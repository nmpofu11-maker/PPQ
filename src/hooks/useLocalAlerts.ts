import { useCallback, useEffect, useRef, useState } from 'react';
import type { DetectedTrendSignal, ScrapedMatch, ValueAlert } from '../types/soccer';
import {
  getPlatformAlertLabel,
  selectNewTriggerableAlerts,
  type AlertSeenRegistry,
  type CrossPlatformAlertItem,
} from '../engine/alertNotifier';
import {
  dispatchOsNotification,
  getAlertCapabilityStatus,
  playAlertChime,
  requestOsAlertPermission,
  type OsPermissionState,
} from '../services/notifications';
import { usePersistedState } from './usePersistedState';

const MAX_TOASTS = 3;
const TOAST_TTL_MS = 15_000;

function evItem(prefix: string, a: ValueAlert, nowMs: number): CrossPlatformAlertItem {
  return {
    id: `${prefix}-${nowMs}`,
    dedupKey: `${prefix}-${a.id}-${nowMs}`,
    kind: 'ev_value',
    matchId: a.matchId,
    matchTitle: a.matchTitle,
    league: a.league,
    minute: a.minute,
    scoreline: a.scoreline,
    headline: `+${a.evPct.toFixed(1)}% EV · ${a.selection}`,
    detail: `${a.market} · Model ${(a.modelProbability * 100).toFixed(1)}% vs ${a.bookmakerOddsAmerican} (${a.provider})`,
    evPct: a.evPct,
    tag: `pitchpulse-${prefix}-${a.matchId}`,
    createdAtMs: nowMs,
  };
}

