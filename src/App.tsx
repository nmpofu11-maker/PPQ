import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AlertScopeMode, ScrapedMatch } from './types/soccer';
import { filterMatchIdsByAlertScope } from './engine/leagueTiers';
import { getPlatformAlertLabel } from './engine/alertNotifier';
import { deriveMatchInsights } from './lib/matchInsights';
import { ensureUserProfile, loadUserMinEvThreshold } from './services/persistence';
import { useAuth } from './hooks/useAuth';
import { useModelLearning } from './hooks/useModelLearning';
import { useLiveFeed } from './hooks/useLiveFeed';
import { usePaperLedger } from './hooks/usePaperLedger';
import { useLocalAlerts } from './hooks/useLocalAlerts';
import { useBackgroundPush } from './hooks/useBackgroundPush';
import { useTacticalBriefs } from './hooks/useTacticalBriefs';
import { usePersistedState } from './hooks/usePersistedState';
import { AppHeader, type ActiveTab } from './components/layout/AppHeader';
import { WorkspaceToolbar } from './components/layout/WorkspaceToolbar';
import { StatusBanners } from './components/layout/StatusBanners';
import { RadarView } from './components/RadarView';
import { ResponsibleGamblingNotice } from './components/ResponsibleGamblingNotice';
import { LiveAlertToastStack } from './components/LiveAlertToastStack';
import { OfflineIndicator } from './components/OfflineIndicator';

// Heavier, less-visited views are split into their own chunks.
const ValueAlertsView = lazy(() =>
  import('./components/ValueAlertsView').then((m) => ({ default: m.ValueAlertsView }))
);
const LearningDashboard = lazy(() =>
  import('./components/LearningDashboard').then((m) => ({ default: m.LearningDashboard }))
);
const MethodologyView = lazy(() =>
  import('./components/MethodologyView').then((m) => ({ default: m.MethodologyView }))
);

