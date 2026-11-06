import { DURATION, SCENARIOS, START, STRATEGIES, clamp, compareStrategies, decodeConfig, encodeConfig, makeConfig, simulate } from "./rollout.js";

const $ = (id) => document.getElementById(id);
const form = $("form");
const SVG_NS = "http://www.w3.org/2000/svg";

let cfg = decodeConfig(location.hash);
let all = null; // results per strategy for the current scenario
let res = null; // the selected strategy's result
let scenarioBlast = {};

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

function svg(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

const num = (n) => Math.round(n).toLocaleString("en-US");
const pct = (x, d = 1) => `${(x * 100).toFixed(d)}%`;
const mins = (m) => (m == null ? "n/a" : m === 0 ? "under 1 min" : `${m} min`);
const rel = (t) => t - START; // minutes since the rollout started
const isLatency = () => SCENARIOS[cfg.scenario].latencyFactor > 1;
const blastLabel = () => (isLatency() ? "Slowed requests" : "Users hit");

// Event kinds grouped into the four marker colors.
const KIND = { start: "step", step: "step", switch: "step", complete: "step", scale: "step", pass: "pass", alert: "bad", fail: "bad", rollback: "rollback", done: "rollback" };

// ---------------------------------------------------------------------------
// Form

function fillForm() {
  for (const f of form.elements) if (f.name && f.name in cfg) f.value = cfg[f.name];
  $("scenarios").replaceChildren(...Object.entries(SCENARIOS).map(([id, s]) => el("button", {
    type: "button", class: "preset", "data-scenario": id, "aria-pressed": String(cfg.scenario === id),
  }, [el("span", { text: s.label }), el("small", { "data-blast": id })])));
  $("scenario-note").textContent = SCENARIOS[cfg.scenario].note;
  $("strategies").replaceChildren(...Object.entries(STRATEGIES).map(([id, s]) => el("button", {
    type: "button", class: "tab", role: "tab", "aria-selected": String(cfg.strategy === id), "data-strategy": id, text: s.label,
  })));
  $("strategy-note").textContent = STRATEGIES[cfg.strategy].note;
}

form.addEventListener("input", (e) => {
  const f = e.target;
  if (!f.name) return;
  if (f.name !== "steps") {
    const v = Number(f.value);
    if (f.value === "" || !Number.isFinite(v) || v < 0) return;
  }
  cfg = clamp({ ...cfg, [f.name]: f.value });
  schedule();
});
form.addEventListener("change", () => { // show clamped values once editing ends
  for (const f of form.elements) if (f.name && f.name in cfg) f.value = cfg[f.name];
});

$("scenarios").addEventListener("click", (e) => {
  const b = e.target.closest("[data-scenario]");
  if (!b) return;
  cfg = { ...cfg, scenario: b.dataset.scenario };
  fillForm();
  update();
});

function selectStrategy(id) {
  cfg = { ...cfg, strategy: id };
  fillForm();
  res = all[id];
  paintSelected();
}

$("strategies").addEventListener("click", (e) => {
  const b = e.target.closest("[data-strategy]");
  if (b) selectStrategy(b.dataset.strategy);
});

$("rows").addEventListener("click", (e) => {
  const tr = e.target.closest("[data-strategy]");
  if (tr) selectStrategy(tr.dataset.strategy);
});

let timer = 0;
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(update, 120);
}

// ---------------------------------------------------------------------------
// Results

function update() {
  all = compareStrategies(cfg);
  res = all[cfg.strategy];
  scenarioBlast = {};
  for (const id of Object.keys(SCENARIOS)) {
    scenarioBlast[id] = id === cfg.scenario ? res : simulate({ ...cfg, scenario: id });
  }
  drawTable();
  paintSelected();
}

