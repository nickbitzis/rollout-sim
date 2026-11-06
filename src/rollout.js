// A minute-by-minute simulation of a release going out under five deployment
// strategies. Each minute, user requests are split between the stable version
// (v1) and the new version (v2) by the strategy's routing, errors and latency
// are sampled per version, an aggregate alert watches the service as a whole,
// and the canary-with-analysis strategy compares v2 against v1 at every step.
// Times are whole minutes. No DOM code.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal sample (Box-Muller). */
export function normal(rand) {
  const u = 1 - rand(), v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Poisson sample: exact (Knuth) for small means, normal approximation above 30. */
export function poisson(rand, lambda) {
  if (lambda <= 0) return 0;
  if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * normal(rand)));
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= rand(); } while (p > L);
  return k - 1;
}

/** Binomial sample. Poisson for rare events, normal approximation otherwise. */
export function binomial(rand, n, p) {
  if (n <= 0 || p <= 0) return 0;
  if (p >= 1) return n;
  const mean = n * p;
  if (n < 30) {
    let k = 0;
    for (let i = 0; i < n; i++) if (rand() < p) k++;
    return k;
  }
  if (p < 0.05 || mean < 10) return Math.min(n, poisson(rand, mean));
  return Math.min(n, Math.max(0, Math.round(mean + Math.sqrt(mean * (1 - p)) * normal(rand))));
}

/** Standard normal CDF (Abramowitz and Stegun 7.1.26, error under 1.5e-7). */
export function normCdf(z) {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** Inverse of normCdf by bisection. Only used for a handful of critical values. */
export function normInv(p) {
  let lo = -10, hi = 10;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (normCdf(mid) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * One-sided two-proportion z-test: is the canary error rate higher than the
 * baseline's? Returns z (positive means the canary is worse) and the p-value.
 */
export function twoProportionZ(eC, nC, eB, nB) {
  if (nC <= 0 || nB <= 0) return { z: 0, p: 1 };
  const pooled = (eC + eB) / (nC + nB);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / nC + 1 / nB));
  if (se === 0) return { z: 0, p: 1 };
  const z = (eC / nC - eB / nB) / se;
  return { z, p: 1 - normCdf(z) };
}

// Latency is lognormal with this median and spread. p99 = median * exp(SIGMA * Z99).
export const MEDIAN_MS = 120;
export const SIGMA = 0.5;
const Z99 = normInv(0.99);

/** True p99 of a traffic mix: share `w` of requests are `factor` times slower. */
export function mixP99(w, factor, median = MEDIAN_MS, sigma = SIGMA) {
  if (w <= 0 || factor === 1) return median * Math.exp(sigma * Z99);
  if (w >= 1) return median * factor * Math.exp(sigma * Z99);
  const F = (lq) => (1 - w) * normCdf((lq - Math.log(median)) / sigma) + w * normCdf((lq - Math.log(median * factor)) / sigma);
  let lo = Math.log(median), hi = Math.log(median * factor) + 4 * sigma;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (F(mid) < 0.99) lo = mid; else hi = mid;
  }
  return Math.exp((lo + hi) / 2);
}

/**
 * Relative standard error of a p99 estimated from n lognormal samples, from the
 * asymptotic variance of a sample quantile: sqrt(p(1-p)/n) / f(q), in log units.
 */
export function p99LogSe(n, sigma = SIGMA) {
  if (n <= 0) return Infinity;
  const pdf = Math.exp(-Z99 * Z99 / 2) / Math.sqrt(2 * Math.PI);
  return (sigma * Math.sqrt(0.99 * 0.01 / n)) / pdf;
}

// ---------------------------------------------------------------------------
// Strategies and scenarios.

export const STRATEGIES = {
  recreate: { label: "All at once (recreate)", short: "Recreate", note: "Stop every v1 pod, then start v2. Cheapest, with downtime while v2 starts." },
  rolling: { label: "Rolling update", short: "Rolling", note: "Replace pods in waves bounded by maxSurge and maxUnavailable. The Kubernetes default." },
  bluegreen: { label: "Blue-green", short: "Blue-green", note: "Start a full v2 stack, test it, switch all traffic at once. Keep v1 for instant rollback." },
  canary: { label: "Canary, fixed steps", short: "Canary", note: "Shift traffic in steps with a bake time at each one. People watch dashboards and roll back by hand." },
  analysis: { label: "Canary with analysis", short: "Canary + analysis", note: "Same steps, but each one ends with a statistical comparison of v2 against v1. Fails roll back automatically." },
};

