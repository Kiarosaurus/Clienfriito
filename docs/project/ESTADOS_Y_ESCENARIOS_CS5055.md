# Calienfriito (CCS), estados, prioridad de la alarma de CO y escenarios de prueba del log en Wokwi

Proyecto CS5055 Internet of Things (UTEC 2026-2), aula A403. Este documento describe los estados del sistema, la prioridad de la alarma de CO sobre el control de clima y los escenarios de recirculación del aire. Reúne además los 15 escenarios que se prueban a mano en Wokwi para validar el log del monitor serial (`sketch.ino`) y cierra con los hallazgos y pendientes de diseño.

**Contenido**

1. Estados del sistema
2. Prioridad de la alarma de CO sobre el control de clima
3. Escenarios de recirculación del aire ante CO elevado
4. Escenarios 1 a 15
5. Hallazgos y pendientes

---

## 1. Estados del sistema

El sistema siempre está en uno de estos estados, y se ve en la fila `Estado` del log.

| Estado | Cuándo se da | Ventilador | Calefactor | LED RGB | Buzzer |
|---|---|---|---|---|---|
| **DISABLED** (Desactivado) | El aula está vacía (lectura del MQ-135 menor que 2200), sin importar la temperatura | Apagado | Apagado | Apagado | OFF |
| **STANDBY** (En espera) | El aula está ocupada y no hace falta enfriar ni calentar: la temperatura está entre 23.5 °C y 24.5 °C, o el ventilador o el calefactor ya la llevaron al setpoint de 24.0 °C | Apagado | Apagado | Verde | OFF |
| **COOLING** (Enfriando) | El aula está ocupada y la temperatura es 24.5 °C o más. Se mantiene hasta que la temperatura baja a 24.0 °C o menos | 100 % | Apagado | Azul | OFF |
| **HEATING** (Calentando) | El aula está ocupada y la temperatura es 23.5 °C o menos. Se mantiene hasta que la temperatura sube a 24.0 °C o más | Apagado | Encendido | Ámbar (rojo y verde) | OFF |
| **ALARMA DE CO** | La lectura del MQ-7 es 50 ppm o más. Tiene prioridad sobre todos los demás estados | 100 % | Apagado | Rojo | ON |
| **PRE_COOLING** (Pre-enfriamiento) | Existe en el código, pero este firmware **no lo usa**: lo dispararía el modelo de IA según la ocupación esperada por reserva | 54 % | Apagado | Cian (verde y azul) | OFF |

- **Estado inicial:** El sistema arranca en STANDBY, con el LED verde, hasta que sale la primera lectura.
- **Temperatura entre 23.5 °C y 24.5 °C:** Se mantiene el estado en que ya estaba, salvo dos casos: COOLING pasa a STANDBY al llegar a 24.0 °C o menos, y HEATING pasa a STANDBY al llegar a 24.0 °C o más. Si el aula se ocupa estando en DISABLED, pasa a STANDBY.
- **Ventilador y calefactor:** Nunca están encendidos a la vez. Ambos se apagan en el setpoint de 24.0 °C, así que al terminar de enfriar no empieza a calentar, ni al revés.
- **Sin lectura del DHT22:** Se mantiene el último estado.
- **Cambio de ventilador:** Encender o apagar el ventilador exige que hayan pasado 60 s desde su último cambio. Los cambios entre estados con el ventilador apagado (STANDBY, DISABLED y HEATING) son inmediatos. El calefactor no tiene este intervalo, porque es una carga resistiva. Si el paso de COOLING a HEATING queda retenido, el calefactor sigue apagado hasta que el ventilador se apague. El primer cambio después del arranque tampoco espera.

---

## 2. Prioridad de la alarma de CO sobre el control de clima

Cuando en una misma situación el sistema puede hacer una acción de **control de clima** (encender, apagar o dejar el ventilador o el calefactor según la temperatura y la ocupación) y una acción de **control de CO** (la alarma), **se prioriza el control de CO**.

Mientras la lectura del MQ-7 sea 50 ppm o más, el ventilador queda al 100 %, el calefactor se apaga, suena el buzzer y el LED es rojo, aunque el clima pidiera otra cosa (por ejemplo, ventilador apagado porque el aula está vacía, o calefactor encendido porque la temperatura es 23.5 °C o menos). El control de clima se reanuda recién cuando la lectura baja de 50 ppm. La razón es que la seguridad de las personas tiene prioridad sobre la comodidad y el ahorro de energía.

En el log se ve así:

```
|   Estado     ALARMA DE CO - Control de clima suspendido
|   Motivo     CO >= 50 ppm: ventilador al 100 %, calefactor OFF y buzzer ON
```

Los escenarios 3, 8, 9, 12 y 14 muestran esta prioridad.

---

## 3. Escenarios de recirculación del aire ante CO elevado

Depende de qué hace físicamente ese ventilador:

| Ventilador real | Efecto sobre el CO | ¿Tiene sentido la regla? |
|---|---|---|
| Extrae aire del aula o mete aire exterior | El CO se diluye y baja | **Sí.** Ventilar es lo primero que se recomienda ante CO elevado, junto con avisar y evacuar. |
| Solo recircula el aire interior (ventilador de enfriamiento) | El CO se mezcla pero no sale | **Poco.** Mezclar no saca el CO, y si la fuente es localizada puede esparcirlo. |
| Es el ventilador de enfriamiento y no hay salida de aire al exterior | El CO no baja | **No ayuda.** Queda solo el aviso del buzzer. |

---

# Escenarios 1 a 15

## Escenario 1: Arranque y formato

**Contexto:** Primer arranque con el aula vacía. Se ve el banner, el estado inicial y el primer bloque. Luego cambias el DHT22 a 28 °C y 70 % para comprobar que sus valores y sus etiquetas se actualizan en el bloque, y que aunque haga calor, con el aula vacía, el ventilador sigue apagado.

**Antes de empezar:** Detén la simulación. Deja los potenciómetros del MQ-135 y del MQ-7 en 0 y el DHT22 con `{ "temperature": "26", "humidity": "55" }`. Inicia la simulación.

| Paso | Espera a ver | Haz | Debe aparecer |
|---|---|---|---|
| Al iniciar | El banner, las líneas SIS y RED y el primer bloque | Nada | T = 26.0 C CALIDO y HR = 55 % MODERADO |
| 1 | El primer bloque | Pon el DHT22 en 28 °C de temperatura y 70 % de humedad | El siguiente bloque con T = 28.0 C CALIDO y HR = 70 % HUMEDO, sigue DISABLED y ventilador OFF |

**Activaciones de actuadores**

| Paso | Se activa | Por qué |
|---|---|---|
| Al iniciar | **LED verde**, durante los primeros ~2 s | El sistema arranca en estado STANDBY (en espera), y STANDBY se muestra con LED verde. Todavía no hay ninguna lectura de sensores que cambie ese estado. En cuanto sale el primer bloque, la lectura del MQ-135 es 0 (de 4095), menor que el umbral de ocupación de 2200, así que el aula cuenta como vacía, el estado pasa a DISABLED y el LED se apaga. |

Después del arranque no se activa ningún actuador en este escenario. Con el aula vacía (lectura del MQ-135 = 0, menor que 2200) el estado es DISABLED, aunque la temperatura de 28.0 °C esté en CALIDO (24.5 °C o más).

**Log esperado**

Al iniciar:
```
==================================================================
 Calienfriito - Nodo de control termico, Aula A403
 CS5055 Internet of Things - UTEC 2026-2 (simulacion en Wokwi)
------------------------------------------------------------------
 Setpoint: 24.0 C | Intervalo on/off del ventilador: 60 s
 Ventilador: ON con T >= 24.5 C, OFF con T <= 24.0 C
 Calefactor: ON con T <= 23.5 C, OFF con T >= 24.0 C
 Umbral de ocupacion (MQ-135): 2200/4095 | Umbral de CO: 50 ppm
 Periodo de muestreo: 2 s
------------------------------------------------------------------
 Etiquetas: SIS sistema | RED red | EVT eventos
 Cada lectura se muestra como un bloque CICLO (sensores, decision, actuadores)
==================================================================
[     0.3 s] SIS  DHT22      | sensor   | D4
[     0.3 s] SIS  MQ-135     | sensor   | D34 (ADC1)
[     0.3 s] SIS  MQ-7       | sensor   | D35 (ADC1)
[     0.3 s] SIS  Ventilador | actuador | D25 (PWM)
[     0.3 s] SIS  Calefactor | actuador | D32
[     0.3 s] SIS  Buzzer     | actuador | D26
[     0.3 s] SIS  LED RGB    | actuador | D27 (R), D14 (G), D13 (B)
[     0.3 s] SIS  Estado inicial: STANDBY | LED=VERDE (en espera)
[     0.3 s] RED  Conectando a la red WiFi "Wokwi-GUEST"
[     0.3 s] RED  WiFi conectado | IP 10.0.0.2 | RSSI -60 dBm
[     2.3 s] EVT  Transicion de estado: STANDBY -> DISABLED
+-- CICLO 1   | t =    2.3 s ------------------------------
| SENSORES
|   DHT22      T = 26.0 C    CALIDO (T >= 24.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC    0/4095   AULA VACIA (ADC < 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     DISABLED - Desactivado
|   Motivo     Aula vacia (MQ-135 < 2200)
| ACTUADORES
|   Ventilador OFF [----------]   0 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    OFF sin color (aula vacia)
+------------------------------------------------
```

Tras el paso 1:
```
+-- CICLO 2   | t =    4.3 s ------------------------------
| SENSORES
|   DHT22      T = 28.0 C    CALIDO (T >= 24.5 C)
|              HR = 70 %     HUMEDO (HR >= 60 %)
|   MQ-135     ADC    0/4095   AULA VACIA (ADC < 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     DISABLED - Desactivado
|   Motivo     Aula vacia (MQ-135 < 2200)
| ACTUADORES
|   Ventilador OFF [----------]   0 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    OFF sin color (aula vacia)
+------------------------------------------------
```

---

## Escenario 2: Ocupación del aula sin necesidad de enfriar ni calentar

**Contexto:** Comprueba qué hace el sistema cuando el aula pasa a estar ocupada y no hace falta enfriar ni calentar. Con temperatura de 24.0 °C (TEMPLADO, entre 23.5 °C y 24.5 °C), al ocuparse el aula el estado pasa de DISABLED a STANDBY, y cuando el aula se vacía vuelve a DISABLED. En ambos cambios el ventilador y el calefactor siguen apagados, así que el cambio es inmediato y no espera 60 s.

**Antes de empezar:** Detén la simulación. Deja los potenciómetros del MQ-135 y del MQ-7 en 0 y el DHT22 con `{ "temperature": "26", "humidity": "55" }`. Inicia la simulación.

| Paso | Espera a ver | Haz | Debe aparecer |
|---|---|---|---|
| Al iniciar | El primer bloque | Nada | DISABLED y aula vacía |
| 1 | El primer bloque | Pon la temperatura del DHT22 en 24.0 °C | T = 24.0 C TEMPLADO, sigue DISABLED |
| 2 | Un bloque con T = 24.0 C | Sube el potenciómetro del MQ-135 hasta que el log muestre ADC 2800 (el aula pasa a estar ocupada) | Evento DISABLED -> STANDBY, ADC 2800 AULA OCUPADA, STANDBY - En espera y LED verde |
| 3 | Un bloque con ADC 2800 | Baja el MQ-135 a 0 (ADC 0, el aula se vacía) | Evento STANDBY -> DISABLED, AULA VACIA y LED apagado |

