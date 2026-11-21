import type {
  PaperBetRecord,
  PaperBetStatus,
  PaperLedgerSummary,
  ScrapedMatch,
  ValueAlert,
} from '../types/soccer';

/**
 * Computes unit stake directly from the alert's bounded 1/4-Kelly sizing (1% = 1 unit).
 * Minimum 0.25u when +EV qualifies, capped at 5.0u per position to avoid concentration risk.
 */
export function computeKellyUnits(kellyFractionPct: number): number {
  const clamped = Math.max(0.25, Math.min(5.0, kellyFractionPct));
  return Number(clamped.toFixed(2));
}

export function buildPaperBetId(alert: ValueAlert): string {
  return `pb_${alert.matchId}_${alert.market}_${alert.selection}`
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 120);
}

/**
 * Automatically records genuine live +EV edges into the paper-bet ledger without duplicating
 * active/settled bets for the exact same fixture, market, and selection.
 */
export function recordNewPaperBets(params: {
  existingBets: PaperBetRecord[];
  alerts: ValueAlert[];
  matchesById: Map<string, ScrapedMatch>;
  nowIso?: string;
}): {
  nextBets: PaperBetRecord[];
  addedBets: PaperBetRecord[];
} {
  const { existingBets, alerts, matchesById, nowIso = new Date().toISOString() } = params;
  const existingIds = new Set(existingBets.map((b) => b.id));
  const addedBets: PaperBetRecord[] = [];

  for (const al of alerts) {
    if (al.state !== 'in' || al.evPct <= 0 || al.confidenceTier === 'Watch') continue;
    // A paper ledger is only meaningful if it is priced off odds that really were live.
    if (!al.oddsVerifiedLive) continue;
    const betId = buildPaperBetId(al);
    if (existingIds.has(betId)) continue;

    const match = matchesById.get(al.matchId);
    if (!match || match.state !== 'in') continue;

    existingIds.add(betId);
    addedBets.push({
      id: betId,
      matchId: al.matchId,
      league: al.league,
      matchTitle: al.matchTitle,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      minutePlaced: al.minute,
      scoreAtPlacement: al.scoreline,
      market: al.market,
      selection: al.selection,
      confidenceTier: al.confidenceTier,
      modelProbability: al.modelProbability,
      bookmakerOddsDecimal: al.bookmakerOddsDecimal,
      bookmakerOddsAmerican: al.bookmakerOddsAmerican,
      evPct: al.evPct,
      stakeUnits: computeKellyUnits(al.kellyFractionPct),
      oddsVerifiedLive: al.oddsVerifiedLive,
      status: 'open',
      finalScore: null,
      profitUnits: 0,
      placedAt: nowIso,
      settledAt: null,
    });
  }

  if (addedBets.length === 0) {
    return { nextBets: existingBets, addedBets: [] };
  }

  return {
    nextBets: [...addedBets, ...existingBets].slice(0, 250),
    addedBets,
  };
}

/**
 * Evaluates a settled finished match (`state === 'post'`) for a specific paper bet.
 * Supports 1X2, Double Chance (1X, X2, 12), Over/Under (including integer push),
 * and Asian Handicap (full, half, and quarter-ball split outcomes).
 */
export function evaluateSinglePaperBetOutcome(
  bet: PaperBetRecord,
  homeScore: number,
  awayScore: number
): { status: Exclude<PaperBetStatus, 'open'>; profitUnits: number } | null {
  const margin = homeScore - awayScore;
  const totalGoals = homeScore + awayScore;

  if (bet.market === 'Match Winner (1X2)') {
    let won = false;
    if (bet.selection === 'Draw') {
      won = margin === 0;
    } else if (bet.selection === `${bet.homeTeam} Win`) {
      won = margin > 0;
    } else if (bet.selection === `${bet.awayTeam} Win`) {
      won = margin < 0;
    } else {
      return null;
    }
    return {
      status: won ? 'won' : 'lost',
      profitUnits: Number(
        (won ? bet.stakeUnits * (bet.bookmakerOddsDecimal - 1) : -bet.stakeUnits).toFixed(3)
      ),
    };
  }

  if (bet.market === 'Double Chance') {
    let won = false;
    if (bet.selection.includes('(1X)')) {
      won = margin >= 0;
    } else if (bet.selection.includes('(X2)')) {
      won = margin <= 0;
    } else if (bet.selection.includes('(12)')) {
      won = margin !== 0;
    } else {
      return null;
    }
    return {
      status: won ? 'won' : 'lost',
      profitUnits: Number(
        (won ? bet.stakeUnits * (bet.bookmakerOddsDecimal - 1) : -bet.stakeUnits).toFixed(3)
      ),
    };
  }

  if (bet.market === 'Over / Under Goals') {
    const matchOu = bet.selection.match(/^(Over|Under)\s+([0-9]+(?:\.[0-9]+)?)/i);
    if (!matchOu) return null;
    const side = matchOu[1].toLowerCase();
    const line = Number(matchOu[2]);
    if (!Number.isFinite(line)) return null;

    if (Math.abs(totalGoals - line) < 1e-6) {
      return { status: 'push', profitUnits: 0 };
    }
    const won = side === 'over' ? totalGoals > line : totalGoals < line;
    return {
      status: won ? 'won' : 'lost',
      profitUnits: Number(
        (won ? bet.stakeUnits * (bet.bookmakerOddsDecimal - 1) : -bet.stakeUnits).toFixed(3)
      ),
    };
  }

  if (bet.market === 'Asian Handicap / Spread') {
    const ahMatch = bet.selection.match(/^(.*)\s+\(([+-]?[0-9]+(?:\.[0-9]+)?)\)$/);
    if (!ahMatch) return null;
    const teamPart = ahMatch[1].trim();
    const line = Number(ahMatch[2]);
    if (!Number.isFinite(line)) return null;

    const isHome = teamPart === bet.homeTeam;
    const isAway = teamPart === bet.awayTeam;
    if (!isHome && !isAway) return null;

    const teamMargin = isHome ? margin : -margin;
    const diff = teamMargin + line;

    // Quarter-ball split handling
    const frac = Math.abs(diff - Math.round(diff));
    if (Math.abs(diff) < 1e-6) {
      return { status: 'push', profitUnits: 0 };
    }
    if (Math.abs(frac - 0.25) < 1e-4) {
      if (diff > 0) {
        const profit = bet.stakeUnits * 0.5 * (bet.bookmakerOddsDecimal - 1);
        return { status: 'won', profitUnits: Number(profit.toFixed(3)) };
      }
      const loss = -bet.stakeUnits * 0.5;
      return { status: 'lost', profitUnits: Number(loss.toFixed(3)) };
    }

    const won = diff > 0;
    return {
      status: won ? 'won' : 'lost',
      profitUnits: Number(
        (won ? bet.stakeUnits * (bet.bookmakerOddsDecimal - 1) : -bet.stakeUnits).toFixed(3)
      ),
    };
  }

  return null;
}

