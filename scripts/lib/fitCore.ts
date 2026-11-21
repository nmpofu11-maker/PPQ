import type { ScrapedMatch } from '../../src/types/soccer';
import { buildSamples, modelPredictor, scoreSamples, type EvalSample } from '../../src/engine/evaluation';
import { createInitialModelState } from '../../src/engine/learningModel';
import { DEFAULT_PARAMS, PARAM_BOUNDS, type StructuralParams } from '../../src/engine/modelParams';
import { MIN_TEST_MATCHES_FOR_VERDICT, runBacktest, type BacktestReport } from './backtestCore';

export interface FitOptions {
  minutes: number[];
  passes: number;
  /** Candidate offsets per coordinate step, in units of the current step size. */
  candidatesPerSide?: number;
  start?: StructuralParams;
  onProgress?: (msg: string) => void;
}

export interface FitResult {
  params: StructuralParams;
  startLogLoss: number;
  fittedLogLoss: number;
  evaluations: number;
}

function objective(samples: EvalSample[], params: StructuralParams): number {
  const state = createInitialModelState();
  return scoreSamples(samples, modelPredictor(state, params)).summary.logLoss;
}

/**
 * Coordinate descent on mean 3-way log loss over TRAINING matches only, with step sizes
 * that shrink each pass. Deliberately simple and deterministic: with ~11 parameters and a
 * few thousand samples it is hard to overfit badly, and held-out evaluation decides whether
 * the result is kept (see acceptFit).
 */
export function fitParams(trainMatches: ScrapedMatch[], opts: FitOptions): FitResult {
  const samples = buildSamples(trainMatches, opts.minutes);
  const keys = Object.keys(PARAM_BOUNDS) as (keyof StructuralParams)[];
  let current: StructuralParams = { ...(opts.start ?? DEFAULT_PARAMS) };
  let best = objective(samples, current);
  const startLogLoss = best;
  let evaluations = 1;
  const side = opts.candidatesPerSide ?? 2;

  for (let pass = 0; pass < opts.passes; pass++) {
    const shrink = Math.pow(0.5, pass);
    for (const key of keys) {
      const [lo, hi] = PARAM_BOUNDS[key];
      const step = ((hi - lo) / 10) * shrink;
      let bestValue = current[key];
      for (let k = -side; k <= side; k++) {
        if (k === 0) continue;
        const candidate = Math.min(hi, Math.max(lo, current[key] + k * step));
        if (candidate === current[key]) continue;
        const loss = objective(samples, { ...current, [key]: candidate });
        evaluations += 1;
        if (loss < best - 1e-9) {
          best = loss;
          bestValue = candidate;
        }
      }
      current = { ...current, [key]: bestValue };
    }
    opts.onProgress?.(`pass ${pass + 1}/${opts.passes}: train log loss ${best.toFixed(5)}`);
  }

  return { params: current, startLogLoss, fittedLogLoss: best, evaluations };
}

export interface AcceptDecision {
  accept: boolean;
  reasons: string[];
  fittedReport: BacktestReport;
  defaultReport: BacktestReport;
}

/**
 * A fit is only kept if, on matches it never saw, it (a) has enough held-out data,
 * (b) beats the hand-chosen defaults on log loss, and (c) beats the score-and-clock
 * baseline with a 95% CI entirely below zero.
 */
export function acceptFit(
  matches: ScrapedMatch[],
  fitted: StructuralParams,
  opts: { minutes: number[]; testFraction: number; bootstrapIterations?: number }
): AcceptDecision {
  const base = { minutes: opts.minutes, testFraction: opts.testFraction, learn: false, bootstrapIterations: opts.bootstrapIterations };
  const fittedReport = runBacktest(matches, { ...base, params: fitted });
  const defaultReport = runBacktest(matches, { ...base, params: DEFAULT_PARAMS });

  const reasons: string[] = [];
  if (fittedReport.matches.test < MIN_TEST_MATCHES_FOR_VERDICT) {
    reasons.push(`only ${fittedReport.matches.test} held-out matches (need ≥ ${MIN_TEST_MATCHES_FOR_VERDICT})`);
  }
  if (!(fittedReport.methods.model.logLoss < defaultReport.methods.model.logLoss)) {
    reasons.push('fitted parameters do not beat the defaults on held-out log loss');
  }
  if (fittedReport.verdict !== 'model_better') {
    reasons.push(`does not beat the score-and-clock baseline (${fittedReport.verdict})`);
  }
  return { accept: reasons.length === 0, reasons, fittedReport, defaultReport };
}
