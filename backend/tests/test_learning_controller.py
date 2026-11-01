"""Learning controller (shadow strategy): learns the room, plans, persists."""
import asyncio
from datetime import datetime, timedelta

import numpy as np

from app.models.sensor import SensorReading
from app.services import data_service
from app.services.learning_controller import LearningController

# A toy room with known per-minute effects, in the controller's feature order:
# [constante, exterior − interior, ventilador × (exterior − interior), calefactor, personas/10, ocupada]
TRUE = np.array([0.0, 0.007, 0.009, 0.03, 0.011, 0.006])


def run_toy_room(ctrl: LearningController, minutes: int, rng: np.random.Generator, people: int = 30):
    """Feed the controller in shadow; the 'node' acts at random so every effect is visible."""
    temp, co2, tout = 23.0, 600.0, 19.0
    for minute in range(minutes):
        fan = float(rng.choice([0.0, 1.0]))
        heat = 0.0 if fan else float(rng.choice([0.0, 1.0]))
        for sample in range(6):                       # one reading every 10 s; the room changes continuously
            ts = minute * 60 + sample * 10
            ctrl.step(ts, temp + rng.normal(0, 0.02), co2, True, tout, applied=(fan, heat))
            x = np.array([1.0, tout - temp, fan * (tout - temp), heat, people / 10, 1.0])
            temp += float(x @ TRUE) / 6
            flow = ctrl.NOMINAL_INFILTRATION_M3S + fan * ctrl.fan_max_m3s
            co2 += (people * ctrl.PERSON_CO2_M3S * 1e6 / ctrl.volume - flow / ctrl.volume * (co2 - 420)) * 10
    return temp


def test_learns_the_effect_of_each_actuator():
    ctrl = LearningController(fan_max_m3s=0.5)
    run_toy_room(ctrl, 600, np.random.default_rng(1))
    theta = ctrl.model.theta
    assert abs(theta[3] - TRUE[3]) < 0.01          # heater
    assert abs(theta[2] - TRUE[2]) < 0.01          # fan
    assert ctrl.ready


def test_plans_fan_when_hot_and_heater_when_cold():
    ctrl = LearningController(fan_max_m3s=0.5)
    ctrl.model.theta = TRUE.copy()
    fan, heat = ctrl.plan(t0=25.5, tout=19.0, people=30, occupied=True)
    assert fan > 0 and heat == 0
    fan, heat = ctrl.plan(t0=22.0, tout=19.0, people=5, occupied=True)
    assert heat > 0 and fan == 0


def test_empty_room_means_everything_off():
    ctrl = LearningController()
    ctrl.model.theta = TRUE.copy()
    for ts in range(0, 180, 10):
        decision = ctrl.step(ts, 26.0, 450.0, False, 19.0, applied=(0.0, 0.0))
    assert decision == (0.0, 0.0)


def test_state_round_trip_keeps_what_was_learned():
    ctrl = LearningController(fan_max_m3s=0.5)
    run_toy_room(ctrl, 120, np.random.default_rng(2))
    clone = LearningController.from_state(ctrl.to_state(), fan_max_m3s=0.5)
    assert np.allclose(clone.model.theta, ctrl.model.theta)
    assert clone.minutes_learned == ctrl.minutes_learned
    assert clone.plan(25.0, 19.0, 20, True) == ctrl.plan(25.0, 19.0, 20, True)


def test_a_long_gap_does_not_learn_across_it():
    ctrl = LearningController()
    for ts in range(0, 120, 10):
        ctrl.step(ts, 24.0, 600.0, True, 19.0, applied=(0.0, 0.0))
    theta = ctrl.model.theta.copy()
    ctrl.step(4 * 3600, 30.0, 600.0, True, 19.0, applied=(0.0, 0.0))   # node was offline for hours
    ctrl.step(4 * 3600 + 60, 30.0, 600.0, True, 19.0, applied=(0.0, 0.0))
    assert np.allclose(ctrl.model.theta, theta)


class FakeCollection:
    def __init__(self):
        self.docs = {}

    async def find_one(self, query):
        return self.docs.get(query["_id"])

    async def replace_one(self, query, doc, upsert=False):
        self.docs[query["_id"]] = doc


def test_shadow_step_reads_the_node_and_persists_each_minute():
    data_service._SHADOW.clear()
    db = {"learning_state": FakeCollection()}
    start = datetime(2026, 10, 24, 15, 0, 0)
    summary = None
    for i in range(13):                                # a bit over two minutes, every 10 s
        reading = SensorReading(
            sensor_id="s-A403", temperature=25.0, humidity=55.0, co2_ppm=900.0, co_ppm=2.0,
            timestamp=start + timedelta(seconds=10 * i),
            node_state={"accion": "COOLING", "ventilador_pwm": 255, "calefactor": False, "co2_proxy": 3000},
        )
        summary = asyncio.run(data_service.shadow_learning_step(db, "A403", reading))
    assert set(summary) == {"fan_pct", "heater_pct", "minutes_learned", "ready"}
    assert "A403" in db["learning_state"].docs
    data_service._SHADOW.clear()


def test_shadow_step_ignores_readings_without_a_node_decision():
    reading = SensorReading(sensor_id="s-A403", temperature=25.0, humidity=55.0, co2_ppm=900.0)
    assert asyncio.run(data_service.shadow_learning_step({}, "A403", reading)) is None


def class_in(minutes_until: int, people: float = 35, total: int = 195):
    return [(m >= minutes_until, people if m >= minutes_until else 0.0) for m in range(total)]


def test_prepares_a_cold_room_before_a_class():
    ctrl = LearningController(heater_w=2000)
    ctrl.model.theta = TRUE.copy()
    fan, heat = ctrl.plan(18.0, 16.0, 0, False, class_in(60)[:75])
    assert heat > 0 and fan == 0


def test_stays_off_without_a_class_coming():
    ctrl = LearningController(heater_w=2000)
    ctrl.model.theta = TRUE.copy()
    for ts in range(0, 200, 10):            # empty room, class far away (> 3 h)
        decision = ctrl.step(ts, 18.0, 450.0, False, 16.0, applied=(0.0, 0.0),
                             forecast=lambda: [(False, 0.0)] * 195)
    assert decision == (0.0, 0.0)


def test_heats_ahead_when_the_timetable_says_a_class_is_coming():
    ctrl = LearningController(heater_w=2000)
    ctrl.model.theta = TRUE.copy()
    for ts in range(0, 200, 10):
        decision = ctrl.step(ts, 18.0, 450.0, False, 16.0, applied=(0.0, 0.0),
                             forecast=lambda: class_in(45))
    assert decision[1] > 0
