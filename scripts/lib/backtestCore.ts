import type { ModelIntelligencePayload, PaperBetRecord, ScrapedMatch } from '../../src/types/soccer';
import {
  UNIFORM_PROBS,
  buildSamples,
  climatology,
  constantPredictor,
  leagueGoalRates,
  modelPredictor,
  pairedClusterBootstrap,
  scoreSamples,
  scoreStateBaseline,
  splitChronological,
  type BootstrapResult,
  type MetricSummary,
} from '../../src/engine/evaluation';
import { createInitialModelState, evaluateAndUpdateModel } from '../../src/engine/learningModel';
import { getModelParams, isUsingFittedParams, type StructuralParams } from '../../src/engine/modelParams';
import {
  predictMatchMarkets,
  toOddsFreeSnapshot,
} from '../../src/engine/momentumMath';
import { evaluateBettingValue } from '../../src/engine/valueDetector';
import {
  computePaperLedgerSummary,
  evaluateSinglePaperBetOutcome,
  recordNewPaperBets,
} from '../../src/engine/paperLedger';
import type { LiveLogRecord } from './dataset';

export interface BacktestOptions {
  minutes: number[];
  testFraction: number;
  /** Replay the online learning loop over the training period, then freeze it for the test period. */
  learn: boolean;
  params?: StructuralParams;
  bootstrapIterations?: number;
}

export type Verdict = 'model_better' | 'model_worse' | 'inconclusive' | 'underpowered';

export interface BacktestReport {
  usingFittedParams: boolean;
  params: StructuralParams;
  matches: { total: number; train: number; test: number };
  minutes: number[];
  baselineRates: { home90: number; away90: number };
  methods: Record<'uniform' | 'climatology' | 'scoreState' | 'model', MetricSummary>;
  perMinute: { minute: number; model: MetricSummary; scoreState: MetricSummary }[];
  modelVsScoreState: { logLoss: BootstrapResult; rps: BootstrapResult };
  modelVsClimatology: { logLoss: BootstrapResult };
  verdict: Verdict;
  verdictText: string;
}

/** Minimum held-out matches before a verdict is anything but "underpowered". */
export const MIN_TEST_MATCHES_FOR_VERDICT = 150;

export function learnedModelState(trainMatches: ScrapedMatch[], learn: boolean): ModelIntelligencePayload {
  const initial = createInitialModelState();
  if (!learn || trainMatches.length === 0) return initial;
  const ordered = [...trainMatches].sort((a, b) => a.startDate.localeCompare(b.startDate));
  return evaluateAndUpdateModel(ordered, initial, 65, []).nextState;
}

export function runBacktest(matches: ScrapedMatch[], opts: BacktestOptions): BacktestReport {
  const params = opts.params ?? getModelParams();
  const { train, test } = splitChronological(matches, opts.testFraction);
  const modelState = learnedModelState(train, opts.learn);
  const rates = leagueGoalRates(train);
  const clim = climatology(train);

  const samples = buildSamples(test, opts.minutes);
  const model = scoreSamples(samples, modelPredictor(modelState, params));
  const scoreState = scoreSamples(samples, (s) => scoreStateBaseline(s, rates));
  const climScored = scoreSamples(samples, constantPredictor(clim));
  const uniform = scoreSamples(samples, constantPredictor(UNIFORM_PROBS));

  const ids = samples.map((s) => s.matchId);
  const iters = opts.bootstrapIterations ?? 2000;
  const vsScoreLL = pairedClusterBootstrap(model.logLossPerSample, scoreState.logLossPerSample, ids, iters);
  const vsScoreRps = pairedClusterBootstrap(model.rpsPerSample, scoreState.rpsPerSample, ids, iters);
  const vsClimLL = pairedClusterBootstrap(model.logLossPerSample, climScored.logLossPerSample, ids, iters);

  const perMinute = opts.minutes.map((minute) => {
    const subset = samples.filter((s) => s.minute === minute);
    return {
      minute,
      model: scoreSamples(subset, modelPredictor(modelState, params)).summary,
      scoreState: scoreSamples(subset, (s) => scoreStateBaseline(s, rates)).summary,
    };
  });

  let verdict: Verdict;
  let verdictText: string;
  if (test.length < MIN_TEST_MATCHES_FOR_VERDICT) {
    verdict = 'underpowered';
    verdictText = `Only ${test.length} held-out matches (< ${MIN_TEST_MATCHES_FOR_VERDICT}). Collect more history before drawing conclusions.`;
  } else if (vsScoreLL.hi < 0) {
    verdict = 'model_better';
    verdictText = 'The flow model beats the score-and-clock baseline on log loss (95% CI entirely below zero).';
  } else if (vsScoreLL.lo > 0) {
    verdict = 'model_worse';
    verdictText = 'The flow model is WORSE than the score-and-clock baseline: its shot/corner/momentum features add noise.';
  } else {
    verdict = 'inconclusive';
    verdictText = 'The 95% CI for log-loss difference vs the score-and-clock baseline includes zero: no demonstrated value.';
  }

  return {
    usingFittedParams: opts.params ? false : isUsingFittedParams(),
    params,
    matches: { total: matches.length, train: train.length, test: test.length },
    minutes: opts.minutes,
    baselineRates: rates,
    methods: {
      uniform: uniform.summary,
      climatology: climScored.summary,
      scoreState: scoreState.summary,
      model: model.summary,
    },
    perMinute,
    modelVsScoreState: { logLoss: vsScoreLL, rps: vsScoreRps },
    modelVsClimatology: { logLoss: vsClimLL },
    verdict,
    verdictText,
  };
}

