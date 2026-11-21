import React, { useState } from 'react';
import type {
  AlertScopeMode,
  DetectedTrendSignal,
  MarketCategory,
  TacticalAiBrief,
  ValueAlert,
} from '../types/soccer';
import type { OsPermissionState } from '../services/notifications';

interface ValueAlertsViewProps {
  alerts: ValueAlert[];
  trends: DetectedTrendSignal[];
  aiBriefs: Record<string, TacticalAiBrief>;
  loadingTrendIds: Record<string, boolean>;
  trendErrors: Record<string, string>;
  onAnalyzeTrend: (trend: DetectedTrendSignal) => void;
  minEvThreshold: number;
  onChangeThreshold: (val: number) => void;
  onSelectMatch: (matchId: string) => void;
  osAlertsEnabled: boolean;
  osPermission: OsPermissionState;
  platformLabel: string;
  isEmbeddedIframe: boolean;
  onToggleOsAlerts: () => void;
  onTestAlert: () => void;
  verifiedLiveOnly: boolean;
  onToggleVerifiedLiveOnly: () => void;
  alertScope: AlertScopeMode;
  onChangeAlertScope: (scope: AlertScopeMode) => void;
  watchlistCount: number;
  autoAiOnOverlap: boolean;
  onToggleAutoAiOnOverlap: () => void;
  backgroundPushSupported: boolean;
  backgroundPushSubscribed: boolean;
  backgroundPushBusy: boolean;
  backgroundPushNotice: string | null;
  onToggleBackgroundPush: () => void;
  onTestBackgroundPush: () => void;
}

const MARKET_FILTERS: ('All' | MarketCategory)[] = [
  'All',
  'Match Winner (1X2)',
  'Double Chance',
  'Over / Under Goals',
  'Asian Handicap / Spread',
];

