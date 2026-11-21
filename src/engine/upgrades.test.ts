import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBettingValue } from './valueDetector';
import { predictMatchMarkets, toOddsFreeSnapshot } from './momentumMath';
import { createInitialModelState, evaluateAndUpdateModel } from './learningModel';
import {
  captureLiveMilestoneSnapshots,
  findBestLiveCapturedSnapshot,
} from './snapshotRecorder';
import { filterMatchIdsByAlertScope, isTopTierLeague } from './leagueTiers';
import type { ScrapedMatch } from '../types/soccer';

function buildLiveFixture(overrides: Partial<ScrapedMatch> = {}): ScrapedMatch {
  return {
    id: 'u101',
    league: 'English Premier League',
    leagueSlug: 'eng.1',
    startDate: '2026-11-20T18:00:00Z',
    state: 'in',
    minute: 61,
    statusText: "61'",
    venue: 'Anfield',
    homeTeam: 'Liverpool',
    homeAbbr: 'LIV',
    awayTeam: 'Aston Villa',
    awayAbbr: 'AVL',
    homeScore: 1,
    awayScore: 1,
    homeStats: {
      possessionPct: 68,
      totalShots: 16,
      shotsOnTarget: 8,
      wonCorners: 9,
      foulsCommitted: 5,
      yellowCards: 1,
      redCards: 0,
      offsides: 1,
      saves: 1,
      formScore: 0.75,
      lastFiveSummary: ['W 2-0', 'W 3-1'],
    },
    awayStats: {
      possessionPct: 32,
      totalShots: 4,
      shotsOnTarget: 1,
      wonCorners: 2,
      foulsCommitted: 11,
      yellowCards: 2,
      redCards: 0,
      offsides: 2,
      saves: 6,
      formScore: -0.2,
      lastFiveSummary: ['L 0-2', 'D 1-1'],
    },
    events: [
      {
        id: 'e1',
        minute: 56,
        clockDisplay: "56'",
        sequence: 1,
        teamSide: 'home',
        eventType: 'shot_on_target',
        text: 'Attempt saved by Liverpool.',
      },
      {
        id: 'e2',
        minute: 59,
        clockDisplay: "59'",
        sequence: 2,
        teamSide: 'home',
        eventType: 'corner',
        text: 'Corner, Liverpool.',
      },
    ],
    hasDetailedFlow: true,
    bbcCrossCheck: { matched: true, scoreLabel: '1-1' },
    scrapedOdds: {
      provider: 'DraftKings',
      isLive: true,
      homeMoneyline: '+160',
      drawMoneyline: '+260',
      awayMoneyline: '+210',
      totalLine: 2.5,
      overOdds: '-115',
      underOdds: '-105',
      spreadLine: -0.5,
      homeSpreadOdds: '+155',
      awaySpreadOdds: '-185',
    },
    lastUpdated: '2026-11-20T19:01:00Z',
    ...overrides,
  };
}

test('evaluateBettingValue verifies live odds gate and derives Double Chance alerts cleanly', () => {
  const model = createInitialModelState();
  const liveMatch = buildLiveFixture();
  const pred = predictMatchMarkets(toOddsFreeSnapshot(liveMatch), model);

  const alerts = evaluateBettingValue(liveMatch, pred, 1.0, { verifiedLiveOnly: true });
  assert.ok(alerts.length > 0);
  assert.ok(alerts.every((a) => a.oddsVerifiedLive === true));
  const dcAlerts = alerts.filter((a) => a.market === 'Double Chance');
  assert.ok(dcAlerts.length >= 1, 'Expected at least one +EV Double Chance leg from generous 1X2 pricing');

  // Unverified pre-match fallback odds must be filtered out when verifiedLiveOnly is true
  const preOddsMatch = buildLiveFixture({
    scrapedOdds: { ...liveMatch.scrapedOdds!, isLive: false },
  });
  const blocked = evaluateBettingValue(preOddsMatch, pred, 1.0, { verifiedLiveOnly: true });
  assert.equal(blocked.length, 0);

  const allowedUnverified = evaluateBettingValue(preOddsMatch, pred, 1.0, { verifiedLiveOnly: false });
  assert.ok(allowedUnverified.length > 0);
  assert.equal(allowedUnverified[0].oddsVerifiedLive, false);
  assert.match(allowedUnverified[0].oddsSourceNote, /Pre-Match/);
});

test('captureLiveMilestoneSnapshots records exact 60m snapshot and learningModel prefers it over reconstruction', () => {
  const model = createInitialModelState();
  const liveAt61 = buildLiveFixture({ minute: 61 });

  const captured = captureLiveMilestoneSnapshots({
    liveMatches: [liveAt61],
    existingSnapshots: [],
    modelState: model,
    nowIso: '2026-11-20T19:01:00Z',
  });
  assert.equal(captured.addedSnapshots.length, 1);
  assert.equal(captured.addedSnapshots[0].milestoneMinute, 60);
  assert.equal(captured.addedSnapshots[0].capturedMinute, 61);

  const found = findBestLiveCapturedSnapshot('u101', 65, captured.nextSnapshots);
  assert.ok(found);
  assert.equal(found.id, 'u101_60');

  // Later match finishes 2-1 -> evaluateAndUpdateModel uses the exact captured snapshot
  const finished = buildLiveFixture({
    state: 'post',
    minute: 90,
    homeScore: 2,
    awayScore: 1,
  });
  const learning = evaluateAndUpdateModel([finished], model, 65, captured.nextSnapshots);
  assert.equal(learning.processedCount, 1);
  assert.equal(learning.newAudits[0].snapshotSource, 'exact_live_capture');
  assert.equal(learning.newAudits[0].snapshotMinute, 61);
  assert.match(learning.nextState.meta_improvement_notes, /1 exact live-captured/);
});

test('isTopTierLeague and filterMatchIdsByAlertScope scope alerts cleanly', () => {
  assert.equal(isTopTierLeague('English Premier League', 'eng.1'), true);
  assert.equal(isTopTierLeague('UEFA Champions League', 'uefa.champions'), true);
  assert.equal(isTopTierLeague('Regional Amateur Cup', 'reg.cup'), false);

  const epl = buildLiveFixture({ id: 'm_epl', league: 'English Premier League' });
  const minor = buildLiveFixture({ id: 'm_minor', league: 'Regional Amateur Cup' });

  const topOnly = filterMatchIdsByAlertScope({
    matches: [epl, minor],
    scope: 'top_leagues',
    watchlistIds: new Set(['m_minor']),
  });
  assert.equal(topOnly.has('m_epl'), true);
  assert.equal(topOnly.has('m_minor'), false);

  const watchOnly = filterMatchIdsByAlertScope({
    matches: [epl, minor],
    scope: 'watchlist',
    watchlistIds: new Set(['m_minor']),
  });
  assert.equal(watchOnly.has('m_epl'), false);
  assert.equal(watchOnly.has('m_minor'), true);
});
