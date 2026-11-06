import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BASE_ERROR, DEFAULTS, START, binomial, bugRateAt, compareStrategies, decodeConfig, encodeConfig, makeConfig, mixP99,
  mulberry32, normCdf, normInv, p99LogSe, parseSteps, poisson, simulate, twoProportionZ, SCENARIOS,
} from "../src/rollout.js";

const run = (over = {}) => simulate(makeConfig(over));
const firstAt = (r, kind) => r.events.find((e) => e.kind === kind)?.t;
const shares = (r) => r.minutes.map((m) => m.w2);

test("mulberry32 is deterministic and seed dependent", () => {
  const a = mulberry32(42), b = mulberry32(42), c = mulberry32(43);
  const xs = Array.from({ length: 5 }, a), ys = Array.from({ length: 5 }, b), zs = Array.from({ length: 5 }, c);
  assert.deepEqual(xs, ys);
  assert.notDeepEqual(xs, zs);
  for (const x of xs) assert.ok(x >= 0 && x < 1);
});

test("simulation is reproducible from the seed", () => {
  const a = run({ scenario: "bad", strategy: "rolling" }), b = run({ scenario: "bad", strategy: "rolling" });
  assert.deepEqual(a.minutes, b.minutes);
  assert.deepEqual(a.events, b.events);
  const c = run({ scenario: "bad", strategy: "rolling", seed: 8 });
  assert.notDeepEqual(a.minutes, c.minutes);
});

test("poisson and binomial samplers have the right means", () => {
  const rand = mulberry32(3);
  const mean = (f, k = 4000) => Array.from({ length: k }, f).reduce((s, x) => s + x, 0) / k;
  assert.ok(Math.abs(mean(() => poisson(rand, 4)) - 4) < 0.15);
  assert.ok(Math.abs(mean(() => poisson(rand, 2000)) - 2000) < 5);
  assert.ok(Math.abs(mean(() => binomial(rand, 2000, 0.003)) - 6) < 0.25);
  assert.ok(Math.abs(mean(() => binomial(rand, 2000, 0.3)) - 600) < 3);
  assert.ok(Math.abs(mean(() => binomial(rand, 20, 0.5)) - 10) < 0.2);
});

test("normal CDF, inverse, and the two-proportion z-test match known values", () => {
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-4);
  assert.ok(Math.abs(normInv(0.99) - 2.3263) < 1e-3);
  assert.equal(twoProportionZ(3, 1000, 3, 1000).z, 0);
  // 4% vs 0.3% on 500 and 10,000 requests is far past any threshold.
  const big = twoProportionZ(20, 500, 30, 10000);
  assert.ok(big.z > 8 && big.p < 1e-10);
  // A canary that is better than baseline gives a negative z.
  assert.ok(twoProportionZ(0, 500, 30, 10000).z < 0);
});

test("p99 of a traffic mix sits between the two versions and the standard error shrinks with traffic", () => {
  const p1 = mixP99(0, 1.4), p2 = mixP99(1, 1.4), mid = mixP99(0.5, 1.4);
  assert.ok(Math.abs(p2 / p1 - 1.4) < 1e-9);
  assert.ok(mid > p1 && mid < p2);
  assert.ok(mixP99(0.01, 1.4) < p1 * 1.05); // 1% of slow traffic barely moves the aggregate p99
  assert.ok(Math.abs(p99LogSe(100) / p99LogSe(400) - 2) < 1e-9);
});

test("parseSteps sorts, removes duplicates, and always ends at 100%", () => {
  assert.deepEqual(parseSteps("25, 5, 5, 1"), [0.01, 0.05, 0.25, 1]);
  assert.deepEqual(parseSteps("1,5,25,50,100"), [0.01, 0.05, 0.25, 0.5, 1]);
  assert.deepEqual(parseSteps("junk, -3, 400"), [1]);
});

