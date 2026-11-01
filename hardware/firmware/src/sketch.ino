/*
 * ============================================================================
 *  Calienfriito - firmware de simulacion (Wokwi)
 *  Nodo de control termico - Aula A403
 *  CS5055 Internet of Things - UTEC 2026-2
 * ============================================================================
 *
 *  Funciones:
 *   1) Lectura de DHT22 (temperatura/humedad), MQ-135 (proxy de CO2 y de
 *      ocupacion) y MQ-7 (proxy de CO en ppm).
 *   2) Heuristica de control con setpoint de 24.0 C:
 *      ventilador ON con T >= 24.5 C y OFF con T <= 24.0 C;
 *      calefactor ON con T <= 23.5 C y OFF con T >= 24.0 C.
 *      Ventilador y calefactor nunca estan encendidos a la vez. Intervalo
 *      minimo de 60 s entre cambios de cualquier actuador (ventilador o
 *      calefactor), en ambos sentidos. Estados:
 *      COOLING, HEATING, PRE_COOLING, STANDBY, DISABLED.
 *   3) Alarma de CO evaluada localmente, antes que cualquier otra logica e
 *      independiente de la red. Apaga el calefactor.
 *   4) Telemetria por MQTT (incluye el motivo de cada decision), con Last Will
 *      ("offline") en el topico de estado y los umbrales retenidos en el de
 *      config. La consumen el backend (ccs/+/telemetry) y el monitor del nodo.
 *
 *  Formato del log serie:
 *     [  tiempo s] ETIQ  mensaje
 *   Etiquetas: SIS sistema | RED red | EVT eventos (transiciones, alarmas)
 *
 *   Cada lectura se muestra como un bloque, con la hora una sola vez y una
 *   fila por sensor y por actuador:
 *     +-- CICLO 8   | t =   16.5 s ------------------------------
 *     | SENSORES
 *     |   DHT22      T = 26.0 C    CALIDO (T >= 24.5 C)
 *     |              HR = 55 %     MODERADO (40 % < HR < 60 %)
 *     |   MQ-135     ADC 2800/4095   AULA OCUPADA (ADC >= 2200)
 *     |   MQ-7       CO = 91 ppm   ALARMA (CO >= 50 ppm)
 *     | DECISION
 *     |   Estado     ALARMA DE CO - Control de clima suspendido
 *     |   Motivo     CO >= 50 ppm: ventilador al 100 % y buzzer ON
 *     | ACTUADORES
 *     |   Ventilador ON  [##########] 100 %   (LED amarillo)
 *     |   Calefactor OFF                      (LED naranja)
 *     |   Buzzer     ON
 *     |   LED RGB    ON  ROJO (Alarma CO)
 *     +------------------------------------------------
 *   LOG_CADA_N_CICLOS permite imprimir el bloque cada N lecturas (por defecto
 *   2: se lee cada 1 s y el bloque sale cada 2 s).
 *
 *  Limites de la simulacion:
 *   - MQ-135 y MQ-7 se representan con potenciometros: permiten probar
 *     umbrales y logica, no la respuesta quimica real de los sensores.
 *   - El LED amarillo representa el PWM que en hardware va al MOSFET del
 *     ventilador de 12 V.
 *   - El LED naranja representa la salida digital que en hardware va al
 *     MOSFET del calefactor PTC de 12 V.
 *   - PRE_COOLING lo dispara el modelo de IA (requiere la ocupacion esperada
 *     segun la reserva); este firmware implementa solo la heuristica.
 *   - PubSubClient publica en QoS 0 (el subscribe usa QoS 1).
 *   - El hardware real tambien usa DHT22 (±0.5 C, resolucion 0.1 C): la banda
 *     de ±0.5 C de la histeresis no se puede resolver con un DHT11 (±2 C, 1 C).
 * ============================================================================
 */

#include <DHT.h>      // Adafruit "DHT sensor library" (verificada en Wokwi con el
                      // core ESP32 3.x; DHTesp da TIMEOUT con ese core)
#include <WiFi.h>
#include <PubSubClient.h>

// ---------------- Compatibilidad PWM entre cores de Arduino-ESP32 ------------
// Core >= 3.0: ledcAttach(pin, freq, res) + ledcWrite(pin, duty).
// Core <  3.0: ledcSetup(canal, freq, res) + ledcAttachPin(pin, canal)
//              + ledcWrite(canal, duty).
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  #define CCS_LEDC_API_NUEVA 1
#else
  #define CCS_LEDC_API_NUEVA 0
#endif
#define FAN_PWM_CHANNEL 0 // solo se usa con la API antigua

// ------------------------- INA219 (opcional) -------------------------------
// #include <Wire.h>
// #include <Adafruit_INA219.h>
// Adafruit_INA219 ina219;

