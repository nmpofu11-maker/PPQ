import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetScraperCachesForTests,
  classifyPlayType,
  listEspnLeagues,
  parseLastFiveForm,
  parseMinute,
  parseScoreboardEvent,
  parseScrapedOdds,
  resolveTeamSide,
  scrapeScoreboardMatches,
  scrapeSingleMatchDetails,
} from './scraper';

/* ------------------------------ pure parsers ------------------------------ */

test('classifyPlayType: goals, but never goal kicks or goalkeeper plays', () => {
  assert.equal(classifyPlayType('goal', 'Goal! Arsenal 1, Chelsea 0.'), 'goal');
  assert.equal(classifyPlayType('goal---header', 'Goal!'), 'goal');
  assert.equal(classifyPlayType('penalty---scored', 'Penalty scored'), 'goal');
  assert.equal(classifyPlayType(undefined, 'Goal! Arsenal 1, Chelsea 0.'), 'goal');

  assert.equal(classifyPlayType('goal-kick', 'Goal kick for Chelsea.'), 'other');
  assert.equal(classifyPlayType('goal_kick', 'x'), 'other');
  assert.equal(classifyPlayType(undefined, 'Goal kick awarded to Chelsea.'), 'other');
  assert.notEqual(classifyPlayType('goalkeeper-save', 'Save by the keeper'), 'goal');
  assert.notEqual(classifyPlayType('goalkeeper-distribution', 'x'), 'goal');
});

test('classifyPlayType: other event families', () => {
  assert.equal(classifyPlayType('red-card', 'x'), 'red_card');
  assert.equal(classifyPlayType('yellow-card', 'x'), 'yellow_card');
  assert.equal(classifyPlayType('corner-kick', 'x'), 'corner');
  assert.equal(classifyPlayType(undefined, 'Attempt saved in the bottom left corner.'), 'shot_on_target');
  assert.equal(classifyPlayType(undefined, 'Attempt missed. Wide.'), 'shot_off_target');
  assert.equal(classifyPlayType('substitution', 'x'), 'substitution');
  assert.equal(classifyPlayType('something-else', 'x'), 'other');
});

test('parseMinute handles stoppage time, HT/FT, clock seconds and pre-match', () => {
  assert.equal(parseMinute("45'+2'", undefined, 'in'), 47);
  assert.equal(parseMinute('HT', undefined, 'in'), 45);
  assert.equal(parseMinute("62'", undefined, 'in'), 62);
  assert.equal(parseMinute(undefined, 3600, 'in'), 60);
  assert.equal(parseMinute("12'", undefined, 'pre'), 0);
  assert.equal(parseMinute("120'", undefined, 'in'), 95);
  assert.equal(parseMinute('', undefined, 'post'), 90);
});

test('resolveTeamSide matches by normalised team name and by commentary text', () => {
  assert.equal(resolveTeamSide('Arsenal FC', 'x', 'Arsenal', 'Chelsea'), 'home');
  assert.equal(resolveTeamSide('Chelsea', 'x', 'Arsenal', 'Chelsea'), 'away');
  assert.equal(resolveTeamSide(undefined, 'Corner, Chelsea. Conceded by X', 'Arsenal', 'Chelsea'), 'away');
  assert.equal(resolveTeamSide(undefined, 'Nothing relevant', 'Arsenal', 'Chelsea'), 'neutral');
});

test('parseLastFiveForm weights recent results more and stays in [-1, 1]', () => {
  const allWins = parseLastFiveForm({
    events: Array.from({ length: 5 }, () => ({ gameResult: 'W', homeTeamScore: 3, awayTeamScore: 0, score: '3-0' })),
  });
  assert.ok(allWins.formScore !== null && allWins.formScore > 0.9 && allWins.formScore <= 1);
  const recentLossOldWins = parseLastFiveForm({
    events: [
      { gameResult: 'L', homeTeamScore: 0, awayTeamScore: 1 },
      { gameResult: 'W', homeTeamScore: 1, awayTeamScore: 0 },
      { gameResult: 'W', homeTeamScore: 1, awayTeamScore: 0 },
    ],
  });
  const recentWinOldLoss = parseLastFiveForm({
    events: [
      { gameResult: 'W', homeTeamScore: 1, awayTeamScore: 0 },
      { gameResult: 'W', homeTeamScore: 1, awayTeamScore: 0 },
      { gameResult: 'L', homeTeamScore: 0, awayTeamScore: 1 },
    ],
  });
  assert.ok((recentWinOldLoss.formScore ?? 0) > (recentLossOldWins.formScore ?? 0));
  assert.deepEqual(parseLastFiveForm(undefined), { formScore: null, lastFiveSummary: [] });
});

