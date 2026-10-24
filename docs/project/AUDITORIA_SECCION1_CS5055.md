# Auditoría de cumplimiento — Sección 1 "Acerca del Proyecto Final" (CS5055 IoT 2026-2)

**Proyecto:** Climate Cognitive System (CCS)
**Fecha de revisión:** 2026-09-01
**Alcance:** exclusivamente la Sección 1 del documento `docs/project/CS5055_Proyectos262.pdf` (1.1 Requisitos Técnicos Mínimos, 1.2 Proyectos No Aceptados, 1.3 Propuestas Sugeridas).
**Base de evidencia:** código del repositorio en `main` (commit `51853cc`), `hardware/gateway/sistema.py`, `hardware/gateway/README.md`, `backend/app/`, e `docs/report/informe_ICC_Climate_system.pdf`.

---

## 1. Veredicto ejecutivo

| | |
|---|---|
| **Requisitos obligatorios de 1.1 cumplidos** | **2 de 5** |
| **Requisitos obligatorios de 1.1 incumplidos** | **3 de 5** (Actuador, Comunicación Inalámbrica, Enclosure) |
| **Cumple 1.2 (no es tema descartado)** | Sí |
| **Cumple 1.3 (proyecto alternativo válido)** | **No, con la evidencia actual** |

El proyecto es **excepcionalmente fuerte en la capa de software y de datos, y estructuralmente débil en la capa física**, que es justamente lo que la Sección 1 evalúa. Hoy el sistema es una plataforma IoT de *telemetría y decisión*: mide, infiere y muestra, pero **no acciona nada en el mundo físico**. En el vocabulario del curso, hay un nodo sensor, no un sistema IoT con lazo cerrado.

El riesgo no es que el proyecto sea malo; es que **la rúbrica de la Sección 1 no premia lo que el equipo ya construyó**. La ingeniería de backend, el modelo `HistGradientBoostingRegressor` validado contra baselines, la persistencia poliglota y el reporte de ROI valen mucho — pero ninguna de esas piezas satisface las viñetas "Actuador", "Comunicación Inalámbrica" o "Enclosure".

---

## 2. Cumplimiento detallado de 1.1 (Requisitos Técnicos Mínimos)

### 2.1 Sensores — mínimo 3 → ✅ **CUMPLE**

| Sensor | Variable | Evidencia |
|---|---|---|
| DHT11 | temperatura (°C), humedad (%) | `hardware/gateway/sistema.py:253-254`, `hardware/gateway/README.md` |
| MQ-135 | CO₂-proxy (ppm) → ocupación real | `hardware/gateway/sistema.py:262` |
| MQ-7 | CO (ADC → ppm por curva de datasheet) | `hardware/gateway/sistema.py:60-77` |
| Cámara + MediaPipe | aforo por cruce de línea virtual | `hardware/gateway/sistema.py:125-235` |

Tres módulos físicos independientes, más un cuarto canal de percepción por visión. Se supera el mínimo con holgura.

**Observación crítica:** el MQ-7 tiene calibración documentada (`MQ7_R0`, procedimiento de aire limpio en `hardware/gateway/README.md`), lo cual es una fortaleza real y diferencial. El MQ-135, en cambio, se consume como `air_quality_ppm` **sin curva de calibración propia** — se está tratando una lectura cruda de calidad de aire como si fuera CO₂ en ppm, y sobre ese número se apoya el balance de masa que estima la ocupación real. Es el eslabón cuantitativamente más frágil de toda la cadena, y un docente de IoT lo va a preguntar. Documenten la conversión o degrádenlo explícitamente a "proxy relativo, no ppm absolutos".

---

### 2.2 Actuador — mínimo 1 funcional → ❌ **NO CUMPLE (bloqueante)**

**No existe ningún actuador en el repositorio.** Ni físico, ni en código, ni en el diagrama de flujo de datos.

Evidencia:

