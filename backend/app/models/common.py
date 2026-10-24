# ARCHIVO NUEVO — este archivo no existía antes, hay que crearlo completo.
# Sirve para que las respuestas de error (401/403/404/409) tengan un "schema"
# declarado, y así Watson pueda ofrecer {body.detail} como variable insertable
# en los mensajes de error de las actions.

from pydantic import BaseModel


class ErrorDetail(BaseModel):
    """Shape de todo HTTPException(detail=...) del backend."""
    detail: str
