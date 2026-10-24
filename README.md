# Climate Cognitive System (CCS)

[![CI](https://github.com/Kiarosaurus/Climate-Cognitive-System/actions/workflows/ci.yml/badge.svg)](https://github.com/Kiarosaurus/Climate-Cognitive-System/actions/workflows/ci.yml)
[![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-async-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)](https://docs.docker.com/compose/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

> An IoT cognitive platform that turns raw climate-sensor telemetry into **predictive, occupancy-aware air-conditioning decisions** — pre-cooling rooms *before* they fill up, flagging CO emergencies in real time, and quantifying the energy it saves.

> 🌐 **Live instance:** [kiarosaurus.me](https://kiarosaurus.me) · 📖 Technical deep-dive: [TECHNICAL_DOCUMENTATION.md](./TECHNICAL_DOCUMENTATION.md) · 📄 Project report (Spanish, rubric): [`informe/informe.pdf`](./informe/informe.pdf)

<!-- Screenshots: drop PNGs into docs/assets/ and uncomment.
| Global dashboard | Room detail | ROI report |
|---|---|---|
| ![Dashboard](docs/assets/dashboard.png) | ![Room detail](docs/assets/room-detail.png) | ![ROI](docs/assets/roi.png) |
-->

---

## Overview

Traditional HVAC reacts: it waits for a room to get hot, then cools it. By then the energy is already wasted and the occupants are already uncomfortable. **Climate Cognitive System (CCS)** flips this into a *predictive* loop.

Every sensor reading is enriched with **room context** (capacity, target temperature, and the class/event schedule), fed into a **thermal-load model**, and converted into a concrete cognitive action — `ON / PRE-COOLING`, `STANDBY`, or `DISABLED`. The system anticipates the heat load that *N* people will generate and starts cooling ahead of time, instead of chasing the temperature after the fact.

On top of the control loop, CCS provides:

- A **real-time CO (carbon monoxide) emergency monitor** that separates genuine hardware alerts from simulated/test traffic.
- An **ROI report** that compares cognitive energy consumption against a traditional "always-on" baseline and reports the savings in **kWh and USD**.
- A **conversational assistant** (IBM Watson Assistant) embedded in the UI for natural-language queries.
- **Role-based access control** (admin / collaborator / guest) with reservation-gated device control.

---

## Key Features

- **🧠 Cognitive Cooling Engine** — Predicts thermal load from `[temperature, hour_of_day, expected_occupancy, actual_occupancy, outdoor_temp, floor, volume_m3, ac_btu]` and emits a pre-cooling decision per reading. Adjusts the room's target temperature downward by the predicted load offset so cooling starts *before* the heat arrives.
- **👥 Expected vs. Actual Occupancy (feed-forward + feedback)** — The reservation plan drives anticipatory pre-cooling; **actual occupancy inferred from CO₂** (steady-state mass balance) trims the demand in real time, so a half-empty booked room stops being over-cooled. Both signals and their gap are persisted per reading.
- **🌡️ Exogenous Climate Driver** — A deterministic Lima temperature model (`climate_service`) feeds outdoor temperature as a feature — no weather API or extra hardware — giving the model signal the occupancy heuristic can't reproduce.
- **🔀 Dual-Mode Prediction with Graceful Degradation** — Uses a trained scikit-learn `HistGradientBoostingRegressor` (loaded as a **bundle** with its feature contract, room map and metadata) when `model.joblib` is present; automatically falls back to a transparent heuristic when it isn't. The API never goes down for lack of a model.
- **🗄️ Polyglot Persistence** — High-volume, schemaless sensor telemetry lives in **MongoDB**; relational configuration (users, rooms, schedules, devices, reservations) lives in **PostgreSQL**. Each store is used for what it's best at.
- **🚨 Real-Time CO Emergency Monitor** — Surfaces `CO > 50 ppm` alerts from a rolling 15-second window, with a hard-fallback classifier that buckets each alert as *real* vs *simulated* and self-purges stale simulation data every polling cycle.
- **💵 ROI / Energy-Savings Report** — Reconstructs AC runtime from the stored `cognitive_action` history, contrasts it against a 100%-uptime traditional baseline, and computes savings in kWh and USD over a 7-day window.
- **💬 Conversational Assistant** — IBM Watson Assistant integration exposed as a session-based chat endpoint and a floating in-app chat widget.
- **🔐 RBAC + JWT Auth** — Argon2 password hashing (self-healing admin seed), short-lived JWTs, and reservation-aware authorization (collaborators can only control devices in rooms they currently hold).
- **🛡️ Resilient Startup** — PostgreSQL connection retries, idempotent in-code schema migrations (handling cases `create_all()` can't), and an auto-seeded admin account.
- **🐳 Fully Containerized** — One `docker compose up` brings up PostgreSQL, MongoDB, the FastAPI backend, and the React frontend on an isolated bridge network with health checks.
- **🔌 Physical Sensor Node** — An **Arduino UNO** (DHT11, MQ-135, MQ-7) streams JSON over Serial to a Python gateway ([`hardware/sistema.py`](./hardware/sistema.py)) that also counts room occupancy with the laptop camera (**MediaPipe Face Detection**, virtual-line crossing) and POSTs the merged reading to the live backend.

---

## Engineering Decisions

The decisions that best explain the design — each with a full writeup in the [technical documentation](./TECHNICAL_DOCUMENTATION.md):

1. **The ML model must beat its own heuristic to ship** — chronological holdout plus mean and occupancy-only baselines; if `beats_baselines` is false, the API keeps running on the transparent heuristic instead (§3.9.3).
2. **Feed-forward + feedback occupancy** — the reservation plan pre-cools ahead of arrival; CO₂ mass balance trims demand to measured reality, so a half-empty booked room stops being over-cooled (§3.7).
3. **A deterministic exogenous climate driver instead of a weather API** — without independent signal the cooling label degenerates into `occupancy × k`, which the heuristic already reproduces, and ML can never win (§3.9.1–3.9.2).
4. **Polyglot persistence without strict cross-store FKs** — high-volume telemetry in MongoDB, relational configuration in PostgreSQL; deletions use historical orphaning + text-confirmation instead of cascades that would destroy telemetry history (§3.4).
5. **Graceful degradation everywhere** — a missing `model.joblib`, absent Watson credentials, or a briefly unreachable database degrade one feature each; the API never goes down whole (§3.9, startup retries).

---

## Tech Stack & Architecture

### Backend
| Layer | Technology |
|-------|-----------|
| API framework | **FastAPI** + **Uvicorn** (ASGI), async endpoints |
| Validation | **Pydantic v2** |
| Relational DB | **PostgreSQL 15** via **SQLAlchemy 2.0** (`psycopg2`) |
| Document DB | **MongoDB 6.0** via **Motor** (async) / **PyMongo** |
| Machine Learning | **scikit-learn** (`HistGradientBoostingRegressor`), **NumPy**, **pandas**, **joblib** |
| Conversational AI | **IBM Watson Assistant** (`ibm-watson` SDK) |
| Auth / Security | **JWT** (`python-jose`), **Argon2** hashing (`pwdlib`) |

### Frontend
| Layer | Technology |
|-------|-----------|
| Framework | **React 18** + **TypeScript** |
| Build tool | **Vite 5** |
| Styling | **Tailwind CSS 3** |
| Charts | **Recharts** |
| HTTP / Auth | **Axios**, **jwt-decode** |
| Routing | **React Router 6** |

### Infrastructure
- **Docker** & **Docker Compose** — four-service orchestration (`postgres`, `mongo`, `backend`, `frontend`) on a dedicated bridge network with health-checked dependencies.

### Architecture at a Glance

```
                         ┌──────────────────────────────┐
   Sensors / Simulator   │   React + Vite Frontend       │
        │                │   (dashboards, chat, ROI)     │
        │ POST readings  └───────────────┬───────────────┘
        │                                │ REST (Axios + JWT)
        ▼                                ▼
┌────────────────────────────────────────────────────────┐
│                   FastAPI Backend                       │
│                                                         │
│  /sensors ─► process_reading ─► get_room_context ───────┼──► PostgreSQL
│                     │                                   │   (rooms, schedules,
│                     ▼                                   │    users, devices,
│             calculate_cooling_demand                    │    reservations)
│             (ML model  ▸ or ▸  heuristic)               │
│                     │                                   │
│                     ▼  cognitive_action                 │
│             save_reading ───────────────────────────────┼──► MongoDB
│                                                         │   (sensor_readings)
│  /chat ──► IBM Watson Assistant                         │
│  /reports ─► ROI energy-savings calculator              │
│  /auth ──► JWT + RBAC                                    │
└─────────────────────────────────────────────────────────┘
                     ▲
                     │ python ml_pipeline/*.py
        ┌────────────┴─────────────┐
        │  ML Pipeline (offline)    │
        │  extract_data → train     │
        │  → backend/app/ml/        │
        │       model.joblib        │
        └───────────────────────────┘
```

**Data-flow highlight:** each ingested reading is matched to its device → room → active schedule, scored for thermal load, tagged with a `cognitive_action`, and persisted. Telemetry from inactive devices is dropped at ingest; control-disabled devices are stored but emit no action. This keeps the hot path lean and the document store free of dead data.

---

## Project Structure

```
Climate-Cognitive-System/
├── backend/
│   ├── Dockerfile
│   ├── requirements.txt
│   ├── tests/                   # Unit tests (services) + DB-free route smoke tests
│   └── app/
│       ├── main.py              # App bootstrap, startup hooks, migrations, admin seed
│       ├── config.py            # Env-driven configuration
│       ├── dependencies.py      # get_current_user (JWT + revocation) + require_api_key
│       ├── database.py          # MongoDB (Motor) connection
│       ├── database_sql.py      # PostgreSQL (SQLAlchemy) connection
│       ├── core/                # security.py (Argon2 + JWT), timeutils.py (UTC↔local)
│       ├── models/              # Pydantic (sensor) + SQLAlchemy (admin) models
│       ├── routes/              # sensors, admin, chat, auth, reports
│       ├── services/            # data, predictive, occupancy, climate, room_profile, watson
│       └── ml/model.joblib      # Trained model bundle (generated by ml_pipeline)
├── frontend/                    # React + Vite + Tailwind SPA
│   ├── Dockerfile
│   ├── package.json
│   └── src/
├── ml_pipeline/
│   ├── common.py                # Shared bootstrap-label formula (label ↔ baseline)
│   ├── extract_data.py          # Mongo → feature CSV (+ synthetic augmentation)
│   └── train_model.py           # Train & export the model bundle
├── seed_data/
│   ├── generate_dataset.py      # Reproducible UTEC dataset → Mongo + PostgreSQL
│   └── DATASET_GUIDE.md         # Usage, time window and attendance model
├── hardware/
│   ├── sistema.py               # Arduino UNO Serial → camera occupancy → HTTPS gateway
│   └── README.md                # Components, calibration and run instructions
├── informe/
│   ├── informe.tex              # Spanish project report (rubric) → informe.pdf
│   └── slides.tex               # Spanish presentation (beamer) → slides.pdf
├── database/
│   ├── postgres/init.sql
│   └── mongo/init.js
├── .github/workflows/ci.yml     # CI: backend unit tests + frontend build
├── docker-compose.yml
└── .env.example                 # Template — copy to .env (gitignored)
```

---

## Prerequisites

- **Docker** ≥ 24.0 & **Docker Compose** ≥ 2.0 (recommended path)
- **Git**
- For manual/local runs: **Python 3.12+**, plus a running **PostgreSQL 15** and **MongoDB 6**
- *(Optional)* IBM Watson Assistant credentials for the chat feature

---

## Installation & Setup

### Option A — Docker Compose (recommended)

```bash
# 1. Clone
git clone https://github.com/Kiarosaurus/Climate-Cognitive-System.git
cd Climate-Cognitive-System

# 2. Configure environment
cp .env.example .env   # or create .env manually (see Environment Variables below)

# 3. Launch the full stack (fresh state)
docker compose down -v
docker compose up --build -d

# Follow backend logs
docker compose logs -f backend
```

Services come up on:

| Service   | URL                         |
|-----------|-----------------------------|
| Frontend  | http://localhost:3000       |
| Backend   | http://localhost:8000       |
| API docs  | http://localhost:8000/docs  |
| PostgreSQL| localhost:5432              |
| MongoDB   | localhost:27017             |

A default admin account is auto-seeded on first startup:

```
username: admin
password: admin      # local development default (ADMIN_PASSWORD env unset)
```

> ⚠️ **Public deployments MUST set `ADMIN_PASSWORD`** in `.env` before first boot
> (or rotate the password immediately after). The seeder never overwrites a
> valid existing hash, so a rotated password survives restarts.

### Option B — Manual / Local Dev

**Backend**
```bash
cd backend
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
# Ensure Postgres & Mongo are running and env vars are set
uvicorn app.main:app --reload --port 8000
```

**Frontend**
```bash
cd frontend
npm install
npm run dev          # Vite dev server
```

### Environment Variables (`.env`)

```ini
# Databases — MONGO_URI / POSTGRES_URI are NOT set here: docker-compose.yml
# injects them pointing at the `mongo` / `postgres` service names. Set them
# only for manual/local runs outside Docker.
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
POSTGRES_DB=climate_db

# Auth — the JWT algorithm is hardcoded to HS256 in app/config.py (not env-read)
SECRET_KEY=<random-hex>           # auto-generated in memory if omitted (tokens reset on restart)
ACCESS_TOKEN_EXPIRE_MINUTES=15
ADMIN_PASSWORD=<strong-password>  # initial 'admin' password — REQUIRED for public deployments

# Deployment timezone — whole-hour UTC offset to phase-align the diurnal drift.
LOCAL_UTC_OFFSET_HOURS=-5         # default America/Lima (Barranco, UTEC); no DST

# IBM Watson Assistant (optional — chat returns 503 if unset)
WATSON_API_KEY=
WATSON_URL=
WATSON_ASSISTANT_ID=
WATSON_EXTENSION_KEY=             # API key protecting /sensors and /chat
```

> ⚠️ If `SECRET_KEY` is left empty, the backend generates a random one in memory at boot — every token expires when the container restarts.

---

## Usage

### Health check
```bash
curl http://localhost:8000/health
# {"status":"ok"}
```

### Authenticate (obtain a JWT)
```bash
curl -X POST http://localhost:8000/api/v1/auth/login \
  -d "username=admin&password=admin"
# → { "access_token": "...", "token_type": "bearer" }
```

### Ingest a sensor reading
> The `/sensors` and `/chat` routers are gated by the `WATSON_EXTENSION_KEY` API key —
> a **shared anti-abuse gate, not per-device authentication** (the frontend bakes it
> into the public JS bundle). It is enforced only when the env var is set; unset, the
> routes are open (local dev).

```bash
curl -X POST http://localhost:8000/api/v1/sensors/ \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $WATSON_EXTENSION_KEY" \
  -d '{
        "sensor_id": "sensor-001",
        "temperature": 28.5,
        "humidity": 60,
        "co2_ppm": 800,
        "co_ppm": 5
      }'
```

Example response — note the predicted cognitive action:

```json
{
  "sensor_id": "sensor-001",
  "anomaly_detected": false,
  "inserted_id": "...",
  "cognitive_action": {
    "ac_status": "ON",
    "cooling_mode": "PRE-COOLING",
    "target": 21.85,
    "thermal_load_offset": 0.15,
    "model": "ml",
    "expected_occupancy": 30,
    "actual_occupancy": 15,
    "effective_occupancy": 21.0,
    "occupancy_gap": 15
  },
  "room_context": { "room_name": "Lab A", "expected_people": 30 }
}
```

### Poll CO emergencies (admin / collaborator)
```bash
curl http://localhost:8000/api/v1/sensors/emergencies \
  -H "Authorization: Bearer $TOKEN"
# → { "real": [...], "simulated": [...] }
```

### Chat with the assistant
```bash
curl -X POST http://localhost:8000/api/v1/chat/ \
  -H "X-API-Key: $WATSON_EXTENSION_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "message": "What is the temperature in Lab A?" }'
```

---

## Physical Sensor Node

The repo includes the client-side gateway for the real sensor node deployed in classroom **A403**: an **Arduino UNO** samples DHT11 (temperature/humidity), MQ-135 (CO₂ proxy) and MQ-7 (CO, raw ADC → ppm via datasheet curve) and streams JSON over USB-Serial every ~2 s; [`hardware/sistema.py`](./hardware/sistema.py) merges in a **camera-based occupancy count** (MediaPipe Face Detection, virtual-line crossing) and POSTs the reading to the backend. Wiring, calibration and run instructions: [`hardware/README.md`](./hardware/README.md).

---

## Running Tests

Unit tests cover the pure cognitive logic — CO₂ mass-balance occupancy, the deterministic Lima climate model, the heuristic cooling engine (feed-forward/feedback blend, policies, AC decision) and per-room physical metadata — plus DB-free route smoke tests for the auth gates and RBAC (these skip automatically when `fastapi` is not installed):

```bash
cd backend
pip install -r requirements-dev.txt
pytest -v
```

The same suite plus the frontend type-check/build runs on every push via [GitHub Actions](./.github/workflows/ci.yml).

---

## Training the Predictive Model

The cooling engine runs on a heuristic fallback out of the box. To train and deploy the ML model:

```bash
# From project root, with MONGO_URI reachable
python ml_pipeline/extract_data.py    # Mongo → ml_pipeline/data/features.csv
python ml_pipeline/train_model.py     # → backend/app/ml/model.joblib
```

- **`extract_data.py`** pulls `sensor_readings` from MongoDB, reads the **real plan** (`expected_occupancy`) from the stored `cognitive_action`, derives `actual_occupancy` from CO₂, attaches per-room physical metadata (`floor`, `volume_m3`, `ac_btu`) and the exogenous `outdoor_temp`, writes rows **in chronological order**, and augments with synthetic rows when real data is sparse.
- **`train_model.py`** fits a `HistGradientBoostingRegressor` with **early stopping** on a **chronological holdout**, reports **baselines** (mean + occupancy-only heuristic) so ML only ships if it beats them, prints permutation feature importances, and exports a **bundle** `{model, features, room_id_map, metadata}` to `model.joblib`. On the next backend startup it is picked up automatically (ML mode).
- Reproducible seed: **`seed_data/generate_dataset.py`** builds a realistic ~2-month UTEC dataset (occupancy trend, CO₂-coherent gap, Lima climate) and loads Mongo + PostgreSQL — see [`seed_data/DATASET_GUIDE.md`](./seed_data/DATASET_GUIDE.md).

---

## API Surface

| Method | Endpoint                              | Auth                         | Purpose                                      |
|--------|---------------------------------------|------------------------------|----------------------------------------------|
| GET    | `/health`                             | —                            | Liveness probe                               |
| POST   | `/api/v1/auth/login`                  | —                            | Obtain JWT                                    |
| POST   | `/api/v1/auth/register`               | —                            | Create account (guest auto-active; others pending) |
| POST   | `/api/v1/sensors/`                    | API key                      | Ingest reading + cognitive action             |
| GET    | `/api/v1/sensors/`                    | API key                      | List recent readings (filter by room/sensor)  |
| GET    | `/api/v1/sensors/emergencies`         | API key + JWT (admin/collab) | Real-time CO alerts                           |
| PUT    | `/api/v1/sensors/{id}/control`        | API key + JWT (no guests; collaborator needs an active reservation) | Toggle device active / control-enabled |
| POST   | `/api/v1/chat/`                       | API key (+ optional JWT, forwarded to Watson actions as session variables) | Watson Assistant conversation |
| GET    | `/api/v1/reports/roi`                 | JWT (admin)                  | ROI / energy-savings report                   |
| *      | `/api/v1/admin/...`                   | JWT (admin; reservations & timeline also collaborator) | Manage users, rooms, schedules, reservations |

> The API key rows apply router-wide: every `/sensors` and `/chat` route also passes
> through `require_api_key` (no-op while `WATSON_EXTENSION_KEY` is unset).

Full interactive documentation is available at **`/docs`** (Swagger UI) when the backend is running.

---

## Useful Docker Commands

```bash
# Rebuild a single service
docker compose up --build -d backend
docker compose up --build -d frontend

# Open a shell inside a container
docker compose exec backend bash
docker compose exec postgres psql -U postgres -d climate_db
docker compose exec mongo mongosh

# Stop (keep volumes) / tear everything down
docker compose down
docker compose down -v --remove-orphans
```
## Video de Demostración

[Enlace de video de demostración](https://www.youtube.com/watch?v=rYZCHMFjSDE)
---

## License

Released under the [MIT License](./LICENSE).