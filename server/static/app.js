"use strict";

/* =====================================================================
   Environmental Monitoring Station - dashboard
   Talks to server.py:  GET /api/state, GET /api/history, SSE /api/stream
   ===================================================================== */

const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const COLORS = {
  temp: css("--temp"), hum: css("--hum"), light: css("--light"),
  ok: css("--ok"), bad: css("--bad"), muted: css("--muted"), line: css("--line"),
};

const METRICS = {
  temp:  { label: "Temperature", unit: "°C", color: COLORS.temp,  decimals: 1, limitKey: "temp_limit" },
  hum:   { label: "Humidity",    unit: "%",  color: COLORS.hum,   decimals: 0, limitKey: "hum_limit" },
  light: { label: "Light",       unit: "%",  color: COLORS.light, decimals: 0, limitKey: null },
};

const state = {
  history: [],
  latest: null,
  config: { temp_limit: 35, hum_limit: 80, muted: false },
  arduinoLimits: null,
  connection: { state: "starting", mode: "serial", port: null, detail: "" },
  alerts: [],
  stats: null,
  startedAt: null,
  clockOffset: 0,       // serverTime - clientTime (seconds)
  staleAfter: 8,
  sensorError: false,
  metric: "temp",
  range: 600,
  count: 0,
};

const serverNow = () => Date.now() / 1000 + state.clockOffset;
const fmt = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? "—" : Number(v).toFixed(d));
const timeStr = (t) => new Date((t - state.clockOffset) * 1000).toLocaleTimeString([], { hour12: false });

/* ---------------------------------------------------------------------
   Gauges (SVG, 240° sweep)
   --------------------------------------------------------------------- */
const SVG_NS = "http://www.w3.org/2000/svg";
const G = { cx: 100, cy: 100, r: 78, start: 150, sweep: 240 };

function polar(deg, r = G.r) {
  const a = (deg * Math.PI) / 180;
  return [G.cx + r * Math.cos(a), G.cy + r * Math.sin(a)];
}
function arcPath(r = G.r) {
  const [x1, y1] = polar(G.start, r);
  const [x2, y2] = polar(G.start + G.sweep, r);
  return `M ${x1} ${y1} A ${r} ${r} 0 1 1 ${x2} ${y2}`;
}
function el(tag, attrs, parent) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}

function makeGauge(container, { min, max, unit, color, decimals, ticks }) {
  const svg = el("svg", { viewBox: "0 0 200 165", role: "img" }, container);
  const defs = el("defs", {}, svg);
  const gid = "g" + Math.random().toString(36).slice(2, 8);
  const grad = el("linearGradient", { id: gid, x1: "0", y1: "1", x2: "1", y2: "0" }, defs);
  el("stop", { offset: "0%", "stop-color": color, "stop-opacity": ".55" }, grad);
  el("stop", { offset: "100%", "stop-color": color }, grad);

  el("path", { d: arcPath(), class: "track", fill: "none", "stroke-width": 14, "stroke-linecap": "round" }, svg);
  const length = 2 * Math.PI * G.r * (G.sweep / 360);
  const arc = el("path", {
    d: arcPath(), class: "arc", fill: "none", stroke: `url(#${gid})`, "stroke-width": 14,
    "stroke-linecap": "round", "stroke-dasharray": length, "stroke-dashoffset": length,
  }, svg);

  // scale ticks
  ticks.forEach((v, i) => {
    const deg = G.start + ((v - min) / (max - min)) * G.sweep;
    const [x1, y1] = polar(deg, G.r - 12);
    const [x2, y2] = polar(deg, G.r - 17);
    el("line", { x1, y1, x2, y2, stroke: "#2a3a57", "stroke-width": 2, "stroke-linecap": "round" }, svg);
    // only label the two ends so the numbers never collide with the big reading
    if (i === 0 || i === ticks.length - 1) {
      const [tx, ty] = polar(deg);
      const t = el("text", { x: tx, y: ty + 24, "text-anchor": "middle", class: "gauge-scale" }, svg);
      t.textContent = v + unit;
    }
  });

  const limitTick = el("line", { stroke: COLORS.bad, "stroke-width": 3, "stroke-linecap": "round", opacity: 0 }, svg);
  const limitLabel = el("text", { class: "gauge-limit-label", "text-anchor": "middle", opacity: 0 }, svg);
  const dot = el("circle", { r: 6, fill: "#fff", stroke: color, "stroke-width": 3, opacity: 0 }, svg);

  const val = el("text", { x: 100, y: 108, "text-anchor": "middle", class: "gauge-val" }, svg);
  val.textContent = "—";
  const u = el("text", { x: 100, y: 130, "text-anchor": "middle", class: "gauge-unit" }, svg);
  u.textContent = unit;

  const clamp = (v) => Math.max(min, Math.min(max, v));

  return {
    set(value, over) {
      if (value === null || value === undefined) {
        val.textContent = "—";
        arc.setAttribute("stroke-dashoffset", length);
        dot.setAttribute("opacity", 0);
        return;
      }
      const frac = (clamp(value) - min) / (max - min);
      arc.setAttribute("stroke-dashoffset", length * (1 - frac));
      arc.setAttribute("stroke", over ? COLORS.bad : `url(#${gid})`);
      const [x, y] = polar(G.start + frac * G.sweep);
      dot.setAttribute("cx", x);
      dot.setAttribute("cy", y);
      dot.setAttribute("stroke", over ? COLORS.bad : color);
      dot.setAttribute("opacity", 1);
      val.textContent = Number(value).toFixed(decimals);
      val.style.fill = over ? COLORS.bad : "";
    },
    setLimit(limit) {
      if (limit === null || limit === undefined) return;
      const deg = G.start + ((clamp(limit) - min) / (max - min)) * G.sweep;
      const [x1, y1] = polar(deg, G.r + 10);
      const [x2, y2] = polar(deg, G.r - 10);
      Object.entries({ x1, y1, x2, y2, opacity: 1 }).forEach(([k, v]) => limitTick.setAttribute(k, v));
      const [lx, ly] = polar(deg, G.r + 20);
      limitLabel.setAttribute("x", lx);
      limitLabel.setAttribute("y", ly + 3);
      limitLabel.setAttribute("opacity", 1);
      limitLabel.textContent = "LIMIT";
    },
  };
}

