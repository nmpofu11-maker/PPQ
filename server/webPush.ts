import fs from 'node:fs';
import path from 'node:path';
import { generateVAPIDKeys, sendNotification, type PushSubscription } from 'web-push';
import { scrapeScoreboardMatches } from './scraper';
import { isAllowedPushEndpoint } from './security';
import {
  PushStore,
  type ModelSnapshot,
  type StoredSubscriber,
  type SubscriberPreferences,
} from './pushStore';
import { predictMatchMarkets, toOddsFreeSnapshot, clamp } from '../src/engine/momentumMath';
import { evaluateBettingValue } from '../src/engine/valueDetector';
import { detectAttackTrends } from '../src/engine/trendDetector';
import { createInitialModelState } from '../src/engine/learningModel';
import { filterMatchIdsByAlertScope } from '../src/engine/leagueTiers';
import {
  formatOsNotificationPayload,
  selectNewTriggerableAlerts,
  type AlertSeenRegistry,
} from '../src/engine/alertNotifier';
import type {
  AlertScopeMode,
  GlobalModelWeights,
  ScrapedMatch,
  TeamLearnedCoefficients,
} from '../src/types/soccer';

export type { SubscriberPreferences } from './pushStore';

/* -------------------------------------------------------------------------- */
/* VAPID configuration                                                         */
/* -------------------------------------------------------------------------- */

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
  isPersistentEnvKey: boolean;
}

/**
 * Production never invents ephemeral VAPID keys: regenerating them on every boot
 * silently invalidates every existing browser subscription. Without keys in
 * production, push is reported as not configured (HTTP 503) and the rest of the
 * app keeps working. In development keys are generated once and persisted.
 */
export function loadVapidConfig(opts: {
  production: boolean;
  dataDir: string;
  env?: NodeJS.ProcessEnv;
}): VapidConfig | null {
  const env = opts.env ?? process.env;
  const subject = (env.VAPID_SUBJECT || 'mailto:alerts@pitchpulse-quant.local').trim();
  const pub = (env.VAPID_PUBLIC_KEY || '').trim();
  const priv = (env.VAPID_PRIVATE_KEY || '').trim();

  if (pub && priv) {
    return { publicKey: pub, privateKey: priv, subject, isPersistentEnvKey: true };
  }
  if (opts.production) return null;

  const file = path.join(opts.dataDir, 'vapid.json');
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      publicKey?: string;
      privateKey?: string;
    };
    if (saved.publicKey && saved.privateKey) {
      return {
        publicKey: saved.publicKey,
        privateKey: saved.privateKey,
        subject,
        isPersistentEnvKey: false,
      };
    }
  } catch {
    // fall through and generate
  }
  const generated = generateVAPIDKeys();
  try {
    fs.mkdirSync(opts.dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(generated), { mode: 0o600 });
  } catch (err) {
    console.warn('[push] could not persist development VAPID keys:', err);
  }
  return { ...generated, subject, isPersistentEnvKey: false };
}

/* -------------------------------------------------------------------------- */
/* Input validation / sanitising                                               */
/* -------------------------------------------------------------------------- */

const DEFAULT_PREFERENCES: SubscriberPreferences = {
  minEvThreshold: 3,
  verifiedLiveOnly: true,
  scope: 'all',
  watchlistIds: [],
};

export function validatePushSubscriptionInput(raw: unknown): PushSubscription | null {
  if (!raw || typeof raw !== 'object') return null;
  const sub = raw as Record<string, unknown>;
  if (typeof sub.endpoint !== 'string' || sub.endpoint.length > 2048) return null;
  if (!isAllowedPushEndpoint(sub.endpoint)) return null;

  const keys = sub.keys as Record<string, unknown> | undefined;
  if (
    !keys ||
    typeof keys.p256dh !== 'string' ||
    typeof keys.auth !== 'string' ||
    keys.p256dh.length < 16 ||
    keys.p256dh.length > 256 ||
    keys.auth.length < 8 ||
    keys.auth.length > 256
  ) {
    return null;
  }

  return {
    endpoint: sub.endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
  };
}

