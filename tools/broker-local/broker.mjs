// Broker MQTT liviano, SIN Docker: alternativa a Mosquitto para probar solo el nodo
// (Wokwi) y el monitor, sin backend ni bases de datos. Con Docker, usar el servicio
// `mosquitto` del docker-compose (mismos puertos: no levantar ambos a la vez).
//
//   TCP       1883 -> lo usa el ESP32 de Wokwi (MQTT_HOST = "host.wokwi.internal")
//   WebSocket 9001 -> lo usa el dashboard (ws://localhost:9001)
//   HTTP      9001 -> sirve el monitor del nodo en http://localhost:9001
//
// Uso:  cd tools/broker-local && npm install && npm start
import { createServer } from "node:net";
import http from "node:http";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Aedes = require("aedes");
const websocketStream = require("websocket-stream");

const PUERTO_TCP = Number(process.env.PUERTO_TCP || 1883);
const PUERTO_WS = Number(process.env.PUERTO_WS || 9001);

const aedes = new Aedes();
const hora = () => new Date().toLocaleTimeString("es-PE", { hour12: false });

createServer(aedes.handle).listen(PUERTO_TCP, () =>
  console.log(`[${hora()}] MQTT TCP en el puerto ${PUERTO_TCP} (ESP32)`));
// El mismo puerto sirve el monitor por HTTP (http://localhost:9001), para abrirlo dentro de
// VS Code (Simple Browser) junto al simulador: Wokwi se pausa cuando VS Code no esta a la vista.
const DASHBOARD = fileURLToPath(new URL("../../frontend/public/monitor/index.html", import.meta.url));
const web = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url.startsWith("/?") || req.url === "/index.html")) {
    readFile(DASHBOARD).then(
      (html) => { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); res.end(html); },
      () => { res.writeHead(500); res.end("No se encontro frontend/public/monitor/index.html"); });
  } else { res.writeHead(404); res.end(); }
});
websocketStream.createServer({ server: web }, aedes.handle);
web.listen(PUERTO_WS, () => {
  console.log(`[${hora()}] MQTT WebSocket en el puerto ${PUERTO_WS} (ws://localhost:${PUERTO_WS})`);
  console.log(`[${hora()}] Dashboard en http://localhost:${PUERTO_WS}`);
});

aedes.on("client", (c) => console.log(`[${hora()}] + conectado:    ${c.id}`));
aedes.on("clientDisconnect", (c) => console.log(`[${hora()}] - desconectado: ${c.id}`));
// Una linea por cada 30 mensajes de telemetria, para confirmar que fluye sin inundar la consola.
let telemetrias = 0;
aedes.on("publish", (paquete, cliente) => {
  if (!cliente) return;
  if (paquete.topic.endsWith("/telemetry")) {
    if (++telemetrias % 30 === 1) console.log(`[${hora()}]   telemetria #${telemetrias} de ${cliente.id}`);
  } else {
    console.log(`[${hora()}]   ${paquete.topic}: ${paquete.payload.toString().slice(0, 80)}`);
  }
});
