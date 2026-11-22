import type {
  DetectedTrendSignal,
  ModelIntelligencePayload,
  PureFlowPrediction,
  ScrapedMatch,
  ValueAlert,
} from '../types/soccer';
import { predictMatchMarkets, toOddsFreeSnapshot } from '../engine/momentumMath';
import { detectAttackTrends } from '../engine/trendDetector';
import { evaluateBettingValue } from '../engine/valueDetector';

export interface MatchInsights {
  predictionsByMatch: Map<string, PureFlowPrediction>;
  alertsByMatch: Map<string, ValueAlert[]>;
  allAlerts: ValueAlert[];
  trendsByMatch: Map<string, DetectedTrendSignal[]>;
  allTrends: DetectedTrendSignal[];
}

/**
 * Pure-flow predictions (100% odds-free), rolling attack trends and Stage-2 +EV alerts for
 * every scraped match. `scopedMatchIds` limits which matches feed the flat alert/trend lists.
 */
export function deriveMatchInsights(params: {
  matches: ScrapedMatch[];
  modelState: Pick<ModelIntelligencePayload, 'globalWeights' | 'team_intelligence_matrices'>;
  minEvThreshold: number;
  verifiedLiveOnly: boolean;
  scopedMatchIds: Set<string>;
}): MatchInsights {
  const { matches, modelState, minEvThreshold, verifiedLiveOnly, scopedMatchIds } = params;
  const predictionsByMatch = new Map<string, PureFlowPrediction>();
  const alertsByMatch = new Map<string, ValueAlert[]>();
  const trendsByMatch = new Map<string, DetectedTrendSignal[]>();
  const allAlerts: ValueAlert[] = [];
  const allTrends: DetectedTrendSignal[] = [];

  for (const m of matches) {
    const snap = toOddsFreeSnapshot(m);
    const pred = predictMatchMarkets(snap, modelState);
    predictionsByMatch.set(m.id, pred);

    const matchTrends = detectAttackTrends(snap, pred, 10);
    trendsByMatch.set(m.id, matchTrends);
    const evs = evaluateBettingValue(m, pred, minEvThreshold, { verifiedLiveOnly });
    alertsByMatch.set(m.id, evs);

    if (scopedMatchIds.has(m.id)) {
      allTrends.push(...matchTrends);
      allAlerts.push(...evs);
    }
  }

  allAlerts.sort((a, b) => b.evPct - a.evPct);
  allTrends.sort((a, b) => b.intensityScore - a.intensityScore);
  return { predictionsByMatch, alertsByMatch, allAlerts, trendsByMatch, allTrends };
}
