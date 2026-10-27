// Prueba 1: ESP32 DevKit V1 + DHT11 en GPIO27.
// Emite solo lecturas reales por USB/Serial. El script Python las envia a CCS.
// Instalar "DHT sensor library" de Adafruit (y Adafruit Unified Sensor).

#include <DHT.h>

constexpr int DHT_PIN = 27;
constexpr unsigned long READ_INTERVAL_MS = 10000;
DHT dht(DHT_PIN, DHT11);
unsigned long last_read_ms = 0;

void readAndPrint() {
  float humidity = dht.readHumidity();
  float temperature = dht.readTemperature();
  if (isnan(humidity) || isnan(temperature)) {
    Serial.println("DHT11: lectura fallida; revisar 3V3, GPIO27 y GND");
    return;
  }
  Serial.printf("{\"sensor\":\"DHT11\",\"temperature\":%.1f,\"humidity\":%.1f}\n",
                temperature, humidity);
}

void setup() {
  Serial.begin(115200);
  dht.begin();
  delay(2000);
  readAndPrint();
  last_read_ms = millis();
}

void loop() {
  if (millis() - last_read_ms >= READ_INTERVAL_MS) {
    readAndPrint();
    last_read_ms = millis();
  }
}
