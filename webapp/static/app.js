// Guest page: big temperature, heat to a target (timed or Keep), jets, quiet, stop.
"use strict";

const MIN_F = 60, MAX_F = 104;
let state = {};
let targetF = null;        // what the stepper shows (°F); null until first state
let targetTouched = false; // the viewer changed it, so don't overwrite from the tub
// Heat model from the web app's history (P °F/h heater gain, k /h loss rate).
let model = null;
async function loadModel() {
  try { const r = await fetch("/api/model"); if (r.ok) model = await r.json(); } catch {}
}
loadModel();
setInterval(loadModel, 10 * 60 * 1000);

// Hours to warm from t0 to t1 with the outside at out: dT/dt = P - k(T - out).
function hoursToReach(t0, t1, out) {
  if (!model || t0 == null || out == null) return null;
  const { P, k } = model;
  const a = P - k * (t0 - out), b = P - k * (t1 - out);
  if (b <= 0.2) return Infinity;           // losses would match the heater first
  return k > 0 ? Math.log(a / b) / k : (t1 - t0) / P;
}

// "ready ≈ 8:30 PM" (rounded to 5 min; weekday added if not today).
function readyText(hours) {
  if (hours === Infinity) return "may not reach target";
  const at = new Date(Date.now() + hours * 3600e3);
  at.setMinutes(Math.round(at.getMinutes() / 5) * 5, 0, 0);
  const sameDay = at.toDateString() === new Date().toDateString();
  const t = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `ready ≈ ${sameDay ? "" : at.toLocaleDateString(undefined, { weekday: "short" }) + " "}${t}`;
}

// Eco countdown: the controller reports it every ~10 s; tick it locally between.
let ecoLeft = 0, ecoAt = 0;

function heatingTarget(s) {
  if (s.active_hold === "HEAT") return s.target_temperature;
  if (s.keep_warm) return s.keep_warm_temperature;
  return null;
}

function render() {
  const s = state;
  const water = s.water_temperature;
  const U = units.label();
  $("water").textContent = units.show(water);
  $("outdoor").textContent = units.show(s.outdoor_temperature, 0);
  for (const id of ["waterUnit", "targetUnit", "outUnit"]) $(id).textContent = U;
  $("unit").textContent = U;

  const heating = !!s.ch3_heat;
  const goal = heatingTarget(s);
  if (!targetTouched) {
    const t = s.keep_warm ? s.keep_warm_temperature : s.target_temperature;
    if (t != null) targetF = t;
  }
  $("target").textContent = targetF == null ? "--" : units.show(targetF, units.c ? 1 : 0);

  // Ring: how close the water is to the heating goal, if there is one.
  const C = 2 * Math.PI * 88;
  let frac = 0;
  if (goal != null && water != null) frac = Math.max(0, Math.min(1, (water - MIN_F) / (goal - MIN_F)));
  $("arc").style.strokeDasharray = `${frac * C} ${C}`;
  $("ring").className = "ring" + (heating ? " heating" : goal != null ? " holding" : "");
  $("heroSub").textContent =
    goal == null ? "Water" : heating ? `heating to ${units.show(goal, 0)}${U}` : `holding ${units.show(goal, 0)}${U}`;
  renderEco();
  // Arrival time while heating toward a goal.
  const hrs = goal != null && (heating || s.heat_requested) && water != null && water < goal - 0.2
    ? hoursToReach(water, goal, s.outdoor_temperature) : null;
  $("eta").hidden = hrs == null;
  if (hrs != null) $("eta").textContent = readyText(hrs);

  $("activity").textContent = s.connected === false ? "Controller offline" : friendlyActivity(s.activity);
  $("chipPump").textContent = `Pump ${s.pump ? s.pump.toLowerCase() : "—"}`;
  $("chipPump").classList.toggle("lit", s.pump === "LOW" || s.pump === "HIGH");
  $("chipHeat").textContent = heating ? "Heater on" : "Heater off";
  $("chipHeat").classList.toggle("hot", heating);

  const f = s.fault && s.fault !== "NONE" ? s.fault : null;
  $("fault").hidden = !f;
  if (f) $("fault").textContent = FAULTS[f] || f;

  // Without Eco mode a set temperature holds until changed: say so, with a way out.
  const holding = s.keep_warm && !s.eco_mode;
  $("keepNote").hidden = !holding;
  if (holding) {
    $("keepNote").innerHTML =
      `Holding ${units.show(s.keep_warm_temperature, 0)}${U} until changed. ` +
      `<button class="link" id="keepOff">Back to eco</button>`;
    $("keepOff").onclick = () => run("Back to eco", () => post("/api/keep-warm", { enable: false }));
  }

  const jets = /^Button HIGH/.test(s.activity || "") ? "high" : /^Button LOW/.test(s.activity || "") ? "low" : "off";
  document.querySelectorAll("#jets button").forEach((b) => b.classList.toggle("on", b.dataset.level === jets));

  $("power").textContent = s.power__estimated_ != null
    ? `${(s.power__estimated_ / 1000).toFixed(1)} kW now · ${(s.energy_today ?? 0).toFixed(1)} kWh today` : "";
}