**Activaciones de actuadores**

| Paso | Se activa | Por qué |
|---|---|---|
| Al iniciar | **LED verde**, durante los primeros ~2 s | El sistema arranca en estado STANDBY (en espera), y STANDBY se muestra con LED verde. Todavía no hay ninguna lectura de sensores que cambie ese estado. En cuanto sale el primer bloque, la lectura del MQ-135 es 0 (de 4095), menor que el umbral de ocupación de 2200, así que el aula cuenta como vacía, el estado pasa a DISABLED y el LED se apaga. |
| 2 | **LED verde** | La lectura del MQ-135 (el ADC, de un máximo de 4095) subió a 2800, que supera el umbral de ocupación de 2200, así que el sistema considera el aula ocupada. La temperatura del DHT22 es 24.0 °C, que está entre 23.5 °C y 24.5 °C, así que no hace falta enfriar ni calentar. Con aula ocupada y sin necesidad de enfriar ni calentar, el estado es STANDBY (en espera), que se muestra con LED verde. El ventilador y el calefactor siguen apagados. |

En el paso 3, la lectura del MQ-135 baja a 0, menor que el umbral de ocupación de 2200, así que el aula vuelve a contar como vacía. El estado pasa a DISABLED y el LED verde se apaga. El cambio es inmediato porque el ventilador y el calefactor estaban apagados en los dos estados y no se aplica la espera de 60 s.

En el paso 1 no se activa nada: la lectura del MQ-135 sigue en 0 (menor que 2200), así que el aula cuenta como vacía.

**Log esperado**

Al iniciar:
```
[     2.3 s] EVT  Transicion de estado: STANDBY -> DISABLED
+-- CICLO 1   | t =    2.3 s ------------------------------
| SENSORES
|   DHT22      T = 26.0 C    CALIDO (T >= 24.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC    0/4095   AULA VACIA (ADC < 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     DISABLED - Desactivado
|   Motivo     Aula vacia (MQ-135 < 2200)
| ACTUADORES
|   Ventilador OFF [----------]   0 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    OFF sin color (aula vacia)
+------------------------------------------------
```

Tras el paso 1:
```
+-- CICLO 2   | t =    4.3 s ------------------------------
| SENSORES
|   DHT22      T = 24.0 C    TEMPLADO (23.5 C < T < 24.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC    0/4095   AULA VACIA (ADC < 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     DISABLED - Desactivado
|   Motivo     Aula vacia (MQ-135 < 2200)
| ACTUADORES
|   Ventilador OFF [----------]   0 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    OFF sin color (aula vacia)
+------------------------------------------------
```

Tras el paso 2:
```
[     6.3 s] EVT  Transicion de estado: DISABLED -> STANDBY
+-- CICLO 3   | t =    6.3 s ------------------------------
| SENSORES
|   DHT22      T = 24.0 C    TEMPLADO (23.5 C < T < 24.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC 2800/4095   AULA OCUPADA (ADC >= 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     STANDBY - En espera
|   Motivo     Aula ocupada y 23.5 C < T < 24.5 C: sin enfriar ni calentar
| ACTUADORES
|   Ventilador OFF [----------]   0 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    ON  VERDE (en espera)
+------------------------------------------------
```

Tras el paso 3:
```
[     8.3 s] EVT  Transicion de estado: STANDBY -> DISABLED
+-- CICLO 4   | t =    8.3 s ------------------------------
| SENSORES
|   DHT22      T = 24.0 C    TEMPLADO (23.5 C < T < 24.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC    0/4095   AULA VACIA (ADC < 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     DISABLED - Desactivado
|   Motivo     Aula vacia (MQ-135 < 2200)
| ACTUADORES
|   Ventilador OFF [----------]   0 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    OFF sin color (aula vacia)
+------------------------------------------------
```
---

## Escenario 3: Alarma de CO con el aula vacía

**Contexto:** Comprueba que la alarma de CO funciona por sí sola, sin importar la ocupación ni la temperatura. Con el aula vacía y el ventilador apagado por el clima, al subir el CO la alarma enciende el ventilador, el buzzer y el LED rojo. Al bajar el CO, todo vuelve a lo que decide el clima.

**Antes de empezar:** Detén la simulación. Deja los potenciómetros del MQ-135 y del MQ-7 en 0 y el DHT22 con `{ "temperature": "26", "humidity": "55" }`. Inicia la simulación.

| Paso | Espera a ver | Haz | Debe aparecer |
|---|---|---|---|
| Al iniciar | El primer bloque | Nada | DISABLED y aula vacía |
| 1 | El primer bloque | Sube el potenciómetro del MQ-7 hasta que el log muestre CO = 90 ppm | Evento "ALARMA DE CO ACTIVADA: 90 ppm >= 50 ppm...", bloque con ALARMA DE CO, ventilador 100 %, Buzzer ON y LED rojo |
| 2 | El bloque con la alarma (déjala activa los bloques que quieras) | Baja el MQ-7 a 0 (CO = 0 ppm) | Evento "Alarma de CO desactivada: 0 ppm < 50 ppm..." y vuelve a DISABLED, ventilador OFF, Buzzer OFF y LED apagado |

**Activaciones de actuadores**

| Paso | Se activa | Por qué |
|---|---|---|
| Al iniciar | **LED verde**, durante los primeros ~2 s | El sistema arranca en estado STANDBY (en espera), y STANDBY se muestra con LED verde. Todavía no hay ninguna lectura de sensores que cambie ese estado. En cuanto sale el primer bloque, la lectura del MQ-135 es 0 (de 4095), menor que el umbral de ocupación de 2200, así que el aula cuenta como vacía, el estado pasa a DISABLED y el LED se apaga. |
| 1 | **Ventilador 100 %, buzzer ON, LED rojo** | La lectura del MQ-7 subió a 90 ppm de CO, que supera el umbral de alarma de 50 ppm, así que se activa la alarma de CO. El ventilador renueva el aire, el buzzer avisa y el LED rojo indica la causa. La alarma pasa por encima del resto: se activa aunque el aula esté vacía (lectura del MQ-135 en 0, menor que el umbral de ocupación de 2200) y la temperatura esté en CALIDO (26.0 °C, que es 24.5 °C o más), y suspende el control de clima. En el paso 2 la lectura baja a 0 ppm, menor que 50 ppm, y la alarma termina en ese mismo bloque. Los actuadores vuelven a lo que decide el clima: con el aula vacía es DISABLED, es decir todo apagado. |

**Log esperado**

Al iniciar:
```
[     2.3 s] EVT  Transicion de estado: STANDBY -> DISABLED
+-- CICLO 1   | t =    2.3 s ------------------------------
| SENSORES
|   DHT22      T = 26.0 C    CALIDO (T >= 24.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC    0/4095   AULA VACIA (ADC < 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     DISABLED - Desactivado
|   Motivo     Aula vacia (MQ-135 < 2200)
| ACTUADORES
|   Ventilador OFF [----------]   0 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    OFF sin color (aula vacia)
+------------------------------------------------
```

Tras el paso 1:
```
[     4.3 s] EVT  ALARMA DE CO ACTIVADA: 90 ppm >= 50 ppm. Ventilador forzado al 100%, calefactor OFF y buzzer ON
+-- CICLO 2   | t =    4.3 s ------------------------------
| SENSORES
|   DHT22      T = 26.0 C    CALIDO (T >= 24.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC    0/4095   AULA VACIA (ADC < 2200)
|   MQ-7       CO = 90 ppm   ALARMA (CO >= 50 ppm)
| DECISION
|   Estado     ALARMA DE CO - Control de clima suspendido
|   Motivo     CO >= 50 ppm: ventilador al 100 %, calefactor OFF y buzzer ON
| ACTUADORES
|   Ventilador ON  [##########] 100 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     ON
|   LED RGB    ON  ROJO (Alarma CO)
+------------------------------------------------
```

Tras el paso 2:
```
[     6.3 s] EVT  Alarma de CO desactivada: 0 ppm < 50 ppm. Se reanuda el control por heuristica
+-- CICLO 3   | t =    6.3 s ------------------------------
| SENSORES
|   DHT22      T = 26.0 C    CALIDO (T >= 24.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC    0/4095   AULA VACIA (ADC < 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     DISABLED - Desactivado
|   Motivo     Aula vacia (MQ-135 < 2200)
| ACTUADORES
|   Ventilador OFF [----------]   0 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    OFF sin color (aula vacia)
+------------------------------------------------
```
---

## Escenario 4: Aula ocupada y caliente

**Contexto:** Caso normal de enfriamiento: el aula está ocupada (lectura del MQ-135 de 2200 o más) y la temperatura está en CALIDO (24.5 °C o más). Es el primer cambio de potencia del ventilador tras el arranque, así que la histéresis de 60 s no lo frena.

**Antes de empezar:** Detén la simulación. Deja los potenciómetros del MQ-135 y del MQ-7 en 0 y el DHT22 con `{ "temperature": "26", "humidity": "55" }`. Inicia la simulación.

| Paso | Espera a ver | Haz | Debe aparecer |
|---|---|---|---|
| Al iniciar | El primer bloque | Nada | DISABLED y aula vacía |
| 1 | El primer bloque | Sube el potenciómetro del MQ-135 hasta que el log muestre ADC 2800 (cualquier valor de 2200 o más sirve) | Evento DISABLED -> COOLING, COOLING - Enfriando, "Aula ocupada y T >= 24.5 C: ventilador ON", ventilador 100 % y LED azul |

**Activaciones de actuadores**

| Paso | Se activa | Por qué |
|---|---|---|
| Al iniciar | **LED verde**, durante los primeros ~2 s | El sistema arranca en estado STANDBY (en espera), y STANDBY se muestra con LED verde. Todavía no hay ninguna lectura de sensores que cambie ese estado. En cuanto sale el primer bloque, la lectura del MQ-135 es 0 (de 4095), menor que el umbral de ocupación de 2200, así que el aula cuenta como vacía, el estado pasa a DISABLED y el LED se apaga. |
| 1 | **Ventilador 100 %, LED azul** | La lectura del MQ-135 (el ADC, de un máximo de 4095) subió a 2800, que supera el umbral de ocupación de 2200, así que el sistema considera el aula ocupada. Además, la temperatura del DHT22 es 26.0 °C, que es 24.5 °C o más (setpoint 24.0 °C más 0.5 °C de margen), así que hace falta enfriar. Se cumplen las dos condiciones, el estado pasa a COOLING y el ventilador se enciende al 100 %. El LED azul indica "enfriando". El buzzer sigue apagado porque no hay alarma de CO (la lectura del MQ-7 es 0 ppm, menor que 50 ppm). |

**Log esperado**

Al iniciar:
```
[     2.3 s] EVT  Transicion de estado: STANDBY -> DISABLED
+-- CICLO 1   | t =    2.3 s ------------------------------
| SENSORES
|   DHT22      T = 26.0 C    CALIDO (T >= 24.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC    0/4095   AULA VACIA (ADC < 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     DISABLED - Desactivado
|   Motivo     Aula vacia (MQ-135 < 2200)
| ACTUADORES
|   Ventilador OFF [----------]   0 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    OFF sin color (aula vacia)
+------------------------------------------------
```

