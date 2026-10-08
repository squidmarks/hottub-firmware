"""Temperature history: one sample a minute in SQLite, kept for KEEP_DAYS.

Each sample is water and outdoor temperature (°F), the heating target in force
(a Heat hold's target, or Keep warm's, else none) and whether the heater was on
at any point during that minute.
"""

from __future__ import annotations

import asyncio
import logging
import sqlite3
import time
from pathlib import Path
from typing import Any

from .controller import Controller

log = logging.getLogger("hottub.history")

SAMPLE_S = 60
KEEP_DAYS = 60
MAX_POINTS = 360  # what a phone-width chart can show


class History:
    def __init__(self, path: Path, controller: Controller) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS samples ("
            " ts INTEGER PRIMARY KEY, water REAL, outdoor REAL, target REAL, heater INTEGER)"
        )
        self.db.commit()
        self.controller = controller
        self._heater_seen = False

    def _target(self, s: dict[str, Any]) -> float | None:
        if s.get("active_hold") == "HEAT":
            return s.get("target_temperature")
        if s.get("keep_warm"):
            return s.get("keep_warm_temperature")
        return None

    async def run(self) -> None:
        q = self.controller.subscribe()  # to catch short heater runs between samples
        next_at = time.time() // SAMPLE_S * SAMPLE_S + SAMPLE_S
        try:
            while True:
                try:
                    await asyncio.wait_for(q.get(), timeout=max(0.1, next_at - time.time()))
                    if self.controller.states.get("ch3_heat"):
                        self._heater_seen = True
                    continue
                except asyncio.TimeoutError:
                    pass
                self._record(int(next_at))
                next_at += SAMPLE_S
        finally:
            self.controller.unsubscribe(q)

    def _record(self, ts: int) -> None:
        c = self.controller
        if not c.connected:
            return  # leave a gap rather than repeat stale values
        s = c.states
        heater = bool(s.get("ch3_heat")) or self._heater_seen
        self._heater_seen = False
        try:
            self.db.execute(
                "INSERT OR REPLACE INTO samples VALUES (?,?,?,?,?)",
                (ts, s.get("water_temperature"), s.get("outdoor_temperature"),
                 self._target(s), int(heater)),
            )
            self.db.execute("DELETE FROM samples WHERE ts < ?", (ts - KEEP_DAYS * 86400,))
            self.db.commit()
        except sqlite3.Error:
            log.exception("could not record a sample")

    def query(self, hours: float) -> dict[str, Any]:
        """Samples for the last `hours`, averaged into at most MAX_POINTS buckets."""
        now = int(time.time())
        start = now - int(hours * 3600)
        bucket = max(SAMPLE_S, int(hours * 3600 / MAX_POINTS))
        rows = self.db.execute(
            "SELECT (ts / ?) * ? AS b, AVG(water), AVG(outdoor), AVG(target), MAX(heater)"
            " FROM samples WHERE ts >= ? GROUP BY b ORDER BY b",
            (bucket, bucket, start),
        ).fetchall()
        r1 = lambda v: None if v is None else round(v, 1)  # noqa: E731
        return {
            "start": start, "end": now, "bucket_s": bucket,
            "points": [
                {"t": b, "water": r1(w), "outdoor": r1(o), "target": r1(tg), "heater": bool(h)}
                for b, w, o, tg, h in rows
            ],
        }


def seed_fake(h: History, days: int = 7) -> None:
    """Simulated tub only: a week of plausible history so the chart has data."""
    import math
    import random

    if h.db.execute("SELECT COUNT(*) FROM samples").fetchone()[0]:
        return
    now = int(time.time()) // SAMPLE_S * SAMPLE_S
    water, rows = 85.0, []
    for i in range(days * 1440, 0, -1):
        ts = now - i * SAMPLE_S
        hour = (ts // 3600) % 24
        outdoor = 50 + 12 * math.sin((hour - 9) / 24 * 2 * math.pi) + random.uniform(-0.5, 0.5)
        target = 102.0 if 17 <= hour < 23 else None
        heater = target is not None and water < target
        water += 0.09 if heater else -(water - outdoor) * 0.0004
        rows.append((ts, round(water, 2), round(outdoor, 2), target, int(heater)))
    h.db.executemany("INSERT OR REPLACE INTO samples VALUES (?,?,?,?,?)", rows)
    h.db.commit()