test("config round-trips through the URL hash and bad values are clamped", () => {
  const cfg = makeConfig({ scenario: "leak", strategy: "bluegreen", seed: 99, bakeMin: 4, steps: "2,10" });
  assert.deepEqual(decodeConfig(`#${encodeConfig(cfg)}`), cfg);
  const bad = decodeConfig("#scenario=nope&replicas=-5&bakeMin=999&rpm=abc");
  assert.equal(bad.scenario, DEFAULTS.scenario);
  assert.equal(bad.replicas, 2);
  assert.equal(bad.bakeMin, 30);
  assert.equal(bad.rpm, DEFAULTS.rpm);
});

// ---------------------------------------------------------------------------
// Traffic schedules on a healthy release.

test("recreate: full outage while v2 starts, then all traffic on v2", () => {
  const r = run({ scenario: "healthy", strategy: "recreate", podStartMin: 3 });
  const s = shares(r);
  assert.ok(s.slice(0, START).every((w) => w === 0));
  for (let t = START; t < START + 3; t++) assert.equal(r.minutes[t].outage, r.minutes[t].n);
  assert.ok(s.slice(START + 3).every((w) => w === 1));
  assert.equal(r.downtimeMin, 3);
  assert.equal(r.peakCapacity, 1);
  assert.equal(r.rolloutMin, 3);
});

test("rolling: waves of maxSurge pods, share never goes back, no downtime", () => {
  const r = run({ scenario: "healthy", strategy: "rolling", replicas: 10, surgePct: 25, unavailPct: 0, podStartMin: 2 });
  const s = shares(r);
  for (let t = 1; t < s.length; t++) assert.ok(s[t] >= s[t - 1]);
  // ceil(10 * 25%) = 3 new pods per wave, 4 waves of 2 minutes.
  assert.equal(r.rolloutMin, 8);
  assert.equal(r.peakCapacity, 1.3);
  assert.equal(r.downtimeMin, 0);
  assert.ok(Math.abs(s[START + 2] - 3 / 10) < 1e-9);
});

test("rolling with maxUnavailable only never adds pods", () => {
  const r = run({ scenario: "healthy", strategy: "rolling", replicas: 10, surgePct: 0, unavailPct: 50, podStartMin: 2 });
  assert.equal(r.peakCapacity, 1);
  assert.equal(r.rolloutMin, 4);
  assert.ok(Math.min(...r.minutes.map((m) => m.pods1 + m.pods2)) >= 10);
});

test("blue-green: 0% then 100% at the switch, double capacity until blue is removed", () => {
  const r = run({ scenario: "healthy", strategy: "bluegreen", podStartMin: 2, previewMin: 3, keepBlueMin: 30 });
  const sw = firstAt(r, "switch");
  assert.equal(sw, START + 5);
  assert.ok(shares(r).every((w, t) => w === (t >= sw ? 1 : 0)));
  assert.equal(r.peakCapacity, 2);
  assert.equal(r.minutes[sw + 29].pods1, 10);
  assert.equal(r.minutes[sw + 30].pods1, 0);
});

test("canary: weights follow the steps in order with the bake time at each one", () => {
  const r = run({ scenario: "healthy", strategy: "canary", steps: "1,5,25,50,100", bakeMin: 10, podStartMin: 2 });
  const steps = r.events.filter((e) => e.kind === "step");
  assert.deepEqual(steps.map((e) => r.minutes[e.t].w2), [0.01, 0.05, 0.25, 0.5, 1]);
  for (let i = 1; i < steps.length; i++) assert.ok(steps[i].t - steps[i - 1].t >= 10);
  // 1% and 5% share a single pod, so that step needs no new pods.
  assert.equal(steps[1].t - steps[0].t, 10);
  assert.equal(steps[2].t - steps[1].t, 12);
  assert.equal(r.minutes[steps[2].t].pods2, 3);
  assert.ok(r.completeAt > steps[4].t);
});

test("a healthy release never rolls back under any strategy", () => {
  const all = compareStrategies(makeConfig({ scenario: "healthy" }));
  for (const [s, r] of Object.entries(all)) {
    assert.equal(r.rolledBack, false, s);
    assert.equal(r.blast, 0, s);
    assert.equal(r.minutes.at(-1).w2, 1, s);
  }
});

