import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp, errorHandler, type AppDeps } from './app';
import { PushService } from './webPush';
import { PushStore } from './pushStore';
import { createDailyBudget } from './security';
import type { TacticalAiBrief } from '../src/types/soccer';

const VAPID = { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:t@t.test', isPersistentEnvKey: true };

function goodSubscription(host = 'fcm.googleapis.com', id = 'abc') {
  return {
    endpoint: `https://${host}/fcm/send/${id}`,
    keys: { p256dh: 'p'.repeat(32), auth: 'a'.repeat(16) },
  };
}

interface Harness {
  base: string;
  sent: string[];
  store: PushStore;
  briefCalls: number;
  close: () => Promise<void>;
}

async function start(overrides: Partial<AppDeps> & { vapid?: typeof VAPID | null } = {}): Promise<Harness> {
  const sent: string[] = [];
  const store = new PushStore(null);
  const push = new PushService({
    store,
    vapid: overrides.vapid === undefined ? VAPID : overrides.vapid,
    send: async (sub) => {
      sent.push(sub.endpoint);
    },
    testCooldownMs: 0,
    tickMs: 3_600_000,
  });
  const h = { sent, store, briefCalls: 0 } as Harness;
  const app = createApp({
    push,
    verifyToken: async (t) => (t === 'good-token' ? { uid: 'u1', emailVerified: true } : null),
    generateBrief: async (input) => {
      h.briefCalls += 1;
      return {
        trendId: input.trend.id,
        matchId: input.trend.matchId,
        tacticalVerdict: 'Sustained Pressure',
        bestMarketPick: 'x',
        dangerQualitySummary: 'y',
        keyRiskFactor: 'z',
        generatedAt: new Date().toISOString(),
        modelUsed: 'test',
      } satisfies TacticalAiBrief;
    },
    ...overrides,
  });
  app.use(errorHandler);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  h.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  h.close = () =>
    new Promise<void>((resolve) => {
      push.stop();
      server.close(() => resolve());
    });
  return h;
}

async function post(h: Harness, path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${h.base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

function briefBody() {
  return {
    trend: {
      id: 't1',
      matchId: 'm1',
      league: 'L',
      matchTitle: 'A vs B',
      minute: 60,
      scoreline: '0-0',
      teamSide: 'home',
      teamName: 'A',
      patterns: [],
      patternLabel: 'Persistent Attack Surge',
      windowMinutes: 10,
      recentShots: 3,
      recentShotsOnTarget: 2,
      recentCorners: 1,
      consecutiveMomentumMinutes: 6,
      intensityScore: 5,
      recommendedMarket: 'Next Team to Score',
      recommendedSelection: 'A Next Goal',
      modelProbability: 0.4,
      recentCommentary: [],
    },
    homeTeam: 'A',
    awayTeam: 'B',
    possessionHome: 50,
    possessionAway: 50,
    shotsHome: '3',
    shotsAway: '2',
    nextGoalHomeProb: 0.4,
    nextGoalAwayProb: 0.3,
    winHomeProb: 0.4,
    drawProb: 0.3,
    winAwayProb: 0.3,
  };
}

test('subscribe rejects non-push-service endpoints (SSRF) and accepts real ones', async () => {
  const h = await start();
  try {
    const evil = await post(h, '/api/push/subscribe', { subscription: goodSubscription('evil.example.com') });
    assert.equal(evil.status, 400);
    const internal = await post(h, '/api/push/subscribe', {
      subscription: { ...goodSubscription(), endpoint: 'https://169.254.169.254/latest/meta-data' },
    });
    assert.equal(internal.status, 400);
    assert.equal(h.store.size, 0);

    const ok = await post(h, '/api/push/subscribe', { subscription: goodSubscription() });
    assert.equal(ok.status, 200);
    assert.equal(h.store.size, 1);
    // defaults to the safe verified-live-only preference
    assert.equal(h.store.values()[0].preferences.verifiedLiveOnly, true);
  } finally {
    await h.close();
  }
});

test('push/test never broadcasts and only targets the named, registered endpoint', async () => {
  const h = await start();
  try {
    await post(h, '/api/push/subscribe', { subscription: goodSubscription('fcm.googleapis.com', 'one') });
    await post(h, '/api/push/subscribe', { subscription: goodSubscription('fcm.googleapis.com', 'two') });

    const noEndpoint = await post(h, '/api/push/test', {});
    assert.equal(noEndpoint.status, 400);
    assert.equal(h.sent.length, 0, 'no broadcast without an endpoint');

    const unknown = await post(h, '/api/push/test', { endpoint: 'https://fcm.googleapis.com/fcm/send/nope' });
    assert.equal(unknown.status, 200);
    assert.equal(unknown.body?.sent, 0);

    const own = await post(h, '/api/push/test', { endpoint: goodSubscription('fcm.googleapis.com', 'one').endpoint });
    assert.equal(own.body?.sent, 1);
    assert.deepEqual(h.sent, [goodSubscription('fcm.googleapis.com', 'one').endpoint]);
  } finally {
    await h.close();
  }
});

test('push endpoints return 503 when VAPID keys are not configured', async () => {
  const h = await start({ vapid: null });
  try {
    const sub = await post(h, '/api/push/subscribe', { subscription: goodSubscription() });
    assert.equal(sub.status, 503);
    const info = await fetch(`${h.base}/api/push/vapid-public-key`).then((r) => r.json());
    assert.equal(info.configured, false);
    assert.equal(info.publicKey, null);
  } finally {
    await h.close();
  }
});

test('subscribe is rate limited per client', async () => {
  const h = await start();
  try {
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (await post(h, '/api/push/subscribe', { subscription: goodSubscription('evil.example.com') })).status;
    }
    assert.equal(last, 429);
  } finally {
    await h.close();
  }
});

test('tactical brief requires a valid sign-in token', async () => {
  const h = await start();
  try {
    assert.equal((await post(h, '/api/alerts/tactical-brief', briefBody())).status, 401);
    assert.equal(
      (await post(h, '/api/alerts/tactical-brief', briefBody(), { authorization: 'Bearer wrong' })).status,
      401
    );
    assert.equal(h.briefCalls, 0, 'the AI provider is never reached without auth');

    const ok = await post(h, '/api/alerts/tactical-brief', briefBody(), { authorization: 'Bearer good-token' });
    assert.equal(ok.status, 200);
    assert.equal(h.briefCalls, 1);
  } finally {
    await h.close();
  }
});

test('tactical brief validates input and enforces the daily budget', async () => {
  const h = await start({ budget: createDailyBudget({ globalLimit: 10, perUserLimit: 1 }) });
  try {
    const auth = { authorization: 'Bearer good-token' };
    const bad = await post(h, '/api/alerts/tactical-brief', { nope: true }, auth);
    assert.equal(bad.status, 400);

    assert.equal((await post(h, '/api/alerts/tactical-brief', briefBody(), auth)).status, 200);
    const limited = await post(h, '/api/alerts/tactical-brief', briefBody(), auth);
    assert.equal(limited.status, 429);
    assert.equal(h.briefCalls, 1);
  } finally {
    await h.close();
  }
});

test('tactical brief failures return a generic 502 and refund the budget', async () => {
  const h = await start({
    generateBrief: async () => {
      throw new Error('Gemini API (503): internal provider detail');
    },
    budget: createDailyBudget({ globalLimit: 10, perUserLimit: 1 }),
  });
  try {
    const auth = { authorization: 'Bearer good-token' };
    const first = await post(h, '/api/alerts/tactical-brief', briefBody(), auth);
    assert.equal(first.status, 502);
    assert.ok(!JSON.stringify(first.body).includes('provider detail'), 'upstream detail is not leaked');
    const second = await post(h, '/api/alerts/tactical-brief', briefBody(), auth);
    assert.equal(second.status, 502, 'budget was refunded, so the second call is attempted again');
  } finally {
    await h.close();
  }
});

test('malformed and oversized JSON bodies get clean 4xx responses', async () => {
  const h = await start();
  try {
    const malformed = await post(h, '/api/push/unsubscribe', '{not json');
    assert.equal(malformed.status, 400);
    const huge = await post(h, '/api/push/unsubscribe', { endpoint: 'x'.repeat(40_000) });
    assert.equal(huge.status, 413);
  } finally {
    await h.close();
  }
});

test('match and league routes validate input, forward league queries, and hide upstream error details', async () => {
  const seenOpts: Array<{ league?: string; allLeagues?: boolean }> = [];
  const h = await start({
    listLeagues: async () => [
      { slug: 'eng.1', name: 'English Premier League' },
      { slug: 'bra.1', name: 'Brazilian Serie A' },
    ],
    scrapeScoreboard: async (opts) => {
      seenOpts.push({ league: opts?.league, allLeagues: opts?.allLeagues });
      if (opts?.league === 'bra.1') {
        return {
          matches: [],
          sources: { espnCount: 0, bbcCrossCheckedCount: 0, scrapedAt: new Date().toISOString(), leagueCount: 0 },
        };
      }
      throw new Error('ESPN scoreboard scrape failed with HTTP 500');
    },
    scrapeMatch: async (id: string) => (id === 'missing' ? null : ({ id } as never)),
  });
  try {
    const leaguesRes = await fetch(`${h.base}/api/leagues`);
    assert.equal(leaguesRes.status, 200);
    const leaguesBody = (await leaguesRes.json()) as { count: number; leagues: Array<{ slug: string }> };
    assert.equal(leaguesBody.count, 2);
    assert.equal(leaguesBody.leagues[1].slug, 'bra.1');

    assert.equal((await fetch(`${h.base}/api/matches/live?date=bad`)).status, 400);
    assert.equal((await fetch(`${h.base}/api/matches/live?league=bad/slug!`)).status, 400);

    const bra = await fetch(`${h.base}/api/matches/live?league=bra.1`);
    assert.equal(bra.status, 200);
    assert.deepEqual(seenOpts.at(-1), { league: 'bra.1', allLeagues: false });

    const live = await fetch(`${h.base}/api/matches/live`);
    assert.equal(live.status, 502);
    assert.deepEqual(seenOpts.at(-1), { league: undefined, allLeagues: true });
    assert.ok(!JSON.stringify(await live.json()).includes('HTTP 500'));
    assert.equal((await fetch(`${h.base}/api/matches/bad%20id`)).status, 400);
    assert.equal((await fetch(`${h.base}/api/matches/missing`)).status, 404);
    assert.equal((await fetch(`${h.base}/api/matches/abc123`)).status, 200);
    assert.equal((await fetch(`${h.base}/api/does-not-exist`)).status, 404);
  } finally {
    await h.close();
  }
});
