import type { MatchEventItem, MatchEventType, ScrapedMatch, ScrapedOdds } from '../../types/soccer';

/** Small deterministic PRNG so fixtures are reproducible. */
export function seededRandom(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function liveOdds(overrides: Partial<ScrapedOdds> = {}): ScrapedOdds {
  return {
    provider: 'DraftKings',
    isLive: true,
    homeMoneyline: '+140',
    drawMoneyline: '+220',
    awayMoneyline: '+290',
    totalLine: 2.5,
    overOdds: '-120',
    underOdds: '+100',
    spreadLine: -0.5,
    homeSpreadOdds: '+135',
    awaySpreadOdds: '-160',
    ...overrides,
  };
}

/**
 * Generates a finished match from a simple known process in which a team's chance of
 * shooting, winning corners and scoring all scale with its attack strength. That plants a
 * real (but modest) signal for the pipeline tests to find.
 */
export function syntheticFinishedMatch(index: number, seed = 1): ScrapedMatch {
  const rand = seededRandom(seed * 100_003 + index);
  const attackHome = 0.7 + rand() * 0.9;
  const attackAway = 0.6 + rand() * 0.9;
  const events: MatchEventItem[] = [];
  let seq = 0;
  let homeGoals = 0;
  let awayGoals = 0;
  let hShots = 0;
  let aShots = 0;
  let hSot = 0;
  let aSot = 0;
  let hCorners = 0;
  let aCorners = 0;

  const push = (minute: number, side: 'home' | 'away', type: MatchEventType) => {
    seq += 1;
    events.push({
      id: `m${index}_e${seq}`,
      minute,
      clockDisplay: `${minute}'`,
      sequence: seq,
      teamSide: side,
      eventType: type,
      text: type,
    });
  };

  for (let minute = 1; minute <= 90; minute++) {
    for (const side of ['home', 'away'] as const) {
      const a = side === 'home' ? attackHome * 1.08 : attackAway;
      if (rand() < 0.07 * a) {
        const onTarget = rand() < 0.38;
        if (side === 'home') {
          hShots += 1;
          if (onTarget) hSot += 1;
        } else {
          aShots += 1;
          if (onTarget) aSot += 1;
        }
        if (onTarget && rand() < 0.3) {
          push(minute, side, 'goal');
          if (side === 'home') homeGoals += 1;
          else awayGoals += 1;
        } else {
          push(minute, side, onTarget ? 'shot_on_target' : 'shot_off_target');
        }
      }
      if (rand() < 0.05 * a) {
        push(minute, side, 'corner');
        if (side === 'home') hCorners += 1;
        else aCorners += 1;
      }
    }
  }

  const day = String(1 + Math.floor(index / 3)).padStart(3, '0');
  return {
    id: `synthetic_${seed}_${index}`,
    league: 'Synthetic League',
    leagueSlug: 'syn.1',
    startDate: `2026-${day.slice(0, 2).padStart(2, '0')}-${String((index % 27) + 1).padStart(2, '0')}T${String(10 + (index % 10)).padStart(2, '0')}:00:00Z`,
    state: 'post',
    minute: 90,
    statusText: 'FT',
    venue: null,
    homeTeam: `Home ${index % 12}`,
    homeAbbr: 'HOM',
    awayTeam: `Away ${(index + 5) % 12}`,
    awayAbbr: 'AWY',
    homeScore: homeGoals,
    awayScore: awayGoals,
    homeStats: {
      possessionPct: 50,
      totalShots: hShots,
      shotsOnTarget: hSot,
      wonCorners: hCorners,
      foulsCommitted: 0,
      yellowCards: 0,
      redCards: 0,
      offsides: 0,
      saves: 0,
      formScore: null,
      lastFiveSummary: [],
    },
    awayStats: {
      possessionPct: 50,
      totalShots: aShots,
      shotsOnTarget: aSot,
      wonCorners: aCorners,
      foulsCommitted: 0,
      yellowCards: 0,
      redCards: 0,
      offsides: 0,
      saves: 0,
      formScore: null,
      lastFiveSummary: [],
    },
    events,
    hasDetailedFlow: true,
    bbcCrossCheck: { matched: false, scoreLabel: null },
    scrapedOdds: null,
    lastUpdated: '2026-11-20T19:02:00Z',
  };
}

export function syntheticHistory(count: number, seed = 1): ScrapedMatch[] {
  // distinct, strictly increasing dates so chronological splits are well defined
  return Array.from({ length: count }, (_, i) => {
    const m = syntheticFinishedMatch(i, seed);
    const d = new Date(Date.UTC(2026, 0, 1) + i * 3_600_000 * 7);
    return { ...m, startDate: d.toISOString() };
  });
}