// ---------------------------- Pines -----------------------------------------
#define DHTPIN       4    // D4
#define DHTTYPE      DHT22
#define MQ135_PIN    34   // D34 (ADC1_CH6)
#define MQ7_PIN      35   // D35 (ADC1_CH7)
#define FAN_PWM_PIN  25   // D25 -> MOSFET del ventilador (aqui: LED amarillo)
#define BUZZER_PIN   26   // D26
#define LED_R_PIN    27   // D27
#define LED_G_PIN    14   // D14
#define LED_B_PIN    13   // D13
#define HEATER_PIN   32   // D32 -> MOSFET del calefactor PTC (aqui: LED naranja)

// ------------------- Parametros de control (del informe) --------------------
const float SETPOINT_C                = 24.0;    // temperatura objetivo
const float HYSTERESIS_C              = 0.5;     // banda muerta +-0.5 C
// Umbrales derivados: ventilador ON con T >= 24.5 C, calefactor ON con
// T <= 23.5 C; ambos se apagan al volver al setpoint (24.0 C). Asi, al
// terminar de enfriar no se activa el calefactor, ni al reves.
const float T_VENTILADOR_ON_C         = SETPOINT_C + HYSTERESIS_C; // 24.5 C
const float T_CALEFACTOR_ON_C         = SETPOINT_C - HYSTERESIS_C; // 23.5 C
const float T_APAGADO_C               = SETPOINT_C;                // 24.0 C
const unsigned long MIN_ON_MS         = 60000UL; // intervalo minimo on/off
// Umbrales de humedad: PROVISIONALES y solo informativos (clasifican la lectura en
// el log; no intervienen en ninguna decision de control). Pendiente de definir su fuente.
const float HR_ALTA_PCT               = 60.0;    // HR >= 60 %  -> HUMEDO
const float HR_BAJA_PCT               = 40.0;    // HR <= 40 %  -> SECO
const int CO_ALARM_PPM                = 50;      // umbral de alarma de CO
const int OCCUPANCY_ADC_THRESHOLD     = 2200;    // MQ-135 (ADC 0-4095)
// Conversion SIMULADA del MQ-135 a ppm de CO2 (lineal, 0-4095 -> 400-2000 ppm) para
// el backend, que estima la ocupacion como (CO2 - 420) / 25 personas. En hardware
// real se reemplaza por la calibracion en dos puntos (aula vacia / aula llena).
const float CO2_PPM_MIN               = 400.0;
const float CO2_PPM_MAX               = 2000.0;
// La telemetria viaja marcada como simulada: el backend la separa de la real.
const bool  TELEMETRIA_SIMULADA       = true;
// Periodo de muestreo, control y telemetria MQTT (el dashboard recibe 1 dato/s).
// El DHT22 solo se lee cada 2 s (limite de la libreria Adafruit): entre medio
// devuelve la ultima lectura. MQ-135 y MQ-7 si se leen en cada ciclo.
const unsigned long PERIODO_LECTURA_MS = 1000;

// ------------------------------ Red / MQTT -----------------------------------
const char* WIFI_SSID = "Wokwi-GUEST";
const char* WIFI_PASS = "";
// Broker LOCAL: Mosquitto del docker-compose (o tools/broker-local sin Docker).
// "host.wokwi.internal" es como la simulacion de Wokwi llega al computador.
const char* MQTT_HOST = "host.wokwi.internal";
const int   MQTT_PORT = 1883;
// Topicos de PROYECTO_REDEFINIDO (seccion 6.3). El backend se suscribe a ccs/+/telemetry.
const char* TOPIC_TELEMETRY = "ccs/A403/telemetry";
const char* TOPIC_STATUS    = "ccs/A403/status";
const char* TOPIC_CMD       = "ccs/A403/command";
const char* TOPIC_CONFIG    = "ccs/A403/config"; // umbrales, retenido (lo lee el monitor del nodo)
const char* CLIENT_ID_BASE  = "calienfriito-A403-sim";
const unsigned long WIFI_TIMEOUT_MS = 10000UL;
// Reconexion MQTT cada 5 s fijos (MIN = MAX). Para volver a una espera creciente (RF-11)
// basta con subir MQTT_RETRY_MAX_MS; la logica de duplicar ya esta en intentarMQTT().
const unsigned long MQTT_RETRY_MIN_MS = 5000UL;
const unsigned long MQTT_RETRY_MAX_MS = 5000UL;
unsigned long mqttEsperaMs = MQTT_RETRY_MIN_MS;         // espera antes del proximo intento
unsigned long mqttProximaEsperaMs = MQTT_RETRY_MIN_MS;  // la que se aplicara si este falla
bool huboIntentoMqtt = false;                          // el primer intento no espera

DHT dht(DHTPIN, DHTTYPE);
WiFiClient espClient;
PubSubClient mqtt(espClient);
String clientId; // sufijo aleatorio: en un broker publico, dos nodos con el
                 // mismo ID se expulsan entre si

