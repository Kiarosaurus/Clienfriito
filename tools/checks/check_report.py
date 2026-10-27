"""Gate estructural del informe final (rúbrica CS5055 P2).

Uso:
  python tools/checks/check_report.py [--tex RUTA] [--final] [--members 3]
Verifica estructura/orden, IEEE, citas vs .bib, ventana de 7 años en Estado del
Arte, figuras obligatorias, labels referenciados, Mercado <= 2 párrafos + link,
\\pendiente restantes, log de LaTeX y muletillas típicas de texto generado.
No reemplaza al report-critic: solo atrapa lo mecánico.
"""
from __future__ import annotations

import argparse
import datetime as dt
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REPORT_DIR = ROOT / "informe" / "Association_for_Computing_Machinery__ACM____Generic_Journal_Manuscript_Template"

# (clave, regex sobre el título normalizado) en el orden exigido por la rúbrica.
SECTIONS = [
    ("introduccion", r"introducci"),
    ("problematica", r"problem"),
    ("marco", r"marco te"),
    ("estado_arte", r"estado del arte"),
    ("metodologia", r"metodolog"),
    ("implementacion", r"implementaci"),
    ("resultados", r"resultado"),
    ("mercado", r"mercado"),
    ("conclusiones", r"conclusi"),
]
REQUIRED_FIG_LABELS = ["fig:bloques-hw", "fig:arquitectura", "fig:flujo", "fig:sota"]
REQUIRED_FIG_PREFIX = ["fig:resultados"]
AI_TELLS = [
    "cabe destacar", "cabe mencionar", "es importante mencionar", "es importante destacar",
    "en este sentido", "juega un papel", "desempeña un papel crucial", "en el panorama",
    "sin lugar a dudas", "en definitiva", "a su vez", "robusto y escalable", "de vanguardia",
]


def strip_comments(tex: str) -> str:
    return re.sub(r"(?<!\\)%.*", "", tex)


def headings(tex: str) -> list[tuple[int, str, str]]:
    """(pos, nivel, título en minúsculas) de section/subsection."""
    out = []
    for m in re.finditer(r"\\(section|subsection)\*?\{([^}]*)\}", tex):
        out.append((m.start(), m.group(1), m.group(2).lower()))
    return out


def section_body(tex: str, heads, idx: int) -> str:
    start = heads[idx][0]
    level = heads[idx][1]
    end = len(tex)
    for pos, lvl, _ in heads[idx + 1:]:
        if lvl == "section" or lvl == level:
            end = pos
            break
    body = tex[start:end]
    cut = re.search(r"\\bibliography\{|\\end\{document\}", body)
    return body[:cut.start()] if cut else body


def parse_bib(bib: str) -> dict[str, int | None]:
    entries = {}
    for m in re.finditer(r"@\w+\s*\{\s*([^,\s]+)\s*,(.*?)(?=\n@|\Z)", bib, re.S):
        y = re.search(r"\byear\s*=\s*[{\"]?(\d{4})", m.group(2), re.I)
        entries[m.group(1)] = int(y.group(1)) if y else None
    return entries


def cites(text: str) -> list[str]:
    keys = []
    for m in re.finditer(r"\\cite[a-zA-Z]*\*?(?:\[[^\]]*\])*\{([^}]*)\}", text):
        keys += [k.strip() for k in m.group(1).split(",") if k.strip()]
    return keys