function ViewFallback() {
  return <div className="py-16 text-center text-xs text-slate-400">Loading…</div>;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('radar');
  const [minEvThreshold, setMinEvThreshold] = useState(3);

  // Settings that persist per browser. Verified-live odds only is the safe default.
  const [watchlistIds, setWatchlistIds] = usePersistedState<string[]>('pitchpulse_watchlist_ids', []);
  const [verifiedLiveOnly, setVerifiedLiveOnly] = usePersistedState<boolean>('pitchpulse_verified_live_only', true);
  const [alertScope, setAlertScope] = usePersistedState<AlertScopeMode>('pitchpulse_alert_scope', 'all');
  const [autoAiOnOverlap, setAutoAiOnOverlap] = usePersistedState<boolean>('pitchpulse_auto_ai_overlap', false);

  const { user, userRef, profileReady, firestoreStatus, signIn, signOut, getIdToken } = useAuth();
  const learning = useModelLearning({ user, userRef, profileReady });

  // Learning + settling run after each scrape; settle is wired through a ref because the ledger
  // needs the scraped matches this callback is produced from.
  const settleRef = useRef<(m: ScrapedMatch[]) => void>(() => {});
  const { processScrape } = learning;
  const onScraped = useCallback(
    (scraped: ScrapedMatch[]) => {
      processScrape(scraped);
      settleRef.current(scraped);
    },
    [processScrape]
  );
  const feed = useLiveFeed(onScraped);
  const { matches, setSelectedMatchId } = feed;

  // Restore the user's saved alert threshold after sign-in
  useEffect(() => {
    if (!user || !profileReady) return;
    let active = true;
    loadUserMinEvThreshold(user.uid)
      .then((saved) => {
        if (active && saved !== null) setMinEvThreshold(saved);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [user, profileReady]);

  const handleThresholdChange = useCallback(
    async (next: number) => {
      setMinEvThreshold(next);
      if (userRef.current) {
        try {
          await ensureUserProfile(userRef.current, next);
        } catch {
          // Logged by handleFirestoreError
        }
      }
    },
    [userRef]
  );

  const watchlistSet = useMemo(() => new Set(watchlistIds), [watchlistIds]);
  const scopedMatchIds = useMemo(
    () => filterMatchIdsByAlertScope({ matches, scope: alertScope, watchlistIds: watchlistSet }),
    [matches, alertScope, watchlistSet]
  );

  const insights = useMemo(
    () =>
      deriveMatchInsights({
        matches,
        modelState: learning.modelState,
        minEvThreshold,
        verifiedLiveOnly,
        scopedMatchIds,
      }),
    [matches, learning.modelState, minEvThreshold, verifiedLiveOnly, scopedMatchIds]
  );
  const { predictionsByMatch, alertsByMatch, allAlerts, trendsByMatch, allTrends } = insights;

  const ledger = usePaperLedger({ user, userRef, profileReady, matches, allAlerts });
  settleRef.current = ledger.settleFinished;

  const inspectMatch = useCallback(
    (matchId: string) => {
      setSelectedMatchId(matchId);
      setActiveTab('radar');
    },
    [setSelectedMatchId]
  );

  // Deep-link from OS notification click (?matchId=... or service-worker postMessage)
  useEffect(() => {
    const linked = new URLSearchParams(window.location.search).get('matchId');
    if (linked) inspectMatch(linked);
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'SELECT_MATCH_FROM_ALERT' && typeof event.data.matchId === 'string' && event.data.matchId) {
        inspectMatch(event.data.matchId);
      }
    };
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [inspectMatch]);

  const alerts = useLocalAlerts({
    matches,
    allAlerts,
    allTrends,
    selectedMatchId: feed.selectedMatchId,
    onInspectMatch: inspectMatch,
  });
  const push = useBackgroundPush({
    minEvThreshold,
    verifiedLiveOnly,
    alertScope,
    watchlistIds,
    modelState: learning.modelState,
  });
  const briefs = useTacticalBriefs({
    user,
    getIdToken,
    matches,
    predictionsByMatch,
    allAlerts,
    allTrends,
    autoAiOnOverlap,
  });

  const toggleWatchlist = useCallback(
    (id: string) =>
      setWatchlistIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [id, ...prev].slice(0, 100))),
    [setWatchlistIds]
  );

  const liveCount = useMemo(() => matches.filter((m) => m.state === 'in').length, [matches]);

  return (
    <div className="min-h-screen bg-[#0B0F17] text-slate-100 flex flex-col">
      <AppHeader
        activeTab={activeTab}
        onChangeTab={setActiveTab}
        alertCount={allAlerts.length}
        isLoading={feed.isLoadingMatches}
        onRefresh={() => void feed.fetchLiveFeed(false)}
      />

      <WorkspaceToolbar
        liveCount={liveCount}
        matchCount={matches.length}
        sourcesMeta={feed.sourcesMeta}
        modelSamples={learning.modelState.metrics.totalEvaluated}
        alertCapability={alerts.alertCapability}
        osAlertsEnabled={alerts.osAlertsEnabled}
        soundAlertsEnabled={alerts.soundAlertsEnabled}
        autoPoll={feed.autoPoll}
        user={user}
        onToggleOsAlerts={() => void alerts.toggleOsAlerts()}
        onToggleSound={alerts.toggleSoundAlerts}
        onToggleAutoPoll={() => feed.setAutoPoll((v) => !v)}
        onSignIn={() => void signIn()}
        onSignOut={() => void signOut()}
      />

      <main className="flex-1 max-w-[1440px] w-full mx-auto px-6 py-6 space-y-6">
        <StatusBanners
          alertNoticeMsg={alerts.alertNoticeMsg}
          isEmbeddedIframe={alerts.alertCapability.isEmbeddedIframe}
          onDismissNotice={alerts.dismissNotice}
          scrapeError={feed.scrapeError}
          onRetry={() => void feed.fetchLiveFeed(false)}
          topAlert={allAlerts[0] ?? null}
          alertCount={allAlerts.length}
          showTopAlert={activeTab === 'radar'}
          onInspectTop={feed.setSelectedMatchId}
          onViewAlerts={() => setActiveTab('alerts')}
        />

        {activeTab === 'radar' && (
          <RadarView
            matches={matches}
            isLoading={feed.isLoadingMatches}
            isRefreshingSingle={feed.isRefreshingSingle}
            selectedMatchId={feed.selectedMatchId}
            onSelectMatch={feed.setSelectedMatchId}
            predictionsByMatch={predictionsByMatch}
            alertsByMatch={alertsByMatch}
            trendsByMatch={trendsByMatch}
            watchlistIds={watchlistIds}
            onToggleWatchlist={toggleWatchlist}
            aiBriefs={briefs.aiBriefs}
            loadingTrendIds={briefs.loadingTrendIds}
            trendErrors={briefs.trendErrors}
            onAnalyzeTrend={briefs.analyzeTrend}
            onRefreshMatch={(id) => void feed.refreshSingleMatch(id)}
          />
        )}

        <Suspense fallback={<ViewFallback />}>
          {activeTab === 'alerts' && (
            <ValueAlertsView
              alerts={allAlerts}
              trends={allTrends}
              aiBriefs={briefs.aiBriefs}
              loadingTrendIds={briefs.loadingTrendIds}
              trendErrors={briefs.trendErrors}
              onAnalyzeTrend={briefs.analyzeTrend}
              minEvThreshold={minEvThreshold}
              onChangeThreshold={handleThresholdChange}
              onSelectMatch={inspectMatch}
              osAlertsEnabled={alerts.osAlertsEnabled}
              osPermission={alerts.alertCapability.permission}
              platformLabel={getPlatformAlertLabel(alerts.alertCapability.platform)}
              isEmbeddedIframe={alerts.alertCapability.isEmbeddedIframe}
              onToggleOsAlerts={alerts.toggleOsAlerts}
              onTestAlert={alerts.triggerTestAlert}
              verifiedLiveOnly={verifiedLiveOnly}
              onToggleVerifiedLiveOnly={() => setVerifiedLiveOnly((v) => !v)}
              alertScope={alertScope}
              onChangeAlertScope={setAlertScope}
              watchlistCount={watchlistIds.length}
              autoAiOnOverlap={autoAiOnOverlap}
              onToggleAutoAiOnOverlap={() => setAutoAiOnOverlap((v) => !v)}
              backgroundPushSupported={push.supported}
              backgroundPushSubscribed={push.subscribed}
              backgroundPushBusy={push.busy}
              backgroundPushNotice={push.notice}
              onToggleBackgroundPush={push.toggle}
              onTestBackgroundPush={push.sendTest}
            />
          )}

          {activeTab === 'learning' && (
            <LearningDashboard
              modelState={learning.modelState}
              user={user}
              firestoreStatus={firestoreStatus}
              isCalibrating={learning.isCalibrating}
              calibrationStatusMsg={learning.calibrationStatusMsg}
              onRunHistoricalCalibration={learning.runHistoricalCalibration}
              onSignIn={() => void signIn()}
              onSignOut={() => void signOut()}
              paperBets={ledger.paperBets}
              paperSummary={ledger.summary}
              capturedSnapshotCount={learning.liveSnapshots.length}
              onResetPaperLedger={ledger.reset}
            />
          )}

          {activeTab === 'methodology' && <MethodologyView />}
        </Suspense>
      </main>

      <ResponsibleGamblingNotice />
      <LiveAlertToastStack toasts={alerts.liveToasts} onInspectMatch={inspectMatch} onDismissToast={alerts.dismissToast} />
      <OfflineIndicator />
    </div>
  );
}
