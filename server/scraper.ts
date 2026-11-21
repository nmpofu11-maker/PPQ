import * as cheerio from 'cheerio';
import type {
  MatchEventItem,
  MatchEventType,
  MatchLifecycleState,
  ScrapedMatch,
  ScrapedOdds,
  TeamMatchStats,
} from '../src/types/soccer';

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

interface CacheEntry<T> {
  expiresAt: number;
  data: T;
}

const scoreboardCache = new Map<string, CacheEntry<ScrapedMatch[]>>();
const summaryCache = new Map<string, CacheEntry<Partial<ScrapedMatch>>>();
let bbcCache: CacheEntry<Map<string, string>> | null = null;

function normalizeTeamName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(fc|cf|sc|afc|ac|as|fk|bk|united|city|town)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

function parseMinute(displayClock: string | undefined, clockVal: number | undefined, state: MatchLifecycleState): number {
  if (state === 'pre') return 0;
  if (displayClock) {
    const clean = displayClock.replace(/'/g, '').trim();
    if (clean.toUpperCase() === 'HT') return 45;
    if (clean.toUpperCase() === 'FT') return 90;
    const plusParts = clean.split('+');
    if (plusParts.length === 2) {
      const base = parseInt(plusParts[0], 10);
      const added = parseInt(plusParts[1], 10);
      if (Number.isFinite(base) && Number.isFinite(added)) {
        return Math.min(95, base + added);
      }
    }
    const parsed = parseInt(clean, 10);
    if (Number.isFinite(parsed)) return Math.min(95, Math.max(0, parsed));
  }
  if (typeof clockVal === 'number' && Number.isFinite(clockVal)) {
    return Math.min(95, Math.max(0, Math.round(clockVal / 60)));
  }
  return state === 'post' ? 90 : 1;
}

function classifyPlayType(
  playType: string | undefined,
  text: string
): MatchEventType {
  const pt = (playType || '').toLowerCase();
  const tx = text.toLowerCase();

  if (pt.includes('goal') || pt.includes('penalty---scored') || tx.startsWith('goal!')) {
    return 'goal';
  }
  if (pt.includes('red-card') || tx.includes('red card') || tx.includes('second yellow')) {
    return 'red_card';
  }
  if (pt.includes('yellow-card') || tx.includes('yellow card')) {
    return 'yellow_card';
  }
  if (pt.includes('corner') || tx.startsWith('corner,')) {
    return 'corner';
  }
  if (
    pt.includes('shot-on-target') ||
    tx.includes('attempt saved') ||
    tx.includes('saved in the') ||
    tx.includes('hits the bar') ||
    tx.includes('hits the left post') ||
    tx.includes('hits the right post')
  ) {
    return 'shot_on_target';
  }
  if (
    pt.includes('shot') ||
    pt.includes('attempt') ||
    tx.includes('attempt missed') ||
    tx.includes('attempt blocked')
  ) {
    return 'shot_off_target';
  }
  if (pt.includes('save')) {
    return 'save';
  }
  if (pt.includes('foul') || tx.includes('foul by') || tx.includes('wins a free kick')) {
    return 'foul';
  }
  if (pt.includes('substitution') || tx.startsWith('substitution,')) {
    return 'substitution';
  }
  if (pt.includes('kickoff')) return 'kickoff';
  if (pt.includes('halftime')) return 'halftime';
  if (pt.includes('fulltime')) return 'fulltime';
  return 'other';
}

function resolveTeamSide(
  teamNameFromPlay: string | undefined,
  text: string,
  homeTeam: string,
  awayTeam: string
): 'home' | 'away' | 'neutral' {
  const normHome = normalizeTeamName(homeTeam);
  const normAway = normalizeTeamName(awayTeam);

  if (teamNameFromPlay) {
    const normPlay = normalizeTeamName(teamNameFromPlay);
    if (normPlay && normHome && (normPlay.includes(normHome) || normHome.includes(normPlay))) {
      return 'home';
    }
    if (normPlay && normAway && (normPlay.includes(normAway) || normAway.includes(normPlay))) {
      return 'away';
    }
  }

  const lower = text.toLowerCase();
  if (lower.includes(homeTeam.toLowerCase())) return 'home';
  if (lower.includes(awayTeam.toLowerCase())) return 'away';
  return 'neutral';
}

function emptyStats(): TeamMatchStats {
  return {
    possessionPct: null,
    totalShots: 0,
    shotsOnTarget: 0,
    wonCorners: 0,
    foulsCommitted: 0,
    yellowCards: 0,
    redCards: 0,
    offsides: 0,
    saves: 0,
    formScore: null,
    lastFiveSummary: [],
  };
}

function parseBoxscoreStats(statsArr: any[] | undefined): Partial<TeamMatchStats> {
  if (!Array.isArray(statsArr)) return {};
  const map = new Map<string, number>();
  for (const s of statsArr) {
    if (s?.name) {
      const val = parseFloat(String(s.displayValue ?? s.value ?? ''));
      if (Number.isFinite(val)) map.set(s.name, val);
    }
  }
  return {
    possessionPct: map.has('possessionPct') ? map.get('possessionPct')! : null,
    totalShots: map.get('totalShots') ?? 0,
    shotsOnTarget: map.get('shotsOnTarget') ?? 0,
    wonCorners: map.get('wonCorners') ?? 0,
    foulsCommitted: map.get('foulsCommitted') ?? 0,
    yellowCards: map.get('yellowCards') ?? 0,
    redCards: map.get('redCards') ?? 0,
    offsides: map.get('offsides') ?? 0,
    saves: map.get('saves') ?? 0,
  };
}

function parseLastFiveForm(lastFiveEntry: any): {
  formScore: number | null;
  lastFiveSummary: string[];
} {
  const events = lastFiveEntry?.events;
  if (!Array.isArray(events) || events.length === 0) {
    return { formScore: null, lastFiveSummary: [] };
  }

  let weightedSum = 0;
  let totalWeight = 0;
  const summary: string[] = [];

  // Most recent games weighted higher
  const slice = events.slice(0, 5);
  slice.forEach((ev: any, idx: number) => {
    const res = String(ev.gameResult || '').toUpperCase();
    const w = Math.pow(0.82, idx);
    let score = 0;
    if (res === 'W') score = 1;
    else if (res === 'L') score = -1;

    const hS = Number(ev.homeTeamScore);
    const aS = Number(ev.awayTeamScore);
    let gdAdj = 0;
    if (Number.isFinite(hS) && Number.isFinite(aS)) {
      const gd = Math.abs(hS - aS);
      gdAdj = res === 'W' ? Math.min(0.25, gd * 0.08) : res === 'L' ? -Math.min(0.25, gd * 0.08) : 0;
    }

    weightedSum += (score + gdAdj) * w;
    totalWeight += w;
    summary.push(`${res || '?'} ${ev.score || ''}`.trim());
  });

  const formScore =
    totalWeight > 0 ? Number(Math.max(-1, Math.min(1, weightedSum / totalWeight)).toFixed(3)) : null;

  return { formScore, lastFiveSummary: summary };
}

function parseScrapedOdds(oddsArr: any[] | undefined, state: MatchLifecycleState): ScrapedOdds | null {
  if (!Array.isArray(oddsArr) || oddsArr.length === 0) return null;
  const primary = oddsArr[0];
  const provider = primary?.provider?.name || 'DraftKings';
  const ml = primary?.moneyline;
  const total = primary?.total;
  const spread = primary?.pointSpread;

  const pickOdds = (node: any): { val: string | null; isLive: boolean } => {
    if (!node) return { val: null, isLive: false };
    if (state === 'in' && node.live?.odds) {
      return { val: String(node.live.odds), isLive: true };
    }
    if (node.close?.odds) return { val: String(node.close.odds), isLive: false };
    if (node.open?.odds) return { val: String(node.open.odds), isLive: false };
    return { val: null, isLive: false };
  };

  const pickLine = (node: any, isLivePreferred: boolean): number | null => {
    if (!node) return null;
    const raw =
      (isLivePreferred && node.live?.line) || node.close?.line || node.open?.line || null;
    if (!raw) return null;
    const parsed = parseFloat(String(raw).replace(/[^0-9+.\-]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  };

  const homeMl = pickOdds(ml?.home);
  const drawMl = pickOdds(ml?.draw);
  const awayMl = pickOdds(ml?.away);
  const over = pickOdds(total?.over);
  const under = pickOdds(total?.under);
  const hSpread = pickOdds(spread?.home);
  const aSpread = pickOdds(spread?.away);

  const isLive = homeMl.isLive || over.isLive || hSpread.isLive;
  const totalLine = pickLine(total?.over, state === 'in');
  const spreadLine = pickLine(spread?.home, state === 'in');

  if (!homeMl.val && !over.val && !hSpread.val) return null;

  return {
    provider,
    isLive,
    homeMoneyline: homeMl.val,
    drawMoneyline: drawMl.val,
    awayMoneyline: awayMl.val,
    totalLine,
    overOdds: over.val,
    underOdds: under.val,
    spreadLine,
    homeSpreadOdds: hSpread.val,
    awaySpreadOdds: aSpread.val,
  };
}

/**
 * Secondary HTML scraper: parses BBC Sport Football Scores & Fixtures page via Cheerio
 * to cross-check live scorelines independently.
 */
async function scrapeBbcScoreCrossCheck(): Promise<Map<string, string>> {
  const now = Date.now();
  if (bbcCache && bbcCache.expiresAt > now) {
    return bbcCache.data;
  }

  const scoreMap = new Map<string, string>();
  try {
    const res = await fetch('https://www.bbc.com/sport/football/scores-fixtures', {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) return scoreMap;

    const html = await res.text();
    const $ = cheerio.load(html);
    let initialJsonStr: string | null = null;

    $('script').each((_, el) => {
      const content = $(el).html() || '';
      if (content.includes('window.__INITIAL_DATA__=')) {
        const m = content.match(/window\.__INITIAL_DATA__="([\s\S]*?)";/);
        if (m) {
          initialJsonStr = m[1];
        }
      }
    });

    if (initialJsonStr) {
      const decoded = JSON.parse(`"${initialJsonStr}"`);
      const parsed = JSON.parse(decoded);
      const walk = (node: any) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
          for (const item of node) walk(item);
          return;
        }
        if (node.home?.fullName && node.away?.fullName) {
          const hKey = normalizeTeamName(node.home.fullName);
          const aKey = normalizeTeamName(node.away.fullName);
          const hScore = node.home.score ?? '';
          const aScore = node.away.score ?? '';
          if (hKey && aKey && hScore !== '' && aScore !== '') {
            scoreMap.set(`${hKey}__${aKey}`, `${hScore}-${aScore}`);
          }
        }
        for (const v of Object.values(node)) walk(v);
      };
      walk(parsed);
    }
  } catch {
    // Non-fatal secondary cross-check failure
  }

  bbcCache = { expiresAt: now + 30_000, data: scoreMap };
  return scoreMap;
}

async function fetchEspnMatchSummary(
  match: ScrapedMatch
): Promise<Partial<ScrapedMatch>> {
  const now = Date.now();
  const cached = summaryCache.get(match.id);
  const ttl = match.state === 'post' ? 300_000 : 12_000;
  if (cached && cached.expiresAt > now) {
    return cached.data;
  }

  const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/all/summary?event=${encodeURIComponent(
    match.id
  )}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) return {};
  const data = await res.json();

  const homeStats: TeamMatchStats = { ...match.homeStats };
  const awayStats: TeamMatchStats = { ...match.awayStats };

  const boxTeams = data.boxscore?.teams;
  if (Array.isArray(boxTeams)) {
    for (const bt of boxTeams) {
      const isHome =
        bt.homeAway === 'home' ||
        normalizeTeamName(bt.team?.displayName || '') === normalizeTeamName(match.homeTeam);
      const parsed = parseBoxscoreStats(bt.statistics);
      if (isHome) Object.assign(homeStats, parsed);
      else Object.assign(awayStats, parsed);
    }
  }

  const lastFive = data.lastFiveGames;
  if (Array.isArray(lastFive)) {
    for (const lf of lastFive) {
      const isHome =
        normalizeTeamName(lf.team?.displayName || '') === normalizeTeamName(match.homeTeam);
      const parsedForm = parseLastFiveForm(lf);
      if (isHome) {
        homeStats.formScore = parsedForm.formScore;
        homeStats.lastFiveSummary = parsedForm.lastFiveSummary;
      } else {
        awayStats.formScore = parsedForm.formScore;
        awayStats.lastFiveSummary = parsedForm.lastFiveSummary;
      }
    }
  }

  const events: MatchEventItem[] = [];
  const rawCommentary = Array.isArray(data.commentary) ? data.commentary : [];
  const rawKeyEvents = Array.isArray(data.keyEvents) ? data.keyEvents : [];

  const sourceList = rawCommentary.length > 0 ? rawCommentary : rawKeyEvents;
  sourceList.forEach((item: any, idx: number) => {
    const text = String(item.text || item.play?.text || '');
    if (!text) return;
    const clockDisplay = String(
      item.time?.displayValue || item.clock?.displayValue || ''
    );
    const clockVal = item.time?.value ?? item.clock?.value;
    const minute = parseMinute(clockDisplay, clockVal, match.state);
    const playType = item.play?.type?.type || item.type?.type;
    const teamNameFromPlay = item.play?.team?.displayName || item.team?.displayName;
    let eventType = classifyPlayType(playType, text);
    let teamSide = resolveTeamSide(
      teamNameFromPlay,
      text,
      match.homeTeam,
      match.awayTeam
    );

    // ESPN "Attempt saved" sometimes tags the goalkeeper's team or attacker's team;
    // normalize so shots on target credit the attacking team accurately
    if (eventType === 'save' && text.toLowerCase().includes('attempt saved')) {
      eventType = 'shot_on_target';
    }

    events.push({
      id: String(item.play?.id || item.id || `${match.id}_ev_${idx}`),
      minute,
      clockDisplay: clockDisplay || `${minute}'`,
      sequence: Number(item.sequence ?? idx),
      teamSide,
      teamName: teamNameFromPlay,
      eventType,
      text,
    });
  });

  events.sort((a, b) => a.minute - b.minute || a.sequence - b.sequence);

  const scrapedOdds = parseScrapedOdds(data.odds, match.state) || match.scrapedOdds;
  const headerLeagueName = data.header?.league?.name
    ? String(data.header.league.name)
    : undefined;
  const headerLeagueSlug = data.header?.league?.slug
    ? String(data.header.league.slug)
    : undefined;

  const partial: Partial<ScrapedMatch> = {
    ...(headerLeagueName ? { league: headerLeagueName } : {}),
    ...(headerLeagueSlug ? { leagueSlug: headerLeagueSlug } : {}),
    homeStats,
    awayStats,
    events,
    hasDetailedFlow: events.length > 0 || (homeStats.totalShots + awayStats.totalShots > 0),
    scrapedOdds,
  };

  summaryCache.set(match.id, { expiresAt: now + ttl, data: partial });
  return partial;
}

function parseScoreboardEvent(
  ev: any,
  bbcScores: Map<string, string>,
  leagueLookup: Map<string, { name: string; slug: string }>
): ScrapedMatch | null {
  const comp = ev.competitions?.[0];
  if (!comp) return null;

  const competitors = comp.competitors || [];
  const homeComp = competitors.find((c: any) => c.homeAway === 'home') || competitors[0];
  const awayComp = competitors.find((c: any) => c.homeAway === 'away') || competitors[1];
  if (!homeComp || !awayComp) return null;

  const stateRaw = ev.status?.type?.state;
  const state: MatchLifecycleState =
    stateRaw === 'in' ? 'in' : stateRaw === 'post' ? 'post' : 'pre';

  const displayClock = ev.status?.displayClock || ev.status?.type?.shortDetail || '';
  const minute = parseMinute(displayClock, ev.status?.clock, state);

  const homeTeam = String(homeComp.team?.displayName || homeComp.team?.name || 'Home');
  const awayTeam = String(awayComp.team?.displayName || awayComp.team?.name || 'Away');

  const leagueSlugFromLinks = (() => {
    const allLinks = [
      ...(Array.isArray(ev.links) ? ev.links : []),
      ...(Array.isArray(homeComp.team?.links) ? homeComp.team.links : []),
    ];
    for (const l of allLinks) {
      const href = String(l?.href || '');
      const m = href.match(/\/league\/([^/?#]+)/i);
      if (m) return m[1];
    }
    return '';
  })();

  const LEAGUE_NAMES: Record<string, string> = {
    'eng.1': 'English Premier League',
    'eng.2': 'EFL Championship',
    'eng.fa': 'FA Cup',
    'esp.1': 'Spanish La Liga',
    'ger.1': 'German Bundesliga',
    'ita.1': 'Italian Serie A',
    'fra.1': 'French Ligue 1',
    'fra.coupe': 'Coupe de France',
    'usa.1': 'MLS',
    'usa.w.1': 'NWSL',
    'usa.w.usl.1': 'USL Super League',
    'aus.1': 'Australian A-League Men',
    'aus.w.1': 'Australian A-League Women',
    'uefa.champions': 'UEFA Champions League',
    'uefa.europa': 'UEFA Europa League',
    'ned.1': 'Dutch Eredivisie',
    'por.1': 'Portuguese Primeira Liga',
    'bra.1': 'Brazilian Serie A',
    'arg.1': 'Argentine Liga Profesional',
    'mex.1': 'Liga MX',
    'jpn.1': 'J1 League',
    'fifa.worldq.concacaf': 'World Cup Qualifying (CONCACAF)',
    'fifa.worldq.uefa': 'World Cup Qualifying (UEFA)',
    'fifa.friendly': 'International Friendly',
  };

  const uidLeagueId = String(ev.uid || '').match(/~l:(\d+)~/)?.[1] || '';

  const leagueInfo =
    leagueLookup.get(leagueSlugFromLinks) ||
    leagueLookup.get(uidLeagueId) ||
    leagueLookup.get(ev.season?.slug || '') ||
    leagueLookup.get(comp.league?.id || '') ||
    null;

  const fallbackSlug = leagueSlugFromLinks || String(ev.season?.slug || '');
  const leagueName =
    ev.league?.name ||
    leagueInfo?.name ||
    LEAGUE_NAMES[leagueSlugFromLinks.toLowerCase()] ||
    comp.notes?.[0]?.headline ||
    (fallbackSlug && !/regular-season|fall-season/i.test(fallbackSlug)
      ? fallbackSlug.replace(/[-.]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
      : 'Global Soccer');

  const hNorm = normalizeTeamName(homeTeam);
  const aNorm = normalizeTeamName(awayTeam);
  const bbcScore = bbcScores.get(`${hNorm}__${aNorm}`) || null;

  const homeStats = emptyStats();
  const awayStats = emptyStats();
  if (Array.isArray(homeComp.statistics)) {
    Object.assign(homeStats, parseBoxscoreStats(homeComp.statistics));
  }
  if (Array.isArray(awayComp.statistics)) {
    Object.assign(awayStats, parseBoxscoreStats(awayComp.statistics));
  }

  return {
    id: String(ev.id),
    league: leagueName,
    leagueSlug: String(ev.season?.slug || 'soccer'),
    startDate: String(ev.date || new Date().toISOString()),
    state,
    minute,
    statusText: String(ev.status?.type?.shortDetail || ev.status?.type?.description || state),
    venue: comp.venue?.fullName ? String(comp.venue.fullName) : null,
    homeTeam,
    homeAbbr: String(homeComp.team?.abbreviation || homeTeam.slice(0, 3).toUpperCase()),
    awayTeam,
    awayAbbr: String(awayComp.team?.abbreviation || awayTeam.slice(0, 3).toUpperCase()),
    homeScore: parseInt(String(homeComp.score ?? '0'), 10) || 0,
    awayScore: parseInt(String(awayComp.score ?? '0'), 10) || 0,
    homeStats,
    awayStats,
    events: [],
    hasDetailedFlow: false,
    bbcCrossCheck: {
      matched: bbcScore !== null,
      scoreLabel: bbcScore,
    },
    scrapedOdds: parseScrapedOdds(comp.odds, state),
    lastUpdated: new Date().toISOString(),
  };
}

async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  limit: number
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let cursor = 0;

  async function worker() {
    while (cursor < tasks.length) {
      const idx = cursor++;
      results[idx] = await tasks[idx]();
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
  return results;
}

export async function scrapeScoreboardMatches(options?: {
  dateYyyymmdd?: string;
  enrichLimit?: number;
  onlyFinished?: boolean;
}): Promise<{
  matches: ScrapedMatch[];
  sources: { espnCount: number; bbcCrossCheckedCount: number; scrapedAt: string };
}> {
  const cacheKey = `${options?.dateYyyymmdd || 'live'}_${options?.onlyFinished ? 'post' : 'all'}`;
  const now = Date.now();
  const ttl = options?.dateYyyymmdd ? 180_000 : 15_000;

  const cached = scoreboardCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return {
      matches: cached.data,
      sources: {
        espnCount: cached.data.length,
        bbcCrossCheckedCount: cached.data.filter((m) => m.bbcCrossCheck.matched).length,
        scrapedAt: new Date().toISOString(),
      },
    };
  }

  const espnUrl = options?.dateYyyymmdd
    ? `https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard?dates=${encodeURIComponent(
        options.dateYyyymmdd
      )}`
    : 'https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard';

  const [espnRes, bbcScores] = await Promise.all([
    fetch(espnUrl, { headers: { 'User-Agent': USER_AGENT } }),
    options?.dateYyyymmdd ? Promise.resolve(new Map<string, string>()) : scrapeBbcScoreCrossCheck(),
  ]);

  if (!espnRes.ok) {
    throw new Error(`ESPN scoreboard scrape failed with HTTP ${espnRes.status}`);
  }

  const json = await espnRes.json();
  const leagueLookup = new Map<string, { name: string; slug: string }>();
  if (Array.isArray(json.leagues)) {
    for (const lg of json.leagues) {
      if (lg.slug && lg.name) {
        leagueLookup.set(String(lg.slug), { name: String(lg.name), slug: String(lg.slug) });
      }
      if (lg.id && lg.name) {
        leagueLookup.set(String(lg.id), { name: String(lg.name), slug: String(lg.slug || '') });
      }
    }
  }

  const rawEvents = Array.isArray(json.events) ? json.events : [];
  let matches: ScrapedMatch[] = rawEvents
    .map((ev: any) => parseScoreboardEvent(ev, bbcScores, leagueLookup))
    .filter((m: ScrapedMatch | null): m is ScrapedMatch => m !== null);

  if (options?.onlyFinished) {
    matches = matches.filter((m) => m.state === 'post');
  }

  // Sort: live ('in') first, then upcoming ('pre') by soonest, then finished ('post')
  matches.sort((a, b) => {
    const rank: Record<MatchLifecycleState, number> = { in: 0, pre: 1, post: 2 };
    if (rank[a.state] !== rank[b.state]) return rank[a.state] - rank[b.state];
    return new Date(a.startDate).getTime() - new Date(b.startDate).getTime();
  });

  // Enrich live matches first, then finished/upcoming up to enrichLimit
  const enrichLimit = options?.enrichLimit ?? 22;
  const toEnrich = matches.slice(0, enrichLimit);

  await runWithConcurrency(
    toEnrich.map((m) => async () => {
      try {
        const details = await fetchEspnMatchSummary(m);
        Object.assign(m, details);
      } catch {
        // Keep base scoreboard data if single match summary fails
      }
    }),
    6
  );

  scoreboardCache.set(cacheKey, { expiresAt: now + ttl, data: matches });

  return {
    matches,
    sources: {
      espnCount: matches.length,
      bbcCrossCheckedCount: matches.filter((m) => m.bbcCrossCheck.matched).length,
      scrapedAt: new Date().toISOString(),
    },
  };
}

export async function scrapeSingleMatchDetails(matchId: string): Promise<ScrapedMatch | null> {
  // Find match metadata from live scoreboard or fetch summary directly
  const { matches } = await scrapeScoreboardMatches({ enrichLimit: 0 });
  const existing = matches.find((m) => m.id === matchId);
  if (existing) {
    const details = await fetchEspnMatchSummary(existing);
    return { ...existing, ...details };
  }

  const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/all/summary?event=${encodeURIComponent(
    matchId
  )}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) return null;
  const data = await res.json();
  const comp = data.header?.competitions?.[0];
  if (!comp) return null;

  const homeComp = comp.competitors?.find((c: any) => c.homeAway === 'home') || comp.competitors?.[0];
  const awayComp = comp.competitors?.find((c: any) => c.homeAway === 'away') || comp.competitors?.[1];
  const stateRaw = comp.status?.type?.state;
  const state: MatchLifecycleState =
    stateRaw === 'in' ? 'in' : stateRaw === 'post' ? 'post' : 'pre';

  const base: ScrapedMatch = {
    id: matchId,
    league: String(data.header?.league?.name || 'Soccer'),
    leagueSlug: String(data.header?.league?.slug || 'soccer'),
    startDate: String(comp.date || new Date().toISOString()),
    state,
    minute: parseMinute(comp.status?.displayClock, comp.status?.clock, state),
    statusText: String(comp.status?.type?.shortDetail || state),
    venue: data.gameInfo?.venue?.fullName || null,
    homeTeam: String(homeComp?.team?.displayName || 'Home'),
    homeAbbr: String(homeComp?.team?.abbreviation || 'HOM'),
    awayTeam: String(awayComp?.team?.displayName || 'Away'),
    awayAbbr: String(awayComp?.team?.abbreviation || 'AWY'),
    homeScore: parseInt(String(homeComp?.score ?? '0'), 10) || 0,
    awayScore: parseInt(String(awayComp?.score ?? '0'), 10) || 0,
    homeStats: emptyStats(),
    awayStats: emptyStats(),
    events: [],
    hasDetailedFlow: false,
    bbcCrossCheck: { matched: false, scoreLabel: null },
    scrapedOdds: null,
    lastUpdated: new Date().toISOString(),
  };

  const details = await fetchEspnMatchSummary(base);
  return { ...base, ...details };
}
