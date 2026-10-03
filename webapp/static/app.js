// Guest page: big temperature, heat to a target, jets, quiet, stop.
"use strict";

const MIN_F = 60, MAX_F = 104;
let state = {};
let targetF = null;        // what the stepper shows (°F); null until first state
let targetTouched = false; // the viewer changed it, so don't overwrite from the tub
let minutes = 120;

function render() {
  const s = state;
  const water = s.water_temperature;
  $("water").textContent = units.show(water);
  $("waterUnit").textContent = $("targetUnit").textContent = units.label();
  $("unit").textContent = units.label();

  const heating = !!s.ch3_heat;
  const holdHeat = s.active_hold === "HEAT";
  if (!targetTouched && s.target_temperature != null) targetF = s.target_temperature;
  $("target").textContent = targetF == null ? "--" : units.show(targetF, units.c ? 1 : 0);

  // Ring: how close the water is to the target (when heating), else neutral.
  const arc = $("arc");
  const C = 2 * Math.PI * 88;
  let frac = 0;
  if (holdHeat && water != null && s.target_temperature) {
    frac = Math.max(0, Math.min(1, (water - MIN_F) / (s.target_temperature - MIN_F)));
  }
  arc.style.strokeDasharray = `${frac * C} ${C}`;
  $("ring").className = "ring" + (heating ? " heating" : holdHeat ? " holding" : "");
  $("heroSub").textContent = holdHeat && s.target_temperature != null
    ? `Water · heating to ${units.show(s.target_temperature, 0)}${units.label()}`
    : "Water";

  $("activity").textContent = s.connected === false ? "Controller offline" : friendlyActivity(s.activity);
  $("chipPump").textContent = `Pump ${s.pump ? s.pump.toLowerCase() : "—"}`;
  $("chipPump").classList.toggle("lit", s.pump === "LOW" || s.pump === "HIGH");
  $("chipHeat").textContent = heating ? "Heater on" : "Heater off";
  $("chipHeat").classList.toggle("hot", heating);
  $("chipOut").textContent = `Outside ${units.show(s.outdoor_temperature, 0)}${units.label()}`;

  const f = s.fault && s.fault !== "NONE" ? s.fault : null;
  $("fault").hidden = !f;
  if (f) $("fault").textContent = FAULTS[f] || f;

  // Jets: highlight the running session, if any.
  const jets = /^Button HIGH/.test(s.activity || "") ? "high" : /^Button LOW/.test(s.activity || "") ? "low" : "off";
  document.querySelectorAll("#jets button").forEach((b) => b.classList.toggle("on", b.dataset.level === jets));

  $("power").textContent = s.power__estimated_ != null
    ? `${(s.power__estimated_ / 1000).toFixed(1)} kW now · ${(s.energy_today ?? 0).toFixed(1)} kWh today` : "";
}

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
$("unit").onclick = () => { units.toggle(); render(); };

document.querySelectorAll("#duration button").forEach((b) => {
  b.onclick = () => {
    minutes = +b.dataset.min;
    document.querySelectorAll("#duration button").forEach((x) => x.classList.toggle("on", x === b));
  };
});

$("heat").onclick = () => run(
  `Heating to ${units.show(targetF, units.c ? 1 : 0)}${units.label()} for ${minutes / 60} h`,
  async () => { await post("/api/heat", { target_f: targetF, minutes }); targetTouched = false; },
);

document.querySelectorAll("#jets button").forEach((b) => {
  b.onclick = () => run(`Jets ${b.dataset.level}`, () => post("/api/jets", { level: b.dataset.level }));
});

$("quiet").onclick = () => run("Quiet for a while", () => post("/api/quiet"));
$("stop").onclick = () => {
  if (confirm("Stop heating and jets?")) run("Stopped", () => post("/api/stop"));
};

live((s) => {
  setDot(s);
  if (s) { state = s; render(); }
});
render();