Tras el paso 1:
```
[     4.3 s] EVT  Transicion de estado: DISABLED -> COOLING
+-- CICLO 2   | t =    4.3 s ------------------------------
| SENSORES
|   DHT22      T = 26.0 C    CALIDO (T >= 24.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC 2800/4095   AULA OCUPADA (ADC >= 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     COOLING - Enfriando
|   Motivo     Aula ocupada y T >= 24.5 C: ventilador ON
| ACTUADORES
|   Ventilador ON  [##########] 100 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    ON  AZUL (enfriando)
+------------------------------------------------
```

---

## Escenario 5: Banda muerta

**Contexto:** Entre 23.5 °C y 24.5 °C, la zona TEMPLADO, el ventilador encendido sigue encendido mientras la temperatura no baje a 24.0 °C (el setpoint).

**Antes de empezar:** Detén la simulación. Deja los potenciómetros del MQ-135 y del MQ-7 en 0 y el DHT22 con `{ "temperature": "26", "humidity": "55" }`. Inicia la simulación.

| Paso | Espera a ver | Haz | Debe aparecer |
|---|---|---|---|
| Al iniciar | El primer bloque | Nada | DISABLED y aula vacía |
| 1 | El primer bloque | Sube el potenciómetro del MQ-135 hasta que el log muestre ADC 2800 | Evento DISABLED -> COOLING y COOLING - Enfriando |
| 2 | Un bloque con COOLING - Enfriando | Pon la temperatura del DHT22 en 24.2 °C | T = 24.2 C TEMPLADO, sigue COOLING - Enfriando y el Motivo dice "23.5 C < T < 24.5 C: se mantiene el estado" |

**Activaciones de actuadores**

| Paso | Se activa | Por qué |
|---|---|---|
| Al iniciar | **LED verde**, durante los primeros ~2 s | El sistema arranca en estado STANDBY (en espera), y STANDBY se muestra con LED verde. Todavía no hay ninguna lectura de sensores que cambie ese estado. En cuanto sale el primer bloque, la lectura del MQ-135 es 0 (de 4095), menor que el umbral de ocupación de 2200, así que el aula cuenta como vacía, el estado pasa a DISABLED y el LED se apaga. |
| 1 | **Ventilador 100 %, LED azul** | La lectura del MQ-135 (ADC) es 2800, mayor que el umbral de ocupación de 2200: el aula está ocupada. La temperatura del DHT22 es 26.0 °C, que es 24.5 °C o más: hace falta enfriar. El estado es COOLING. |
| 2 | Siguen activos: ventilador 100 %, LED azul | La temperatura del DHT22 bajó a 24.2 °C, que queda entre 23.5 °C y 24.5 °C y todavía no llega al setpoint de 24.0 °C, donde se apagaría el ventilador. El sistema conserva el estado anterior. Así se evita que el ventilador se encienda y se apague cada vez que la temperatura varía unas décimas. |

**Log esperado**

Al iniciar:
```
[     2.3 s] EVT  Transicion de estado: STANDBY -> DISABLED
+-- CICLO 1   | t =    2.3 s ------------------------------
| SENSORES
|   DHT22      T = 26.0 C    CALIDO (T >= 24.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC    0/4095   AULA VACIA (ADC < 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     DISABLED - Desactivado
|   Motivo     Aula vacia (MQ-135 < 2200)
| ACTUADORES
|   Ventilador OFF [----------]   0 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    OFF sin color (aula vacia)
+------------------------------------------------
```

Tras el paso 1:
```
[     4.3 s] EVT  Transicion de estado: DISABLED -> COOLING
+-- CICLO 2   | t =    4.3 s ------------------------------
| SENSORES
|   DHT22      T = 26.0 C    CALIDO (T >= 24.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC 2800/4095   AULA OCUPADA (ADC >= 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     COOLING - Enfriando
|   Motivo     Aula ocupada y T >= 24.5 C: ventilador ON
| ACTUADORES
|   Ventilador ON  [##########] 100 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    ON  AZUL (enfriando)
+------------------------------------------------
```

Tras el paso 2:
```
+-- CICLO 3   | t =    6.3 s ------------------------------
| SENSORES
|   DHT22      T = 24.2 C    TEMPLADO (23.5 C < T < 24.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC 2800/4095   AULA OCUPADA (ADC >= 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     COOLING - Enfriando
|   Motivo     23.5 C < T < 24.5 C: se mantiene el estado
| ACTUADORES
|   Ventilador ON  [##########] 100 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    ON  AZUL (enfriando)
+------------------------------------------------
```

---

## Escenario 6: Histéresis, apagado retenido por temperatura

**Contexto:** El aula está ocupada y se enfría. La temperatura baja a 23.8 °C, por debajo del setpoint de 24.0 °C, así que correspondería apagar el ventilador y pasar a STANDBY. Pero el ventilador se encendió hace menos de 60 s y el sistema retiene el estado COOLING hasta cumplir el intervalo mínimo. El contador "faltan N s" baja de 2 en 2.

**Antes de empezar:** Detén la simulación. Deja los potenciómetros del MQ-135 y del MQ-7 en 0 y el DHT22 con `{ "temperature": "26", "humidity": "55" }`. Inicia la simulación.

**Límite de tiempo:** El paso 2 debe hacerse antes de que pasen 60 s desde el encendido del ventilador. Si tardas más, el apagado ocurre sin retención y el escenario no se ve.

| Paso | Espera a ver | Haz | Debe aparecer |
|---|---|---|---|
| Al iniciar | El primer bloque | Nada | DISABLED y aula vacía |
| 1 | El primer bloque | Sube el potenciómetro del MQ-135 hasta que el log muestre ADC 2800 | Evento DISABLED -> COOLING |
| 2 | Un bloque con COOLING - Enfriando | **De inmediato**, pon la temperatura del DHT22 en 23.8 °C | Motivo "Histeresis: STANDBY retenido, faltan N s ..." con N menor que 60. El N inicial depende de cuánto demores |
| 3 | El bloque con "faltan N s" | **No toques nada.** Espera ~1 minuto | N baja de 2 en 2 en cada bloque y el estado sigue COOLING - Enfriando |
| 4 | N llegando a 2 | Sigue sin tocar nada | Evento COOLING -> STANDBY, ventilador OFF y LED verde |

**Activaciones de actuadores**

| Paso | Se activa | Por qué |
|---|---|---|
| Al iniciar | **LED verde**, durante los primeros ~2 s | El sistema arranca en estado STANDBY (en espera), y STANDBY se muestra con LED verde. Todavía no hay ninguna lectura de sensores que cambie ese estado. En cuanto sale el primer bloque, la lectura del MQ-135 es 0 (de 4095), menor que el umbral de ocupación de 2200, así que el aula cuenta como vacía, el estado pasa a DISABLED y el LED se apaga. |
| 1 | **Ventilador 100 %, LED azul** | La lectura del MQ-135 (ADC) es 2800, mayor que el umbral de ocupación de 2200: el aula está ocupada. La temperatura del DHT22 es 26.0 °C, que es 24.5 °C o más: hace falta enfriar. El estado es COOLING. |
| 2 y 3 | Siguen activos: ventilador 100 %, LED azul | La temperatura del DHT22 bajó a 23.8 °C, que es 24.0 °C o menos, y eso ya pide pasar a STANDBY, es decir apagar el ventilador. No pide calentar, porque no llega a 23.5 °C. Pero el ventilador se encendió hace menos de 60 s, y apagarlo tan pronto podría dañar el motor y provocaría cambios de estado continuos. El sistema retiene COOLING hasta cumplir el intervalo mínimo de 60 s, y el contador "faltan N s" muestra lo que falta. |
| 4 | **LED verde** | Pasaron los 60 s desde que se encendió el ventilador, así que el cambio ya está permitido. El aula sigue ocupada (lectura del MQ-135 en 2800, de 2200 o más) y la temperatura sigue en 23.8 °C (24.0 °C o menos), por lo que el estado es STANDBY. STANDBY apaga el ventilador, deja el calefactor apagado y se muestra con LED verde. |

**Log esperado**

Al iniciar:
```
[     2.3 s] EVT  Transicion de estado: STANDBY -> DISABLED
+-- CICLO 1   | t =    2.3 s ------------------------------
| SENSORES
|   DHT22      T = 26.0 C    CALIDO (T >= 24.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC    0/4095   AULA VACIA (ADC < 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     DISABLED - Desactivado
|   Motivo     Aula vacia (MQ-135 < 2200)
| ACTUADORES
|   Ventilador OFF [----------]   0 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    OFF sin color (aula vacia)
+------------------------------------------------
```

Tras el paso 1:
```
[     4.3 s] EVT  Transicion de estado: DISABLED -> COOLING
+-- CICLO 2   | t =    4.3 s ------------------------------
| SENSORES
|   DHT22      T = 26.0 C    CALIDO (T >= 24.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC 2800/4095   AULA OCUPADA (ADC >= 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     COOLING - Enfriando
|   Motivo     Aula ocupada y T >= 24.5 C: ventilador ON
| ACTUADORES
|   Ventilador ON  [##########] 100 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    ON  AZUL (enfriando)
+------------------------------------------------
```

Tras el paso 2:
```
+-- CICLO 3   | t =    6.3 s ------------------------------
| SENSORES
|   DHT22      T = 23.8 C    TEMPLADO (23.5 C < T < 24.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC 2800/4095   AULA OCUPADA (ADC >= 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     COOLING - Enfriando
|   Motivo     Histeresis: STANDBY retenido, faltan 58 s del intervalo minimo de 60 s
| ACTUADORES
|   Ventilador ON  [##########] 100 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    ON  AZUL (enfriando)
+------------------------------------------------
```

Durante el paso 3, a mitad de la espera y en el último bloque antes del cambio:
```
+-- CICLO 16  | t =   32.3 s ------------------------------
| SENSORES
|   DHT22      T = 23.8 C    TEMPLADO (23.5 C < T < 24.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC 2800/4095   AULA OCUPADA (ADC >= 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     COOLING - Enfriando
|   Motivo     Histeresis: STANDBY retenido, faltan 32 s del intervalo minimo de 60 s
| ACTUADORES
|   Ventilador ON  [##########] 100 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    ON  AZUL (enfriando)
+------------------------------------------------
+-- CICLO 31  | t =   62.3 s ------------------------------
| SENSORES
|   DHT22      T = 23.8 C    TEMPLADO (23.5 C < T < 24.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC 2800/4095   AULA OCUPADA (ADC >= 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     COOLING - Enfriando
|   Motivo     Histeresis: STANDBY retenido, faltan 2 s del intervalo minimo de 60 s
| ACTUADORES
|   Ventilador ON  [##########] 100 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    ON  AZUL (enfriando)
+------------------------------------------------
```

Tras el paso 4:
```
[    64.3 s] EVT  Transicion de estado: COOLING -> STANDBY
+-- CICLO 32  | t =   64.3 s ------------------------------
| SENSORES
|   DHT22      T = 23.8 C    TEMPLADO (23.5 C < T < 24.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC 2800/4095   AULA OCUPADA (ADC >= 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     STANDBY - En espera
|   Motivo     T <= 24.0 C (setpoint alcanzado): ventilador OFF
| ACTUADORES
|   Ventilador OFF [----------]   0 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    ON  VERDE (en espera)
+------------------------------------------------
```