// ------------------------------ Estado ---------------------------------------
// Prefijo ACCION_ para evitar choques con macros del core (p. ej. DISABLED).
enum Accion { ACCION_COOLING, ACCION_HEATING, ACCION_PRE_COOLING, ACCION_STANDBY, ACCION_DISABLED };
Accion accionActual = ACCION_STANDBY;

unsigned long ultimoCambioMs = 0;
bool huboCambioActuador = false;   // el primer arranque no espera los 60 s
bool alarmaCO = false;
bool alarmaCOPrevia = false;
bool wifiOk = false;
bool mqttEstabaConectado = false;
unsigned long ultimoIntentoMqttMs = 0;
unsigned long ultimaLecturaMs = 0;

// Estado real de los actuadores, para reportarlo en el log
int dutyVentilador = 0;            // 0-255
bool calefactorEncendido = false;
const char* colorLed = "APAGADO";
bool ledRojoOn = false, ledVerdeOn = false, ledAzulOn = false;
bool buzzerEncendido = false;

// Justificacion de la ultima decision, para reportarla en el log
char motivoDecision[128] = "";

// Bloqueo por histeresis: segundos que faltan para aplicar el estado pendiente
// (0 = sin bloqueo). Se publica en la telemetria para el candado del dashboard.
unsigned long bloqueoSegundos = 0;
Accion accionPendiente = ACCION_STANDBY;

// ------------------------------- Log -----------------------------------------
// Toda linea termina en "\r\n" (como Serial.println). Con "\n" solo, la Wokwi
// Terminal de VS Code baja de linea sin volver a la columna 0 y el log sale en escalera.
void logInicio(const char* etiqueta) {
  Serial.printf("[%8.1f s] %-4s ", millis() / 1000.0, etiqueta);
}
#define LOG(etiqueta, ...) do { logInicio(etiqueta); Serial.printf(__VA_ARGS__); Serial.println(); } while (0)

// Fila de un dispositivo en el arranque: el nombre ocupa una columna fija de
// 11 caracteres para que todas las filas queden alineadas en el monitor.
#define LOGF(etiqueta, nombre, ...) do { logInicio(etiqueta); Serial.printf("%-11s| ", nombre); Serial.printf(__VA_ARGS__); Serial.println(); } while (0)

// ----------------------- Bloque de ciclo (sensores/decision/actuadores) -------
// 2 = un bloque cada 2 ciclos (cada 2 s): el monitor serie no duplica su volumen
// aunque la telemetria salga cada segundo. Los eventos EVT se imprimen siempre.
const unsigned long LOG_CADA_N_CICLOS = 2;
unsigned long numeroCiclo = 0;

// Barra de 10 posiciones: "[#####-----]". El buffer debe tener >= 13 bytes.
void barraNivel(int porcentaje, char* buf) {
  int llenos = (porcentaje * 10 + 50) / 100;
  buf[0] = '[';
  for (int i = 0; i < 10; i++) buf[1 + i] = (i < llenos) ? '#' : '-';
  buf[11] = ']';
  buf[12] = '\0';
}

void imprimirEncabezado() {
  Serial.println();
  Serial.println("==================================================================");
  Serial.println(" Calienfriito - Nodo de control termico, Aula A403");
  Serial.println(" CS5055 Internet of Things - UTEC 2026-2 (simulacion en Wokwi)");
  Serial.println("------------------------------------------------------------------");
  Serial.printf(" Setpoint: %.1f C | Intervalo minimo entre cambios de actuador: %lu s\r\n",
                SETPOINT_C, MIN_ON_MS / 1000);
  Serial.printf(" Ventilador: ON con T >= %.1f C, OFF con T <= %.1f C\r\n",
                T_VENTILADOR_ON_C, T_APAGADO_C);
  Serial.printf(" Calefactor: ON con T <= %.1f C, OFF con T >= %.1f C\r\n",
                T_CALEFACTOR_ON_C, T_APAGADO_C);
  Serial.printf(" Umbral de ocupacion (MQ-135): %d/4095 | Umbral de CO: %d ppm\r\n",
                OCCUPANCY_ADC_THRESHOLD, CO_ALARM_PPM);
  Serial.printf(" Periodo de muestreo y telemetria: %lu s | Bloque CICLO cada %lu s\r\n",
                PERIODO_LECTURA_MS / 1000, PERIODO_LECTURA_MS * LOG_CADA_N_CICLOS / 1000);
  Serial.println("------------------------------------------------------------------");
  Serial.println(" Etiquetas: SIS sistema | RED red | EVT eventos");
  Serial.println(" Cada lectura se muestra como un bloque CICLO (sensores, decision, actuadores)");
  Serial.println("==================================================================");
}

const char* nombreAccion(Accion a) {
  switch (a) {
    case ACCION_COOLING:     return "COOLING";
    case ACCION_HEATING:     return "HEATING";
    case ACCION_PRE_COOLING: return "PRE_COOLING";
    case ACCION_STANDBY:     return "STANDBY";
    case ACCION_DISABLED:    return "DISABLED";
  }
  return "STANDBY";
}

