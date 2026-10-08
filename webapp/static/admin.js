// Admin page: controller settings and a live diagnostic table.
"use strict";

const LABELS = {
  eco_mode: ["Eco mode", "On: a set temperature falls back to eco after the period below. Off: it holds until changed."],
  eco_mode_after: ["Back to eco after", "restarts whenever someone sets a temperature"],
  eco_temperature: ["Eco temperature (°F)", "Held during filter cycles. 34 °F = frost protection only."],
  filter_cycle_after_no_flow_for: ["Filter cycle after no flow for", "hours"],
  filter_cycle_length: ["Filter cycle length", "minutes"],
  button_session_length: ["Jets session length", "minutes, for the tub button and the Jets control"],
  quiet_period: ["Quiet period", "minutes"],
  water_probe: ["Water probe", "the other probe is outdoor"],
  tub_button_type: ["Tub button type", ""],
  buzzer_enabled: ["Buzzer", "beeps for tub-button presses and faults"],
};
const ORDER = Object.keys(LABELS);

const DIAG = [
  ["Water", (s) => fmtT(s.water_temperature)],
  ["Outdoor", (s) => fmtT(s.outdoor_temperature)],
  ["Target", (s) => fmtT(s.target_temperature)],
  ["Activity", (s) => s.activity],
  ["Active hold", (s) => s.active_hold],
  ["Pump", (s) => s.pump],
  ["Fault", (s) => s.fault],
  ["Heat requested", (s) => onOff(s.heat_requested)],
  ["CH1 RUN", (s) => onOff(s.ch1_run)],
  ["CH2 SELECT (on = HIGH)", (s) => onOff(s.ch2_select__on___high_)],
  ["CH3 HEAT", (s) => onOff(s.ch3_heat)],
  ["DI1 flow", (s) => onOff(s.di1_flow)],
  ["DI2 hi-limit OK", (s) => onOff(s.di2_temp_ok)],
  ["DI3 tub button", (s) => onOff(s.di3_tub_button)],
  ["Power (estimated)", (s) => s.power__estimated_ == null ? "--" : `${Math.round(s.power__estimated_)} W`],
  ["Energy today", (s) => s.energy_today == null ? "--" : `${s.energy_today.toFixed(2)} kWh`],
  ["Energy total", (s) => s.energy_total == null ? "--" : `${s.energy_total.toFixed(1)} kWh`],
  ["Probe A (…5528)", (s) => fmtT(s.probe_a___5528_)],
  ["Probe B (…2928)", (s) => fmtT(s.probe_b___2928_)],
  ["1-Wire devices", (s) => s["1-wire_devices"]],
  ["Heat model", () => model
    ? `heater +${model.P.toFixed(1)} °F/h, loss ${model.k.toFixed(3)}/h per °F (${model.heat_windows} heating, ${model.cool_windows} cooling windows)`
    : "learning (needs a few hours of heating)"],
  ["Wi-Fi", (s) => s["wi-fi_rssi"] == null ? "--" : `${Math.round(s["wi-fi_rssi"])} dBm`],
  ["Uptime", (s) => s.uptime == null ? "--" : fmtDur(s.uptime)],
];

const fmtT = (f) => (f == null ? "--" : `${units.show(f)}${units.label()}`);
const onOff = (b) => (b == null ? "--" : b ? "on" : "off");
const fmtDur = (s) => {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};

let state = {};
let model = null;
(async () => { try { const r = await fetch("/api/model"); if (r.ok) model = await r.json(); } catch {} })();
let meta = {};
const editing = new Set(); // inputs with focus aren't overwritten by live updates

function buildSettings() {
  const box = $("settings");
  box.innerHTML = "";
  for (const id of ORDER) {
    const m = meta[id];
    if (!m) continue;
    const [label, hint] = LABELS[id];
    const row = document.createElement("label");
    row.className = "setting";
    row.innerHTML = `<span class="name">${label}${hint ? `<small>${hint}</small>` : ""}</span>`;
    let input;
    if (m.type === "number") {
      input = document.createElement("input");
      input.type = "number";
      input.inputMode = "decimal";
      Object.assign(input, { min: m.min, max: m.max, step: m.step });
      input.onfocus = () => editing.add(id);
      input.onblur = () => editing.delete(id);
      input.onchange = () => save(id, parseFloat(input.value));
    } else if (m.type === "select") {
      input = document.createElement("select");
      for (const o of m.options) input.add(new Option(o, o));
      input.onchange = () => save(id, input.value);
    } else {
      input = document.createElement("input");
      input.type = "checkbox";
      input.className = "toggle";
      input.onchange = () => save(id, input.checked);
    }
    input.id = "set-" + id;
    row.appendChild(input);
    box.appendChild(row);
  }
}

function render() {
  $("unit").textContent = units.label();
  for (const id of ORDER) {
    const el = $("set-" + id);
    if (!el || editing.has(id) || state[id] == null) continue;
    if (el.type === "checkbox") el.checked = !!state[id];
    else el.value = state[id];
  }
  $("diag").innerHTML = DIAG.map(([k, f]) => `<tr><th>${k}</th><td>${f(state) ?? "--"}</td></tr>`).join("");
}

async function save(id, value) {
  try {
    await post("/api/admin/setting", { id, value });
    toast(`${LABELS[id][0]} saved`);
  } catch (e) {
    toast(e.message, true);
    render();
  }
}

$("unit").onclick = () => { units.toggle(); render(); };
$("filterNow").onclick = async () => {
  try { await post("/api/admin/filter-now"); toast("Filter cycle starting"); }
  catch (e) { toast(e.message, true); }
};

(async () => {
  try {
    const r = await fetch("/api/admin/me");
    if (!r.ok) throw new Error(r.status === 403 ? "This account isn't an admin." : r.statusText);
    const me = await r.json();
    meta = me.settings;
    $("who").textContent = `Signed in as ${me.email}`;
    buildSettings();
  } catch (e) {
    $("who").textContent = e.message;
  }
  live((s) => { setDot(s); if (s) { state = s; render(); } });
})();