function hm(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

// Leaf + "eco in 3:42" (a set temperature is counting down) or "eco 85°F" (idle).
function renderEco() {
  const s = state;
  $("eco").hidden = !s.eco_mode;
  if (!s.eco_mode) return;
  const left = Math.max(0, ecoLeft - (Date.now() - ecoAt) / 1000);
  $("ecoText").textContent = s.keep_warm && left > 0
    ? `eco in ${hm(left)}`
    : `eco ${units.show(s.eco_temperature, 0)}${units.label()}`;
}
setInterval(() => { if (state.eco_mode && state.keep_warm) renderEco(); }, 1000);

function stepTarget(dir) {
  if (targetF == null) targetF = 100;
  // 1 °F steps, or 0.5 °C steps for °C viewers (sent to the tub in °F).
  if (units.c) {
    const c = Math.round(((targetF - 32) / 1.8) * 2) / 2 + dir * 0.5;
    targetF = Math.round((c * 1.8 + 32) * 2) / 2;
  } else {
    targetF = Math.round(targetF) + dir;
  }
  targetF = Math.max(MIN_F, Math.min(MAX_F, targetF));
  targetTouched = true;
  render();
}

async function run(label, fn) {
  try { await fn(); toast(label); } catch (e) { toast(e.message, true); }
}

$("up").onclick = () => stepTarget(+1);
$("down").onclick = () => stepTarget(-1);
$("unit").onclick = () => { units.toggle(); render(); chart.render(); };



$("heat").onclick = () => {
  const t = `${units.show(targetF, units.c ? 1 : 0)}${units.label()}`;
  run(state.eco_mode ? `Set to ${t} (eco later)` : `Holding ${t}`, async () => {
    await post("/api/keep-warm", { enable: true, target_f: targetF });
    targetTouched = false;
  });
};

document.querySelectorAll("#jets button").forEach((b) => {
  b.onclick = () => run(`Jets ${b.dataset.level}`, () => post("/api/jets", { level: b.dataset.level }));
});

$("quiet").onclick = () => run("Quiet for a while", () => post("/api/quiet"));
$("stop").onclick = () => {
  if (confirm("Stop heating, jets and Keep warm?")) run("Stopped", () => post("/api/stop"));
};

const chart = tempChart($("chart"), $("chartSvg"), $("tip"));

// Now / History tabs share the top of the page.
function showTab(hist) {
  $("panelNow").hidden = hist;
  $("panelHist").hidden = !hist;
  $("tabNow").classList.toggle("on", !hist);
  $("tabHist").classList.toggle("on", hist);
  $("tabNow").setAttribute("aria-selected", String(!hist));
  $("tabHist").setAttribute("aria-selected", String(hist));
  store.set("tab", hist ? "hist" : "now");
  if (hist) chart.load();
}
$("tabNow").onclick = () => showTab(false);
$("tabHist").onclick = () => showTab(true);
document.querySelectorAll("#range button").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll("#range button").forEach((x) => x.classList.toggle("on", x === b));
    chart.load(+b.dataset.h);
  };
});
showTab(store.get("tab", "now") === "hist");
setInterval(() => document.visibilityState === "visible" && !$("panelHist").hidden && chart.load(), 60000);

live((s) => {
  setDot(s);
  if (s) {
    if (s.eco_countdown !== state.eco_countdown || !ecoAt) { ecoLeft = s.eco_countdown || 0; ecoAt = Date.now(); }
    state = s;
    render();
  }
});
render();
