import test from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import {
  createDailyBudget,
  createFirebaseTokenVerifier,
  createRateLimiter,
  isAllowedPushEndpoint,
  sanitizeTacticalBriefInput,
} from './security';

test('isAllowedPushEndpoint accepts real browser push services only', () => {
  assert.equal(isAllowedPushEndpoint('https://fcm.googleapis.com/fcm/send/abc'), true);
  assert.equal(isAllowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc'), true);
  assert.equal(isAllowedPushEndpoint('https://abc.notify.windows.com/w/?token=1'), true);
  assert.equal(isAllowedPushEndpoint('https://web.push.apple.com/abc'), true);
});

test('isAllowedPushEndpoint rejects SSRF-style endpoints', () => {
  const bad = [
    'http://fcm.googleapis.com/fcm/send/abc', // not https
    'https://evil.example.com/hook',
    'https://fcm.googleapis.com.evil.com/x', // suffix trick
    'https://evilfcm.googleapis.com.attacker.io/x',
    'https://localhost/x',
    'https://127.0.0.1/x',
    'https://169.254.169.254/latest/meta-data',
    'https://metadata.google.internal/computeMetadata/v1/',
    'https://user:pass@fcm.googleapis.com/x', // credentials
    'https://fcm.googleapis.com:8443/x', // non-standard port
    'https://notify.windows.com/x', // bare suffix domain without a subdomain
    'not a url',
    '',
  ];
  for (const url of bad) assert.equal(isAllowedPushEndpoint(url), false, url);
});

test('PUSH_ENDPOINT_ALLOWLIST extends the allowlist explicitly', () => {
  const prev = process.env.PUSH_ENDPOINT_ALLOWLIST;
  try {
    process.env.PUSH_ENDPOINT_ALLOWLIST = 'push.example.org';
    assert.equal(isAllowedPushEndpoint('https://push.example.org/x'), true);
    assert.equal(isAllowedPushEndpoint('https://a.push.example.org/x'), true);
    assert.equal(isAllowedPushEndpoint('https://example.org/x'), false);
  } finally {
    if (prev === undefined) delete process.env.PUSH_ENDPOINT_ALLOWLIST;
    else process.env.PUSH_ENDPOINT_ALLOWLIST = prev;
  }
});

function fakeRes() {
  const state: { status: number; headers: Record<string, string>; body: unknown } = {
    status: 200,
    headers: {},
    body: null,
  };
  const res = {
    setHeader(k: string, v: string) {
      state.headers[k] = v;
    },
    status(code: number) {
      state.status = code;
      return res;
    },
    json(b: unknown) {
      state.body = b;
      return res;
    },
  } as unknown as Response;
  return { res, state };
}

test('rate limiter blocks after max hits and recovers after the window', () => {
  let t = 1_000;
  const limiter = createRateLimiter({ name: 't', windowMs: 1_000, max: 2, now: () => t });
  const req = { ip: '1.2.3.4' } as Request;
  let passed = 0;
  const next = () => {
    passed += 1;
  };

  limiter(req, fakeRes().res, next);
  limiter(req, fakeRes().res, next);
  const blocked = fakeRes();
  limiter(req, blocked.res, next);
  assert.equal(passed, 2);
  assert.equal(blocked.state.status, 429);
  assert.ok(blocked.state.headers['Retry-After']);

  // a different client is unaffected
  limiter({ ip: '9.9.9.9' } as Request, fakeRes().res, next);
  assert.equal(passed, 3);

  t += 1_500;
  limiter(req, fakeRes().res, next);
  assert.equal(passed, 4);
});

test('daily budget enforces global and per-user caps and supports refunds', () => {
  let t = Date.parse('2026-11-21T10:00:00Z');
  const budget = createDailyBudget({ globalLimit: 3, perUserLimit: 2, now: () => t });
  assert.equal(budget.tryConsume('a'), true);
  assert.equal(budget.tryConsume('a'), true);
  assert.equal(budget.tryConsume('a'), false, 'per-user cap');
  assert.equal(budget.tryConsume('b'), true);
  assert.equal(budget.tryConsume('c'), false, 'global cap');
  budget.refund('b');
  assert.equal(budget.tryConsume('c'), true);
  t = Date.parse('2026-11-22T00:00:01Z');
  assert.equal(budget.tryConsume('a'), true, 'new UTC day resets');
});

test('firebase token verifier accepts valid tokens, rejects bad ones, and caches', async () => {
  let calls = 0;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    calls += 1;
    const { idToken } = JSON.parse(String(init?.body));
    if (idToken === 'good') {
      return new Response(JSON.stringify({ users: [{ localId: 'uid1', emailVerified: true }] }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify({ error: { message: 'INVALID_ID_TOKEN' } }), { status: 400 });
  }) as unknown as typeof fetch;

  const verify = createFirebaseTokenVerifier({ apiKey: 'k', fetchImpl });
  assert.deepEqual(await verify('good'), { uid: 'uid1', emailVerified: true });
  assert.deepEqual(await verify('good'), { uid: 'uid1', emailVerified: true });
  assert.equal(calls, 1, 'second lookup served from cache');
  assert.equal(await verify('bad'), null);
  assert.equal(await verify(''), null);
  assert.equal(await verify('x'.repeat(5000)), null);
});

function validBriefBody() {
  return {
    trend: {
      id: 't1',
      matchId: 'm1',
      league: 'Test League',
      matchTitle: 'A vs B',
      minute: 63,
      scoreline: '1-1',
      teamSide: 'home',
      teamName: 'A',
      patterns: ['Persistent Attack Surge'],
      patternLabel: 'Persistent Attack Surge',
      windowMinutes: 10,
      recentShots: 4,
      recentShotsOnTarget: 2,
      recentCorners: 1,
      consecutiveMomentumMinutes: 6,
      intensityScore: 7,
      recommendedMarket: 'Next Team to Score',
      recommendedSelection: 'A Next Goal',
      modelProbability: 0.4,
      recentCommentary: ['Attempt saved.'],
    },
    homeTeam: 'A',
    awayTeam: 'B',
    possessionHome: 55,
    possessionAway: 45,
    shotsHome: '8 (3 SoT)',
    shotsAway: '4 (1 SoT)',
    nextGoalHomeProb: 0.4,
    nextGoalAwayProb: 0.3,
    winHomeProb: 0.4,
    drawProb: 0.3,
    winAwayProb: 0.3,
  };
}

test('sanitizeTacticalBriefInput accepts a valid payload and bounds free text', () => {
  const body = validBriefBody();
  body.trend.recentCommentary = Array.from({ length: 50 }, () => 'x'.repeat(5000));
  body.homeTeam = `A${'\u0000'}\n${'z'.repeat(500)}`;
  const out = sanitizeTacticalBriefInput(body);
  assert.ok(out);
  assert.equal(out.trend.recentCommentary.length, 8);
  assert.ok(out.trend.recentCommentary.every((c) => c.length <= 240));
  assert.ok(out.homeTeam.length <= 120);
  assert.ok(!/[\u0000-\u001f]/.test(out.homeTeam));
});

test('sanitizeTacticalBriefInput rejects malformed payloads', () => {
  assert.equal(sanitizeTacticalBriefInput(null), null);
  assert.equal(sanitizeTacticalBriefInput({}), null);
  const missingTeam = validBriefBody();
  missingTeam.homeTeam = '';
  assert.equal(sanitizeTacticalBriefInput(missingTeam), null);
  const nanProb = validBriefBody();
  (nanProb as Record<string, unknown>).winHomeProb = 'high';
  assert.equal(sanitizeTacticalBriefInput(nanProb), null);
  const badMinute = validBriefBody();
  (badMinute.trend as Record<string, unknown>).minute = Number.NaN;
  assert.equal(sanitizeTacticalBriefInput(badMinute), null);
});
