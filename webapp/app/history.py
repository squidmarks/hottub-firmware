"""Temperature history: one sample a minute in SQLite, kept for KEEP_DAYS.

Each sample is water and outdoor temperature (°F), the heating target in force
(a Heat hold's target, or Keep warm's, else none), whether the heater was on
at any point during that minute, and the pump state (0 off, 1 low, 2 high).

The same data fits a two-number heat model, refreshed hourly from the last
FIT_DAYS days:  dT/dt = P*heater - k*(T_water - T_outside)   (°F per hour)
  P  heater gain: how fast the heater alone raises the water
  k  loss rate:   how fast the tub cools, per degree it's warmer than outside
Cooling windows (heater off, pump not on high) measure k directly; heating
windows then give P. Without enough cooling data, P and k are both fitted
from heating windows (the rate falls as the water warms, which pins k).
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
FIT_DAYS = 7      # heat model: how much history to fit
WINDOW_S = 1200   # ...in 20-minute steady windows
MIN_WINDOWS = 6


class History:
    def __init__(self, path: Path, controller: Controller) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS samples ("
            " ts INTEGER PRIMARY KEY, water REAL, outdoor REAL, target REAL, heater INTEGER)"
        )
        cols = {r[1] for r in self.db.execute("PRAGMA table_info(samples)")}
        if "pump" not in cols:
            self.db.execute("ALTER TABLE samples ADD COLUMN pump INTEGER")
        self.db.commit()
        self.model: dict[str, Any] | None = None
        self.controller = controller
        self._heater_seen = False

    def _target(self, s: dict[str, Any]) -> float | None:
        if s.get("active_hold") == "HEAT":
            return s.get("target_temperature")
        if s.get("keep_warm"):
            return s.get("keep_warm_temperature")
        return None

    async def fit_loop(self) -> None:
        while True:
            try:
                self.model = self.fit()
                if self.model:
                    log.info("heat model: P=%.2f F/h, k=%.3f /h (%d heating, %d cooling windows)",
                             self.model["P"], self.model["k"], self.model["heat_windows"],
                             self.model["cool_windows"])
            except Exception:
                log.exception("heat model fit failed")
            await asyncio.sleep(3600)

    def fit(self, days: int = FIT_DAYS) -> dict[str, Any] | None:
        """Fit P and k from WINDOW_S-long stretches of steady state."""
        rows = self.db.execute(
            "SELECT ts, water, outdoor, heater, pump FROM samples WHERE ts >= ? ORDER BY ts",
            (int(time.time()) - days * 86400,),
        ).fetchall()
        heat, cool = [], []  # (rate °F/h, ΔT to outside)
        n = WINDOW_S // SAMPLE_S
        i = 0
        while i + n < len(rows):
            w = rows[i:i + n + 1]
            ok = (all(r[1] is not None and r[2] is not None for r in w)
                  and w[-1][0] - w[0][0] <= WINDOW_S + 2 * SAMPLE_S)  # no gaps
            heating = ok and all(r[3] for r in w) and all(r[4] in (None, 1) for r in w)
            cooling = ok and not any(r[3] for r in w) and all(r[4] in (None, 0, 1) for r in w)
            if heating or cooling:
                hours = (w[-1][0] - w[0][0]) / 3600
                rate = (w[-1][1] - w[0][1]) / hours
                dt = sum(r[1] - r[2] for r in w) / len(w)
                (heat if heating else cool).append((rate, dt))
                i += n  # non-overlapping windows
            else:
                i += 1
        P = k = None
        cool = [(r, d) for r, d in cool if d > 3]
        if len(cool) >= MIN_WINDOWS:
            k = -sum(r * d for r, d in cool) / sum(d * d for _, d in cool)
            if heat:
                P = sum(r + k * d for r, d in heat) / len(heat)
        elif len(heat) >= MIN_WINDOWS:
            ds = [d for _, d in heat]
            if max(ds) - min(ds) >= 5:  # need spread in ΔT to see the losses
                md, mr = sum(ds) / len(ds), sum(r for r, _ in heat) / len(heat)
                slope = (sum((d - md) * (r - mr) for r, d in heat)
                         / sum((d - md) ** 2 for d in ds))
                k, P = -slope, mr - slope * md
        if P is None or k is None or not (1 <= P <= 30) or not (0 <= k <= 0.5):
            return None
        return {"P": round(P, 2), "k": round(k, 4), "heat_windows": len(heat),
                "cool_windows": len(cool), "fitted_at": int(time.time())}

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
                "INSERT OR REPLACE INTO samples (ts, water, outdoor, target, heater, pump)"
                " VALUES (?,?,?,?,?,?)",
                (ts, s.get("water_temperature"), s.get("outdoor_temperature"),
                 self._target(s), int(heater), {"LOW": 1, "HIGH": 2}.get(s.get("pump"), 0)),
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
    h.db.executemany("INSERT OR REPLACE INTO samples (ts, water, outdoor, target, heater)"
                     " VALUES (?,?,?,?,?)", rows)
    h.db.commit()
