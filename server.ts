import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  scrapeScoreboardMatches,
  scrapeSingleMatchDetails,
} from './server/scraper';
import { generateTacticalBrief, type TacticalBriefInput } from './server/aiAlerts';
import {
  getPublicVapidInfo,
  registerPushSubscription,
  sanitizePreferences,
  sendTestPushNotification,
  unregisterPushSubscription,
  validatePushSubscriptionInput,
} from './server/webPush';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);

async function startServer() {
  const app = express();
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'pitchpulse-scraper', timestamp: new Date().toISOString() });
  });

  app.get('/api/push/vapid-public-key', (_req, res) => {
    res.json(getPublicVapidInfo());
  });

  app.post('/api/push/subscribe', (req, res) => {
    const subscription = validatePushSubscriptionInput(req.body?.subscription);
    if (!subscription) {
      res.status(400).json({ error: 'Invalid Web Push subscription payload.' });
      return;
    }
    const prefs = sanitizePreferences(req.body?.preferences);
    const result = registerPushSubscription(subscription, prefs);
    res.json({ ok: true, ...result });
  });

  app.post('/api/push/unsubscribe', (req, res) => {
    const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : '';
    if (!endpoint || endpoint.length > 2048) {
      res.status(400).json({ error: 'Invalid endpoint.' });
      return;
    }
    const result = unregisterPushSubscription(endpoint);
    res.json({ ok: true, ...result });
  });

  app.post('/api/push/test', async (req, res) => {
    const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : undefined;
    const result = await sendTestPushNotification(endpoint);
    res.json({ ok: result.sent > 0, ...result });
  });

  app.post('/api/alerts/tactical-brief', async (req, res) => {
    try {
      const body = req.body as TacticalBriefInput;
      if (!body?.trend?.id || !body?.homeTeam || !body?.awayTeam) {
        res.status(400).json({ error: 'Invalid tactical brief payload.' });
        return;
      }
      const brief = await generateTacticalBrief(body);
      res.json({ brief });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'AI tactical brief generation failed';
      res.status(502).json({ error: message });
    }
  });

  app.get('/api/matches/live', async (req, res) => {
    try {
      const dateParam = typeof req.query.date === 'string' ? req.query.date : undefined;
      if (dateParam && !/^\d{8}$/.test(dateParam)) {
        res.status(400).json({ error: 'Invalid date parameter. Expected YYYYMMDD.' });
        return;
      }
      const data = await scrapeScoreboardMatches({
        dateYyyymmdd: dateParam,
        enrichLimit: 24,
      });
      res.json(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Live scraping failed';
      res.status(502).json({ error: message });
    }
  });

  app.get('/api/matches/:id', async (req, res) => {
    try {
      const matchId = req.params.id;
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(matchId)) {
        res.status(400).json({ error: 'Invalid match ID.' });
        return;
      }
      const match = await scrapeSingleMatchDetails(matchId);
      if (!match) {
        res.status(404).json({ error: 'Match not found in scraped feeds.' });
        return;
      }
      res.json({ match });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Match detail scraping failed';
      res.status(502).json({ error: message });
    }
  });

  app.get('/api/historical/finished', async (req, res) => {
    try {
      const rawDays = Number(req.query.days ?? 2);
      const days = Math.max(1, Math.min(5, Number.isFinite(rawDays) ? rawDays : 2));
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
          scrapeScoreboardMatches({
            dateYyyymmdd,
            onlyFinished: true,
            enrichLimit: 18,
          })
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
      const message = err instanceof Error ? err.message : 'Historical scraping failed';
      res.status(502).json({ error: message });
    }
  });

  if (process.env.NODE_ENV === 'production') {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: 'spa',
    });
    app.get('/@vite/client', async (_req, res, next) => {
      try {
        const transformed = await vite.transformRequest('/@vite/client');
        if (!transformed) {
          next();
          return;
        }
        const safeCode = transformed.code.replace(
          /let wsTransport = createWebSocketModuleRunnerTransport\(\{[\s\S]*?pingInterval: hmrTimeout\s*\}\);/,
          'let wsTransport = { async connect() {}, async disconnect() {}, send() {} };'
        );
        res.type('application/javascript').send(safeCode);
      } catch (err) {
        next(err);
      }
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`PitchPulse Quant server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Server startup error:', err);
  process.exit(1);
});