export const ValueAlertsView: React.FC<ValueAlertsViewProps> = ({
  alerts,
  trends,
  aiBriefs,
  loadingTrendIds,
  trendErrors,
  onAnalyzeTrend,
  minEvThreshold,
  onChangeThreshold,
  onSelectMatch,
  osAlertsEnabled,
  osPermission,
  platformLabel,
  isEmbeddedIframe,
  onToggleOsAlerts,
  onTestAlert,
  verifiedLiveOnly,
  onToggleVerifiedLiveOnly,
  alertScope,
  onChangeAlertScope,
  watchlistCount,
  autoAiOnOverlap,
  onToggleAutoAiOnOverlap,
  backgroundPushSupported,
  backgroundPushSubscribed,
  backgroundPushBusy,
  backgroundPushNotice,
  onToggleBackgroundPush,
  onTestBackgroundPush,
}) => {
  const [marketFilter, setMarketFilter] = useState<'All' | MarketCategory>('All');
  const [tierFilter, setTierFilter] = useState<'All' | 'Strong Edge' | 'Moderate Edge'>('All');

  const filtered = alerts.filter((a) => {
    if (marketFilter !== 'All' && a.market !== marketFilter) return false;
    if (tierFilter !== 'All' && a.confidenceTier !== tierFilter) return false;
    return true;
  });

  return (
    <div className="space-y-6">
      {/* Device Alert Delivery Status (Foreground OS Toast + True Background VAPID Push) */}
      <div className="bg-[#131A26] border border-white/8 rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="text-sm font-semibold text-white">
              Device Alert Delivery ({platformLabel})
            </div>
            <p className="text-xs text-slate-400">
              {osAlertsEnabled && osPermission === 'granted'
                ? `Active: New +EV edges and persistent attack surges dispatch native ${platformLabel} notifications with match deep-linking while the app runs.`
                : isEmbeddedIframe && osPermission === 'iframe-blocked'
                ? 'Running inside an embedded frame. Open in a standalone browser tab or install as a PWA to receive native Windows/Android system alerts.'
                : `Enable ${platformLabel} notifications to get native desktop toasts on Windows or Service Worker status-bar alerts on Android whenever new live value appears.`}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={onTestAlert}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-white/12 bg-[#0E141F] text-slate-200 hover:bg-[#1A2333] transition-colors whitespace-nowrap shrink-0"
            >
              Test Alert
            </button>
            <button
              type="button"
              onClick={onToggleOsAlerts}
              className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                osAlertsEnabled && osPermission === 'granted'
                  ? 'bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25'
                  : 'bg-emerald-500 text-slate-950 hover:bg-emerald-400'
              }`}
            >
              {osAlertsEnabled && osPermission === 'granted'
                ? `${platformLabel}: Active`
                : `Enable ${platformLabel}`}
            </button>
          </div>
        </div>

        {/* True Background Server Web Push (Tab-Closed Delivery via VAPID) */}
        <div className="pt-3 border-t border-white/8 flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-0.5">
            <div className="text-xs font-semibold text-slate-200">
              Background Server Push (Tab Closed · VAPID)
            </div>
            <p className="text-xs text-slate-400">
              {backgroundPushSubscribed
                ? 'Subscribed: Express 45s server monitor pushes new +EV and surge alerts via Service Worker even when this tab is closed.'
                : backgroundPushSupported
                ? 'Subscribe this device to receive real OS push alerts when PitchPulse is closed on Windows or Android.'
                : 'PushManager is unavailable in this browser context (requires HTTPS/localhost standalone tab or installed PWA).'}
            </p>
            {backgroundPushNotice && (
              <p className="text-xs text-amber-300 pt-0.5">{backgroundPushNotice}</p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {backgroundPushSubscribed && (
              <button
                type="button"
                onClick={onTestBackgroundPush}
                disabled={backgroundPushBusy}
                className="px-3 py-1.5 text-xs font-medium rounded-lg border border-white/12 bg-[#0E141F] text-slate-200 hover:bg-[#1A2333] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
              >
                Send Push Test
              </button>
            )}
            <button
              type="button"
              onClick={onToggleBackgroundPush}
              disabled={backgroundPushBusy || !backgroundPushSupported}
              className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 disabled:opacity-50 ${
                backgroundPushSubscribed
                  ? 'bg-sky-500/15 border border-sky-500/40 text-sky-300 hover:bg-sky-500/25'
                  : 'bg-[#1A2333] border border-white/15 text-slate-100 hover:bg-[#243044]'
              }`}
            >
              {backgroundPushBusy
                ? 'Updating...'
                : backgroundPushSubscribed
                ? 'Background Push: On'
                : 'Subscribe Background Push'}
            </button>
          </div>
        </div>
      </div>

      {/* Section 1: Quantitative Live Attack Trends & AI Tactical Alerts */}
      <div className="bg-[#131A26] border border-white/8 rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold text-white">
              Persistent Attack &amp; Shot-on-Goal Trend Alerts ({trends.length})
            </h1>
            <p className="text-xs text-slate-400 mt-1">
              Rolling 10-minute quantitative triggers detecting sustained momentum surges, shot-on-target barrages, and set-piece sieges—paired with on-demand Gemini tactical synthesis over play-by-play commentary (zero odds input).
            </p>
          </div>

          <button
            type="button"
            onClick={onToggleAutoAiOnOverlap}
            aria-pressed={autoAiOnOverlap}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
              autoAiOnOverlap
                ? 'bg-amber-500/15 border-amber-500/40 text-amber-300'
                : 'bg-[#0E141F] border-white/12 text-slate-300 hover:bg-[#1A2333]'
            }`}
          >
            {autoAiOnOverlap
              ? 'Auto-AI on +EV + Surge: On'
              : 'Auto-AI on +EV + Surge: Off'}
          </button>
        </div>

        {trends.length === 0 ? (
          <div className="border border-white/8 rounded-lg bg-[#0E141F] p-6 text-center text-xs text-slate-400">
            No live in-play matches within the active alert scope currently exceed the rolling 10-minute persistent attack or shots-on-goal threshold.
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {trends.map((tr) => {
              const brief = aiBriefs[tr.id];
              const isBusy = Boolean(loadingTrendIds[tr.id]);
              const errMsg = trendErrors[tr.id];

              return (
                <div
                  key={tr.id}
                  className="border border-amber-500/25 rounded-lg bg-[#0E141F] p-4 space-y-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="text-xs text-slate-400">
                        {tr.league} · <span className="text-emerald-400 font-mono">Live {tr.minute}&apos;</span> · {tr.scoreline}
                      </div>
                      <div className="text-sm font-semibold text-white mt-0.5">
                        {tr.matchTitle}
                      </div>
                      <div className="text-xs font-medium text-amber-300 mt-1">
                        {tr.teamName}: {tr.patternLabel}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => onAnalyzeTrend(tr)}
                        disabled={isBusy}
                        className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-amber-400 text-slate-950 hover:bg-amber-300 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
                      >
                        {isBusy
                          ? 'Analyzing...'
                          : brief
                          ? 'Refresh AI Brief'
                          : 'AI Tactical Brief'}
                      </button>
                      <button
                        type="button"
                        onClick={() => onSelectMatch(tr.matchId)}
                        className="px-3 py-1.5 text-xs font-medium rounded-lg border border-white/12 bg-[#1A2333] text-slate-200 hover:bg-[#243044] transition-colors whitespace-nowrap shrink-0"
                      >
                        Inspect
                      </button>
                    </div>
                  </div>

                  <div className="text-xs font-mono tabular-nums text-slate-300 flex flex-wrap gap-x-3 gap-y-1">
                    <span>{tr.recentShots} shots ({tr.recentShotsOnTarget} SoT)</span>
                    <span>·</span>
                    <span>{tr.recentCorners} corners</span>
                    <span>·</span>
                    <span>{tr.consecutiveMomentumMinutes}m consecutive pressure</span>
                    <span>·</span>
                    <span className="text-emerald-400">
                      {tr.recommendedSelection} ({(tr.modelProbability * 100).toFixed(1)}%)
                    </span>
                  </div>

                  {errMsg && (
                    <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/25 rounded-md px-3 py-2">
                      {errMsg}
                    </div>
                  )}

                  {brief && (
                    <div className="pt-2.5 border-t border-white/8 space-y-1.5 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-semibold text-emerald-400">
                          {brief.tacticalVerdict} · {brief.bestMarketPick}
                        </span>
                        <span className="font-mono text-[11px] text-slate-500">
                          {brief.modelUsed}
                        </span>
                      </div>
                      <p className="text-slate-200 leading-relaxed">
                        {brief.dangerQualitySummary}
                      </p>
                      <p className="text-slate-400">
                        Risk: {brief.keyRiskFactor}
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Section 2: +EV Value Queue */}
      <div className="bg-[#131A26] border border-white/8 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-white">
            Live In-Play +EV Alert Queue
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Surfaces live in-play fixtures where independent pure-flow momentum probabilities exceed scraped market implied probabilities by at least +{minEvThreshold}%.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <label htmlFor="alert-scope-select" className="text-xs text-slate-400">
              Scope
            </label>
            <select
              id="alert-scope-select"
              value={alertScope}
              onChange={(e) => onChangeAlertScope(e.target.value as AlertScopeMode)}
              className="bg-[#0E141F] border border-white/12 rounded-lg px-2.5 py-1.5 text-xs text-slate-100"
            >
              <option value="all">All Global Matches</option>
              <option value="top_leagues">Top-Tier Leagues</option>
              <option value="watchlist">Watchlist Only ({watchlistCount})</option>
            </select>
          </div>

          <button
            type="button"
            onClick={onToggleVerifiedLiveOnly}
            aria-pressed={verifiedLiveOnly}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
              verifiedLiveOnly
                ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                : 'bg-[#0E141F] border-white/12 text-slate-300 hover:bg-[#1A2333]'
            }`}
          >
            {verifiedLiveOnly ? 'Verified Live Odds Only: On' : 'Verified Live Odds Only: Off'}
          </button>

          <div className="flex items-center gap-2">
            <label htmlFor="ev-threshold-select" className="text-xs text-slate-400">
              Min +EV Edge
            </label>
            <select
              id="ev-threshold-select"
              value={minEvThreshold}
              onChange={(e) => onChangeThreshold(Number(e.target.value))}
              className="bg-[#0E141F] border border-white/12 rounded-lg px-2.5 py-1.5 text-xs font-mono text-slate-100"
            >
              <option value={1}>+1.0%</option>
              <option value={3}>+3.0%</option>
              <option value={5}>+5.0%</option>
              <option value={8}>+8.0%</option>
              <option value={12}>+12.0%</option>
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="tier-filter-select" className="text-xs text-slate-400">
              Tier
            </label>
            <select
              id="tier-filter-select"
              value={tierFilter}
              onChange={(e) =>
                setTierFilter(e.target.value as 'All' | 'Strong Edge' | 'Moderate Edge')
              }
              className="bg-[#0E141F] border border-white/12 rounded-lg px-2.5 py-1.5 text-xs text-slate-100"
            >
              <option value="All">All Tiers</option>
              <option value="Strong Edge">Strong Edge (≥8%)</option>
              <option value="Moderate Edge">Moderate Edge (3–8%)</option>
            </select>
          </div>
        </div>
      </div>

      {/* Market Filter Tabs */}
      <div className="flex flex-wrap items-center gap-1 p-1 bg-[#131A26] border border-white/8 rounded-lg w-fit">
        {MARKET_FILTERS.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMarketFilter(m)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              marketFilter === m
                ? 'bg-[#1F293B] text-white'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {m}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="bg-[#131A26] border border-white/8 rounded-xl p-10 text-center space-y-2">
          <h3 className="text-sm font-semibold text-slate-200">
            No +EV alerts match your current filter
          </h3>
          <p className="text-xs text-slate-400 max-w-md mx-auto">
            Live alerts trigger strictly on in-play matches with verified match-flow momentum and active bookmaker lines.
          </p>
        </div>
      ) : (
        <div className="bg-[#131A26] border border-white/8 rounded-xl overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/8 text-xs text-slate-400 font-medium">
                <th className="py-3 px-4">Match &amp; State</th>
                <th className="py-3 px-4">Market &amp; Selection</th>
                <th className="py-3 px-4 text-right">Model Prob</th>
                <th className="py-3 px-4 text-right">Scraped Odds</th>
                <th className="py-3 px-4 text-right">EV %</th>
                <th className="py-3 px-4 text-right">¼-Kelly</th>
                <th className="py-3 px-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/8 text-xs">
              {filtered.map((al) => (
                <tr key={al.id} className="hover:bg-white/[0.02] transition-colors">
                  <td className="py-3 px-4">
                    <div className="font-medium text-slate-100">{al.matchTitle}</div>
                    <div className="text-slate-400 mt-0.5">
                      {al.league} ·{' '}
                      <span className={al.state === 'in' ? 'text-emerald-400' : ''}>
                        {al.state === 'in' ? `Live ${al.minute}'` : 'Upcoming'}
                      </span>{' '}
                      · {al.scoreline}
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <div className="font-medium text-slate-200">
                      {al.selection}
                    </div>
                    <div className="text-slate-400 mt-0.5">
                      {al.market} · {al.evidenceSummary}
                    </div>
                  </td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-100">
                    {(al.modelProbability * 100).toFixed(1)}%
                    <div className="text-slate-500">Fair {al.fairDecimalOdds}</div>
                  </td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-200">
                    {al.bookmakerOddsAmerican} ({al.bookmakerOddsDecimal})
                    <div className="text-slate-500">
                      {(al.impliedProbability * 100).toFixed(1)}% ·{' '}
                      <span className={al.oddsVerifiedLive ? 'text-emerald-400' : 'text-amber-300'}>
                        {al.oddsVerifiedLive ? 'Verified Live' : 'Pre-Match / Unverified'}
                      </span>
                    </div>
                  </td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums">
                    <span
                      className={`font-semibold ${
                        al.evPct >= 8 ? 'text-emerald-400' : 'text-amber-400'
                      }`}
                    >
                      +{al.evPct.toFixed(1)}%
                    </span>
                    <div className="text-slate-500">{al.confidenceTier}</div>
                  </td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-200">
                    {al.kellyFractionPct.toFixed(1)}%
                  </td>
                  <td className="py-3 px-4 text-right">
                    <button
                      type="button"
                      onClick={() => onSelectMatch(al.matchId)}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg border border-white/12 bg-[#1A2333] text-slate-100 hover:bg-[#243044] transition-colors whitespace-nowrap shrink-0"
                    >
                      Inspect Flow
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
