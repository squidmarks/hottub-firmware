// Shared by the guest and admin pages: live state, units, small helpers.
"use strict";

const $ = (id) => document.getElementById(id);

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// Temperatures arrive in °F from the controller; the viewer may prefer °C.
const units = {
  c: store.get("unit", "F") === "C",
  toggle() { this.c = !this.c; store.set("unit", this.c ? "C" : "F"); },
  label() { return this.c ? "°C" : "°F"; },
  show(f, digits = 1) {
    if (f == null) return "--";
    return (this.c ? (f - 32) / 1.8 : f).toFixed(digits);
  },
};

const FAULTS = {
  NO_FLOW: "No water flow detected. The heater is locked out until the next heat request.",
  OVER_TEMP: "The heater's high-limit switch tripped. Heater locked out.",
  HEATER_UNKNOWN: "The heater has been on but the water isn't warming. Check the heater.",
  SENSOR_FAIL: "The water temperature probe isn't reporting. Heater locked out.",
};

// "Hold HEAT, 1:42:10 left" -> "Heating · 1:42:10 left"
function friendlyActivity(a) {
  if (!a) return "—";
  return a
    .replace(/^Hold HEAT/, "Heating")
    .replace(/^Hold PUMP_LOW/, "Pump on low")
    .replace(/^Hold PUMP_HIGH/, "Pump on high")
    .replace(/^Button HIGH/, "Jets high")
    .replace(/^Button LOW/, "Jets low")
    .replace(/^Hold ending/, "Finishing up")
    .replace(/^Keep warm at/, "Keeping warm at")
    .replace(/, /, " · ")
    .replace(/(\d+(?:\.\d+)?)°F/g, (_, f) => `${units.show(+f, 0)}${units.label()}`);
}

async function post(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    let msg = r.statusText;
    try { const j = await r.json(); msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail); } catch {}
    throw new Error(r.status === 503 ? "The tub controller is offline." : msg);
  }
  return r.json();
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast show" + (bad ? " bad" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = "toast"), 2600);
}

// Live state over server-sent events; the browser reconnects on its own.
function live(onState) {
  let es;
  const open = () => {
    es = new EventSource("/api/events");
    es.onmessage = (e) => onState(JSON.parse(e.data));
    es.onerror = () => onState(null);
  };
  open();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && es.readyState === EventSource.CLOSED) open();
  });
}

function setDot(s) {
  const dot = $("dot");
  const up = s && s.connected;
  dot.className = "dot " + (s == null ? "" : up ? "up" : "down");
  dot.title = s == null ? "Reconnecting…" : up ? "Connected to the tub" : "Tub controller offline";
  $("offline").hidden = !(s && !s.connected);
}
