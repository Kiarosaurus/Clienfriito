# Guía de diagramas — reglas verificables

Fuente: `Guia Diagramas.pdf` (CS5055, 9 sep 2026). Cada regla tiene ID para citarla en la bitácora.

## Diagrama de flujo (lógica de programación)
- F1 Simbología: óvalo = Inicio/Fin; rectángulo = proceso; rombo = decisión; paralelogramo = entrada/salida (lectura de sensores, publicar/mostrar); flecha = flujo.
- F2 Dirección general arriba→abajo y izquierda→derecha.
- F3 Un único "Inicio"; múltiples retornos permitidos si es bucle continuo.
- F4 Decisiones = preguntas cerradas (`¿CO > 50 ppm?`, `¿T > T_obj + 0.5 °C?`); exactamente 2 salidas etiquetadas **V** y **F**.
- F5 Jerarquía de prioridades: la condición de mayor prioridad (seguridad CO) se evalúa primero; solo si el ambiente es seguro se evalúa lo demás (ver ejemplo Lab 2 de la guía).
- F6 Control no bloqueante (temporizadores `millis()`-style en vez de `delay` largos; debounce/tiempo mínimo explícito).
- F7 Lecturas de sensores y publicación MQTT dibujadas con paralelogramo.

## Diagrama de bloques (arquitectura de hardware)
- B1 Microcontrolador al **centro**; entradas apuntan HACIA él; salidas reciben flechas DESDE él.
- B2 **Separar potencia de control**: estilo de línea distinto (p. ej. gruesa/roja = energía, fina/negra = datos) + leyenda.
- B3 **Cada flecha etiquetada con el protocolo/tipo de señal**: I2C, analógica (ADC1), digital 1-wire, PWM, GPIO, WiFi/MQTT.
- B4 Distribución radial **sin cruce de líneas**.
- B5 Fuentes y niveles de tensión explícitos (12 V, 5 V regulado, 3.3 V) — omitirlos costó puntos en P1.
- B6 Título del subsistema en el recuadro (ej. "NODO DE CONTROL TÉRMICO — AULA A403") y agrupaciones (sistema de control / etapa de potencia).

## Anti-genérico (motivo del descuento en P1)
- Nombrar el componente real (DHT11, MQ-7, INA219, IRLZ44N…), no "Sensores".
- Indicar tensión, protocolo, pin/canal o dirección I2C donde aporte.
- Incluir elementos de interfaz reales: divisor 5→3.3 V para AOUT de MQ, MOSFET + diodo flyback, buck.
- Diagrama de sistema (nodo → broker → backend → dashboard) es figura SEPARADA del diagrama de hardware.
- Figura explicativa basada en Estado del Arte = otra figura separada (ej. reactivo vs anticipativo).

## Formato de producción
TikZ en archivos `standalone` bajo `informe/Association_.../figuras/diagramas/`, compilados a PDF e incluidos con `\includegraphics`. Fuente legible a 1 columna (≥ 7 pt efectivo). Escala de grises legible (impresión B/N).