test("healthy rollout time: recreate is fastest, canaries are slowest", () => {
  const all = compareStrategies(makeConfig({ scenario: "healthy" }));
  const t = Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v.rolloutMin]));
  assert.ok(t.recreate < t.bluegreen && t.bluegreen < t.rolling);
  assert.ok(t.rolling < t.canary);
  assert.equal(t.canary, t.analysis);
});

// ---------------------------------------------------------------------------
// Rollback triggers and timing.

test("a bad release is rolled back by every strategy", () => {
  const all = compareStrategies(makeConfig({ scenario: "bad" }));
  for (const [s, r] of Object.entries(all)) {
    assert.ok(r.rolledBack, s);
    assert.notEqual(r.rollbackDoneAt, null, s);
    assert.equal(r.minutes.at(-1).w2, 0, s);
  }
});

test("manual rollback starts exactly the human delay after the alert", () => {
  for (const humanMin of [0, 5, 20]) {
    const r = run({ scenario: "bad", strategy: "bluegreen", humanMin });
    assert.equal(r.rollbackAt - r.alertAt, humanMin);
    assert.equal(firstAt(r, "rollback"), r.rollbackAt);
  }
});

test("the alert needs the error rate held over the threshold for alertForMin minutes", () => {
  const a = run({ scenario: "bad", strategy: "bluegreen", alertForMin: 1 });
  const b = run({ scenario: "bad", strategy: "bluegreen", alertForMin: 5 });
  assert.equal(b.alertAt - a.alertAt, 4);
});

test("rollback mechanics: blue-green and canary are instant, rolling takes waves, recreate has downtime", () => {
  const all = compareStrategies(makeConfig({ scenario: "bad", podStartMin: 2 }));
  assert.equal(all.bluegreen.rollbackMechMin, 0);
  assert.equal(all.canary.rollbackMechMin, 0);
  assert.equal(all.analysis.rollbackMechMin, 0);
  assert.equal(all.rolling.rollbackMechMin, 8);
  assert.equal(all.recreate.rollbackMechMin, 2);
  assert.equal(all.recreate.downtimeMin, 4); // 2 minutes going out, 2 coming back
});

test("blue-green rollback needs a redeploy once blue has been scaled down", () => {
  const kept = run({ scenario: "leak", strategy: "bluegreen", keepBlueMin: 60 });
  const gone = run({ scenario: "leak", strategy: "bluegreen", keepBlueMin: 5, podStartMin: 3 });
  assert.equal(kept.rollbackMechMin, 0);
  assert.equal(gone.rollbackMechMin, 3);
  assert.ok(gone.blast > kept.blast);
});

test("canary analysis fails the bad release at an early step and rolls back in the same minute", () => {
  const r = run({ scenario: "bad", strategy: "analysis" });
  const fail = r.events.find((e) => e.kind === "fail");
  assert.ok(fail);
  assert.equal(r.rollbackAt, fail.t);
  assert.ok(r.checks.at(-1).w <= 0.05);
  assert.equal(r.alertAt, null); // the aggregate never moved enough to page anyone
  assert.ok(r.blast < 30);
});

test("canary analysis catches a latency-only regression with the p99 check", () => {
  const r = run({ scenario: "latency", strategy: "analysis" });
  const last = r.checks.at(-1);
  assert.equal(last.pass, false);
  assert.ok(last.z < normInv(0.99)); // errors were fine
  assert.ok(last.p99C / last.p99B > 1.2);
  assert.ok(last.w <= 0.25);
});

test("the segment bug is caught by analysis while fixed steps go to 50% or more", () => {
  const all = compareStrategies(makeConfig({ scenario: "segment" }));
  assert.ok(all.analysis.checks.at(-1).w <= 0.05);
  const canaryPeak = Math.max(...all.canary.minutes.map((m) => m.w2));
  assert.ok(canaryPeak >= 0.5);
  assert.ok(all.analysis.blast * 10 < all.canary.blast);
});

