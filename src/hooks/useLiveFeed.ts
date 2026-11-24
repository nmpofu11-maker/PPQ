import { useCallback, useEffect, useRef, useState } from 'react';
import type { MatchLifecycleState, ScrapedMatch } from '../types/soccer';
import { parseJsonResponse } from '../lib/safeJson';

export interface SourcesMeta {
  espnCount: number;
  bbcCrossCheckedCount: number;
  scrapedAt: string;
  leagueCount?: number;
}

export interface EspnLeagueOption {
  slug: string;
  name: string;
}

const POLL_INTERVAL_MS = 30_000;

function mergeAndSortMatches(base: ScrapedMatch[], incoming: ScrapedMatch[]): ScrapedMatch[] {
  const byId = new Map<string, ScrapedMatch>();
  for (const m of base) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);

  const merged = Array.from(byId.values());
  const rank: Record<MatchLifecycleState, number> = { in: 0, pre: 1, post: 2 };
  merged.sort((a, b) => {
    if (rank[a.state] !== rank[b.state]) return rank[a.state] - rank[b.state];
    const ta = new Date(a.startDate).getTime();
    const tb = new Date(b.startDate).getTime();
    return a.state === 'post' ? tb - ta : ta - tb;
  });
  return merged;
}

/** Polls the server's live feed and ESPN league catalog. */
export function useLiveFeed(onScraped: (scraped: ScrapedMatch[]) => void) {
  const [matches, setMatches] = useState<ScrapedMatch[]>([]);
  const [sourcesMeta, setSourcesMeta] = useState<SourcesMeta | null>(null);
  const [espnLeagues, setEspnLeagues] = useState<EspnLeagueOption[]>([]);
  const [loadingLeague, setLoadingLeague] = useState<string | null>(null);
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null);
  const [autoPoll, setAutoPoll] = useState(true);
  const [isLoadingMatches, setIsLoadingMatches] = useState(true);
  const [isRefreshingSingle, setIsRefreshingSingle] = useState(false);
  const [scrapeError, setScrapeError] = useState<string | null>(null);

  const onScrapedRef = useRef(onScraped);
  onScrapedRef.current = onScraped;

  const extraMatchesRef = useRef<ScrapedMatch[]>([]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch('/api/leagues');
        const data = await parseJsonResponse<{ leagues?: EspnLeagueOption[] }>(res, 'League catalog');
        if (active && Array.isArray(data.leagues)) {
          setEspnLeagues(data.leagues);
        }
      } catch {
        // Non-fatal: loaded feed leagues are still shown in RadarView
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const fetchLiveFeed = useCallback(async (silent = false) => {
    if (!silent) setIsLoadingMatches(true);
    setScrapeError(null);
    try {
      const res = await fetch('/api/matches/live');
      const data = await parseJsonResponse<{
        matches?: ScrapedMatch[];
        sources?: SourcesMeta;
      }>(res, 'Live scrape');

      const scraped: ScrapedMatch[] = Array.isArray(data.matches) ? data.matches : [];
      const combined =
        extraMatchesRef.current.length > 0
          ? mergeAndSortMatches(extraMatchesRef.current, scraped)
          : scraped;

      setMatches(combined);
      setSourcesMeta(data.sources || null);

      setSelectedMatchId((prev) => {
        if (prev && combined.some((m) => m.id === prev)) return prev;
        const firstLive = combined.find((m) => m.state === 'in');
        const firstFlow = combined.find((m) => m.hasDetailedFlow);
        return firstLive?.id || firstFlow?.id || combined[0]?.id || null;
      });

      onScrapedRef.current(combined);
    } catch (err) {
      setScrapeError(err instanceof Error ? err.message : 'Unable to scrape live matches');
    } finally {
      setIsLoadingMatches(false);
    }
  }, []);

  useEffect(() => {
    void fetchLiveFeed(false);
  }, [fetchLiveFeed]);

  useEffect(() => {
    if (!autoPoll) return;
    const timer = window.setInterval(() => {
      void fetchLiveFeed(true);
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [autoPoll, fetchLiveFeed]);

  const loadLeagueMatches = useCallback(async (leagueSlug: string): Promise<ScrapedMatch[]> => {
    setLoadingLeague(leagueSlug);
    setScrapeError(null);
    try {
      const res = await fetch(`/api/matches/live?league=${encodeURIComponent(leagueSlug)}`);
      const data = await parseJsonResponse<{ matches?: ScrapedMatch[] }>(res, 'League scrape');
      const leagueMatches: ScrapedMatch[] = Array.isArray(data.matches) ? data.matches : [];

      if (leagueMatches.length > 0) {
        extraMatchesRef.current = mergeAndSortMatches(extraMatchesRef.current, leagueMatches);
        setMatches((prev) => mergeAndSortMatches(prev, leagueMatches));
        setSelectedMatchId((prev) => {
          if (prev && leagueMatches.some((m) => m.id === prev)) return prev;
          const firstLive = leagueMatches.find((m) => m.state === 'in');
          const firstFlow = leagueMatches.find((m) => m.hasDetailedFlow);
          return firstLive?.id || firstFlow?.id || leagueMatches[0]?.id || prev;
        });
        onScrapedRef.current(leagueMatches);
      }

      return leagueMatches;
    } catch (err) {
      setScrapeError(err instanceof Error ? err.message : 'Unable to load ESPN league');
      return [];
    } finally {
      setLoadingLeague(null);
    }
  }, []);

  const refreshSingleMatch = useCallback(async (matchId: string) => {
    setIsRefreshingSingle(true);
    try {
      const res = await fetch(`/api/matches/${encodeURIComponent(matchId)}`);
      if (!res.ok) return;
      const data = await parseJsonResponse<{ match?: ScrapedMatch }>(res, 'Match refresh');
      if (data.match) {
        const updated = data.match;
        setMatches((prev) => prev.map((m) => (m.id === matchId ? updated : m)));
      }
    } catch {
      // Preserve current match state on transient single-match refresh error
    } finally {
      setIsRefreshingSingle(false);
    }
  }, []);

  return {
    matches,
    sourcesMeta,
    espnLeagues,
    loadingLeague,
    selectedMatchId,
    setSelectedMatchId,
    autoPoll,
    setAutoPoll,
    isLoadingMatches,
    isRefreshingSingle,
    scrapeError,
    fetchLiveFeed,
    loadLeagueMatches,
    refreshSingleMatch,
  };
}
