import logging
from typing import Optional
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel
from jose import JWTError

from app.core.security import decode_token
from app.services import watson_service

logger = logging.getLogger(__name__)
router = APIRouter()


class ChatRequest(BaseModel):
    session_id: Optional[str] = None
    message: str


class ChatResponse(BaseModel):
    response: str
    session_id: str


def _session_identity(authorization: Optional[str]) -> dict:
    """Best-effort identity forwarded to Watson as actions session variables.

    The widget already sends the logged-in user's Bearer JWT (axios interceptor);
    actions bind it to the Authorization header of extension callouts, so CRUD
    requests hit the API as that user and the backend enforces the exact same
    RBAC as the web UI. Absent/invalid token → anonymous: small talk keeps
    working, and any CRUD callout is rejected by the API itself (401/403) —
    authorization is NEVER decided here or in Watson.
    """
    identity = {"jwt": "", "user_role": "anonymous", "username": ""}
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(" ", 1)[1].strip()
        identity["jwt"] = token
        try:
            claims = decode_token(token)
            identity["user_role"] = claims.get("role") or "anonymous"
            identity["username"] = claims.get("sub") or ""
        except JWTError:
            # Forward the opaque token anyway; protected endpoints will 401 it.
            logger.info("Chat: undecodable bearer token — forwarding as anonymous.")
    return identity


@router.post("/", response_model=ChatResponse)
async def chat(payload: ChatRequest, authorization: Optional[str] = Header(None)):
    try:
        session_id = payload.session_id
        if not session_id:
            session_id = await watson_service.create_session()
            logger.info("New Watson session created: %s", session_id)

        identity = _session_identity(authorization)
        response_text = await watson_service.send_message(
            session_id, payload.message, skill_variables=identity
        )
        logger.info(
            "Watson response for session %s (role=%s): %s",
            session_id, identity["user_role"], response_text[:80],
        )
        return ChatResponse(response=response_text, session_id=session_id)

    except RuntimeError as exc:
        logger.error("Watson not available: %s", exc)
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception as exc:
        # Catches ibm_cloud_sdk_core.api_exception.ApiException too
        code = getattr(exc, "code", 500)
        detail = getattr(exc, "message", str(exc))
        logger.error("Watson API error %s: %s", code, detail)
        raise HTTPException(status_code=code if isinstance(code, int) else 500, detail=detail)