const gauges = {
  temp: makeGauge($("gauge-temp"), { min: 0, max: 50, unit: "°C", color: COLORS.temp, decimals: 1, ticks: [0, 10, 20, 30, 40, 50] }),
  hum:  makeGauge($("gauge-hum"),  { min: 0, max: 100, unit: "%", color: COLORS.hum, decimals: 0, ticks: [0, 20, 40, 60, 80, 100] }),
};

/* ---------------------------------------------------------------------
   Live chart (canvas)
   --------------------------------------------------------------------- */
const canvas = $("chart");
const ctx = canvas.getContext("2d");
const tip = $("chart-tip");
let hoverX = null;

function niceTicks(lo, hi, count = 5) {
  if (lo === hi) { lo -= 1; hi += 1; }
  const span = hi - lo;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const niceLo = Math.floor(lo / step) * step;
  const niceHi = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let v = niceLo; v <= niceHi + step / 2; v += step) ticks.push(+v.toFixed(6));
  return { lo: niceLo, hi: niceHi, ticks };
}

function drawChart() {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const pad = { l: 46, r: 14, t: 14, b: 26 };
  const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
  const now = serverNow();
  const t0 = now - state.range;
  const pts = state.history.filter((r) => r.t >= t0 - 4);
  $("chart-empty").hidden = pts.length > 0;

  const keys = state.metric === "all" ? ["temp", "hum", "light"] : [state.metric];
  const limitKey = state.metric !== "all" ? METRICS[state.metric].limitKey : null;
  const limit = limitKey ? state.config[limitKey] : null;

  // y-range
  let lo, hi;
  if (state.metric === "all") { lo = 0; hi = 100; }
  else {
    const vals = pts.map((r) => r[state.metric]);
    if (limit !== null) vals.push(limit);
    lo = vals.length ? Math.min(...vals) : 0;
    hi = vals.length ? Math.max(...vals) : 100;
    const padY = Math.max((hi - lo) * 0.15, 1);
    lo -= padY; hi += padY;
    if (state.metric !== "temp") { lo = Math.max(0, lo); hi = Math.min(100, hi); }
  }
  const nt = niceTicks(lo, hi, 5);
  lo = nt.lo; hi = nt.hi;

  const xOf = (t) => pad.l + ((t - t0) / state.range) * pw;
  const yOf = (v) => pad.t + ph - ((v - lo) / (hi - lo)) * ph;

  // grid + y labels
  ctx.font = "11px Segoe UI, system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  nt.ticks.forEach((v) => {
    const y = yOf(v);
    ctx.strokeStyle = "rgba(138,154,179,.12)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
    ctx.fillStyle = COLORS.muted;
    ctx.fillText(Number.isInteger(v) ? v : v.toFixed(1), pad.l - 8, y);
  });

  // x labels
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const xStep = state.range <= 120 ? 20 : state.range <= 600 ? 120 : 600;
  for (let t = Math.ceil(t0 / xStep) * xStep; t <= now; t += xStep) {
    const x = xOf(t);
    if (x < pad.l + 15 || x > W - pad.r - 15) continue;
    ctx.fillStyle = COLORS.muted;
    const d = new Date((t - state.clockOffset) * 1000);
    const label = state.range <= 120
      ? d.toLocaleTimeString([], { hour12: false, minute: "2-digit", second: "2-digit" })
      : d.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit" });
    ctx.fillText(label, x, H - pad.b + 8);
  }

  // limit line
  if (limit !== null && limit >= lo && limit <= hi) {
    const y = yOf(limit);
    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = COLORS.bad;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = COLORS.bad;
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.font = "600 11px Segoe UI, system-ui, sans-serif";
    ctx.fillText(`LIMIT ${limit}${METRICS[state.metric].unit}`, W - pad.r - 4, y - 4);
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(pad.l, pad.t - 4, pw, ph + 8);
  ctx.clip();

  // series
  keys.forEach((k) => {
    const color = METRICS[k].color;
    const segments = [];
    let seg = [];
    pts.forEach((r, i) => {
      if (i > 0 && r.t - pts[i - 1].t > 8) { segments.push(seg); seg = []; }
      seg.push([xOf(r.t), yOf(r[k])]);
    });
    if (seg.length) segments.push(seg);

    segments.forEach((s) => {
      if (keys.length === 1 && s.length > 1) {
        const g = ctx.createLinearGradient(0, pad.t, 0, pad.t + ph);
        g.addColorStop(0, color + "55");
        g.addColorStop(1, color + "00");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(s[0][0], pad.t + ph);
        s.forEach(([x, y]) => ctx.lineTo(x, y));
        ctx.lineTo(s[s.length - 1][0], pad.t + ph);
        ctx.closePath();
        ctx.fill();
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.2;
      ctx.lineJoin = "round";
      ctx.beginPath();
      s.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
    });

    // live point
    const last = pts[pts.length - 1];
    if (last) {
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(xOf(last.t), yOf(last[k]), 4, 0, Math.PI * 2); ctx.fill();
    }
  });
  ctx.restore();

  // hover crosshair + tooltip
  if (hoverX !== null && pts.length) {
    const tAtX = t0 + ((hoverX - pad.l) / pw) * state.range;
    let best = pts[0];
    for (const r of pts) if (Math.abs(r.t - tAtX) < Math.abs(best.t - tAtX)) best = r;
    const x = xOf(best.t);
    ctx.strokeStyle = "rgba(230,237,247,.35)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ph); ctx.stroke();
    keys.forEach((k) => {
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = METRICS[k].color;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, yOf(best[k]), 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    });
    const rows = ["temp", "hum", "light"].map((k) =>
      `<div class="tt-row"><i style="background:${METRICS[k].color}"></i>${METRICS[k].label}: <b>${fmt(best[k], METRICS[k].decimals)}${METRICS[k].unit}</b></div>`).join("");
    tip.innerHTML = `<div class="tt-time">${timeStr(best.t)}</div>${rows}`;
    tip.hidden = false;
    const minY = Math.min(...keys.map((k) => yOf(best[k])));
    tip.style.left = Math.max(90, Math.min(W - 90, x)) + "px";
    tip.style.top = Math.max(90, minY) + "px";
  } else {
    tip.hidden = true;
  }
}

canvas.addEventListener("mousemove", (e) => { hoverX = e.offsetX; drawChart(); });
canvas.addEventListener("mouseleave", () => { hoverX = null; drawChart(); });
canvas.addEventListener("touchmove", (e) => {
  const r = canvas.getBoundingClientRect();
  hoverX = e.touches[0].clientX - r.left; drawChart();
}, { passive: true });
canvas.addEventListener("touchend", () => { hoverX = null; drawChart(); });
window.addEventListener("resize", drawChart);

function renderLegend() {
  const keys = state.metric === "all" ? ["temp", "hum", "light"] : [state.metric];
  let html = keys.map((k) => `<span><i style="background:${METRICS[k].color}"></i>${METRICS[k].label} (${METRICS[k].unit})</span>`).join("");
  if (state.metric !== "all" && METRICS[state.metric].limitKey) html += `<span><i class="dashed"></i>Alert limit</span>`;
  $("legend").innerHTML = html;
}

function bindSeg(id, attr, key) {
  $(id).addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    $(id).querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
    state[key] = attr === "range" ? Number(b.dataset.range) : b.dataset.metric;
    renderLegend();
    drawChart();
  });
}
bindSeg("metric-seg", "metric", "metric");
bindSeg("range-seg", "range", "range");