- No hay ningún archivo `.ino`, `.cpp` ni sketch de Arduino versionado. El firmware del nodo no está en el repo.
- `hardware/gateway/sistema.py` es **unidireccional**: hilo serial → lee; hilo cámara → cuenta; hilo combinado → `POST`. No hay ninguna escritura hacia el puerto serial (`ser.write(...)` no aparece en las 337 líneas del archivo). El Arduino nunca recibe un comando.
- La respuesta del servidor con `cognitive_action` **solo se imprime en consola** (`hardware/gateway/sistema.py:288-289`): `print(f"[POST] OK 201 — ac_status={accion}")`. Se descarta.
- El endpoint `PUT /sensors/{id}/control` (`backend/app/routes/sensors.py:277-330`) **no controla ningún dispositivo**: valida rol y reserva, y luego escribe dos flags booleanos (`is_active`, `control_enabled`) en PostgreSQL. Es control de *permisos de ingesta*, no de actuación.
- El `cognitive_action` (`ON` / `PRE-COOLING` / `STANDBY` / `DISABLED`) es un string persistido en MongoDB y renderizado en el dashboard. Nada más.
- El propio informe lo reconoce: la tabla de hardware marca el emisor IR con asterisco — *"Actuador de fase 2: en la versión inicial la acción cognitiva se visualiza en la app; el envío IR real al A/C es funcionalidad opcional"* — y la sección de alcance lista "Control real del A/C por emisor IR" como **fuera de alcance**.

Nota adicional del enunciado: *"Las pantallas LCD o displays no cuentan como actuadores"*. Por analogía directa, **un dashboard web tampoco es un actuador**. El argumento "nuestra salida es la decisión mostrada en la interfaz" no va a sobrevivir la evaluación.

Este es el incumplimiento más grave, porque es el único de la lista que es **binario**: o hay un actuador que se mueve, o no lo hay.

---

### 2.3 Comunicación Inalámbrica — etapa con protocolo (LoRa, MQTT, Bluetooth, RF, Zigbee…) → ❌ **NO CUMPLE**

El enlace nodo↔gateway es **USB-Serial cableado**:

```
Arduino UNO ──[USB Serial 9600 baud]──► laptop (sistema.py) ──[HTTPS]──► backend
```

`hardware/gateway/sistema.py:29-30`: `SERIAL_PORT = 'COM6'`, `BAUD_RATE = 9600`.

El único tramo inalámbrico es el WiFi de la laptop hacia `kiarosaurus.me`. **Eso no cuenta como la "etapa" que pide el enunciado**, por dos razones:

1. Es infraestructura de red de propósito general, no un protocolo IoT diseñado ni implementado por el equipo. El curso pide una *etapa* de comunicación — es decir, una decisión de diseño de enlace que el equipo justifique (alcance, consumo, topología, MTU, QoS).
2. La lista explícita del enunciado (LoRa, MQTT, Bluetooth, RF, Zigbee) es de protocolos de la capa de dispositivo. HTTPS sobre WiFi corporativo desde un laptop no pertenece a esa familia, y además exige explícitamente *"consultar previamente con el docente"* — cosa que, si van a defender WiFi/HTTPS, deben hacer **por escrito y antes**.

Además hay un problema práctico grave para la demo: el nodo depende de una **laptop con cámara, OpenCV, MediaPipe y un cable USB** para poder transmitir. Eso es un gateway, no un nodo IoT desplegable, y se nota en una demostración en vivo.

---

### 2.4 Interfaz Gráfica con procesamiento previo → ✅ **CUMPLE, con margen amplio**

Es el punto más fuerte del proyecto y, con diferencia, el que mejor supera lo pedido. El enunciado pide un dashboard que *"no solo visualice datos, sino que incluya un procesamiento previo de los mismos para obtener métricas que respalden el correcto funcionamiento del sistema"*. El proyecto entrega:

