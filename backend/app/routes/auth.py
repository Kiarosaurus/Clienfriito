import logging
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy.exc import SQLAlchemyError

from app.database_sql import get_db_sql
from app.models.admin import User, ROLES
from app.core.security import verify_password, hash_password, create_access_token

logger = logging.getLogger(__name__)
router = APIRouter()


class RegisterIn(BaseModel):
    username: str
    password: str
    role: str = "guest"


@router.post("/login")
def login(
    form: OAuth2PasswordRequestForm = Depends(),
    db: Session = Depends(get_db_sql),
):
    user = db.query(User).filter(User.username == form.username).first()
    if not user or not verify_password(form.password, user.hashed_password):
        logger.warning("Failed login attempt for username='%s'", form.username)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if user.status != "active":
        logger.warning("Login blocked — user='%s' status='%s'.", user.username, user.status)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Account is '{user.status}'. Contact an administrator.",
        )
    token = create_access_token({"sub": user.username, "role": user.role})
    logger.info("User '%s' authenticated (role=%s).", user.username, user.role)
    return {"access_token": token, "token_type": "bearer"}


@router.post("/register", status_code=201)
def register(payload: RegisterIn, db: Session = Depends(get_db_sql)):
    if payload.role not in ROLES:
        raise HTTPException(status_code=400, detail=f"Invalid role. Must be one of: {sorted(ROLES)}")
    if db.query(User).filter(User.username == payload.username).first():
        raise HTTPException(status_code=409, detail="Username already taken.")

    # collaborator and admin require approval; guest is immediately active
    initial_status = "active" if payload.role == "guest" else "pending"

    user = User(
        username=payload.username,
        hashed_password=hash_password(payload.password),
        role=payload.role,
        status=initial_status,
    )
    db.add(user)
    try:
        db.commit()
        db.refresh(user)
    except SQLAlchemyError as exc:
        db.rollback()
        logger.error("DB error on register: %s", exc)
        raise HTTPException(status_code=503, detail="Database error. Try again later.") from exc
    logger.info("Registered user='%s' role='%s' status='%s'.", user.username, user.role, user.status)
    return {"user_id": user.id, "username": user.username, "role": user.role, "status": user.status}
