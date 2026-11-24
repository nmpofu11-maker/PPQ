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

const FETCH_TIMEOUT_MS = 10_000;
const ESPN_SITE_HOSTS = [
  'https://site.api.espn.com',
  'https://site.web.api.espn.com',
] as const;

export interface EspnLeagueInfo {
  slug: string;
  name: string;
}

const KNOWN_LEAGUE_NAMES: Record<string, string> = {
  'eng.1': 'English Premier League',
  'eng.2': 'EFL Championship',
  'eng.3': 'EFL League One',
  'eng.4': 'EFL League Two',
  'eng.fa': 'English FA Cup',
  'eng.league_cup': 'English Carabao Cup',
  'esp.1': 'Spanish La Liga',
  'esp.2': 'Spanish Segunda División',
  'esp.copa_del_rey': 'Spanish Copa del Rey',
  'ger.1': 'German Bundesliga',
  'ger.2': 'German 2. Bundesliga',
  'ger.dfb_pokal': 'German DFB-Pokal',
  'ita.1': 'Italian Serie A',
  'ita.2': 'Italian Serie B',
  'ita.coppa_italia': 'Coppa Italia',
  'fra.1': 'French Ligue 1',
  'fra.2': 'French Ligue 2',
  'fra.coupe': 'Coupe de France',
  'ned.1': 'Dutch Eredivisie',
  'por.1': 'Portuguese Primeira Liga',
  'tur.1': 'Turkish Super Lig',
  'bel.1': 'Belgian Pro League',
  'sco.1': 'Scottish Premiership',
  'aut.1': 'Austrian Bundesliga',
  'sui.1': 'Swiss Super League',
  'gre.1': 'Greek Super League',
  'den.1': 'Danish Superliga',
  'nor.1': 'Norwegian Eliteserien',
  'swe.1': 'Swedish Allsvenskan',
  'rus.1': 'Russian Premier League',
  'usa.1': 'MLS',
  'usa.nwsl': 'NWSL',
  'usa.w.1': 'NWSL',
  'usa.w.usl.1': 'USL Super League',
  'mex.1': 'Liga MX',
  'bra.1': 'Brazilian Serie A',
  'arg.1': 'Argentine Liga Profesional',
  'col.1': 'Colombian Primera A',
  'chi.1': 'Chilean Primera División',
  'aus.1': 'Australian A-League Men',
  'aus.w.1': 'Australian A-League Women',
  'jpn.1': 'J1 League',
  'ksa.1': 'Saudi Pro League',
  'uefa.champions': 'UEFA Champions League',
  'uefa.europa': 'UEFA Europa League',
  'uefa.europa.conf': 'UEFA Conference League',
  'uefa.wchampions': "UEFA Women's Champions League",
  'uefa.nations': 'UEFA Nations League',
  'conmebol.libertadores': 'CONMEBOL Libertadores',
  'conmebol.sudamericana': 'CONMEBOL Sudamericana',
  'concacaf.champions': 'CONCACAF Champions Cup',
  'concacaf.nations.league': 'CONCACAF Nations League',
  'fifa.world': 'FIFA World Cup',
  'fifa.wwc': "FIFA Women's World Cup",
  'fifa.worldq.concacaf': 'World Cup Qualifying (CONCACAF)',
  'fifa.worldq.uefa': 'World Cup Qualifying (UEFA)',
  'fifa.friendly': 'International Friendly',
  'eng.w.1': "English Women's Super League",
};

const CORE_HISTORICAL_SLUGS = [
  'eng.1', 'eng.2', 'eng.3', 'eng.fa', 'eng.league_cup',
  'esp.1', 'esp.2', 'esp.copa_del_rey',
  'ger.1', 'ger.2', 'ger.dfb_pokal',
  'ita.1', 'ita.2', 'ita.coppa_italia',
  'fra.1', 'fra.2', 'fra.coupe',
  'ned.1', 'por.1', 'tur.1', 'bel.1', 'sco.1', 'aut.1', 'sui.1', 'gre.1',
  'usa.1', 'usa.nwsl', 'mex.1', 'bra.1', 'arg.1', 'aus.1', 'jpn.1', 'ksa.1',
  'uefa.champions', 'uefa.europa', 'uefa.europa.conf', 'uefa.nations',
  'conmebol.libertadores', 'conmebol.sudamericana', 'concacaf.champions',
  'fifa.friendly', 'eng.w.1',
];

