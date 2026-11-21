import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeMomentumTimeline,
  predictMatchMarkets,
  reconstructSnapshotAtMinute,
  toOddsFreeSnapshot,
} from './momentumMath';
import { createInitialModelState, evaluateAndUpdateModel } from './learningModel';
import { evaluateBettingValue } from './valueDetector';
import type { ScrapedMatch } from '../types/soccer';

function buildFixtureMatch(): ScrapedMatch {
  return {
    id: 'test_match_1',
    league: 'Test League',
    leagueSlug: 'eng.1',
    startDate: '2026-11-20T18:00:00Z',
    state: 'in',
    minute: 62,
    statusText: "62'",
    venue: 'Test Stadium',
    homeTeam: 'Arsenal',
    homeAbbr: 'ARS',
    awayTeam: 'Chelsea',
    awayAbbr: 'CHE',
    homeScore: 1,
    awayScore: 1,
    homeStats: {
      possessionPct: 64,
      totalShots: 14,
      shotsOnTarget: 7,
      wonCorners: 8,
      foulsCommitted: 6,
      yellowCards: 1,
      redCards: 0,
      offsides: 1,
      saves: 2,
      formScore: 0.65,
      lastFiveSummary: ['W 2-0', 'W 3-1', 'D 1-1', 'W 1-0', 'W 2-1'],
    },
    awayStats: {
      possessionPct: 36,
      totalShots: 5,
      shotsOnTarget: 2,
      wonCorners: 2,
      foulsCommitted: 11,
      yellowCards: 3,
      redCards: 1,
      offsides: 2,
      saves: 6,
      formScore: 0.1,
      lastFiveSummary: ['D 0-0', 'L 1-2', 'W 1-0', 'D 2-2', 'L 0-1'],
    },
    events: [
      {
        id: 'e1',
        minute: 18,
        clockDisplay: "18'",
        sequence: 1,
        teamSide: 'home',
        eventType: 'goal',
        text: 'Goal! Home scores.',
      },
      {
        id: 'e2',
        minute: 34,
        clockDisplay: "34'",
        sequence: 2,
        teamSide: 'away',
        eventType: 'goal',
        text: 'Goal! Away equalizes.',
      },
      {
        id: 'e3',
        minute: 54,
        clockDisplay: "54'",
        sequence: 3,
        teamSide: 'away',
        eventType: 'red_card',
        text: 'Red card shown to away defender.',
      },
      {
        id: 'e4',
        minute: 58,
        clockDisplay: "58'",
        sequence: 4,
        teamSide: 'home',
        eventType: 'shot_on_target',
        text: 'Saved shot on target by home striker.',
      },
      {
        id: 'e5',
        minute: 60,
        clockDisplay: "60'",
        sequence: 5,
        teamSide: 'home',
        eventType: 'corner',
        text: 'Corner won by home side.',
      },
      {
        id: 'e6',
        minute: 78,
        clockDisplay: "78'",
        sequence: 6,
        teamSide: 'home',
        eventType: 'goal',
        text: 'Late goal at 78th minute.',
      },
    ],
    hasDetailedFlow: true,
    bbcCrossCheck: { matched: false, scoreLabel: null },
    scrapedOdds: {
      provider: 'DraftKings',
      isLive: true,
      homeMoneyline: '+140',
      drawMoneyline: '+220',
      awayMoneyline: '+290',
      totalLine: 2.5,
      overOdds: '-120',
      underOdds: '+100',
      spreadLine: -0.5,
      homeSpreadOdds: '+135',
      awaySpreadOdds: '-160',
    },
    lastUpdated: '2026-11-20T19:02:00Z',
  };
}

test('pure-flow probabilities sum cleanly to 1.0 across all markets and favor dominant momentum side', () => {
  const match = buildFixtureMatch();
  const model = createInitialModelState();
  const snapshot = toOddsFreeSnapshot(match);
  const prediction = predictMatchMarkets(snapshot, model);

  const sum1x2 =
    prediction.markets.winner1X2.homeProb +
    prediction.markets.winner1X2.drawProb +
    prediction.markets.winner1X2.awayProb;
  assert.ok(Math.abs(sum1x2 - 1) < 1e-6);

  const sumNext =
    prediction.markets.nextTeamToScore.homeProb +
    prediction.markets.nextTeamToScore.awayProb +
    prediction.markets.nextTeamToScore.noGoalProb;
  assert.ok(Math.abs(sumNext - 1) < 1e-6);

  assert.ok(prediction.netMomentum > 0, 'Home side with 64% possession, 7 SoT, and man advantage must have positive net momentum');
  assert.ok(
    prediction.markets.winner1X2.homeProb > prediction.markets.winner1X2.awayProb,
    'Home win prob must exceed away win prob under overwhelming match flow'
  );
  assert.ok(
    prediction.markets.nextTeamToScore.homeProb > prediction.markets.nextTeamToScore.awayProb
  );
});

test('odds firewall: changing scraped odds does not alter pure-flow predictions', () => {
  const matchA = buildFixtureMatch();
  const matchB = buildFixtureMatch();
  matchB.scrapedOdds = {
    provider: 'DraftKings',
    isLive: true,
    homeMoneyline: '+900',
    drawMoneyline: '+900',
    awayMoneyline: '-900',
    totalLine: 4.5,
    overOdds: '+400',
    underOdds: '-600',
    spreadLine: 1.5,
    homeSpreadOdds: '-900',
    awaySpreadOdds: '+500',
  };

  const model = createInitialModelState();
  const predA = predictMatchMarkets(toOddsFreeSnapshot(matchA), model);
  const predB = predictMatchMarkets(toOddsFreeSnapshot(matchB), model);

  assert.deepEqual(predA.markets, predB.markets);
  assert.equal(predA.netMomentum, predB.netMomentum);

  // Stage 2 EV detector DOES react to +900 home odds
  const alertsB = evaluateBettingValue(matchB, predB, 5.0);
  assert.ok(alertsB.some((a) => a.selection.includes('Arsenal Win') && a.evPct > 50));
});

test('reconstructSnapshotAtMinute enforces strict causal cut-off (no future leakage)', () => {
  const match = buildFixtureMatch();
  match.state = 'post';
  match.homeScore = 2;
  match.awayScore = 1;
  const snap65 = reconstructSnapshotAtMinute(match, 65);

  assert.equal(snap65.homeScore, 1);
  assert.equal(snap65.awayScore, 1);
  assert.ok(snap65.events.every((e) => e.minute <= 65));
});

test('online learning model calibrates weights and populates team intelligence matrices', () => {
  const match = buildFixtureMatch();
  match.state = 'post';
  match.minute = 90;
  match.homeScore = 2;
  match.awayScore = 1;

  const initial = createInitialModelState();
  const { nextState, processedCount } = evaluateAndUpdateModel([match], initial, 65);

  assert.equal(processedCount, 1);
  assert.equal(nextState.metrics.totalEvaluated, 1);
  assert.ok(nextState.team_intelligence_matrices['arsenal'].sample_size_matches === 1);
  assert.ok(nextState.team_intelligence_matrices['chelsea'].sample_size_matches === 1);
  assert.ok(nextState.recentAudits.length === 1);
  const timeline = computeMomentumTimeline(toOddsFreeSnapshot(match), nextState.globalWeights);
  assert.equal(timeline.length, 90);
  const redMin = timeline.find((p) => p.minute === 54);
  assert.ok(redMin?.majorEvents?.some((e) => e.type === 'red_card' && e.side === 'away'));
});
