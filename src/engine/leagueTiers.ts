import type { AlertScopeMode, ScrapedMatch } from '../types/soccer';

const TOP_TIER_LEAGUE_PATTERNS = [
  /premier league/i,
  /champions league/i,
  /europa league/i,
  /conference league/i,
  /la liga/i,
  /bundesliga/i,
  /serie a/i,
  /ligue 1/i,
  /eredivisie/i,
  /primeira liga/i,
  /\bmls\b/i,
  /\bliga mx\b/i,
  /championship/i,
  /copa libertadores/i,
  /world cup/i,
  /euro/i,
  /fa cup/i,
  /copa del rey/i,
];

export function isTopTierLeague(leagueName: string, leagueSlug?: string): boolean {
  const combined = `${leagueName} ${leagueSlug || ''}`;
  return TOP_TIER_LEAGUE_PATTERNS.some((rx) => rx.test(combined));
}

export function filterMatchIdsByAlertScope(params: {
  matches: ScrapedMatch[];
  scope: AlertScopeMode;
  watchlistIds: Set<string>;
}): Set<string> {
  const { matches, scope, watchlistIds } = params;
  if (scope === 'all') {
    return new Set(matches.map((m) => m.id));
  }
  if (scope === 'watchlist') {
    return new Set(matches.filter((m) => watchlistIds.has(m.id)).map((m) => m.id));
  }
  return new Set(
    matches
      .filter((m) => isTopTierLeague(m.league, m.leagueSlug))
      .map((m) => m.id)
  );
}