export const SCENARIOS = {
  healthy: { label: "Healthy release", note: "v2 behaves exactly like v1. Any rollback here is a false alarm.", bugRate: 0, latencyFactor: 1 },
  bad: { label: "Bad release", note: "v2 fails 4% of requests instead of 0.3%.", bugRate: 0.0371, latencyFactor: 1 },
  latency: { label: "Subtle regression", note: "v2 is 40% slower at p99. Error rate does not change.", bugRate: 0, latencyFactor: 1.4 },
  segment: { label: "Bug for 10% of users", note: "v2 fails 15% of requests for one segment of users (10% of traffic). Overall v2 errors go to about 1.8%.", bugRate: 0.15, segment: 0.1, latencyFactor: 1 },
  leak: { label: "Memory leak", note: "v2 is healthy for 20 minutes, then pods start running out of memory and errors climb to 8% over 10 minutes.", bugRate: 0.08, onsetMin: 20, rampMin: 10, latencyFactor: 1 },
};

export const BASE_ERROR = 0.003;
/** The analysis ignores error-rate differences smaller than this (0.5 percentage points). */
export const MIN_ERROR_DIFF = 0.005;

/** Share of v2 requests failing because of the bug, for pods of a given age. */
export function bugRateAt(scn, ageMin) {
  if (!scn.bugRate) return 0;
  if (scn.onsetMin == null) return scn.bugRate;
  if (ageMin < scn.onsetMin) return 0;
  return scn.bugRate * Math.min(1, (ageMin - scn.onsetMin + 1) / scn.rampMin);
}

export const DEFAULTS = {
  scenario: "bad",
  strategy: "canary",
  seed: 7,
  rpm: 2000, // requests per minute
  replicas: 10,
  podStartMin: 2, // minutes from creating a pod to it passing readiness
  humanMin: 10, // minutes from an alert to a person starting the rollback
  alertErrorPct: 1, // aggregate error rate that pages someone, held for alertForMin
  alertForMin: 3,
  surgePct: 25,
  unavailPct: 0,
  previewMin: 3, // blue-green smoke test on the idle v2 stack
  keepBlueMin: 60,
  steps: "1,5,25,50,100",
  bakeMin: 10,
  alphaPct: 1, // one-sided significance level per analysis check
  latTolPct: 20, // canary p99 may be this much above baseline before it can fail
};

export const START = 10; // minute the rollout begins; the minutes before it are the v1 baseline
export const DURATION = 130;

/** Parse "1, 5, 25" into sorted unique fractions that always end at 100%. */
export function parseSteps(s) {
  const xs = String(s).split(/[,\s]+/).map(Number).filter((x) => Number.isFinite(x) && x > 0 && x <= 100);
  const out = [...new Set(xs.map((x) => Math.round(x * 10) / 10))].sort((a, b) => a - b);
  if (out[out.length - 1] !== 100) out.push(100);
  return out.map((x) => x / 100);
}

export function clamp(cfg) {
  const c = { ...DEFAULTS, ...cfg };
  if (!SCENARIOS[c.scenario]) c.scenario = DEFAULTS.scenario;
  if (!STRATEGIES[c.strategy]) c.strategy = DEFAULTS.strategy;
  const lim = (k, lo, hi, round = true) => {
    let v = Number(c[k]);
    if (!Number.isFinite(v)) v = DEFAULTS[k];
    v = Math.min(hi, Math.max(lo, v));
    c[k] = round ? Math.round(v) : v;
  };
  lim("seed", 0, 1e9);
  lim("rpm", 100, 20000);
  lim("replicas", 2, 100);
  lim("podStartMin", 1, 10);
  lim("humanMin", 0, 60);
  lim("alertErrorPct", 0.5, 20, false);
  lim("alertForMin", 1, 10);
  lim("surgePct", 0, 100);
  lim("unavailPct", 0, 100);
  if (c.surgePct === 0 && c.unavailPct === 0) c.surgePct = 25;
  lim("previewMin", 0, 30);
  lim("keepBlueMin", 0, 120);
  lim("bakeMin", 1, 30);
  lim("alphaPct", 0.1, 10, false);
  lim("latTolPct", 0, 100);
  c.steps = parseSteps(c.steps).map((x) => Math.round(x * 1000) / 10).join(",");
  return c;
}

