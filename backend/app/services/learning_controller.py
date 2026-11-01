"""Learning controller: learns how a room responds and plans fan/heater levels.

Two pieces:
  · Model   — predicts the temperature change of the next minute from the indoor
              temperature, the outdoor temperature, the people in the room (CO2 mass
              balance) and the fan/heater levels. It is a linear model updated with
              every new minute (recursive least squares), so it adapts to each room.
  · Planner — every minute tries several fan/heater levels on the model over the
              next 15 minutes and keeps the cheapest one that holds the room in the
              comfort band (23.5–24.5 °C). Only the first minute is applied; the plan
              is redone every minute.

Live, it runs in SHADOW next to the node: the node's firmware rules act, this
controller decides what it would do with the same readings and learns from what the
node actually did. ml/simulation/compare_strategies.py imports this same class, so
the controller evaluated in simulation is exactly the one running here.

Pure Python + numpy: no database or framework code in this module (see
`shadow_step` in data_service for the live wiring).
"""
from __future__ import annotations

from typing import Callable, Optional

import numpy as np

SETPOINT_C, BAND_C = 24.0, 0.5            # firmware SETPOINT_C and HYSTERESIS_C
BAND_LO, BAND_HI = SETPOINT_C - BAND_C, SETPOINT_C + BAND_C
CO2_OUTDOOR_PPM = 420.0
HORIZON_MIN = 15
MAX_GAP_S = 300.0                          # longer gaps (node offline) restart the short-term history
READY_MINUTES = 30                         # minutes of occupied/acting data before the decisions are trusted
LOOKAHEAD_MIN = 180                        # a class starting within this many minutes may be prepared for

# Node actuators (PROYECTO_REDEFINIDO §4): 12 V axial fan and 12 V PTC heater.
NODE_FAN_MAX_M3S = 0.04                    # ~85 CFM at full speed
NODE_FAN_MAX_W = 2.4
NODE_HEATER_W = 35.0

FAN_LEVELS = (0.25, 0.5, 0.75, 1.0)
HEAT_LEVELS = (0.5, 1.0)
DURATIONS_MIN = (2, 5, HORIZON_MIN)        # keep the level this long, then off
OPTIONS = [(0.0, 0.0, 0)] + [(f, 0.0, d) for f in FAN_LEVELS for d in DURATIONS_MIN] \
    + [(0.0, h, d) for h in HEAT_LEVELS for d in DURATIONS_MIN]
# Preparing the room before a class needs longer actions (heat/cool for up to 3 h).
PREPARE_DURATIONS_MIN = (2, 5, 15, 30, 60, 90, 120, 180)
PREPARE_OPTIONS = [(0.0, 0.0, 0)] + [(f, 0.0, d) for f in FAN_LEVELS for d in PREPARE_DURATIONS_MIN] \
    + [(0.0, h, d) for h in HEAT_LEVELS for d in PREPARE_DURATIONS_MIN]

# One entry per minute from now: (class in the room?, expected people). Built from the
# room's timetable and reservations; the controller never sees actual attendance ahead.
Forecast = list[tuple[bool, float]]

FEATURES = ["constante", "exterior − interior", "ventilador × (exterior − interior)", "calefactor", "personas / 10", "aula ocupada"]


def fan_power_w(level: float, fan_max_w: float) -> float:
    """Fan laws: electric power grows with the cube of the speed."""
    return fan_max_w * level ** 3


class RecursiveLeastSquares:
    """Linear model updated one sample at a time; old samples fade (forgetting factor)."""

    def __init__(self, n: int, forget: float = 0.999) -> None:
        self.theta = np.zeros(n)
        self.p = np.eye(n) * 100.0
        self.forget = forget

    def update(self, x: np.ndarray, y: float, forget: bool = True) -> None:
        """forget=False for samples without new information (empty room, actuators off):
        forgetting then would inflate P in the unexcited directions (windup) and the next
        informative sample would cause a huge jump."""
        if not np.all(np.isfinite(x)) or not np.isfinite(y) or abs(y) > 1.0:   # sensor glitch
            return
        lam = self.forget if forget else 1.0
        px = self.p @ x
        k = px / (lam + x @ px)
        self.theta = self.theta + k * (y - x @ self.theta)
        self.p = (self.p - np.outer(k, px)) / lam
        self.p = (self.p + self.p.T) / 2
        tr = np.trace(self.p)
        if tr > 1e3:
            self.p *= 1e3 / tr

    def predict(self, x: np.ndarray) -> float:
        return float(x @ self.theta)


