// Guest page: big temperature, heat to a target (timed or Keep), jets, quiet, stop.
"use strict";

const MIN_F = 60, MAX_F = 104;
let state = {};
let targetF = null;        // what the stepper shows (°F); null until first state
let targetTouched = false; // the viewer changed it, so don't overwrite from the tub
let minutes = 120;         // or "keep"

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
  $("heroSub").textContent = goal != null ? `to ${units.show(goal, 0)}${U}` : "Water";

  $("activity").textContent = s.connected === false ? "Controller offline" : friendlyActivity(s.activity);
  $("chipPump").textContent = `Pump ${s.pump ? s.pump.toLowerCase() : "—"}`;
  $("chipPump").classList.toggle("lit", s.pump === "LOW" || s.pump === "HIGH");
  $("chipHeat").textContent = heating ? "Heater on" : "Heater off";
  $("chipHeat").classList.toggle("hot", heating);

  const f = s.fault && s.fault !== "NONE" ? s.fault : null;
  $("fault").hidden = !f;
  if (f) $("fault").textContent = FAULTS[f] || f;

  // Heat button and the Keep warm note.
  const tShow = `${units.show(targetF, units.c ? 1 : 0)}${U}`;
  $("heat").textContent = minutes === "keep" ? `Keep at ${tShow}` : `Heat to ${tShow} · ${minutes / 60} h`;
  $("keepNote").hidden = !s.keep_warm;
  if (s.keep_warm) {
    $("keepNote").innerHTML =
      `Keeping warm at ${units.show(s.keep_warm_temperature, 0)}${U} until turned off. ` +
      `<button class="link" id="keepOff">Turn off</button>`;
    $("keepOff").onclick = () => run("Keep warm off", () => post("/api/keep-warm", { enable: false }));
  }

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
$("unit").onclick = () => { units.toggle(); render(); chart.render(); };

document.querySelectorAll("#duration button").forEach((b) => {
  b.onclick = () => {
    minutes = b.dataset.min === "keep" ? "keep" : +b.dataset.min;
    document.querySelectorAll("#duration button").forEach((x) => x.classList.toggle("on", x === b));
    render();
  };
});

$("heat").onclick = () => {
  const t = `${units.show(targetF, units.c ? 1 : 0)}${units.label()}`;
  if (minutes === "keep") {
    run(`Keeping warm at ${t}`, async () => {
      await post("/api/keep-warm", { enable: true, target_f: targetF });
      targetTouched = false;
    });
  } else {
    run(`Heating to ${t} for ${minutes / 60} h`, async () => {
      await post("/api/heat", { target_f: targetF, minutes });
      targetTouched = false;
    });
  }
};

document.querySelectorAll("#jets button").forEach((b) => {
  b.onclick = () => run(`Jets ${b.dataset.level}`, () => post("/api/jets", { level: b.dataset.level }));
});

$("quiet").onclick = () => run("Quiet for a while", () => post("/api/quiet"));
$("stop").onclick = () => {
  if (confirm("Stop heating, jets and Keep warm?")) run("Stopped", () => post("/api/stop"));
};

const chart = tempChart($("chart"), $("chartSvg"), $("tip"));
document.querySelectorAll("#range button").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll("#range button").forEach((x) => x.classList.toggle("on", x === b));
    chart.load(+b.dataset.h);
  };
});
chart.load(24);
setInterval(() => document.visibilityState === "visible" && chart.load(), 60000);

live((s) => {
  setDot(s);
  if (s) { state = s; render(); }
});
render();
