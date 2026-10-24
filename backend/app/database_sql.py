import logging
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker, declarative_base
from app.config import POSTGRES_URI

logger = logging.getLogger(__name__)

Base = declarative_base()

engine = create_engine(
    POSTGRES_URI,
    pool_pre_ping=True,   # verify connection before use
    pool_size=5,
    max_overflow=10,
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


def get_db_sql():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
