"""RF-26 manual override: who may control a room's devices (RF-37)."""
import types

import pytest

pytest.importorskip("fastapi")

from fastapi import HTTPException  # noqa: E402

from app.routes.sensors import _require_room_control  # noqa: E402


def user(role):
    return types.SimpleNamespace(id=1, username=role, role=role)


def test_admin_may_always_override():
    _require_room_control(None, user("admin"), "A403")   # no DB access needed


def test_guest_may_never_override():
    with pytest.raises(HTTPException) as exc:
        _require_room_control(None, user("guest"), "A403")
    assert exc.value.status_code == 403


def test_manual_modes_map_to_node_actions():
    from app.routes.sensors import override_command

    assert override_command("fan", 30, "admin")["accion"] == "COOLING"
    assert override_command("heater", 30, "admin")["accion"] == "HEATING"
    assert override_command("off", 30, "admin")["accion"] == "STANDBY"
    assert override_command("on", 30, "admin")["accion"] == "COOLING"     # older clients
    assert override_command("fan", 30, "admin")["duracion_s"] == 1800
    assert override_command("auto", 30, "admin") == {"modo": "auto"}
    assert override_command("fan", 30, "admin", 50)["nivel"] == 50            # fan power
    assert "nivel" not in override_command("heater", 30, "admin", 50)       # only the fan has a level
    with pytest.raises(ValueError):
        override_command("both", 30, "admin")