---

## Escenario 7: Aula que se vacía con el ventilador ON

**Contexto:** El aula se vacía mientras se enfría. Apagar por vacío también respeta los 60 s mínimos desde el encendido. Es la misma histéresis del escenario 6, pero disparada por la ocupación (lectura del MQ-135) y no por la temperatura.

**Antes de empezar:** Detén la simulación. Deja los potenciómetros del MQ-135 y del MQ-7 en 0 y el DHT22 con `{ "temperature": "26", "humidity": "55" }`. Inicia la simulación.

**Límite de tiempo:** El paso 2 debe hacerse antes de que pasen 60 s desde el encendido del ventilador.

| Paso | Espera a ver | Haz | Debe aparecer |
|---|---|---|---|
| Al iniciar | El primer bloque | Nada | DISABLED y aula vacía |
| 1 | El primer bloque | Sube el potenciómetro del MQ-135 hasta que el log muestre ADC 2800 | Evento DISABLED -> COOLING |
| 2 | Un bloque con COOLING - Enfriando | **De inmediato**, baja el MQ-135 a 0 (ADC 0) | Motivo "Histeresis: DISABLED retenido, faltan N s ..." con N menor que 60 |
| 3 | El bloque con "faltan N s" | **No toques nada.** Espera ~1 minuto | N baja de 2 en 2 y el estado sigue COOLING - Enfriando |
| 4 | N llegando a 2 | Sigue sin tocar nada | Evento COOLING -> DISABLED, ventilador OFF y LED apagado |

**Activaciones de actuadores**

| Paso | Se activa | Por qué |
|---|---|---|
| Al iniciar | **LED verde**, durante los primeros ~2 s | El sistema arranca en estado STANDBY (en espera), y STANDBY se muestra con LED verde. Todavía no hay ninguna lectura de sensores que cambie ese estado. En cuanto sale el primer bloque, la lectura del MQ-135 es 0 (de 4095), menor que el umbral de ocupación de 2200, así que el aula cuenta como vacía, el estado pasa a DISABLED y el LED se apaga. |
| 1 | **Ventilador 100 %, LED azul** | La lectura del MQ-135 (ADC) es 2800, mayor que el umbral de ocupación de 2200: el aula está ocupada. La temperatura del DHT22 es 26.0 °C, que es 24.5 °C o más: hace falta enfriar. El estado es COOLING. |
| 2 y 3 | Siguen activos: ventilador 100 %, LED azul | La lectura del MQ-135 bajó a 0, menor que el umbral de ocupación de 2200, así que el aula cuenta como vacía y correspondería pasar a DISABLED, es decir apagar el ventilador. Pero el ventilador lleva menos de 60 s encendido, así que el sistema retiene COOLING hasta cumplir el intervalo mínimo. |

En el paso 4 pasaron los 60 s, el cambio ya está permitido, y el ventilador y el LED azul se apagan porque el aula ya no está ocupada y no hace falta enfriar.

**Log esperado**

Al iniciar:
```
[     2.3 s] EVT  Transicion de estado: STANDBY -> DISABLED
+-- CICLO 1   | t =    2.3 s ------------------------------
| SENSORES
|   DHT22      T = 26.0 C    CALIDO (T >= 24.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC    0/4095   AULA VACIA (ADC < 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     DISABLED - Desactivado
|   Motivo     Aula vacia (MQ-135 < 2200)
| ACTUADORES
|   Ventilador OFF [----------]   0 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    OFF sin color (aula vacia)
+------------------------------------------------
```

Tras el paso 1:
```
[     4.3 s] EVT  Transicion de estado: DISABLED -> COOLING
+-- CICLO 2   | t =    4.3 s ------------------------------
| SENSORES
|   DHT22      T = 26.0 C    CALIDO (T >= 24.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC 2800/4095   AULA OCUPADA (ADC >= 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     COOLING - Enfriando
|   Motivo     Aula ocupada y T >= 24.5 C: ventilador ON
| ACTUADORES
|   Ventilador ON  [##########] 100 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    ON  AZUL (enfriando)
+------------------------------------------------
```

Tras el paso 2:
```
+-- CICLO 3   | t =    6.3 s ------------------------------
| SENSORES
|   DHT22      T = 26.0 C    CALIDO (T >= 24.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC    0/4095   AULA VACIA (ADC < 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     COOLING - Enfriando
|   Motivo     Histeresis: DISABLED retenido, faltan 58 s del intervalo minimo de 60 s
| ACTUADORES
|   Ventilador ON  [##########] 100 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    ON  AZUL (enfriando)
+------------------------------------------------
```

Durante el paso 3, a mitad de la espera y en el último bloque antes del cambio:
```
+-- CICLO 16  | t =   32.3 s ------------------------------
| SENSORES
|   DHT22      T = 26.0 C    CALIDO (T >= 24.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC    0/4095   AULA VACIA (ADC < 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     COOLING - Enfriando
|   Motivo     Histeresis: DISABLED retenido, faltan 32 s del intervalo minimo de 60 s
| ACTUADORES
|   Ventilador ON  [##########] 100 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    ON  AZUL (enfriando)
+------------------------------------------------
+-- CICLO 31  | t =   62.3 s ------------------------------
| SENSORES
|   DHT22      T = 26.0 C    CALIDO (T >= 24.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC    0/4095   AULA VACIA (ADC < 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     COOLING - Enfriando
|   Motivo     Histeresis: DISABLED retenido, faltan 2 s del intervalo minimo de 60 s
| ACTUADORES
|   Ventilador ON  [##########] 100 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    ON  AZUL (enfriando)
+------------------------------------------------
```

Tras el paso 4:
```
[    64.3 s] EVT  Transicion de estado: COOLING -> DISABLED
+-- CICLO 32  | t =   64.3 s ------------------------------
| SENSORES
|   DHT22      T = 26.0 C    CALIDO (T >= 24.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC    0/4095   AULA VACIA (ADC < 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     DISABLED - Desactivado
|   Motivo     Aula vacia (MQ-135 < 2200)
| ACTUADORES
|   Ventilador OFF [----------]   0 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    OFF sin color (aula vacia)
+------------------------------------------------
```

---

## Escenario 8: Alarma de CO y su fin

**Contexto:** La alarma de CO (lectura del MQ-7 de 50 ppm o más) tiene prioridad sobre todo, incluso sobre un enfriamiento en curso. Fuerza el ventilador al 100 % y el buzzer, y suspende el control de clima. Al terminar, se reanuda el control normal y el estado COOLING sigue como estaba.

**Antes de empezar:** Detén la simulación. Deja los potenciómetros del MQ-135 y del MQ-7 en 0 y el DHT22 con `{ "temperature": "26", "humidity": "55" }`. Inicia la simulación.

| Paso | Espera a ver | Haz | Debe aparecer |
|---|---|---|---|
| Al iniciar | El primer bloque | Nada | DISABLED y aula vacía |
| 1 | El primer bloque | Sube el potenciómetro del MQ-135 hasta que el log muestre ADC 2800 | Evento DISABLED -> COOLING |
| 2 | Un bloque con COOLING - Enfriando | Sube el potenciómetro del MQ-7 hasta que el log muestre CO = 90 ppm | Evento "ALARMA DE CO ACTIVADA: 90 ppm >= 50 ppm...", ALARMA DE CO, Buzzer ON y LED rojo |
| 3 | El bloque con la alarma (déjala activa los bloques que quieras) | Baja el MQ-7 a 0 (CO = 0 ppm) | Evento "Alarma de CO desactivada...", vuelve a COOLING - Enfriando, Buzzer OFF y LED azul |

**Activaciones de actuadores**

| Paso | Se activa | Por qué |
|---|---|---|
| Al iniciar | **LED verde**, durante los primeros ~2 s | El sistema arranca en estado STANDBY (en espera), y STANDBY se muestra con LED verde. Todavía no hay ninguna lectura de sensores que cambie ese estado. En cuanto sale el primer bloque, la lectura del MQ-135 es 0 (de 4095), menor que el umbral de ocupación de 2200, así que el aula cuenta como vacía, el estado pasa a DISABLED y el LED se apaga. |
| 1 | **Ventilador 100 %, LED azul** | La lectura del MQ-135 (ADC) es 2800, mayor que el umbral de ocupación de 2200: el aula está ocupada. La temperatura del DHT22 es 26.0 °C, que es 24.5 °C o más: hace falta enfriar. El estado es COOLING. |
| 2 | **Buzzer ON, LED rojo**; el ventilador sigue al 100 % | La lectura del MQ-7 subió a 90 ppm de CO, que supera el umbral de alarma de 50 ppm, así que se activa la alarma de CO, que pasa por encima de la heurística de clima. El buzzer avisa y el LED rojo reemplaza al azul para indicar la causa. El ventilador ya estaba al 100 % por el enfriamiento, y ahora lo mantiene la alarma para renovar el aire. |
| 3 | **LED azul** vuelve a encenderse; el buzzer se apaga | La lectura del MQ-7 bajó a 0 ppm, menor que 50 ppm, así que la alarma termina. Se reanuda la heurística, que sigue viendo aula ocupada (lectura del MQ-135 de 2800, de 2200 o más) y temperatura de 26.0 °C (24.5 °C o más), así que el estado vuelve a COOLING. El ventilador nunca se apagó durante todo el escenario. |

**Log esperado**

Al iniciar:
```
[     2.3 s] EVT  Transicion de estado: STANDBY -> DISABLED
+-- CICLO 1   | t =    2.3 s ------------------------------
| SENSORES
|   DHT22      T = 26.0 C    CALIDO (T >= 24.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC    0/4095   AULA VACIA (ADC < 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     DISABLED - Desactivado
|   Motivo     Aula vacia (MQ-135 < 2200)
| ACTUADORES
|   Ventilador OFF [----------]   0 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    OFF sin color (aula vacia)
+------------------------------------------------
```

Tras el paso 1:
```
[     4.3 s] EVT  Transicion de estado: DISABLED -> COOLING
+-- CICLO 2   | t =    4.3 s ------------------------------
| SENSORES
|   DHT22      T = 26.0 C    CALIDO (T >= 24.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC 2800/4095   AULA OCUPADA (ADC >= 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     COOLING - Enfriando
|   Motivo     Aula ocupada y T >= 24.5 C: ventilador ON
| ACTUADORES
|   Ventilador ON  [##########] 100 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    ON  AZUL (enfriando)
+------------------------------------------------
```

Tras el paso 2:
```
[     6.3 s] EVT  ALARMA DE CO ACTIVADA: 90 ppm >= 50 ppm. Ventilador forzado al 100%, calefactor OFF y buzzer ON
+-- CICLO 3   | t =    6.3 s ------------------------------
| SENSORES
|   DHT22      T = 26.0 C    CALIDO (T >= 24.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC 2800/4095   AULA OCUPADA (ADC >= 2200)
|   MQ-7       CO = 90 ppm   ALARMA (CO >= 50 ppm)
| DECISION
|   Estado     ALARMA DE CO - Control de clima suspendido
|   Motivo     CO >= 50 ppm: ventilador al 100 %, calefactor OFF y buzzer ON
| ACTUADORES
|   Ventilador ON  [##########] 100 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     ON
|   LED RGB    ON  ROJO (Alarma CO)
+------------------------------------------------
```

