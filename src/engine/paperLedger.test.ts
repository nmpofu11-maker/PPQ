import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computePaperLedgerSummary,
  evaluateSinglePaperBetOutcome,
  recordNewPaperBets,
  settlePaperBets,
} from './paperLedger';
import type { PaperBetRecord, ScrapedMatch, ValueAlert } from '../types/soccer';

function makeStats() {
  return {
    possessionPct: 55,
    totalShots: 8,
    shotsOnTarget: 4,
    wonCorners: 5,
    foulsCommitted: 6,
    yellowCards: 1,
    redCards: 0,
    offsides: 1,
    saves: 2,
    formScore: 0.4,
    lastFiveSummary: ['W', 'W', 'D'],
  };
}

function makeMatch(overrides: Partial<ScrapedMatch> = {}): ScrapedMatch {
  return {
    id: 'm100',
    league: 'English Premier League',
    leagueSlug: 'eng.1',
    startDate: '2026-11-20T18:00:00Z',
    state: 'in',
    minute: 62,
    statusText: "62'",
    venue: 'Emirates',
    homeTeam: 'Arsenal',
    homeAbbr: 'ARS',
    awayTeam: 'Chelsea',
    awayAbbr: 'CHE',
    homeScore: 1,
    awayScore: 1,
    homeStats: makeStats(),
    awayStats: makeStats(),
    events: [],
    hasDetailedFlow: true,
    bbcCrossCheck: { matched: false, scoreLabel: null },
    scrapedOdds: null,
    lastUpdated: '2026-11-20T19:02:00Z',
    ...overrides,
  };
}

function makeAlert(overrides: Partial<ValueAlert> = {}): ValueAlert {
  return {
    id: 'a100',
    matchId: 'm100',
    league: 'English Premier League',
    matchTitle: 'Arsenal vs Chelsea',
    state: 'in',
    minute: 62,
    scoreline: '1-1',
    market: 'Match Winner (1X2)',
    selection: 'Arsenal Win',
    modelProbability: 0.56,
    fairDecimalOdds: 1.79,
    bookmakerOddsAmerican: '+110',
    bookmakerOddsDecimal: 2.1,
    impliedProbability: 0.4762,
    evPct: 17.6,
    kellyFractionPct: 4.0,
    isLiveOdds: true,
    oddsVerifiedLive: true,
    oddsSourceNote: 'Verified Live (DraftKings)',
    provider: 'DraftKings',
    evidenceSummary: 'Dominant shots on target',
    confidenceTier: 'Strong Edge',
    ...overrides,
  };
}

test('recordNewPaperBets creates deduplicated open bets scaled by 1/4-Kelly units', () => {
  const match = makeMatch();
  const matchesById = new Map([[match.id, match]]);
  const alert1 = makeAlert();
  const watchAlert = makeAlert({
    id: 'watch1',
    selection: 'Draw',
    evPct: 2.1,
    confidenceTier: 'Watch',
  });

  const first = recordNewPaperBets({
    existingBets: [],
    alerts: [alert1, watchAlert],
    matchesById,
    nowIso: '2026-11-20T19:02:00Z',
  });
  assert.equal(first.addedBets.length, 1);
  assert.equal(first.nextBets[0].stakeUnits, 4);
  assert.equal(first.nextBets[0].status, 'open');

  // Re-running on next 30s poll does not duplicate same selection
  const repeat = recordNewPaperBets({
    existingBets: first.nextBets,
    alerts: [alert1],
    matchesById,
    nowIso: '2026-11-20T19:02:30Z',
  });
  assert.equal(repeat.addedBets.length, 0);
  assert.equal(repeat.nextBets.length, 1);
});

