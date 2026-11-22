import test from 'node:test';
import assert from 'node:assert/strict';
import { runBacktest, evaluateLiveLog, MIN_TEST_MATCHES_FOR_VERDICT } from './backtestCore';
import { acceptFit, fitParams } from './fitCore';
import { DEFAULT_PARAMS, PARAM_BOUNDS, getModelParams, isUsingFittedParams } from '../../src/engine/modelParams';
import { createInitialModelState } from '../../src/engine/learningModel';
import { liveOdds, syntheticFinishedMatch, syntheticHistory } from '../../src/engine/__fixtures__/syntheticMatches';
import { predictMatchMarkets, reconstructSnapshotAtMinute, toOddsFreeSnapshot } from '../../src/engine/momentumMath';
import { evaluateBettingValue } from '../../src/engine/valueDetector';
import { recordNewPaperBets } from '../../src/engine/paperLedger';

test('committed params are the unfitted defaults until a real fit passes the held-out checks', () => {
  assert.equal(isUsingFittedParams(), false);
  assert.deepEqual(getModelParams(), DEFAULT_PARAMS);
});

test('runBacktest reports all methods and refuses a verdict on a small hold-out', () => {
  const report = runBacktest(syntheticHistory(40), { minutes: [30, 60], testFraction: 0.3, learn: false, bootstrapIterations: 100 });
  assert.equal(report.verdict, 'underpowered');
  assert.ok(report.matches.test < MIN_TEST_MATCHES_FOR_VERDICT);
  for (const k of ['uniform', 'climatology', 'scoreState', 'model'] as const) {
    assert.ok(Number.isFinite(report.methods[k].logLoss), k);
    assert.ok(report.methods[k].n > 0);
  }
  // uniform baseline is exactly ln(3) log loss
  assert.ok(Math.abs(report.methods.uniform.logLoss - Math.log(3)) < 1e-9);
  assert.equal(report.perMinute.length, 2);
});

test('fitParams never makes the training objective worse and stays inside its bounds', () => {
  const train = syntheticHistory(30);
  const fit = fitParams(train, { minutes: [30, 60], passes: 1, candidatesPerSide: 1 });
  assert.ok(fit.fittedLogLoss <= fit.startLogLoss + 1e-9);
  for (const k of Object.keys(PARAM_BOUNDS) as (keyof typeof PARAM_BOUNDS)[]) {
    const [lo, hi] = PARAM_BOUNDS[k];
    assert.ok(fit.params[k] >= lo && fit.params[k] <= hi, k);
  }
});

test('acceptFit refuses to bless a fit when the held-out set is too small', () => {
  const history = syntheticHistory(40);
  const decision = acceptFit(history, DEFAULT_PARAMS, { minutes: [30, 60], testFraction: 0.3, bootstrapIterations: 100 });
  assert.equal(decision.accept, false);
  assert.ok(decision.reasons.some((r) => r.includes('held-out matches')));
});

test('shrinkage tempers early-match extrapolation without changing the legacy default', () => {
  const m = syntheticFinishedMatch(11);
  const snap = reconstructSnapshotAtMinute(m, 20);
  // a lively 20 minutes on every attacking metric, so shrinking toward the league prior lowers the rate
  snap.homeStats.shotsOnTarget = 2;
  snap.homeStats.totalShots = 4;
  snap.homeStats.wonCorners = 2;
  const model = createInitialModelState();
  const legacy = predictMatchMarkets(snap, model, DEFAULT_PARAMS);
  const shrunk = predictMatchMarkets(snap, model, { ...DEFAULT_PARAMS, shrinkMinutes: 40 });
  assert.ok(shrunk.homeLambdaRem < legacy.homeLambdaRem);
  // zero shrinkage reproduces the original maths exactly
  const again = predictMatchMarkets(snap, model, { ...DEFAULT_PARAMS, shrinkMinutes: 0 });
  assert.equal(again.homeLambdaRem, legacy.homeLambdaRem);
});

test('value detection defaults to verified-live odds only; opting out is explicit', () => {
  const base = syntheticFinishedMatch(5);
  const live = {
    ...base,
    state: 'in' as const,
    minute: 60,
    homeScore: 0,
    awayScore: 0,
    scrapedOdds: liveOdds({ isLive: false, homeMoneyline: '+900', drawMoneyline: '+900', awayMoneyline: '+900' }),
  };
  const pred = predictMatchMarkets(toOddsFreeSnapshot(live), createInitialModelState());
  assert.equal(evaluateBettingValue(live, pred, 0.5).length, 0, 'stale pre-match odds produce no alerts by default');
  assert.ok(evaluateBettingValue(live, pred, 0.5, { verifiedLiveOnly: false }).length > 0, 'explicit opt-out still works');
});

test('paper ledger only records bets priced off verified-live odds', () => {
  const base = syntheticFinishedMatch(6);
  const live = {
    ...base,
    state: 'in' as const,
    minute: 60,
    homeScore: 0,
    awayScore: 0,
    scrapedOdds: liveOdds({ isLive: false, homeMoneyline: '+900', drawMoneyline: '+900', awayMoneyline: '+900' }),
  };
  const pred = predictMatchMarkets(toOddsFreeSnapshot(live), createInitialModelState());
  const unverified = evaluateBettingValue(live, pred, 0.5, { verifiedLiveOnly: false });
  assert.ok(unverified.length > 0);
  assert.ok(unverified.every((a) => a.oddsVerifiedLive === false));
  const result = recordNewPaperBets({ existingBets: [], alerts: unverified, matchesById: new Map([[live.id, live]]) });
  assert.equal(result.addedBets.length, 0);
});

test('evaluateLiveLog settles recorded alerts against the final score and flags thin samples', () => {
  const base = syntheticFinishedMatch(7);
  const inPlay = {
    ...base,
    state: 'in' as const,
    minute: 60,
    homeScore: 0,
    awayScore: 0,
    scrapedOdds: liveOdds({ homeMoneyline: '+900', drawMoneyline: '+900', awayMoneyline: '+900' }),
  };
  const final = { ...base, state: 'post' as const, minute: 90, homeScore: 2, awayScore: 0, events: [] };
  const report = evaluateLiveLog(
    [
      { capturedAt: '2026-11-21T15:00:00Z', match: inPlay },
      { capturedAt: '2026-11-21T16:50:00Z', match: final },
    ],
    createInitialModelState(),
    DEFAULT_PARAMS,
    0.5
  );
  assert.ok(report.alertsPlaced > 0);
  assert.equal(report.settled, report.alertsPlaced);
  assert.ok(report.realisedRoiPct !== null);
  assert.match(report.note, /variance/);
});