/* ---------------------------------------------------------------------
   Rendering
   --------------------------------------------------------------------- */
function setTag(id, text, cls) {
  const t = $(id);
  t.textContent = text;
  t.className = "tag" + (cls ? " " + cls : "");
}

function isStale() {
  return !state.latest || serverNow() - state.latest.t > state.staleAfter;
}

function renderReading() {
  const r = state.latest;
  const { temp_limit: tl, hum_limit: hl } = state.config;
  gauges.temp.setLimit(tl);
  gauges.hum.setLimit(hl);

  if (!r) {
    gauges.temp.set(null); gauges.hum.set(null);
    return;
  }
  // follow the server's status (it applies hysteresis), not a raw comparison
  const hot = r.status === "HIGH_TEMP" || r.status === "HIGH_TEMP_HUM";
  const wet = r.status === "HIGH_HUM" || r.status === "HIGH_TEMP_HUM";
  gauges.temp.set(r.temp, hot);
  gauges.hum.set(r.hum, wet);

  setTag("temp-tag", hot ? "HIGH" : r.temp < 18 ? "Cold" : r.temp <= 27 ? "Comfortable" : "Warm", hot ? "bad" : r.temp <= 27 && r.temp >= 18 ? "ok" : "warn");
  setTag("hum-tag", wet ? "HIGH" : r.hum < 30 ? "Dry" : r.hum <= 60 ? "Comfortable" : "Humid", wet ? "bad" : r.hum <= 60 && r.hum >= 30 ? "ok" : "warn");

  $("light-val").textContent = fmt(r.light, 0);
  $("light-raw").textContent = r.light_raw;
  $("light-fill").style.width = Math.max(0, Math.min(100, r.light)) + "%";
  const lt = r.light < 10 ? "Dark" : r.light < 35 ? "Dim" : r.light < 70 ? "Indoor" : "Bright";
  setTag("light-tag", lt, "");
}

