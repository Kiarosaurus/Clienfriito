"""Energía diaria ESTIMADA del nodo Calienfriito por carga (Sección de Mercado).

Fuente de los números: Tabla tab:potencia del informe (hojas de datos), NO mediciones.
Cuando existan datos del INA219 (experimento E5), esta figura debe rehacerse con la
potencia medida de la rama del ventilador.

Uso (desde esta carpeta o cualquier otra):
    python graficar_consumo_estimado.py
Salida: consumo-estimado.pdf junto a este script.

Tipografía: si hay LaTeX en el PATH, el texto se compone con Linux Libertine (la fuente
del informe) mediante text.usetex; si no, se usa la serif por defecto de matplotlib.
"""
import shutil
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

AQUI = Path(__file__).resolve().parent

# (carga, potencia [W], horas/día) -- valores de la Tabla tab:potencia.
CARGAS = [
    ("Calefactor MQ-135", 0.80, 24.0),
    ("ESP32 con WiFi", 0.50, 24.0),
    ("Calefactor MQ-7 (ciclo 5 V / 1.4 V)", 0.34, 24.0),
    ("Ventilador 100 %, 8 h/día", 2.40, 8.0),
]
ETA_BUCK = 0.85  # supuesto típico; pendiente confirmar con el modelo instalado (P-12)
ANCHO_IN = 5.95  # ancho de texto del informe (430 pt); se incluye a \linewidth sin reescalar
TAM_LETRA = 9    # próximo al cuerpo del documento

PREAMBULO = (r"\usepackage[T1]{fontenc}\usepackage{libertine}"
             r"\usepackage[libertine]{newtxmath}")


def configurar_fuente() -> bool:
    """Activa LaTeX + Libertine si hay distribución TeX; devuelve True si se activó."""
    usa_tex = shutil.which("latex") is not None
    if usa_tex:
        plt.rcParams.update({"text.usetex": True, "text.latex.preamble": PREAMBULO})
    plt.rcParams.update({"font.size": TAM_LETRA, "font.family": "serif"})
    return usa_tex


def t(texto: str, usa_tex: bool) -> str:
    """Adapta caracteres especiales cuando el texto pasa por LaTeX."""
    if not usa_tex:
        return texto
    return (texto.replace("%", r"\%")
                 .replace("η", r"$\eta$")
                 .replace("≈", r"$\approx$"))


def main() -> None:
    usa_tex = configurar_fuente()
    nombres = [c[0] for c in CARGAS]
    wh = [p * h for _, p, h in CARGAS]
    total_5v = sum(w for (n, _, _), w in zip(CARGAS, wh) if "Ventilador" not in n)
    perdidas = total_5v / ETA_BUCK - total_5v
    nombres.append(f"Pérdidas buck (η = {ETA_BUCK:.2f} supuesto)")
    wh.append(perdidas)
    total = sum(wh)

    fig, ax = plt.subplots(figsize=(ANCHO_IN, 2.5))
    y = range(len(nombres))[::-1]
    barras = ax.barh(list(y), wh, color="0.55", edgecolor="black", linewidth=0.5)
    for b, w in zip(barras, wh):
        ax.text(b.get_width() + 0.3, b.get_y() + b.get_height() / 2, f"{w:.1f} Wh",
                va="center", fontsize=TAM_LETRA - 1)
    ax.set_yticks(list(y))
    ax.set_yticklabels([t(n, usa_tex) for n in nombres])
    ax.set_xlabel(t("Energía por día [Wh] (estimación de hoja de datos)", usa_tex))
    ax.set_xlim(0, max(wh) * 1.3)
    ax.set_title(t(f"Total ≈ {total:.0f} Wh/día ≈ {total * 30 / 1000:.1f} kWh/mes, sin PTC",
                   usa_tex), fontsize=TAM_LETRA)
    for lado in ("top", "right"):
        ax.spines[lado].set_visible(False)
    fig.tight_layout()
    fig.savefig(AQUI / "consumo-estimado.pdf")
    print(f"OK consumo-estimado.pdf  total={total:.1f} Wh/dia  usetex={usa_tex}")


if __name__ == "__main__":
    main()