export function sanitizePreferences(raw: unknown): SubscriberPreferences {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PREFERENCES };
  const obj = raw as Record<string, unknown>;
  const minEv = Number(obj.minEvThreshold);
  const safeMinEv = Number.isFinite(minEv) ? Math.max(0.5, Math.min(50, minEv)) : 3;
  const scopeRaw = obj.scope;
  const scope: AlertScopeMode =
    scopeRaw === 'watchlist' || scopeRaw === 'top_leagues' ? scopeRaw : 'all';
  const watchlistIds = Array.isArray(obj.watchlistIds)
    ? obj.watchlistIds
        .filter((x): x is string => typeof x === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(x))
        .slice(0, 100)
    : [];

  return {
    minEvThreshold: safeMinEv,
    // Safe by default: only an explicit `false` opts out of verified-live-odds-only.
    verifiedLiveOnly: obj.verifiedLiveOnly === false ? false : true,
    scope,
    watchlistIds,
  };
}

const MAX_TEAMS_IN_MODEL = 300;

function finiteOr(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? clamp(n, min, max) : fallback;
}

/**
 * Accepts the browser's learned model so background alerts use the same
 * calibrated parameters as the foreground app. Every value is clamped to the
 * same ranges the learning loop and Firestore rules enforce.
 */
export function sanitizeModelSnapshot(raw: unknown): ModelSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const gw = obj.globalWeights as Record<string, unknown> | undefined;
  if (!gw || typeof gw !== 'object') return null;
  const base = createInitialModelState().globalWeights;

  const globalWeights: GlobalModelWeights = {
    momentumSensitivity: finiteOr(gw.momentumSensitivity, base.momentumSensitivity, 0.1, 1.5),
    shotOnTargetWeight: finiteOr(gw.shotOnTargetWeight, base.shotOnTargetWeight, 0.2, 1.8),
    possessionWeight: finiteOr(gw.possessionWeight, base.possessionWeight, 0, 2),
    cornerPressureWeight: finiteOr(gw.cornerPressureWeight, base.cornerPressureWeight, 0, 2),
    baseTempoBias: finiteOr(gw.baseTempoBias, base.baseTempoBias, -0.45, 0.45),
    homeAdvantageBase: finiteOr(gw.homeAdvantageBase, base.homeAdvantageBase, 0.9, 1.3),
  };

  const matrices: Record<string, TeamLearnedCoefficients> = {};
  const rawMatrices = obj.team_intelligence_matrices;
  if (rawMatrices && typeof rawMatrices === 'object') {
    let count = 0;
    for (const [key, val] of Object.entries(rawMatrices as Record<string, unknown>)) {
      if (count >= MAX_TEAMS_IN_MODEL) break;
      if (!/^[a-z0-9_]{1,120}$/.test(key) || !val || typeof val !== 'object') continue;
      const lc = (val as Record<string, unknown>).learned_coefficients as
        | Record<string, unknown>
        | undefined;
      if (!lc || typeof lc !== 'object') continue;
      matrices[key] = {
        sample_size_matches: Math.round(
          finiteOr((val as Record<string, unknown>).sample_size_matches, 0, 0, 100000)
        ),
        learned_coefficients: {
          home_advantage_multiplier: finiteOr(lc.home_advantage_multiplier, 1.08, 0.8, 1.45),
          form_momentum_weight: finiteOr(lc.form_momentum_weight, 1, 0.5, 1.6),
          volatility_index: finiteOr(lc.volatility_index, 1, 0.65, 1.65),
          fatigue_penalty_modifier: finiteOr(lc.fatigue_penalty_modifier, 1, 0.7, 1.45),
        },
      };
      count += 1;
    }
  }

  return { globalWeights, team_intelligence_matrices: matrices };
}

