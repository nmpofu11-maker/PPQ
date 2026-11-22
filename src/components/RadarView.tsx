import { useMemo, useState } from 'react';
import { Star } from 'lucide-react';
import type {
  AlertScopeMode,
  DetectedTrendSignal,
  MatchLifecycleState,
  PureFlowPrediction,
  ScrapedMatch,
  TacticalAiBrief,
  ValueAlert,
} from '../types/soccer';
import { isTopTierLeague } from '../engine/leagueTiers';
import { MatchInspector } from './MatchInspector';

type StatusFilter = 'all' | MatchLifecycleState;

export function RadarView(props: {
  matches: ScrapedMatch[];
  isLoading: boolean;
  isRefreshingSingle: boolean;
  selectedMatchId: string | null;
  onSelectMatch: (id: string) => void;
  predictionsByMatch: Map<string, PureFlowPrediction>;
  alertsByMatch: Map<string, ValueAlert[]>;
  trendsByMatch: Map<string, DetectedTrendSignal[]>;
  watchlistIds: string[];
  onToggleWatchlist: (id: string) => void;
  aiBriefs: Record<string, TacticalAiBrief>;
  loadingTrendIds: Record<string, boolean>;
  trendErrors: Record<string, string>;
  onAnalyzeTrend: (t: DetectedTrendSignal) => void;
  onRefreshMatch: (id: string) => void;
}) {
  const { matches, predictionsByMatch, alertsByMatch, trendsByMatch } = props;
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [leagueFilter, setLeagueFilter] = useState('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [radarScope, setRadarScope] = useState<AlertScopeMode>('all');

  const watchlistSet = useMemo(() => new Set(props.watchlistIds), [props.watchlistIds]);

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

  const liveCount = useMemo(() => matches.filter((m) => m.state === 'in').length, [matches]);

  const selectedMatch = matches.find((m) => m.id === props.selectedMatchId) || filteredMatches[0] || null;
  const selectedPrediction = selectedMatch ? predictionsByMatch.get(selectedMatch.id) || null : null;
  const selectedAlerts = selectedMatch ? alertsByMatch.get(selectedMatch.id) || [] : [];
  const selectedTrends = selectedMatch ? trendsByMatch.get(selectedMatch.id) || [] : [];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
      <aside className="lg:col-span-5 xl:col-span-4 bg-[#131A26] border border-white/8 rounded-xl p-4 space-y-4">
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-sm font-semibold text-white">Global Match Radar</h1>
            <span className="text-xs font-mono tabular-nums text-slate-400">{filteredMatches.length} shown</span>
          </div>

          <div className="grid grid-cols-4 gap-1 p-1 bg-[#0E141F] border border-white/8 rounded-lg">
            {(['all', 'in', 'pre', 'post'] as StatusFilter[]).map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => setStatusFilter(st)}
                className={`py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                  statusFilter === st ? 'bg-[#1F293B] text-white' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {st === 'all' ? 'All' : st === 'in' ? `Live (${liveCount})` : st === 'pre' ? 'Soon' : 'Final'}
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
            <div className="grid grid-cols-3 gap-1 p-1 bg-[#0E141F] border border-white/8 rounded-lg">
              {(
                [
                  { id: 'all', label: 'Global' },
                  { id: 'top_leagues', label: 'Top Leagues' },
                  { id: 'watchlist', label: `Watchlist (${props.watchlistIds.length})` },
                ] as const
              ).map((sc) => (
                <button
                  key={sc.id}
                  type="button"
                  onClick={() => setRadarScope(sc.id)}
                  className={`py-1 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap ${
                    radarScope === sc.id ? 'bg-[#1F293B] text-white' : 'text-slate-400 hover:text-slate-200'
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

        {props.isLoading && matches.length === 0 ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-20 rounded-lg bg-[#0E141F] border border-white/8 animate-pulse" />
            ))}
          </div>
        ) : filteredMatches.length === 0 ? (
          <div className="py-10 text-center text-xs text-slate-400 border border-white/8 rounded-lg bg-[#0E141F]">
            No scraped fixtures match your current filters.
          </div>
        ) : (
          <div className="space-y-1.5 max-h-[720px] overflow-y-auto pr-1">
            {filteredMatches.map((m) => (
              <FixtureRow
                key={m.id}
                match={m}
                prediction={predictionsByMatch.get(m.id)}
                bestEv={(alertsByMatch.get(m.id) || [])[0]}
                isSelected={selectedMatch?.id === m.id}
                isStarred={watchlistSet.has(m.id)}
                onSelect={props.onSelectMatch}
                onToggleWatchlist={props.onToggleWatchlist}
              />
            ))}
          </div>
        )}
      </aside>

      <div className="lg:col-span-7 xl:col-span-8">
        <MatchInspector
          match={selectedMatch}
          prediction={selectedPrediction}
          alerts={selectedAlerts}
          trends={selectedTrends}
          aiBriefs={props.aiBriefs}
          loadingTrendIds={props.loadingTrendIds}
          trendErrors={props.trendErrors}
          onAnalyzeTrend={props.onAnalyzeTrend}
          onRefreshMatch={props.onRefreshMatch}
          isRefreshing={props.isRefreshingSingle}
          isWatchlisted={selectedMatch ? watchlistSet.has(selectedMatch.id) : false}
          onToggleWatchlist={props.onToggleWatchlist}
        />
      </div>
    </div>
  );
}