test('parseScrapedOdds prefers live odds for in-play matches and flags them live', () => {
  const odds = [
    {
      provider: { name: 'DraftKings' },
      moneyline: {
        home: { live: { odds: '+150' }, close: { odds: '+120' } },
        draw: { close: { odds: '+230' } },
        away: { close: { odds: '+210' } },
      },
      total: { over: { close: { odds: '-110', line: 'o2.5' } }, under: { close: { odds: '-110' } } },
    },
  ];
  const live = parseScrapedOdds(odds, 'in');
  assert.equal(live?.isLive, true);
  assert.equal(live?.homeMoneyline, '+150');
  assert.equal(live?.totalLine, 2.5);
  const pre = parseScrapedOdds(odds, 'pre');
  assert.equal(pre?.isLive, false);
  assert.equal(pre?.homeMoneyline, '+120');
  assert.equal(parseScrapedOdds([], 'in'), null);
});

test('parseScoreboardEvent builds a match and tolerates sparse payloads', () => {
  const m = parseScoreboardEvent(scoreboardEvent('777'), new Map(), new Map());
  assert.ok(m);
  assert.equal(m.homeTeam, 'Arsenal');
  assert.equal(m.awayTeam, 'Chelsea');
  assert.equal(m.state, 'in');
  assert.equal(m.minute, 62);
  assert.equal(m.homeScore, 1);
  assert.equal(parseScoreboardEvent({ id: '1' }, new Map(), new Map()), null);
});

/* --------------------- caching / de-duplication (fetch stub) --------------------- */

function scoreboardEvent(id: string) {
  return {
    id,
    uid: `s:600~l:700~e:${id}`,
    date: '2026-11-21T15:00:00Z',
    season: { slug: 'eng.1' },
    status: { clock: 3720, displayClock: "62'", type: { state: 'in', shortDetail: "62'" } },
    competitions: [
      {
        competitors: [
          { homeAway: 'home', score: '1', team: { displayName: 'Arsenal', abbreviation: 'ARS' } },
          { homeAway: 'away', score: '0', team: { displayName: 'Chelsea', abbreviation: 'CHE' } },
        ],
      },
    ],
  };
}

function summaryPayload() {
  return {
    header: { league: { name: 'English Premier League', slug: 'eng.1' } },
    boxscore: {
      teams: [
        {
          homeAway: 'home',
          team: { displayName: 'Arsenal' },
          statistics: [
            { name: 'shotsOnTarget', displayValue: '5' },
            { name: 'totalShots', displayValue: '11' },
            { name: 'possessionPct', displayValue: '58' },
          ],
        },
        {
          homeAway: 'away',
          team: { displayName: 'Chelsea' },
          statistics: [{ name: 'shotsOnTarget', displayValue: '1' }],
        },
      ],
    },
    commentary: [
      {
        text: 'Attempt saved. Saka (Arsenal) right footed shot is saved.',
        time: { displayValue: "60'" },
        play: { type: { type: 'shot-on-target' }, team: { displayName: 'Arsenal' } },
      },
    ],
  };
}

const realFetch = globalThis.fetch;
let counts: { scoreboard: number; summary: number };

