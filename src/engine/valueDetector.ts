import type {
  MarketCategory,
  PureFlowPrediction,
  ScrapedMatch,
  ValueAlert,
} from '../types/soccer';

/**
 * Converts American odds string (e.g. "+155", "-188", "EVEN") to Decimal odds.
 */
export function americanToDecimal(americanStr: string | null | undefined): number | null {
  if (!americanStr) return null;
  const cleaned = americanStr.trim().toUpperCase();
  if (cleaned === 'EVEN' || cleaned === 'PK') return 2.0;
  const num = Number(cleaned.replace(/[^0-9+\-.]/g, ''));
  if (!Number.isFinite(num) || num === 0) return null;
  if (num > 0) {
    return Number((1 + num / 100).toFixed(3));
  }
  return Number((1 + 100 / Math.abs(num)).toFixed(3));
}

export function decimalToAmerican(decimalOdds: number): string {
  if (!Number.isFinite(decimalOdds) || decimalOdds <= 1.01) return 'OFF';
  if (Math.abs(decimalOdds - 2) < 0.005) return 'EVEN';
  if (decimalOdds >= 2) {
    return `+${Math.round((decimalOdds - 1) * 100)}`;
  }
  return `-${Math.round(100 / (decimalOdds - 1))}`;
}

export function decimalToImpliedProbability(decimalOdds: number): number {
  if (!Number.isFinite(decimalOdds) || decimalOdds <= 1) return 1;
  return 1 / decimalOdds;
}

export function probabilityToFairDecimalOdds(prob: number): number {
  if (prob <= 0.005) return 200;
  return Number((1 / prob).toFixed(2));
}

function buildAlert(params: {
  match: ScrapedMatch;
  prediction: PureFlowPrediction;
  market: MarketCategory;
  selection: string;
  modelProbability: number;
  americanOdds: string | null;
  decimalOddsOverride?: number | null;
  isLiveOdds: boolean;
  provider: string;
  oddsSourceNote?: string;
}): ValueAlert | null {
  const decimalOdds =
    params.decimalOddsOverride && params.decimalOddsOverride > 1.01
      ? Number(params.decimalOddsOverride.toFixed(3))
      : americanToDecimal(params.americanOdds);
  if (!decimalOdds || decimalOdds <= 1.01) return null;

  const americanDisplay = params.americanOdds || decimalToAmerican(decimalOdds);
  const impliedProb = decimalToImpliedProbability(decimalOdds);
  const evPct = (params.modelProbability * decimalOdds - 1) * 100;

  // Quarter-Kelly sizing bounded between 0% and 10%
  const rawKelly = (params.modelProbability * decimalOdds - 1) / (decimalOdds - 1);
  const kellyFractionPct = Math.max(0, Math.min(10, rawKelly * 0.25 * 100));

  const confidenceTier: ValueAlert['confidenceTier'] =
    evPct >= 8 ? 'Strong Edge' : evPct >= 3 ? 'Moderate Edge' : 'Watch';

  const oddsVerifiedLive = Boolean(params.isLiveOdds);
  const oddsSourceNote =
    params.oddsSourceNote ||
    (oddsVerifiedLive
      ? `Verified Live (${params.provider})`
      : `Pre-Match / Unverified Live (${params.provider})`);

  return {
    id: `${params.match.id}_${params.market}_${params.selection}`.replace(/[^a-zA-Z0-9_-]/g, '_'),
    matchId: params.match.id,
    league: params.match.league,
    matchTitle: `${params.match.homeTeam} vs ${params.match.awayTeam}`,
    state: params.match.state,
    minute: params.match.minute,
    scoreline: `${params.match.homeScore}-${params.match.awayScore}`,
    market: params.market,
    selection: params.selection,
    modelProbability: Number(params.modelProbability.toFixed(4)),
    fairDecimalOdds: probabilityToFairDecimalOdds(params.modelProbability),
    bookmakerOddsAmerican: americanDisplay,
    bookmakerOddsDecimal: decimalOdds,
    impliedProbability: Number(impliedProb.toFixed(4)),
    evPct: Number(evPct.toFixed(2)),
    kellyFractionPct: Number(kellyFractionPct.toFixed(2)),
    isLiveOdds: params.isLiveOdds,
    oddsVerifiedLive,
    oddsSourceNote,
    provider: params.provider,
    evidenceSummary: params.prediction.evidenceReasons.slice(0, 2).join(' · '),
    confidenceTier,
  };
}

export interface EvaluateValueOptions {
  verifiedLiveOnly?: boolean;
}

/**
 * STAGE 2 ONLY (Post-Prediction Odds Firewall):
 * Compares already-computed pure-flow probabilities against scraped bookmaker odds
 * strictly to surface positive Expected Value (+EV) alerts on live matches with active match flow.
 */
