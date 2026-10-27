# Rúbrica y requisitos — transcripción operativa

Fuentes: `CS5055_Proyectos262.pdf`, `informe/Nota del pdf.png`. Leer los originales si hay duda.

## Requisitos técnicos mínimos del proyecto
- ≥3 sensores; ≥1 actuador funcional (LCD/display NO cuenta).
- Comunicación inalámbrica con protocolo (MQTT aquí).
- **Dashboard con procesamiento previo**: no solo visualizar; métricas que respalden el correcto funcionamiento.
- Enclosure 3D/reciclado (acabado profesional). Bonus: PCB propia.

## Informe final P2 (entrega S14 — viernes 13 nov 2026)
Formato: LaTeX, plantilla ACM Generic Journal Manuscript. Turnitin < 20 %. Un solo PDF.
Estructura obligatoria (en este orden):
1. Título
2. Introducción, Problemática y Marco Teórico — consolidado CORREGIDO de P1; solo teoría estrictamente necesaria.
3. Estado del Arte — análisis extendido; artículos/tesis de **los últimos 7 años (≥2019)**; ≥2 papers por integrante (3 integrantes → ≥6).
4. Metodología y Desarrollo — diagrama de bloques/representación gráfica + **≥1 figura explicativa basada en el Estado del Arte**.
5. Implementación — evidencias reales: **diagrama de flujo** de la lógica; **diagrama de bloques con interconexiones**; **fotos del prototipo contextualizadas**.
6. Análisis de Resultados — figuras y tablas; **≥1 figura de resultados original** (generada por autores) explicada.
7. Descripción del Mercado — segmento + modelo de negocio en **máx. 2 párrafos**; figuras contextualizadas; **link al video publicitario**.
8. Conclusiones y Recomendaciones.
9. Referencias — **IEEE estricto y uniforme**.

## Rúbrica de calificación (P1, se asume misma vara en P2) — nota obtenida en P1

| Criterio | Pts | P1 | Sobresaliente exige |
|---|---|---|---|
| Introducción y Problemática | 2 | 2 | Contexto con **datos concretos**; justificación técnica y social; necesidad innegable respaldada por referencias reales verificables. |
| Marco Teórico y Estado del Arte | 3 | 2.5 | ≥2 artículos por integrante; citación rigurosa (IEEE); **análisis crítico que vincula** investigaciones con la propuesta (no descriptivo); fuentes comprobables. |
| Metodología Técnica | 2 | **1** | Componentes completos con **especificaciones técnicas clave**; MCU justificado técnicamente (**pines, memoria, protocolos**); diagrama de bloques **estructurado, lógico, correctamente etiquetado**. P1 cayó en "En proceso": *omisión de componentes fundamentales (fuentes de alimentación), diagrama excesivamente genérico*. |
| Objetivos y Alcances | 3 | 3 | Objetivos específicos, **medibles**, alineados; alcances/limitaciones delimitan frontera exacta. |
| Redacción y Presentación | 2 | 1.5 | Formato visual impecable; **citación rigurosa y uniforme**; redacción técnica fluida de autoría propia; sin errores ortográficos; cohesión. P1: inconsistencias menores en formato de citación/márgenes/estilo. |

Niveles inferiores a evitar explícitamente:
- "Inicial": información ficticia, uso de IA no verificado, referencias inexistentes/apócrifas, patrones sintácticos automatizados.
- "Logrado" (Metodología): justificación MCU superficial, etiquetas/conexiones omitidas en el diagrama.

## Debilidades concretas detectadas en P1 (punto de partida de la bitácora)
- Diagrama de bloques: 3 cajas genéricas, sin alimentación, sin protocolos por enlace, sin separación potencia/control.
- Justificación ESP32 sin números (pines ADC1, RAM/Flash, núcleos, frecuencia, consumo).
- Estado del Arte: Satish 2012, Batterman 2017 y patente 1982 fuera de ventana 7 años (válidos solo como Marco Teórico); análisis por párrafo descriptivo, falta tabla comparativa y brecha explícita.
- Ref [5] (Jurnal ILKOMEDIA, indonesio) y [8] (revista de agricultura) — verificar existencia y pertinencia.
- No hay diagrama de flujo, fotos, resultados, mercado ni video (exigidos en P2).

## Video publicitario
Estilo anuncio/"Feria del Hogar"; fotos/clips del prototipo; todos los integrantes en cámara. Speech de costo: "el gasto es tan poco que ni se siente".
