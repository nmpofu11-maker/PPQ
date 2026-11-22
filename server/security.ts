import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { DetectedTrendSignal, MarketCategory, TrendPatternType } from '../src/types/soccer';
import type { TacticalBriefInput } from './aiAlerts';

/* -------------------------------------------------------------------------- */
/* Rate limiting (in-memory sliding window; per-process, no extra dependency)  */
/* -------------------------------------------------------------------------- */

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Bucket name so different routes keep independent counters. */
  name: string;
  keyFn?: (req: Request) => string;
  now?: () => number;
}

export function clientKey(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

export function createRateLimiter(opts: RateLimitOptions) {
  const hits = new Map<string, number[]>();
  const now = opts.now ?? Date.now;
  const keyFn = opts.keyFn ?? clientKey;

  const sweep = setInterval(() => {
    const cutoff = now() - opts.windowMs;
    for (const [k, stamps] of hits) {
      const fresh = stamps.filter((t) => t > cutoff);
      if (fresh.length === 0) hits.delete(k);
      else hits.set(k, fresh);
    }
  }, Math.max(10_000, opts.windowMs));
  sweep.unref();

  return function rateLimit(req: Request, res: Response, next: NextFunction) {
    const key = `${opts.name}:${keyFn(req)}`;
    const t = now();
    const cutoff = t - opts.windowMs;
    const stamps = (hits.get(key) ?? []).filter((s) => s > cutoff);
    if (stamps.length >= opts.max) {
      const retryAfterSec = Math.max(1, Math.ceil((stamps[0] + opts.windowMs - t) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json({ error: 'Too many requests. Please slow down.' });
      return;
    }
    stamps.push(t);
    hits.set(key, stamps);
    next();
  };
}

/* -------------------------------------------------------------------------- */
/* Web Push endpoint allowlist (prevents the server being used for SSRF)       */
/* -------------------------------------------------------------------------- */

const PUSH_HOST_EXACT = new Set([
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
]);

const PUSH_HOST_SUFFIXES = [
  '.push.services.mozilla.com',
  '.notify.windows.com',
  '.push.apple.com',
];

function extraAllowedHosts(): string[] {
  return (process.env.PUSH_ENDPOINT_ALLOWLIST || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Only well-known browser push services are accepted. The server will POST to
 * whatever endpoint a subscriber registers, so accepting arbitrary https URLs
 * would let anyone aim the server at arbitrary hosts (blind SSRF).
 */
export function isAllowedPushEndpoint(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  if (url.port && url.port !== '443') return false;

  const host = url.hostname.toLowerCase();
  if (PUSH_HOST_EXACT.has(host)) return true;
  if (PUSH_HOST_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length)) return true;
  return extraAllowedHosts().some((h) => host === h || host.endsWith(`.${h}`));
}

/* -------------------------------------------------------------------------- */
/* Firebase ID token verification (no firebase-admin dependency)               */
/* -------------------------------------------------------------------------- */

export interface VerifiedUser {
  uid: string;
  emailVerified: boolean;
}

export type TokenVerifier = (idToken: string) => Promise<VerifiedUser | null>;

/**
 * Verifies a Firebase ID token through the Identity Toolkit `accounts:lookup`
 * REST endpoint, using the web API key already shipped to clients.
 * Successful lookups are cached briefly to avoid a network call per request.
 */
export function createFirebaseTokenVerifier(opts: {
  apiKey: string;
  fetchImpl?: typeof fetch;
  cacheMs?: number;
  now?: () => number;
}): TokenVerifier {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const cacheMs = opts.cacheMs ?? 5 * 60_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { user: VerifiedUser; expiresAt: number }>();

  return async (idToken: string) => {
    if (!idToken || idToken.length > 4096) return null;
    const cacheKey = crypto.createHash('sha256').update(idToken).digest('hex');
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > now()) return cached.user;

    try {
      const res = await fetchImpl(
        `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(opts.apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken }),
          signal: AbortSignal.timeout(8_000),
        }
      );
      if (!res.ok) return null;
      const data = (await res.json()) as {
        users?: { localId?: string; emailVerified?: boolean }[];
      };
      const u = data.users?.[0];
      if (!u?.localId) return null;
      const user: VerifiedUser = { uid: u.localId, emailVerified: Boolean(u.emailVerified) };
      cache.set(cacheKey, { user, expiresAt: now() + cacheMs });
      if (cache.size > 500) {
        const oldest = cache.keys().next().value;
        if (oldest) cache.delete(oldest);
      }
      return user;
    } catch {
      return null;
    }
  };
}

export function bearerToken(req: Request): string {
  const header = req.headers.authorization || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

/* -------------------------------------------------------------------------- */
/* Usage budget (protects the Gemini key from abuse)                           */
/* -------------------------------------------------------------------------- */

export function createDailyBudget(opts: {
  globalLimit: number;
  perUserLimit: number;
  now?: () => number;
}) {
  const now = opts.now ?? Date.now;
  let day = '';
  let globalCount = 0;
  const perUser = new Map<string, number>();

  function roll() {
    const today = new Date(now()).toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      globalCount = 0;
      perUser.clear();
    }
  }

  return {
    /** Returns true and consumes one unit if budget remains. */
    tryConsume(uid: string): boolean {
      roll();
      if (globalCount >= opts.globalLimit) return false;
      if ((perUser.get(uid) ?? 0) >= opts.perUserLimit) return false;
      globalCount += 1;
      perUser.set(uid, (perUser.get(uid) ?? 0) + 1);
      return true;
    },
    /** Hand a unit back when the upstream call failed through no fault of the user. */
    refund(uid: string) {
      roll();
      globalCount = Math.max(0, globalCount - 1);
      perUser.set(uid, Math.max(0, (perUser.get(uid) ?? 1) - 1));
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Input sanitisation for the tactical-brief route                             */
/* -------------------------------------------------------------------------- */

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
}

function num(v: unknown, min: number, max: number): number | null {
  const n = typeof v === 'number' ? v : Number.NaN;
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

function prob(v: unknown): number | null {
  return num(v, 0, 1);
}

const PATTERNS: TrendPatternType[] = [
  'Persistent Attack Surge',
  'Shots-on-Goal Barrage',
  'Set-Piece Siege',
  'Manpower Counter-Press',
];

const MARKETS: MarketCategory[] = [
  'Match Winner (1X2)',
  'Double Chance',
  'Over / Under Goals',
  'Asian Handicap / Spread',
  'Next Team to Score',
] as MarketCategory[];

/** Returns a clean, bounded payload, or null if the body is not a valid brief request. */
export function sanitizeTacticalBriefInput(body: unknown): TacticalBriefInput | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const t = b.trend as Record<string, unknown> | undefined;
  if (!t || typeof t !== 'object') return null;

  const id = str(t.id, 160);
  const matchId = str(t.matchId, 64);
  const homeTeam = str(b.homeTeam, 120);
  const awayTeam = str(b.awayTeam, 120);
  if (!id || !matchId || !homeTeam || !awayTeam) return null;

  const probs = {
    nextGoalHomeProb: prob(b.nextGoalHomeProb),
    nextGoalAwayProb: prob(b.nextGoalAwayProb),
    winHomeProb: prob(b.winHomeProb),
    drawProb: prob(b.drawProb),
    winAwayProb: prob(b.winAwayProb),
  };
  if (Object.values(probs).some((p) => p === null)) return null;

  const minute = num(t.minute, 0, 130);
  const windowMinutes = num(t.windowMinutes, 1, 30);
  const recentShots = num(t.recentShots, 0, 100);
  const recentShotsOnTarget = num(t.recentShotsOnTarget, 0, 100);
  const recentCorners = num(t.recentCorners, 0, 100);
  const consecutive = num(t.consecutiveMomentumMinutes, 0, 130);
  if (
    minute === null ||
    windowMinutes === null ||
    recentShots === null ||
    recentShotsOnTarget === null ||
    recentCorners === null ||
    consecutive === null
  ) {
    return null;
  }

  const commentary = Array.isArray(t.recentCommentary)
    ? t.recentCommentary.map((c) => str(c, 240)).filter(Boolean).slice(0, 8)
    : [];

  const patterns = Array.isArray(t.patterns)
    ? (t.patterns.filter((p) => PATTERNS.includes(p as TrendPatternType)) as TrendPatternType[])
    : [];

  const market = MARKETS.includes(t.recommendedMarket as MarketCategory)
    ? (t.recommendedMarket as MarketCategory)
    : ('Next Team to Score' as MarketCategory);

  const trend: DetectedTrendSignal = {
    id,
    matchId,
    league: str(t.league, 120),
    matchTitle: str(t.matchTitle, 260),
    minute,
    scoreline: str(t.scoreline, 20),
    teamSide: t.teamSide === 'away' ? 'away' : 'home',
    teamName: str(t.teamName, 120),
    patterns,
    patternLabel: str(t.patternLabel, 160),
    windowMinutes,
    recentShots,
    recentShotsOnTarget,
    recentCorners,
    consecutiveMomentumMinutes: consecutive,
    intensityScore: num(t.intensityScore, 0, 1000) ?? 0,
    recommendedMarket: market,
    recommendedSelection: str(t.recommendedSelection, 160),
    modelProbability: prob(t.modelProbability) ?? 0,
    recentCommentary: commentary,
  };

  return {
    trend,
    homeTeam,
    awayTeam,
    possessionHome: num(b.possessionHome, 0, 100),
    possessionAway: num(b.possessionAway, 0, 100),
    shotsHome: str(b.shotsHome, 40),
    shotsAway: str(b.shotsAway, 40),
    nextGoalHomeProb: probs.nextGoalHomeProb as number,
    nextGoalAwayProb: probs.nextGoalAwayProb as number,
    winHomeProb: probs.winHomeProb as number,
    drawProb: probs.drawProb as number,
    winAwayProb: probs.winAwayProb as number,
  };
}
