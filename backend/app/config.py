import os
import secrets

MONGO_URI = os.getenv("MONGO_URI", "mongodb://mongo:27017")
POSTGRES_URI = os.getenv(
    "POSTGRES_URI",
    "postgresql://postgres:postgres@localhost:5432/climate_db",
)

# IBM Watson Assistant
WATSON_API_KEY = os.getenv("WATSON_API_KEY", "")
WATSON_URL = os.getenv("WATSON_URL", "")
WATSON_ASSISTANT_ID = os.getenv("WATSON_ASSISTANT_ID", "")

# Watson Custom Extension API key (protects /sensors and /chat endpoints)
WATSON_EXTENSION_KEY = os.getenv("WATSON_EXTENSION_KEY", "")

# Initial password for the auto-seeded 'admin' account. The default is ONLY
# acceptable for local development — production deployments MUST set it.
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "admin")

# JWT
SECRET_KEY = os.getenv("SECRET_KEY") or secrets.token_hex(32)
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "15"))

# Deployment timezone offset from UTC (whole hours), used to phase-align the diurnal
# temperature drift so its peak lands in the local afternoon. Default -5 = America/Lima
# (Barranco, UTEC — no DST). Override via env for other deployments.
LOCAL_UTC_OFFSET_HOURS = int(os.getenv("LOCAL_UTC_OFFSET_HOURS", "-5"))
