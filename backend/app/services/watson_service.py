import time
import logging
from starlette.concurrency import run_in_threadpool
from app.config import WATSON_API_KEY, WATSON_URL, WATSON_ASSISTANT_ID

# Cuántas veces continuamos con input vacío para recoger el texto que Watson
# dejó pendiente cuando el turno vuelve sin texto (turno vacío o solo "pause").
_MAX_CONTINUATIONS = 3
_MAX_PAUSE_SECONDS = 3.0
# Espera corta antes de continuar un turno vacío (generic=[]), que no trae un
# tiempo de pausa propio, para darle margen al callout de la extensión.
_EMPTY_TURN_WAIT = 0.6

logger = logging.getLogger(__name__)

_client = None  # AssistantV2 singleton


def init_watson() -> None:
    global _client
    if not all([WATSON_API_KEY, WATSON_URL, WATSON_ASSISTANT_ID]):
        logger.warning(
            "Watson credentials incomplete — chat endpoint will return 503. "
            "Set WATSON_API_KEY, WATSON_URL, WATSON_ASSISTANT_ID env vars."
        )
        return
    try:
        from ibm_watson import AssistantV2
        from ibm_cloud_sdk_core.authenticators import IAMAuthenticator

        authenticator = IAMAuthenticator(WATSON_API_KEY)
        _client = AssistantV2(version="2021-11-27", authenticator=authenticator)
        _client.set_service_url(WATSON_URL)
        logger.info("Watson AssistantV2 client initialized (url=%s).", WATSON_URL)
    except Exception as exc:
        logger.error("Failed to initialize Watson client: %s", exc)


# ── sync helpers (run in threadpool) ─────────────────────────────────────────

def _create_session_sync() -> str:
    result = _client.create_session(
        assistant_id=WATSON_ASSISTANT_ID,
        environment_id=WATSON_ASSISTANT_ID,
    ).get_result()
    return result["session_id"]


def _texts_from(generics: list) -> list[str]:
    # Junta TODOS los fragmentos de tipo "text" del turno, sin importar en qué
    # posición vengan (antes solo miraba generics[0] y se perdía la respuesta
    # real si Watson mandaba una pausa/opciones antes del texto).
    return [g.get("text") for g in generics if g.get("response_type") == "text" and g.get("text")]


def _pause_seconds(generics: list) -> float | None:
    # Si el turno solo trae "pause" (el "escribiendo…" que Watson manda mientras
    # resuelve un callout de extensión) y NADA de texto, devuelve cuánto esperar
    # antes de pedir la continuación. None si no hay ninguna pausa que seguir.
    pauses = [g for g in generics if g.get("response_type") == "pause"]
    if not pauses:
        return None
    ms = max((g.get("time") or 0) for g in pauses)
    return min(ms / 1000.0, _MAX_PAUSE_SECONDS)


def _send_message_sync(session_id: str, text: str, skill_variables: dict | None = None) -> str:
    kwargs: dict = {}
    if skill_variables:
        # Actions read these as session variables (must exist with the SAME
        # names in the actions skill). This is how the logged-in user's JWT
        # reaches extension callouts: the action binds the Authorization
        # header to the `jwt` variable, and the backend then enforces the
        # exact same RBAC as the web UI — Watson adds no authority of its own.
        kwargs["context"] = {
            "skills": {"actions skill": {"skill_variables": skill_variables}}
        }
    user_id = (skill_variables or {}).get("username") or "ccs_anonymous"

    response = _client.message(
        assistant_id=WATSON_ASSISTANT_ID,
        environment_id=WATSON_ASSISTANT_ID,
        session_id=session_id,
        input={"message_type": "text", "text": text},
        user_id=user_id,
        **kwargs,
    ).get_result()
    generics = response.get("output", {}).get("generic", [])
    texts = _texts_from(generics)

    # Watson parte la respuesta cuando un paso hace un callout de extensión:
    # devuelve un turno SIN texto (observado: generic=[] totalmente vacío, o a
    # veces solo un "pause"/typing) y el texto real llega en el siguiente turno.
    # ANTES eso caía a "No hubo respuesta de Watson." y el usuario tenía que
    # reescribir el mismo mensaje para verlo. AHORA continuamos con input vacío
    # (no re-dispara la action ni el callout) para recoger lo pendiente.
    attempts = 0
    while not texts and attempts < _MAX_CONTINUATIONS:
        # Un turno "pause" trae su propio tiempo de espera; un turno vacío no,
        # así que usamos una espera corta para dar margen al callout.
        wait = _pause_seconds(generics)
        time.sleep(wait if wait is not None else _EMPTY_TURN_WAIT)
        attempts += 1
        response = _client.message(
            assistant_id=WATSON_ASSISTANT_ID,
            environment_id=WATSON_ASSISTANT_ID,
            session_id=session_id,
            input={"message_type": "text", "text": ""},
            user_id=user_id,
            **kwargs,
        ).get_result()
        generics = response.get("output", {}).get("generic", [])
        texts = _texts_from(generics)
        # Si el turno ya trae contenido real que NO es texto (option,
        # user_defined, etc.) y tampoco es una pausa, no hay texto que recoger
        # por esta vía: cortamos para no insistir de más.
        if not texts and generics and _pause_seconds(generics) is None:
            break

    if texts:
        return "\n".join(texts)

    # DIAGNÓSTICO TEMPORAL: como no hay acceso a los logs del servidor, exponemos
    # en el propio chat qué mandó Watson en el turno vacío, para saber si es un
    # "pause", otro response_type, o un turno totalmente vacío. Quitar una vez
    # identificado el response_type y ampliado el filtro de _texts_from().
    seen_types = [g.get("response_type") for g in generics]
    logger.warning(
        "Watson devolvió un turno SIN texto tras %d continuación(es). response_types=%s | output=%s",
        attempts, seen_types, response.get("output", {}),
    )
    return (
        "No hubo respuesta de Watson. "
        f"[DEBUG cont={attempts} types={seen_types} "
        f"generic={str(generics)[:400]}]"
    )


# ── public async API ──────────────────────────────────────────────────────────

async def create_session() -> str:
    if _client is None:
        raise RuntimeError("Watson client not initialized. Check Watson env vars.")
    return await run_in_threadpool(_create_session_sync)


async def send_message(session_id: str, text: str, skill_variables: dict | None = None) -> str:
    if _client is None:
        raise RuntimeError("Watson client not initialized. Check Watson env vars.")
    return await run_in_threadpool(_send_message_sync, session_id, text, skill_variables)
