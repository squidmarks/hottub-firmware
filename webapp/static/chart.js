// Temperature history chart: water and outside on one temperature axis, the
// heating target as a dashed line, heater-on periods as bands. Hover / touch
// shows a crosshair and the values at that moment.
"use strict";

function tempChart(box, svg, tip) {
  const NS = "http://www.w3.org/2000/svg";
  const H = 170, M = { l: 34, r: 10, t: 10, b: 20 };
  let data = null, hours = 24;

  async function load(h) {
    if (h) hours = h;
    try {
      const r = await fetch(`/api/history?hours=${hours}`);
      if (r.ok) { data = await r.json(); render(); }
    } catch { /* keep the last chart */ }
  }

  const el = (name, attrs, parent = svg) => {
    const e = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    parent.appendChild(e);
    return e;
  };
  const conv = (f) => (f == null ? null : units.c ? (f - 32) / 1.8 : f);

  function render() {
    svg.innerHTML = "";
    tip.hidden = true;
    const W = box.clientWidth;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("height", H);
    const pts = (data && data.points) || [];
    if (pts.length < 2) {
      el("text", { x: W / 2, y: H / 2, "text-anchor": "middle", class: "empty" }).textContent =
        "Collecting data — check back in a few minutes.";
      return;
    }

    // Scales: time on x; one temperature axis, at least 10° tall.
    const x0 = data.start, x1 = data.end;
    const vals = pts.flatMap((p) => [p.water, p.outdoor, p.target]).filter((v) => v != null).map(conv);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const minSpan = units.c ? 6 : 10;
    if (hi - lo < minSpan) { const mid = (hi + lo) / 2; lo = mid - minSpan / 2; hi = mid + minSpan / 2; }
    const step = niceStep((hi - lo) / 4);
    lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
    const X = (t) => M.l + ((t - x0) / (x1 - x0)) * (W - M.l - M.r);
    const Y = (v) => M.t + (1 - (v - lo) / (hi - lo)) * (H - M.t - M.b);

    // Heater-on bands (merged runs of buckets).
    const bw = data.bucket_s;
    let run = null;
    const band = (a, b) => el("rect", { x: X(a), y: M.t, width: Math.max(1, X(b) - X(a)), height: H - M.t - M.b, class: "band" });
    for (const p of pts) {
      if (p.heater) { if (!run) run = [p.t, p.t + bw]; else run[1] = p.t + bw; }
      else if (run) { band(run[0], run[1]); run = null; }
    }
    if (run) band(run[0], run[1]);

    // Grid and y labels.
    for (let v = lo; v <= hi + 1e-9; v += step) {
      el("line", { x1: M.l, x2: W - M.r, y1: Y(v), y2: Y(v), class: "grid" });
      el("text", { x: M.l - 6, y: Y(v) + 4, "text-anchor": "end", class: "axis" }).textContent = `${Math.round(v)}°`;
    }
    // X labels.
    for (const t of timeTicks(x0, x1, hours)) {
      el("text", { x: X(t), y: H - 4, "text-anchor": "middle", class: "axis" }).textContent = fmtTick(t, hours);
    }

    // Lines, broken where there's no data.
    const path = (key, cls, stepped) => {
      let d = "", prev = null;
      for (const p of pts) {
        const v = conv(p[key]);
        const gap = prev && p.t - prev.t > bw * 3;
        if (v == null || gap) { if (v == null) { prev = null; continue; } }
        const xx = X(p.t + bw / 2), yy = Y(v);
        if (!prev || gap) d += `M${xx},${yy}`;
        else d += stepped ? `H${xx}V${yy}` : `L${xx},${yy}`;
        prev = p;
      }
      if (d) el("path", { d, class: cls });
    };
    path("target", "line target", true);
    path("outdoor", "line out", false);
    path("water", "line water", false);

    // Direct labels at the right end, nudged apart if they'd collide.
    const last = (k) => { for (let i = pts.length - 1; i >= 0; i--) if (pts[i][k] != null) return conv(pts[i][k]); return null; };
    const lw = last("water"), lo2 = last("outdoor");
    if (lw != null && lo2 != null) {
      let yw = Y(lw) - 6, yo = Y(lo2) - 6;
      if (Math.abs(yw - yo) < 12) { if (yw < yo) yo = yw + 12; else yw = yo + 12; }
      el("text", { x: W - M.r - 2, y: yw, "text-anchor": "end", class: "dl" }).textContent = "Water";
      el("text", { x: W - M.r - 2, y: yo, "text-anchor": "end", class: "dl" }).textContent = "Outside";
    }

    // Crosshair + tooltip.
    const cross = el("line", { y1: M.t, y2: H - M.b, class: "cross", visibility: "hidden" });
    const dots = ["water", "out"].map((c) => el("circle", { r: 4, class: `dot ${c}`, visibility: "hidden" }));
    const hit = el("rect", { x: M.l, y: 0, width: W - M.l - M.r, height: H, fill: "transparent" });
    const show = (ev) => {
      const r = svg.getBoundingClientRect();
      const px = (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left;
      const t = x0 + ((px - M.l) / (W - M.l - M.r)) * (x1 - x0);
      let best = pts[0];
      for (const p of pts) if (Math.abs(p.t + bw / 2 - t) < Math.abs(best.t + bw / 2 - t)) best = p;
      const bx = X(best.t + bw / 2);
      cross.setAttribute("x1", bx); cross.setAttribute("x2", bx); cross.setAttribute("visibility", "visible");
      [["water", 0], ["outdoor", 1]].forEach(([k, i]) => {
        const v = conv(best[k]);
        dots[i].setAttribute("visibility", v == null ? "hidden" : "visible");
        if (v != null) { dots[i].setAttribute("cx", bx); dots[i].setAttribute("cy", Y(v)); }
      });
      const U = units.label();
      const f = (v) => (v == null ? "—" : `${units.show(v)}${U}`);
      tip.innerHTML =
        `<div class="tt">${fmtTime(best.t, hours)}</div>` +
        `<div><i class="sw water"></i>Water <b>${f(best.water)}</b></div>` +
        `<div><i class="sw out"></i>Outside <b>${f(best.outdoor)}</b></div>` +
        (best.target != null ? `<div><i class="sw target"></i>Target <b>${f(best.target)}</b></div>` : "") +
        (best.heater ? `<div><i class="sw heat"></i>Heater on</div>` : "");
      tip.hidden = false;
      const tw = tip.offsetWidth;
      tip.style.left = `${Math.min(Math.max(bx - tw / 2, 0), W - tw)}px`;
    };
    const hide = () => {
      tip.hidden = true;
      cross.setAttribute("visibility", "hidden");
      dots.forEach((d) => d.setAttribute("visibility", "hidden"));
    };
    hit.addEventListener("pointermove", show);
    hit.addEventListener("pointerdown", show);
    hit.addEventListener("pointerleave", hide);
  }

  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * p) return m * p;
    return 10 * p;
  }
  function timeTicks(a, b, h) {
    const stepS = h <= 6 ? 3600 : h <= 24 ? 6 * 3600 : 86400;
    const out = [];
    const d = new Date(a * 1000);
    if (stepS === 86400) d.setHours(24, 0, 0, 0);
    else d.setMinutes(0, 0, 0), d.setHours(Math.ceil((d.getHours() + 0.01) / (stepS / 3600)) * (stepS / 3600));
    for (let t = d.getTime() / 1000; t < b; t += stepS) if (t > a) out.push(t);
    return out;
  }
  function fmtTick(t, h) {
    const d = new Date(t * 1000);
    return h > 24 ? d.toLocaleDateString(undefined, { weekday: "short" })
                  : d.toLocaleTimeString(undefined, { hour: "numeric" });
  }
  function fmtTime(t, h) {
    const d = new Date(t * 1000);
    return d.toLocaleString(undefined, h > 24
      ? { weekday: "short", hour: "numeric", minute: "2-digit" }
      : { hour: "numeric", minute: "2-digit" });
  }

  let rt;
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(render, 150); });
  return { load, render };
}
