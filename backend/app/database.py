from motor.motor_asyncio import AsyncIOMotorClient
from app.config import MONGO_URI

_client: AsyncIOMotorClient | None = None


def get_client() -> AsyncIOMotorClient:
    global _client
    if _client is None:
        _client = AsyncIOMotorClient(MONGO_URI, serverSelectionTimeoutMS=3000)
    return _client


def get_db():
    return get_client()["climate_db"]