class LearningController:
    NOMINAL_INFILTRATION_M3S = 0.06        # guess; the true value is unknown to the controller
    PERSON_CO2_M3S = 5.2e-6                # seated adult (ASHRAE)
    COMFORT_WEIGHT = 200.0                 # cost of each (°C outside the band)² per minute
    COMFORT_LINEAR = 200.0                 # cost of each °C outside the band per minute
    ENERGY_WEIGHT = 0.1                    # cost of each Wh

    def __init__(self, fan_max_m3s: float = NODE_FAN_MAX_M3S, fan_max_w: float = NODE_FAN_MAX_W,
                 heater_w: float = NODE_HEATER_W, volume_m3: float = 190.0,
                 explore: float = 0.0, seed: int = 11) -> None:
        self.fan_max_m3s, self.fan_max_w, self.heater_w = fan_max_m3s, fan_max_w, heater_w
        self.volume = volume_m3
        self.explore = explore
        self.rng = np.random.default_rng(seed)
        self.model = RecursiveLeastSquares(len(FEATURES))
        self.minutes_learned = 0
        self.current: tuple[float, float] = (0.0, 0.0)
        # Offset-free correction: recent gap between what the model predicted and what
        # happened, added to every predicted minute so model bias does not pile up.
        self.bias = 0.0
        self._reset_short_term()

    def _reset_short_term(self) -> None:
        self.c_hist: list[float] = []
        self.q_hist: list[float] = []
        self.acc: list[tuple[float, float, float, float]] = []   # (t, co2, fan, heat) of the open minute
        self.bucket: Optional[int] = None
        self.last_ts: Optional[float] = None
        self.prev_x: Optional[np.ndarray] = None
        self.prev_t: Optional[float] = None
        self.prev_used: Optional[tuple[float, float]] = None      # actuator levels of the previous minute

    @property
    def ready(self) -> bool:
        return self.minutes_learned >= READY_MINUTES

    # ── one reading ───────────────────────────────────────────────────────────
    def step(self, ts_s: float, t_meas: float, co2_meas: float, occupied: bool, tout: float,
             applied: Optional[tuple[float, float]] = None,
             forecast: Optional[Callable[[], Forecast]] = None) -> tuple[float, float]:
        """Feed one reading; returns the controller's (fan, heater) levels, 0–1.

        applied: what the actuators actually did at this reading. In shadow it is the
        node's action; None means the controller itself is in charge (simulation).
        forecast: returns the timetable for the next LOOKAHEAD_MIN + HORIZON_MIN minutes;
        called only when a minute closes. Without it the controller cannot prepare the
        room before a class and only acts while the room is occupied.
        Closing a minute (first reading of a new minute) learns from it and replans.
        """
        if self.last_ts is not None and (ts_s - self.last_ts > MAX_GAP_S or ts_s < self.last_ts):
            self._reset_short_term()
        self.closed_minute = False
        bucket = int(ts_s // 60)
        if self.bucket is not None and bucket != self.bucket and self.acc:
            self._close_minute(occupied, tout, forecast() if forecast else None)
            self.closed_minute = True
        self.bucket = bucket
        self.last_ts = ts_s
        fan, heat = applied if applied is not None else self.current
        self.acc.append((t_meas, co2_meas, fan, heat))
        return self.current

    def _close_minute(self, occupied: bool, tout: float, forecast: Optional[Forecast] = None) -> None:
        t_now = float(np.mean([a[0] for a in self.acc]))
        co2_now = float(np.mean([a[1] for a in self.acc]))
        fan_used = float(np.mean([a[2] for a in self.acc]))
        heat_used = float(np.mean([a[3] for a in self.acc]))
        self.acc = []
        self.c_hist = (self.c_hist + [co2_now])[-16:]
        self.q_hist = (self.q_hist + [self.NOMINAL_INFILTRATION_M3S + fan_used * self.fan_max_m3s])[-16:]
        people = self.people_estimate()

        if self.prev_x is not None and self.prev_t is not None and self.prev_used is not None:
            # Mean of this minute minus mean of the previous one spans the second half of
            # the previous minute and the first half of this one: average both actions.
            fan_eff = (self.prev_used[0] + fan_used) / 2
            heat_eff = (self.prev_used[1] + heat_used) / 2
            x_used = self.prev_x.copy()
            x_used[2] = fan_eff * x_used[1]
            x_used[3] = heat_eff
            informative = bool(x_used[5] or fan_eff or heat_eff)
            observed = t_now - self.prev_t
            if informative and abs(observed) <= 1.0:
                self.bias = 0.7 * self.bias + 0.3 * (observed - self.model.predict(x_used))
            self.model.update(x_used, observed, forget=informative)
            # Physics priors (signs only): the room drifts toward the outdoor temperature,
            # the fan moves it toward outdoor air, the heater and people only warm.
            for k in (1, 2, 3, 4):
                self.model.theta[k] = max(self.model.theta[k], 0.0)
            if informative:
                self.minutes_learned += 1

        if occupied:
            # Now: measured people. Ahead: the timetable says when the class ends.
            # Use without a scheduled class (forecast says empty now) is assumed to go on.
            scheduled = bool(forecast and forecast[0][0])
            ahead = forecast[1:HORIZON_MIN] if scheduled else [(True, people)] * (HORIZON_MIN - 1)
            fc = [(True, people)] + [(occ, people if occ else 0.0) for occ, _ in ahead]
            self.current = self.plan(t_now, tout, people, occupied, fc)
            if self.explore and self.rng.random() < self.explore:
                self.current = OPTIONS[int(self.rng.integers(len(OPTIONS)))][:2]
        else:
            start = next((m for m, (occ, _) in enumerate(forecast or []) if occ), None)
            if start is None or start > LOOKAHEAD_MIN:
                self.current = (0.0, 0.0)            # empty and no class coming: everything off
            else:                                    # prepare the room for the next class
                self.current = self.plan(t_now, tout, people, occupied, forecast[:start + HORIZON_MIN])
        self.prev_x = self.features(t_now, tout, people, occupied, *self.current)
        self.prev_t = t_now
        self.prev_used = (fan_used, heat_used)

    # ── model and planner ─────────────────────────────────────────────────────
    @staticmethod
    def features(t: float, tout: float, people: float, occupied: bool, fan: float, heat: float) -> np.ndarray:
        return np.array([1.0, tout - t, fan * (tout - t), heat, people / 10, 1.0 if occupied else 0.0])

    def people_estimate(self) -> float:
        """CO2 mass balance over the last 15 min: generation = dC/dt + flow/V · (C − C_out).

        Uses the known fan airflow, so ventilating does not look like people leaving."""
        if len(self.c_hist) < 2:
            return 0.0
        minutes = len(self.c_hist) - 1
        dcdt = (self.c_hist[-1] - self.c_hist[0]) / (minutes * 60)
        flow = float(np.mean(self.q_hist[-minutes:]))
        excess = float(np.mean(self.c_hist)) - CO2_OUTDOOR_PPM
        generation = dcdt + flow / self.volume * excess
        return max(0.0, generation * self.volume / 1e6 / self.PERSON_CO2_M3S)

    def plan(self, t0: float, tout: float, people: float, occupied: bool,
             forecast: Optional[Forecast] = None) -> tuple[float, float]:
        """Cheapest first action over the forecast window. Comfort only counts in minutes
        with a class; empty minutes before a class cost only the energy spent preparing."""
        fc = forecast or [(occupied, people)] * HORIZON_MIN
        options = OPTIONS if len(fc) <= HORIZON_MIN else PREPARE_OPTIONS
        th0, th1, th2, th3, th4, th5 = (float(v) for v in self.model.theta)
        bias = self.bias
        best, best_cost = (0.0, 0.0), float("inf")
        for fan_level, heat_level, minutes_on in options:
            if minutes_on > len(fc):
                continue
            t, cost = t0, 0.0
            for m, (occ, ppl) in enumerate(fc):
                fan, heat = (fan_level, heat_level) if m < minutes_on else (0.0, 0.0)
                gap = tout - t
                dt = th0 + th1 * gap + th2 * fan * gap + th3 * heat + th4 * ppl / 10 + (th5 if occ else 0.0) + bias
                t += -1.0 if dt < -1.0 else 1.0 if dt > 1.0 else dt
                if occ:
                    out = max(0.0, t - BAND_HI) + max(0.0, BAND_LO - t)
                    cost += self.COMFORT_WEIGHT * out * out + self.COMFORT_LINEAR * out + 0.5 * (t - SETPOINT_C) ** 2
            energy_wh = (fan_power_w(fan_level, self.fan_max_w) + self.heater_w * heat_level) * minutes_on / 60
            cost += self.ENERGY_WEIGHT * energy_wh
            if cost < best_cost:
                best, best_cost = (fan_level, heat_level), cost
        return best

    # ── persistence (live shadow keeps one controller per room) ───────────────
    def to_state(self) -> dict:
        return {
            "theta": self.model.theta.tolist(),
            "p": self.model.p.tolist(),
            "minutes_learned": self.minutes_learned,
            "bias": self.bias,
            "current": list(self.current),
            "c_hist": self.c_hist,
            "q_hist": self.q_hist,
            "acc": [list(a) for a in self.acc],
            "bucket": self.bucket,
            "last_ts": self.last_ts,
            "prev_x": None if self.prev_x is None else self.prev_x.tolist(),
            "prev_t": self.prev_t,
            "prev_used": None if self.prev_used is None else list(self.prev_used),
        }

    @classmethod
    def from_state(cls, state: dict, **kwargs) -> "LearningController":
        c = cls(**kwargs)
        c.model.theta = np.array(state["theta"], dtype=float)
        c.model.p = np.array(state["p"], dtype=float)
        c.minutes_learned = int(state.get("minutes_learned", 0))
        c.bias = float(state.get("bias", 0.0))
        c.current = tuple(state.get("current", (0.0, 0.0)))
        c.c_hist = list(state.get("c_hist", []))
        c.q_hist = list(state.get("q_hist", []))
        c.acc = [tuple(a) for a in state.get("acc", [])]
        c.bucket = state.get("bucket")
        c.last_ts = state.get("last_ts")
        c.prev_x = None if state.get("prev_x") is None else np.array(state["prev_x"], dtype=float)
        c.prev_t = state.get("prev_t")
        c.prev_used = None if state.get("prev_used") is None else tuple(state["prev_used"])
        return c

    def summary(self) -> dict:
        """What the dashboard shows next to each reading."""
        return {
            "fan_pct": round(self.current[0] * 100),
            "heater_pct": round(self.current[1] * 100),
            "minutes_learned": self.minutes_learned,
            "ready": self.ready,
        }