Tras el paso 3:
```
[     8.3 s] EVT  Alarma de CO desactivada: 0 ppm < 50 ppm. Se reanuda el control por heuristica
+-- CICLO 4   | t =    8.3 s ------------------------------
| SENSORES
|   DHT22      T = 26.0 C    CALIDO (T >= 24.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC 2800/4095   AULA OCUPADA (ADC >= 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     COOLING - Enfriando
|   Motivo     Aula ocupada y T >= 24.5 C: ventilador ON
| ACTUADORES
|   Ventilador ON  [##########] 100 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    ON  AZUL (enfriando)
+------------------------------------------------
```

---

## Escenario 9: DHT22 sin lectura

**Contexto:** Si el sensor de temperatura falla, el sistema mantiene el último estado y no decide con datos inválidos. Como el estado inicial es STANDBY, se queda en STANDBY aunque el aula esté vacía o llena. La alarma de CO (lectura del MQ-7 de 50 ppm o más) sigue funcionando sin DHT22. Sin lectura no hay etiquetas de temperatura ni de humedad.

**Antes de empezar:** Detén la simulación. Deja los potenciómetros del MQ-135 y del MQ-7 en 0. Desconecta el cable SDA del DHT22, el que va al pin D4, de modo que el DHT22 no entregue lectura. Inicia la simulación. En este escenario no aplica el `{ "temperature": "26", "humidity": "55" }`, porque el sensor está desconectado.

| Paso | Espera a ver | Haz | Debe aparecer |
|---|---|---|---|
| Al iniciar | El primer bloque | Nada | DHT22 "sin lectura", STANDBY, "Sin lectura del DHT22: se mantiene el ultimo estado" y LED verde. No hay evento STANDBY -> DISABLED |
| 1 | El primer bloque | Sube el potenciómetro del MQ-135 hasta que el log muestre ADC 2800 | Sigue "sin lectura" y STANDBY |
| 2 | Un bloque con ADC 2800 | Sube el potenciómetro del MQ-7 hasta que el log muestre CO = 90 ppm | Evento de alarma y ALARMA DE CO, Buzzer ON y LED rojo |
| 3 | El bloque con la alarma | Baja el MQ-7 a 0 (CO = 0 ppm) | Evento de fin de alarma y vuelve a STANDBY |

**Activaciones de actuadores**

| Paso | Se activa | Por qué |
|---|---|---|
| Al iniciar y paso 1 | **LED verde**, y se mantiene encendido | El sistema arranca en estado STANDBY (en espera), y STANDBY se muestra con LED verde. Sin lectura de temperatura del DHT22 la heurística no puede decidir, así que conserva el último estado, que es el inicial: STANDBY. Por eso el LED sigue verde aunque la lectura del MQ-135 sea 0 (al iniciar, menor que el umbral de ocupación de 2200, aula vacía) o 2800 (paso 1, mayor que 2200, aula ocupada): ni pasa a DISABLED ni a COOLING. |
| 2 | **Ventilador 100 %, buzzer ON, LED rojo** | La lectura del MQ-7 subió a 90 ppm de CO, que supera el umbral de alarma de 50 ppm, así que se activa la alarma de CO. La alarma se evalúa antes que cualquier otra cosa y no depende del DHT22, así que funciona aunque ese sensor falle. |
| 3 | **LED verde** vuelve a encenderse | La lectura del MQ-7 bajó a 0 ppm, menor que 50 ppm, así que la alarma termina y la heurística retoma el control. Sigue sin lectura de temperatura, así que vuelve a conservar el último estado: STANDBY. El ventilador y el buzzer se apagan. |

**Log esperado**

Al iniciar:
```
+-- CICLO 1   | t =    2.3 s ------------------------------
| SENSORES
|   DHT22      sin lectura
|   MQ-135     ADC    0/4095   AULA VACIA (ADC < 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     STANDBY - En espera
|   Motivo     Sin lectura del DHT22: se mantiene el ultimo estado
| ACTUADORES
|   Ventilador OFF [----------]   0 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    ON  VERDE (en espera)
+------------------------------------------------
```

Tras el paso 1:
```
+-- CICLO 2   | t =    4.3 s ------------------------------
| SENSORES
|   DHT22      sin lectura
|   MQ-135     ADC 2800/4095   AULA OCUPADA (ADC >= 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     STANDBY - En espera
|   Motivo     Sin lectura del DHT22: se mantiene el ultimo estado
| ACTUADORES
|   Ventilador OFF [----------]   0 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    ON  VERDE (en espera)
+------------------------------------------------
```

Tras el paso 2:
```
[     6.3 s] EVT  ALARMA DE CO ACTIVADA: 90 ppm >= 50 ppm. Ventilador forzado al 100%, calefactor OFF y buzzer ON
+-- CICLO 3   | t =    6.3 s ------------------------------
| SENSORES
|   DHT22      sin lectura
|   MQ-135     ADC 2800/4095   AULA OCUPADA (ADC >= 2200)
|   MQ-7       CO = 90 ppm   ALARMA (CO >= 50 ppm)
| DECISION
|   Estado     ALARMA DE CO - Control de clima suspendido
|   Motivo     CO >= 50 ppm: ventilador al 100 %, calefactor OFF y buzzer ON
| ACTUADORES
|   Ventilador ON  [##########] 100 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     ON
|   LED RGB    ON  ROJO (Alarma CO)
+------------------------------------------------
```

Tras el paso 3:
```
[     8.3 s] EVT  Alarma de CO desactivada: 0 ppm < 50 ppm. Se reanuda el control por heuristica
+-- CICLO 4   | t =    8.3 s ------------------------------
| SENSORES
|   DHT22      sin lectura
|   MQ-135     ADC 2800/4095   AULA OCUPADA (ADC >= 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     STANDBY - En espera
|   Motivo     Sin lectura del DHT22: se mantiene el ultimo estado
| ACTUADORES
|   Ventilador OFF [----------]   0 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    ON  VERDE (en espera)
+------------------------------------------------
```

Al terminar, reconecta el cable SDA.

---

## Escenario 10: Frecuencia del bloque (`LOG_CADA_N_CICLOS = 5`)

**Contexto:** Con N = 5 solo se imprime un bloque cada 5 ciclos (cada 10 s). Los eventos EVT siguen saliendo en cuanto ocurren. Una alarma corta que empieza y termina entre dos bloques solo se ve por sus dos EVT.

**Antes de empezar:** En el sketch cambia `LOG_CADA_N_CICLOS = 1` a `5`. Detén la simulación. Deja los potenciómetros del MQ-135 y del MQ-7 en 0 y el DHT22 con `{ "temperature": "26", "humidity": "55" }`. Inicia la simulación.

**Límite de tiempo:** La alarma debe empezar y terminar entre dos bloques, que salen cada 10 s.

| Paso | Espera a ver | Haz | Debe aparecer |
|---|---|---|---|
| Al iniciar | Las líneas SIS y RED y la línea `EVT ... STANDBY -> DISABLED` (~2 s) | Nada | No sale ningún bloque todavía |
| 1 | Esa línea `EVT ... STANDBY -> DISABLED` | Sube el potenciómetro del MQ-135 a una lectura de 2800 (el log no la muestra todavía, súbelo claramente por encima de 2200) | Línea `EVT ... DISABLED -> COOLING` (sin bloque) |
| 2 | El primer bloque que aparezca (será el de ciclo 5, a ~10 s) | Sube el potenciómetro del MQ-7 hasta que el siguiente bloque o evento muestre 90 ppm (con el log reducido, súbelo claramente por encima de 50 ppm) | Línea `EVT ... ALARMA DE CO ACTIVADA` |
| 3 | Esa línea de alarma | Baja el MQ-7 a 0 **de inmediato**, antes del siguiente bloque | Línea `EVT ... Alarma de CO desactivada` |
| 4 | El siguiente bloque (será el de ciclo 10, a ~20 s) | Nada | Bloque con CO = 0 ppm NORMAL y COOLING - Enfriando |

Si el siguiente bloque sale antes de que bajes el MQ-7, mostrará la alarma. Repite el escenario, porque la alarma debía caber entre los dos bloques.

**Activaciones de actuadores**

| Paso | Se activa | Por qué |
|---|---|---|
| Al iniciar | **LED verde**, durante los primeros ~2 s | El sistema arranca en estado STANDBY (en espera), y STANDBY se muestra con LED verde. Todavía no hay ninguna lectura de sensores que cambie ese estado. En cuanto la primera lectura muestra el MQ-135 en 0 (de 4095), menor que el umbral de ocupación de 2200, el aula cuenta como vacía, el estado pasa a DISABLED y el LED se apaga, aunque con N = 5 todavía no salga un bloque. |
| 1 | **Ventilador 100 %, LED azul** | La lectura del MQ-135 (ADC) está por encima del umbral de ocupación de 2200: el aula está ocupada. La temperatura del DHT22 es 26.0 °C, que es 24.5 °C o más: hace falta enfriar. El estado es COOLING, igual que en el escenario 4. |
| 2 | **Buzzer ON, LED rojo**; el ventilador sigue al 100 % | La lectura del MQ-7 supera el umbral de alarma de 50 ppm de CO, así que se activa la alarma, igual que en el escenario 8. |
| 3 | **LED azul** vuelve a encenderse; el buzzer se apaga | La lectura del MQ-7 bajó a 0 ppm, menor que 50 ppm, así que la alarma termina y la heurística vuelve a COOLING. |

En el circuito verás activarse el buzzer y el LED rojo durante la alarma, aunque el log no muestre ningún bloque de alarma. Los actuadores reaccionan en cada lectura, pero el log solo imprime un bloque cada 5 ciclos. Por eso la alarma aparece únicamente en sus dos líneas EVT.

**Log esperado**

Tras el banner y las líneas SIS y RED del escenario 1, en este orden:
```
[     2.3 s] EVT  Transicion de estado: STANDBY -> DISABLED
[     6.3 s] EVT  Transicion de estado: DISABLED -> COOLING
+-- CICLO 5   | t =   10.3 s ------------------------------
| SENSORES
|   DHT22      T = 26.0 C    CALIDO (T >= 24.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC 2800/4095   AULA OCUPADA (ADC >= 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     COOLING - Enfriando
|   Motivo     Aula ocupada y T >= 24.5 C: ventilador ON
| ACTUADORES
|   Ventilador ON  [##########] 100 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    ON  AZUL (enfriando)
+------------------------------------------------
[    12.3 s] EVT  ALARMA DE CO ACTIVADA: 90 ppm >= 50 ppm. Ventilador forzado al 100%, calefactor OFF y buzzer ON
[    16.3 s] EVT  Alarma de CO desactivada: 0 ppm < 50 ppm. Se reanuda el control por heuristica
+-- CICLO 10  | t =   20.3 s ------------------------------
| SENSORES
|   DHT22      T = 26.0 C    CALIDO (T >= 24.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC 2800/4095   AULA OCUPADA (ADC >= 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     COOLING - Enfriando
|   Motivo     Aula ocupada y T >= 24.5 C: ventilador ON
| ACTUADORES
|   Ventilador ON  [##########] 100 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    ON  AZUL (enfriando)
+------------------------------------------------
```

Al terminar, vuelve `LOG_CADA_N_CICLOS` a 1.

---

## Escenario 11: Log contra circuito