- **Modelo ML real y validado**: `HistGradientBoostingRegressor` con holdout cronológico y dos baselines (media y solo-ocupación); si `beats_baselines` es falso, el modelo no se despliega y el sistema cae a heurística transparente (`ml/pipeline/train_model.py`, `backend/app/services/predictive_service.py`).
- **Ocupación real inferida por balance de masa de CO₂**, contrastada contra el conteo directo de cámara (`backend/app/services/occupancy_service.py`).
- **Reporte de ROI** en kWh y USD sobre ventana de 7 días, reconstruyendo el runtime desde el histórico de `cognitive_action` (`backend/app/routes/reports.py`).
- **Monitor de emergencias de CO** con ventana deslizante de 15 s y clasificación real/simulado.
- RBAC con JWT, control condicionado a reservas activas, y degradación elegante ante ausencia de modelo o de credenciales.

Esto excede el requisito. **No inviertan más esfuerzo aquí**; el retorno marginal en la rúbrica de Sección 1 es cercano a cero comparado con cerrar los tres huecos físicos.

---

### 2.5 Aplicativo Móvil — [OPCIONAL] → ⚪ **No implementado (no penaliza)**

No hay app móvil. El requisito es explícitamente opcional. No es prioridad frente a los bloqueantes.

---

### 2.6 Enclosure / Case — impresión 3D o materiales reciclados → ❌ **NO CUMPLE**

Cero evidencia en todo el repositorio: no hay archivos `.stl`, `.step`, `.f3d`, ni fotos, ni una sección de carcasa en `hardware/gateway/README.md`, ni mención en el informe. El enunciado indica además que *"se evaluará el acabado visual y profesional"*, es decir, no basta con existir: se califica la calidad.

Es el incumplimiento más **barato de resolver** de los tres, y el que más impacto visual tiene en la demostración de la S15.

---

### 2.7 Puntaje Bonus — PCB propia → ⚪ **No implementado (bonus, no penaliza)**

Sin evidencia. Es puntaje extra; sensato ignorarlo hasta cerrar lo obligatorio.

---

## 3. Cumplimiento de 1.2 (Proyectos No Aceptados) → ✅ **CUMPLE**

El proyecto no cae en ninguna de las cuatro categorías descartadas (riego inteligente, alimentador de mascotas, estacionamiento inteligente, portón/control de acceso). Tema limpio y, de hecho, considerablemente más original que la media. Sin observaciones.

---

## 4. Cumplimiento de 1.3 (Propuestas Sugeridas / Proyecto Alternativo) → ❌ **NO CUMPLE con la evidencia actual**

CCS no corresponde a ninguna de las 10 líneas sugeridas. Cae por tanto en **"Proyectos alternativos"**, categoría que impone dos condiciones acumulativas:

> *"Se permite proponer otros temas que cumplan **estrictamente** con los requisitos mínimos de hardware/software y cuenten con **validación del Estado del Arte**. Consultar previamente con el docente."*

**Condición 1 — cumplir estrictamente los requisitos mínimos:** hoy no se cumple (§2.2, §2.3, §2.6). El adverbio *"estrictamente"* elimina el margen de interpretación.

**Condición 2 — validación del Estado del Arte:** el único informe versionado es `docs/report/informe_ICC_Climate_system.pdf`, y presenta tres problemas serios frente a CS5055:

1. **Es de otro curso.** El encabezado dice "Computación Cognitiva — UTEC", fechado 2 de julio de 2026. No es un entregable de CS5055 y su índice no sigue la estructura que exige el enunciado.
2. **No tiene sección de Estado del Arte.** El índice va de "Problema identificado" a "Propuesta de solución" sin análisis de trabajos previos.
3. **Bibliografía insuficiente.** Dos referencias en total: ASHRAE Standard 55 (norma, no paper) y Pérez-Lombard et al., *Energy and Buildings*, **2008**. La Sección 2.3 exige *dos artículos científicos por integrante* (equipo de 3 → mínimo 6 papers) y la 3.2.2 los acota a *los últimos 7 años* (≥ 2019). Ninguna de las dos referencias actuales califica.

Se puede reutilizar mucho del contenido, pero **hay que producir un informe nuevo para CS5055** con Estado del Arte propio y bibliografía IEEE reciente.

**Acción inmediata y de mayor prioridad:** obtener y guardar por escrito (correo) la aprobación explícita del docente para el tema alternativo, incluyendo el cambio A/C → ventilador. El enunciado exige consulta previa tanto para el proyecto alternativo como para el protocolo de comunicación. Sin ese respaldo, cualquier trabajo posterior es especulativo.

