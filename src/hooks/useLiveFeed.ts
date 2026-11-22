import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScrapedMatch } from '../types/soccer';

export interface SourcesMeta {
  espnCount: number;
  bbcCrossCheckedCount: number;
  scrapedAt: string;
}

const POLL_INTERVAL_MS = 30_000;

/** Polls the server's live feed. `onScraped` runs side effects (learning, settling) per scrape. */
export function useLiveFeed(onScraped: (scraped: ScrapedMatch[]) => void) {
  const [matches, setMatches] = useState<ScrapedMatch[]>([]);
  const [sourcesMeta, setSourcesMeta] = useState<SourcesMeta | null>(null);
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null);
  const [autoPoll, setAutoPoll] = useState(true);
  const [isLoadingMatches, setIsLoadingMatches] = useState(true);
  const [isRefreshingSingle, setIsRefreshingSingle] = useState(false);
  const [scrapeError, setScrapeError] = useState<string | null>(null);

  const onScrapedRef = useRef(onScraped);
  onScrapedRef.current = onScraped;

  const fetchLiveFeed = useCallback(async (silent = false) => {
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

      onScrapedRef.current(scraped);
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

  const refreshSingleMatch = useCallback(async (matchId: string) => {
    setIsRefreshingSingle(true);
    try {
      const res = await fetch(`/api/matches/${encodeURIComponent(matchId)}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.match) {
        setMatches((prev) => prev.map((m) => (m.id === matchId ? (data.match as ScrapedMatch) : m)));
      }
    } finally {
      setIsRefreshingSingle(false);
    }
  }, []);

  return {
    matches,
    sourcesMeta,
    selectedMatchId,
    setSelectedMatchId,
    autoPoll,
    setAutoPoll,
    isLoadingMatches,
    isRefreshingSingle,
    scrapeError,
    fetchLiveFeed,
    refreshSingleMatch,
  };
}