**Contexto:** Comprueba que cada fila de ACTUADORES coincide con lo que se ve en el circuito de Wokwi.

**Antes de empezar:** Detén la simulación. Deja los potenciómetros del MQ-135 y del MQ-7 en 0 y el DHT22 con `{ "temperature": "26", "humidity": "55" }`. Inicia la simulación.

| Paso | Espera a ver | Haz | Debe aparecer en el log | Debe verse en el circuito |
|---|---|---|---|---|
| Al iniciar | El primer bloque | Nada | DISABLED, LED RGB OFF | LED verde ~2 s y luego todo apagado |
| 1 | El primer bloque | Sube el potenciómetro del MQ-135 hasta que el log muestre ADC 2800 | Ventilador ON y LED RGB AZUL (enfriando) | LED amarillo y LED azul encendidos |
| 2 | Un bloque con COOLING - Enfriando | Pon la temperatura del DHT22 en 23.8 °C y espera ~1 minuto sin tocar nada | Evento COOLING -> STANDBY, ventilador OFF y LED RGB VERDE (en espera) | Solo el LED verde encendido |
| 3 | Un bloque con STANDBY | Sube el potenciómetro del MQ-7 hasta que el log muestre CO = 90 ppm | ALARMA DE CO, ventilador ON al 100 %, Buzzer ON y LED RGB ROJO (Alarma CO) | LED rojo, LED amarillo y buzzer activos |
| 4 | El bloque con la alarma | Baja el MQ-7 a 0 (CO = 0 ppm) | Vuelve a STANDBY, ventilador OFF, Buzzer OFF y LED RGB VERDE | Solo el LED verde encendido |
| 5 | Un bloque con STANDBY | Pon la temperatura del DHT22 en 22.0 °C | Evento STANDBY -> HEATING, Calefactor ON y LED RGB AMBAR (calentando) | LED naranja, LED rojo y LED verde encendidos |

**Activaciones de actuadores**

| Paso | Se activa | Por qué |
|---|---|---|
| Al iniciar | **LED verde**, durante los primeros ~2 s | El sistema arranca en estado STANDBY (en espera), y STANDBY se muestra con LED verde. Todavía no hay ninguna lectura de sensores que cambie ese estado. En cuanto sale el primer bloque, la lectura del MQ-135 es 0 (de 4095), menor que el umbral de ocupación de 2200, así que el aula cuenta como vacía, el estado pasa a DISABLED y el LED se apaga. |
| 1 | **LED amarillo y LED azul** | La lectura del MQ-135 (ADC) es 2800, mayor que el umbral de ocupación de 2200: el aula está ocupada. La temperatura del DHT22 es 26.0 °C, que es 24.5 °C o más: hace falta enfriar. El estado es COOLING: el ventilador (LED amarillo) enfría y el LED azul lo indica. |
| 2 | **LED verde** | La temperatura del DHT22 bajó a 23.8 °C, que es 24.0 °C o menos, y con el aula ocupada (lectura del MQ-135 de 2800, de 2200 o más) eso pide STANDBY. El cambio espera a que pasen 60 s desde el encendido del ventilador, y después el ventilador se apaga y se enciende el LED verde de "en espera". |
| 3 | **LED rojo, LED amarillo y buzzer** | La lectura del MQ-7 subió a 90 ppm de CO, que supera el umbral de alarma de 50 ppm, así que se activa la alarma de CO. El ventilador se fuerza al 100 % (el LED amarillo se enciende otra vez), el buzzer suena y el LED rojo marca la causa. |
| 4 | **LED verde** vuelve a encenderse | La lectura del MQ-7 bajó a 0 ppm, menor que 50 ppm, así que la alarma termina. La heurística vuelve a evaluar: aula ocupada y temperatura de 23.8 °C (entre 23.5 °C y 24.5 °C) dan STANDBY, con ventilador y buzzer apagados. |
| 5 | **LED naranja, LED rojo y LED verde** | La temperatura del DHT22 bajó a 22.0 °C, que es 23.5 °C o menos, y con el aula ocupada eso pide HEATING. El ventilador ya estaba apagado, así que el cambio es inmediato. El calefactor (LED naranja) se enciende, y el color ámbar del LED RGB se ve como el LED rojo y el LED verde encendidos a la vez. |

Esta es la correspondencia entre cada fila del log y el circuito:

| Fila del log | En el circuito debe verse |
|---|---|
| `Ventilador ON  [##########] 100 %` | LED amarillo (D25) encendido a máxima intensidad |
| `Ventilador OFF [----------] 0 %` | LED amarillo apagado |
| `Calefactor ON` | LED naranja (D32) encendido |
| `Calefactor OFF` | LED naranja apagado |
| `Buzzer ON` | Buzzer (D26) activo |
| `Buzzer OFF` | Buzzer en silencio |
| `LED RGB ON ROJO (Alarma CO)` | Solo el LED rojo (D27) encendido |
| `LED RGB ON AZUL (enfriando)` | Solo el LED azul (D13) encendido |
| `LED RGB ON VERDE (en espera)` | Solo el LED verde (D14) encendido |
| `LED RGB ON AMBAR (calentando)` | El LED rojo (D27) y el LED verde (D14) encendidos |
| `LED RGB OFF sin color (aula vacia)` | Los tres apagados |

Los bloques de los pasos 1 y 2 son los de los escenarios 4 y 6. El del paso 3 es el de alarma del escenario 8, el del paso 4 vuelve a STANDBY y el del paso 5 es el de calefacción del escenario 13. No generé el log exacto de esta combinación completa, pero cada fila debe coincidir con la tabla. El color cian (pre-enfriamiento) existe en el código, pero esta heurística nunca lo usa.
---

## Escenario 12: Fin de la alarma con el aula ya evacuada

**Contexto:** Es el caso esperable en una situación real: ante una alarma de CO las personas evacúan el aula, y luego el CO se disipa. Se comprueba qué hace el sistema al terminar la alarma si, mientras duraba, el aula se vació. Durante la alarma el estado de clima queda congelado en COOLING. Al terminar, la heurística ve el aula vacía y propondría DISABLED (ventilador apagado), pero el ventilador lo encendió el clima hace menos de 60 s, así que la regla de 60 s **retiene COOLING**. Resultado: el ventilador sigue al 100 % unos segundos después de terminar la alarma, porque el ventilador forzado por la alarma no reinició ese contador.

**Antes de empezar:** Detén la simulación. Deja los potenciómetros del MQ-135 y del MQ-7 en 0 y el DHT22 con `{ "temperature": "26", "humidity": "55" }`. Inicia la simulación.

**Límite de tiempo:** El paso 4 debe hacerse antes de que pasen 60 s desde el encendido del ventilador por el clima (paso 1). Si tardas más, el ventilador se apaga en el mismo bloque en que termina la alarma y no se ve la retención.

| Paso | Espera a ver | Haz | Debe aparecer |
|---|---|---|---|
| Al iniciar | El primer bloque | Nada | DISABLED y aula vacía |
| 1 | El primer bloque | Sube el potenciómetro del MQ-135 hasta que el log muestre ADC 2800 | Evento DISABLED -> COOLING, COOLING - Enfriando, ventilador 100 % y LED azul |
| 2 | Un bloque con COOLING - Enfriando | Sube el potenciómetro del MQ-7 hasta que el log muestre CO = 90 ppm | Evento "ALARMA DE CO ACTIVADA", ALARMA DE CO, Buzzer ON y LED rojo |
| 3 | El bloque con la alarma | Baja el MQ-135 a 0 (ADC 0, el aula queda desocupada) | AULA VACIA, pero sigue ALARMA DE CO, ventilador 100 %, Buzzer ON y LED rojo. **Sin evento de estado** |
| 4 | Un bloque con AULA VACIA y alarma | **De inmediato**, baja el MQ-7 a 0 (CO = 0 ppm, el CO se disipó) | Evento "Alarma de CO desactivada...", Motivo "Histeresis: DISABLED retenido, faltan N s ..." con N menor que 60, COOLING - Enfriando, ventilador 100 %, Buzzer OFF y LED azul |
| 5 | El bloque con "faltan N s" | **No toques nada.** Espera ~1 minuto | N baja de 2 en 2 y el estado sigue COOLING - Enfriando. Al final, evento COOLING -> DISABLED, ventilador OFF y LED apagado |

**Activaciones de actuadores**

| Paso | Se activa | Por qué |
|---|---|---|
| Al iniciar | **LED verde**, durante los primeros ~2 s | El sistema arranca en estado STANDBY (en espera), y STANDBY se muestra con LED verde. Todavía no hay ninguna lectura de sensores que cambie ese estado. En cuanto sale el primer bloque, la lectura del MQ-135 es 0 (de 4095), menor que el umbral de ocupación de 2200, así que el aula cuenta como vacía, el estado pasa a DISABLED y el LED se apaga. |
| 1 | **Ventilador 100 %, LED azul** | La lectura del MQ-135 (ADC) es 2800, mayor que el umbral de ocupación de 2200: el aula está ocupada. La temperatura del DHT22 es 26.0 °C, que es 24.5 °C o más (setpoint 24.0 °C más 0.5 °C de margen): hace falta enfriar. El estado es COOLING. |
| 2 | **Buzzer ON, LED rojo**; el ventilador sigue al 100 % | La lectura del MQ-7 subió a 90 ppm de CO, que supera el umbral de alarma de 50 ppm, así que se activa la alarma de CO. El buzzer avisa y el LED rojo reemplaza al azul. El ventilador ya estaba al 100 % por el clima y ahora lo mantiene la alarma. |
| 3 | Siguen activos: ventilador 100 %, buzzer ON, LED rojo | La lectura del MQ-135 bajó a 0, menor que el umbral de ocupación de 2200, así que el aula cuenta como vacía. Pero la alarma manda sobre el clima, que está suspendido: no se evalúa la ocupación y no hay cambio de estado. Mientras la lectura del MQ-7 siga en 90 ppm (50 ppm o más) todo sigue igual. |
| 4 | **LED azul** vuelve a encenderse; el buzzer se apaga; el ventilador **sigue al 100 %** | La lectura del MQ-7 bajó a 0 ppm, menor que 50 ppm, así que la alarma termina y el buzzer se apaga. El clima se reanuda y ve el aula vacía (lectura del MQ-135 en 0, menor que 2200), por lo que propone DISABLED, es decir apagar el ventilador. Pero el ventilador lo encendió el clima en el paso 1, hace menos de 60 s, y el contador de 60 s sigue contando desde ahí (el ventilador forzado por la alarma no lo reinició). Por eso el sistema retiene COOLING y el ventilador sigue al 100 % con el LED azul. En el paso 5, cuando se cumplen los 60 s, el cambio ya está permitido: el estado pasa a DISABLED y el ventilador y el LED se apagan, porque el aula ya no está ocupada y no hace falta enfriar. |

**Log esperado**

Al iniciar:
```
[     2.3 s] EVT  Transicion de estado: STANDBY -> DISABLED
+-- CICLO 1   | t =    2.3 s ------------------------------
| SENSORES
|   DHT22      T = 26.0 C    CALIDO (T >= 24.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC    0/4095   AULA VACIA (ADC < 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     DISABLED - Desactivado
|   Motivo     Aula vacia (MQ-135 < 2200)
| ACTUADORES
|   Ventilador OFF [----------]   0 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    OFF sin color (aula vacia)
+------------------------------------------------
```