function renderStats() {
  const s = state.stats;
  ["temp", "hum", "light"].forEach((k) => {
    const d = METRICS[k].decimals;
    const u = k === "temp" ? "°" : "%";
    const m = s && s[k];
    $(`${k}-min`).textContent = m && m.min !== null ? fmt(m.min, d) + u : "—";
    $(`${k}-avg`).textContent = m && m.avg !== null ? fmt(m.avg, d) + u : "—";
    $(`${k}-max`).textContent = m && m.max !== null ? fmt(m.max, d) + u : "—";
  });
}

const BANNERS = {
  NORMAL:        { cls: "banner-ok",  icon: "✅", title: "NORMAL", sub: () => "All readings are within safe limits" },
  HIGH_TEMP:     { cls: "banner-bad", icon: "🔥", title: "HIGH TEMPERATURE WARNING", sub: (r) => `Temperature ${fmt(r.temp)} °C is above the ${state.config.temp_limit} °C limit` },
  HIGH_HUM:      { cls: "banner-bad", icon: "💧", title: "HIGH HUMIDITY WARNING", sub: (r) => `Humidity ${fmt(r.hum, 0)} % is above the ${state.config.hum_limit} % limit` },
  HIGH_TEMP_HUM: { cls: "banner-bad", icon: "🚨", title: "HIGH TEMPERATURE & HUMIDITY", sub: (r) => `${fmt(r.temp)} °C and ${fmt(r.hum, 0)} % are both above their limits` },
};

