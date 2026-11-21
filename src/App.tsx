import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { Bell, BellOff, Star, Volume2, VolumeX } from 'lucide-react';
import type {
  AlertScopeMode,
  DetectedTrendSignal,
  LiveCapturedSnapshot,
  MatchLifecycleState,
  ModelIntelligencePayload,
  PaperBetRecord,
  PureFlowPrediction,
  ScrapedMatch,
  TacticalAiBrief,
  ValueAlert,
} from './types/soccer';
import {
  predictMatchMarkets,
  slugifyTeamKey,
  toOddsFreeSnapshot,
} from './engine/momentumMath';
import { evaluateBettingValue } from './engine/valueDetector';
import { detectAttackTrends } from './engine/trendDetector';
import {
  computePaperLedgerSummary,
  recordNewPaperBets,
  settlePaperBets,
} from './engine/paperLedger';
import { captureLiveMilestoneSnapshots } from './engine/snapshotRecorder';
import { filterMatchIdsByAlertScope, isTopTierLeague } from './engine/leagueTiers';
import {
  getPlatformAlertLabel,
  selectNewTriggerableAlerts,
  type AlertSeenRegistry,
  type CrossPlatformAlertItem,
} from './engine/alertNotifier';
import {
  createInitialModelState,
  evaluateAndUpdateModel,
} from './engine/learningModel';
import {
  auth,
  signInWithGoogle,
  signOutUser,
  testFirestoreConnection,
} from './services/firebase';
import {
  ensureUserProfile,
  loadLiveSnapshotsFromFirestore,
  loadModelIntelligenceFromFirestore,
  loadPaperBetsFromFirestore,
  loadUserMinEvThreshold,
  saveCalibrationToFirestore,
  saveLiveSnapshotsToFirestore,
  savePaperBetsToFirestore,
  saveTrendAlertToFirestore,
} from './services/persistence';
import {
  dispatchOsNotification,
  getAlertCapabilityStatus,
  getBackgroundPushSubscriptionState,
  playAlertChime,
  requestOsAlertPermission,
  sendBackgroundPushTest,
  subscribeToBackgroundWebPush,
  syncBackgroundPushPreferences,
  unsubscribeFromBackgroundWebPush,
  type OsPermissionState,
} from './services/notifications';
import { MatchInspector } from './components/MatchInspector';
import { ValueAlertsView } from './components/ValueAlertsView';
import { LearningDashboard } from './components/LearningDashboard';
import { MethodologyView } from './components/MethodologyView';
import { LiveAlertToastStack } from './components/LiveAlertToastStack';
import { PWAInstallButton } from './components/PWAInstallButton';
import { OfflineIndicator } from './components/OfflineIndicator';

type ActiveTab = 'radar' | 'alerts' | 'learning' | 'methodology';
type StatusFilter = 'all' | MatchLifecycleState;

function loadStoredJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('radar');
  const [matches, setMatches] = useState<ScrapedMatch[]>([]);
  const [sourcesMeta, setSourcesMeta] = useState<{
    espnCount: number;
    bbcCrossCheckedCount: number;
    scrapedAt: string;
  } | null>(null);
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [leagueFilter, setLeagueFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [minEvThreshold, setMinEvThreshold] = useState<number>(3);
  const [autoPoll, setAutoPoll] = useState<boolean>(true);

  const [isLoadingMatches, setIsLoadingMatches] = useState<boolean>(true);
  const [isRefreshingSingle, setIsRefreshingSingle] = useState<boolean>(false);
  const [scrapeError, setScrapeError] = useState<string | null>(null);

  const [modelState, setModelState] = useState<ModelIntelligencePayload>(() =>
    createInitialModelState()
  );
  const [isCalibrating, setIsCalibrating] = useState<boolean>(false);
  const [calibrationStatusMsg, setCalibrationStatusMsg] = useState<string | null>(null);

  const [user, setUser] = useState<User | null>(null);
  const [firestoreStatus, setFirestoreStatus] = useState<
    'connected' | 'offline' | 'error' | 'checking'
  >('checking');

  const [aiBriefs, setAiBriefs] = useState<Record<string, TacticalAiBrief>>({});
  const [loadingTrendIds, setLoadingTrendIds] = useState<Record<string, boolean>>({});
  const [trendErrors, setTrendErrors] = useState<Record<string, string>>({});

  // Cross-platform Windows / Android notification state
  const [alertCapability, setAlertCapability] = useState(() =>
    getAlertCapabilityStatus()
  );
  const [osAlertsEnabled, setOsAlertsEnabled] = useState<boolean>(() => {
    try {
      const saved = window.localStorage.getItem('pitchpulse_os_alerts_enabled');
      if (saved !== null) return saved === 'true';
    } catch {
      // Ignore storage errors
    }
    return getAlertCapabilityStatus().permission === 'granted';
  });
  const [soundAlertsEnabled, setSoundAlertsEnabled] = useState<boolean>(() => {
    try {
      const saved = window.localStorage.getItem('pitchpulse_sound_alerts');
      return saved === null ? true : saved === 'true';
    } catch {
      return true;
    }
  });
  const [alertNoticeMsg, setAlertNoticeMsg] = useState<string | null>(null);
  const [liveToasts, setLiveToasts] = useState<CrossPlatformAlertItem[]>([]);

  // Chief-Engineer Upgrades State
  const [watchlistIds, setWatchlistIds] = useState<string[]>(() =>
    loadStoredJson<string[]>('pitchpulse_watchlist_ids', [])
  );
  const [radarScope, setRadarScope] = useState<AlertScopeMode>('all');
  const [verifiedLiveOnly, setVerifiedLiveOnly] = useState<boolean>(() =>
    loadStoredJson<boolean>('pitchpulse_verified_live_only', true)
  );
  const [alertScope, setAlertScope] = useState<AlertScopeMode>(() =>
    loadStoredJson<AlertScopeMode>('pitchpulse_alert_scope', 'all')
  );
  const [autoAiOnOverlap, setAutoAiOnOverlap] = useState<boolean>(() =>
    loadStoredJson<boolean>('pitchpulse_auto_ai_overlap', false)
  );
  const [paperBets, setPaperBets] = useState<PaperBetRecord[]>(() =>
    loadStoredJson<PaperBetRecord[]>('pitchpulse_paper_bets', [])
  );
  const [liveSnapshots, setLiveSnapshots] = useState<LiveCapturedSnapshot[]>(() =>
    loadStoredJson<LiveCapturedSnapshot[]>('pitchpulse_live_snapshots', [])
  );

  // True Background Web Push (VAPID)
  const [bgPushSupported, setBgPushSupported] = useState<boolean>(false);
  const [bgPushSubscribed, setBgPushSubscribed] = useState<boolean>(false);
  const [bgPushBusy, setBgPushBusy] = useState<boolean>(false);
  const [bgPushNotice, setBgPushNotice] = useState<string | null>(null);

  const alertRegistryRef = useRef<AlertSeenRegistry>({});
  const hasSeededAlertsRef = useRef<boolean>(false);
  const autoAiAttemptedRef = useRef<Set<string>>(new Set());

  const modelStateRef = useRef(modelState);
  modelStateRef.current = modelState;
  const userRef = useRef(user);
  userRef.current = user;
  const liveSnapshotsRef = useRef(liveSnapshots);
  liveSnapshotsRef.current = liveSnapshots;
  const paperBetsRef = useRef(paperBets);
  paperBetsRef.current = paperBets;

  // Startup Firestore connectivity check, Auth listener, & Push subscription check
  useEffect(() => {
    let active = true;
    testFirestoreConnection().then((status) => {
      if (active) setFirestoreStatus(status);
    });
    getBackgroundPushSubscriptionState().then((st) => {
      if (!active) return;
      setBgPushSupported(st.supported);
      setBgPushSubscribed(st.subscribed);
    });

    const unsub = onAuthStateChanged(auth, async (nextUser) => {
      if (!active) return;
      setUser(nextUser);
      if (nextUser) {
        try {
          await ensureUserProfile(nextUser, minEvThreshold);
          const savedThresh = await loadUserMinEvThreshold(nextUser.uid);
          if (savedThresh !== null && active) {
            setMinEvThreshold(savedThresh);
          }
          const [loadedModel, loadedBets, loadedSnaps] = await Promise.all([
            loadModelIntelligenceFromFirestore(nextUser.uid),
            loadPaperBetsFromFirestore(nextUser.uid).catch(() => []),
            loadLiveSnapshotsFromFirestore(nextUser.uid).catch(() => []),
          ]);
          if (loadedModel && active) {
            setModelState(loadedModel);
          }
          if (loadedBets.length > 0 && active) {
            setPaperBets((prev) => {
              const merged = new Map<string, PaperBetRecord>();
              for (const b of prev) merged.set(b.id, b);
              for (const b of loadedBets) merged.set(b.id, b);
              return Array.from(merged.values()).slice(0, 250);
            });
          }
          if (loadedSnaps.length > 0 && active) {
            setLiveSnapshots((prev) => {
              const merged = new Map<string, LiveCapturedSnapshot>();
              for (const s of prev) merged.set(s.id, s);
              for (const s of loadedSnaps) merged.set(s.id, s);
              return Array.from(merged.values()).slice(0, 200);
            });
          }
        } catch {
          // Handled via structured handleFirestoreError logging
        }
      }
    });

    return () => {
      active = false;
      unsub();
    };
  }, []);

  // Deep-link from Windows/Android notification click (?matchId=... or SW postMessage)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const linkedMatchId = params.get('matchId');
    if (linkedMatchId) {
      setSelectedMatchId(linkedMatchId);
      setActiveTab('radar');
    }

    const handleSwMessage = (event: MessageEvent) => {
      if (
        event.data?.type === 'SELECT_MATCH_FROM_ALERT' &&
        typeof event.data.matchId === 'string' &&
        event.data.matchId
      ) {
        setSelectedMatchId(event.data.matchId);
        setActiveTab('radar');
      }
    };

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', handleSwMessage);
    }
    return () => {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.removeEventListener('message', handleSwMessage);
      }
    };
  }, []);

  const persistIfSignedIn = useCallback(
    async (
      nextModel: ModelIntelligencePayload,
      newAudits: ModelIntelligencePayload['recentAudits'],
      sourceMatches: ScrapedMatch[]
    ) => {
      const currentUser = userRef.current;
      if (!currentUser) return;
      const teamDisplayNames: Record<string, string> = {};
      for (const m of sourceMatches) {
        teamDisplayNames[slugifyTeamKey(m.homeTeam)] = m.homeTeam;
        teamDisplayNames[slugifyTeamKey(m.awayTeam)] = m.awayTeam;
      }
      await saveCalibrationToFirestore(currentUser, nextModel, newAudits, teamDisplayNames);
    },
    []
  );

  const fetchLiveFeed = useCallback(
    async (silent = false) => {
      if (!silent) setIsLoadingMatches(true);
      setScrapeError(null);
      try {
        const res = await fetch('/api/matches/live');
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `Scrape failed (${res.status})`);
        }
        const data = await res.json();
        const scraped: ScrapedMatch[] = Array.isArray(data.matches) ? data.matches : [];
        setMatches(scraped);
        setSourcesMeta(data.sources || null);

        setSelectedMatchId((prev) => {
          if (prev && scraped.some((m) => m.id === prev)) return prev;
          const firstLive = scraped.find((m) => m.state === 'in');
          const firstFlow = scraped.find((m) => m.hasDetailedFlow);
          return firstLive?.id || firstFlow?.id || scraped[0]?.id || null;
        });

        // 1. Capture authentic live milestone snapshots (30', 45', 60', 75') for unbiased learning
        const liveWithFlow = scraped.filter((m) => m.state === 'in' && m.hasDetailedFlow);
        let latestSnaps = liveSnapshotsRef.current;
        if (liveWithFlow.length > 0) {
          const cap = captureLiveMilestoneSnapshots({
            liveMatches: liveWithFlow,
            existingSnapshots: liveSnapshotsRef.current,
            modelState: modelStateRef.current,
          });
          if (cap.addedSnapshots.length > 0) {
            latestSnaps = cap.nextSnapshots;
            setLiveSnapshots(cap.nextSnapshots);
            try {
              window.localStorage.setItem(
                'pitchpulse_live_snapshots',
                JSON.stringify(cap.nextSnapshots.slice(0, 120))
              );
            } catch {
              // Ignore quota errors
            }
            if (userRef.current) {
              saveLiveSnapshotsToFirestore(userRef.current, cap.addedSnapshots).catch(() => {});
            }
          }
        }

        // 2. Continuous learning: evaluate newly finished today matches preferring exact live captures
        const finishedWithFlow = scraped.filter(
          (m) => m.state === 'post' && m.hasDetailedFlow
        );
        if (finishedWithFlow.length > 0) {
          const { nextState, newAudits, processedCount } = evaluateAndUpdateModel(
            finishedWithFlow,
            modelStateRef.current,
            65,
            latestSnaps
          );
          if (processedCount > 0) {
            setModelState(nextState);
            persistIfSignedIn(nextState, newAudits, finishedWithFlow).catch(() => {});
          }
        }

        // 3. Settle any open paper bets on newly finished matches
        const allFinished = scraped.filter((m) => m.state === 'post');
        if (allFinished.length > 0 && paperBetsRef.current.some((b) => b.status === 'open')) {
          const settled = settlePaperBets({
            bets: paperBetsRef.current,
            finishedMatches: allFinished,
          });
          if (settled.settledBets.length > 0) {
            setPaperBets(settled.nextBets);
            try {
              window.localStorage.setItem(
                'pitchpulse_paper_bets',
                JSON.stringify(settled.nextBets)
              );
            } catch {
              // Ignore storage quota
            }
            if (userRef.current) {
              savePaperBetsToFirestore(userRef.current, settled.settledBets).catch(() => {});
            }
          }
        }
      } catch (err) {
        setScrapeError(
          err instanceof Error ? err.message : 'Unable to scrape live matches'
        );
      } finally {
        setIsLoadingMatches(false);
      }
    },
    [persistIfSignedIn]
  );

  useEffect(() => {
    fetchLiveFeed(false);
  }, [fetchLiveFeed]);

  useEffect(() => {
    if (!autoPoll) return;
    const timer = window.setInterval(() => {
      fetchLiveFeed(true);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [autoPoll, fetchLiveFeed]);

  const handleRefreshSingleMatch = useCallback(async (matchId: string) => {
    setIsRefreshingSingle(true);
    try {
      const res = await fetch(`/api/matches/${encodeURIComponent(matchId)}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.match) {
        setMatches((prev) =>
          prev.map((m) => (m.id === matchId ? (data.match as ScrapedMatch) : m))
        );
      }
    } finally {
      setIsRefreshingSingle(false);
    }
  }, []);

  const handleRunHistoricalCalibration = useCallback(
    async (days: number, snapshotMinute: number) => {
      setIsCalibrating(true);
      setCalibrationStatusMsg(null);
      try {
        const res = await fetch(
          `/api/historical/finished?days=${encodeURIComponent(String(days))}`
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || 'Historical scrape failed');
        }
        const data = await res.json();
        const finished: ScrapedMatch[] = Array.isArray(data.matches) ? data.matches : [];
        const { nextState, newAudits, processedCount } = evaluateAndUpdateModel(
          finished,
          modelStateRef.current,
          snapshotMinute,
          liveSnapshotsRef.current
        );

        if (processedCount === 0) {
          setCalibrationStatusMsg(
            `Scraped ${finished.length} completed matches across ${data.datesScraped?.join(', ')} — all available matches were already evaluated.`
          );
        } else {
          setModelState(nextState);
          await persistIfSignedIn(nextState, newAudits, finished);
          setCalibrationStatusMsg(
            `Evaluated +${processedCount} real finished matches at ${snapshotMinute}' snapshot (${nextState.metrics.totalEvaluated} total). Mean Brier: ${nextState.metrics.meanBrierScore?.toFixed(4)} · Accuracy: ${nextState.metrics.accuracyPct?.toFixed(1)}%.`
          );
        }
      } catch (err) {
        setCalibrationStatusMsg(
          err instanceof Error ? err.message : 'Historical calibration failed.'
        );
      } finally {
        setIsCalibrating(false);
      }
    },
    [persistIfSignedIn]
  );

  const handleThresholdChange = useCallback(async (nextVal: number) => {
    setMinEvThreshold(nextVal);
    if (userRef.current) {
      try {
        await ensureUserProfile(userRef.current, nextVal);
      } catch {
        // Logged by handleFirestoreError
      }
    }
  }, []);

  const handleGoogleSignIn = useCallback(async () => {
    try {
      await signInWithGoogle();
    } catch {
      // Popup closed or blocked
    }
  }, []);

  const handleSignOut = useCallback(async () => {
    await signOutUser();
  }, []);

  const watchlistSet = useMemo(() => new Set(watchlistIds), [watchlistIds]);

  const scopedMatchIds = useMemo(
    () =>
      filterMatchIdsByAlertScope({
        matches,
        scope: alertScope,
        watchlistIds: watchlistSet,
      }),
    [matches, alertScope, watchlistSet]
  );

  // Compute pure-flow predictions (100% odds-free), rolling attack trends, & Stage 2 +EV alerts
  const { predictionsByMatch, alertsByMatch, allAlerts, trendsByMatch, allTrends } = useMemo(() => {
    const preds = new Map<string, PureFlowPrediction>();
    const alertsMap = new Map<string, ValueAlert[]>();
    const flatAlerts: ValueAlert[] = [];
    const trendsMap = new Map<string, DetectedTrendSignal[]>();
    const flatTrends: DetectedTrendSignal[] = [];

    for (const m of matches) {
      const snap = toOddsFreeSnapshot(m);
      const pred = predictMatchMarkets(snap, modelState);
      preds.set(m.id, pred);

      const matchTrends = detectAttackTrends(snap, pred, 10);
      trendsMap.set(m.id, matchTrends);
      if (scopedMatchIds.has(m.id)) {
        flatTrends.push(...matchTrends);
      }

      const evs = evaluateBettingValue(m, pred, minEvThreshold, {
        verifiedLiveOnly,
      });
      alertsMap.set(m.id, evs);
      if (scopedMatchIds.has(m.id)) {
        flatAlerts.push(...evs);
      }
    }

    flatAlerts.sort((a, b) => b.evPct - a.evPct);
    flatTrends.sort((a, b) => b.intensityScore - a.intensityScore);
    return {
      predictionsByMatch: preds,
      alertsByMatch: alertsMap,
      allAlerts: flatAlerts,
      trendsByMatch: trendsMap,
      allTrends: flatTrends,
    };
  }, [matches, modelState, minEvThreshold, verifiedLiveOnly, scopedMatchIds]);

  const paperSummary = useMemo(
    () => computePaperLedgerSummary(paperBets),
    [paperBets]
  );

  // Automatically log qualified +EV edges into the Paper-Bet Ledger
  useEffect(() => {
    if (matches.length === 0 || allAlerts.length === 0) return;
    const matchesById = new Map(matches.map((m) => [m.id, m]));
    const rec = recordNewPaperBets({
      existingBets: paperBetsRef.current,
      alerts: allAlerts,
      matchesById,
    });
    if (rec.addedBets.length > 0) {
      setPaperBets(rec.nextBets);
      try {
        window.localStorage.setItem('pitchpulse_paper_bets', JSON.stringify(rec.nextBets));
      } catch {
        // Ignore quota errors
      }
      if (userRef.current) {
        savePaperBetsToFirestore(userRef.current, rec.addedBets).catch(() => {});
      }
    }
  }, [matches, allAlerts]);

  const handleToggleWatchlist = useCallback((matchId: string) => {
    setWatchlistIds((prev) => {
      const next = prev.includes(matchId)
        ? prev.filter((id) => id !== matchId)
        : [matchId, ...prev].slice(0, 100);
      try {
        window.localStorage.setItem('pitchpulse_watchlist_ids', JSON.stringify(next));
      } catch {
        // Ignore storage errors
      }
      return next;
    });
  }, []);

  const handleToggleVerifiedLiveOnly = useCallback(() => {
    setVerifiedLiveOnly((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem('pitchpulse_verified_live_only', JSON.stringify(next));
      } catch {
        // Ignore
      }
      return next;
    });
  }, []);

  const handleChangeAlertScope = useCallback((next: AlertScopeMode) => {
    setAlertScope(next);
    try {
      window.localStorage.setItem('pitchpulse_alert_scope', JSON.stringify(next));
    } catch {
      // Ignore
    }
  }, []);

  const handleToggleAutoAiOnOverlap = useCallback(() => {
    setAutoAiOnOverlap((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem('pitchpulse_auto_ai_overlap', JSON.stringify(next));
      } catch {
        // Ignore
      }
      return next;
    });
  }, []);

  const handleResetPaperLedger = useCallback(() => {
    setPaperBets([]);
    try {
      window.localStorage.removeItem('pitchpulse_paper_bets');
    } catch {
      // Ignore
    }
  }, []);

  // Keep Background Push preferences synchronized with active user filters
  useEffect(() => {
    if (!bgPushSubscribed) return;
    syncBackgroundPushPreferences({
      minEvThreshold,
      verifiedLiveOnly,
      scope: alertScope,
      watchlistIds,
    }).catch(() => {});
  }, [bgPushSubscribed, minEvThreshold, verifiedLiveOnly, alertScope, watchlistIds]);

  const handleToggleBackgroundPush = useCallback(async () => {
    setBgPushBusy(true);
    setBgPushNotice(null);
    try {
      if (bgPushSubscribed) {
        await unsubscribeFromBackgroundWebPush();
        setBgPushSubscribed(false);
        setBgPushNotice('Background Web Push unsubscribed on this device.');
      } else {
        const res = await subscribeToBackgroundWebPush({
          minEvThreshold,
          verifiedLiveOnly,
          scope: alertScope,
          watchlistIds,
        });
        if (res.ok) {
          setBgPushSubscribed(true);
          setBgPushNotice(
            'Subscribed: Server 45s monitor will alert this device even when the browser tab is closed.'
          );
        } else {
          setBgPushNotice(res.error || 'Could not enable background push notifications.');
        }
      }
    } finally {
      setBgPushBusy(false);
    }
  }, [bgPushSubscribed, minEvThreshold, verifiedLiveOnly, alertScope, watchlistIds]);

  const handleTestBackgroundPush = useCallback(async () => {
    setBgPushBusy(true);
    setBgPushNotice(null);
    try {
      const res = await sendBackgroundPushTest();
      setBgPushNotice(
        res.ok
          ? 'Test VAPID push dispatched via Service Worker.'
          : 'No active push subscription responded on the server. Try re-subscribing.'
      );
    } finally {
      setBgPushBusy(false);
    }
  }, []);

  const handleInspectMatchFromAlert = useCallback((matchId: string) => {
    setSelectedMatchId(matchId);
    setActiveTab('radar');
  }, []);

  const pushInAppToasts = useCallback((items: CrossPlatformAlertItem[]) => {
    if (items.length === 0) return;
    setLiveToasts((prev) => {
      const merged = [...items, ...prev];
      const unique: CrossPlatformAlertItem[] = [];
      const seenIds = new Set<string>();
      for (const item of merged) {
        if (!seenIds.has(item.dedupKey)) {
          seenIds.add(item.dedupKey);
          unique.push(item);
        }
        if (unique.length >= 3) break;
      }
      return unique;
    });
  }, []);

  // Auto-dismiss live toasts after 15 seconds
  useEffect(() => {
    if (liveToasts.length === 0) return;
    const timer = window.setTimeout(() => {
      setLiveToasts((prev) => prev.slice(0, -1));
    }, 15_000);
    return () => window.clearTimeout(timer);
  }, [liveToasts]);

  // Monitor live scraped alerts & dispatch Windows Toast / Android System Notification when new edges emerge
  useEffect(() => {
    if (matches.length === 0) return;

    const nowMs = Date.now();
    if (!hasSeededAlertsRef.current) {
      const seeded = selectNewTriggerableAlerts({
        alerts: allAlerts,
        trends: allTrends,
        registry: alertRegistryRef.current,
        nowMs,
        seedOnly: true,
      });
      alertRegistryRef.current = seeded.nextRegistry;
      hasSeededAlertsRef.current = true;
      return;
    }

    const { items, nextRegistry } = selectNewTriggerableAlerts({
      alerts: allAlerts,
      trends: allTrends,
      registry: alertRegistryRef.current,
      nowMs,
      includeTrends: true,
    });
    alertRegistryRef.current = nextRegistry;

    if (items.length > 0) {
      pushInAppToasts(items);
      if (soundAlertsEnabled) {
        playAlertChime(items[0].kind);
      }
      if (osAlertsEnabled && alertCapability.permission === 'granted') {
        items.slice(0, 2).forEach((item) => {
          dispatchOsNotification(item, handleInspectMatchFromAlert).catch(() => {});
        });
      }
    }
  }, [
    matches,
    allAlerts,
    allTrends,
    osAlertsEnabled,
    soundAlertsEnabled,
    alertCapability.permission,
    pushInAppToasts,
    handleInspectMatchFromAlert,
  ]);

  const handleToggleOsAlerts = useCallback(async () => {
    if (osAlertsEnabled) {
      setOsAlertsEnabled(false);
      setAlertNoticeMsg(null);
      try {
        window.localStorage.setItem('pitchpulse_os_alerts_enabled', 'false');
      } catch {
        // Ignore storage errors
      }
      return;
    }

    const perm: OsPermissionState = await requestOsAlertPermission();
    const updatedCap = getAlertCapabilityStatus();
    setAlertCapability({ ...updatedCap, permission: perm });

    if (perm === 'granted') {
      setOsAlertsEnabled(true);
      setAlertNoticeMsg(null);
      try {
        window.localStorage.setItem('pitchpulse_os_alerts_enabled', 'true');
      } catch {
        // Ignore storage errors
      }
      // Dispatch an immediate confirmation or current top real +EV alert
      const topAlert = allAlerts[0];
      const item: CrossPlatformAlertItem = topAlert
        ? {
            id: `enabled-top-${Date.now()}`,
            dedupKey: `enabled-top-${topAlert.id}`,
            kind: 'ev_value',
            matchId: topAlert.matchId,
            matchTitle: topAlert.matchTitle,
            league: topAlert.league,
            minute: topAlert.minute,
            scoreline: topAlert.scoreline,
            headline: `+${topAlert.evPct.toFixed(1)}% EV · ${topAlert.selection}`,
            detail: `${topAlert.market} · Model ${(topAlert.modelProbability * 100).toFixed(1)}% vs ${topAlert.bookmakerOddsAmerican} (${topAlert.provider})`,
            evPct: topAlert.evPct,
            tag: `pitchpulse-ev-${topAlert.matchId}`,
            createdAtMs: Date.now(),
          }
        : {
            id: `enabled-ready-${Date.now()}`,
            dedupKey: 'enabled-ready',
            kind: 'attack_trend',
            matchId: selectedMatchId || '',
            matchTitle: 'Live Monitor Active',
            league: getPlatformAlertLabel(updatedCap.platform),
            minute: 0,
            scoreline: `${matches.filter((m) => m.state === 'in').length} Live`,
            headline: `${getPlatformAlertLabel(updatedCap.platform)} notifications enabled`,
            detail: 'You will be alerted automatically when new +EV edges or persistent attack surges emerge.',
            tag: 'pitchpulse-ready',
            createdAtMs: Date.now(),
          };
      dispatchOsNotification(item, handleInspectMatchFromAlert).catch(() => {});
      pushInAppToasts([item]);
      if (soundAlertsEnabled) playAlertChime(item.kind);
    } else if (perm === 'iframe-blocked') {
      setOsAlertsEnabled(false);
      setAlertNoticeMsg(
        'Embedded preview blocks native OS notification permission prompts. Open in a standalone browser tab to enable Windows/Android system alerts.'
      );
    } else if (perm === 'denied') {
      setOsAlertsEnabled(false);
      setAlertNoticeMsg(
        'Notifications are blocked in your browser site settings. Allow notifications in browser permissions to receive Windows/Android alerts.'
      );
    } else {
      setOsAlertsEnabled(false);
      setAlertNoticeMsg('Browser Notification API is not supported on this device/browser.');
    }
  }, [
    osAlertsEnabled,
    allAlerts,
    selectedMatchId,
    matches,
    soundAlertsEnabled,
    handleInspectMatchFromAlert,
    pushInAppToasts,
  ]);

  const handleToggleSoundAlerts = useCallback(() => {
    setSoundAlertsEnabled((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem('pitchpulse_sound_alerts', String(next));
      } catch {
        // Ignore storage errors
      }
      if (next) playAlertChime('ev_value');
      return next;
    });
  }, []);

  const handleTriggerTestAlert = useCallback(async () => {
    const topAlert = allAlerts[0];
    const topTrend = allTrends[0];
    const item: CrossPlatformAlertItem = topAlert
      ? {
          id: `test-${Date.now()}`,
          dedupKey: `test-${topAlert.id}-${Date.now()}`,
          kind: 'ev_value',
          matchId: topAlert.matchId,
          matchTitle: topAlert.matchTitle,
          league: topAlert.league,
          minute: topAlert.minute,
          scoreline: topAlert.scoreline,
          headline: `+${topAlert.evPct.toFixed(1)}% EV · ${topAlert.selection}`,
          detail: `${topAlert.market} · Model ${(topAlert.modelProbability * 100).toFixed(1)}% vs ${topAlert.bookmakerOddsAmerican} (${topAlert.provider})`,
          evPct: topAlert.evPct,
          tag: `pitchpulse-test-${topAlert.matchId}`,
          createdAtMs: Date.now(),
        }
      : topTrend
      ? {
          id: `test-${Date.now()}`,
          dedupKey: `test-${topTrend.id}-${Date.now()}`,
          kind: 'attack_trend',
          matchId: topTrend.matchId,
          matchTitle: topTrend.matchTitle,
          league: topTrend.league,
          minute: topTrend.minute,
          scoreline: topTrend.scoreline,
          headline: `${topTrend.teamName}: ${topTrend.patternLabel}`,
          detail: `${topTrend.recentShots} shots (${topTrend.recentShotsOnTarget} SoT) · ${topTrend.recommendedSelection} (${(topTrend.modelProbability * 100).toFixed(1)}%)`,
          tag: `pitchpulse-test-${topTrend.matchId}`,
          createdAtMs: Date.now(),
        }
      : {
          id: `test-${Date.now()}`,
          dedupKey: `test-monitor-${Date.now()}`,
          kind: 'attack_trend',
          matchId: selectedMatchId || '',
          matchTitle: 'Live Monitor Active',
          league: getPlatformAlertLabel(alertCapability.platform),
          minute: 0,
          scoreline: `${matches.filter((m) => m.state === 'in').length} Live`,
          headline: 'System alert pipeline verified',
          detail: 'Polling ESPN & BBC every 30s for new +EV edges and persistent attack surges.',
          tag: 'pitchpulse-test-monitor',
          createdAtMs: Date.now(),
        };

    pushInAppToasts([item]);
    if (soundAlertsEnabled) playAlertChime(item.kind);

    if (alertCapability.permission === 'granted') {
      await dispatchOsNotification(item, handleInspectMatchFromAlert);
    } else if (osAlertsEnabled) {
      await handleToggleOsAlerts();
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
    handleInspectMatchFromAlert,
    handleToggleOsAlerts,
  ]);

  const handleAnalyzeTrend = useCallback(
    async (trend: DetectedTrendSignal) => {
      const match = matches.find((m) => m.id === trend.matchId);
      const pred = predictionsByMatch.get(trend.matchId);
      if (!match || !pred) return;

      setLoadingTrendIds((prev) => ({ ...prev, [trend.id]: true }));
      setTrendErrors((prev) => {
        const next = { ...prev };
        delete next[trend.id];
        return next;
      });

      try {
        const res = await fetch('/api/alerts/tactical-brief', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            trend,
            homeTeam: match.homeTeam,
            awayTeam: match.awayTeam,
            possessionHome: match.homeStats.possessionPct,
            possessionAway: match.awayStats.possessionPct,
            shotsHome: `${match.homeStats.totalShots} (${match.homeStats.shotsOnTarget} SoT)`,
            shotsAway: `${match.awayStats.totalShots} (${match.awayStats.shotsOnTarget} SoT)`,
            nextGoalHomeProb: pred.markets.nextTeamToScore.homeProb,
            nextGoalAwayProb: pred.markets.nextTeamToScore.awayProb,
            winHomeProb: pred.markets.winner1X2.homeProb,
            drawProb: pred.markets.winner1X2.drawProb,
            winAwayProb: pred.markets.winner1X2.awayProb,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || `AI analysis failed (${res.status})`);
        }
        const brief = data.brief as TacticalAiBrief;
        setAiBriefs((prev) => ({ ...prev, [trend.id]: brief }));

        if (userRef.current) {
          saveTrendAlertToFirestore(userRef.current, trend, brief).catch(() => {});
        }
      } catch (err) {
        setTrendErrors((prev) => ({
          ...prev,
          [trend.id]:
            err instanceof Error ? err.message : 'Unable to generate AI tactical brief.',
        }));
      } finally {
        setLoadingTrendIds((prev) => ({ ...prev, [trend.id]: false }));
      }
    },
    [matches, predictionsByMatch]
  );

  // Auto-AI Tactical Brief when enabled and a live match has BOTH >=5% +EV edge and a rolling attack surge
  useEffect(() => {
    if (!autoAiOnOverlap || allTrends.length === 0 || allAlerts.length === 0) return;
    const highEvMatchIds = new Set(
      allAlerts.filter((a) => a.evPct >= 5.0).map((a) => a.matchId)
    );
    const overlapping = allTrends.filter(
      (tr) =>
        highEvMatchIds.has(tr.matchId) &&
        !aiBriefs[tr.id] &&
        !loadingTrendIds[tr.id] &&
        !autoAiAttemptedRef.current.has(tr.id)
    );
    if (overlapping.length === 0) return;
    const target = overlapping[0];
    autoAiAttemptedRef.current.add(target.id);
    handleAnalyzeTrend(target);
  }, [autoAiOnOverlap, allTrends, allAlerts, aiBriefs, loadingTrendIds, handleAnalyzeTrend]);

  const leagues = useMemo(() => {
    const set = new Set<string>();
    for (const m of matches) set.add(m.league);
    return ['ALL', ...Array.from(set).sort()];
  }, [matches]);

  const filteredMatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return matches.filter((m) => {
      if (statusFilter !== 'all' && m.state !== statusFilter) return false;
      if (radarScope === 'watchlist' && !watchlistSet.has(m.id)) return false;
      if (radarScope === 'top_leagues' && !isTopTierLeague(m.league, m.leagueSlug)) return false;
      if (leagueFilter !== 'ALL' && m.league !== leagueFilter) return false;
      if (
        q &&
        !m.homeTeam.toLowerCase().includes(q) &&
        !m.awayTeam.toLowerCase().includes(q) &&
        !m.league.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [matches, statusFilter, radarScope, watchlistSet, leagueFilter, searchQuery]);

  const liveCount = useMemo(
    () => matches.filter((m) => m.state === 'in').length,
    [matches]
  );

  const selectedMatch =
    matches.find((m) => m.id === selectedMatchId) || filteredMatches[0] || null;
  const selectedPrediction = selectedMatch
    ? predictionsByMatch.get(selectedMatch.id) || null
    : null;
  const selectedAlerts = selectedMatch
    ? alertsByMatch.get(selectedMatch.id) || []
    : [];
  const selectedTrends = selectedMatch
    ? trendsByMatch.get(selectedMatch.id) || []
    : [];

  return (
    <div className="min-h-screen bg-[#0B0F17] text-slate-100 flex flex-col">
      {/* Top Bar Contract: Exactly 3 zones separated by gap-8 */}
      <header className="border-b border-white/8 bg-[#0E141F] px-6 py-3.5 flex items-center justify-between gap-8">
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            setActiveTab('radar');
          }}
          className="text-base font-bold tracking-tight text-white whitespace-nowrap shrink-0"
        >
          PitchPulse Quant
        </a>

        <nav
          aria-label="Primary navigation"
          className="hidden md:flex items-center gap-6 text-sm font-medium"
        >
          <button
            type="button"
            onClick={() => setActiveTab('radar')}
            className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'radar'
                ? 'border-emerald-400 text-white'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Live Radar
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('alerts')}
            className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'alerts'
                ? 'border-emerald-400 text-white'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Value Alerts ({allAlerts.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('learning')}
            className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'learning'
                ? 'border-emerald-400 text-white'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Model Learning
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('methodology')}
            className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'methodology'
                ? 'border-emerald-400 text-white'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Methodology
          </button>
        </nav>

        <div className="shrink-0">
          <button
            type="button"
            onClick={() => fetchLiveFeed(false)}
            disabled={isLoadingMatches}
            className="px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-500 text-slate-950 hover:bg-emerald-400 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
          >
            {isLoadingMatches ? 'Scraping...' : 'Refresh Scrape'}
          </button>
        </div>
      </header>

      {/* Mobile Nav Bar (compact single-row switcher below header on small screens) */}
      <div className="md:hidden border-b border-white/8 bg-[#0E141F] px-3 py-2 grid grid-cols-4 gap-1">
        {(['radar', 'alerts', 'learning', 'methodology'] as ActiveTab[]).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`px-1.5 py-1.5 text-[11px] font-medium rounded-md text-center truncate whitespace-nowrap ${
              activeTab === tab
                ? 'bg-[#1F293B] text-white'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {tab === 'radar'
              ? 'Radar'
              : tab === 'alerts'
              ? `Alerts (${allAlerts.length})`
              : tab === 'learning'
              ? 'Learning'
              : 'Math'}
          </button>
        ))}
      </div>

      {/* Workspace Toolbar */}
      <div className="border-b border-white/8 bg-[#0B0F17] px-6 py-3 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
          <span className="font-mono tabular-nums text-slate-200">
            {liveCount} Live · {matches.length} Scraped Fixtures
          </span>
          {sourcesMeta && (
            <>
              <span aria-hidden="true">·</span>
              <span>
                BBC Cross-Checked: {sourcesMeta.bbcCrossCheckedCount}
              </span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">
                Updated {new Date(sourcesMeta.scrapedAt).toLocaleTimeString()}
              </span>
            </>
          )}
          <span aria-hidden="true">·</span>
          <span className="font-mono tabular-nums">
            Model Samples: {modelState.metrics.totalEvaluated}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={handleToggleOsAlerts}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
              osAlertsEnabled && alertCapability.permission === 'granted'
                ? 'bg-emerald-500/12 border-emerald-500/35 text-emerald-300'
                : 'bg-[#131A26] border-white/12 text-slate-200 hover:bg-[#1A2333]'
            }`}
          >
            {osAlertsEnabled && alertCapability.permission === 'granted' ? (
              <Bell className="w-3.5 h-3.5" aria-hidden="true" />
            ) : (
              <BellOff className="w-3.5 h-3.5" aria-hidden="true" />
            )}
            <span>
              {osAlertsEnabled && alertCapability.permission === 'granted'
                ? `${getPlatformAlertLabel(alertCapability.platform)}: On`
                : `Enable ${getPlatformAlertLabel(alertCapability.platform)}`}
            </span>
          </button>

          <button
            type="button"
            onClick={handleToggleSoundAlerts}
            aria-label={soundAlertsEnabled ? 'Mute alert chime' : 'Enable alert chime'}
            title={soundAlertsEnabled ? 'Alert chime enabled' : 'Alert chime muted'}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
              soundAlertsEnabled
                ? 'bg-[#131A26] border-white/12 text-slate-200 hover:bg-[#1A2333]'
                : 'bg-[#131A26] border-white/8 text-slate-500'
            }`}
          >
            {soundAlertsEnabled ? (
              <Volume2 className="w-3.5 h-3.5" aria-hidden="true" />
            ) : (
              <VolumeX className="w-3.5 h-3.5" aria-hidden="true" />
            )}
            <span className="hidden sm:inline">
              {soundAlertsEnabled ? 'Chime' : 'Muted'}
            </span>
          </button>

          <PWAInstallButton />

          <button
            type="button"
            onClick={() => setAutoPoll((v) => !v)}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
              autoPoll
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                : 'bg-[#131A26] border-white/12 text-slate-400'
            }`}
          >
            {autoPoll ? 'Auto-Poll 30s: On' : 'Auto-Poll: Off'}
          </button>

          {user ? (
            <button
              type="button"
              onClick={handleSignOut}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-white/12 bg-[#131A26] text-slate-300 hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              Synced ({user.email?.split('@')[0]})
            </button>
          ) : (
            <button
              type="button"
              onClick={handleGoogleSignIn}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-white/12 bg-[#131A26] text-slate-200 hover:bg-[#1A2333] transition-colors whitespace-nowrap shrink-0"
            >
              Google Cloud Sync
            </button>
          )}
        </div>
      </div>

      {/* Main Content */}
      <main className="flex-1 max-w-[1440px] w-full mx-auto px-6 py-6 space-y-6">
        {alertNoticeMsg && (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs text-amber-200">
            <span>{alertNoticeMsg}</span>
            <div className="flex items-center gap-3">
              {alertCapability.isEmbeddedIframe && (
                <a
                  href={window.location.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3 py-1.5 rounded-lg bg-amber-400 text-slate-950 font-semibold hover:bg-amber-300 transition-colors whitespace-nowrap shrink-0"
                >
                  Open Standalone Tab
                </a>
              )}
              <button
                type="button"
                onClick={() => setAlertNoticeMsg(null)}
                className="text-slate-300 hover:text-white whitespace-nowrap shrink-0"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
        {scrapeError && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 flex items-center justify-between gap-4 text-xs text-red-200">
            <span>Scraping error: {scrapeError}</span>
            <button
              type="button"
              onClick={() => fetchLiveFeed(false)}
              className="px-3 py-1.5 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-white font-medium whitespace-nowrap shrink-0"
            >
              Retry Scrape
            </button>
          </div>
        )}

        {/* Top +EV Alert Banner if active opportunities exist */}
        {activeTab === 'radar' && allAlerts.length > 0 && (
          <div className="bg-[#131A26] border border-emerald-500/30 rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-4">
            <div className="text-xs text-slate-200">
              <span className="font-semibold text-emerald-400">
                Top +EV Edge Detected:
              </span>{' '}
              {allAlerts[0].matchTitle} · {allAlerts[0].market} —{' '}
              <span className="font-semibold text-white">
                {allAlerts[0].selection}
              </span>{' '}
              <span className="font-mono tabular-nums text-emerald-400 font-semibold">
                (+{allAlerts[0].evPct.toFixed(1)}% EV)
              </span>
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setSelectedMatchId(allAlerts[0].matchId)}
                className="text-xs font-medium text-emerald-400 hover:text-emerald-300 whitespace-nowrap shrink-0"
              >
                Inspect Fixture
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('alerts')}
                className="text-xs font-medium text-slate-300 hover:text-white whitespace-nowrap shrink-0"
              >
                View All {allAlerts.length} Alerts
              </button>
            </div>
          </div>
        )}

        {activeTab === 'radar' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* Left Rail: Match List & Filters */}
            <aside className="lg:col-span-5 xl:col-span-4 bg-[#131A26] border border-white/8 rounded-xl p-4 space-y-4">
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h1 className="text-sm font-semibold text-white">
                    Global Match Radar
                  </h1>
                  <span className="text-xs font-mono tabular-nums text-slate-400">
                    {filteredMatches.length} shown
                  </span>
                </div>

                {/* Status Filter Segmented Control */}
                <div className="grid grid-cols-4 gap-1 p-1 bg-[#0E141F] border border-white/8 rounded-lg">
                  {(['all', 'in', 'pre', 'post'] as StatusFilter[]).map((st) => (
                    <button
                      key={st}
                      type="button"
                      onClick={() => setStatusFilter(st)}
                      className={`py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                        statusFilter === st
                          ? 'bg-[#1F293B] text-white'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {st === 'all'
                        ? 'All'
                        : st === 'in'
                        ? `Live (${liveCount})`
                        : st === 'pre'
                        ? 'Soon'
                        : 'Final'}
                    </button>
                  ))}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 gap-2">
                  <div>
                    <label htmlFor="search-matches" className="sr-only">
                      Search teams or leagues
                    </label>
                    <input
                      id="search-matches"
                      type="search"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Filter team or league..."
                      className="w-full bg-[#0E141F] border border-white/12 rounded-lg px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500"
                    />
                  </div>
                  {/* Radar Scope Preset (All / Top-Tier / Watchlist) */}
                  <div className="grid grid-cols-3 gap-1 p-1 bg-[#0E141F] border border-white/8 rounded-lg">
                    {(
                      [
                        { id: 'all', label: 'Global' },
                        { id: 'top_leagues', label: 'Top Leagues' },
                        { id: 'watchlist', label: `Watchlist (${watchlistIds.length})` },
                      ] as const
                    ).map((sc) => (
                      <button
                        key={sc.id}
                        type="button"
                        onClick={() => setRadarScope(sc.id)}
                        className={`py-1 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap ${
                          radarScope === sc.id
                            ? 'bg-[#1F293B] text-white'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {sc.label}
                      </button>
                    ))}
                  </div>

                  <div>
                    <label htmlFor="league-filter" className="sr-only">
                      Filter by league
                    </label>
                    <select
                      id="league-filter"
                      value={leagueFilter}
                      onChange={(e) => setLeagueFilter(e.target.value)}
                      className="w-full bg-[#0E141F] border border-white/12 rounded-lg px-3 py-2 text-xs text-slate-100"
                    >
                      {leagues.map((lg) => (
                        <option key={lg} value={lg}>
                          {lg === 'ALL' ? 'All Global Leagues' : lg}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>

              {/* Fixture List */}
              {isLoadingMatches && matches.length === 0 ? (
                <div className="space-y-2">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div
                      key={i}
                      className="h-20 rounded-lg bg-[#0E141F] border border-white/8 animate-pulse"
                    />
                  ))}
                </div>
              ) : filteredMatches.length === 0 ? (
                <div className="py-10 text-center text-xs text-slate-400 border border-white/8 rounded-lg bg-[#0E141F]">
                  No scraped fixtures match your current filters.
                </div>
              ) : (
                <div className="space-y-1.5 max-h-[720px] overflow-y-auto pr-1">
                  {filteredMatches.map((m) => {
                    const pred = predictionsByMatch.get(m.id);
                    const evList = alertsByMatch.get(m.id) || [];
                    const isSelected = selectedMatch?.id === m.id;
                    const bestEv = evList[0];
                    const isStarred = watchlistSet.has(m.id);

                    return (
                      <div
                        key={m.id}
                        className={`flex items-stretch rounded-lg border transition-colors ${
                          isSelected
                            ? 'bg-[#1A2436] border-emerald-500/40'
                            : 'bg-[#0E141F] border-white/8 hover:border-white/20'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => setSelectedMatchId(m.id)}
                          className="flex-1 min-w-0 text-left p-3"
                        >
                          <div className="flex items-center justify-between gap-2 text-[11px] text-slate-400">
                            <span className="truncate">{m.league}</span>
                            <span
                              className={`font-mono tabular-nums shrink-0 ${
                                m.state === 'in'
                                  ? 'text-emerald-400 font-semibold'
                                  : 'text-slate-400'
                              }`}
                            >
                              {m.state === 'in'
                                ? `${m.minute}'`
                                : m.state === 'post'
                                ? 'FT'
                                : new Date(m.startDate).toLocaleTimeString([], {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                  })}
                            </span>
                          </div>

                          <div className="mt-1.5 flex items-center justify-between gap-2 text-xs font-medium text-slate-100">
                            <span className="truncate">{m.homeTeam}</span>
                            <span className="font-mono tabular-nums font-bold text-white shrink-0">
                              {m.homeScore}
                            </span>
                          </div>
                          <div className="mt-0.5 flex items-center justify-between gap-2 text-xs font-medium text-slate-100">
                            <span className="truncate">{m.awayTeam}</span>
                            <span className="font-mono tabular-nums font-bold text-white shrink-0">
                              {m.awayScore}
                            </span>
                          </div>

                          <div className="mt-2 pt-1.5 border-t border-white/6 flex items-center justify-between gap-2 text-[11px] font-mono tabular-nums text-slate-400">
                            <span>
                              Flow:{' '}
                              {pred
                                ? `${pred.netMomentum >= 0 ? '+' : ''}${pred.netMomentum.toFixed(1)}`
                                : '0.0'}
                            </span>
                            {bestEv ? (
                              <span className="text-emerald-400 font-semibold">
                                +{bestEv.evPct.toFixed(1)}% EV
                              </span>
                            ) : (
                              <span>
                                1X2:{' '}
                                {pred
                                  ? `${(pred.markets.winner1X2.homeProb * 100).toFixed(0)}/${(
                                      pred.markets.winner1X2.drawProb * 100
                                    ).toFixed(0)}/${(
                                      pred.markets.winner1X2.awayProb * 100
                                    ).toFixed(0)}`
                                  : '—'}
                              </span>
                            )}
                          </div>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleToggleWatchlist(m.id)}
                          aria-pressed={isStarred}
                          aria-label={
                            isStarred
                              ? `Remove ${m.homeTeam} vs ${m.awayTeam} from Watchlist`
                              : `Add ${m.homeTeam} vs ${m.awayTeam} to Watchlist`
                          }
                          title={isStarred ? 'Remove from Watchlist' : 'Pin to Watchlist'}
                          className="px-2.5 flex items-center justify-center border-l border-white/6 text-slate-500 hover:text-amber-300 transition-colors shrink-0"
                        >
                          <Star
                            className={`w-3.5 h-3.5 ${
                              isStarred ? 'fill-amber-400 text-amber-400' : ''
                            }`}
                            aria-hidden="true"
                          />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </aside>

            {/* Right Main Panel: Deep Match Flow Inspector */}
            <div className="lg:col-span-7 xl:col-span-8">
              <MatchInspector
                match={selectedMatch}
                prediction={selectedPrediction}
                alerts={selectedAlerts}
                trends={selectedTrends}
                aiBriefs={aiBriefs}
                loadingTrendIds={loadingTrendIds}
                trendErrors={trendErrors}
                onAnalyzeTrend={handleAnalyzeTrend}
                onRefreshMatch={handleRefreshSingleMatch}
                isRefreshing={isRefreshingSingle}
                isWatchlisted={selectedMatch ? watchlistSet.has(selectedMatch.id) : false}
                onToggleWatchlist={handleToggleWatchlist}
              />
            </div>
          </div>
        )}

        {activeTab === 'alerts' && (
          <ValueAlertsView
            alerts={allAlerts}
            trends={allTrends}
            aiBriefs={aiBriefs}
            loadingTrendIds={loadingTrendIds}
            trendErrors={trendErrors}
            onAnalyzeTrend={handleAnalyzeTrend}
            minEvThreshold={minEvThreshold}
            onChangeThreshold={handleThresholdChange}
            onSelectMatch={(id) => {
              setSelectedMatchId(id);
              setActiveTab('radar');
            }}
            osAlertsEnabled={osAlertsEnabled}
            osPermission={alertCapability.permission}
            platformLabel={getPlatformAlertLabel(alertCapability.platform)}
            isEmbeddedIframe={alertCapability.isEmbeddedIframe}
            onToggleOsAlerts={handleToggleOsAlerts}
            onTestAlert={handleTriggerTestAlert}
            verifiedLiveOnly={verifiedLiveOnly}
            onToggleVerifiedLiveOnly={handleToggleVerifiedLiveOnly}
            alertScope={alertScope}
            onChangeAlertScope={handleChangeAlertScope}
            watchlistCount={watchlistIds.length}
            autoAiOnOverlap={autoAiOnOverlap}
            onToggleAutoAiOnOverlap={handleToggleAutoAiOnOverlap}
            backgroundPushSupported={bgPushSupported}
            backgroundPushSubscribed={bgPushSubscribed}
            backgroundPushBusy={bgPushBusy}
            backgroundPushNotice={bgPushNotice}
            onToggleBackgroundPush={handleToggleBackgroundPush}
            onTestBackgroundPush={handleTestBackgroundPush}
          />
        )}

        {activeTab === 'learning' && (
          <LearningDashboard
            modelState={modelState}
            user={user}
            firestoreStatus={firestoreStatus}
            isCalibrating={isCalibrating}
            calibrationStatusMsg={calibrationStatusMsg}
            onRunHistoricalCalibration={handleRunHistoricalCalibration}
            onSignIn={handleGoogleSignIn}
            onSignOut={handleSignOut}
            paperBets={paperBets}
            paperSummary={paperSummary}
            capturedSnapshotCount={liveSnapshots.length}
            onResetPaperLedger={handleResetPaperLedger}
          />
        )}

        {activeTab === 'methodology' && <MethodologyView />}
      </main>

      <LiveAlertToastStack
        toasts={liveToasts}
        onInspectMatch={handleInspectMatchFromAlert}
        onDismissToast={(id) =>
          setLiveToasts((prev) => prev.filter((t) => t.id !== id))
        }
      />
      <OfflineIndicator />
    </div>
  );
}