test('evaluateSinglePaperBetOutcome settles 1X2, Double Chance, Over/Under push, and Quarter-Ball Asian Handicap accurately', () => {
  const baseBet: PaperBetRecord = {
    id: 'b1',
    matchId: 'm100',
    league: 'EPL',
    matchTitle: 'Arsenal vs Chelsea',
    homeTeam: 'Arsenal',
    awayTeam: 'Chelsea',
    minutePlaced: 60,
    scoreAtPlacement: '1-1',
    market: 'Match Winner (1X2)',
    selection: 'Arsenal Win',
    confidenceTier: 'Strong Edge',
    modelProbability: 0.56,
    bookmakerOddsDecimal: 2.1,
    bookmakerOddsAmerican: '+110',
    evPct: 17.6,
    stakeUnits: 2,
    oddsVerifiedLive: true,
    status: 'open',
    finalScore: null,
    profitUnits: 0,
    placedAt: '2026-11-20T19:00:00Z',
    settledAt: null,
  };

  // 1X2 win
  assert.deepEqual(evaluateSinglePaperBetOutcome(baseBet, 2, 1), {
    status: 'won',
    profitUnits: 2.2,
  });

  // Double Chance 1X on draw
  assert.deepEqual(
    evaluateSinglePaperBetOutcome(
      { ...baseBet, market: 'Double Chance', selection: 'Arsenal or Draw (1X)', bookmakerOddsDecimal: 1.5 },
      1,
      1
    ),
    { status: 'won', profitUnits: 1.0 }
  );

  // Over/Under exact integer push
  assert.deepEqual(
    evaluateSinglePaperBetOutcome(
      { ...baseBet, market: 'Over / Under Goals', selection: 'Over 2.0 Goals' },
      1,
      1
    ),
    { status: 'push', profitUnits: 0 }
  );

  // Asian Handicap -0.25 with Draw -> half-loss (-1.0u on 2u stake)
  assert.deepEqual(
    evaluateSinglePaperBetOutcome(
      { ...baseBet, market: 'Asian Handicap / Spread', selection: 'Arsenal (-0.25)' },
      1,
      1
    ),
    { status: 'lost', profitUnits: -1.0 }
  );

  // Asian Handicap +0.25 with Draw -> half-win (+1.1u on 2u @ 2.10)
  assert.deepEqual(
    evaluateSinglePaperBetOutcome(
      { ...baseBet, market: 'Asian Handicap / Spread', selection: 'Arsenal (+0.25)' },
      1,
      1
    ),
    { status: 'won', profitUnits: 1.1 }
  );
});

test('settlePaperBets and computePaperLedgerSummary calculate ROI, drawdown, and equity curve', () => {
  const openBet1: PaperBetRecord = {
    id: 'b1',
    matchId: 'm1',
    league: 'EPL',
    matchTitle: 'Arsenal vs Chelsea',
    homeTeam: 'Arsenal',
    awayTeam: 'Chelsea',
    minutePlaced: 60,
    scoreAtPlacement: '1-1',
    market: 'Match Winner (1X2)',
    selection: 'Arsenal Win',
    confidenceTier: 'Strong Edge',
    modelProbability: 0.55,
    bookmakerOddsDecimal: 2.2,
    bookmakerOddsAmerican: '+120',
    evPct: 21.0,
    stakeUnits: 2.0,
    oddsVerifiedLive: true,
    status: 'open',
    finalScore: null,
    profitUnits: 0,
    placedAt: '2026-11-20T18:00:00Z',
    settledAt: null,
  };
  const openBet2: PaperBetRecord = {
    ...openBet1,
    id: 'b2',
    matchId: 'm2',
    matchTitle: 'Liverpool vs Everton',
    homeTeam: 'Liverpool',
    awayTeam: 'Everton',
    selection: 'Everton Win',
    confidenceTier: 'Moderate Edge',
    evPct: 5.5,
    stakeUnits: 1.0,
    placedAt: '2026-11-20T19:00:00Z',
  };

  const settled = settlePaperBets({
    bets: [openBet1, openBet2],
    finishedMatches: [
      makeMatch({ id: 'm1', state: 'post', homeScore: 2, awayScore: 1 }),
      makeMatch({ id: 'm2', state: 'post', homeTeam: 'Liverpool', awayTeam: 'Everton', homeScore: 3, awayScore: 0 }),
    ],
    nowIso: '2026-11-20T20:00:00Z',
  });

  assert.equal(settled.settledBets.length, 2);
  const summary = computePaperLedgerSummary(settled.nextBets);
  assert.equal(summary.wins, 1);
  assert.equal(summary.losses, 1);
  assert.equal(summary.totalStakedUnits, 3.0);
  // +2.4 on b1 then -1.0 on b2 => net +1.4u, drawdown 1.0u
  assert.equal(summary.netProfitUnits, 1.4);
  assert.equal(summary.maxDrawdownUnits, 1.0);
  assert.equal(summary.strongTierProfitUnits, 2.4);
  assert.equal(summary.moderateTierProfitUnits, -1.0);
  assert.equal(summary.equityCurve.length, 3);
});