function renderBanner() {
  const b = $("banner");
  const r = state.latest;
  let cls, icon, title, sub;
  const conn = state.connection.state;

  if (conn !== "connected") {
    cls = "banner-wait"; icon = "🔌";
    title = conn === "searching" ? "ARDUINO NOT FOUND" : conn === "disconnected" || conn === "error" ? "ARDUINO DISCONNECTED" : "CONNECTING…";
    sub = state.connection.detail || "Plug the Arduino into this laptop's USB port";
  } else if (state.sensorError && isStale()) {
    cls = "banner-wait"; icon = "⚠️"; title = "SENSOR ERROR"; sub = "The DHT11 is not responding. Check the wire on D2, 5V and GND.";
  } else if (!r || isStale()) {
    cls = "banner-wait"; icon = "⏳"; title = "WAITING FOR DATA"; sub = "Connected. Waiting for the first reading…";
  } else {
    const def = BANNERS[r.status] || BANNERS.NORMAL;
    cls = def.cls; icon = def.icon; title = def.title; sub = def.sub(r);
  }
  b.className = "banner " + cls;
  $("banner-icon").textContent = icon;
  $("banner-title").textContent = title;
  $("banner-sub").textContent = sub;
  $("banner-limits").innerHTML = `Temp limit <b>${state.config.temp_limit} °C</b><br>Humidity limit <b>${state.config.hum_limit} %</b>`;

  const alerting = cls === "banner-bad";
  document.title = alerting ? "⚠ ALERT · Env Monitor" : "Environmental Monitoring Station";
}

function renderConnection() {
  const c = state.connection;
  const pill = $("conn");
  let cls, text;
  if (c.state === "connected" && c.mode === "demo") { cls = "pill-demo"; text = "Demo mode (simulated)"; }
  else if (c.state === "connected" && isStale() && state.latest) { cls = "pill-wait"; text = `No data · ${c.port}`; }
  else if (c.state === "connected") { cls = "pill-ok"; text = `Arduino connected · ${c.port}`; }
  else if (c.state === "searching") { cls = "pill-wait"; text = "Searching for Arduino…"; }
  else if (c.state === "connecting") { cls = "pill-wait"; text = `Connecting · ${c.port}`; }
  else if (c.state === "starting") { cls = "pill-wait"; text = "Starting…"; }
  else { cls = "pill-bad"; text = "Arduino disconnected"; }
  pill.className = "pill " + cls;
  $("conn-text").textContent = text;
  $("s-source").textContent = c.mode === "demo" ? "Demo data" : c.port || "—";
  $("s-detail").textContent = c.detail || "";
}

function renderLimits() {
  const c = state.config;
  if (document.activeElement !== $("in-temp")) $("in-temp").value = c.temp_limit;
  if (document.activeElement !== $("in-hum")) $("in-hum").value = c.hum_limit;
  $("mute").checked = !!c.muted;
  const a = state.arduinoLimits;
  if (!a) setTag("sync-tag", "Not synced", "warn");
  else if (Math.abs(a.temp_limit - c.temp_limit) < 0.05 && Math.abs(a.hum_limit - c.hum_limit) < 0.05) setTag("sync-tag", "Synced ✓", "ok");
  else setTag("sync-tag", "Syncing…", "warn");
}

function renderAlerts() {
  const list = $("alert-log");
  const n = state.alerts.filter((a) => a.level === "alert").length;
  setTag("alert-count", `${n} alert${n === 1 ? "" : "s"}`, n ? "bad" : "");
  if (!state.alerts.length) {
    list.innerHTML = `<li class="empty muted">No alerts yet</li>`;
    return;
  }
  list.innerHTML = state.alerts.slice().reverse().map((a) =>
    `<li class="${a.level}"><time>${timeStr(a.t)}</time><span>${escapeHtml(a.message)}</span></li>`).join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderAll() {
  renderReading();
  renderStats();
  renderBanner();
  renderConnection();
  renderLimits();
  renderAlerts();
  renderLegend();
  $("s-count").textContent = state.count;
  drawChart();
}

/* ---------------------------------------------------------------------
   Browser beep (optional)
   --------------------------------------------------------------------- */
let audioCtx = null;
function beep() {
  if (!$("browser-sound").checked) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = "square";
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.06, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.25);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.25);
  } catch (_) { /* audio not available */ }
}
try { $("browser-sound").checked = localStorage.getItem("envmon-sound") === "1"; } catch (_) {}
$("browser-sound").addEventListener("change", (e) => {
  try { localStorage.setItem("envmon-sound", e.target.checked ? "1" : "0"); } catch (_) {}
  if (e.target.checked) { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); beep(); }
});