export function makeConfig(over = {}) {
  return clamp({ ...DEFAULTS, ...over });
}

export function encodeConfig(cfg) {
  const p = new URLSearchParams();
  for (const k of Object.keys(DEFAULTS)) p.set(k, String(cfg[k]));
  return p.toString();
}

export function decodeConfig(hash) {
  const p = new URLSearchParams(String(hash).replace(/^#/, ""));
  const over = {};
  for (const k of Object.keys(DEFAULTS)) if (p.has(k)) over[k] = p.get(k);
  return makeConfig(over);
}

// ---------------------------------------------------------------------------
// Pods. Each version has ready pods and pending pods (with the minute they
// become ready). Strategies only create and delete pods and set routing.

function makePods(n) {
  return { v1: { ready: n, pending: [] }, v2: { ready: 0, pending: [] } };
}
const count = (pods, v) => pods[v].ready + pods[v].pending.length;
function start(pods, v, k, t, P) {
  for (let i = 0; i < k; i++) pods[v].pending.push(t + P);
}
function promote(pods, t) {
  for (const v of ["v1", "v2"]) {
    const still = pods[v].pending.filter((r) => r > t);
    pods[v].ready += pods[v].pending.length - still.length;
    pods[v].pending = still;
  }
}
/** Delete k pods of a version, pending ones first. */
function kill(pods, v, k) {
  const fromPending = Math.min(k, pods[v].pending.length);
  pods[v].pending.splice(pods[v].pending.length - fromPending, fromPending);
  pods[v].ready -= Math.min(pods[v].ready, k - fromPending);
}

/**
 * A controller per strategy. `tick(t, rollback)` runs at the start of minute t
 * and returns the routing for that minute: { w2, outage }. `rollback` is true
 * once the rollback has been decided. The controller logs events with `log`.
 */
function controller(cfg, pods, log, analyze) {
  const N = cfg.replicas, P = cfg.podStartMin, S = START;
  const byReady = () => {
    const r1 = pods.v1.ready, r2 = pods.v2.ready;
    return r1 + r2 === 0 ? { w2: 0, outage: true } : { w2: r2 / (r1 + r2), outage: false };
  };
  const st = { complete: false, rbStarted: false, rbFinished: false };

  if (cfg.strategy === "recreate") {
    return {
      st,
      tick(t, rollback) {
        if (t === S) { kill(pods, "v1", N); start(pods, "v2", N, t, P); log(t, "start", "v1 stopped, v2 starting. No pods are serving."); }
        if (rollback && !st.rbStarted) { st.rbStarted = true; kill(pods, "v2", N); start(pods, "v1", N, t, P); log(t, "rollback", "Rollback: v2 stopped, v1 starting. No pods are serving."); }
        promote(pods, t);
        if (!st.complete && !st.rbStarted && pods.v2.ready === N) { st.complete = true; log(t, "complete", "v2 serving all traffic."); }
        return byReady();
      },
    };
  }

  if (cfg.strategy === "rolling") {
    const surge = Math.ceil((N * cfg.surgePct) / 100), unavail = Math.floor((N * cfg.unavailPct) / 100);
    const maxSurge = surge + unavail === 0 ? 1 : surge;
    return {
      st,
      tick(t, rollback) {
        if (t < S) return byReady();
        if (t === S) log(t, "start", `Rolling update: up to ${maxSurge} extra and ${unavail} unavailable pods at a time.`);
        if (rollback && !st.rbStarted) { st.rbStarted = true; log(t, "rollback", "Rollback: rolling back to v1 with the same surge settings."); }
        promote(pods, t);
        const target = st.rbStarted ? "v1" : "v2", other = st.rbStarted ? "v2" : "v1";
        // Scale down the old version as far as availability allows, then scale up the new one.
        const avail = pods.v1.ready + pods.v2.ready;
        const pend = pods[other].pending.length;
        kill(pods, other, pend + Math.max(0, Math.min(pods[other].ready, avail - (N - unavail))));
        const up = Math.min(N - count(pods, target), N + maxSurge - count(pods, "v1") - count(pods, "v2"));
        if (up > 0) start(pods, target, up, t, P);
        if (!st.rbStarted && !st.complete && count(pods, "v1") === 0 && pods.v2.ready === N) { st.complete = true; log(t, "complete", "All pods are v2."); }
        return byReady();
      },
    };
  }

  if (cfg.strategy === "bluegreen") {
    let active = "v1", greenReadyAt = null, switchAt = null;
    return {
      st,
      tick(t, rollback) {
        if (t === S) { start(pods, "v2", N, t, P); log(t, "start", `Green stack (v2) starting: ${N} extra pods, no traffic yet.`); }
        promote(pods, t);
        if (!st.rbStarted && greenReadyAt == null && pods.v2.ready === N) { greenReadyAt = t; if (cfg.previewMin) log(t, "step", `Green ready. Smoke tests on the preview service for ${cfg.previewMin} min.`); }
        if (!st.rbStarted && switchAt == null && greenReadyAt != null && t >= greenReadyAt + cfg.previewMin) {
          switchAt = t; active = "v2"; st.complete = true;
          log(t, "switch", `Switch: all traffic to v2. Blue (v1) kept for ${cfg.keepBlueMin} min.`);
        }
        if (switchAt != null && !st.rbStarted && t === switchAt + cfg.keepBlueMin && count(pods, "v1") > 0) {
          kill(pods, "v1", N); log(t, "scale", "Blue (v1) scaled down. Rollback now needs a redeploy.");
        }
        if (rollback && !st.rbStarted) {
          st.rbStarted = true;
          if (pods.v1.ready >= N) log(t, "rollback", "Rollback: switch traffic back to blue (v1).");
          else { start(pods, "v1", N - count(pods, "v1"), t, P); log(t, "rollback", "Rollback: blue is gone, redeploying v1 before switching back."); }
        }
        if (st.rbStarted && active === "v2" && pods.v1.ready >= N) { active = "v1"; kill(pods, "v2", N); }
        const r = pods[active].ready;
        return r === 0 ? { w2: 0, outage: true } : { w2: active === "v2" ? 1 : 0, outage: false };
      },
    };
  }

  // Canary, with or without analysis. Traffic is split by weight (a mesh or
  // ingress), so v2 can get 1% with a single pod. Stable stays at full size
  // until the last step passes, as in Argo Rollouts by default.
  const steps = parseSteps(cfg.steps);
  let i = 0, phase = "idle", w = 0, bakeStart = 0;
  return {
    st,
    tick(t, rollback) {
      promote(pods, t);
      if (t === S) { phase = "scaling"; start(pods, "v2", Math.ceil(N * steps[0]), t, P); log(t, "start", `Canary pods starting for the ${pct(steps[0])} step.`); }
      if (rollback && !st.rbStarted) {
        st.rbStarted = true;
        if (pods.v1.ready >= N) log(t, "rollback", "Rollback: weight set to 0% and canary pods deleted.");
        else { start(pods, "v1", N - count(pods, "v1"), t, P); log(t, "rollback", "Rollback: v1 was scaled down, redeploying it first."); }
      }
      if (st.rbStarted) {
        if (pods.v1.ready >= N) { w = 0; kill(pods, "v2", count(pods, "v2")); }
        return { w2: pods.v2.ready ? w : 0, outage: false };
      }
      if (phase === "baking" && t - bakeStart >= cfg.bakeMin) {
        const verdict = analyze ? analyze(bakeStart, t - 1, steps[i]) : { pass: true };
        if (!verdict.pass) {
          log(t, "fail", `Analysis failed at ${pct(steps[i])}: ${verdict.reason}`);
          st.rbStarted = true;
          st.autoRollbackAt = t;
          w = 0; kill(pods, "v2", count(pods, "v2"));
          log(t, "rollback", "Automatic rollback: weight set to 0% and canary pods deleted.");
          return { w2: 0, outage: false };
        }
        if (analyze) log(t, "pass", `Analysis passed at ${pct(steps[i])}: ${verdict.reason}`);
        i++;
        if (i >= steps.length) {
          phase = "done"; st.complete = true; kill(pods, "v1", N);
          log(t, "complete", "Promoted. v1 scaled down, rollback now needs a redeploy.");
        } else {
          phase = "scaling";
          start(pods, "v2", Math.max(0, Math.ceil(N * steps[i]) - count(pods, "v2")), t, P);
        }
      }
      if (phase === "scaling" && pods.v2.ready >= Math.ceil(N * steps[i])) {
        phase = "baking"; bakeStart = t; w = steps[i];
        log(t, "step", `Weight ${pct(w)} to v2. Baking ${cfg.bakeMin} min.`);
      }
      return { w2: pods.v2.ready ? w : 0, outage: false };
    },
  };
}

const pct = (x) => `${+(x * 100).toFixed(1)}%`;

// ---------------------------------------------------------------------------
// The simulation.

export function simulate(cfgIn) {
  const cfg = clamp(cfgIn);
  const scn = SCENARIOS[cfg.scenario];
  const rand = mulberry32(cfg.seed * 7919 + 17);
  const pods = makePods(cfg.replicas);
  const events = [];
  const log = (t, kind, text) => events.push({ t, kind, text });
  const zCrit = normInv(1 - cfg.alphaPct / 100);
  const minutes = [];
  const basP99 = mixP99(0, 1);

  // Canary analysis: compare v2 with v1 over the bake window [a, b].
  const analyze = (a, b, w) => {
    let nC = 0, eC = 0, nB = 0, eB = 0, slowC = 0;
    for (let k = a; k <= b; k++) { const m = minutes[k]; nC += m.n2; eC += m.e2; nB += m.n1; eB += m.e1; slowC += m.n2 * Math.log(m.lat2); }
    if (w >= 1 || nB < 100) {
      // At 100% there is no stable traffic left to compare with: use v1's last 10 minutes before the rollout.
      nB = 0; eB = 0;
      for (let k = Math.max(0, START - 10); k < START; k++) { nB += minutes[k].n1; eB += minutes[k].e1; }
    }
    const err = twoProportionZ(eC, nC, eB, nB);
    const factorC = nC ? Math.exp(slowC / nC) : 1;
    const p99C = basP99 * factorC * Math.exp(p99LogSe(nC) * normal(rand));
    const p99B = basP99 * Math.exp(p99LogSe(nB) * normal(rand));
    const ratio = p99C / p99B;
    const seLat = Math.hypot(p99LogSe(nC), p99LogSe(nB));
    const zLat = Math.log(ratio) / seLat;
    const rC = nC ? eC / nC : 0, rB = nB ? eB / nB : 0;
    const errText = `errors ${(rC * 100).toFixed(2)}% vs ${(rB * 100).toFixed(2)}% (z ${err.z.toFixed(1)})`;
    const latText = `p99 ${Math.round(p99C)} vs ${Math.round(p99B)} ms`;
    const result = { t: b + 1, w, nC, nB, rC, rB, z: err.z, p99C, p99B, zLat };
    // Errors fail when the difference is both significant and big enough to matter.
    if (err.z > zCrit && rC - rB > MIN_ERROR_DIFF) return { ...result, pass: false, reason: `${errText}. ${latText}.` };
    // Latency fails when we are confident the canary is more than latTolPct slower:
    // the lower confidence bound of the p99 ratio is above the tolerance.
    if (Math.log(ratio) - zCrit * seLat > Math.log(1 + cfg.latTolPct / 100)) return { ...result, pass: false, reason: `${latText} (+${Math.round((ratio - 1) * 100)}%, z ${zLat.toFixed(1)}). ${errText}.` };
    return { ...result, pass: true, reason: `${errText}. ${latText}.` };
  };
  const checks = [];
  const ctl = controller(cfg, pods, log, cfg.strategy === "analysis" ? (a, b, w) => { const r = analyze(a, b, w); checks.push(r); return r; } : null);

  let v2StartAt = null, alertAt = null, detectAt = null, rollbackAt = null, rollbackDoneAt = null, bugStartAt = null, completeAt = null;
  let streak = 0;
  for (let t = 0; t < DURATION; t++) {
    const route = ctl.tick(t, rollbackAt != null && t >= rollbackAt);
    if (ctl.st.autoRollbackAt === t && (rollbackAt == null || t < rollbackAt)) {
      // The analysis acted before any person did.
      rollbackAt = t;
      if (detectAt == null) detectAt = t;
    }
    if (v2StartAt == null && count(pods, "v2") > 0) v2StartAt = t;
    if (ctl.st.complete && completeAt == null) completeAt = t;

    const n = poisson(rand, cfg.rpm);
    const age = v2StartAt == null ? 0 : t - v2StartAt;
    const m = { t, n, n1: 0, n2: 0, e1: 0, e2: 0, bug: 0, slowed: 0, outage: 0, w2: route.w2, lat2: 1, pods1: count(pods, "v1"), pods2: count(pods, "v2") };
    if (route.outage) {
      m.outage = n;
    } else {
      m.n2 = binomial(rand, n, route.w2);
      m.n1 = n - m.n2;
      m.e1 = binomial(rand, m.n1, BASE_ERROR);
      const affected = scn.segment ? binomial(rand, m.n2, scn.segment) : m.n2;
      m.bug = binomial(rand, affected, bugRateAt(scn, age));
      m.e2 = m.bug + binomial(rand, m.n2 - m.bug, BASE_ERROR);
      m.lat2 = scn.latencyFactor;
      if (scn.latencyFactor > 1) m.slowed = m.n2;
    }
    const served = m.n1 + m.n2;
    m.p99 = served ? mixP99(served ? m.n2 / served : 0, scn.latencyFactor) * Math.exp(p99LogSe(served) * normal(rand)) : 0;
    minutes.push(m);
    if (bugStartAt == null && m.n2 > 0 && (bugRateAt(scn, age) > 0 || scn.latencyFactor > 1)) bugStartAt = t;

    // Aggregate alert on the whole service, the way most teams are paged:
    // error rate or p99 over a threshold for several minutes in a row.
    // Outage minutes are excluded, since a recreate deploy is expected to cause them.
    const errRate = served ? (m.e1 + m.e2) / served : 0;
    const hot = served > 0 && (errRate * 100 > cfg.alertErrorPct || m.p99 > basP99 * 1.25);
    streak = hot ? streak + 1 : 0;
    if (alertAt == null && t >= START && streak >= cfg.alertForMin) {
      alertAt = t + 1;
      log(t + 1, "alert", `Alert: service ${errRate * 100 > cfg.alertErrorPct ? `error rate ${(errRate * 100).toFixed(1)}%` : `p99 ${Math.round(m.p99)} ms`} for ${cfg.alertForMin} min. On-call paged.`);
      if (detectAt == null && !ctl.st.rbStarted && count(pods, "v2") > 0) { detectAt = t + 1; rollbackAt = t + 1 + cfg.humanMin; }
    }
    if (rollbackAt != null && rollbackDoneAt == null && t >= rollbackAt && m.n2 === 0 && count(pods, "v2") === 0 && !route.outage) {
      rollbackDoneAt = t;
      log(t, "done", "Rollback complete: no traffic on v2.");
    }
  }

  // Summary metrics.
  const sum = (f) => minutes.reduce((a, m) => a + f(m), 0);
  const N = cfg.replicas;
  const peakPods = Math.max(...minutes.map((m) => m.pods1 + m.pods2));
  const blast = scn.latencyFactor > 1 ? sum((m) => m.slowed) : sum((m) => m.bug);
  return {
    cfg,
    minutes,
    events: events.sort((a, b) => a.t - b.t),
    checks,
    blast,
    bugErrors: sum((m) => m.bug),
    outage: sum((m) => m.outage),
    downtimeMin: minutes.filter((m) => m.outage > 0).length,
    v2Requests: sum((m) => m.n2),
    alertAt,
    detectAt,
    rollbackAt,
    rollbackDoneAt,
    rolledBack: rollbackAt != null,
    bugStartAt,
    completeAt,
    detectMin: detectAt != null && bugStartAt != null ? Math.max(0, detectAt - bugStartAt) : null,
    rollbackMin: rollbackDoneAt != null ? rollbackDoneAt - detectAt : null,
    rollbackMechMin: rollbackDoneAt != null ? rollbackDoneAt - rollbackAt : null,
    rolloutMin: completeAt != null ? completeAt - START : null,
    peakCapacity: peakPods / N,
    extraPodHours: sum((m) => Math.max(0, m.pods1 + m.pods2 - N)) / 60,
  };
}

/** Run every strategy on the same scenario and seed, plus a healthy release for rollout time. */
export function compareStrategies(cfg) {
  const out = {};
  for (const s of Object.keys(STRATEGIES)) {
    const r = simulate({ ...cfg, strategy: s });
    const h = cfg.scenario === "healthy" ? r : simulate({ ...cfg, strategy: s, scenario: "healthy" });
    out[s] = { ...r, healthyRolloutMin: h.rolloutMin, healthyRolledBack: h.rolledBack };
  }
  return out;
}
