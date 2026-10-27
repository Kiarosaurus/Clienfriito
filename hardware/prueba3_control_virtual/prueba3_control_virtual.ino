// Prueba 3: DHT11 D27 + pulsador D26/GND. Sin motor ni rele conectado.
// Envia medidas reales por USB/Serial y confirma la orden que devuelve la API.
// Python: hardware/prueba3_mi_cuarto.py
// Biblioteca: DHT sensor library de Adafruit y Adafruit Unified Sensor.

#include <DHT.h>
#include <stdlib.h>
#include <string.h>

constexpr int DHT_PIN = 27;
constexpr int BUTTON_PIN = 26;
constexpr unsigned long READ_INTERVAL_MS = 10000;
constexpr unsigned long DHT_MIN_INTERVAL_MS = 2000;
constexpr unsigned long DEBOUNCE_MS = 40;

DHT dht(DHT_PIN, DHT11);
unsigned long last_read_ms = 0;
unsigned long last_button_change_ms = 0;
bool last_button_raw = HIGH;
bool button_stable = HIGH;
uint32_t sequence = 0;
bool waiting_for_command = false;
char command_line[80];
size_t command_length = 0;

void readAndPrint(const char* trigger) {
  last_read_ms = millis();
  float humidity = dht.readHumidity();
  float temperature = dht.readTemperature();
  if (isnan(humidity) || isnan(temperature)) {
    Serial.println("DHT11: lectura fallida; revisar 3V3, D27 y GND");
    return;
  }
  ++sequence;
  waiting_for_command = true;
  Serial.printf(
      "{\"sensor\":\"DHT11\",\"seq\":%lu,\"temperature\":%.1f,\"humidity\":%.1f,\"trigger\":\"%s\"}\n",
      static_cast<unsigned long>(sequence), temperature, humidity, trigger);
}

void processCommand(const char* line) {
  unsigned long received_seq = 0;
  char action[20] = {};
  char pwm[16] = {};
  if (sscanf(line, "CMD,%lu,%19[^,],%15s", &received_seq, action, pwm) != 3) {
    Serial.println("ERR,FORMATO");
    return;
  }
  if (!waiting_for_command || received_seq != sequence) {
    Serial.printf("ERR,SECUENCIA,%lu\n", received_seq);
    return;
  }
  if (strcmp(action, "ON") != 0 && strcmp(action, "PRE-COOLING") != 0 &&
      strcmp(action, "STANDBY") != 0 && strcmp(action, "DISABLED") != 0) {
    Serial.println("ERR,ACCION");
    return;
  }
  if (strcmp(pwm, "NA") != 0) {
    char* end = nullptr;
    double value = strtod(pwm, &end);
    if (end == pwm || *end != '\0' || !isfinite(value) || value < 0 || value > 100) {
      Serial.println("ERR,PWM");
      return;
    }
  }
  waiting_for_command = false;
  // Solo confirmacion por Serial. No hay salida GPIO ni ventilador fisico.
  Serial.printf("ACK,%lu,%s,%s\n", received_seq, action, pwm);
}

void readSerialCommands() {
  while (Serial.available()) {
    char c = static_cast<char>(Serial.read());
    if (c == '\r') continue;
    if (c == '\n') {
      command_line[command_length] = '\0';
      if (command_length > 0) processCommand(command_line);
      command_length = 0;
    } else if (command_length < sizeof(command_line) - 1) {
      command_line[command_length++] = c;
    } else {
      command_length = 0;
      Serial.println("ERR,LINEA_LARGA");
    }
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  dht.begin();
  delay(DHT_MIN_INTERVAL_MS);
  readAndPrint("periodic");
}

void loop() {
  readSerialCommands();
  const unsigned long now = millis();
  const bool raw = digitalRead(BUTTON_PIN);
  if (raw != last_button_raw) {
    last_button_change_ms = now;
    last_button_raw = raw;
  }
  if (now - last_button_change_ms >= DEBOUNCE_MS && raw != button_stable) {
    button_stable = raw;
    if (button_stable == LOW) {
      if (now - last_read_ms >= DHT_MIN_INTERVAL_MS) {
        readAndPrint("button");
      } else {
        Serial.println("BOTON: espera 2 s entre lecturas DHT11");
      }
    }
  }
  if (now - last_read_ms >= READ_INTERVAL_MS) {
    readAndPrint("periodic");
  }
  delay(5);
}
