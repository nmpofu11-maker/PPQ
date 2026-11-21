import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PushStore } from './pushStore';
import {
  PushService,
  loadVapidConfig,
  sanitizeModelSnapshot,
  sanitizePreferences,
  validatePushSubscriptionInput,
} from './webPush';

const VAPID = { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:t@t.test', isPersistentEnvKey: true };

function sub(id: string) {
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
    keys: { p256dh: 'p'.repeat(32), auth: 'a'.repeat(16) },
  };
}

const PREFS = sanitizePreferences({});

test('push store persists subscriptions across restarts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppq-push-'));
  const file = path.join(dir, 'nested', 'subs.json');
  const a = new PushStore(file);
  const svc = new PushService({ store: a, vapid: VAPID, send: async () => undefined });
  const res = svc.register(sub('one'), PREFS, null);
  assert.equal(res.ok, true);
  a.flush();

  const b = new PushStore(file);
  assert.equal(b.size, 1);
  assert.equal(b.get(sub('one').endpoint)?.subscription.endpoint, sub('one').endpoint);
  svc.stop();
});

test('push store tolerates a missing or corrupt file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppq-push-'));
  assert.equal(new PushStore(path.join(dir, 'missing.json')).size, 0);
  const corrupt = path.join(dir, 'corrupt.json');
  fs.writeFileSync(corrupt, '{ definitely not json');
  assert.equal(new PushStore(corrupt).size, 0);
});

test('register enforces subscriber capacity but allows updating an existing subscriber', () => {
  const svc = new PushService({
    store: new PushStore(null),
    vapid: VAPID,
    maxSubscribers: 1,
    send: async () => undefined,
  });
  assert.equal(svc.register(sub('a'), PREFS, null).ok, true);
  const full = svc.register(sub('b'), PREFS, null);
  assert.deepEqual(full, { ok: false, reason: 'capacity' });
  assert.equal(svc.register(sub('a'), { ...PREFS, minEvThreshold: 9 }, null).ok, true);
  svc.stop();
});

test('register keeps the previously synced model when a refresh omits it', () => {
  const store = new PushStore(null);
  const svc = new PushService({ store, vapid: VAPID, send: async () => undefined });
  const model = sanitizeModelSnapshot({
    globalWeights: { momentumSensitivity: 0.9 },
    team_intelligence_matrices: {},
  });
  svc.register(sub('a'), PREFS, model);
  svc.register(sub('a'), PREFS, null);
  assert.equal(store.get(sub('a').endpoint)?.model?.globalWeights.momentumSensitivity, 0.9);
  svc.stop();
});

test('test notifications enforce a per-endpoint cooldown', async () => {
  let now = 1_000_000;
  const sent: string[] = [];
  const svc = new PushService({
    store: new PushStore(null),
    vapid: VAPID,
    testCooldownMs: 30_000,
    now: () => now,
    send: async (s) => {
      sent.push(s.endpoint);
    },
  });
  svc.register(sub('a'), PREFS, null);
  assert.equal((await svc.sendTest(sub('a').endpoint)).sent, 1);
  assert.equal((await svc.sendTest(sub('a').endpoint)).reason, 'cooldown');
  now += 31_000;
  assert.equal((await svc.sendTest(sub('a').endpoint)).sent, 1);
  svc.stop();
});

test('expired subscriptions (410) are removed when a send fails', async () => {
  const store = new PushStore(null);
  const svc = new PushService({
    store,
    vapid: VAPID,
    testCooldownMs: 0,
    send: async () => {
      throw Object.assign(new Error('gone'), { statusCode: 410 });
    },
  });
  svc.register(sub('a'), PREFS, null);
  const r = await svc.sendTest(sub('a').endpoint);
  assert.equal(r.failed, 1);
  assert.equal(store.size, 0);
  svc.stop();
});

test('VAPID: production never generates ephemeral keys; development persists them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppq-vapid-'));
  assert.equal(loadVapidConfig({ production: true, dataDir: dir, env: {} }), null);

  const fromEnv = loadVapidConfig({
    production: true,
    dataDir: dir,
    env: { VAPID_PUBLIC_KEY: 'a', VAPID_PRIVATE_KEY: 'b' },
  });
  assert.equal(fromEnv?.isPersistentEnvKey, true);

  const first = loadVapidConfig({ production: false, dataDir: dir, env: {} });
  const second = loadVapidConfig({ production: false, dataDir: dir, env: {} });
  assert.ok(first?.publicKey);
  assert.equal(first?.publicKey, second?.publicKey, 'dev keys survive a restart');
});

test('validatePushSubscriptionInput applies the endpoint allowlist', () => {
  assert.ok(validatePushSubscriptionInput(sub('a')));
  assert.equal(validatePushSubscriptionInput({ ...sub('a'), endpoint: 'https://evil.example.com/x' }), null);
  assert.equal(validatePushSubscriptionInput({ endpoint: sub('a').endpoint, keys: { p256dh: 'x', auth: 'y' } }), null);
});

test('sanitizePreferences defaults to verified-live-only and clamps inputs', () => {
  assert.equal(sanitizePreferences(undefined).verifiedLiveOnly, true);
  assert.equal(sanitizePreferences({}).verifiedLiveOnly, true);
  assert.equal(sanitizePreferences({ verifiedLiveOnly: false }).verifiedLiveOnly, false);
  assert.equal(sanitizePreferences({ minEvThreshold: 9999 }).minEvThreshold, 50);
  assert.equal(sanitizePreferences({ minEvThreshold: -4 }).minEvThreshold, 0.5);
  assert.equal(sanitizePreferences({ scope: 'bogus' }).scope, 'all');
});

test('sanitizeModelSnapshot clamps hostile values and drops bad team keys', () => {
  const out = sanitizeModelSnapshot({
    globalWeights: { momentumSensitivity: 9999, shotOnTargetWeight: -5, baseTempoBias: 'NaN' },
    team_intelligence_matrices: {
      arsenal: {
        sample_size_matches: 1e12,
        learned_coefficients: { home_advantage_multiplier: 99, form_momentum_weight: 0 },
      },
      'bad key!': { learned_coefficients: {} },
    },
  });
  assert.ok(out);
  assert.equal(out.globalWeights.momentumSensitivity, 1.5);
  assert.equal(out.globalWeights.shotOnTargetWeight, 0.2);
  assert.ok(Number.isFinite(out.globalWeights.baseTempoBias));
  assert.equal(out.team_intelligence_matrices.arsenal.learned_coefficients.home_advantage_multiplier, 1.45);
  assert.equal(out.team_intelligence_matrices.arsenal.sample_size_matches, 100000);
  assert.equal(out.team_intelligence_matrices['bad key!'], undefined);
  assert.equal(sanitizeModelSnapshot('nope'), null);
});