function FixtureRow(props: {
  match: ScrapedMatch;
  prediction?: PureFlowPrediction;
  bestEv?: ValueAlert;
  isSelected: boolean;
  isStarred: boolean;
  onSelect: (id: string) => void;
  onToggleWatchlist: (id: string) => void;
}) {
  const { match: m, prediction: pred, bestEv, isSelected, isStarred } = props;
  const w = pred?.markets.winner1X2;
  return (
    <div
      className={`flex items-stretch rounded-lg border transition-colors ${
        isSelected ? 'bg-[#1A2436] border-emerald-500/40' : 'bg-[#0E141F] border-white/8 hover:border-white/20'
      }`}
    >
      <button type="button" onClick={() => props.onSelect(m.id)} className="flex-1 min-w-0 text-left p-3">
        <div className="flex items-center justify-between gap-2 text-[11px] text-slate-400">
          <span className="truncate">{m.league}</span>
          <span className={`font-mono tabular-nums shrink-0 ${m.state === 'in' ? 'text-emerald-400 font-semibold' : 'text-slate-400'}`}>
            {m.state === 'in'
              ? `${m.minute}'`
              : m.state === 'post'
              ? 'FT'
              : new Date(m.startDate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-2 text-xs font-medium text-slate-100">
          <span className="truncate">{m.homeTeam}</span>
          <span className="font-mono tabular-nums font-bold text-white shrink-0">{m.homeScore}</span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2 text-xs font-medium text-slate-100">
          <span className="truncate">{m.awayTeam}</span>
          <span className="font-mono tabular-nums font-bold text-white shrink-0">{m.awayScore}</span>
        </div>
        <div className="mt-2 pt-1.5 border-t border-white/6 flex items-center justify-between gap-2 text-[11px] font-mono tabular-nums text-slate-400">
          <span>Flow: {pred ? `${pred.netMomentum >= 0 ? '+' : ''}${pred.netMomentum.toFixed(1)}` : '0.0'}</span>
          {bestEv ? (
            <span className="text-emerald-400 font-semibold">+{bestEv.evPct.toFixed(1)}% EV</span>
          ) : (
            <span>
              1X2: {w ? `${(w.homeProb * 100).toFixed(0)}/${(w.drawProb * 100).toFixed(0)}/${(w.awayProb * 100).toFixed(0)}` : '—'}
            </span>
          )}
        </div>
      </button>
      <button
        type="button"
        onClick={() => props.onToggleWatchlist(m.id)}
        aria-pressed={isStarred}
        aria-label={isStarred ? `Remove ${m.homeTeam} vs ${m.awayTeam} from Watchlist` : `Add ${m.homeTeam} vs ${m.awayTeam} to Watchlist`}
        title={isStarred ? 'Remove from Watchlist' : 'Pin to Watchlist'}
        className="px-2.5 flex items-center justify-center border-l border-white/6 text-slate-500 hover:text-amber-300 transition-colors shrink-0"
      >
        <Star className={`w-3.5 h-3.5 ${isStarred ? 'fill-amber-400 text-amber-400' : ''}`} aria-hidden="true" />
      </button>
    </div>
  );
}
