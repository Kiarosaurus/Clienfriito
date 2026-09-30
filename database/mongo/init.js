db = db.getSiblingDB("climate_db");

db.createCollection("sensor_readings");

db.sensor_readings.createIndex({ sensor_id: 1, timestamp: -1 });

// Timestamp-only range scans (ROI report, TTL purge) — the compound index above
// cannot serve these (prefix rule: it needs sensor_id first).
db.sensor_readings.createIndex({ timestamp: 1 });

// CO emergencies: polled every 5 s per client. Partial index stays near-empty
// in normal operation (only readings above the 50 ppm alert threshold).
db.sensor_readings.createIndex(
  { timestamp: 1 },
  { partialFilterExpression: { co_ppm: { $gt: 50 } }, name: "co_alerts_ts" }
);

// NOTE: this script only runs when the Mongo volume is created fresh
// (docker-entrypoint-initdb.d). On a live instance, run the createIndex
// calls above manually via mongosh.

print("MongoDB initialized: climate_db.sensor_readings ready.");
