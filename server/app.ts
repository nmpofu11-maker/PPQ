import express, { type NextFunction, type Request, type Response } from 'express';
import firebaseConfig from '../firebase-applet-config.json';
import { listEspnLeagues, scrapeScoreboardMatches, scrapeSingleMatchDetails } from './scraper';
import { generateTacticalBrief } from './aiAlerts';
import {
  PushService,
  sanitizeModelSnapshot,
  sanitizePreferences,
  validatePushSubscriptionInput,
} from './webPush';
import {
  bearerToken,
  createDailyBudget,
  createFirebaseTokenVerifier,
  createRateLimiter,
  sanitizeTacticalBriefInput,
  type TokenVerifier,
} from './security';

export interface AppDeps {
  push: PushService;
  scrapeScoreboard?: typeof scrapeScoreboardMatches;
  scrapeMatch?: typeof scrapeSingleMatchDetails;
  listLeagues?: typeof listEspnLeagues;
  generateBrief?: typeof generateTacticalBrief;
  verifyToken?: TokenVerifier;
  budget?: ReturnType<typeof createDailyBudget>;
  /** Express `trust proxy` setting. Set to the number of reverse-proxy hops in front of the app. */
  trustProxy?: boolean | number | string;
}

function intEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function createApp(deps: AppDeps) {
  const scrapeScoreboard = deps.scrapeScoreboard ?? scrapeScoreboardMatches;
  const scrapeMatch = deps.scrapeMatch ?? scrapeSingleMatchDetails;
  const listLeagues = deps.listLeagues ?? listEspnLeagues;
  const generateBrief = deps.generateBrief ?? generateTacticalBrief;
  const push = deps.push;

  const verifyToken =
    deps.verifyToken ??
    createFirebaseTokenVerifier({
      apiKey: (process.env.FIREBASE_API_KEY || '').trim() || firebaseConfig.apiKey,
    });
  const budget =
    deps.budget ??
    createDailyBudget({
      globalLimit: intEnv('AI_DAILY_LIMIT_GLOBAL', 300),
      perUserLimit: intEnv('AI_DAILY_LIMIT_PER_USER', 40),
    });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', deps.trustProxy ?? false);

  // Baseline hardening headers. (No frame-ancestors/CSP here: the app is embeddable
  // and Firebase sign-in needs third-party frames.)
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // The subscribe body may carry the learned model, so it gets a larger (still bounded) limit.
  app.use('/api/push/subscribe', express.json({ limit: '128kb' }));
  app.use(express.json({ limit: '32kb' }));

  const generalLimit = createRateLimiter({ name: 'api', windowMs: 60_000, max: 120 });
  const scrapeLimit = createRateLimiter({ name: 'scrape', windowMs: 60_000, max: 40 });
  const historyLimit = createRateLimiter({ name: 'history', windowMs: 60_000, max: 10 });
  const subscribeLimit = createRateLimiter({ name: 'subscribe', windowMs: 60_000, max: 10 });
  const testPushLimit = createRateLimiter({ name: 'push-test', windowMs: 60_000, max: 5 });
  const briefLimit = createRateLimiter({ name: 'brief', windowMs: 60_000, max: 10 });
  app.use('/api', generalLimit);

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'pitchpulse-scraper', timestamp: new Date().toISOString() });
  });

  /* ------------------------------- Web Push -------------------------------- */

  const pushDisabled = (res: Response) =>
    res.status(503).json({
      error: 'Push notifications are not configured on this server.',
      configured: false,
    });

  app.get('/api/push/vapid-public-key', (_req, res) => {
    res.json(push.publicInfo());
  });

  app.post('/api/push/subscribe', subscribeLimit, (req, res) => {
    if (!push.isConfigured()) return pushDisabled(res);
    const subscription = validatePushSubscriptionInput(req.body?.subscription);
    if (!subscription) {
      res.status(400).json({ error: 'Invalid or unsupported Web Push subscription.' });
      return;
    }
    const prefs = sanitizePreferences(req.body?.preferences);
    const model = sanitizeModelSnapshot(req.body?.model);
    const result = push.register(subscription, prefs, model);
    if (!result.ok) {
      if (result.reason === 'not_configured') return pushDisabled(res);
      res.status(503).json({ error: 'Push subscriber capacity reached.' });
      return;
    }
    res.json({ ok: true, subscriberCount: result.subscriberCount });
  });

  app.post('/api/push/unsubscribe', subscribeLimit, (req, res) => {
    const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : '';
    if (!endpoint || endpoint.length > 2048) {
      res.status(400).json({ error: 'Invalid endpoint.' });
      return;
    }
    res.json({ ok: true, ...push.unregister(endpoint) });
  });

  app.post('/api/push/test', testPushLimit, async (req, res) => {
    if (!push.isConfigured()) return pushDisabled(res);
    const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : '';
    if (!endpoint || endpoint.length > 2048) {
      // A test never broadcasts: the caller must name their own registered endpoint.
      res.status(400).json({ error: 'An endpoint is required.' });
      return;
    }
    const result = await push.sendTest(endpoint);
    if (result.reason === 'cooldown') {
      res.status(429).json({ ok: false, ...result });
      return;
    }
    res.json({ ok: result.sent > 0, ...result });
  });

  /* ---------------------------- AI tactical brief --------------------------- */

  app.post('/api/alerts/tactical-brief', briefLimit, async (req, res) => {
    const token = bearerToken(req);
    const user = token ? await verifyToken(token) : null;
    if (!user) {
      res.status(401).json({ error: 'Sign in to generate AI tactical briefs.' });
      return;
    }

    const input = sanitizeTacticalBriefInput(req.body);
    if (!input) {
      res.status(400).json({ error: 'Invalid tactical brief payload.' });
      return;
    }

    if (!budget.tryConsume(user.uid)) {
      res.status(429).json({ error: 'Daily AI brief limit reached. Try again tomorrow.' });
      return;
    }

    try {
      const brief = await generateBrief(input);
      res.json({ brief });
    } catch (err) {
      budget.refund(user.uid);
      console.error('[ai] tactical brief failed:', err instanceof Error ? err.message : err);
      const message = err instanceof Error ? err.message : '';
      // Configuration problems are actionable for the operator and safe to surface.
      const safe = message.includes('GEMINI_API_KEY')
        ? 'AI tactical briefs are not configured on this server.'
        : 'AI tactical brief generation failed. Please try again shortly.';
      res.status(502).json({ error: safe });
    }
  });

  /* -------------------------------- Scraping -------------------------------- */

  app.get('/api/leagues', scrapeLimit, async (_req, res) => {
    try {
      const leagues = await listLeagues();
      res.json({ leagues, count: leagues.length });
    } catch (err) {
      console.error('[scrape] leagues failed:', err instanceof Error ? err.message : err);
      res.status(502).json({ error: 'League catalog is unavailable right now.' });
    }
  });

  app.get('/api/matches/live', scrapeLimit, async (req, res) => {
    try {
      const dateParam = typeof req.query.date === 'string' ? req.query.date : undefined;
      if (dateParam && !/^\d{8}$/.test(dateParam)) {
        res.status(400).json({ error: 'Invalid date parameter. Expected YYYYMMDD.' });
        return;
      }
      const leagueParam =
        typeof req.query.league === 'string' && req.query.league.trim()
          ? req.query.league.trim()
          : undefined;
      if (leagueParam && !/^[a-z0-9._-]{1,48}$/i.test(leagueParam)) {
        res.status(400).json({ error: 'Invalid league parameter.' });
        return;
      }
      const data = await scrapeScoreboard({
        dateYyyymmdd: dateParam,
        league: leagueParam,
        allLeagues: !leagueParam,
        enrichLimit: 24,
      });
      res.json(data);
    } catch (err) {
      console.error('[scrape] live failed:', err instanceof Error ? err.message : err);
      res.status(502).json({ error: 'Live data source is unavailable right now.' });
    }
  });

  app.get('/api/matches/:id', scrapeLimit, async (req, res) => {
    try {
      const matchId = req.params.id;
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(matchId)) {
        res.status(400).json({ error: 'Invalid match ID.' });
        return;
      }
      const match = await scrapeMatch(matchId);
      if (!match) {
        res.status(404).json({ error: 'Match not found in scraped feeds.' });
        return;
      }
      res.json({ match });
    } catch (err) {
      console.error('[scrape] match failed:', err instanceof Error ? err.message : err);
      res.status(502).json({ error: 'Match data source is unavailable right now.' });
    }
  });

  app.get('/api/historical/finished', historyLimit, async (req, res) => {
    try {
      const rawDays = Number(req.query.days ?? 2);
      const days = Math.max(1, Math.min(5, Number.isFinite(rawDays) ? Math.floor(rawDays) : 2));
      const baseDate = new Date();

      const dateStrings: string[] = [];
      for (let d = 0; d < days; d++) {
        const dt = new Date(baseDate.getTime() - d * 86_400_000);
        const yyyy = dt.getUTCFullYear();
        const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(dt.getUTCDate()).padStart(2, '0');
        dateStrings.push(`${yyyy}${mm}${dd}`);
      }

      const batches = await Promise.all(
        dateStrings.map((dateYyyymmdd) =>
          scrapeScoreboard({ dateYyyymmdd, allLeagues: true, onlyFinished: true, enrichLimit: 24 })
        )
      );

      const seen = new Set<string>();
      const finishedMatches = [];
      for (const b of batches) {
        for (const m of b.matches) {
          if (!seen.has(m.id) && m.state === 'post' && m.hasDetailedFlow) {
            seen.add(m.id);
            finishedMatches.push(m);
          }
        }
      }

      res.json({
        datesScraped: dateStrings,
        count: finishedMatches.length,
        matches: finishedMatches,
      });
    } catch (err) {
      console.error('[scrape] historical failed:', err instanceof Error ? err.message : err);
      res.status(502).json({ error: 'Historical data source is unavailable right now.' });
    }
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });

  return app;
}

/** Final error handler; mount AFTER static/SPA routes. */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction
) {
  if (res.headersSent) return next(err);
  const e = err as { type?: string; status?: number };
  if (e?.type === 'entity.too.large') {
    res.status(413).json({ error: 'Request body too large.' });
    return;
  }
  if (e?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    res.status(400).json({ error: 'Malformed JSON body.' });
    return;
  }
  console.error('[server] unhandled error:', err);
  res.status(500).json({ error: 'Internal server error.' });
}