// Significado del estado, para que el log se entienda sin conocer el codigo.
const char* descripcionAccion(Accion a) {
  switch (a) {
    case ACCION_COOLING:     return "Enfriando";
    case ACCION_HEATING:     return "Calentando";
    case ACCION_PRE_COOLING: return "Pre-enfriamiento";
    case ACCION_STANDBY:     return "En espera";
    case ACCION_DISABLED:    return "Desactivado";
  }
  return "En espera";
}

// ---------------------------- Actuadores --------------------------------------
void escribirPWMVentilador(int duty) {
#if CCS_LEDC_API_NUEVA
  ledcWrite(FAN_PWM_PIN, duty);
#else
  ledcWrite(FAN_PWM_CHANNEL, duty);
#endif
  dutyVentilador = duty;
}

void escribirCalefactor(bool encendido) {
  digitalWrite(HEATER_PIN, encendido ? HIGH : LOW);
  calefactorEncendido = encendido;
}

void escribirBuzzer(bool encendido) {
  digitalWrite(BUZZER_PIN, encendido ? HIGH : LOW);
  buzzerEncendido = encendido;
}

void escribirLed(bool r, bool g, bool b, const char* descripcion) {
  digitalWrite(LED_R_PIN, r ? HIGH : LOW);
  digitalWrite(LED_G_PIN, g ? HIGH : LOW);
  digitalWrite(LED_B_PIN, b ? HIGH : LOW);
  ledRojoOn = r; ledVerdeOn = g; ledAzulOn = b;
  colorLed = descripcion;
}

// Verde = en espera, Azul = enfriando, Ambar = calentando,
// Cian = pre-enfriamiento, Apagado = aula vacia,
// Rojo = alarma de CO (prioridad maxima)
void setLedEstado(Accion a) {
  if (alarmaCO) { escribirLed(true, false, false, "ROJO (Alarma CO)"); return; }
  switch (a) {
    case ACCION_COOLING:     escribirLed(false, false, true,  "AZUL (enfriando)"); break;
    case ACCION_HEATING:     escribirLed(true,  true,  false, "AMBAR (calentando)"); break;
    case ACCION_PRE_COOLING: escribirLed(false, true,  true,  "CIAN (pre-enfriamiento)"); break;
    case ACCION_DISABLED:    escribirLed(false, false, false, "sin color (aula vacia)"); break;
    case ACCION_STANDBY:
    default:                 escribirLed(false, true,  false, "VERDE (en espera)"); break;
  }
}

int dutyDeAccion(Accion a) {
  switch (a) {
    case ACCION_COOLING:     return 255;
    case ACCION_PRE_COOLING: return 140;
    default:                 return 0;
  }
}

// El calefactor solo se enciende en HEATING, estado en el que el ventilador
// esta apagado: ambos actuadores nunca coinciden.
void aplicarAccion(Accion a) {
  escribirPWMVentilador(dutyDeAccion(a));
  escribirCalefactor(a == ACCION_HEATING);
  setLedEstado(a);
}

// --------------------- Heuristica con histeresis -----------------------------
// El ventilador gira en COOLING y PRE_COOLING; esta apagado en STANDBY y DISABLED.
bool ventiladorEncendido(Accion a) {
  return a == ACCION_COOLING || a == ACCION_PRE_COOLING;
}

// El calefactor solo esta encendido en HEATING.
bool calefactorActivo(Accion a) {
  return a == ACCION_HEATING;
}