function paintSelected() {
  for (const b of document.querySelectorAll("[data-blast]")) {
    const r = scenarioBlast[b.dataset.blast];
    if (!r) continue;
    const lat = SCENARIOS[b.dataset.blast].latencyFactor > 1;
    b.textContent = r.cfg.scenario === "healthy"
      ? (r.rolledBack ? "Rolled back by mistake" : `Done in ${r.rolloutMin} min`)
      : `${num(r.blast)} ${lat ? "slowed" : "users hit"} with ${STRATEGIES[cfg.strategy].short}`;
  }
  for (const tr of $("rows").children) tr.classList.toggle("selected", tr.dataset.strategy === cfg.strategy);
  drawCards();
  drawCharts();
  drawTimeline();
  history.replaceState(null, "", `#${encodeConfig(cfg)}`);
}

function card(labelText, value, sub, cls = "") {
  return el("div", { class: "card" }, [
    el("span", { class: "card-label", text: labelText }),
    el("span", { class: `card-total ${cls}`, text: value }),
    el("span", { class: "card-sub", text: sub }),
  ]);
}

function drawCards() {
  const r = res, healthy = cfg.scenario === "healthy";
  const best = Math.min(...Object.values(all).map((x) => x.blast));
  const cards = [];
  if (healthy) {
    cards.push(card("Rollout time", r.rolloutMin == null ? "n/a" : `${r.rolloutMin} min`, "From start until v2 takes all traffic and the rollout is marked done"));
    cards.push(card("False alarm", r.rolledBack ? "Yes" : "No", r.rolledBack ? "A healthy release was rolled back" : "No alert fired and no analysis failed", r.rolledBack ? "bad" : "good"));
  } else {
    cards.push(card(blastLabel(), num(r.blast), isLatency() ? "Requests served by the slower v2" : "Requests that failed because of the bug", r.blast === best ? "good" : r.blast > best * 5 ? "bad" : ""));
    cards.push(card("Detected after", mins(r.detectMin), r.detectAt == null ? "Never detected in this run" : detectedBy(r)));
  }
  if (!healthy) cards.push(card("Rollback took", mins(r.rollbackMechMin), r.rollbackMechMin == null ? "No rollback in this run" : `From the decision until v2 had no traffic. ${r.rollbackAt - r.detectAt > 0 ? `Plus ${r.rollbackAt - r.detectAt} min before someone acted.` : "Started automatically."}`));
  cards.push(card("Peak capacity", `${r.peakCapacity.toFixed(1)}x`, `${num(r.extraPodHours * 10) / 10} extra pod-hours over the run`, r.peakCapacity >= 2 ? "bad" : ""));
  if (healthy) cards.push(card("Downtime", r.downtimeMin ? `${r.downtimeMin} min` : "None", r.downtimeMin ? `${num(r.outage)} requests had no pod to serve them` : "Some pods served traffic every minute", r.downtimeMin ? "bad" : "good"));
  $("cards").replaceChildren(...cards);
}

function detectedBy(r) {
  const fail = r.events.find((e) => e.kind === "fail");
  if (fail && fail.t === r.detectAt) return "By automated analysis, from the first user exposed to the bug";
  return "By the service alert, from the first user exposed to the bug";
}

function drawTable() {
  const rows = Object.entries(all);
  const healthy = cfg.scenario === "healthy";
  const minOf = (f) => Math.min(...rows.map(([, r]) => f(r)).filter((x) => x != null));
  const bestBlast = minOf((r) => r.blast), bestRoll = minOf((r) => r.healthyRolloutMin), bestPods = minOf((r) => r.extraPodHours);
  $("blast-head").textContent = blastLabel();
  $("rows").replaceChildren(...rows.map(([id, r]) => el("tr", { "data-strategy": id }, [
    el("td", { text: STRATEGIES[id].label }),
    el("td", { class: `num${!healthy && r.blast === bestBlast ? " good" : ""}`, text: healthy ? "n/a" : num(r.blast) }),
    el("td", { class: "num", text: healthy ? (r.rolledBack ? "false alarm" : "n/a") : mins(r.detectMin) }),
    el("td", { class: "num", text: healthy ? "n/a" : mins(r.rollbackMechMin) }),
    el("td", { class: `num${r.healthyRolloutMin === bestRoll ? " good" : ""}`, text: r.healthyRolloutMin == null ? "n/a" : `${r.healthyRolloutMin} min` }),
    el("td", { class: `num${r.peakCapacity >= 2 ? " bad" : ""}`, text: `${r.peakCapacity.toFixed(1)}x` }),
    el("td", { class: `num${r.extraPodHours === bestPods ? " good" : ""}`, text: (Math.round(r.extraPodHours * 10) / 10).toFixed(1) }),
    el("td", { class: `num${r.downtimeMin ? " bad" : ""}`, text: r.downtimeMin ? `${r.downtimeMin} min` : "none" }),
  ])));
  $("note").textContent = tableNote();
}