beforeEach(() => {
  __resetScraperCachesForTests();
  counts = { scoreboard: 0, summary: 0 };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('bbc.com')) return new Response('', { status: 404 });
    if (url.includes('/scoreboard')) {
      counts.scoreboard += 1;
      await new Promise((r) => setTimeout(r, 15)); // widen the window for concurrent callers
      return new Response(JSON.stringify({ leagues: [], events: [scoreboardEvent('777')] }), { status: 200 });
    }
    if (url.includes('/summary')) {
      counts.summary += 1;
      return new Response(JSON.stringify(summaryPayload()), { status: 200 });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('regression: a shallow (enrichLimit 0) scrape must not poison the enriched live cache', async () => {
  const shallow = await scrapeScoreboardMatches({ enrichLimit: 0 });
  assert.equal(shallow.matches[0].hasDetailedFlow, false);

  const full = await scrapeScoreboardMatches({ enrichLimit: 24 });
  assert.equal(full.matches[0].hasDetailedFlow, true, 'enriched request must not receive the shallow cache entry');
  assert.equal(full.matches[0].homeStats.shotsOnTarget, 5);
  assert.ok(full.matches[0].events.length > 0);
});

test('single-match details no longer corrupt a later /matches/live result', async () => {
  const detail = await scrapeSingleMatchDetails('777');
  assert.ok(detail && detail.homeStats.shotsOnTarget === 5);
  const live = await scrapeScoreboardMatches({ enrichLimit: 24 });
  assert.equal(live.matches[0].hasDetailedFlow, true);
});

test('concurrent identical requests share a single upstream scrape', async () => {
  const [a, b, c] = await Promise.all([
    scrapeScoreboardMatches({ enrichLimit: 24 }),
    scrapeScoreboardMatches({ enrichLimit: 24 }),
    scrapeScoreboardMatches({ enrichLimit: 24 }),
  ]);
  assert.equal(counts.scoreboard, 1);
  assert.equal(a.matches.length, 1);
  assert.equal(b.matches.length, 1);
  assert.equal(c.matches.length, 1);

  await scrapeScoreboardMatches({ enrichLimit: 24 });
  assert.equal(counts.scoreboard, 1, 'subsequent call is served from cache');
});

test('a failed upstream scrape is not cached and is retried', async () => {
  let fail = true;
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (fail && String(input).includes('/scoreboard')) return new Response('', { status: 500 });
    return inner(input, init);
  }) as typeof fetch;

  await assert.rejects(scrapeScoreboardMatches({ enrichLimit: 0 }), /HTTP 500/);
  fail = false;
  const ok = await scrapeScoreboardMatches({ enrichLimit: 0 });
  assert.equal(ok.matches.length, 1);
});

test('allLeagues discovers catalog slugs, merges leagues, filters out-of-window undated fixtures, and lists leagues', async () => {
  const nowIso = new Date().toISOString();
  const farFutureIso = new Date(Date.now() + 20 * 86_400_000).toISOString();
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('sports.core.api.espn.com/v2/sports/soccer/leagues')) {
      return new Response(
        JSON.stringify({
          items: [
            { $ref: 'http://sports.core.api.espn.com/v2/sports/soccer/leagues/eng.1?lang=en' },
            { $ref: 'http://sports.core.api.espn.com/v2/sports/soccer/leagues/bra.1?lang=en' },
          ],
        }),
        { status: 200 }
      );
    }
    if (url.includes('/soccer/bra.1/scoreboard')) {
      return new Response(
        JSON.stringify({
          leagues: [{ id: '85', name: 'Brazilian Serie A', slug: 'bra.1' }],
          events: [
            {
              ...scoreboardEvent('888'),
              date: nowIso,
              season: { slug: '2026-season' },
            },
            {
              ...scoreboardEvent('999'),
              date: farFutureIso,
              status: { clock: 0, displayClock: '00:00', type: { state: 'pre', shortDetail: 'Pre' } },
            },
          ],
        }),
        { status: 200 }
      );
    }
    return inner(input, init);
  }) as typeof fetch;

  const res = await scrapeScoreboardMatches({ allLeagues: true, enrichLimit: 0 });
  const ids = res.matches.map((m) => m.id).sort();
  assert.deepEqual(ids, ['777', '888']);
  const braMatch = res.matches.find((m) => m.id === '888');
  assert.equal(braMatch?.league, 'Brazilian Serie A');
  assert.equal(braMatch?.leagueSlug, 'bra.1');
  assert.ok((res.sources.leagueCount ?? 0) >= 2);

  const catalog = await listEspnLeagues();
  assert.ok(catalog.some((l) => l.slug === 'bra.1' && l.name === 'Brazilian Serie A'));
});

test('fetchEspnJson fails over to secondary host when primary returns 403 HTML', async () => {
  const seenHosts: string[] = [];
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('site.api.espn.com')) {
      seenHosts.push('site.api');
      return new Response('<!doctype html><html>403 Forbidden</html>', {
        status: 403,
        headers: { 'content-type': 'text/html' },
      });
    }
    if (url.includes('site.web.api.espn.com')) {
      seenHosts.push('site.web.api');
    }
    return inner(input, init);
  }) as typeof fetch;

  const ok = await scrapeScoreboardMatches({ league: 'eng.1', enrichLimit: 0 });
  assert.equal(ok.matches.length, 1);
  assert.deepEqual(seenHosts, ['site.api', 'site.web.api']);
});