/* -------------------------------------------------------------------------- */
/* Push service                                                                */
/* -------------------------------------------------------------------------- */

type SendFn = (
  subscription: PushSubscription,
  payload: string,
  options: { TTL: number; urgency: 'high' | 'normal' | 'low' }
) => Promise<unknown>;

export interface PushServiceOptions {
  store: PushStore;
  vapid: VapidConfig | null;
  scrape?: typeof scrapeScoreboardMatches;
  send?: SendFn;
  tickMs?: number;
  maxSubscribers?: number;
  testCooldownMs?: number;
  now?: () => number;
}

export class PushService {
  private readonly store: PushStore;
  private readonly vapid: VapidConfig | null;
  private readonly scrape: typeof scrapeScoreboardMatches;
  private readonly send: SendFn;
  private readonly tickMs: number;
  private readonly maxSubscribers: number;
  private readonly testCooldownMs: number;
  private readonly now: () => number;

  /** Seen-alert registries are deliberately in-memory: after a restart the first tick only re-seeds, so nobody gets duplicate alerts. */
  private readonly registries = new Map<string, { registry: AlertSeenRegistry; seeded: boolean }>();
  private readonly lastTestAt = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(opts: PushServiceOptions) {
    this.store = opts.store;
    this.vapid = opts.vapid;
    this.scrape = opts.scrape ?? scrapeScoreboardMatches;
    this.tickMs = opts.tickMs ?? 45_000;
    this.maxSubscribers = opts.maxSubscribers ?? 2000;
    this.testCooldownMs = opts.testCooldownMs ?? 30_000;
    this.now = opts.now ?? Date.now;
    this.send =
      opts.send ??
      ((subscription, payload, options) => {
        if (!this.vapid) return Promise.reject(new Error('push_not_configured'));
        return sendNotification(subscription, payload, {
          ...options,
          vapidDetails: {
            subject: this.vapid.subject,
            publicKey: this.vapid.publicKey,
            privateKey: this.vapid.privateKey,
          },
        });
      });
  }

  isConfigured() {
    return this.vapid !== null;
  }

  publicInfo() {
    return {
      configured: this.isConfigured(),
      publicKey: this.vapid?.publicKey ?? null,
      isPersistentEnvKey: this.vapid?.isPersistentEnvKey ?? false,
      subscriberCount: this.store.size,
    };
  }

  /** Resume the monitor for subscribers restored from disk. */
  start() {
    if (this.isConfigured()) this.ensureLoop();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.store.flush();
  }

  register(
    subscription: PushSubscription,
    preferences: SubscriberPreferences,
    model: ModelSnapshot | null
  ): { ok: true; subscriberCount: number } | { ok: false; reason: 'capacity' | 'not_configured' } {
    if (!this.isConfigured()) return { ok: false, reason: 'not_configured' };
    const prev = this.store.get(subscription.endpoint);
    if (!prev && this.store.size >= this.maxSubscribers) return { ok: false, reason: 'capacity' };

    const entry: StoredSubscriber = {
      subscription,
      preferences,
      model: model ?? prev?.model ?? null,
      createdAt: prev?.createdAt ?? new Date(this.now()).toISOString(),
    };
    this.store.set(subscription.endpoint, entry);
    this.ensureLoop();
    return { ok: true, subscriberCount: this.store.size };
  }

  unregister(endpoint: string) {
    const removed = this.store.delete(endpoint);
    this.registries.delete(endpoint);
    this.lastTestAt.delete(endpoint);
    if (this.store.size === 0) this.stopLoop();
    return { removed, subscriberCount: this.store.size };
  }

