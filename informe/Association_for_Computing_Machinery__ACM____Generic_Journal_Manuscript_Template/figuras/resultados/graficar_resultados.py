"""Figura de resultados del informe (fig:resultados-telemetria) a partir de datos REALES.

Entrada: exportación de MongoDB del nodo físico de A403 (solo lecturas con is_simulated=false):

    mongoexport --uri "mongodb://localhost:27017" --db climate_db \
        --collection sensor_readings --jsonArray \
        --query '{"sensor_id": "s-A403", "is_simulated": false}' \
        --out figuras/resultados/datos/lecturas_A403.json

Salida: figuras/resultados/resultados-telemetria.pdf (el informe la incluye solo si existe).

Uso (desde la carpeta de la plantilla):
    python figuras/resultados/graficar_resultados.py [--entrada RUTA] [--desde ISO] [--hasta ISO]

El script NO genera ni completa datos: si la exportación no existe o no contiene lecturas
reales, termina con código 1 y no escribe la figura.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

AQUI = Path(__file__).resolve().parent
ENTRADA = AQUI / "datos" / "lecturas_A403.json"
SALIDA = AQUI / "resultados-telemetria.pdf"
CO_ALARMA_PPM = 50.0


def _ts(valor):
    if isinstance(valor, dict) and "$date" in valor:  # formato extendido de mongoexport
        valor = valor["$date"]
    if isinstance(valor, (int, float)):
        return datetime.utcfromtimestamp(valor / 1000.0)
    return datetime.fromisoformat(str(valor).replace("Z", "+00:00")).replace(tzinfo=None)


def _num(valor):
    try:
        return None if valor is None else float(valor)
    except (TypeError, ValueError):
        return None


def cargar(ruta: Path, desde: datetime | None, hasta: datetime | None) -> list[dict]:
    docs = json.loads(ruta.read_text(encoding="utf-8"))
    filas = []
    for d in docs:
        if d.get("is_simulated", False):
            continue  # nunca mezclar aulas simuladas con el nodo físico
        t = _ts(d.get("timestamp"))
        if (desde and t < desde) or (hasta and t > hasta):
            continue
        ca = d.get("cognitive_action") or {}
        filas.append({
            "t": t,
            "temp": _num(d.get("temperature")),
            "objetivo": _num(ca.get("heuristic_target", ca.get("target"))),
            "co2": _num(d.get("co2_ppm")),
            "co": _num(d.get("co_ppm")),
            "pwm": _num(d.get("fan_pwm", ca.get("fan_pwm"))),
            "potencia": _num(d.get("power_w")),
            "heur": ca.get("heuristic_action", ca.get("action")),
            "ml": ca.get("ml_action"),
        })
    return sorted(filas, key=lambda f: f["t"])


def graficar(filas: list[dict]) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import matplotlib.dates as mdates

    t = [f["t"] for f in filas]
    fig, ax = plt.subplots(4, 1, figsize=(7.0, 7.5), sharex=True,
                           gridspec_kw={"height_ratios": [2, 1.5, 1.5, 0.8]})

    ax[0].plot(t, [f["temp"] for f in filas], lw=1.0, label="T medida (DHT11)")
    if any(f["objetivo"] is not None for f in filas):
        ax[0].plot(t, [f["objetivo"] for f in filas], lw=1.0, ls="--", label="objetivo ajustado")
    ax[0].set_ylabel("T [°C]")
    ax[0].legend(loc="upper right", fontsize=7)

    ax[1].plot(t, [f["co2"] for f in filas], lw=1.0, color="tab:green", label="CO$_2$ rel. (MQ-135)")
    ax1b = ax[1].twinx()
    ax1b.plot(t, [f["co"] for f in filas], lw=0.8, color="tab:red", label="CO (MQ-7)")
    ax1b.axhline(CO_ALARMA_PPM, color="tab:red", ls=":", lw=0.8)
    ax[1].set_ylabel("CO$_2$ [ppm rel.]")
    ax1b.set_ylabel("CO [ppm]")

    ax[2].step(t, [f["pwm"] for f in filas], where="post", lw=1.0, label="PWM ventilador [%]")
    ax2b = ax[2].twinx()
    ax2b.plot(t, [f["potencia"] for f in filas], lw=0.8, color="tab:purple", label="P nodo (INA219)")
    ax[2].set_ylabel("PWM [%]")
    ax2b.set_ylabel("P [W]")

    estados = ["STANDBY", "PRE-COOLING", "ON", "DISABLED"]
    codigo = {e: i for i, e in enumerate(estados)}
    ax[3].step(t, [codigo.get(f["heur"], None) for f in filas], where="post", lw=1.0, label="heurística (activa)")
    ax[3].step(t, [codigo.get(f["ml"], None) for f in filas], where="post", lw=1.0, ls="--", label="ML (sombra)")
    ax[3].set_yticks(range(len(estados)), estados, fontsize=6)
    ax[3].legend(loc="upper right", fontsize=7)
    ax[3].xaxis.set_major_formatter(mdates.DateFormatter("%d/%m %H:%M"))
    fig.autofmt_xdate()
    fig.tight_layout()
    fig.savefig(SALIDA)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--entrada", type=Path, default=ENTRADA)
    ap.add_argument("--desde", type=datetime.fromisoformat)
    ap.add_argument("--hasta", type=datetime.fromisoformat)
    a = ap.parse_args()
    if not a.entrada.exists():
        print(f"Sin datos reales: no existe {a.entrada}. No se genera la figura.")
        return 1
    filas = cargar(a.entrada, a.desde, a.hasta)
    if not filas:
        print("La exportación no contiene lecturas reales (is_simulated=false). No se genera la figura.")
        return 1
    graficar(filas)
    print(f"OK {SALIDA.name}: {len(filas)} lecturas reales entre {filas[0]['t']} y {filas[-1]['t']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