/* -------------------------------------------------------------------------- */
/* Realised +EV evaluation from a recorded live log                            */
/* -------------------------------------------------------------------------- */

export interface EvAlertReport {
  alertsPlaced: number;
  settled: number;
  hitRate: number | null;
  meanModelProbability: number | null;
  meanExpectedEvPct: number | null;
  realisedRoiPct: number | null;
  roiCi95: [number, number] | null;
  note: string;
}

export function evaluateLiveLog(
  records: LiveLogRecord[],
  modelState: ModelIntelligencePayload,
  params: StructuralParams,
  minEvPct = 3
): EvAlertReport {
  const byMatch = new Map<string, LiveLogRecord[]>();
  for (const r of records) {
    const list = byMatch.get(r.match.id) ?? [];
    list.push(r);
    byMatch.set(r.match.id, list);
  }

  let bets: PaperBetRecord[] = [];
  const finals = new Map<string, { home: number; away: number }>();
  for (const [id, list] of byMatch) {
    list.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    const post = [...list].reverse().find((r) => r.match.state === 'post');
    if (post) finals.set(id, { home: post.match.homeScore, away: post.match.awayScore });

    for (const rec of list) {
      const m = rec.match;
      if (m.state !== 'in' || !m.scrapedOdds) continue;
      const prediction = predictMatchMarkets(toOddsFreeSnapshot(m), modelState, params);
      const alerts = evaluateBettingValue(m, prediction, minEvPct, { verifiedLiveOnly: true });
      bets = recordNewPaperBets({
        existingBets: bets,
        alerts,
        matchesById: new Map([[m.id, m]]),
        nowIso: rec.capturedAt,
      }).nextBets;
    }
  }

  let staked = 0;
  let profit = 0;
  let wins = 0;
  let settled = 0;
  const perBetReturns: number[] = [];
  for (const bet of bets) {
    const fin = finals.get(bet.matchId);
    if (!fin) continue;
    const res = evaluateSinglePaperBetOutcome(bet, fin.home, fin.away);
    if (!res) continue;
    settled += 1;
    staked += bet.stakeUnits;
    profit += res.profitUnits;
    if (res.profitUnits > 0) wins += 1;
    perBetReturns.push(bet.stakeUnits > 0 ? res.profitUnits / bet.stakeUnits : 0);
  }
  // keep the summary helper exercised so ledger maths stays the single source of truth
  void computePaperLedgerSummary(bets);

  const roi = staked > 0 ? (profit / staked) * 100 : null;
  let ci: [number, number] | null = null;
  if (perBetReturns.length >= 20) {
    const means: number[] = [];
    let seed = 7;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let it = 0; it < 2000; it++) {
      let s = 0;
      for (let k = 0; k < perBetReturns.length; k++) s += perBetReturns[Math.floor(rand() * perBetReturns.length)];
      means.push((s / perBetReturns.length) * 100);
    }
    means.sort((a, b) => a - b);
    ci = [means[Math.floor(0.025 * (means.length - 1))], means[Math.ceil(0.975 * (means.length - 1))]];
  }

  const placed = bets.length;
  return {
    alertsPlaced: placed,
    settled,
    hitRate: settled ? wins / settled : null,
    meanModelProbability: placed ? bets.reduce((s, b) => s + b.modelProbability, 0) / placed : null,
    meanExpectedEvPct: placed ? bets.reduce((s, b) => s + b.evPct, 0) / placed : null,
    realisedRoiPct: roi,
    roiCi95: ci,
    note:
      settled < 100
        ? `Only ${settled} settled alerts. ROI from this few bets is dominated by variance and says nothing reliable about edge.`
        : 'Compare realised ROI (and its CI) with the mean expected EV: a large gap means the model is over-confident versus the market.',
  };
}
