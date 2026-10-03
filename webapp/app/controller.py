"""One live connection to the hot tub controller over the ESPHome native API.

Keeps the latest value of every entity (by object_id), reconnects on its own,
and tells subscribers whenever something changes. HOTTUB_FAKE=1 swaps in a
simulated controller for UI work without the real tub.
"""

from __future__ import annotations

import asyncio
import logging
import random
from typing import Any

from aioesphomeapi import (
    APIClient,
    APIConnectionError,
    EntityInfo,
    EntityState,
    UserService,
)

log = logging.getLogger("hottub.controller")

RETRY_S = 5


class Controller:
    def __init__(self, host: str, port: int, key: str) -> None:
        self.host, self.port, self.key = host, port, key
        self.connected = False
        self.by_key: dict[int, EntityInfo] = {}
        self.by_id: dict[str, EntityInfo] = {}
        self.states: dict[str, Any] = {}
        self.services: dict[str, UserService] = {}
        self._client: APIClient | None = None
        self._subscribers: set[asyncio.Queue[None]] = set()
        self._disconnected = asyncio.Event()

    # --- subscribers -----------------------------------------------------
    def subscribe(self) -> asyncio.Queue[None]:
        q: asyncio.Queue[None] = asyncio.Queue(maxsize=1)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[None]) -> None:
        self._subscribers.discard(q)

    def _notify(self) -> None:
        for q in self._subscribers:
            if q.empty():
                q.put_nowait(None)

    def snapshot(self) -> dict[str, Any]:
        return {"connected": self.connected, **self.states}

    # --- connection loop -------------------------------------------------
    async def run(self) -> None:
        while True:
            try:
                await self._connect_once()
                await self._disconnected.wait()
            except (APIConnectionError, OSError, asyncio.TimeoutError) as e:
                log.warning("controller unreachable: %s", e)
            except Exception:  # keep the loop alive whatever happens
                log.exception("controller connection failed")
            self._set_connected(False)
            await asyncio.sleep(RETRY_S)

    async def _connect_once(self) -> None:
        self._disconnected.clear()

        async def on_stop(expected: bool) -> None:
            log.info("controller disconnected")
            self._disconnected.set()

        client = APIClient(self.host, self.port, None, noise_psk=self.key)
        await client.connect(on_stop=on_stop, login=True)
        entities, services = await client.list_entities_services()
        self._client = client
        self.by_key = {e.key: e for e in entities}
        self.by_id = {e.object_id: e for e in entities}
        self.services = {s.name: s for s in services}
        client.subscribe_states(self._on_state)
        self._set_connected(True)
        log.info("connected to %s: %d entities, %d actions", self.host, len(entities), len(services))

    def _on_state(self, st: EntityState) -> None:
        info = self.by_key.get(st.key)
        if info is None:
            return
        if getattr(st, "missing_state", False):
            value = None
        else:
            value = getattr(st, "state", None)
            if isinstance(value, float) and value != value:  # NaN -> unknown
                value = None
        if self.states.get(info.object_id) != value:
            self.states[info.object_id] = value
            self._notify()

    def _set_connected(self, up: bool) -> None:
        if self.connected != up:
            self.connected = up
            self._notify()

    # --- commands --------------------------------------------------------
    def _need(self) -> APIClient:
        if not self.connected or self._client is None:
            raise ConnectionError("controller offline")
        return self._client

    async def action(self, name: str, **data: Any) -> None:
        client = self._need()
        svc = self.services.get(name)
        if svc is None:
            raise KeyError(f"controller has no action {name}")
        await client.execute_service(svc, data)

    def set_number(self, object_id: str, value: float) -> None:
        self._need().number_command(self.by_id[object_id].key, value)

    def set_select(self, object_id: str, option: str) -> None:
        self._need().select_command(self.by_id[object_id].key, option)

    def set_switch(self, object_id: str, on: bool) -> None:
        self._need().switch_command(self.by_id[object_id].key, on)

    def press(self, object_id: str) -> None:
        self._need().button_command(self.by_id[object_id].key)

    def options(self, object_id: str) -> list[str]:
        return list(getattr(self.by_id.get(object_id), "options", []) or [])

    def limits(self, object_id: str) -> dict[str, float] | None:
        e = self.by_id.get(object_id)
        if e is None or not hasattr(e, "min_value"):
            return None
        return {"min": e.min_value, "max": e.max_value, "step": e.step}


