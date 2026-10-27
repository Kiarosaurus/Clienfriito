"""Gate del frontend: reglas duras de CLAUDE.md + cobertura de la spec de hardware.

Uso: python tools/checks/check_frontend_scope.py
Sale con código 1 si alguna regla falla. Los checks de "cobertura" definen el
criterio de terminado de la adaptación (fallan hasta que el frontend refleje la spec).
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "frontend" / "src"

# Regla 1: ninguna interfaz se elimina.
REQUIRED_VIEWS = [
    "GlobalDashboard", "Infrastructure", "ROIReport", "Register", "Reservations",
    "RoomDetail", "RoomSearch", "SensorSearch", "UserManagement",
]
REQUIRED_ROUTES = ["/login", "/register", "rooms", "room/:id", "sensors",
                   "reservations", "admin/users", "infrastructure", "roi"]

# Regla 2: sin comparación contra AC 24/7.
FORBIDDEN = {
    r"Tradicional": "baseline 'Tradicional' (AC 24/7)",
    r"traditional_kwh": "campo traditional_kwh (baseline AC)",
    r"ac_power_kw": "potencia de AC asumida",
    r"24\s*/\s*7": "mención a 24/7",
    r"Potencia AC": "potencia de AC asumida",
}

# Cobertura de docs/hardware-spec.md (insensible a mayúsculas; basta una alternativa).
COVERAGE = {
    "ventilador PWM": [r"fan_pwm", r"\bPWM\b"],
    "calefactor PTC": [r"heater", r"\bPTC\b"],
    "alarma CO (buzzer/LED)": [r"alarm_active", r"buzzer"],
    "potencia INA219": [r"power_w", r"INA219"],
    "MQTT / nodo online": [r"MQTT", r"node_online"],
    "estado PRE-COOLING": [r"PRE-COOLING", r"PRE_COOLING"],
    "MCU ESP32": [r"ESP32"],
    "ML en modo sombra": [r"ml_action", r"sombra", r"shadow"],
    "latencia sensado-actuación": [r"latency_ms", r"latencia"],
}


def read_sources() -> dict[Path, str]:
    return {p: p.read_text(encoding="utf-8", errors="replace")
            for p in SRC.rglob("*") if p.suffix in {".ts", ".tsx"}}


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    if not SRC.is_dir():
        print(f"FAIL no existe {SRC}")
        return 1
    sources = read_sources()
    blob = "\n".join(sources.values())
    failures: list[str] = []

    views = {p.stem for p in (SRC / "views").glob("*.tsx")}
    for v in REQUIRED_VIEWS:
        if v not in views:
            failures.append(f"[vistas] falta vista {v}.tsx (no se elimina ninguna interfaz)")
    app = (SRC / "App.tsx").read_text(encoding="utf-8")
    for r in REQUIRED_ROUTES:
        if f'path="{r}"' not in app:
            failures.append(f"[rutas] falta ruta '{r}' en App.tsx")

    for pat, why in FORBIDDEN.items():
        for path, text in sources.items():
            for i, line in enumerate(text.splitlines(), 1):
                if re.search(pat, line):
                    failures.append(f"[costos] {path.relative_to(ROOT)}:{i} {why}")

    for concept, pats in COVERAGE.items():
        if not any(re.search(p, blob, re.IGNORECASE) for p in pats):
            failures.append(f"[cobertura] el frontend no refleja: {concept}")

    for f in failures:
        print("FAIL", f)
    print(f"\n{len(failures)} fallo(s)" if failures else "OK frontend scope")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
