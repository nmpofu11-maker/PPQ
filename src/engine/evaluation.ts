/**
 * Offline evaluation utilities: proper scoring rules, reliability/calibration,
 * honest baselines and a paired bootstrap. Used by scripts/backtest.ts and scripts/fit.ts.
 *
 * NOTE on Brier scores: the in-app learning loop stores a 3-class Brier divided by 3
 * (a uniform 1/3-1/3-1/3 guess scores 2/9 ≈ 0.222 on that scale). The STANDARD multi-class
 * Brier used here is the plain sum of squared errors (uniform guess = 2/3 ≈ 0.667), so the
 * two are related by a factor of 3 and must not be compared directly.
 */
import type { OddsFreeMatchSnapshot, ScrapedMatch } from '../types/soccer';
import { predictMatchMarkets, reconstructSnapshotAtMinute } from './momentumMath';

export type Outcome = 'H' | 'D' | 'A';
export interface Probs3 {
  home: number;
  draw: number;
  away: number;
}

export const UNIFORM_BRIER_STANDARD = 2 / 3;
/** Multiply the app's stored mean Brier by this to get the standard multi-class value. */
export const STORED_TO_STANDARD_BRIER = 3;

export function outcomeOf(homeGoals: number, awayGoals: number): Outcome {
  return homeGoals > awayGoals ? 'H' : homeGoals < awayGoals ? 'A' : 'D';
}

function indicator(o: Outcome): [number, number, number] {
  return [o === 'H' ? 1 : 0, o === 'D' ? 1 : 0, o === 'A' ? 1 : 0];
}

export function normalise3(p: Probs3): Probs3 {
  const s = p.home + p.draw + p.away;
  return s > 0 ? { home: p.home / s, draw: p.draw / s, away: p.away / s } : { home: 1 / 3, draw: 1 / 3, away: 1 / 3 };
}

/** Standard multi-class Brier score (sum of squared errors, range 0..2). */
export function brier3(p: Probs3, o: Outcome): number {
  const [yh, yd, ya] = indicator(o);
  return (p.home - yh) ** 2 + (p.draw - yd) ** 2 + (p.away - ya) ** 2;
}

/** Ranked probability score for ordered outcomes H < D < A (lower is better). */
export function rps3(p: Probs3, o: Outcome): number {
  const [yh, yd] = indicator(o);
  return ((p.home - yh) ** 2 + (p.home + p.draw - (yh + yd)) ** 2) / 2;
}

export function logLoss3(p: Probs3, o: Outcome): number {
  const v = o === 'H' ? p.home : o === 'D' ? p.draw : p.away;
  return -Math.log(Math.min(1 - 1e-12, Math.max(1e-12, v)));
}

export function brierBinary(p: number, y: 0 | 1): number {
  return (p - y) ** 2;
}

export function logLossBinary(p: number, y: 0 | 1): number {
  const q = Math.min(1 - 1e-12, Math.max(1e-12, p));
  return -(y === 1 ? Math.log(q) : Math.log(1 - q));
}

export interface ReliabilityBin {
  lo: number;
  hi: number;
  count: number;
  meanPredicted: number;
  observedFrequency: number;
}

export function reliabilityBins(pairs: { p: number; y: 0 | 1 }[], bins = 10): ReliabilityBin[] {
  const out: ReliabilityBin[] = [];
  for (let b = 0; b < bins; b++) {
    const lo = b / bins;
    const hi = (b + 1) / bins;
    const inBin = pairs.filter((x) => (b === bins - 1 ? x.p >= lo && x.p <= hi : x.p >= lo && x.p < hi));
    out.push({
      lo,
      hi,
      count: inBin.length,
      meanPredicted: inBin.length ? inBin.reduce((s, x) => s + x.p, 0) / inBin.length : 0,
      observedFrequency: inBin.length ? inBin.reduce((s, x) => s + x.y, 0) / inBin.length : 0,
    });
  }
  return out;
}

/** Expected calibration error over reliability bins (count-weighted mean |pred - observed|). */
export function expectedCalibrationError(bins: ReliabilityBin[]): number {
  const total = bins.reduce((s, b) => s + b.count, 0);
  if (total === 0) return 0;
  return bins.reduce((s, b) => s + (b.count / total) * Math.abs(b.meanPredicted - b.observedFrequency), 0);
}

/* -------------------------------------------------------------------------- */
/* Samples                                                                     */
/* -------------------------------------------------------------------------- */

export interface EvalSample {
  matchId: string;
  startDate: string;
  minute: number;
  snapshot: OddsFreeMatchSnapshot;
  outcome: Outcome;
  final: { home: number; away: number };
  over25: 0 | 1;
}

export function isUsableHistoricalMatch(m: ScrapedMatch): boolean {
  return m.state === 'post' && m.hasDetailedFlow && m.events.length >= 10;
}

export function sortByDate<T extends { startDate: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.startDate.localeCompare(b.startDate));
}

