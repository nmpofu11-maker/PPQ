import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveMatchInsights } from './matchInsights';
import { createInitialModelState } from '../engine/learningModel';
import { syntheticFinishedMatch, liveOdds } from '../engine/__fixtures__/syntheticMatches';
import type { ScrapedMatch } from '../types/soccer';

function liveMatch(id: string, odds: ScrapedMatch['scrapedOdds']): ScrapedMatch {
  return { ...syntheticFinishedMatch(1), id, state: 'in', minute: 60, scrapedOdds: odds };
}

const model = createInitialModelState();

test('produces a prediction and trend list for every match', () => {
  const ms = [liveMatch('a', liveOdds()), liveMatch('b', liveOdds())];
  const out = deriveMatchInsights({
    matches: ms,
    modelState: model,
    minEvThreshold: 0.5,
    verifiedLiveOnly: true,
    scopedMatchIds: new Set(['a', 'b']),
  });
  assert.equal(out.predictionsByMatch.size, 2);
  assert.equal(out.trendsByMatch.size, 2);
  assert.equal(out.alertsByMatch.size, 2);
});

test('only scoped matches feed the flat alert and trend lists', () => {
  const ms = [liveMatch('a', liveOdds()), liveMatch('b', liveOdds())];
  const out = deriveMatchInsights({
    matches: ms,
    modelState: model,
    minEvThreshold: 0,
    verifiedLiveOnly: true,
    scopedMatchIds: new Set(['a']),
  });
  assert.ok(out.allAlerts.every((a) => a.matchId === 'a'));
  assert.ok(out.allTrends.every((t) => t.matchId === 'a'));
  // per-match maps still cover unscoped matches
  assert.ok(out.predictionsByMatch.has('b'));
});

test('verified-live-only drops alerts built on non-live odds; opting out restores them', () => {
  const stale = liveMatch('a', liveOdds({ isLive: false }));
  const base = { matches: [stale], modelState: model, minEvThreshold: 0, scopedMatchIds: new Set(['a']) };
  const strict = deriveMatchInsights({ ...base, verifiedLiveOnly: true });
  assert.equal(strict.allAlerts.length, 0);
  const loose = deriveMatchInsights({ ...base, verifiedLiveOnly: false });
  assert.ok(loose.allAlerts.length > 0, 'non-live odds produce alerts once the safeguard is switched off');
});

test('alerts are sorted by EV descending', () => {
  const out = deriveMatchInsights({
    matches: [liveMatch('a', liveOdds()), liveMatch('b', liveOdds({ homeMoneyline: '+400' }))],
    modelState: model,
    minEvThreshold: 0,
    verifiedLiveOnly: true,
    scopedMatchIds: new Set(['a', 'b']),
  });
  for (let i = 1; i < out.allAlerts.length; i++) {
    assert.ok(out.allAlerts[i - 1].evPct >= out.allAlerts[i].evPct);
  }
});
