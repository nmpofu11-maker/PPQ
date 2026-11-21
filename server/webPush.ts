import {
  generateVAPIDKeys,
  sendNotification,
  setVapidDetails,
  type PushSubscription,
} from 'web-push';
import { scrapeScoreboardMatches } from './scraper';
import { predictMatchMarkets, toOddsFreeSnapshot } from '../src/engine/momentumMath';
import { evaluateBettingValue } from '../src/engine/valueDetector';
import { detectAttackTrends } from '../src/engine/trendDetector';
import { createInitialModelState } from '../src/engine/learningModel';
import { filterMatchIdsByAlertScope } from '../src/engine/leagueTiers';
import {
  formatOsNotificationPayload,
  selectNewTriggerableAlerts,
  type AlertSeenRegistry,
} from '../src/engine/alertNotifier';
import type { AlertScopeMode } from '../src/types/soccer';

export interface SubscriberPreferences {
  minEvThreshold: number;
  verifiedLiveOnly: boolean;
  scope: AlertScopeMode;
  watchlistIds: string[];
}

interface ActivePushSubscriber {
  subscription: PushSubscription;
  preferences: SubscriberPreferences;
  registry: AlertSeenRegistry;
  seeded: boolean;
  createdAt: string;
}

const DEFAULT_PREFERENCES: SubscriberPreferences = {
  minEvThreshold: 3,
  verifiedLiveOnly: false,
  scope: 'all',
  watchlistIds: [],
};

let vapidConfig: {
  publicKey: string;
  privateKey: string;
  subject: string;
  isPersistentEnvKey: boolean;
} | null = null;

function ensureVapidConfigured() {
  if (vapidConfig) return vapidConfig;

  const envPub = (process.env.VAPID_PUBLIC_KEY || '').trim();
  const envPriv = (process.env.VAPID_PRIVATE_KEY || '').trim();
  const subject = (process.env.VAPID_SUBJECT || 'mailto:alerts@pitchpulse-quant.local').trim();

  if (envPub && envPriv) {
    vapidConfig = {
      publicKey: envPub,
      privateKey: envPriv,
      subject,
      isPersistentEnvKey: true,
    };
  } else {
    const generated = generateVAPIDKeys();
    vapidConfig = {
      publicKey: generated.publicKey,
      privateKey: generated.privateKey,
      subject,
      isPersistentEnvKey: false,
    };
  }

  setVapidDetails(
    vapidConfig.subject,
    vapidConfig.publicKey,
    vapidConfig.privateKey
  );
  return vapidConfig;
}

const subscribers = new Map<string, ActivePushSubscriber>();
let monitorTimer: NodeJS.Timeout | null = null;
let monitorRunning = false;

export function getPublicVapidInfo() {
  const cfg = ensureVapidConfigured();
  return {
    publicKey: cfg.publicKey,
    isPersistentEnvKey: cfg.isPersistentEnvKey,
    subscriberCount: subscribers.size,
  };
}

export function validatePushSubscriptionInput(raw: unknown): PushSubscription | null {
  if (!raw || typeof raw !== 'object') return null;
  const sub = raw as Record<string, unknown>;
  if (typeof sub.endpoint !== 'string' || sub.endpoint.length > 2048) return null;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(sub.endpoint);
  } catch {
    return null;
  }
  if (parsedUrl.protocol !== 'https:') return null;

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
    keys: {
      p256dh: keys.p256dh,
      auth: keys.auth,
    },
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
    verifiedLiveOnly: Boolean(obj.verifiedLiveOnly),
    scope,
    watchlistIds,
  };
}

