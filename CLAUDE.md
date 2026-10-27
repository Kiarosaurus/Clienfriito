# CLAUDE.md — Calienfriito / Climate Cognitive System (CS5055 IoT, UTEC 2026-2)

Equipo: Brayan Gomero, Kiara Balcázar, Rodrigo Carlos. Idioma de entregables: **español**.
Entrega informe final + diapositivas: **viernes 13 nov 2026**.

## Qué es este repo
Proyecto previo (control de AC cognitivo) reformulado para CS5055: nodo ESP32 con sensores
DHT11 / MQ-135 / MQ-7 / INA219, actuadores ventilador PWM + buzzer/LED + PTC, MQTT,
backend FastAPI, dashboard React. Heurística activa vs modelo ML en modo sombra.

- `frontend/` React 18 + TS + Vite + Tailwind + Recharts. Vistas en `frontend/src/views/`.
- `backend/` FastAPI + Mongo + Postgres; tests en `backend/tests/` (pytest).
- `hardware/` gateway viejo (Arduino UNO serial) — no tocar salvo pedido explícito.
- `informe/` informe P1 (`informe-proyecto-iot.pdf`), su nota (`Nota del pdf.png`) y la plantilla ACM
  donde vive el informe final.

## Documentos fuente de verdad (leer ANTES de trabajar)
- `docs/hardware-spec.md` — sensores, actuadores, MQTT, campos de datos, regla de costos.
- `docs/rubrica.md` — requisitos del curso, rúbrica y debilidades de P1.
- `docs/guia-diagramas.md` — reglas F1–F7 (flujo) y B1–B6 (bloques).
Si un documento y el código discrepan, gana el documento; si el documento tiene **[CONFIRMAR]**,
no inventes: deja pendiente en `informe/PENDIENTES.md`.

## Reglas duras
1. **No eliminar ninguna interfaz/vista/ruta** del frontend. Se adaptan, no se borran.
2. **Costos**: mostrar consumo/costo del propio nodo ("tan poco que ni se siente").
   PROHIBIDO comparar contra AC 24/7 / "Tradicional vs Cognitivo" en dashboard.
3. **Cero datos ficticios presentados como reales** en el informe: resultados, fotos, link del video,
   mediciones → si no existen, `\pendiente{...}` + entrada en `informe/PENDIENTES.md`.
4. **Referencias verificables**: toda cita debe existir (DOI/URL comprobado por `citation-verifier`).
   Estado del Arte solo ≥2019. IEEE estricto (`IEEEtran.bst`).
5. Backend: cambios solo **aditivos** (campos opcionales) para alimentar el frontend; `pytest` verde.
6. Redacción de autoría propia, sin muletillas de IA (ver lista en agente `report-critic`). Turnitin < 20 %.
7. No commitear/pushear sin pedido del usuario.

## Comandos
```bash
# Frontend (instalar una vez: cd frontend && npm install)
cd frontend && npm run build             # tsc + vite build = gate de tipos
# Backend
cd backend && pytest -q
# Checks de proyecto
python tools/checks/check_frontend_scope.py      # reglas frontend (vistas, costos, sensores nuevos)
python tools/checks/check_report.py              # estructura/rúbrica del .tex + log LaTeX
python tools/checks/check_report.py --final      # además falla si quedan \pendiente
bash tools/build_report.sh                       # compila informe y renderiza PNG por página
bash tools/build_diagrams.sh                     # compila diagramas TikZ y renderiza PNG
```
PNG de revisión visual en `informe/_render/` (ignorado por git). Leerlos con Read para auto-revisión.

## Informe — convenciones
- Carpeta: `informe/Association_for_Computing_Machinery__ACM____Generic_Journal_Manuscript_Template/`
- Principal: `informe.tex` (no editar `acmmanuscript.tex`, es el template original). Bib: `referencias.bib`.
- Figuras: `figuras/` (fotos, resultados), `figuras/diagramas/*.tex` (TikZ standalone).
- Labels obligatorios: `fig:bloques-hw`, `fig:arquitectura`, `fig:flujo`, `fig:sota`, `fig:resultados-*`.
- Macro `\pendiente{texto}` (definida en preámbulo, texto en rojo) para huecos que el equipo debe llenar.

## Orquestación (el hilo principal es el orquestador; los subagentes NO lanzan otros agentes)
Agentes en `.claude/agents/`:

| Agente | Rol | Escribe en |
|---|---|---|
| `frontend-iot-adapter` | adapta vistas a sensores/actuadores nuevos y costos | `frontend/`, backend aditivo |
| `frontend-critic` | audita frontend vs spec + rúbrica dashboard; solo lectura | `docs/bitacora-frontend.md` |
| `report-writer` | redacta/edita LaTeX | `informe.tex`, `referencias.bib` |
| `report-critic` | profesor exigente: califica por criterio, da hallazgos accionables | `informe/BITACORA.md` |
| `citation-verifier` | verifica existencia, año, pertinencia, formato IEEE | `informe/BITACORA.md` |
| `diagram-designer` | crea diagramas TikZ con auto-revisión visual | `figuras/diagramas/` |
| `diagram-critic` | audita diagramas contra F1–F7/B1–B6 + anti-genérico | `informe/BITACORA.md` |

Ciclo (comando `/orquestar <frontend|informe|diagramas|todo>`):
1. **Crítico** evalúa estado actual → escribe iteración N en bitácora (hallazgos con severidad + ID).
2. **Constructor** aplica fixes de la iteración N → marca cada hallazgo `FIX` / `NO-FIX (motivo)`.
3. Gates automáticos (build, pytest, checks) → si fallan, vuelve a 2.
4. Repetir. **Criterio de parada**: crítico da Sobresaliente en TODOS los criterios en **2 iteraciones
   seguidas**, 0 hallazgos ALTA/MEDIA abiertos, todos los gates verdes. Máx. 8 iteraciones por pista;
   si se alcanza, parar y reportar bloqueos al usuario.
Pistas independientes (frontend ∥ diagramas ∥ informe-texto) pueden correr en paralelo: tocan carpetas
disjuntas. `report-writer` solo integra diagramas ya aprobados por `diagram-critic`.