Tras el paso 1:
```
[     4.3 s] EVT  Transicion de estado: DISABLED -> COOLING
+-- CICLO 2   | t =    4.3 s ------------------------------
| SENSORES
|   DHT22      T = 26.0 C    CALIDO (T >= 24.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC 2800/4095   AULA OCUPADA (ADC >= 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     COOLING - Enfriando
|   Motivo     Aula ocupada y T >= 24.5 C: ventilador ON
| ACTUADORES
|   Ventilador ON  [##########] 100 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    ON  AZUL (enfriando)
+------------------------------------------------
```

Tras el paso 2:
```
[     6.3 s] EVT  ALARMA DE CO ACTIVADA: 90 ppm >= 50 ppm. Ventilador forzado al 100%, calefactor OFF y buzzer ON
+-- CICLO 3   | t =    6.3 s ------------------------------
| SENSORES
|   DHT22      T = 26.0 C    CALIDO (T >= 24.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC 2800/4095   AULA OCUPADA (ADC >= 2200)
|   MQ-7       CO = 90 ppm   ALARMA (CO >= 50 ppm)
| DECISION
|   Estado     ALARMA DE CO - Control de clima suspendido
|   Motivo     CO >= 50 ppm: ventilador al 100 %, calefactor OFF y buzzer ON
| ACTUADORES
|   Ventilador ON  [##########] 100 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     ON
|   LED RGB    ON  ROJO (Alarma CO)
+------------------------------------------------
```

Tras el paso 3:
```
+-- CICLO 4   | t =    8.3 s ------------------------------
| SENSORES
|   DHT22      T = 26.0 C    CALIDO (T >= 24.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC    0/4095   AULA VACIA (ADC < 2200)
|   MQ-7       CO = 90 ppm   ALARMA (CO >= 50 ppm)
| DECISION
|   Estado     ALARMA DE CO - Control de clima suspendido
|   Motivo     CO >= 50 ppm: ventilador al 100 %, calefactor OFF y buzzer ON
| ACTUADORES
|   Ventilador ON  [##########] 100 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     ON
|   LED RGB    ON  ROJO (Alarma CO)
+------------------------------------------------
```

Tras el paso 4:
```
[    10.3 s] EVT  Alarma de CO desactivada: 0 ppm < 50 ppm. Se reanuda el control por heuristica
+-- CICLO 5   | t =   10.3 s ------------------------------
| SENSORES
|   DHT22      T = 26.0 C    CALIDO (T >= 24.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC    0/4095   AULA VACIA (ADC < 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     COOLING - Enfriando
|   Motivo     Histeresis: DISABLED retenido, faltan 54 s del intervalo minimo de 60 s
| ACTUADORES
|   Ventilador ON  [##########] 100 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    ON  AZUL (enfriando)
+------------------------------------------------
```

Durante el paso 5, en el último bloque antes del cambio:
```
+-- CICLO 31  | t =   62.3 s ------------------------------
| SENSORES
|   DHT22      T = 26.0 C    CALIDO (T >= 24.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC    0/4095   AULA VACIA (ADC < 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     COOLING - Enfriando
|   Motivo     Histeresis: DISABLED retenido, faltan 2 s del intervalo minimo de 60 s
| ACTUADORES
|   Ventilador ON  [##########] 100 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    ON  AZUL (enfriando)
+------------------------------------------------
```

Al final del paso 5:
```
[    64.3 s] EVT  Transicion de estado: COOLING -> DISABLED
+-- CICLO 32  | t =   64.3 s ------------------------------
| SENSORES
|   DHT22      T = 26.0 C    CALIDO (T >= 24.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC    0/4095   AULA VACIA (ADC < 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     DISABLED - Desactivado
|   Motivo     Aula vacia (MQ-135 < 2200)
| ACTUADORES
|   Ventilador OFF [----------]   0 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    OFF sin color (aula vacia)
+------------------------------------------------
```

---

## Escenario 13: Calefacción hasta el setpoint

**Contexto:** Caso normal de calefacción: el aula está ocupada (lectura del MQ-135 de 2200 o más) y la temperatura está en FRESCO (23.5 °C o menos). El calefactor se mantiene encendido mientras la temperatura sube dentro de la zona TEMPLADO y se apaga al llegar al setpoint de 24.0 °C. Al apagarse no enciende el ventilador, porque la temperatura no llega a 24.5 °C.

**Antes de empezar:** Detén la simulación. Deja los potenciómetros del MQ-135 y del MQ-7 en 0 y el DHT22 con `{ "temperature": "22", "humidity": "55" }`. Inicia la simulación.

| Paso | Espera a ver | Haz | Debe aparecer |
|---|---|---|---|
| Al iniciar | El primer bloque | Nada | T = 22.0 C FRESCO, DISABLED y aula vacía |
| 1 | El primer bloque | Sube el potenciómetro del MQ-135 hasta que el log muestre ADC 2800 | Evento DISABLED -> HEATING, HEATING - Calentando, Calefactor ON y LED RGB AMBAR (calentando) |
| 2 | Un bloque con HEATING - Calentando | Pon la temperatura del DHT22 en 23.8 °C | T = 23.8 C TEMPLADO, sigue HEATING - Calentando y Calefactor ON |
| 3 | Un bloque con T = 23.8 C | Pon la temperatura del DHT22 en 24.2 °C | Evento HEATING -> STANDBY, Calefactor OFF, Ventilador OFF y LED verde |

**Activaciones de actuadores**

| Paso | Se activa | Por qué |
|---|---|---|
| Al iniciar | **LED verde**, durante los primeros ~2 s | El sistema arranca en estado STANDBY (en espera), y STANDBY se muestra con LED verde. En cuanto sale el primer bloque, la lectura del MQ-135 es 0 (de 4095), menor que el umbral de ocupación de 2200, así que el aula cuenta como vacía, el estado pasa a DISABLED y el LED se apaga, aunque la temperatura de 22.0 °C esté en FRESCO. |
| 1 | **LED naranja, LED rojo y LED verde** | La lectura del MQ-135 (ADC) es 2800, mayor que el umbral de ocupación de 2200: el aula está ocupada. La temperatura del DHT22 es 22.0 °C, que es 23.5 °C o menos: hace falta calentar. El estado es HEATING: el calefactor (LED naranja) se enciende y el LED RGB muestra ámbar, que en el circuito se ve como el LED rojo y el LED verde encendidos a la vez. El ventilador sigue apagado. |
| 2 | Siguen activos: LED naranja, LED rojo y LED verde | La temperatura del DHT22 subió a 23.8 °C, que está entre 23.5 °C y 24.5 °C pero no llega al setpoint de 24.0 °C. El sistema conserva HEATING. |
| 3 | **LED verde** | La temperatura del DHT22 subió a 24.2 °C, que es 24.0 °C o más: se alcanzó el setpoint y el calefactor se apaga. El estado pasa a STANDBY. El ventilador no se enciende, porque la temperatura no llega a 24.5 °C. |

**Log esperado**

Al iniciar:
```
[     2.3 s] EVT  Transicion de estado: STANDBY -> DISABLED
+-- CICLO 1   | t =    2.3 s ------------------------------
| SENSORES
|   DHT22      T = 22.0 C    FRESCO (T <= 23.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC    0/4095   AULA VACIA (ADC < 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     DISABLED - Desactivado
|   Motivo     Aula vacia (MQ-135 < 2200)
| ACTUADORES
|   Ventilador OFF [----------]   0 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    OFF sin color (aula vacia)
+------------------------------------------------
```

Tras el paso 1:
```
[     4.3 s] EVT  Transicion de estado: DISABLED -> HEATING
+-- CICLO 2   | t =    4.3 s ------------------------------
| SENSORES
|   DHT22      T = 22.0 C    FRESCO (T <= 23.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC 2800/4095   AULA OCUPADA (ADC >= 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     HEATING - Calentando
|   Motivo     Aula ocupada y T <= 23.5 C: calefactor ON
| ACTUADORES
|   Ventilador OFF [----------]   0 %   (LED amarillo)
|   Calefactor ON                       (LED naranja)
|   Buzzer     OFF
|   LED RGB    ON  AMBAR (calentando)
+------------------------------------------------
```

Tras el paso 2:
```
+-- CICLO 3   | t =    6.3 s ------------------------------
| SENSORES
|   DHT22      T = 23.8 C    TEMPLADO (23.5 C < T < 24.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC 2800/4095   AULA OCUPADA (ADC >= 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     HEATING - Calentando
|   Motivo     23.5 C < T < 24.5 C: se mantiene el estado
| ACTUADORES
|   Ventilador OFF [----------]   0 %   (LED amarillo)
|   Calefactor ON                       (LED naranja)
|   Buzzer     OFF
|   LED RGB    ON  AMBAR (calentando)
+------------------------------------------------
```

Tras el paso 3:
```
[     8.3 s] EVT  Transicion de estado: HEATING -> STANDBY
+-- CICLO 4   | t =    8.3 s ------------------------------
| SENSORES
|   DHT22      T = 24.2 C    TEMPLADO (23.5 C < T < 24.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC 2800/4095   AULA OCUPADA (ADC >= 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     STANDBY - En espera
|   Motivo     T >= 24.0 C (setpoint alcanzado): calefactor OFF
| ACTUADORES
|   Ventilador OFF [----------]   0 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    ON  VERDE (en espera)
+------------------------------------------------
```

---

## Escenario 14: Alarma de CO durante la calefacción

**Contexto:** La alarma de CO (lectura del MQ-7 de 50 ppm o más) también tiene prioridad sobre la calefacción. Apaga el calefactor, fuerza el ventilador al 100 % y enciende el buzzer. Al terminar, se reanuda el control de clima y el estado HEATING sigue como estaba.

**Antes de empezar:** Detén la simulación. Deja los potenciómetros del MQ-135 y del MQ-7 en 0 y el DHT22 con `{ "temperature": "22", "humidity": "55" }`. Inicia la simulación.

| Paso | Espera a ver | Haz | Debe aparecer |
|---|---|---|---|
| Al iniciar | El primer bloque | Nada | T = 22.0 C FRESCO, DISABLED y aula vacía |
| 1 | El primer bloque | Sube el potenciómetro del MQ-135 hasta que el log muestre ADC 2800 | Evento DISABLED -> HEATING y Calefactor ON |
| 2 | Un bloque con HEATING - Calentando | Sube el potenciómetro del MQ-7 hasta que el log muestre CO = 90 ppm | Evento "ALARMA DE CO ACTIVADA: 90 ppm >= 50 ppm...", ALARMA DE CO, Ventilador ON 100 %, Calefactor OFF, Buzzer ON y LED rojo |
| 3 | El bloque con la alarma | Baja el MQ-7 a 0 (CO = 0 ppm) | Evento "Alarma de CO desactivada...", vuelve a HEATING - Calentando, Ventilador OFF, Calefactor ON, Buzzer OFF y LED RGB AMBAR |

**Activaciones de actuadores**