Accion decidirHeuristica(float tempC, bool ocupado) {
  unsigned long ahora = millis();
  Accion propuesta;

  if (!ocupado) {
    propuesta = ACCION_DISABLED;
    snprintf(motivoDecision, sizeof(motivoDecision),
             "Aula vacia (MQ-135 < %d)", OCCUPANCY_ADC_THRESHOLD);
  } else if (tempC >= T_VENTILADOR_ON_C) {
    propuesta = ACCION_COOLING;
    snprintf(motivoDecision, sizeof(motivoDecision),
             "Aula ocupada y T >= %.1f C: ventilador ON", T_VENTILADOR_ON_C);
  } else if (tempC <= T_CALEFACTOR_ON_C) {
    propuesta = ACCION_HEATING;
    snprintf(motivoDecision, sizeof(motivoDecision),
             "Aula ocupada y T <= %.1f C: calefactor ON", T_CALEFACTOR_ON_C);
  } else if (accionActual == ACCION_COOLING && tempC <= T_APAGADO_C) {
    propuesta = ACCION_STANDBY;
    snprintf(motivoDecision, sizeof(motivoDecision),
             "T <= %.1f C (setpoint alcanzado): ventilador OFF", T_APAGADO_C);
  } else if (accionActual == ACCION_HEATING && tempC >= T_APAGADO_C) {
    propuesta = ACCION_STANDBY;
    snprintf(motivoDecision, sizeof(motivoDecision),
             "T >= %.1f C (setpoint alcanzado): calefactor OFF", T_APAGADO_C);
  } else if (accionActual == ACCION_DISABLED) {
    // El aula se acaba de ocupar con T entre ambos umbrales: no hace falta
    // enfriar ni calentar, pero el sistema debe salir de DISABLED.
    propuesta = ACCION_STANDBY;
    snprintf(motivoDecision, sizeof(motivoDecision),
             "Aula ocupada y %.1f C < T < %.1f C: sin enfriar ni calentar",
             T_CALEFACTOR_ON_C, T_VENTILADOR_ON_C);
  } else {
    propuesta = accionActual;
    snprintf(motivoDecision, sizeof(motivoDecision),
             "%.1f C < T < %.1f C: se mantiene el estado",
             T_CALEFACTOR_ON_C, T_VENTILADOR_ON_C);
  }

  // Intervalo minimo simetrico: se exige cada vez que el ventilador o el
  // calefactor se encienden o se apagan, y se cuenta desde el ultimo cambio de
  // cualquiera de los dos. Asi COOLING -> HEATING y HEATING -> COOLING esperan
  // lo mismo, y ningun actuador conmuta dos veces en menos de MIN_ON_MS.
  // Los cambios que no tocan actuadores (p. ej. STANDBY <-> DISABLED) no esperan.
  bool cambiaActuador =
      ventiladorEncendido(propuesta) != ventiladorEncendido(accionActual) ||
      calefactorActivo(propuesta) != calefactorActivo(accionActual);
  if (propuesta != accionActual && cambiaActuador) {
    unsigned long transcurrido = ahora - ultimoCambioMs;
    if (huboCambioActuador && transcurrido < MIN_ON_MS) {
      unsigned long faltan = (MIN_ON_MS - transcurrido + 999) / 1000;
      // Dice en que estado sigue y a cual pasara, p. ej.
      // "Histeresis: sigue en COOLING, pasa a HEATING en 58 s (minimo 60 s)"
      snprintf(motivoDecision, sizeof(motivoDecision),
               "Histeresis: sigue en %s, pasa a %s en %lu s (minimo %lu s)",
               nombreAccion(accionActual), nombreAccion(propuesta), faltan, MIN_ON_MS / 1000);
      bloqueoSegundos = faltan;
      accionPendiente = propuesta;
      return accionActual;
    }
    ultimoCambioMs = ahora;
    huboCambioActuador = true;
  }
  return propuesta;
}

// --------------------------------- Red ---------------------------------------
void onMqttMessage(char* topic, byte* payload, unsigned int length) {
  String msg;
  for (unsigned int i = 0; i < length; i++) msg += (char)payload[i];
  LOG("RED", "Comando recibido en %s: %s", topic, msg.c_str());
}

void intentarWiFi() {
  logInicio("RED");
  Serial.printf("Conectando a la red WiFi \"%s\"", WIFI_SSID);
  // Canal 6: evita que la conexion a Wokwi-GUEST se cuelgue autodetectandolo.
  WiFi.begin(WIFI_SSID, WIFI_PASS, 6);
  unsigned long inicio = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - inicio < WIFI_TIMEOUT_MS) {
    delay(300);
    Serial.print(".");
  }
  Serial.println();
  wifiOk = (WiFi.status() == WL_CONNECTED);
  if (wifiOk) {
    LOG("RED", "WiFi conectado | IP %s | RSSI %d dBm",
        WiFi.localIP().toString().c_str(), WiFi.RSSI());
  } else {
    LOG("RED", "Sin WiFi tras %lu s: el nodo opera en modo autonomo (control y alarma locales)",
        WIFI_TIMEOUT_MS / 1000);
  }
}

// Umbrales de control, retenidos: el dashboard los usa para clasificar las
// lecturas y dibujar las lineas de referencia sin duplicar constantes.
void publicarConfig() {
  char buf[320];
  snprintf(buf, sizeof(buf),
    "{\"setpoint_c\":%.1f,\"t_ventilador_on_c\":%.1f,\"t_calefactor_on_c\":%.1f,"
    "\"t_apagado_c\":%.1f,\"min_on_s\":%lu,\"hr_alta_pct\":%.0f,\"hr_baja_pct\":%.0f,"
    "\"co_alarm_ppm\":%d,\"ocupacion_adc\":%d,\"periodo_s\":%.1f}",
    SETPOINT_C, T_VENTILADOR_ON_C, T_CALEFACTOR_ON_C, T_APAGADO_C, MIN_ON_MS / 1000,
    HR_ALTA_PCT, HR_BAJA_PCT, CO_ALARM_PPM, OCCUPANCY_ADC_THRESHOLD,
    PERIODO_LECTURA_MS / 1000.0);
  mqtt.publish(TOPIC_CONFIG, buf, true);
}