  /** Sends a test notification to ONE registered endpoint only; never broadcasts. */
  async sendTest(endpoint: string): Promise<{ sent: number; failed: number; reason?: string }> {
    const target = this.store.get(endpoint);
    if (!target) return { sent: 0, failed: 0, reason: 'unknown_endpoint' };

    const t = this.now();
    const last = this.lastTestAt.get(endpoint) ?? 0;
    if (t - last < this.testCooldownMs) return { sent: 0, failed: 0, reason: 'cooldown' };
    this.lastTestAt.set(endpoint, t);

    const payload = JSON.stringify({
      title: 'PitchPulse Quant · Background Push Ready',
      body: 'Background push notifications are active (even when this tab is closed).',
      tag: 'pitchpulse-push-test',
      icon: '/pwa-192x192.png',
      badge: '/pwa-192x192.png',
      vibrate: [180, 80, 180],
      data: { matchId: '', url: '/', kind: 'ev_value' },
    });

    try {
      await this.send(target.subscription, payload, { TTL: 120, urgency: 'high' });
      return { sent: 1, failed: 0 };
    } catch (err) {
      this.dropIfGone(endpoint, err);
      return { sent: 0, failed: 1 };
    }
  }

  private dropIfGone(endpoint: string, err: unknown) {
    const statusCode = Number((err as { statusCode?: number })?.statusCode || 0);
    if (statusCode === 404 || statusCode === 410) {
      this.store.delete(endpoint);
      this.registries.delete(endpoint);
    }
  }

  private ensureLoop() {
    if (this.timer || this.store.size === 0) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickMs);
    this.timer.unref();
  }

  private stopLoop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One monitoring cycle. Exposed for tests. */
  async tick(): Promise<void> {
    if (!this.isConfigured() || this.store.size === 0 || this.running) return;
    this.running = true;
    try {
      const { matches } = await this.scrape({ enrichLimit: 24 });
      const liveMatches = matches.filter((m: ScrapedMatch) => m.state === 'in');
      if (liveMatches.length === 0) return;

      const baseline = createInitialModelState();
      const nowMs = this.now();

      for (const [endpoint, entry] of this.store.entries()) {
        const model: ModelSnapshot = entry.model ?? baseline;
        const allowedMatchIds = filterMatchIdsByAlertScope({
          matches: liveMatches,
          scope: entry.preferences.scope,
          watchlistIds: new Set(entry.preferences.watchlistIds),
        });

        const alerts = [];
        const trends = [];
        for (const match of liveMatches) {
          if (!allowedMatchIds.has(match.id)) continue;
          const snap = toOddsFreeSnapshot(match);
          const prediction = predictMatchMarkets(snap, model);
          alerts.push(
            ...evaluateBettingValue(match, prediction, entry.preferences.minEvThreshold, {
              verifiedLiveOnly: entry.preferences.verifiedLiveOnly,
            })
          );
          trends.push(...detectAttackTrends(snap, prediction, 10));
        }

        const state = this.registries.get(endpoint) ?? { registry: {}, seeded: false };
        const selected = selectNewTriggerableAlerts({
          alerts,
          trends,
          registry: state.registry,
          nowMs,
          seedOnly: !state.seeded,
        });
        this.registries.set(endpoint, { registry: selected.nextRegistry, seeded: true });

        for (const alertItem of selected.items.slice(0, 2)) {
          try {
            await this.send(
              entry.subscription,
              JSON.stringify(formatOsNotificationPayload(alertItem)),
              { TTL: 180, urgency: 'high' }
            );
          } catch (err) {
            this.dropIfGone(endpoint, err);
            break;
          }
        }
      }

      if (this.store.size === 0) this.stopLoop();
    } catch (err) {
      console.warn('[push] monitor cycle failed (will retry):', err instanceof Error ? err.message : err);
    } finally {
      this.running = false;
    }
  }
}

export function createDefaultPushStore(env: NodeJS.ProcessEnv = process.env): PushStore {
  const configured = (env.PUSH_STORE_PATH || '').trim();
  const file = configured || path.resolve(process.cwd(), '.data', 'push-subscriptions.json');
  return new PushStore(file);
}