/** In-app toasts, chime and native OS notifications for newly detected edges / attack surges. */
export function useLocalAlerts(params: {
  matches: ScrapedMatch[];
  allAlerts: ValueAlert[];
  allTrends: DetectedTrendSignal[];
  selectedMatchId: string | null;
  onInspectMatch: (matchId: string) => void;
}) {
  const { matches, allAlerts, allTrends, selectedMatchId, onInspectMatch } = params;

  const [alertCapability, setAlertCapability] = useState(() => getAlertCapabilityStatus());
  const [osAlertsEnabled, setOsAlertsEnabled] = usePersistedState<boolean>(
    'pitchpulse_os_alerts_enabled',
    getAlertCapabilityStatus().permission === 'granted'
  );
  const [soundAlertsEnabled, setSoundAlertsEnabled] = usePersistedState<boolean>(
    'pitchpulse_sound_alerts',
    true
  );
  const [alertNoticeMsg, setAlertNoticeMsg] = useState<string | null>(null);
  const [liveToasts, setLiveToasts] = useState<CrossPlatformAlertItem[]>([]);

  const registryRef = useRef<AlertSeenRegistry>({});
  const seededRef = useRef(false);

  const pushInAppToasts = useCallback((items: CrossPlatformAlertItem[]) => {
    if (items.length === 0) return;
    setLiveToasts((prev) => {
      const unique: CrossPlatformAlertItem[] = [];
      const seen = new Set<string>();
      for (const item of [...items, ...prev]) {
        if (!seen.has(item.dedupKey)) {
          seen.add(item.dedupKey);
          unique.push(item);
        }
        if (unique.length >= MAX_TOASTS) break;
      }
      return unique;
    });
  }, []);

  const dismissToast = useCallback((id: string) => {
    setLiveToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    if (liveToasts.length === 0) return;
    const timer = window.setTimeout(() => setLiveToasts((prev) => prev.slice(0, -1)), TOAST_TTL_MS);
    return () => window.clearTimeout(timer);
  }, [liveToasts]);

  // Dispatch notifications when new edges emerge (first pass only seeds the registry)
  useEffect(() => {
    if (matches.length === 0) return;
    const nowMs = Date.now();
    if (!seededRef.current) {
      const seeded = selectNewTriggerableAlerts({
        alerts: allAlerts,
        trends: allTrends,
        registry: registryRef.current,
        nowMs,
        seedOnly: true,
      });
      registryRef.current = seeded.nextRegistry;
      seededRef.current = true;
      return;
    }
    const { items, nextRegistry } = selectNewTriggerableAlerts({
      alerts: allAlerts,
      trends: allTrends,
      registry: registryRef.current,
      nowMs,
      includeTrends: true,
    });
    registryRef.current = nextRegistry;
    if (items.length === 0) return;
    pushInAppToasts(items);
    if (soundAlertsEnabled) playAlertChime(items[0].kind);
    if (osAlertsEnabled && alertCapability.permission === 'granted') {
      items.slice(0, 2).forEach((item) => {
        dispatchOsNotification(item, onInspectMatch).catch(() => {});
      });
    }
  }, [
    matches,
    allAlerts,
    allTrends,
    osAlertsEnabled,
    soundAlertsEnabled,
    alertCapability.permission,
    pushInAppToasts,
    onInspectMatch,
  ]);

  const toggleOsAlerts = useCallback(async () => {
    if (osAlertsEnabled) {
      setOsAlertsEnabled(false);
      setAlertNoticeMsg(null);
      return;
    }
    const perm: OsPermissionState = await requestOsAlertPermission();
    const updatedCap = getAlertCapabilityStatus();
    setAlertCapability({ ...updatedCap, permission: perm });

    if (perm === 'granted') {
      setOsAlertsEnabled(true);
      setAlertNoticeMsg(null);
      const nowMs = Date.now();
      const top = allAlerts[0];
      const item: CrossPlatformAlertItem = top
        ? { ...evItem('enabled-top', top, nowMs), dedupKey: `enabled-top-${top.id}` }
        : {
            id: `enabled-ready-${nowMs}`,
            dedupKey: 'enabled-ready',
            kind: 'attack_trend',
            matchId: selectedMatchId || '',
            matchTitle: 'Live Monitor Active',
            league: getPlatformAlertLabel(updatedCap.platform),
            minute: 0,
            scoreline: `${matches.filter((m) => m.state === 'in').length} Live`,
            headline: `${getPlatformAlertLabel(updatedCap.platform)} notifications enabled`,
            detail: 'You will be alerted when new +EV edges or persistent attack surges emerge.',
            tag: 'pitchpulse-ready',
            createdAtMs: nowMs,
          };
      dispatchOsNotification(item, onInspectMatch).catch(() => {});
      pushInAppToasts([item]);
      if (soundAlertsEnabled) playAlertChime(item.kind);
    } else if (perm === 'iframe-blocked') {
      setOsAlertsEnabled(false);
      setAlertNoticeMsg(
        'Embedded preview blocks native OS notification permission prompts. Open in a standalone browser tab to enable system alerts.'
      );
    } else if (perm === 'denied') {
      setOsAlertsEnabled(false);
      setAlertNoticeMsg(
        'Notifications are blocked in your browser site settings. Allow notifications in browser permissions to receive system alerts.'
      );
    } else {
      setOsAlertsEnabled(false);
      setAlertNoticeMsg('Browser Notification API is not supported on this device/browser.');
    }
  }, [
    osAlertsEnabled,
    setOsAlertsEnabled,
    allAlerts,
    selectedMatchId,
    matches,
    soundAlertsEnabled,
    onInspectMatch,
    pushInAppToasts,
  ]);

  const toggleSoundAlerts = useCallback(() => {
    const next = !soundAlertsEnabled;
    setSoundAlertsEnabled(next);
    if (next) playAlertChime('ev_value');
  }, [soundAlertsEnabled, setSoundAlertsEnabled]);

  const triggerTestAlert = useCallback(async () => {
    const nowMs = Date.now();
    const topAlert = allAlerts[0];
    const topTrend = allTrends[0];
    const item: CrossPlatformAlertItem = topAlert
      ? evItem('test', topAlert, nowMs)
      : topTrend
      ? {
          id: `test-${nowMs}`,
          dedupKey: `test-${topTrend.id}-${nowMs}`,
          kind: 'attack_trend',
          matchId: topTrend.matchId,
          matchTitle: topTrend.matchTitle,
          league: topTrend.league,
          minute: topTrend.minute,
          scoreline: topTrend.scoreline,
          headline: `${topTrend.teamName}: ${topTrend.patternLabel}`,
          detail: `${topTrend.recentShots} shots (${topTrend.recentShotsOnTarget} SoT) · ${topTrend.recommendedSelection} (${(topTrend.modelProbability * 100).toFixed(1)}%)`,
          tag: `pitchpulse-test-${topTrend.matchId}`,
          createdAtMs: nowMs,
        }
      : {
          id: `test-${nowMs}`,
          dedupKey: `test-monitor-${nowMs}`,
          kind: 'attack_trend',
          matchId: selectedMatchId || '',
          matchTitle: 'Live Monitor Active',
          league: getPlatformAlertLabel(alertCapability.platform),
          minute: 0,
          scoreline: `${matches.filter((m) => m.state === 'in').length} Live`,
          headline: 'System alert pipeline verified',
          detail: 'Polling every 30s for new +EV edges and persistent attack surges.',
          tag: 'pitchpulse-test-monitor',
          createdAtMs: nowMs,
        };

    pushInAppToasts([item]);
    if (soundAlertsEnabled) playAlertChime(item.kind);
    if (alertCapability.permission === 'granted') {
      await dispatchOsNotification(item, onInspectMatch);
    } else if (osAlertsEnabled) {
      await toggleOsAlerts();
    }
  }, [
    allAlerts,
    allTrends,
    selectedMatchId,
    matches,
    alertCapability.platform,
    alertCapability.permission,
    soundAlertsEnabled,
    osAlertsEnabled,
    pushInAppToasts,
    onInspectMatch,
    toggleOsAlerts,
  ]);

  return {
    alertCapability,
    osAlertsEnabled,
    soundAlertsEnabled,
    alertNoticeMsg,
    dismissNotice: () => setAlertNoticeMsg(null),
    liveToasts,
    dismissToast,
    toggleOsAlerts,
    toggleSoundAlerts,
    triggerTestAlert,
  };
}