void intentarMQTT() {
  if (!wifiOk) return;
  if (mqtt.connected()) { mqttEstabaConectado = true; return; }
  if (mqttEstabaConectado) {
    // Codigos de PubSubClient: -4 timeout, -3 conexion perdida, -2 fallo de red
    LOG("RED", "MQTT desconectado (rc=%d), reintento en %lu s",
        mqtt.state(), MQTT_RETRY_MIN_MS / 1000);
    mqttEstabaConectado = false;
    mqttEsperaMs = MQTT_RETRY_MIN_MS;            // 5 s hasta el primer reintento...
    mqttProximaEsperaMs = min(2 * MQTT_RETRY_MIN_MS, MQTT_RETRY_MAX_MS); // nunca supera el maximo
    ultimoIntentoMqttMs = millis();
  }
  if (huboIntentoMqtt && millis() - ultimoIntentoMqttMs < mqttEsperaMs) return;
  huboIntentoMqtt = true;
  ultimoIntentoMqttMs = millis();

  // LWT: si el nodo cae sin avisar, el broker publica "offline" retenido.
  if (mqtt.connect(clientId.c_str(), TOPIC_STATUS, 1, true, "offline")) {
    mqttEstabaConectado = true;
    mqttEsperaMs = mqttProximaEsperaMs = MQTT_RETRY_MIN_MS;
    mqtt.publish(TOPIC_STATUS, "online", true);
    mqtt.subscribe(TOPIC_CMD, 1);
    publicarConfig();
    LOG("RED", "MQTT conectado a %s:%d | cliente %s", MQTT_HOST, MQTT_PORT, clientId.c_str());
    LOG("RED", "Publica en %s | suscrito a %s", TOPIC_TELEMETRY, TOPIC_CMD);
  } else {
    mqttEsperaMs = mqttProximaEsperaMs;                                     // con MAX = MIN: siempre 5 s
    mqttProximaEsperaMs = min(mqttProximaEsperaMs * 2, MQTT_RETRY_MAX_MS);
    LOG("RED", "Error de conexion MQTT (rc=%d), reintento en %lu s",
        mqtt.state(), mqttEsperaMs / 1000);
  }
}

void publicarTelemetria(bool dhtOk, float tempC, float humedad, int mq135, int mq7ppm) {
  char temp[12], hum[12];
  if (dhtOk) {
    snprintf(temp, sizeof(temp), "%.1f", tempC);
    snprintf(hum, sizeof(hum), "%.0f", humedad);
  } else {
    strcpy(temp, "null"); // sin dato de temperatura, el resto se reporta igual
    strcpy(hum, "null");
  }
  // El motivo es texto libre: se escapan comillas y barras para no romper el JSON.
  char motivo[160];
  size_t j = 0;
  for (size_t i = 0; motivoDecision[i] && j < sizeof(motivo) - 2; i++) {
    char c = motivoDecision[i];
    if (c == '"' || c == '\\') motivo[j++] = '\\';
    motivo[j++] = c;
  }
  motivo[j] = '\0';

  float co2ppm = CO2_PPM_MIN + mq135 * (CO2_PPM_MAX - CO2_PPM_MIN) / 4095.0;
  char buf[640]; // cabe en el buffer MQTT fijado con setBufferSize en setup()
  snprintf(buf, sizeof(buf),
    "{\"ciclo\":%lu,\"uptime_s\":%.1f,\"temp_c\":%s,\"humedad\":%s,\"co2_proxy\":%d,\"co2_ppm\":%.0f,"
    "\"co_ppm\":%d,\"accion\":\"%s\",\"alarma_co\":%s,\"ventilador_pwm\":%d,"
    "\"calefactor\":%s,\"buzzer\":%s,\"led\":\"%s\",\"motivo\":\"%s\","
    "\"bloqueo_s\":%lu,\"pendiente\":\"%s\",\"is_simulated\":%s}",
    numeroCiclo, millis() / 1000.0, temp, hum, mq135, co2ppm, mq7ppm, nombreAccion(accionActual),
    alarmaCO ? "true" : "false", dutyVentilador,
    calefactorEncendido ? "true" : "false", buzzerEncendido ? "true" : "false",
    colorLed, motivo, bloqueoSegundos, bloqueoSegundos ? nombreAccion(accionPendiente) : "",
    TELEMETRIA_SIMULADA ? "true" : "false");
  if (!mqtt.publish(TOPIC_TELEMETRY, buf)) {
    LOG("RED", "No se pudo publicar la telemetria");
  }
}