export function evaluateBettingValue(
  match: ScrapedMatch,
  prediction: PureFlowPrediction,
  minEvThresholdPct = 2.0,
  options?: EvaluateValueOptions
): ValueAlert[] {
  const odds = match.scrapedOdds;
  if (!odds || match.state !== 'in') return [];
  if (options?.verifiedLiveOnly && !odds.isLive) return [];
  if (match.minute < 3 && !match.hasDetailedFlow) return [];

  const candidates: (ValueAlert | null)[] = [];

  // 1. Match Winner (1X2)
  candidates.push(
    buildAlert({
      match,
      prediction,
      market: 'Match Winner (1X2)',
      selection: `${match.homeTeam} Win`,
      modelProbability: prediction.markets.winner1X2.homeProb,
      americanOdds: odds.homeMoneyline,
      isLiveOdds: odds.isLive,
      provider: odds.provider,
    }),
    buildAlert({
      match,
      prediction,
      market: 'Match Winner (1X2)',
      selection: 'Draw',
      modelProbability: prediction.markets.winner1X2.drawProb,
      americanOdds: odds.drawMoneyline,
      isLiveOdds: odds.isLive,
      provider: odds.provider,
    }),
    buildAlert({
      match,
      prediction,
      market: 'Match Winner (1X2)',
      selection: `${match.awayTeam} Win`,
      modelProbability: prediction.markets.winner1X2.awayProb,
      americanOdds: odds.awayMoneyline,
      isLiveOdds: odds.isLive,
      provider: odds.provider,
    })
  );

  // 2. Double Chance (1X, X2, 12) mathematically derived via live 1X2 Dutching when active legs exist
  const dHome = americanToDecimal(odds.homeMoneyline);
  const dDraw = americanToDecimal(odds.drawMoneyline);
  const dAway = americanToDecimal(odds.awayMoneyline);
  const dutchNote = odds.isLive
    ? `Verified Live (${odds.provider} 1X2 Dutch)`
    : `Pre-Match / Unverified Live (${odds.provider} 1X2 Dutch)`;

  if (dHome && dDraw) {
    const dc1XDecimal = 1 / (1 / dHome + 1 / dDraw);
    if (dc1XDecimal > 1.02) {
      candidates.push(
        buildAlert({
          match,
          prediction,
          market: 'Double Chance',
          selection: `${match.homeTeam} or Draw (1X)`,
          modelProbability: prediction.markets.doubleChance.homeOrDrawProb,
          americanOdds: decimalToAmerican(dc1XDecimal),
          decimalOddsOverride: dc1XDecimal,
          isLiveOdds: odds.isLive,
          provider: `${odds.provider} 1X2 Dutch`,
          oddsSourceNote: dutchNote,
        })
      );
    }
  }
  if (dAway && dDraw) {
    const dcX2Decimal = 1 / (1 / dAway + 1 / dDraw);
    if (dcX2Decimal > 1.02) {
      candidates.push(
        buildAlert({
          match,
          prediction,
          market: 'Double Chance',
          selection: `${match.awayTeam} or Draw (X2)`,
          modelProbability: prediction.markets.doubleChance.awayOrDrawProb,
          americanOdds: decimalToAmerican(dcX2Decimal),
          decimalOddsOverride: dcX2Decimal,
          isLiveOdds: odds.isLive,
          provider: `${odds.provider} 1X2 Dutch`,
          oddsSourceNote: dutchNote,
        })
      );
    }
  }
  if (dHome && dAway) {
    const dc12Decimal = 1 / (1 / dHome + 1 / dAway);
    if (dc12Decimal > 1.02) {
      candidates.push(
        buildAlert({
          match,
          prediction,
          market: 'Double Chance',
          selection: `${match.homeTeam} or ${match.awayTeam} (12)`,
          modelProbability: prediction.markets.doubleChance.homeOrAwayProb,
          americanOdds: decimalToAmerican(dc12Decimal),
          decimalOddsOverride: dc12Decimal,
          isLiveOdds: odds.isLive,
          provider: `${odds.provider} 1X2 Dutch`,
          oddsSourceNote: dutchNote,
        })
      );
    }
  }

  // 3. Over / Under Goals matching the scraped total line
  if (odds.totalLine !== null) {
    const matchedLine = prediction.markets.overUnder.find(
      (ou) => Math.abs(ou.line - odds.totalLine!) < 0.05
    );
    if (matchedLine) {
      candidates.push(
        buildAlert({
          match,
          prediction,
          market: 'Over / Under Goals',
          selection: `Over ${matchedLine.line} Goals`,
          modelProbability: matchedLine.overProb,
          americanOdds: odds.overOdds,
          isLiveOdds: odds.isLive,
          provider: odds.provider,
        }),
        buildAlert({
          match,
          prediction,
          market: 'Over / Under Goals',
          selection: `Under ${matchedLine.line} Goals`,
          modelProbability: matchedLine.underProb,
          americanOdds: odds.underOdds,
          isLiveOdds: odds.isLive,
          provider: odds.provider,
        })
      );
    }
  }

  // 4. Asian Handicap / Spread matching scraped spread line
  if (odds.spreadLine !== null) {
    const matchedAh = prediction.markets.asianHandicap.find(
      (ah) => Math.abs(ah.line - odds.spreadLine!) < 0.05
    );
    if (matchedAh) {
      const denom = matchedAh.homeCoverProb + matchedAh.awayCoverProb || 1;
      candidates.push(
        buildAlert({
          match,
          prediction,
          market: 'Asian Handicap / Spread',
          selection: `${match.homeTeam} (${matchedAh.line >= 0 ? '+' : ''}${matchedAh.line})`,
          modelProbability: matchedAh.homeCoverProb / denom,
          americanOdds: odds.homeSpreadOdds,
          isLiveOdds: odds.isLive,
          provider: odds.provider,
        }),
        buildAlert({
          match,
          prediction,
          market: 'Asian Handicap / Spread',
          selection: `${match.awayTeam} (${-matchedAh.line >= 0 ? '+' : ''}${-matchedAh.line})`,
          modelProbability: matchedAh.awayCoverProb / denom,
          americanOdds: odds.awaySpreadOdds,
          isLiveOdds: odds.isLive,
          provider: odds.provider,
        })
      );
    }
  }

  return candidates
    .filter((a): a is ValueAlert => a !== null && a.evPct >= minEvThresholdPct)
    .sort((a, b) => b.evPct - a.evPct);
}