def text_paragraphs(body: str) -> list[str]:
    body = re.sub(r"\\begin\{(figure|table)\*?\}.*?\\end\{\1\*?\}", "", body, flags=re.S)
    body = re.sub(r"\\(sub)?section\*?\{[^}]*\}", "", body)
    chunks = [c for c in re.split(r"\n\s*\n", body) if c.strip()]
    return [c for c in chunks if len(re.sub(r"\\\w+(\{[^}]*\})?", " ", c).split()) >= 8]


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--tex", type=Path, default=REPORT_DIR / "informe.tex")
    ap.add_argument("--final", action="store_true", help="falla si quedan \\pendiente")
    ap.add_argument("--members", type=int, default=3)
    args = ap.parse_args()

    fails: list[str] = []
    warns: list[str] = []
    if not args.tex.exists():
        print(f"FAIL no existe {args.tex} (lanza report-writer para crearlo)")
        return 1
    tex = strip_comments(args.tex.read_text(encoding="utf-8"))
    heads = headings(tex)

    # Estructura y orden.
    found = {}
    for key, pat in SECTIONS:
        for i, (_, _, title) in enumerate(heads):
            if re.search(pat, title):
                found[key] = i
                break
        else:
            fails.append(f"[estructura] falta sección: {key}")
    order = [found[k] for k, _ in SECTIONS if k in found]
    if order != sorted(order):
        fails.append("[estructura] secciones fuera del orden exigido por la rúbrica")
    if not re.search(r"\\title\{", tex):
        fails.append("[estructura] falta \\title")

    # Bibliografía IEEE + citas.
    if not re.search(r"\\bibliographystyle\{IEEEtran\}", tex):
        fails.append("[ieee] falta \\bibliographystyle{IEEEtran}")
    bibm = re.search(r"\\bibliography\{([^}]*)\}", tex)
    bib: dict[str, int | None] = {}
    if not bibm:
        fails.append("[ieee] falta \\bibliography{...}")
    else:
        for name in bibm.group(1).split(","):
            p = args.tex.parent / (name.strip() + ("" if name.strip().endswith(".bib") else ".bib"))
            if p.exists():
                bib.update(parse_bib(p.read_text(encoding="utf-8")))
            else:
                fails.append(f"[ieee] no existe {p.name}")
    all_cites = cites(tex)
    for k in sorted(set(all_cites) - set(bib)):
        fails.append(f"[citas] \\cite{{{k}}} no está en el .bib")
    for k in sorted(set(bib) - set(all_cites)):
        warns.append(f"[citas] entrada .bib no citada: {k}")
    for k, y in bib.items():
        if y is None:
            fails.append(f"[ieee] entrada sin year: {k}")

    # Estado del Arte: >= 2 por integrante, ventana 7 años.
    min_year = dt.date.today().year - 7
    if "estado_arte" in found:
        sota = set(cites(section_body(tex, heads, found["estado_arte"])))
        recent = {k for k in sota if (bib.get(k) or 0) >= min_year}
        old = sota - recent
        need = 2 * args.members
        if len(recent) < need:
            fails.append(f"[sota] {len(recent)} trabajos >= {min_year} citados; se requieren >= {need}")
        for k in sorted(old):
            warns.append(f"[sota] {k} ({bib.get(k)}) fuera de la ventana de 7 años: muévelo a Marco Teórico")

    # Figuras.
    labels = re.findall(r"\\label\{([^}]*)\}", tex)
    for lab in REQUIRED_FIG_LABELS:
        if lab not in labels:
            fails.append(f"[figuras] falta figura con \\label{{{lab}}}")
    for pref in REQUIRED_FIG_PREFIX:
        if not any(l.startswith(pref) for l in labels):
            fails.append(f"[figuras] falta figura de resultados original ({pref}-*)")
    refs = set(re.findall(r"\\(?:ref|autoref|cref|Cref)\{([^}]*)\}", tex))
    for lab in labels:
        if lab.startswith(("fig:", "tab:")) and lab not in refs:
            fails.append(f"[figuras] {lab} nunca se referencia en el texto")

    # Mercado.
    if "mercado" in found:
        body = section_body(tex, heads, found["mercado"])
        n = len(text_paragraphs(body))
        if n > 2:
            fails.append(f"[mercado] {n} párrafos; máximo 2")
        if not re.search(r"\\(url|href)\{", body):
            fails.append("[mercado] falta link al video publicitario (\\url/\\href)")

    # Pendientes.
    pend = len(re.findall(r"\\pendiente\{", tex.split("\\begin{document}")[-1]))
    if pend:
        (fails if args.final else warns).append(f"[pendientes] quedan {pend} \\pendiente{{}}")

    # Muletillas.
    low = tex.lower()
    for t in AI_TELLS:
        c = low.count(t)
        if c:
            warns.append(f"[estilo] '{t}' x{c}")

    # Log LaTeX.
    log = args.tex.with_suffix(".log")
    if not log.exists():
        fails.append("[latex] no hay .log; compila con tools/build_report.sh")
    else:
        L = log.read_text(encoding="utf-8", errors="replace")
        if re.search(r"^! ", L, re.M):
            fails.append("[latex] el log contiene errores ('! ...')")
        if re.search(r"(Citation|Reference) .* undefined", L):
            fails.append("[latex] citas o referencias indefinidas")
        over = len(re.findall(r"Overfull \\hbox \((\d+\.?\d*)pt", L))
        if over > 5:
            warns.append(f"[latex] {over} overfull hbox")

    for w in warns:
        print("WARN", w)
    for f in fails:
        print("FAIL", f)
    print(f"\n{len(fails)} fallo(s), {len(warns)} aviso(s)")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