class FakeController(Controller):
    """Simulated tub for working on the UI without the real controller."""

    def __init__(self) -> None:
        super().__init__("fake", 0, "")
        self.states = {
            "water_temperature": 98.4, "outdoor_temperature": 41.2,
            "target_temperature": 102.0, "eco_temperature": 85.0,
            "activity": "Hold HEAT, 1:42:10 left", "pump": "LOW", "fault": "NONE",
            "active_hold": "HEAT", "hold_time_remaining": "1:42:10",
            "heat_requested": True, "ch1_run": True, "ch2_select__on___high_": False,
            "ch3_heat": True, "di1_flow": True, "di2_temp_ok": True, "di3_tub_button": False,
            "power__estimated_": 5856.0, "energy_today": 12.4, "energy_total": 311.2,
            "filter_cycle_after_no_flow_for": 12.0, "filter_cycle_length": 60.0,
            "button_session_length": 30.0, "quiet_period": 10.0,
            "tub_button_type": "Momentary", "water_probe": "Probe A (…5528)",
            "buzzer_enabled": True, "wi-fi_rssi": -61.0, "uptime": 3600.0,
            "probe_a___5528_": 98.4, "probe_b___2928_": 41.2,
            "1-wire_devices": "0x310b257cdc352928, 0x5b0b257ca8dc5528",
        }
        self._opts = {
            "tub_button_type": ["Momentary", "Latching"],
            "water_probe": ["Probe A (…5528)", "Probe B (…2928)"],
        }

    async def run(self) -> None:
        self._set_connected(True)
        while True:
            await asyncio.sleep(3)
            if self.states["ch3_heat"]:
                self.states["water_temperature"] = round(self.states["water_temperature"] + 0.1, 1)
            self.states["outdoor_temperature"] = round(41 + random.random(), 1)
            self._notify()

    async def action(self, name: str, **data: Any) -> None:
        log.info("fake action %s %s", name, data)
        s = self.states
        if name == "start_hold":
            s["target_temperature"] = data["target_f"]
            s["active_hold"] = data["mode"].upper()
            s["activity"] = f"Hold {data['mode'].upper()}, {data['hold_s'] // 60} min"
            s["pump"] = "HIGH" if data["mode"] == "pump_high" else "LOW"
            s["ch3_heat"] = data["mode"] == "heat"
        elif name == "stop":
            s.update(activity="Quiet, 0:10:00 left", pump="OFF", ch3_heat=False, active_hold="OFF")
        elif name == "quiet":
            s.update(activity="Quiet, 0:10:00 left", pump="OFF", ch3_heat=False)
        elif name == "set_jets":
            lvl = data["level"]
            s["pump"] = {"off": "LOW", "low": "LOW", "high": "HIGH"}[lvl]
            s["activity"] = "Button HIGH, 0:30:00 left" if lvl == "high" else s["activity"]
        self._notify()

    def set_number(self, object_id: str, value: float) -> None:
        self.states[object_id] = value
        self._notify()

    def set_select(self, object_id: str, option: str) -> None:
        self.states[object_id] = option
        self._notify()

    def set_switch(self, object_id: str, on: bool) -> None:
        self.states[object_id] = on
        self._notify()

    def press(self, object_id: str) -> None:
        log.info("fake press %s", object_id)

    def options(self, object_id: str) -> list[str]:
        return self._opts.get(object_id, [])

    def limits(self, object_id: str) -> dict[str, float] | None:
        return {
            "eco_temperature": {"min": 34, "max": 104, "step": 0.5},
            "filter_cycle_after_no_flow_for": {"min": 1, "max": 48, "step": 1},
            "filter_cycle_length": {"min": 10, "max": 240, "step": 5},
            "button_session_length": {"min": 5, "max": 120, "step": 5},
            "quiet_period": {"min": 1, "max": 60, "step": 1},
        }.get(object_id)
