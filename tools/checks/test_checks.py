"""Tests de los gates. Uso: python -m pytest tools/checks -q"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent

GOOD_TEX = r"""
\documentclass{acmart}
\newcommand{\pendiente}[1]{#1}
\begin{document}
\title{Calienfriito}
\section{Introducción}
Texto \cite{a2020}.
\section{Problemática}
\section{Marco Teórico}
Teoría \cite{old2012}.
\section{Estado del Arte}
\cite{a2020,b2021,c2022,d2023,e2024,f2025}
\section{Metodología}
Ver \ref{fig:bloques-hw}, \ref{fig:arquitectura} y \ref{fig:sota}.
\begin{figure}\label{fig:bloques-hw}\end{figure}
\begin{figure}\label{fig:arquitectura}\end{figure}
\begin{figure}\label{fig:sota}\end{figure}
\section{Implementación}
Ver \ref{fig:flujo}.
\begin{figure}\label{fig:flujo}\end{figure}
\section{Análisis de Resultados}
Ver \ref{fig:resultados-latencia}.
\begin{figure}\label{fig:resultados-latencia}\end{figure}
\section{Descripción del Mercado}
Primer párrafo con suficientes palabras para contar como párrafo real del texto del informe sobre el segmento de mercado.

Segundo párrafo con suficientes palabras para contar como párrafo real sobre el modelo de negocio y el video \url{https://youtu.be/x}.
\section{Conclusiones y Recomendaciones}
Fin.
\bibliographystyle{IEEEtran}
\bibliography{refs}
\end{document}
"""

BIB = "\n".join(
    f"@article{{{k},\n  title={{T}},\n  year={{{y}}}\n}}"
    for k, y in [("a2020", 2020), ("b2021", 2021), ("c2022", 2022), ("d2023", 2023),
                 ("e2024", 2024), ("f2025", 2025), ("old2012", 2012)]
)


def run(tmp: Path, tex: str, *extra: str) -> subprocess.CompletedProcess:
    (tmp / "informe.tex").write_text(tex, encoding="utf-8")
    (tmp / "refs.bib").write_text(BIB, encoding="utf-8")
    (tmp / "informe.log").write_text("clean log\n", encoding="utf-8")
    return subprocess.run(
        [sys.executable, str(HERE / "check_report.py"), "--tex", str(tmp / "informe.tex"), *extra],
        capture_output=True, text=True, encoding="utf-8",
    )


def test_good_report_passes(tmp_path):
    r = run(tmp_path, GOOD_TEX)
    assert r.returncode == 0, r.stdout


def test_missing_section_and_figure_fail(tmp_path):
    tex = GOOD_TEX.replace(r"\section{Implementación}", "").replace(r"\label{fig:flujo}", "")
    r = run(tmp_path, tex)
    assert r.returncode == 1
    assert "implementacion" in r.stdout and "fig:flujo" in r.stdout


def test_old_sota_refs_fail(tmp_path):
    tex = GOOD_TEX.replace(r"\cite{a2020,b2021,c2022,d2023,e2024,f2025}", r"\cite{a2020,old2012}")
    r = run(tmp_path, tex)
    assert r.returncode == 1 and "[sota]" in r.stdout


def test_market_too_long_and_no_link(tmp_path):
    extra = "\n\nTercer párrafo con suficientes palabras para contar como párrafo real y exceder el límite de la rúbrica del curso.\n"
    tex = GOOD_TEX.replace(r"\url{https://youtu.be/x}", "") .replace(
        r"\section{Conclusiones", extra + r"\section{Conclusiones")
    r = run(tmp_path, tex)
    assert "[mercado] 3 párrafos" in r.stdout and "link al video" in r.stdout


def test_pendiente_fails_only_in_final(tmp_path):
    tex = GOOD_TEX.replace("Fin.", r"\pendiente{fotos}")
    assert run(tmp_path, tex).returncode == 0
    assert run(tmp_path, tex, "--final").returncode == 1


def test_undefined_cite_fails(tmp_path):
    r = run(tmp_path, GOOD_TEX.replace(r"\cite{a2020}.", r"\cite{fantasma}."))
    assert r.returncode == 1 and "fantasma" in r.stdout
