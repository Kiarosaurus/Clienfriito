// Prueba 2: DHT11 en D27/GPIO27 y pulsador en D26/GPIO26 + GND.
// El boton pide una lectura adicional; tambien se lee cada 10 segundos.
// USB/Serial a 115200: hardware/prueba2_mi_cuarto.py envia las lecturas a CCS.
// Biblioteca: DHT sensor library de Adafruit y Adafruit Unified Sensor.

#include <DHT.h>

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

void readAndPrint(const char* trigger) {
  last_read_ms = millis();
  float humidity = dht.readHumidity();
  float temperature = dht.readTemperature();
  if (isnan(humidity) || isnan(temperature)) {
    Serial.println("DHT11: lectura fallida; revisar 3V3, D27 y GND");
    return;
  }
  Serial.printf(
      "{\"sensor\":\"DHT11\",\"temperature\":%.1f,\"humidity\":%.1f,\"trigger\":\"%s\"}\n",
      temperature, humidity, trigger);
}

void setup() {
  Serial.begin(115200);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  dht.begin();
  delay(DHT_MIN_INTERVAL_MS);
  readAndPrint("periodic");
}

void loop() {
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
