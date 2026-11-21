import test from 'node:test';
import assert from 'node:assert/strict';
import { predictMatchMarkets, toOddsFreeSnapshot } from './momentumMath';
import { createInitialModelState } from './learningModel';
import { detectAttackTrends } from './trendDetector';
import type { ScrapedMatch } from '../types/soccer';

test('detects Persistent Attack Surge and Shots-on-Goal Barrage from rolling 10-minute match flow', () => {
  const match: ScrapedMatch = {
    id: 'trend_test_1',
    league: 'Test Premier League',
    leagueSlug: 'eng.1',
    startDate: '2026-11-20T18:00:00Z',
    state: 'in',
    minute: 62,
    statusText: "62'",
    venue: 'Test Arena',
    homeTeam: 'Liverpool',
    homeAbbr: 'LIV',
    awayTeam: 'Everton',
    awayAbbr: 'EVE',
    homeScore: 0,
    awayScore: 0,
    homeStats: {
      possessionPct: 68,
      totalShots: 13,
      shotsOnTarget: 6,
      wonCorners: 7,
      foulsCommitted: 5,
      yellowCards: 1,
      redCards: 0,
      offsides: 1,
      saves: 1,
      formScore: 0.7,
      lastFiveSummary: ['W 2-0'],
    },
    awayStats: {
      possessionPct: 32,
      totalShots: 2,
      shotsOnTarget: 1,
      wonCorners: 1,
      foulsCommitted: 12,
      yellowCards: 2,
      redCards: 0,
      offsides: 2,
      saves: 5,
      formScore: -0.2,
      lastFiveSummary: ['L 0-2'],
    },
    events: [
      { id: '1', minute: 53, clockDisplay: "53'", sequence: 1, teamSide: 'home', eventType: 'corner', text: 'Corner, Liverpool.' },
      { id: '2', minute: 55, clockDisplay: "55'", sequence: 2, teamSide: 'home', eventType: 'shot_on_target', text: 'Attempt saved. Close range header by Liverpool.' },
      { id: '3', minute: 57, clockDisplay: "57'", sequence: 3, teamSide: 'home', eventType: 'corner', text: 'Corner, Liverpool.' },
      { id: '4', minute: 59, clockDisplay: "59'", sequence: 4, teamSide: 'home', eventType: 'shot_off_target', text: 'Attempt missed. Left footed shot from the center of the box.' },
      { id: '5', minute: 61, clockDisplay: "61'", sequence: 5, teamSide: 'home', eventType: 'shot_on_target', text: 'Attempt saved. Low drive from 12 yards.' },
    ],
    hasDetailedFlow: true,
    bbcCrossCheck: { matched: false, scoreLabel: null },
    scrapedOdds: null,
    lastUpdated: '2026-11-20T19:02:00Z',
  };

  const model = createInitialModelState();
  const snap = toOddsFreeSnapshot(match);
  const pred = predictMatchMarkets(snap, model);
  const trends = detectAttackTrends(snap, pred, 10);

  assert.equal(trends.length, 1);
  assert.equal(trends[0].teamName, 'Liverpool');
  assert.ok(trends[0].patterns.includes('Persistent Attack Surge'));
  assert.ok(trends[0].patterns.includes('Shots-on-Goal Barrage'));
  assert.equal(trends[0].recentShotsOnTarget, 2);
  assert.equal(trends[0].recentCorners, 2);
});