| Paso | Se activa | Por qué |
|---|---|---|
| Al iniciar | **LED verde**, durante los primeros ~2 s | El sistema arranca en estado STANDBY (en espera). En cuanto sale el primer bloque, la lectura del MQ-135 es 0 (de 4095), menor que el umbral de ocupación de 2200, así que el estado pasa a DISABLED y el LED se apaga. |
| 1 | **LED naranja, LED rojo y LED verde** | Aula ocupada (lectura del MQ-135 de 2800, de 2200 o más) y temperatura de 22.0 °C (23.5 °C o menos): el estado es HEATING, igual que en el escenario 13. |
| 2 | **LED amarillo, buzzer y LED rojo**; el LED naranja se apaga | La lectura del MQ-7 subió a 90 ppm de CO, que supera el umbral de alarma de 50 ppm, así que se activa la alarma de CO. El calefactor se apaga, el ventilador se fuerza al 100 % (LED amarillo) y el buzzer avisa. El LED RGB pasa de ámbar a rojo: el LED verde se apaga y el rojo sigue encendido. Ventilador y calefactor no coinciden en ningún momento. |
| 3 | **LED naranja, LED rojo y LED verde**; el ventilador y el buzzer se apagan | La lectura del MQ-7 bajó a 0 ppm, menor que 50 ppm, así que la alarma termina. Se reanuda la heurística, que sigue viendo aula ocupada y temperatura de 22.0 °C (23.5 °C o menos), así que el estado vuelve a HEATING. El ventilador se apaga sin esperar 60 s, porque lo había encendido la alarma y no el clima. |

**Log esperado**

Al iniciar y tras el paso 1, los mismos bloques del escenario 13.

Tras el paso 2:
```
[     6.3 s] EVT  ALARMA DE CO ACTIVADA: 90 ppm >= 50 ppm. Ventilador forzado al 100%, calefactor OFF y buzzer ON
+-- CICLO 3   | t =    6.3 s ------------------------------
| SENSORES
|   DHT22      T = 22.0 C    FRESCO (T <= 23.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC 2800/4095   AULA OCUPADA (ADC >= 2200)
|   MQ-7       CO = 90 ppm   ALARMA (CO >= 50 ppm)
| DECISION
|   Estado     ALARMA DE CO - Control de clima suspendido
|   Motivo     CO >= 50 ppm: ventilador al 100 %, calefactor OFF y buzzer ON
| ACTUADORES
|   Ventilador ON  [##########] 100 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     ON
|   LED RGB    ON  ROJO (Alarma CO)
+------------------------------------------------
```

Tras el paso 3:
```
[     8.3 s] EVT  Alarma de CO desactivada: 0 ppm < 50 ppm. Se reanuda el control por heuristica
+-- CICLO 4   | t =    8.3 s ------------------------------
| SENSORES
|   DHT22      T = 22.0 C    FRESCO (T <= 23.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC 2800/4095   AULA OCUPADA (ADC >= 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     HEATING - Calentando
|   Motivo     Aula ocupada y T <= 23.5 C: calefactor ON
| ACTUADORES
|   Ventilador OFF [----------]   0 %   (LED amarillo)
|   Calefactor ON                       (LED naranja)
|   Buzzer     OFF
|   LED RGB    ON  AMBAR (calentando)
+------------------------------------------------
```

---

## Escenario 15: Paso de enfriar a calentar con el ventilador retenido

**Contexto:** El aula está ocupada y se enfría, y la temperatura cae de golpe a 22.0 °C (FRESCO, 23.5 °C o menos), lo que pide calentar. Pero el ventilador se encendió hace menos de 60 s, así que el sistema retiene COOLING. Mientras dura la retención el calefactor sigue apagado. Al cumplirse los 60 s, en el mismo bloque se apaga el ventilador y se enciende el calefactor, sin que coincidan.

**Antes de empezar:** Detén la simulación. Deja los potenciómetros del MQ-135 y del MQ-7 en 0 y el DHT22 con `{ "temperature": "26", "humidity": "55" }`. Inicia la simulación.

**Límite de tiempo:** El paso 2 debe hacerse antes de que pasen 60 s desde el encendido del ventilador. Si tardas más, el cambio a HEATING ocurre sin retención y el escenario no se ve.

| Paso | Espera a ver | Haz | Debe aparecer |
|---|---|---|---|
| Al iniciar | El primer bloque | Nada | DISABLED y aula vacía |
| 1 | El primer bloque | Sube el potenciómetro del MQ-135 hasta que el log muestre ADC 2800 | Evento DISABLED -> COOLING |
| 2 | Un bloque con COOLING - Enfriando | **De inmediato**, pon la temperatura del DHT22 en 22.0 °C | Motivo "Histeresis: HEATING retenido, faltan N s ..." con N menor que 60, Ventilador ON y Calefactor OFF |
| 3 | El bloque con "faltan N s" | **No toques nada.** Espera ~1 minuto | N baja de 2 en 2, sigue COOLING - Enfriando y Calefactor OFF. Al final, evento COOLING -> HEATING, Ventilador OFF, Calefactor ON y LED RGB AMBAR |

**Activaciones de actuadores**

| Paso | Se activa | Por qué |
|---|---|---|
| Al iniciar | **LED verde**, durante los primeros ~2 s | El sistema arranca en estado STANDBY (en espera). En cuanto sale el primer bloque, la lectura del MQ-135 es 0 (de 4095), menor que el umbral de ocupación de 2200, así que el estado pasa a DISABLED y el LED se apaga. |
| 1 | **LED amarillo y LED azul** | Aula ocupada (lectura del MQ-135 de 2800, de 2200 o más) y temperatura de 26.0 °C (24.5 °C o más): el estado es COOLING. |
| 2 | Siguen activos: LED amarillo y LED azul; el LED naranja sigue apagado | La temperatura del DHT22 bajó a 22.0 °C, que es 23.5 °C o menos, y eso pide HEATING, es decir apagar el ventilador y encender el calefactor. Pero el ventilador lleva menos de 60 s encendido, así que el sistema retiene COOLING. Como el calefactor solo se enciende en HEATING, sigue apagado y no coincide con el ventilador. |
| 3 | **LED naranja, LED rojo y LED verde**; el LED amarillo y el LED azul se apagan | Pasaron los 60 s desde que se encendió el ventilador, así que el cambio ya está permitido. El estado pasa a HEATING: el ventilador se apaga y el calefactor se enciende en el mismo bloque. |

**Log esperado**

Al iniciar y tras el paso 1, los mismos bloques del escenario 4.

Tras el paso 2:
```
+-- CICLO 3   | t =    6.3 s ------------------------------
| SENSORES
|   DHT22      T = 22.0 C    FRESCO (T <= 23.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC 2800/4095   AULA OCUPADA (ADC >= 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     COOLING - Enfriando
|   Motivo     Histeresis: HEATING retenido, faltan 58 s del intervalo minimo de 60 s
| ACTUADORES
|   Ventilador ON  [##########] 100 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    ON  AZUL (enfriando)
+------------------------------------------------
```

Durante el paso 3, a mitad de la espera y en el último bloque antes del cambio:
```
+-- CICLO 16  | t =   32.3 s ------------------------------
| SENSORES
|   DHT22      T = 22.0 C    FRESCO (T <= 23.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC 2800/4095   AULA OCUPADA (ADC >= 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     COOLING - Enfriando
|   Motivo     Histeresis: HEATING retenido, faltan 32 s del intervalo minimo de 60 s
| ACTUADORES
|   Ventilador ON  [##########] 100 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    ON  AZUL (enfriando)
+------------------------------------------------
+-- CICLO 31  | t =   62.3 s ------------------------------
| SENSORES
|   DHT22      T = 22.0 C    FRESCO (T <= 23.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC 2800/4095   AULA OCUPADA (ADC >= 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     COOLING - Enfriando
|   Motivo     Histeresis: HEATING retenido, faltan 2 s del intervalo minimo de 60 s
| ACTUADORES
|   Ventilador ON  [##########] 100 %   (LED amarillo)
|   Calefactor OFF                      (LED naranja)
|   Buzzer     OFF
|   LED RGB    ON  AZUL (enfriando)
+------------------------------------------------
```

Al final del paso 3:
```
[    64.3 s] EVT  Transicion de estado: COOLING -> HEATING
+-- CICLO 32  | t =   64.3 s ------------------------------
| SENSORES
|   DHT22      T = 22.0 C    FRESCO (T <= 23.5 C)
|              HR = 55 %     MODERADO (40 % < HR < 60 %)
|   MQ-135     ADC 2800/4095   AULA OCUPADA (ADC >= 2200)
|   MQ-7       CO = 0 ppm   NORMAL (CO < 50 ppm)
| DECISION
|   Estado     HEATING - Calentando
|   Motivo     Aula ocupada y T <= 23.5 C: calefactor ON
| ACTUADORES
|   Ventilador OFF [----------]   0 %   (LED amarillo)
|   Calefactor ON                       (LED naranja)
|   Buzzer     OFF
|   LED RGB    ON  AMBAR (calentando)
+------------------------------------------------
```

---

# Hallazgos y pendientes

Estos puntos salieron al redactar y probar los escenarios. **No se cambió el sketch por ninguno**: son decisiones de diseño por tomar.

## Hallazgos sobre la alarma de CO

| # | Hallazgo | Dónde se ve | Consecuencia |
|---|---|---|---|
| 1 | La alarma **no tiene histéresis**: se activa con 50 ppm o más y se apaga con menos de 50 ppm | Sin escenario: se deduce del código | Con una lectura oscilando alrededor de 50 ppm (ventilación marginal o ruido del sensor), el buzzer, el ventilador y el LED cambiarían en cada lectura |
| 2 | La alarma **no tiene tiempo máximo ni escalamiento** | Sin escenario: se deduce del código | Si el CO no baja, todo sigue igual indefinidamente: el sistema no avisa de que "el ventilador no está funcionando" ni toma otra medida |
| 3 | El sistema **no verifica el ventilador** ni que el CO baje por su causa | Sin escenario: se deduce del código | Solo lee la lectura del MQ-7. Un ventilador atascado o desconectado no se detecta |
| 4 | El ventilador forzado por la alarma **no reinicia el contador de 60 s** del clima | Escenario 12 | Tras una alarma con el aula evacuada, el ventilador puede seguir al 100 % unos segundos más |
| 5 | La alarma se desactiva **sin esperar** los 60 s | Escenario 3, paso 2 | Es lo esperable para una alarma de seguridad, pero conviene decidirlo a propósito |

## Pendientes de definición

- **Tipo de ventilador:** ¿extrae aire hacia el exterior o solo recircula? De eso depende que la regla "CO alto, ventilador al 100 %" sirva de verdad (ver la sección 3).
- **Setpoint de 24.0 °C:** viene del sketch y no tiene justificación en los documentos del proyecto. Puede cambiar. De él dependen los umbrales del ventilador (encendido con 24.5 °C o más, apagado con 24.0 °C o menos) y del calefactor (encendido con 23.5 °C o menos, apagado con 24.0 °C o más).
- **Umbrales de humedad (40 % y 60 %):** son provisionales y solo informativos. No tienen fuente.
- **Umbral de CO de 50 ppm:** su origen no está documentado.
- **Mapeo del MQ-7:** `ppm = ADC × 150 / 4095` es una simplificación para la simulación. En hardware real hay que usar la curva de calibración del sensor.
- **MQ-135 y calidad de aire:** hoy solo indica ocupación. Si se quiere ventilar por CO₂, falta definir la conversión de la lectura a ppm y un umbral propio.
- **Sensores reales en simulación:** Wokwi no tiene MQ-135 ni MQ-7, por eso se usan potenciómetros.