// Imprime el estado completo de una lectura: la hora aparece una sola vez en la
// cabecera y cada sensor y cada actuador ocupa su propia fila.
void imprimirBloqueCiclo(bool dhtOk, float tempC, float humedad,
                         int mq135, bool ocupado, int mq7ppm) {
  char barra[13];
  barraNivel(dutyVentilador * 100 / 255, barra);

  Serial.printf("+-- CICLO %-3lu | t = %6.1f s ------------------------------\r\n",
                numeroCiclo, millis() / 1000.0);
  Serial.println("| SENSORES");
  if (dhtOk) {
    const float umbralCalido = SETPOINT_C + HYSTERESIS_C;
    const float umbralFresco = SETPOINT_C - HYSTERESIS_C;
    char clasificacionTemp[48];
    if (tempC >= umbralCalido) {
      snprintf(clasificacionTemp, sizeof(clasificacionTemp), "CALIDO (T >= %.1f C)", umbralCalido);
    } else if (tempC <= umbralFresco) {
      snprintf(clasificacionTemp, sizeof(clasificacionTemp), "FRESCO (T <= %.1f C)", umbralFresco);
    } else {
      snprintf(clasificacionTemp, sizeof(clasificacionTemp), "TEMPLADO (%.1f C < T < %.1f C)",
               umbralFresco, umbralCalido);
    }
    char clasificacionHum[48];
    if (humedad >= HR_ALTA_PCT) {
      snprintf(clasificacionHum, sizeof(clasificacionHum), "HUMEDO (HR >= %.0f %%)", HR_ALTA_PCT);
    } else if (humedad <= HR_BAJA_PCT) {
      snprintf(clasificacionHum, sizeof(clasificacionHum), "SECO (HR <= %.0f %%)", HR_BAJA_PCT);
    } else {
      snprintf(clasificacionHum, sizeof(clasificacionHum), "MODERADO (%.0f %% < HR < %.0f %%)",
               HR_BAJA_PCT, HR_ALTA_PCT);
    }
    char valorTemp[16], valorHum[16];
    snprintf(valorTemp, sizeof(valorTemp), "T = %.1f C", tempC);
    snprintf(valorHum, sizeof(valorHum), "HR = %.0f %%", humedad);
    Serial.printf("|   %-11s%-13s %s\r\n", "DHT22", valorTemp, clasificacionTemp);
    Serial.printf("|   %-11s%-13s %s\r\n", "", valorHum, clasificacionHum);
  } else {
    Serial.printf("|   %-11ssin lectura\r\n", "DHT22");
  }
  if (ocupado) {
    Serial.printf("|   %-11sADC %4d/4095   AULA OCUPADA (ADC >= %d)\r\n", "MQ-135", mq135,
                  OCCUPANCY_ADC_THRESHOLD);
  } else {
    Serial.printf("|   %-11sADC %4d/4095   AULA VACIA (ADC < %d)\r\n", "MQ-135", mq135,
                  OCCUPANCY_ADC_THRESHOLD);
  }
  if (alarmaCO) {
    Serial.printf("|   %-11sCO = %d ppm   ALARMA (CO >= %d ppm)\r\n", "MQ-7", mq7ppm,
                  CO_ALARM_PPM);
  } else {
    Serial.printf("|   %-11sCO = %d ppm   NORMAL (CO < %d ppm)\r\n", "MQ-7", mq7ppm,
                  CO_ALARM_PPM);
  }
  Serial.println("| DECISION");
  if (alarmaCO) {
    // Durante la alarma el control de clima esta suspendido: no se muestra el
    // ultimo estado de la heuristica, porque no es quien manda al ventilador.
    Serial.printf("|   %-11sALARMA DE CO - Control de clima suspendido\r\n", "Estado");
  } else {
    Serial.printf("|   %-11s%s - %s\r\n", "Estado", nombreAccion(accionActual),
                  descripcionAccion(accionActual));
  }
  Serial.printf("|   %-11s%s\r\n", "Motivo", motivoDecision);
  Serial.println("| ACTUADORES");
  bool ledEncendido = ledRojoOn || ledVerdeOn || ledAzulOn;
  Serial.printf("|   %-11s%-4s%s %3d %%   (LED amarillo)\r\n", "Ventilador",
                dutyVentilador > 0 ? "ON" : "OFF", barra, dutyVentilador * 100 / 255);
  Serial.printf("|   %-11s%-4s                     (LED naranja)\r\n", "Calefactor",
                calefactorEncendido ? "ON" : "OFF");
  Serial.printf("|   %-11s%s\r\n", "Buzzer", buzzerEncendido ? "ON" : "OFF");
  Serial.printf("|   %-11s%-4s%s\r\n", "LED RGB", ledEncendido ? "ON" : "OFF", colorLed);
  Serial.println("+------------------------------------------------");
  Serial.println();
}