async function runBackgroundPushTick() {
  if (subscribers.size === 0 || monitorRunning) return;
  monitorRunning = true;
  try {
    ensureVapidConfigured();
    const { matches } = await scrapeScoreboardMatches({ enrichLimit: 24 });
    const liveMatches = matches.filter((m) => m.state === 'in');
    if (liveMatches.length === 0) return;

    const baselineModel = createInitialModelState();
    const matchAnalysis = liveMatches.map((m) => {
      const snap = toOddsFreeSnapshot(m);
      const prediction = predictMatchMarkets(snap, baselineModel);
      const trends = detectAttackTrends(snap, prediction, 10);
      return { match: m, prediction, trends };
    });

    const nowMs = Date.now();
    for (const [endpoint, entry] of subscribers.entries()) {
      const allowedMatchIds = filterMatchIdsByAlertScope({
        matches: liveMatches,
        scope: entry.preferences.scope,
        watchlistIds: new Set(entry.preferences.watchlistIds),
      });

      const alerts = [];
      const trends = [];
      for (const item of matchAnalysis) {
        if (!allowedMatchIds.has(item.match.id)) continue;
        alerts.push(
          ...evaluateBettingValue(
            item.match,
            item.prediction,
            entry.preferences.minEvThreshold,
            { verifiedLiveOnly: entry.preferences.verifiedLiveOnly }
          )
        );
        trends.push(...item.trends);
      }

      const selected = selectNewTriggerableAlerts({
        alerts,
        trends,
        registry: entry.registry,
        nowMs,
        seedOnly: !entry.seeded,
      });
      entry.registry = selected.nextRegistry;
      entry.seeded = true;

      for (const alertItem of selected.items.slice(0, 2)) {
        const payload = formatOsNotificationPayload(alertItem);
        try {
          await sendNotification(entry.subscription, JSON.stringify(payload), {
            TTL: 180,
            urgency: 'high',
          });
        } catch (err: any) {
          const statusCode = Number(err?.statusCode || 0);
          if (statusCode === 404 || statusCode === 410) {
            subscribers.delete(endpoint);
            break;
          }
        }
      }
    }

    if (subscribers.size === 0) {
      stopMonitorLoop();
    }
  } catch {
    // Non-fatal background monitor error; retries next cycle
  } finally {
    monitorRunning = false;
  }
}

function ensureMonitorLoopStarted() {
  if (monitorTimer || subscribers.size === 0) return;
  monitorTimer = setInterval(() => {
    void runBackgroundPushTick();
  }, 45_000);
}

function stopMonitorLoop() {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
}

export function registerPushSubscription(
  subscription: PushSubscription,
  preferences: SubscriberPreferences
): { subscriberCount: number } {
  ensureVapidConfigured();
  const prev = subscribers.get(subscription.endpoint);
  subscribers.set(subscription.endpoint, {
    subscription,
    preferences,
    registry: prev?.registry || {},
    seeded: prev?.seeded || false,
    createdAt: prev?.createdAt || new Date().toISOString(),
  });
  ensureMonitorLoopStarted();
  return { subscriberCount: subscribers.size };
}

export function unregisterPushSubscription(endpoint: string): {
  removed: boolean;
  subscriberCount: number;
} {
  const removed = subscribers.delete(endpoint);
  if (subscribers.size === 0) {
    stopMonitorLoop();
  }
  return { removed, subscriberCount: subscribers.size };
}

export async function sendTestPushNotification(endpoint?: string): Promise<{
  sent: number;
  failed: number;
}> {
  ensureVapidConfigured();
  const targets = endpoint
    ? subscribers.has(endpoint)
      ? [subscribers.get(endpoint)!]
      : []
    : Array.from(subscribers.values());

  if (targets.length === 0) {
    return { sent: 0, failed: 0 };
  }

  const payload = JSON.stringify({
    title: 'PitchPulse Quant · Background Push Ready',
    body: 'Windows & Android background push notifications are active (even when this tab is closed).',
    tag: 'pitchpulse-push-test',
    icon: '/pwa-192x192.png',
    badge: '/pwa-192x192.png',
    vibrate: [180, 80, 180],
    data: { matchId: '', url: '/', kind: 'ev_value' },
  });

  let sent = 0;
  let failed = 0;
  for (const target of targets) {
    try {
      await sendNotification(target.subscription, payload, {
        TTL: 120,
        urgency: 'high',
      });
      sent += 1;
    } catch (err: any) {
      failed += 1;
      const statusCode = Number(err?.statusCode || 0);
      if (statusCode === 404 || statusCode === 410) {
        subscribers.delete(target.subscription.endpoint);
      }
    }
  }

  if (subscribers.size === 0) stopMonitorLoop();
  return { sent, failed };
}