---

## 5. Sobre el cambio planificado: quitar el A/C y usar un ventilador

**Veredicto: decisión correcta, y además es la vía más rápida para desbloquear §2.2. Ejecútenla.** Con tres advertencias no triviales.

### 5.1 Por qué es correcta

- **El propio enunciado la respalda.** La propuesta sugerida N.º 7 lista literalmente *"ventilador de enfriamiento"* como actuador válido, y la N.º 1 (monitor de calidad de aire urbano) lista *"extractor de aire"* y *"servomotor para compuerta de ventilación"*. Un ventilador conmutado por relé es un actuador reconocido por el docente en este mismo documento.
- **Es demostrable en vivo.** El requisito 3.1 exige *"demostración en vivo del prototipo funcionando"* en 20 minutos. Un ventilador de 5 V/12 V que arranca cuando la ocupación o la temperatura cruzan el umbral es visible, audible e inmediato. Un emisor IR apuntando a un A/C que no existe en el aula es indemostrable — y ese es exactamente el callejón sin salida del que están saliendo.
- **Elimina la dependencia de infraestructura ajena.** El sistema deja de necesitar un equipo de terceros para cerrar el lazo.

### 5.2 Advertencia 1 — el cambio no es solo de hardware, es de modelo

El ventilador **no reemplaza funcionalmente al A/C**: un A/C extrae calor y alcanza un setpoint; un ventilador solo aumenta la convección y la temperatura percibida. Todo el andamiaje de "pre-cooling" está construido sobre semántica de aire acondicionado y hay que rearmar la narrativa:

- `ac_btu` es una **feature de entrenamiento** del modelo (`ml/pipeline/train_model.py:54`), con valores de 24 000–36 000 BTU por aula en `backend/app/services/room_profile.py:25-30`. Si el actuador es un ventilador, esa feature deja de tener significado físico.
- El reporte de ROI asume `AC_POWER_KW = 2.5` (`backend/app/routes/reports.py:32`). Un ventilador consume ~0.02–0.05 kW. Los ahorros reportados en USD dejan de corresponder al hardware demostrado, lo cual es un flanco abierto en preguntas.
- El `cognitive_action` seguirá emitiendo `PRE-COOLING`, término que ya no describe lo que hace el actuador.

**Recomendación:** no borren la capa de A/C — **reencuádrenla**. La formulación defendible es: *el sistema calcula la demanda térmica y emite una acción de climatización; el prototipo materializa esa acción sobre un ventilador de ventilación forzada como actuador demostrable, y el modelo de ROI se parametriza para el equipo real de aula (A/C, 2.5 kW) documentando explícitamente la equivalencia.* Es decir: el ventilador es el actuador **real y funcional** exigido por 1.1, y el A/C es el caso de despliegue a escala. Esto es honesto, se sostiene ante preguntas, y no obliga a tirar el modelo ni el reporte de ROI. Lo que **no** deben hacer es dejar constantes de A/C sin anotar mientras demuestran un ventilador — eso sí se lee como inconsistencia.

### 5.3 Advertencia 2 — un ventilador solo cuenta si el lazo se cierra en el firmware

Enchufar un ventilador no resuelve nada por sí solo. Para que cuente como *"actuador funcional"* debe existir la ruta completa:

```
backend (cognitive_action) → respuesta HTTP → gateway → enlace inalámbrico → nodo → relé/MOSFET → ventilador
```

Hoy faltan los últimos cuatro eslabones. Como mínimo hay que:

1. Consumir `cognitive_action.ac_status` de la respuesta del `POST` en lugar de solo imprimirlo (`hardware/gateway/sistema.py:288`).
2. Abrir el canal descendente hacia el nodo (ver §5.4 — resuélvanlo junto con el requisito de comunicación inalámbrica).
3. Escribir el firmware del nodo (que además **hoy no está versionado**) con la lógica de conmutación, y **subirlo al repositorio**.
4. Conmutar la carga con **módulo de relé o MOSFET**, nunca directamente desde un pin del Arduino. Un ventilador de 12 V excede el límite de corriente de un pin GPIO y lo destruye. Si el ventilador es de 12 V, necesita fuente separada, masa común y diodo de retorno (flyback) por ser carga inductiva.
5. Añadir **histéresis o tiempo mínimo de encendido** para evitar que el ventilador oscile ON/OFF en cada lectura de ~2 s. Sin esto, la demo en vivo se ve mal y el motor sufre.

### 5.4 Advertencia 3 — resuelvan actuador y comunicación inalámbrica de una sola vez

Los dos incumplimientos bloqueantes tienen una solución conjunta. La opción de menor riesgo:

**Reemplazar el enlace USB-Serial por ESP32 + MQTT.** El ESP32 sustituye al Arduino UNO como nodo (mantiene DHT11, MQ-135, MQ-7), publica telemetría por MQTT y **se suscribe a un tópico de comando** que enciende el ventilador vía relé. Con esto:

- Queda cubierto §2.2 (actuador real, comandado remotamente).
- Queda cubierto §2.3 (MQTT es el primer protocolo de la lista del enunciado, y es inalámbrico sobre WiFi).
- Desaparece la dependencia del cable USB y de la laptop como puente obligatorio de telemetría (la cámara puede seguir en la laptop como canal aparte).
- El backend ya expone la decisión; solo hay que publicarla al bróker.

Alternativa de menor esfuerzo si el tiempo aprieta: **mantener el Arduino UNO y añadir HC-05 (Bluetooth SPP)** entre nodo y laptop. Cubre §2.3 con cambios mínimos en `sistema.py` (el puerto BT se abre como puerto serie), y el canal es bidireccional, así que también habilita el comando del ventilador. Es menos elegante que MQTT y menos defendible como arquitectura IoT, pero cumple la letra del requisito.

**Cualquiera de las dos requiere consulta previa con el docente**, según indica el propio enunciado en la viñeta de comunicación.

---

## 6. Plan de remediación priorizado

Ordenado por relación impacto-en-rúbrica / esfuerzo.

| # | Acción | Requisito que cierra | Prioridad |
|---|---|---|---|
| 1 | Confirmar por escrito con el docente: tema alternativo + cambio A/C→ventilador + protocolo elegido | 1.3 y 1.1 (comunicación) | **Bloqueante** |
| 2 | Migrar el nodo a ESP32 + MQTT (o HC-05 como plan B) | 1.1 Comunicación Inalámbrica | **Crítica** |
| 3 | Ventilador conmutado por relé/MOSFET, comandado desde `cognitive_action`, con histéresis | 1.1 Actuador | **Crítica** |
| 4 | Versionar el firmware del nodo en `hardware/` (hoy no está en el repo) | Evidencia de implementación | **Alta** |
| 5 | Carcasa impresa en 3D o en material reciclado, con acabado cuidado y fotografiada | 1.1 Enclosure | **Alta** |
| 6 | Informe nuevo para CS5055 con Estado del Arte y ≥6 papers IEEE de los últimos 7 años | 1.3 y 3.2.2 | **Alta** |
| 7 | Anotar/parametrizar `AC_POWER_KW` y `ac_btu` frente al actuador real demostrado | Coherencia técnica ante preguntas | Media |
| 8 | Documentar o degradar la conversión del MQ-135 a ppm | Rigor de sensado | Media |
| 9 | PCB propia | Bonus | Baja |

---

## 7. Cierre

La brecha de este proyecto no es de capacidad técnica — el backend, el pipeline de ML y el dashboard están por encima de lo que la Sección 1 exige. La brecha es de **alineación con la rúbrica**: tres de las cinco viñetas obligatorias de 1.1 se apoyan en la capa física, y esa capa hoy consiste en un Arduino cableado que solo lee. Sustituir el A/C por un ventilador no es una concesión ni un recorte de ambición: es la pieza que convierte una plataforma de telemetría en un sistema IoT con lazo cerrado, y es la que hace posible la demostración en vivo de la Semana 15.