function tableNote() {
  const a = all, short = (id) => STRATEGIES[id].short;
  const human = `Manual rollbacks start ${cfg.humanMin} min after the alert.`;
  if (cfg.scenario === "healthy") {
    const fa = Object.keys(a).filter((id) => a[id].rolledBack);
    return `Nothing should roll back here. ${fa.length ? `${fa.map(short).join(", ")} rolled back a healthy release: a false alarm.` : "None did."} Canary rollouts take longest because every step waits out its bake time. Blue-green holds a second full stack while blue is kept.`;
  }
  const order = Object.keys(a).sort((x, y) => a[x].blast - a[y].blast);
  const best = order[0], worst = order[order.length - 1];
  const parts = [`${short(best)} exposed the fewest (${num(a[best].blast)}), ${short(worst)} the most (${num(a[worst].blast)}).`];
  if (cfg.scenario === "leak") parts.push(`The leak shows ${SCENARIOS.leak.onsetMin} min after v2 starts. A strategy that finishes before then has nothing left to compare against, so bake time decides who catches it.`);
  if (cfg.scenario === "latency") parts.push("Errors never move, so only a latency check or a p99 alert can catch this.");
  if (cfg.scenario === "segment") parts.push("Overall v2 errors are only about 1.8%, so the service alert fires only once v2 has about half the traffic.");
  parts.push(human);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Charts: traffic share (stacked area) and error rate per version, one time axis.

const CW = 800, PAD = { l: 44, r: 10, b: 22 };
const xOf = (t) => PAD.l + (t / DURATION) * (CW - PAD.l - PAD.r);
const H = { "c-share": 196, "c-errors": 190 };
const TOP = { "c-share": 44, "c-errors": 10 };

function axes(nodes, h, top) {
  for (let t = 0; t <= DURATION; t += 10) {
    nodes.push(svg("text", { x: xOf(t), y: h - 6, class: "tick", "text-anchor": "middle" }, `${rel(t)}`));
  }
  nodes.push(svg("line", { x1: xOf(START), x2: xOf(START), y1: top, y2: h - PAD.b, class: "start-line" }));
}

const LABELS = { fail: "analysis failed", alert: "alert", rollback: "rollback", done: "back on v1", switch: "switch", complete: "done" };
const PRIORITY = ["fail", "alert", "rollback", "done", "switch", "complete"];

function markers(nodes, h, top, withLabels) {
  for (const e of res.events) {
    const k = KIND[e.kind] ?? "step", x = xOf(e.t);
    nodes.push(svg("line", { x1: x, x2: x, y1: top, y2: h - PAD.b, class: `ev ${k}` }));
    if (withLabels) nodes.push(svg("path", { d: `M${x - 5},${top - 9} L${x + 5},${top - 9} L${x},${top - 1} Z`, class: `tri ${k}` }));
  }
  if (!withLabels) return;
  // One label per minute (the most important event), on two rows so neighbors do not collide.
  const byMinute = new Map();
  for (const e of res.events) {
    if (!LABELS[e.kind]) continue;
    const cur = byMinute.get(e.t);
    if (!cur || PRIORITY.indexOf(e.kind) < PRIORITY.indexOf(cur.kind)) byMinute.set(e.t, e);
  }
  const rowEnd = [-Infinity, -Infinity];
  for (const e of [...byMinute.values()].sort((a, b) => a.t - b.t)) {
    const text = LABELS[e.kind], x = xOf(e.t), w = text.length * 6 + 8;
    const right = x + w > CW;
    const x0 = right ? x - w : x - 3;
    const row = x0 > rowEnd[0] ? 0 : x0 > rowEnd[1] ? 1 : -1;
    if (row < 0) continue;
    rowEnd[row] = x0 + w;
    nodes.push(svg("text", { x: right ? x : x - 3, y: top - 13 - row * 13, "text-anchor": right ? "end" : "start", class: `ev-label ${KIND[e.kind]}` }, text));
  }
}

function drawShare() {
  const chart = $("c-share"), h = H["c-share"];
  chart.setAttribute("viewBox", `0 0 ${CW} ${h}`);
  const top = TOP["c-share"];
  const y = (v) => top + (1 - v) * (h - top - PAD.b);
  const nodes = [];
  for (const v of [0, 0.5, 1]) {
    nodes.push(svg("line", { x1: PAD.l, x2: CW - PAD.r, y1: y(v), y2: y(v), class: "grid" }));
    nodes.push(svg("text", { x: PAD.l - 6, y: y(v) + 4, class: "tick", "text-anchor": "end" }, `${v * 100}%`));
  }
  // Step shapes: each minute is a flat segment.
  const v1 = [], v2 = [], out = [];
  for (const m of res.minutes) {
    const o = m.outage ? 1 : 0, w2 = o ? 0 : m.w2;
    for (const t of [m.t, m.t + 1]) { v2.push([xOf(t), y(w2)]); v1.push([xOf(t), y(w2 + (1 - w2 - o))]); out.push([xOf(t), y(o ? 1 : 0)]); }
  }
  const band = (top, bottom) => `M${top.map((p) => p.join(",")).join(" L")} L${bottom.slice().reverse().map((p) => p.join(",")).join(" L")} Z`;
  const base = v2.map(([x]) => [x, y(0)]);
  nodes.push(svg("path", { d: band(v2, base), class: "a-v2" }));
  nodes.push(svg("path", { d: band(v1, v2), class: "a-v1" }));
  if (res.downtimeMin) nodes.push(svg("path", { d: band(out, base), class: "a-out" }));
  axes(nodes, h, top);
  markers(nodes, h, top, true);
  chart.replaceChildren(...nodes);
}

function niceMax(v) {
  for (const s of [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1]) if (v <= s) return s;
  return 1;
}

function drawErrors() {
  const chart = $("c-errors"), h = H["c-errors"];
  chart.setAttribute("viewBox", `0 0 ${CW} ${h}`);
  const r1 = res.minutes.map((m) => (m.n1 >= 20 ? m.e1 / m.n1 : null));
  const r2 = res.minutes.map((m) => (m.n2 >= 20 ? m.e2 / m.n2 : null));
  const max = niceMax(Math.max(cfg.alertErrorPct / 100 * 1.4, ...r1.filter((x) => x != null), ...r2.filter((x) => x != null)));
  const top = TOP["c-errors"];
  const y = (v) => top + (1 - Math.min(v, max) / max) * (h - top - PAD.b);
  const nodes = [];
  for (const v of [0, max / 2, max]) {
    nodes.push(svg("line", { x1: PAD.l, x2: CW - PAD.r, y1: y(v), y2: y(v), class: "grid" }));
    nodes.push(svg("text", { x: PAD.l - 6, y: y(v) + 4, class: "tick", "text-anchor": "end" }, pct(v, v < 0.1 && v > 0 ? 1 : 0)));
  }
  axes(nodes, h, top);
  markers(nodes, h, top, false);
  nodes.push(svg("line", { x1: PAD.l, x2: CW - PAD.r, y1: y(cfg.alertErrorPct / 100), y2: y(cfg.alertErrorPct / 100), class: "threshold" }));
  // Polylines with gaps where a version had too little traffic to measure.
  for (const [vals, cls] of [[r1, "l-v1"], [r2, "l-v2"]]) {
    let run = [];
    const flush = () => { if (run.length > 1) nodes.push(svg("polyline", { points: run.join(" "), class: cls })); else if (run.length === 1) nodes.push(svg("circle", { cx: run[0].split(",")[0], cy: run[0].split(",")[1], r: 1.8, class: cls })); run = []; };
    vals.forEach((v, t) => { if (v == null) flush(); else run.push(`${xOf(t + 0.5).toFixed(1)},${y(v).toFixed(1)}`); });
    flush();
  }
  chart.replaceChildren(...nodes);
}

function drawCharts() {
  drawShare();
  drawErrors();
}

function drawTimeline() {
  $("timeline").replaceChildren(...res.events.map((e) => el("li", {}, [
    el("span", { class: "when", text: `${rel(e.t) >= 0 ? "+" : ""}${rel(e.t)} min` }),
    el("i", { class: `mark m-${KIND[e.kind] ?? "step"}` }),
    el("span", { text: e.text }),
  ])));
}

// Shared hover: one crosshair on both charts, a tooltip on the hovered one.
function tipRows(m) {
  const rows = [];
  if (m.outage) rows.push(["No pods serving", `${num(m.outage)} requests failed`]);
  else rows.push(["Traffic on v2", pct(m.w2, m.w2 > 0 && m.w2 < 0.1 ? 1 : 0)]);
  rows.push(["v1 requests", `${num(m.n1)}, ${m.n1 ? pct(m.e1 / m.n1, 2) : "n/a"} errors`]);
  rows.push(["v2 requests", `${num(m.n2)}, ${m.n2 ? pct(m.e2 / m.n2, 2) : "n/a"} errors`]);
  if (m.bug) rows.push(["Failed by the bug", num(m.bug)]);
  if (m.p99) rows.push(["Service p99", `${Math.round(m.p99)} ms`]);
  rows.push(["Pods v1 / v2", `${m.pods1} / ${m.pods2}`]);
  return rows;
}

for (const chart of document.querySelectorAll(".chart")) {
  const tip = chart.nextElementSibling;
  chart.addEventListener("pointermove", (e) => {
    if (!res) return;
    const box = chart.getBoundingClientRect();
    const sx = ((e.clientX - box.left) / box.width) * CW;
    const t = Math.floor(((sx - PAD.l) / (CW - PAD.l - PAD.r)) * DURATION);
    if (t < 0 || t >= DURATION) return;
    for (const c of document.querySelectorAll(".chart")) {
      c.querySelector(".crosshair")?.remove();
      c.append(svg("line", { x1: xOf(t + 0.5), x2: xOf(t + 0.5), y1: TOP[c.id], y2: H[c.id] - PAD.b, class: "crosshair" }));
    }
    const m = res.minutes[t];
    const evs = res.events.filter((x) => x.t === t);
    tip.replaceChildren(
      el("strong", { text: `Minute ${rel(t)}${rel(t) < 0 ? " (before the rollout)" : ""}` }),
      ...tipRows(m).map(([a, b]) => el("div", { class: "tip-row" }, [el("span", { text: a }), el("b", { text: b })])),
      ...evs.map((x) => el("div", { class: "tip-ev", text: x.text })),
    );
    tip.hidden = false;
    const left = e.clientX - box.left;
    tip.style.left = `${left > box.width / 2 ? left - tip.offsetWidth - 12 : left + 12}px`;
    tip.style.top = `${Math.max(0, e.clientY - box.top - 20)}px`;
  });
  chart.addEventListener("pointerleave", () => {
    tip.hidden = true;
    for (const c of document.querySelectorAll(".chart")) c.querySelector(".crosshair")?.remove();
  });
}

// ---------------------------------------------------------------------------

$("reset").addEventListener("click", () => {
  cfg = makeConfig();
  fillForm();
  update();
});

$("share").addEventListener("click", async () => {
  const btn = $("share");
  try {
    await navigator.clipboard.writeText(location.href);
    btn.textContent = "Link copied";
  } catch {
    btn.textContent = "Copy failed";
  }
  setTimeout(() => (btn.textContent = "Copy share link"), 1500);
});

fillForm();
update();
