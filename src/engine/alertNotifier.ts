import type { DetectedTrendSignal, ValueAlert } from '../types/soccer';

export type AlertPlatform = 'windows' | 'android' | 'ios' | 'macos' | 'linux' | 'other';

export interface AlertDispatchRecord {
  lastAlertedAtMs: number;
  lastEvPct: number;
  lastScoreline: string;
}

export type AlertSeenRegistry = Record<string, AlertDispatchRecord>;

export interface CrossPlatformAlertItem {
  id: string;
  dedupKey: string;
  kind: 'ev_value' | 'attack_trend';
  matchId: string;
  matchTitle: string;
  league: string;
  minute: number;
  scoreline: string;
  headline: string;
  detail: string;
  evPct?: number;
  tag: string;
  createdAtMs: number;
}

export interface OsNotificationPayload {
  title: string;
  body: string;
  tag: string;
  icon: string;
  badge: string;
  vibrate: number[];
  data: {
    matchId: string;
    url: string;
    kind: CrossPlatformAlertItem['kind'];
  };
}

export function detectAlertPlatform(userAgent: string): AlertPlatform {
  const ua = userAgent.toLowerCase();
  if (/android/.test(ua)) return 'android';
  if (/iphone|ipad|ipod/.test(ua)) return 'ios';
  if (/windows|win32|win64/.test(ua)) return 'windows';
  if (/macintosh|mac os x/.test(ua)) return 'macos';
  if (/linux/.test(ua)) return 'linux';
  return 'other';
}

export function getPlatformAlertLabel(platform: AlertPlatform): string {
  switch (platform) {
    case 'windows':
      return 'Windows Toast';
    case 'android':
      return 'Android Alert';
    case 'ios':
      return 'iOS Alert';
    case 'macos':
      return 'macOS Banner';
    case 'linux':
      return 'Desktop Alert';
    default:
      return 'System Alert';
  }
}

export function buildEvAlertKey(alert: ValueAlert): string {
  return `ev::${alert.matchId}::${alert.market}::${alert.selection}`;
}

export function buildTrendAlertKey(trend: DetectedTrendSignal): string {
  return `trend::${trend.matchId}::${trend.teamSide}::${trend.patternLabel}`;
}

/**
 * Pure deduplication and escalation selector.
 * Prevents duplicate Windows/Android notifications during 30s auto-polling
 * unless cooldown has elapsed or +EV jumped significantly (>= 4.0%).
 */
export function selectNewTriggerableAlerts(params: {
  alerts: ValueAlert[];
  trends: DetectedTrendSignal[];
  registry: AlertSeenRegistry;
  nowMs: number;
  cooldownMs?: number;
  evJumpThresholdPct?: number;
  includeTrends?: boolean;
  seedOnly?: boolean;
}): {
  items: CrossPlatformAlertItem[];
  nextRegistry: AlertSeenRegistry;
} {
  const {
    alerts,
    trends,
    registry,
    nowMs,
    cooldownMs = 10 * 60_000,
    evJumpThresholdPct = 4.0,
    includeTrends = true,
    seedOnly = false,
  } = params;

  const nextRegistry: AlertSeenRegistry = { ...registry };
  const items: CrossPlatformAlertItem[] = [];

  for (const alert of alerts) {
    const key = buildEvAlertKey(alert);
    const prev = nextRegistry[key];
    const isFresh = !prev;
    const cooldownElapsed = prev ? nowMs - prev.lastAlertedAtMs >= cooldownMs : false;
    const significantJump = prev
      ? alert.evPct - prev.lastEvPct >= evJumpThresholdPct
      : false;
    const scoreChanged = prev ? alert.scoreline !== prev.lastScoreline : false;

    if (isFresh || cooldownElapsed || significantJump || scoreChanged) {
      nextRegistry[key] = {
        lastAlertedAtMs: nowMs,
        lastEvPct: alert.evPct,
        lastScoreline: alert.scoreline,
      };
      if (!seedOnly) {
        items.push({
          id: `${key}::${nowMs}`,
          dedupKey: key,
          kind: 'ev_value',
          matchId: alert.matchId,
          matchTitle: alert.matchTitle,
          league: alert.league,
          minute: alert.minute,
          scoreline: alert.scoreline,
          headline: `+${alert.evPct.toFixed(1)}% EV · ${alert.selection}`,
          detail: `${alert.market} · Model ${(alert.modelProbability * 100).toFixed(1)}% vs ${alert.bookmakerOddsAmerican} (${alert.provider})`,
          evPct: alert.evPct,
          tag: `pitchpulse-ev-${alert.matchId}`,
          createdAtMs: nowMs,
        });
      }
    }
  }

  if (includeTrends) {
    for (const tr of trends) {
      const key = buildTrendAlertKey(tr);
      const prev = nextRegistry[key];
      const isFresh = !prev;
      const cooldownElapsed = prev ? nowMs - prev.lastAlertedAtMs >= cooldownMs : false;

      if (isFresh || cooldownElapsed) {
        nextRegistry[key] = {
          lastAlertedAtMs: nowMs,
          lastEvPct: tr.modelProbability * 100,
          lastScoreline: tr.scoreline,
        };
        if (!seedOnly) {
          items.push({
            id: `${key}::${nowMs}`,
            dedupKey: key,
            kind: 'attack_trend',
            matchId: tr.matchId,
            matchTitle: tr.matchTitle,
            league: tr.league,
            minute: tr.minute,
            scoreline: tr.scoreline,
            headline: `${tr.teamName}: ${tr.patternLabel}`,
            detail: `${tr.recentShots} shots (${tr.recentShotsOnTarget} SoT), ${tr.recentCorners} corners in ${tr.windowMinutes}m · ${tr.recommendedSelection} (${(tr.modelProbability * 100).toFixed(1)}%)`,
            tag: `pitchpulse-trend-${tr.matchId}`,
            createdAtMs: nowMs,
          });
        }
      }
    }
  }

  // Prioritize +EV alerts first, highest EV at top, cap burst size per cycle to avoid OS throttling
  items.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'ev_value' ? -1 : 1;
    return (b.evPct ?? 0) - (a.evPct ?? 0);
  });

  return {
    items: items.slice(0, 4),
    nextRegistry,
  };
}

export function formatOsNotificationPayload(
  item: CrossPlatformAlertItem
): OsNotificationPayload {
  const prefix =
    item.kind === 'ev_value' ? '+EV Value Alert' : 'Attack Trend Alert';
  const title = `${prefix}: ${item.matchTitle} (${item.minute}' · ${item.scoreline})`;
  const body = `${item.headline}\n${item.detail}`;

  return {
    title,
    body,
    tag: item.tag,
    icon: '/pwa-192x192.png',
    badge: '/pwa-192x192.png',
    vibrate: item.kind === 'ev_value' ? [200, 90, 200] : [140, 70, 140],
    data: {
      matchId: item.matchId,
      url: `/?matchId=${encodeURIComponent(item.matchId)}`,
      kind: item.kind,
    },
  };
}
