"""Hot tub web app: a phone-first page for everyone, settings for the admin.

Guests (anyone who can reach the page) can heat to a temperature, run the
jets, go quiet and stop. Everything under /api/admin/ and /admin requires the
admin: Caddy puts those paths behind the Google login and passes the verified
email in X-Auth-Request-Email (stripping any copy the browser sent); this app
also checks that email against ADMIN_EMAILS.

All commands go to the controller's own time-bounded holds and limits; this
app adds nothing the controller would not already enforce, plus guest caps.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .controller import Controller, FakeController

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger("hottub")

STATIC = Path(__file__).parent.parent / "static"
ADMIN_EMAILS = {e.strip().lower() for e in os.environ.get("ADMIN_EMAILS", "").split(",") if e.strip()}
EMAIL_HEADER = os.environ.get("AUTH_EMAIL_HEADER", "X-Auth-Request-Email")

# Guest limits (the controller enforces its own on top: 60-104 °F, <= 4 h).
GUEST_MAX_F = float(os.environ.get("GUEST_MAX_F", "104"))
GUEST_MIN_F = 60.0
GUEST_MAX_MIN = int(os.environ.get("GUEST_MAX_MIN", "240"))

# What the admin may change, by controller object_id.
SETTINGS_NUMBERS = {
    "eco_temperature", "filter_cycle_after_no_flow_for", "filter_cycle_length",
    "button_session_length", "quiet_period",
}
SETTINGS_SELECTS = {"tub_button_type", "water_probe"}
SETTINGS_SWITCHES = {"buzzer_enabled"}

if os.environ.get("HOTTUB_FAKE") == "1":
    controller: Controller = FakeController()
else:
    controller = Controller(
        os.environ["CONTROLLER_HOST"],
        int(os.environ.get("CONTROLLER_PORT", "6053")),
        os.environ["CONTROLLER_API_KEY"],
    )


@asynccontextmanager
async def lifespan(_: FastAPI):
    task = asyncio.create_task(controller.run())
    yield
    task.cancel()


app = FastAPI(title="Hot tub", lifespan=lifespan, docs_url=None, redoc_url=None)


async def _do(coro_or_none) -> dict:
    try:
        if asyncio.iscoroutine(coro_or_none):
            await coro_or_none
    except ConnectionError as e:
        raise HTTPException(503, str(e)) from e
    return {"ok": True}


def _call(fn, *args):
    try:
        fn(*args)
    except ConnectionError as e:
        raise HTTPException(503, str(e)) from e
    except KeyError as e:
        raise HTTPException(404, f"unknown entity {e}") from e
    return {"ok": True}


# --- public: status ----------------------------------------------------------
@app.get("/api/state")
async def state():
    return controller.snapshot()


@app.get("/api/events")
async def events(request: Request):
    """Server-sent events: the full state now, then again on every change."""

    async def stream():
        q = controller.subscribe()
        try:
            yield f"data: {json.dumps(controller.snapshot())}\n\n"
            while not await request.is_disconnected():
                try:
                    await asyncio.wait_for(q.get(), timeout=15)
                    await asyncio.sleep(0.2)  # coalesce bursts of updates
                    yield f"data: {json.dumps(controller.snapshot())}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            controller.unsubscribe(q)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# --- public: guest controls --------------------------------------------------
class Heat(BaseModel):
    target_f: float = Field(ge=GUEST_MIN_F, le=GUEST_MAX_F)
    minutes: int = Field(ge=15, le=GUEST_MAX_MIN)


class Jets(BaseModel):
    level: Literal["off", "low", "high"]


@app.post("/api/heat")
async def heat(body: Heat):
    log.info("heat to %.1f°F for %d min", body.target_f, body.minutes)
    return await _do(controller.action("start_hold", mode="heat",
                                       target_f=body.target_f, hold_s=body.minutes * 60))


@app.post("/api/jets")
async def jets(body: Jets):
    log.info("jets %s", body.level)
    return await _do(controller.action("set_jets", level=body.level))


@app.post("/api/quiet")
async def quiet():
    return await _do(controller.action("quiet"))


@app.post("/api/stop")
async def stop():
    log.info("stop")
    return await _do(controller.action("stop"))


# --- admin -------------------------------------------------------------------
FAKE = os.environ.get("HOTTUB_FAKE") == "1"


def admin(request: Request) -> str:
    email = (request.headers.get(EMAIL_HEADER) or "").strip().lower()
    if FAKE and not email:
        email = "dev@localhost"  # simulated tub only: there is no login in front of it
    if not email or (ADMIN_EMAILS and email not in ADMIN_EMAILS):
        raise HTTPException(403, "admin only")
    return email


@app.get("/api/admin/me")
async def me(email: str = Depends(admin)):
    settings = {}
    for oid in sorted(SETTINGS_NUMBERS):
        settings[oid] = {"type": "number", **(controller.limits(oid) or {})}
    for oid in sorted(SETTINGS_SELECTS):
        settings[oid] = {"type": "select", "options": controller.options(oid)}
    for oid in sorted(SETTINGS_SWITCHES):
        settings[oid] = {"type": "switch"}
    return {"email": email, "settings": settings}


class Setting(BaseModel):
    id: str
    value: float | str | bool


@app.post("/api/admin/setting")
async def set_setting(body: Setting, email: str = Depends(admin)):
    log.info("admin %s sets %s = %r", email, body.id, body.value)
    if body.id in SETTINGS_NUMBERS and isinstance(body.value, (int, float)) and not isinstance(body.value, bool):
        lim = controller.limits(body.id)
        if lim and not (lim["min"] <= body.value <= lim["max"]):
            raise HTTPException(422, f"{body.id} must be {lim['min']}–{lim['max']}")
        return _call(controller.set_number, body.id, float(body.value))
    if body.id in SETTINGS_SELECTS and isinstance(body.value, str):
        if body.value not in controller.options(body.id):
            raise HTTPException(422, "not one of the options")
        return _call(controller.set_select, body.id, body.value)
    if body.id in SETTINGS_SWITCHES and isinstance(body.value, bool):
        return _call(controller.set_switch, body.id, body.value)
    raise HTTPException(422, "not an admin setting, or wrong value type")


@app.post("/api/admin/filter-now")
async def filter_now(email: str = Depends(admin)):
    log.info("admin %s: filter now", email)
    return _call(controller.press, "filter_now")


# --- pages -------------------------------------------------------------------
@app.get("/admin")
async def admin_page(_: str = Depends(admin)):
    return FileResponse(STATIC / "admin.html")


@app.get("/healthz")
async def healthz():
    return {"ok": True, "controller": controller.connected}


app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")