test("memory leak: bake time decides whether analysis sees it", () => {
  const short = run({ scenario: "leak", strategy: "analysis", bakeMin: 2 });
  const long = run({ scenario: "leak", strategy: "analysis", bakeMin: 10 });
  // Short bakes promote before the leak shows, so only the aggregate alert catches it.
  assert.ok(short.completeAt != null && short.completeAt < START + SCENARIOS.leak.onsetMin);
  assert.ok(short.checks.every((c) => c.pass));
  assert.equal(long.completeAt, null);
  assert.ok(long.checks.some((c) => !c.pass));
  assert.ok(long.blast * 2 < short.blast);
});

test("bug rate ramps after the leak onset", () => {
  const s = SCENARIOS.leak;
  assert.equal(bugRateAt(s, 19), 0);
  assert.ok(bugRateAt(s, 20) > 0 && bugRateAt(s, 20) < s.bugRate);
  assert.equal(bugRateAt(s, 40), s.bugRate);
  assert.equal(bugRateAt(SCENARIOS.bad, 0), SCENARIOS.bad.bugRate);
});

test("recreate downtime is counted as outage, not as bug impact", () => {
  const r = run({ scenario: "healthy", strategy: "recreate" });
  assert.ok(r.outage > 3000);
  assert.equal(r.bugErrors, 0);
});

// ---------------------------------------------------------------------------
// Properties over many seeds.

test("analysis false-positive rate on a healthy release stays under 5% over 300 seeds", () => {
  let fp = 0;
  for (let seed = 1; seed <= 300; seed++) if (run({ scenario: "healthy", strategy: "analysis", seed }).rolledBack) fp++;
  assert.ok(fp / 300 < 0.05, `false positives ${fp} of 300`);
});

test("blast radius on the bad release: analysis < fixed canary < the all-at-once strategies, on every seed", () => {
  for (let seed = 1; seed <= 25; seed++) {
    const all = compareStrategies(makeConfig({ scenario: "bad", seed }));
    const big = Math.min(all.recreate.blast, all.rolling.blast, all.bluegreen.blast);
    assert.ok(all.analysis.blast < all.canary.blast, `seed ${seed}`);
    assert.ok(all.canary.blast < big, `seed ${seed}`);
  }
});

test("v1 error rate stays at the baseline in every scenario", () => {
  for (const scenario of Object.keys(SCENARIOS)) {
    const r = run({ scenario, strategy: "canary" });
    const n1 = r.minutes.reduce((a, m) => a + m.n1, 0), e1 = r.minutes.reduce((a, m) => a + m.e1, 0);
    assert.ok(Math.abs(e1 / n1 - BASE_ERROR) < 0.001, scenario);
  }
});

test("capacity: blue-green costs the most extra pod-hours, recreate none", () => {
  const all = compareStrategies(makeConfig({ scenario: "healthy" }));
  assert.equal(all.recreate.extraPodHours, 0);
  for (const s of ["rolling", "canary", "analysis"]) assert.ok(all.bluegreen.extraPodHours > all[s].extraPodHours, s);
});

test("the Argo Rollouts example uses the same steps and thresholds as the simulator", async () => {
  const { readFile } = await import("node:fs/promises");
  const { MIN_ERROR_DIFF } = await import("../src/rollout.js");
  const yaml = await readFile(new URL("../docs/argo-rollout-example.yaml", import.meta.url), "utf8");
  const weights = [...yaml.matchAll(/setWeight: (\d+)/g)].map((m) => Number(m[1]) / 100);
  assert.deepEqual([...weights, 1], parseSteps(DEFAULTS.steps));
  const pauses = [...yaml.matchAll(/duration: (\d+)m/g)].map((m) => Number(m[1]));
  assert.ok(pauses.length === weights.length && pauses.every((p) => p === DEFAULTS.bakeMin));
  const z = Number(yaml.match(/result\[0\] < (2\.\d+)/)[1]);
  assert.ok(Math.abs(z - normInv(1 - DEFAULTS.alphaPct / 100)) < 0.001);
  assert.ok(yaml.includes(`result[0] < ${MIN_ERROR_DIFF}`));
  assert.ok(yaml.includes(`result[0] <= ${1 + DEFAULTS.latTolPct / 100}`));
});
