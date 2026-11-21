import React, { useState } from 'react';
import { Star } from 'lucide-react';
import type {
  DetectedTrendSignal,
  PureFlowPrediction,
  ScrapedMatch,
  TacticalAiBrief,
  ValueAlert,
} from '../types/soccer';
import { probabilityToFairDecimalOdds } from '../engine/valueDetector';
import { MomentumChart } from './MomentumChart';

interface MatchInspectorProps {
  match: ScrapedMatch | null;
  prediction: PureFlowPrediction | null;
  alerts: ValueAlert[];
  trends: DetectedTrendSignal[];
  aiBriefs: Record<string, TacticalAiBrief>;
  loadingTrendIds: Record<string, boolean>;
  trendErrors: Record<string, string>;
  onAnalyzeTrend: (trend: DetectedTrendSignal) => void;
  onRefreshMatch: (matchId: string) => void;
  isRefreshing: boolean;
  isWatchlisted: boolean;
  onToggleWatchlist: (matchId: string) => void;
}

function pct(val: number): string {
  return `${(val * 100).toFixed(1)}%`;
}

export const MatchInspector: React.FC<MatchInspectorProps> = ({
  match,
  prediction,
  alerts,
  trends,
  aiBriefs,
  loadingTrendIds,
  trendErrors,
  onAnalyzeTrend,
  onRefreshMatch,
  isRefreshing,
  isWatchlisted,
  onToggleWatchlist,
}) => {
  const [showEvents, setShowEvents] = useState(false);

  if (!match || !prediction) {
    return (
      <section className="bg-[#131A26] border border-white/8 rounded-xl p-8 flex flex-col items-center justify-center min-h-[480px] text-center">
        <h2 className="text-base font-semibold text-slate-200">
          Select a scraped fixture to inspect match flow
        </h2>
        <p className="mt-2 text-sm text-slate-400 max-w-md">
          Choose any live, upcoming, or completed match from the left radar to compute odds-free Poisson momentum probabilities and check +EV edges.
        </p>
      </section>
    );
  }

  const stateLabel =
    match.state === 'in'
      ? `In-Play · ${match.minute}'`
      : match.state === 'post'
      ? `Full-Time · ${match.statusText}`
      : `Scheduled · ${new Date(match.startDate).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        })}`;

  const statRows: { label: string; home: string | number; away: string | number }[] = [
    {
      label: 'Possession',
      home:
        match.homeStats.possessionPct !== null
          ? `${match.homeStats.possessionPct}%`
          : '—',
      away:
        match.awayStats.possessionPct !== null
          ? `${match.awayStats.possessionPct}%`
          : '—',
    },
    {
      label: 'Shots (On Target)',
      home: `${match.homeStats.totalShots} (${match.homeStats.shotsOnTarget})`,
      away: `${match.awayStats.totalShots} (${match.awayStats.shotsOnTarget})`,
    },
    {
      label: 'Corners Won',
      home: match.homeStats.wonCorners,
      away: match.awayStats.wonCorners,
    },
    {
      label: 'Fouls Committed',
      home: match.homeStats.foulsCommitted,
      away: match.awayStats.foulsCommitted,
    },
    {
      label: 'Yellow / Red Cards',
      home: `${match.homeStats.yellowCards}Y / ${match.homeStats.redCards}R`,
      away: `${match.awayStats.yellowCards}Y / ${match.awayStats.redCards}R`,
    },
    {
      label: 'Last 5 Form Index',
      home:
        match.homeStats.formScore !== null
          ? `${match.homeStats.formScore >= 0 ? '+' : ''}${match.homeStats.formScore.toFixed(2)}`
          : '—',
      away:
        match.awayStats.formScore !== null
          ? `${match.awayStats.formScore >= 0 ? '+' : ''}${match.awayStats.formScore.toFixed(2)}`
          : '—',
    },
  ];

  const significantEvents = match.events.filter((e) =>
    ['goal', 'shot_on_target', 'corner', 'yellow_card', 'red_card'].includes(e.eventType)
  );

  return (
    <section className="bg-[#131A26] border border-white/8 rounded-xl p-6 space-y-6">
      {/* Match Header */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/8 pb-5">
        <div className="space-y-1.5 min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span className="font-medium text-slate-300">{match.league}</span>
            <span aria-hidden="true">·</span>
            <span className={match.state === 'in' ? 'text-emerald-400 font-medium' : ''}>
              {stateLabel}
            </span>
            {match.venue && (
              <>
                <span aria-hidden="true">·</span>
                <span>{match.venue}</span>
              </>
            )}
            <span aria-hidden="true">·</span>
            <span>
              ESPN Feed
              {match.bbcCrossCheck.matched
                ? ` / BBC Verified (${match.bbcCrossCheck.scoreLabel})`
                : ''}
            </span>
          </div>

          <div className="flex items-baseline gap-4 flex-wrap">
            <h2 className="text-xl font-semibold text-white tracking-tight">
              {match.homeTeam}
            </h2>
            <span className="text-2xl font-mono font-bold tabular-nums text-emerald-400">
              {match.homeScore} – {match.awayScore}
            </span>
            <h2 className="text-xl font-semibold text-white tracking-tight">
              {match.awayTeam}
            </h2>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => onToggleWatchlist(match.id)}
            aria-pressed={isWatchlisted}
            aria-label={isWatchlisted ? 'Remove match from Watchlist' : 'Add match to Watchlist'}
            className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
              isWatchlisted
                ? 'bg-amber-500/12 border-amber-500/40 text-amber-300'
                : 'bg-[#1A2333] border-white/12 text-slate-200 hover:bg-[#222D40]'
            }`}
          >
            <Star
              className={`w-3.5 h-3.5 ${isWatchlisted ? 'fill-amber-400 text-amber-400' : ''}`}
              aria-hidden="true"
            />
            <span>{isWatchlisted ? 'Watchlisted' : 'Watchlist'}</span>
          </button>

          <button
            type="button"
            onClick={() => onRefreshMatch(match.id)}
            disabled={isRefreshing}
            className="px-3.5 py-2 text-xs font-medium rounded-lg border border-white/12 bg-[#1A2333] text-slate-200 hover:bg-[#222D40] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
          >
            {isRefreshing ? 'Scraping...' : 'Re-Scrape Match'}
          </button>
        </div>
      </div>

      {/* Momentum Summary Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 border-b border-white/8 pb-5">
        <div>
          <div className="text-xs text-slate-400">Net Match Momentum</div>
          <div
            className={`mt-1 text-lg font-mono font-semibold tabular-nums ${
              prediction.netMomentum > 1.5
                ? 'text-emerald-400'
                : prediction.netMomentum < -1.5
                ? 'text-sky-400'
                : 'text-slate-200'
            }`}
          >
            {prediction.netMomentum >= 0 ? '+' : ''}
            {prediction.netMomentum.toFixed(2)}
          </div>
        </div>
        <div>
          <div className="text-xs text-slate-400">Remaining λ (Home)</div>
          <div className="mt-1 text-lg font-mono font-semibold tabular-nums text-slate-100">
            {prediction.homeLambdaRem.toFixed(2)} xG
          </div>
        </div>
        <div>
          <div className="text-xs text-slate-400">Remaining λ (Away)</div>
          <div className="mt-1 text-lg font-mono font-semibold tabular-nums text-slate-100">
            {prediction.awayLambdaRem.toFixed(2)} xG
          </div>
        </div>
        <div>
          <div className="text-xs text-slate-400">Positive EV Edges</div>
          <div
            className={`mt-1 text-lg font-mono font-semibold tabular-nums ${
              alerts.length > 0 ? 'text-emerald-400' : 'text-slate-400'
            }`}
          >
            {alerts.length} Active
          </div>
        </div>
      </div>

      {/* Momentum Flow Chart */}
      <MomentumChart
        timeline={prediction.momentumTimeline}
        homeTeam={match.homeTeam}
        awayTeam={match.awayTeam}
      />

      {/* Active Persistent Attack / Shots-on-Goal Trend Signals */}
      {trends.length > 0 && (
        <div className="border-t border-white/8 pt-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-amber-300">
              Detected Live Attack Trends (Last {trends[0].windowMinutes}&apos;)
            </h3>
            <span className="text-xs text-slate-400">
              Quantitative play-by-play surge triggers · Odds-free
            </span>
          </div>

          <div className="space-y-3">
            {trends.map((tr) => {
              const brief = aiBriefs[tr.id];
              const isBusy = Boolean(loadingTrendIds[tr.id]);
              const errMsg = trendErrors[tr.id];

              return (
                <div
                  key={tr.id}
                  className="border border-amber-500/25 rounded-lg bg-[#0E141F] p-4 space-y-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="text-xs font-semibold text-white">
                        {tr.teamName} — {tr.patternLabel}
                      </div>
                      <div className="text-xs font-mono tabular-nums text-slate-300">
                        {tr.recentShots} shots ({tr.recentShotsOnTarget} on target) ·{' '}
                        {tr.recentCorners} corners · {tr.consecutiveMomentumMinutes}m sustained flow ·{' '}
                        Model {tr.recommendedSelection} ({(tr.modelProbability * 100).toFixed(1)}%)
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => onAnalyzeTrend(tr)}
                      disabled={isBusy}
                      className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-amber-400 text-slate-950 hover:bg-amber-300 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
                    >
                      {isBusy
                        ? 'Analyzing Flow...'
                        : brief
                        ? 'Refresh AI Brief'
                        : 'AI Tactical Brief'}
                    </button>
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
                          {brief.tacticalVerdict} · Pick: {brief.bestMarketPick}
                        </span>
                        <span className="font-mono text-[11px] text-slate-500">
                          {brief.modelUsed}
                        </span>
                      </div>
                      <p className="text-slate-200 leading-relaxed">
                        {brief.dangerQualitySummary}
                      </p>
                      <p className="text-slate-400">
                        Risk note: {brief.keyRiskFactor}
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Evidence Drivers & Live Boxscore Stats */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 border-t border-white/8 pt-5">
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-slate-200">
            Scraped Statistical Telemetry
          </h3>
          <div className="divide-y divide-white/8 border border-white/8 rounded-lg bg-[#0E141F]">
            <div className="grid grid-cols-3 px-3 py-2 text-xs text-slate-400 font-medium">
              <span className="truncate">{match.homeAbbr}</span>
              <span className="text-center">Metric</span>
              <span className="text-right truncate">{match.awayAbbr}</span>
            </div>
            {statRows.map((row) => (
              <div
                key={row.label}
                className="grid grid-cols-3 px-3 py-2 text-xs items-center"
              >
                <span className="font-mono tabular-nums text-slate-100">
                  {row.home}
                </span>
                <span className="text-center text-slate-400">{row.label}</span>
                <span className="font-mono tabular-nums text-slate-100 text-right">
                  {row.away}
                </span>
              </div>
            ))}
          </div>
          {(match.homeStats.lastFiveSummary.length > 0 ||
            match.awayStats.lastFiveSummary.length > 0) && (
            <div className="text-xs text-slate-400 space-y-1">
              {match.homeStats.lastFiveSummary.length > 0 && (
                <div className="font-mono tabular-nums">
                  {match.homeAbbr} Last 5: {match.homeStats.lastFiveSummary.join(' · ')}
                </div>
              )}
              {match.awayStats.lastFiveSummary.length > 0 && (
                <div className="font-mono tabular-nums">
                  {match.awayAbbr} Last 5: {match.awayStats.lastFiveSummary.join(' · ')}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-slate-200">
            Pure-Flow Evidence Rationale
          </h3>
          <ul className="divide-y divide-white/8 border border-white/8 rounded-lg bg-[#0E141F] text-xs text-slate-300 leading-relaxed">
            {prediction.evidenceReasons.map((reason, i) => (
              <li key={i} className="px-3.5 py-2.5">
                {reason}
              </li>
            ))}
          </ul>
          <p className="text-xs text-slate-500">
            Odds Firewall Active: Prematch and live bookmaker odds are excluded from all momentum and Poisson calculations above.
          </p>
        </div>
      </div>

      {/* Stage 1: Pure-Flow Probabilities across all 4 Betting Markets */}
      <div className="border-t border-white/8 pt-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-100">
            Stage 1 · Odds-Free Pure-Flow Probability Matrix
          </h3>
          <span className="text-xs text-slate-400">
            Independent fair prices derived from live flow &amp; Poisson remaining-time intensity
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* 1X2 & Draw No Bet */}
          <div className="border border-white/8 rounded-lg bg-[#0E141F] p-4 space-y-3">
            <div className="text-xs font-semibold text-slate-300">
              Match Winner (1X2) &amp; Draw No Bet
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div>
                <div className="text-slate-400 truncate">{match.homeAbbr} Win</div>
                <div className="font-mono tabular-nums text-sm font-semibold text-slate-100 mt-0.5">
                  {pct(prediction.markets.winner1X2.homeProb)}
                </div>
                <div className="font-mono tabular-nums text-[11px] text-slate-500">
                  Fair {probabilityToFairDecimalOdds(prediction.markets.winner1X2.homeProb)}
                </div>
              </div>
              <div>
                <div className="text-slate-400">Draw</div>
                <div className="font-mono tabular-nums text-sm font-semibold text-slate-100 mt-0.5">
                  {pct(prediction.markets.winner1X2.drawProb)}
                </div>
                <div className="font-mono tabular-nums text-[11px] text-slate-500">
                  Fair {probabilityToFairDecimalOdds(prediction.markets.winner1X2.drawProb)}
                </div>
              </div>
              <div>
                <div className="text-slate-400 truncate">{match.awayAbbr} Win</div>
                <div className="font-mono tabular-nums text-sm font-semibold text-slate-100 mt-0.5">
                  {pct(prediction.markets.winner1X2.awayProb)}
                </div>
                <div className="font-mono tabular-nums text-[11px] text-slate-500">
                  Fair {probabilityToFairDecimalOdds(prediction.markets.winner1X2.awayProb)}
                </div>
              </div>
            </div>
            <div className="pt-2 border-t border-white/8 flex items-center justify-between text-xs text-slate-400 font-mono tabular-nums">
              <span>DNB {match.homeAbbr}: {pct(prediction.markets.drawNoBet.homeProb)}</span>
              <span>DNB {match.awayAbbr}: {pct(prediction.markets.drawNoBet.awayProb)}</span>
            </div>
          </div>

          {/* Next Team to Score */}
          <div className="border border-white/8 rounded-lg bg-[#0E141F] p-4 space-y-3">
            <div className="text-xs font-semibold text-slate-300">
              Next Team to Score
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div>
                <div className="text-slate-400 truncate">{match.homeAbbr} Next</div>
                <div className="font-mono tabular-nums text-sm font-semibold text-emerald-400 mt-0.5">
                  {pct(prediction.markets.nextTeamToScore.homeProb)}
                </div>
                <div className="font-mono tabular-nums text-[11px] text-slate-500">
                  Fair {probabilityToFairDecimalOdds(prediction.markets.nextTeamToScore.homeProb)}
                </div>
              </div>
              <div>
                <div className="text-slate-400">No Goal</div>
                <div className="font-mono tabular-nums text-sm font-semibold text-slate-100 mt-0.5">
                  {pct(prediction.markets.nextTeamToScore.noGoalProb)}
                </div>
                <div className="font-mono tabular-nums text-[11px] text-slate-500">
                  Fair {probabilityToFairDecimalOdds(prediction.markets.nextTeamToScore.noGoalProb)}
                </div>
              </div>
              <div>
                <div className="text-slate-400 truncate">{match.awayAbbr} Next</div>
                <div className="font-mono tabular-nums text-sm font-semibold text-sky-400 mt-0.5">
                  {pct(prediction.markets.nextTeamToScore.awayProb)}
                </div>
                <div className="font-mono tabular-nums text-[11px] text-slate-500">
                  Fair {probabilityToFairDecimalOdds(prediction.markets.nextTeamToScore.awayProb)}
                </div>
              </div>
            </div>
            <div className="pt-2 border-t border-white/8 flex items-center justify-between text-xs text-slate-400 font-mono tabular-nums">
              <span>1X: {pct(prediction.markets.doubleChance.homeOrDrawProb)}</span>
              <span>X2: {pct(prediction.markets.doubleChance.awayOrDrawProb)}</span>
              <span>12: {pct(prediction.markets.doubleChance.homeOrAwayProb)}</span>
            </div>
          </div>

          {/* Over / Under Total Goals */}
          <div className="border border-white/8 rounded-lg bg-[#0E141F] p-4 space-y-2.5">
            <div className="text-xs font-semibold text-slate-300">
              Over / Under Total Goals
            </div>
            <div className="divide-y divide-white/8 text-xs font-mono tabular-nums">
              {prediction.markets.overUnder.map((ou) => (
                <div key={ou.line} className="py-1.5 flex items-center justify-between">
                  <span className="text-slate-400">Total {ou.line}</span>
                  <span className="text-slate-200">
                    Over {pct(ou.overProb)} / Under {pct(ou.underProb)}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Asian Handicap */}
          <div className="border border-white/8 rounded-lg bg-[#0E141F] p-4 space-y-2.5">
            <div className="text-xs font-semibold text-slate-300">
              Asian Handicap ({match.homeAbbr} Line)
            </div>
            <div className="divide-y divide-white/8 text-xs font-mono tabular-nums">
              {prediction.markets.asianHandicap.map((ah) => (
                <div key={ah.line} className="py-1.5 flex items-center justify-between">
                  <span className="text-slate-400">
                    {ah.line >= 0 ? `+${ah.line}` : ah.line}
                  </span>
                  <span className="text-slate-200">
                    {match.homeAbbr} {pct(ah.homeCoverProb)} · {match.awayAbbr} {pct(ah.awayCoverProb)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Stage 2: Post-Prediction +EV Value Detection */}
      <div className="border-t border-white/8 pt-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-100">
            Stage 2 · Scraped Bookmaker Comparison (+EV Check)
          </h3>
          <span className="text-xs text-slate-400">
            {match.scrapedOdds
              ? `${match.scrapedOdds.provider} · ${
                  match.scrapedOdds.isLive ? 'Live In-Play Odds' : 'Closing/Pre-Match Odds'
                }`
              : 'No bookmaker feed attached'}
          </span>
        </div>

        {alerts.length > 0 ? (
          <div className="divide-y divide-white/8 border border-emerald-500/25 rounded-lg bg-[#0E141F]">
            {alerts.map((al) => (
              <div
                key={al.id}
                className="p-3.5 flex flex-wrap items-center justify-between gap-4 text-xs"
              >
                <div className="space-y-0.5">
                  <div className="font-semibold text-slate-100">
                    {al.market} — {al.selection}
                  </div>
                  <div className="text-slate-400">
                    Model {pct(al.modelProbability)} (Fair {al.fairDecimalOdds}) vs{' '}
                    {al.provider} {al.bookmakerOddsAmerican} ({al.bookmakerOddsDecimal} dec · Implied{' '}
                    {pct(al.impliedProbability)}) ·{' '}
                    <span className={al.oddsVerifiedLive ? 'text-emerald-400' : 'text-amber-300'}>
                      {al.oddsSourceNote}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-4 font-mono tabular-nums">
                  <span className="text-emerald-400 font-semibold">
                    +{al.evPct.toFixed(1)}% EV
                  </span>
                  <span className="text-slate-300">
                    ¼-Kelly {al.kellyFractionPct.toFixed(1)}%
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : match.scrapedOdds ? (
          <div className="border border-white/8 rounded-lg bg-[#0E141F] p-3.5 text-xs text-slate-400">
            Scraped {match.scrapedOdds.provider} lines (1X2: {match.scrapedOdds.homeMoneyline || '—'} /{' '}
            {match.scrapedOdds.drawMoneyline || '—'} / {match.scrapedOdds.awayMoneyline || '—'}
            {match.scrapedOdds.totalLine !== null
              ? ` · O/U ${match.scrapedOdds.totalLine}: ${match.scrapedOdds.overOdds || '—'} / ${match.scrapedOdds.underOdds || '—'}`
              : ''}
            ) currently show no edge exceeding your EV threshold.
          </div>
        ) : (
          <div className="border border-white/8 rounded-lg bg-[#0E141F] p-3.5 text-xs text-slate-400">
            {match.state === 'post'
              ? 'Match finished — live betting market closed.'
              : 'No scraped bookmaker feed available for this fixture; pure-flow probabilities remain computed above.'}
          </div>
        )}
      </div>

      {/* Expandable Play-by-Play Flow Feed */}
      <div className="border-t border-white/8 pt-4">
        <button
          type="button"
          onClick={() => setShowEvents((v) => !v)}
          aria-expanded={showEvents}
          className="text-xs font-medium text-slate-300 hover:text-white transition-colors"
        >
          {showEvents ? 'Hide' : 'Show'} Scraped Play-by-Play Match Flow ({significantEvents.length} key events)
        </button>

        {showEvents && (
          <div className="mt-3 max-h-64 overflow-y-auto divide-y divide-white/8 border border-white/8 rounded-lg bg-[#0E141F]">
            {significantEvents.length === 0 ? (
              <div className="p-3 text-xs text-slate-500">
                No key events recorded yet for this fixture.
              </div>
            ) : (
              significantEvents
                .slice()
                .reverse()
                .map((ev) => (
                  <div
                    key={ev.id}
                    className="px-3 py-2 flex items-start gap-3 text-xs"
                  >
                    <span className="font-mono tabular-nums text-slate-400 w-10 shrink-0">
                      {ev.clockDisplay || `${ev.minute}'`}
                    </span>
                    <span
                      className={`font-medium shrink-0 w-12 ${
                        ev.teamSide === 'home'
                          ? 'text-emerald-400'
                          : ev.teamSide === 'away'
                          ? 'text-sky-400'
                          : 'text-slate-400'
                      }`}
                    >
                      {ev.teamSide === 'home'
                        ? match.homeAbbr
                        : ev.teamSide === 'away'
                        ? match.awayAbbr
                        : 'SYS'}
                    </span>
                    <span className="text-slate-300">{ev.text}</span>
                  </div>
                ))
            )}
          </div>
        )}
      </div>
    </section>
  );
};
