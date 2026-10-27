#!/usr/bin/env bash
# Compila el informe final y renderiza cada página a PNG para revisión visual.
# Uso: bash tools/build_report.sh   (desde la raíz del repo)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/informe/Association_for_Computing_Machinery__ACM____Generic_Journal_Manuscript_Template"
OUT="$ROOT/informe/_render/informe"

[ -f "$DIR/informe.tex" ] || { echo "FAIL no existe informe.tex"; exit 1; }
# Diagramas primero: el informe los incluye como PDF.
if ls "$DIR"/figuras/diagramas/*.tex >/dev/null 2>&1; then bash "$ROOT/tools/build_diagrams.sh"; fi

cd "$DIR"
latexmk -pdf -interaction=nonstopmode -halt-on-error -file-line-error informe.tex >/dev/null 2>&1 \
  || { echo "FAIL compilación; últimas líneas del log:"; grep -n -A3 "^.*:[0-9]*: \|^! " informe.log | head -40; exit 1; }

rm -rf "$OUT" && mkdir -p "$OUT"
pdftoppm -png -r 70 informe.pdf "$OUT/pag"
echo "OK informe.pdf ($(ls "$OUT" | wc -l) páginas) → PNG en informe/_render/informe/"