function fetchWithTimeout(url: string, acceptJson = false): Promise<Response> {
  return fetch(url, {
    headers: acceptJson
      ? { 'User-Agent': USER_AGENT, Accept: 'application/json' }
      : { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

function formatSlugFallback(slug: string): string {
  if (KNOWN_LEAGUE_NAMES[slug]) return KNOWN_LEAGUE_NAMES[slug];
  return slug
    .replace(/\b(\w+)\.(\d+)\b/g, '$1 Tier $2')
    .replace(/[-._]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

interface CacheEntry<T> {
  expiresAt: number;
  data: T;
}

interface LeagueScoreboardCacheEntry {
  expiresAt: number;
  leagueSlug: string;
  leagueName: string | null;
  events: any[];
  leaguesMeta: Map<string, { name: string; slug: string }>;
}

const scoreboardCache = new Map<string, CacheEntry<ScrapedMatch[]>>();
const scoreboardInflight = new Map<string, Promise<ScoreboardResult>>();
const summaryCache = new Map<string, CacheEntry<Partial<ScrapedMatch>>>();
const leagueScoreboardCache = new Map<string, LeagueScoreboardCacheEntry>();
const leagueNameRegistry = new Map<string, string>();
const hostCooldownUntil = new Map<string, number>();
let catalogCache: CacheEntry<string[]> | null = null;
let catalogInflight: Promise<string[]> | null = null;
let bbcCache: CacheEntry<Map<string, string>> | null = null;

async function fetchEspnJson(pathAndQuery: string): Promise<{ ok: boolean; status: number; data: any }> {
  const now = Date.now();
  const hosts = [...ESPN_SITE_HOSTS].sort((a, b) => {
    const aCooling = (hostCooldownUntil.get(a) ?? 0) > now ? 1 : 0;
    const bCooling = (hostCooldownUntil.get(b) ?? 0) > now ? 1 : 0;
    return aCooling - bCooling;
  });

  let lastStatus = 502;
  for (const host of hosts) {
    try {
      const res = await fetchWithTimeout(`${host}${pathAndQuery}`, true);
      lastStatus = res.status;
      if (res.status === 403 || res.status === 429) {
        hostCooldownUntil.set(host, Date.now() + 45_000);
        continue;
      }
      if (!res.ok) continue;
      const text = await res.text();
      if (!text || text.trimStart().startsWith('<')) {
        hostCooldownUntil.set(host, Date.now() + 45_000);
        continue;
      }
      return { ok: true, status: res.status, data: JSON.parse(text) };
    } catch {
      // Try secondary ESPN API host
    }
  }
  return { ok: false, status: lastStatus, data: null };
}

/**
 * Discovers all soccer league slugs registered in ESPN's core catalog (~220 leagues).
 * Cached for 6 hours; returns `[]` cleanly if the catalog endpoint is unreachable.
 */
async function fetchEspnLeagueCatalog(): Promise<string[]> {
  const now = Date.now();
  if (catalogCache && catalogCache.expiresAt > now) {
    return catalogCache.data;
  }
  if (catalogInflight) return catalogInflight;

  catalogInflight = (async () => {
    try {
      const res = await fetchWithTimeout(
        'https://sports.core.api.espn.com/v2/sports/soccer/leagues?limit=500',
        true
      );
      if (!res.ok) return [];
      const text = await res.text();
      if (!text || text.trimStart().startsWith('<')) return [];
      const parsed = JSON.parse(text) as { items?: { $ref?: string }[] };
      const slugs: string[] = [];
      const seen = new Set<string>();
      for (const item of parsed.items || []) {
        const match = String(item?.$ref || '').match(/\/leagues\/([^/?]+)/);
        const slug = match?.[1]?.trim();
        if (slug && /^[a-z0-9._-]{1,48}$/i.test(slug) && !seen.has(slug)) {
          seen.add(slug);
          slugs.push(slug);
        }
      }
      if (slugs.length > 0) {
        catalogCache = { expiresAt: Date.now() + 6 * 3_600_000, data: slugs };
      }
      return slugs;
    } catch {
      return [];
    } finally {
      catalogInflight = null;
    }
  })();

  return catalogInflight;
}

export async function listEspnLeagues(): Promise<EspnLeagueInfo[]> {
  const catalog = await fetchEspnLeagueCatalog();
  const slugs = new Set<string>([...catalog, ...leagueNameRegistry.keys(), ...Object.keys(KNOWN_LEAGUE_NAMES)]);
  const list: EspnLeagueInfo[] = [];
  for (const slug of slugs) {
    const name = leagueNameRegistry.get(slug) || KNOWN_LEAGUE_NAMES[slug] || formatSlugFallback(slug);
    list.push({ slug, name });
  }
  list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
}

export function normalizeTeamName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(fc|cf|sc|afc|ac|as|fk|bk|united|city|town)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

export function parseMinute(displayClock: string | undefined, clockVal: number | undefined, state: MatchLifecycleState): number {
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

export function classifyPlayType(
  playType: string | undefined,
  text: string
): MatchEventType {
  const pt = (playType || '').toLowerCase();
  const tx = text.toLowerCase();

  // Goal kicks and goalkeeper plays must never be read as goals.
  if (/goal[-_ ]?kick/.test(pt) || tx.startsWith('goal kick')) {
    return 'other';
  }
  if (
    /(^|[^a-z])goal($|[^a-z])/.test(pt) ||
    pt.includes('penalty---scored') ||
    tx.startsWith('goal!')
  ) {
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

export function resolveTeamSide(
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

export function parseBoxscoreStats(statsArr: any[] | undefined): Partial<TeamMatchStats> {
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

export function parseLastFiveForm(lastFiveEntry: any): {
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

export function parseScrapedOdds(oddsArr: any[] | undefined, state: MatchLifecycleState): ScrapedOdds | null {
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
    const res = await fetchWithTimeout('https://www.bbc.com/sport/football/scores-fixtures');
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

  const espnResp = await fetchEspnJson(
    `/apis/site/v2/sports/soccer/all/summary?event=${encodeURIComponent(match.id)}`
  );
  if (!espnResp.ok || !espnResp.data) return {};
  const data = espnResp.data;

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

export function parseScoreboardEvent(
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
  const resolvedSlug = leagueInfo?.slug || leagueSlugFromLinks || String(ev.season?.slug || 'soccer');
  const leagueName =
    ev.league?.name ||
    leagueInfo?.name ||
    leagueNameRegistry.get(resolvedSlug) ||
    KNOWN_LEAGUE_NAMES[leagueSlugFromLinks.toLowerCase()] ||
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
    leagueSlug: resolvedSlug,
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

export interface ScoreboardResult {
  matches: ScrapedMatch[];
  sources: {
    espnCount: number;
    bbcCrossCheckedCount: number;
    scrapedAt: string;
    leagueCount?: number;
  };
}

export interface ScoreboardOptions {
  dateYyyymmdd?: string;
  league?: string;
  allLeagues?: boolean;
  enrichLimit?: number;
  onlyFinished?: boolean;
}

/** Test helper: clears module-level caches so tests do not leak state. */
export function __resetScraperCachesForTests() {
  scoreboardCache.clear();
  scoreboardInflight.clear();
  summaryCache.clear();
  leagueScoreboardCache.clear();
  leagueNameRegistry.clear();
  hostCooldownUntil.clear();
  catalogCache = null;
  catalogInflight = null;
  bbcCache = null;
}

function extractLeaguesMeta(json: any, fallbackSlug?: string): Map<string, { name: string; slug: string }> {
  const map = new Map<string, { name: string; slug: string }>();
  if (Array.isArray(json?.leagues)) {
    for (const lg of json.leagues) {
      const slug = lg.slug ? String(lg.slug) : fallbackSlug || '';
      const name = lg.name ? String(lg.name) : '';
      if (slug && name) {
        map.set(slug, { name, slug });
        leagueNameRegistry.set(slug, name);
      }
      if (lg.id && name) {
        map.set(String(lg.id), { name, slug });
      }
    }
  }
  return map;
}

async function fetchSingleLeagueScoreboard(
  slug: string,
  dateYyyymmdd?: string
): Promise<LeagueScoreboardCacheEntry | null> {
  const cacheKey = `${slug}_${dateYyyymmdd || 'current'}`;
  const now = Date.now();
  const cached = leagueScoreboardCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached;
  }

  const query = dateYyyymmdd ? `?dates=${encodeURIComponent(dateYyyymmdd)}` : '';
  const resp = await fetchEspnJson(
    `/apis/site/v2/sports/soccer/${encodeURIComponent(slug)}/scoreboard${query}`
  );
  if (!resp.ok || !resp.data) {
    // Preserve stale cached data on transient errors so a single rate-limit blip doesn't drop leagues
    return cached ?? null;
  }

  const events = Array.isArray(resp.data.events) ? resp.data.events : [];
  const leaguesMeta = extractLeaguesMeta(resp.data, slug);
  const leagueName = resp.data.leagues?.[0]?.name ? String(resp.data.leagues[0].name) : null;

  // Refresh active/live/imminent leagues every 20s; quiet or historical leagues stay cached longer
  const hasLiveOrImminent = events.some((ev: any) => {
    const st = ev.status?.type?.state;
    if (st === 'in') return true;
    const startMs = Date.parse(String(ev.date || ''));
    return Number.isFinite(startMs) && Math.abs(startMs - now) <= 3 * 3_600_000;
  });

  const ttl = dateYyyymmdd
    ? 10 * 60_000
    : hasLiveOrImminent
    ? 20_000
    : 5 * 60_000;

  const entry: LeagueScoreboardCacheEntry = {
    expiresAt: now + ttl,
    leagueSlug: slug,
    leagueName,
    events,
    leaguesMeta,
  };
  leagueScoreboardCache.set(cacheKey, entry);
  return entry;
}

export function scrapeScoreboardMatches(options?: ScoreboardOptions): Promise<ScoreboardResult> {
  // The enrichment depth and league scope are part of the key. Without them, a shallow
  // call could populate the cache and subsequent enriched requests would lack stats/events.
  const enrichLimit = options?.enrichLimit ?? 22;
  const leagueKey = options?.league || (options?.allLeagues ? 'all_leagues' : 'all');
  const cacheKey = `${options?.dateYyyymmdd || 'live'}_${leagueKey}_${options?.onlyFinished ? 'post' : 'all'}_e${enrichLimit}`;

  const cached = scoreboardCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    const leagueSet = new Set(cached.data.map((m) => m.league));
    return Promise.resolve({
      matches: cached.data,
      sources: {
        espnCount: cached.data.length,
        bbcCrossCheckedCount: cached.data.filter((m) => m.bbcCrossCheck.matched).length,
        scrapedAt: new Date().toISOString(),
        leagueCount: leagueSet.size,
      },
    });
  }

  // Collapse concurrent cache misses into one upstream scrape.
  const pending = scoreboardInflight.get(cacheKey);
  if (pending) return pending;

  const run = runScoreboardScrape(cacheKey, { ...options, enrichLimit }).finally(() => {
    scoreboardInflight.delete(cacheKey);
  });
  scoreboardInflight.set(cacheKey, run);
  return run;
}

async function runScoreboardScrape(
  cacheKey: string,
  options: ScoreboardOptions & { enrichLimit: number }
): Promise<ScoreboardResult> {
  const now = Date.now();
  const ttl = options.dateYyyymmdd ? 180_000 : 15_000;
  const specificLeague =
    options.league && options.league !== 'all' ? options.league.trim() : undefined;

  const scoreboardPath = specificLeague
    ? `/apis/site/v2/sports/soccer/${encodeURIComponent(specificLeague)}/scoreboard${
        options.dateYyyymmdd ? `?dates=${encodeURIComponent(options.dateYyyymmdd)}` : ''
      }`
    : `/apis/site/v2/sports/soccer/all/scoreboard${
        options.dateYyyymmdd ? `?dates=${encodeURIComponent(options.dateYyyymmdd)}` : ''
      }`;

  const [espnResp, bbcScores, catalogSlugs] = await Promise.all([
    fetchEspnJson(scoreboardPath),
    options.dateYyyymmdd ? Promise.resolve(new Map<string, string>()) : scrapeBbcScoreCrossCheck(),
    options.allLeagues && !specificLeague ? fetchEspnLeagueCatalog() : Promise.resolve([] as string[]),
  ]);

  if (!espnResp.ok || !espnResp.data) {
    throw new Error(`ESPN scoreboard scrape failed with HTTP ${espnResp.status}`);
  }

  const json = espnResp.data;
  const baseLookup = extractLeaguesMeta(json, specificLeague);
  const byId = new Map<string, ScrapedMatch>();

  const ingestEvents = (
    rawEvents: any[],
    lookup: Map<string, { name: string; slug: string }>,
    overrideLeague?: { slug: string; name: string | null },
    applyActiveWindowFilter = false
  ) => {
    const minWindowMs = now - 36 * 3_600_000;
    const maxWindowMs = now + 72 * 3_600_000;

    for (const ev of rawEvents) {
      const m = parseScoreboardEvent(ev, bbcScores, lookup);
      if (!m) continue;

      if (overrideLeague) {
        if (overrideLeague.name && !ev.league?.name) {
          m.league = overrideLeague.name;
        }
        m.leagueSlug = overrideLeague.slug;
      }

      if (applyActiveWindowFilter && m.state !== 'in') {
        const startMs = Date.parse(m.startDate);
        if (Number.isFinite(startMs) && (startMs < minWindowMs || startMs > maxWindowMs)) {
          continue;
        }
      }

      const prev = byId.get(m.id);
      if (!prev) {
        byId.set(m.id, m);
      } else {
        // Prefer richer canonical league title over generic fallback
        const betterLeague =
          prev.league === 'Global Soccer' || prev.league === prev.leagueSlug
            ? m.league
            : prev.league;
        const betterSlug = prev.leagueSlug === 'soccer' ? m.leagueSlug : prev.leagueSlug;
        byId.set(m.id, {
          ...prev,
          league: betterLeague,
          leagueSlug: betterSlug,
          scrapedOdds: prev.scrapedOdds || m.scrapedOdds,
        });
      }
    }
  };

  const specificLeagueOverride = specificLeague
    ? {
        slug: specificLeague,
        name:
          (json.leagues?.[0]?.name ? String(json.leagues[0].name) : null) ||
          KNOWN_LEAGUE_NAMES[specificLeague] ||
          null,
      }
    : undefined;
  ingestEvents(Array.isArray(json.events) ? json.events : [], baseLookup, specificLeagueOverride, false);

  // Expand across all discovered ESPN leagues (paced in gentle chunks with per-league TTLs)
  if (options.allLeagues && !specificLeague && catalogSlugs.length > 0) {
    const targetSlugs = options.dateYyyymmdd
      ? catalogSlugs.filter((s) => CORE_HISTORICAL_SLUGS.includes(s)).slice(0, 50)
      : catalogSlugs;

    const batchSize = 18;
    for (let i = 0; i < targetSlugs.length; i += batchSize) {
      const slice = targetSlugs.slice(i, i + batchSize);
      const anyUncached = slice.some((s) => {
        const cached = leagueScoreboardCache.get(`${s}_${options.dateYyyymmdd || 'current'}`);
        return !cached || cached.expiresAt <= Date.now();
      });

      const entries = await runWithConcurrency(
        slice.map((slug) => () => fetchSingleLeagueScoreboard(slug, options.dateYyyymmdd)),
        6
      );

      for (const entry of entries) {
        if (!entry) continue;
        ingestEvents(
          entry.events,
          entry.leaguesMeta,
          { slug: entry.leagueSlug, name: entry.leagueName },
          !options.dateYyyymmdd
        );
      }

      if (anyUncached && i + batchSize < targetSlugs.length) {
        await new Promise((r) => setTimeout(r, 75));
      }
    }
  }

  let matches = Array.from(byId.values());

  if (options.onlyFinished) {
    matches = matches.filter((m) => m.state === 'post');
  }

  // Sort: live ('in') first, then upcoming ('pre') by soonest, then finished ('post') most recent first
  matches.sort((a, b) => {
    const rank: Record<MatchLifecycleState, number> = { in: 0, pre: 1, post: 2 };
    if (rank[a.state] !== rank[b.state]) return rank[a.state] - rank[b.state];
    const ta = new Date(a.startDate).getTime();
    const tb = new Date(b.startDate).getTime();
    return a.state === 'post' ? tb - ta : ta - tb;
  });

  // Always enrich all active live matches (up to 36) plus remaining fixtures up to enrichLimit
  const enrichLimit = options.enrichLimit ?? 22;
  const liveCount = matches.filter((m) => m.state === 'in').length;
  const effectiveEnrichCount =
    enrichLimit === 0 ? 0 : Math.max(enrichLimit, Math.min(36, liveCount));
  const toEnrich = matches.slice(0, effectiveEnrichCount);

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
  const leagueSet = new Set(matches.map((m) => m.league));

  return {
    matches,
    sources: {
      espnCount: matches.length,
      bbcCrossCheckedCount: matches.filter((m) => m.bbcCrossCheck.matched).length,
      scrapedAt: new Date().toISOString(),
      leagueCount: leagueSet.size,
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

  const espnResp = await fetchEspnJson(
    `/apis/site/v2/sports/soccer/all/summary?event=${encodeURIComponent(matchId)}`
  );
  if (!espnResp.ok || !espnResp.data) return null;
  const data = espnResp.data;
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
