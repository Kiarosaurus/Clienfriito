#!/usr/bin/env bash
# Compila cada diagrama TikZ standalone a PDF y lo renderiza a PNG para auto-revisión.
# Uso: bash tools/build_diagrams.sh [nombre]   (sin nombre = todos)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/informe/Association_for_Computing_Machinery__ACM____Generic_Journal_Manuscript_Template/figuras/diagramas"
OUT="$ROOT/informe/_render/diagramas"
mkdir -p "$OUT"
cd "$DIR" 2>/dev/null || { echo "FAIL no existe $DIR"; exit 1; }

shopt -s nullglob
files=( ${1:+$1.tex} )
[ ${#files[@]} -eq 0 ] && files=( *.tex )
[ ${#files[@]} -eq 0 ] && { echo "FAIL sin diagramas .tex"; exit 1; }

status=0
for f in "${files[@]}"; do
  n="${f%.tex}"
  if pdflatex -interaction=nonstopmode -halt-on-error "$f" >/dev/null 2>&1; then
    pdftoppm -png -r 150 -singlefile "$n.pdf" "$OUT/$n"
    echo "OK $n → informe/_render/diagramas/$n.png"
  else
    echo "FAIL $n"; grep -n -A2 "^! " "$n.log" | head -15; status=1
  fi
done
rm -f ./*.aux
exit $status
