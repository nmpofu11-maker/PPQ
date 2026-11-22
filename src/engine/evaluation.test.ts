import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STORED_TO_STANDARD_BRIER,
  UNIFORM_BRIER_STANDARD,
  UNIFORM_PROBS,
  brier3,
  buildSamples,
  expectedCalibrationError,
  logLoss3,
  pairedClusterBootstrap,
  poissonOverProb,
  poissonProbs3,
  reliabilityBins,
  rps3,
  scoreStateBaseline,
  skillScore,
  splitChronological,
  storedBrierSkillVsUniform,
} from './evaluation';
import { reconstructSnapshotAtMinute } from './momentumMath';
import { syntheticHistory, syntheticFinishedMatch } from './__fixtures__/syntheticMatches';

test('scoring rules: uniform guess has the textbook values', () => {
  assert.ok(Math.abs(brier3(UNIFORM_PROBS, 'H') - UNIFORM_BRIER_STANDARD) < 1e-12);
  assert.ok(Math.abs(logLoss3(UNIFORM_PROBS, 'D') - Math.log(3)) < 1e-12);
  // RPS of a uniform forecast for an ordered 3-outcome event
  assert.ok(Math.abs(rps3(UNIFORM_PROBS, 'H') - (((1 / 3 - 1) ** 2 + (2 / 3 - 1) ** 2) / 2)) < 1e-12);
  // perfect forecast
  assert.equal(brier3({ home: 1, draw: 0, away: 0 }, 'H'), 0);
  assert.equal(rps3({ home: 0, draw: 0, away: 1 }, 'A'), 0);
});

test('the app stores Brier divided by 3; a uniform guess is exactly zero skill on that scale', () => {
  assert.equal(STORED_TO_STANDARD_BRIER, 3);
  assert.ok(Math.abs(storedBrierSkillVsUniform(2 / 9)) < 1e-12);
  assert.ok(storedBrierSkillVsUniform(0.1) > 0);
  assert.ok(storedBrierSkillVsUniform(0.3) < 0);
  assert.equal(skillScore(0.5, 1), 0.5);
});

test('reliability: perfectly calibrated forecasts give ~0 ECE, overconfident ones do not', () => {
  const calibrated: { p: number; y: 0 | 1 }[] = [];
  for (let i = 0; i < 1000; i++) calibrated.push({ p: 0.7, y: i < 700 ? 1 : 0 });
  assert.ok(expectedCalibrationError(reliabilityBins(calibrated)) < 1e-9);

  const overconfident: { p: number; y: 0 | 1 }[] = [];
  for (let i = 0; i < 1000; i++) overconfident.push({ p: 0.9, y: i < 600 ? 1 : 0 });
  assert.ok(expectedCalibrationError(reliabilityBins(overconfident)) > 0.25);
});

test('poisson helpers are proper distributions and respect the current score', () => {
  const p = poissonProbs3(0.8, 0.6, 1, 0);
  assert.ok(Math.abs(p.home + p.draw + p.away - 1) < 1e-9);
  assert.ok(p.home > p.away);
  const finished = poissonProbs3(0, 0, 2, 1);
  assert.ok(finished.home > 0.999);
  assert.ok(poissonOverProb(0, 3, 2.5) > 0.999, 'already over the line');
  assert.ok(poissonOverProb(0, 1, 2.5) < 0.001);
});

test('chronological split never mixes a match across train and test and keeps time order', () => {
  const matches = syntheticHistory(50);
  const { train, test } = splitChronological(matches, 0.3);
  assert.equal(train.length + test.length, matches.filter((m) => m.events.length >= 10).length);
  const trainIds = new Set(train.map((m) => m.id));
  assert.ok(test.every((m) => !trainIds.has(m.id)));
  const lastTrain = train[train.length - 1].startDate;
  assert.ok(test.every((m) => m.startDate >= lastTrain));
});

test('reconstructed snapshots are causal: no future events and no full-match possession', () => {
  const m = syntheticFinishedMatch(3);
  m.homeStats.possessionPct = 77;
  m.awayStats.possessionPct = 23;
  const snap = reconstructSnapshotAtMinute(m, 30);
  assert.equal(snap.homeStats.possessionPct, null);
  assert.equal(snap.awayStats.possessionPct, null);
  assert.ok(snap.events.every((e) => e.minute <= 30));
  const goalsByThen = m.events.filter((e) => e.minute <= 30 && e.eventType === 'goal');
  assert.equal(snap.homeScore + snap.awayScore, goalsByThen.length);
});

test('score-state baseline ignores shots and corners entirely', () => {
  const samples = buildSamples(syntheticHistory(8), [60]);
  const rates = { home90: 1.5, away90: 1.2 };
  const a = samples[0];
  const b = {
    ...a,
    snapshot: {
      ...a.snapshot,
      homeStats: { ...a.snapshot.homeStats, shotsOnTarget: 99, totalShots: 120, wonCorners: 40 },
    },
  };
  assert.deepEqual(scoreStateBaseline(a, rates), scoreStateBaseline(b, rates));
});

test('paired cluster bootstrap: detects a consistently better model and a null difference', () => {
  const ids: string[] = [];
  const a: number[] = [];
  const b: number[] = [];
  for (let m = 0; m < 60; m++) {
    for (let k = 0; k < 3; k++) {
      ids.push(`m${m}`);
      b.push(1.0 + ((m * 7 + k) % 5) * 0.01);
      a.push(0.9 + ((m * 7 + k) % 5) * 0.01); // consistently 0.1 lower loss
    }
  }
  const better = pairedClusterBootstrap(a, b, ids, 500);
  assert.ok(better.hi < 0 && better.meanDiff < -0.09);

  const same = pairedClusterBootstrap(b, b, ids, 200);
  assert.equal(same.meanDiff, 0);
  assert.equal(same.lo, 0);
  assert.equal(same.hi, 0);

  assert.throws(() => pairedClusterBootstrap([1], [1, 2], ['a'], 10));
});