// --------------------------------- setup ---------------------------------------
void setup() {
  Serial.begin(115200);
  delay(300);
  imprimirEncabezado();

  dht.begin();
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(LED_R_PIN, OUTPUT);
  pinMode(LED_G_PIN, OUTPUT);
  pinMode(LED_B_PIN, OUTPUT);
  pinMode(HEATER_PIN, OUTPUT);
  escribirCalefactor(false);

#if CCS_LEDC_API_NUEVA
  ledcAttach(FAN_PWM_PIN, 5000, 8); // 5 kHz, 8 bits
#else
  ledcSetup(FAN_PWM_CHANNEL, 5000, 8);
  ledcAttachPin(FAN_PWM_PIN, FAN_PWM_CHANNEL);
#endif

  // --- INA219 (opcional) ---
  // Wire.begin();
  // if (!ina219.begin()) LOG("SIS", "INA219 no detectado (revisar SDA/SCL)");

  escribirBuzzer(false);
  aplicarAccion(accionActual);
  LOGF("SIS", "DHT22",      "sensor   | D4");
  LOGF("SIS", "MQ-135",     "sensor   | D34 (ADC1)");
  LOGF("SIS", "MQ-7",       "sensor   | D35 (ADC1)");
  LOGF("SIS", "Ventilador", "actuador | D25 (PWM)");
  LOGF("SIS", "Calefactor", "actuador | D32");
  LOGF("SIS", "Buzzer",     "actuador | D26");
  LOGF("SIS", "LED RGB",    "actuador | D27 (R), D14 (G), D13 (B)");
  LOG("SIS", "Estado inicial: %s | LED=%s", nombreAccion(accionActual), colorLed);

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onMqttMessage);
  // Por defecto PubSubClient espera hasta 15 s al broker y bloquea el loop
  // (control y alarma). Con 3 s el fallo se reporta rapido.
  mqtt.setSocketTimeout(3);
  // El buffer por defecto de PubSubClient (256 B) no alcanza para la telemetria
  // con el motivo de la decision: los publish mas largos fallarian en silencio.
  mqtt.setBufferSize(768);
  clientId = String(CLIENT_ID_BASE) + "-" + String((uint32_t)esp_random(), HEX);

  intentarWiFi();
  intentarMQTT();
  Serial.println();
}

// ---------------------------------- loop ----------------------------------------
void loop() {
  if (wifiOk) {
    intentarMQTT(); // no bloquea: respeta su propio temporizador de reintento
    mqtt.loop();
  }

  if (millis() - ultimaLecturaMs < PERIODO_LECTURA_MS) return;
  ultimaLecturaMs = millis();

  // --- 1. Lectura de sensores ---
  int mq135  = analogRead(MQ135_PIN);          // 0-4095, proxy de CO2/ocupacion
  int mq7Raw = analogRead(MQ7_PIN);            // 0-4095
  int mq7ppm = map(mq7Raw, 0, 4095, 0, 150);   // mapeo SIMPLIFICADO para simular;
                                               // en hardware real usar la curva
                                               // de calibracion del MQ-7
  bool ocupado = mq135 >= OCCUPANCY_ADC_THRESHOLD;
  float tempC   = dht.readTemperature();
  float humedad = dht.readHumidity();
  bool dhtOk = !isnan(tempC) && !isnan(humedad);

  // --- 2. Seguridad: alarma de CO, evaluada antes que el control de clima ---
  alarmaCO = (mq7ppm >= CO_ALARM_PPM);
  if (alarmaCO && !alarmaCOPrevia) {
    LOG("EVT", "ALARMA DE CO ACTIVADA: %d ppm >= %d ppm. Ventilador forzado al 100%%, calefactor OFF y buzzer ON",
        mq7ppm, CO_ALARM_PPM);
  } else if (!alarmaCO && alarmaCOPrevia) {
    LOG("EVT", "Alarma de CO desactivada: %d ppm < %d ppm. Se reanuda el control por heuristica",
        mq7ppm, CO_ALARM_PPM);
  }
  alarmaCOPrevia = alarmaCO;

  // --- 3. Decision de clima ---
  // Solo la heuristica bloquea; con alarma de CO o sin lectura del DHT no hay bloqueo.
  bloqueoSegundos = 0;
  if (alarmaCO) {
    snprintf(motivoDecision, sizeof(motivoDecision),
             "CO >= %d ppm: ventilador al 100 %%, calefactor OFF y buzzer ON", CO_ALARM_PPM);
  } else if (!dhtOk) {
    snprintf(motivoDecision, sizeof(motivoDecision),
             "Sin lectura del DHT22: se mantiene el ultimo estado");
  } else {
    Accion nueva = decidirHeuristica(tempC, ocupado);
    if (nueva != accionActual) {
      LOG("EVT", "Transicion de estado: %s -> %s",
          nombreAccion(accionActual), nombreAccion(nueva));
      accionActual = nueva;
    }
  }

  // --- 4. Actuacion ---
  escribirBuzzer(alarmaCO);
  if (alarmaCO) {
    escribirPWMVentilador(255); // caudal maximo, independiente de la heuristica
    escribirCalefactor(false);  // nunca coincide con el ventilador
    setLedEstado(accionActual);
  } else {
    aplicarAccion(accionActual);
  }

  // --- 5. Registro del ciclo ---
  numeroCiclo++;
  if (numeroCiclo % LOG_CADA_N_CICLOS == 0) {
    imprimirBloqueCiclo(dhtOk, tempC, humedad, mq135, ocupado, mq7ppm);
  }

  // --- 6. Telemetria ---
  if (mqtt.connected()) {
    publicarTelemetria(dhtOk, tempC, humedad, mq135, mq7ppm);
  }
}