/* ---------------------------------------------------------------------
   Controls
   --------------------------------------------------------------------- */
async function post(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

$("limits-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("limits-msg");
  try {
    state.config = await post("/api/limits", { temp_limit: Number($("in-temp").value), hum_limit: Number($("in-hum").value) });
    msg.textContent = "Saved — sent to the Arduino";
    msg.className = "form-msg ok";
    document.activeElement.blur();
    renderAll();
  } catch (err) {
    msg.textContent = err.message;
    msg.className = "form-msg bad";
  }
  setTimeout(() => { msg.textContent = ""; }, 3500);
});

$("mute").addEventListener("change", async (e) => {
  try { state.config = await post("/api/mute", { muted: e.target.checked }); renderLimits(); }
  catch (_) { e.target.checked = !e.target.checked; }
});

$("clear-btn").addEventListener("click", async () => {
  if (!confirm("Reset the graph, stats and alert log for this session?\n(CSV log files on disk are kept.)")) return;
  await post("/api/clear");
});

/* ---------------------------------------------------------------------
   Data loading + live stream
   --------------------------------------------------------------------- */
async function loadAll() {
  const [snap, hist] = await Promise.all([
    fetch("/api/state").then((r) => r.json()),
    fetch("/api/history?seconds=3600").then((r) => r.json()),
  ]);
  state.clockOffset = snap.server_time - Date.now() / 1000;
  state.latest = snap.latest;
  state.config = snap.config;
  state.arduinoLimits = snap.arduino_limits;
  state.connection = snap.connection;
  state.alerts = snap.alerts;
  state.stats = snap.stats;
  state.startedAt = snap.started_at;
  state.staleAfter = snap.stale_after;
  state.sensorError = snap.sensor_error;
  state.count = snap.count;
  state.history = hist;
  renderAll();
}

function connectStream() {
  const es = new EventSource("/api/stream");
  es.onopen = () => loadAll().catch(() => {});
  es.onerror = () => {
    state.connection = { ...state.connection, state: "error", detail: "Lost contact with the laptop server (is server.py still running?)" };
    renderConnection();
    renderBanner();
  };

  es.addEventListener("reading", (e) => {
    const r = JSON.parse(e.data);
    state.stats = r.stats;
    delete r.stats;
    const wasAlert = state.latest && state.latest.status !== "NORMAL";
    state.latest = r;
    state.sensorError = false;
    state.count += 1;
    state.history.push(r);
    if (state.history.length > 3600) state.history.splice(0, state.history.length - 3600);
    renderReading();
    renderStats();
    renderBanner();
    renderConnection();
    $("s-count").textContent = state.count;
    drawChart();
    if (r.status !== "NORMAL") beep();
    else if (wasAlert) { /* recovered */ }
  });
  es.addEventListener("connection", (e) => { state.connection = JSON.parse(e.data); renderConnection(); renderBanner(); });
  es.addEventListener("config", (e) => { state.config = JSON.parse(e.data); renderLimits(); renderReading(); renderBanner(); drawChart(); });
  es.addEventListener("arduino_limits", (e) => { state.arduinoLimits = JSON.parse(e.data); renderLimits(); });
  es.addEventListener("alert", (e) => { state.alerts.push(JSON.parse(e.data)); if (state.alerts.length > 100) state.alerts.shift(); renderAlerts(); });
  es.addEventListener("sensor_error", () => { state.sensorError = true; renderBanner(); });
  es.addEventListener("cleared", () => loadAll().catch(() => {}));
}

/* ---------------------------------------------------------------------
   Clock / uptime ticker
   --------------------------------------------------------------------- */
function fmtDuration(s) {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
}

setInterval(() => {
  $("clock-time").textContent = new Date().toLocaleTimeString([], { hour12: false });
  if (state.startedAt) $("s-uptime").textContent = fmtDuration(serverNow() - state.startedAt);
  if (state.latest) {
    const ago = serverNow() - state.latest.t;
    $("last-update").textContent = ago < 2 ? "updated just now" : `updated ${fmtDuration(ago)} ago`;
  }
  // keep stale-detection and the scrolling chart current between readings
  renderConnection();
  renderBanner();
  drawChart();
}, 1000);

renderAll();
connectStream();