/** Chronological split by MATCH (never by sample) so no match appears in both halves. */
export function splitChronological(
  matches: ScrapedMatch[],
  testFraction: number
): { train: ScrapedMatch[]; test: ScrapedMatch[] } {
  const usable = sortByDate(matches.filter(isUsableHistoricalMatch));
  const cut = Math.max(0, Math.min(usable.length, Math.floor(usable.length * (1 - testFraction))));
  return { train: usable.slice(0, cut), test: usable.slice(cut) };
}

export function buildSamples(matches: ScrapedMatch[], minutes: number[]): EvalSample[] {
  const samples: EvalSample[] = [];
  for (const m of matches) {
    if (!isUsableHistoricalMatch(m)) continue;
    const total = m.homeScore + m.awayScore;
    for (const minute of minutes) {
      samples.push({
        matchId: m.id,
        startDate: m.startDate,
        minute,
        snapshot: reconstructSnapshotAtMinute(m, minute),
        outcome: outcomeOf(m.homeScore, m.awayScore),
        final: { home: m.homeScore, away: m.awayScore },
        over25: total > 2.5 ? 1 : 0,
      });
    }
  }
  return samples;
}

/* -------------------------------------------------------------------------- */
/* Baselines                                                                   */
/* -------------------------------------------------------------------------- */

export const UNIFORM_PROBS: Probs3 = { home: 1 / 3, draw: 1 / 3, away: 1 / 3 };

export function climatology(trainMatches: ScrapedMatch[]): Probs3 {
  const usable = trainMatches.filter(isUsableHistoricalMatch);
  if (usable.length === 0) return UNIFORM_PROBS;
  let h = 0;
  let d = 0;
  let a = 0;
  for (const m of usable) {
    const o = outcomeOf(m.homeScore, m.awayScore);
    if (o === 'H') h += 1;
    else if (o === 'D') d += 1;
    else a += 1;
  }
  // Laplace smoothing keeps log loss finite
  const n = usable.length + 3;
  return { home: (h + 1) / n, draw: (d + 1) / n, away: (a + 1) / n };
}

export function leagueGoalRates(trainMatches: ScrapedMatch[]): { home90: number; away90: number } {
  const usable = trainMatches.filter(isUsableHistoricalMatch);
  if (usable.length === 0) return { home90: 1.45, away90: 1.15 };
  return {
    home90: usable.reduce((s, m) => s + m.homeScore, 0) / usable.length,
    away90: usable.reduce((s, m) => s + m.awayScore, 0) / usable.length,
  };
}

function poissonPmf(k: number, lambda: number): number {
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p *= lambda / i;
  return p;
}

/** Outcome probabilities from independent Poisson remaining goals given the current score. */
export function poissonProbs3(lamHome: number, lamAway: number, curHome: number, curAway: number, maxGoals = 12): Probs3 {
  let h = 0;
  let d = 0;
  let a = 0;
  for (let i = 0; i <= maxGoals; i++) {
    const pi = poissonPmf(i, lamHome);
    for (let j = 0; j <= maxGoals; j++) {
      const pj = poissonPmf(j, lamAway);
      const diff = curHome + i - (curAway + j);
      if (diff > 0) h += pi * pj;
      else if (diff < 0) a += pi * pj;
      else d += pi * pj;
    }
  }
  return normalise3({ home: h, draw: d, away: a });
}

export function poissonOverProb(lamTotalRemaining: number, currentTotal: number, line = 2.5): number {
  let under = 0;
  for (let k = 0; k <= 20; k++) {
    if (currentTotal + k < line) under += poissonPmf(k, lamTotalRemaining);
  }
  return 1 - under;
}

/**
 * The key baseline: the score and the clock, and nothing else. Flat league-average scoring
 * rates for the time remaining. If the flow model cannot beat this, its shot/corner/momentum
 * features add no predictive value.
 */
export function scoreStateBaseline(
  sample: EvalSample,
  rates: { home90: number; away90: number }
): { probs: Probs3; over25: number } {
  const remaining = Math.max(0, 90 - sample.snapshot.minute) / 90;
  const lh = rates.home90 * remaining;
  const la = rates.away90 * remaining;
  const cur = sample.snapshot;
  return {
    probs: poissonProbs3(lh, la, cur.homeScore, cur.awayScore),
    over25: poissonOverProb(lh + la, cur.homeScore + cur.awayScore, 2.5),
  };
}

/* -------------------------------------------------------------------------- */
/* Scoring a predictor                                                         */
/* -------------------------------------------------------------------------- */

export type Predictor = (sample: EvalSample) => { probs: Probs3; over25: number };

export function modelPredictor(
  modelState: Parameters<typeof predictMatchMarkets>[1],
  params?: Parameters<typeof predictMatchMarkets>[2]
): Predictor {
  return (sample) => {
    const pred = predictMatchMarkets(sample.snapshot, modelState, params);
    const w = pred.markets.winner1X2;
    const ou = pred.markets.overUnder.find((x) => Math.abs(x.line - 2.5) < 1e-6);
    return {
      probs: normalise3({ home: w.homeProb, draw: w.drawProb, away: w.awayProb }),
      over25: ou ? ou.overProb : 0.5,
    };
  };
}

