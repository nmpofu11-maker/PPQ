import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectAlertPlatform,
  formatOsNotificationPayload,
  selectNewTriggerableAlerts,
  type AlertSeenRegistry,
} from './alertNotifier';
import type { DetectedTrendSignal, ValueAlert } from '../types/soccer';

const sampleAlert: ValueAlert = {
  id: 'a1',
  matchId: '771001',
  league: 'English Premier League',
  matchTitle: 'Arsenal vs Chelsea',
  state: 'in',
  minute: 63,
  scoreline: '1-1',
  market: 'Match Winner (1X2)',
  selection: 'Arsenal Win',
  modelProbability: 0.61,
  fairDecimalOdds: 1.64,
  bookmakerOddsAmerican: '+110',
  bookmakerOddsDecimal: 2.1,
  impliedProbability: 0.476,
  evPct: 28.1,
  kellyFractionPct: 6.4,
  isLiveOdds: true,
  oddsVerifiedLive: true,
  oddsSourceNote: 'Verified Live (DraftKings)',
  provider: 'DraftKings',
  evidenceSummary: 'Sustained final-third pressure',
  confidenceTier: 'Strong Edge',
};

const sampleTrend: DetectedTrendSignal = {
  id: 'tr1',
  matchId: '771001',
  league: 'English Premier League',
  matchTitle: 'Arsenal vs Chelsea',
  minute: 63,
  scoreline: '1-1',
  teamSide: 'home',
  teamName: 'Arsenal',
  patterns: ['Persistent Attack Surge', 'Shots-on-Goal Barrage'],
  patternLabel: 'Persistent Attack Surge · Shots-on-Goal Barrage',
  windowMinutes: 10,
  recentShots: 4,
  recentShotsOnTarget: 3,
  recentCorners: 2,
  consecutiveMomentumMinutes: 8,
  intensityScore: 84,
  recommendedMarket: 'Next Team to Score',
  recommendedSelection: 'Arsenal Next Goal',
  modelProbability: 0.64,
  recentCommentary: ['61 Shot on target Arsenal'],
};

test('detectAlertPlatform distinguishes Windows, Android, iOS, and macOS cleanly', () => {
  assert.equal(
    detectAlertPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'),
    'windows'
  );
  assert.equal(
    detectAlertPlatform('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36'),
    'android'
  );
  assert.equal(
    detectAlertPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'),
    'ios'
  );
  assert.equal(
    detectAlertPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'),
    'macos'
  );
});

test('selectNewTriggerableAlerts deduplicates identical alerts during cooldown and re-triggers on +4% EV jump', () => {
  const t0 = 1_700_000_000_000;
  let registry: AlertSeenRegistry = {};

  // First detection fires alert
  const first = selectNewTriggerableAlerts({
    alerts: [sampleAlert],
    trends: [sampleTrend],
    registry,
    nowMs: t0,
  });
  assert.equal(first.items.length, 2);
  assert.equal(first.items[0].kind, 'ev_value');
  registry = first.nextRegistry;

  // 30s later with same EV -> suppressed cleanly
  const repeat = selectNewTriggerableAlerts({
    alerts: [{ ...sampleAlert, evPct: 29.5 }],
    trends: [sampleTrend],
    registry,
    nowMs: t0 + 30_000,
  });
  assert.equal(repeat.items.length, 0);

  // +4.5% EV jump -> triggers escalation notification
  const escalated = selectNewTriggerableAlerts({
    alerts: [{ ...sampleAlert, evPct: 33.2 }],
    trends: [sampleTrend],
    registry: repeat.nextRegistry,
    nowMs: t0 + 60_000,
  });
  assert.equal(escalated.items.length, 1);
  assert.equal(escalated.items[0].kind, 'ev_value');
  assert.match(escalated.items[0].headline, /\+33\.2% EV/);
});

test('formatOsNotificationPayload formats Windows/Android notification with deep-link matchId and vibration', () => {
  const { items } = selectNewTriggerableAlerts({
    alerts: [sampleAlert],
    trends: [],
    registry: {},
    nowMs: 1_700_000_000_000,
  });
  const payload = formatOsNotificationPayload(items[0]);
  assert.match(payload.title, /Arsenal vs Chelsea/);
  assert.match(payload.title, /63'/);
  assert.match(payload.body, /\+28\.1% EV/);
  assert.equal(payload.data.matchId, '771001');
  assert.equal(payload.data.url, '/?matchId=771001');
  assert.ok(payload.vibrate.length >= 3);
});