/**
 * Settles any open paper bets whose matches are now finished (`state === 'post'`).
 */
export function settlePaperBets(params: {
  bets: PaperBetRecord[];
  finishedMatches: ScrapedMatch[];
  nowIso?: string;
}): {
  nextBets: PaperBetRecord[];
  settledBets: PaperBetRecord[];
} {
  const { bets, finishedMatches, nowIso = new Date().toISOString() } = params;
  const finishedById = new Map<string, ScrapedMatch>();
  for (const m of finishedMatches) {
    if (m.state === 'post') finishedById.set(m.id, m);
  }

  const settledBets: PaperBetRecord[] = [];
  const nextBets = bets.map((bet) => {
    if (bet.status !== 'open') return bet;
    const match = finishedById.get(bet.matchId);
    if (!match) return bet;

    const outcome = evaluateSinglePaperBetOutcome(bet, match.homeScore, match.awayScore);
    if (!outcome) return bet;

    const updated: PaperBetRecord = {
      ...bet,
      status: outcome.status,
      profitUnits: outcome.profitUnits,
      finalScore: `${match.homeScore}-${match.awayScore}`,
      settledAt: nowIso,
    };
    settledBets.push(updated);
    return updated;
  });

  return { nextBets, settledBets };
}

export function computePaperLedgerSummary(bets: PaperBetRecord[]): PaperLedgerSummary {
  const openBets = bets.filter((b) => b.status === 'open').length;
  const settled = bets
    .filter((b) => b.status !== 'open')
    .slice()
    .sort((a, b) =>
      (a.settledAt || a.placedAt).localeCompare(b.settledAt || b.placedAt)
    );

  let wins = 0;
  let losses = 0;
  let pushes = 0;
  let totalStakedUnits = 0;
  let netProfitUnits = 0;
  let strongTierProfitUnits = 0;
  let strongTierBets = 0;
  let moderateTierProfitUnits = 0;
  let moderateTierBets = 0;

  let peak = 0;
  let maxDrawdownUnits = 0;
  const equityCurve: { index: number; label: string; cumulativeProfit: number }[] = [
    { index: 0, label: 'Start', cumulativeProfit: 0 },
  ];

  settled.forEach((b, idx) => {
    if (b.status === 'won') wins += 1;
    else if (b.status === 'lost') losses += 1;
    else if (b.status === 'push') pushes += 1;

    totalStakedUnits += b.stakeUnits;
    netProfitUnits += b.profitUnits;

    if (b.confidenceTier === 'Strong Edge') {
      strongTierBets += 1;
      strongTierProfitUnits += b.profitUnits;
    } else if (b.confidenceTier === 'Moderate Edge') {
      moderateTierBets += 1;
      moderateTierProfitUnits += b.profitUnits;
    }

    if (netProfitUnits > peak) peak = netProfitUnits;
    const dd = peak - netProfitUnits;
    if (dd > maxDrawdownUnits) maxDrawdownUnits = dd;

    equityCurve.push({
      index: idx + 1,
      label: `#${idx + 1} ${b.homeTeam.slice(0, 6)}`,
      cumulativeProfit: Number(netProfitUnits.toFixed(2)),
    });
  });

  const decisiveCount = wins + losses;
  const hitRatePct =
    decisiveCount > 0 ? Number(((wins / decisiveCount) * 100).toFixed(1)) : null;
  const roiPct =
    totalStakedUnits > 0
      ? Number(((netProfitUnits / totalStakedUnits) * 100).toFixed(2))
      : null;

  return {
    totalBets: bets.length,
    openBets,
    settledBets: settled.length,
    wins,
    losses,
    pushes,
    hitRatePct,
    totalStakedUnits: Number(totalStakedUnits.toFixed(2)),
    netProfitUnits: Number(netProfitUnits.toFixed(2)),
    roiPct,
    maxDrawdownUnits: Number(maxDrawdownUnits.toFixed(2)),
    strongTierProfitUnits: Number(strongTierProfitUnits.toFixed(2)),
    strongTierBets,
    moderateTierProfitUnits: Number(moderateTierProfitUnits.toFixed(2)),
    moderateTierBets,
    equityCurve,
  };
}