export function constantPredictor(probs: Probs3): Predictor {
  return () => ({ probs, over25: 0.5 });
}

export interface MetricSummary {
  n: number;
  brier: number;
  rps: number;
  logLoss: number;
  over25Brier: number;
  over25LogLoss: number;
  /** Reliability of P(home win) and of P(over 2.5). */
  homeWinEce: number;
  over25Ece: number;
  homeWinBins: ReliabilityBin[];
}

export interface ScoredSamples {
  summary: MetricSummary;
  /** Per-sample losses aligned with the input order, for paired bootstrap. */
  logLossPerSample: number[];
  rpsPerSample: number[];
}

export function scoreSamples(samples: EvalSample[], predict: Predictor): ScoredSamples {
  const logLossPerSample: number[] = [];
  const rpsPerSample: number[] = [];
  let brier = 0;
  let rps = 0;
  let ll = 0;
  let o25b = 0;
  let o25l = 0;
  const homePairs: { p: number; y: 0 | 1 }[] = [];
  const overPairs: { p: number; y: 0 | 1 }[] = [];

  for (const s of samples) {
    const { probs, over25 } = predict(s);
    const b = brier3(probs, s.outcome);
    const r = rps3(probs, s.outcome);
    const l = logLoss3(probs, s.outcome);
    brier += b;
    rps += r;
    ll += l;
    o25b += brierBinary(over25, s.over25);
    o25l += logLossBinary(over25, s.over25);
    logLossPerSample.push(l);
    rpsPerSample.push(r);
    homePairs.push({ p: probs.home, y: s.outcome === 'H' ? 1 : 0 });
    overPairs.push({ p: over25, y: s.over25 });
  }

  const n = Math.max(1, samples.length);
  const homeBins = reliabilityBins(homePairs);
  return {
    summary: {
      n: samples.length,
      brier: brier / n,
      rps: rps / n,
      logLoss: ll / n,
      over25Brier: o25b / n,
      over25LogLoss: o25l / n,
      homeWinEce: expectedCalibrationError(homeBins),
      over25Ece: expectedCalibrationError(reliabilityBins(overPairs)),
      homeWinBins: homeBins,
    },
    logLossPerSample,
    rpsPerSample,
  };
}

/* -------------------------------------------------------------------------- */
/* Paired cluster bootstrap                                                    */
/* -------------------------------------------------------------------------- */

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BootstrapResult {
  /** mean(lossA - lossB): NEGATIVE means A is better (lower loss). */
  meanDiff: number;
  lo: number;
  hi: number;
  clusters: number;
}

/**
 * 95% CI for mean(lossA - lossB), resampling whole MATCHES (clusters) because several
 * snapshot minutes from one match are strongly correlated.
 */
export function pairedClusterBootstrap(
  lossA: number[],
  lossB: number[],
  clusterIds: string[],
  iterations = 2000,
  seed = 12345
): BootstrapResult {
  if (lossA.length !== lossB.length || lossA.length !== clusterIds.length) {
    throw new Error('pairedClusterBootstrap: mismatched input lengths');
  }
  const byCluster = new Map<string, { sum: number; count: number }>();
  for (let i = 0; i < lossA.length; i++) {
    const c = byCluster.get(clusterIds[i]) ?? { sum: 0, count: 0 };
    c.sum += lossA[i] - lossB[i];
    c.count += 1;
    byCluster.set(clusterIds[i], c);
  }
  const clusters = Array.from(byCluster.values());
  const totalCount = clusters.reduce((s, c) => s + c.count, 0);
  const totalSum = clusters.reduce((s, c) => s + c.sum, 0);
  const meanDiff = totalCount ? totalSum / totalCount : 0;
  if (clusters.length < 2) return { meanDiff, lo: meanDiff, hi: meanDiff, clusters: clusters.length };

  const rand = mulberry32(seed);
  const means: number[] = [];
  for (let it = 0; it < iterations; it++) {
    let s = 0;
    let c = 0;
    for (let k = 0; k < clusters.length; k++) {
      const pick = clusters[Math.floor(rand() * clusters.length)];
      s += pick.sum;
      c += pick.count;
    }
    means.push(c ? s / c : 0);
  }
  means.sort((x, y) => x - y);
  return {
    meanDiff,
    lo: means[Math.floor(0.025 * (means.length - 1))],
    hi: means[Math.ceil(0.975 * (means.length - 1))],
    clusters: clusters.length,
  };
}

/** Skill score vs a reference: 1 = perfect, 0 = no better than the reference, <0 = worse. */
export function skillScore(score: number, reference: number): number {
  return reference > 0 ? 1 - score / reference : 0;
}

/** Convert the app's stored (÷3) mean Brier to a skill score vs a uniform guess. */
export function storedBrierSkillVsUniform(storedMeanBrier: number): number {
  return skillScore(storedMeanBrier * STORED_TO_STANDARD_BRIER, UNIFORM_BRIER_STANDARD);
}
