import 'dotenv/config';
import express from 'express';
import path from 'path';
import { createApp, errorHandler } from './server/app';
import { PushService, createDefaultPushStore, loadVapidConfig } from './server/webPush';

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';

function parseTrustProxy(): boolean | number | string {
  const raw = (process.env.TRUST_PROXY || '').trim();
  if (!raw) return isProduction ? 1 : false; // one reverse-proxy hop is typical on PaaS hosts
  if (raw === 'true') return true;
  if (raw === 'false' || raw === '0') return false;
  const n = Number(raw);
  return Number.isFinite(n) ? n : raw;
}

async function startServer() {
  const store = createDefaultPushStore();
  const vapid = loadVapidConfig({
    production: isProduction,
    dataDir: path.resolve(process.cwd(), '.data'),
  });
  if (!vapid) {
    console.warn(
      '[push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set. Background push is DISABLED in production. ' +
        'Generate keys with `npx web-push generate-vapid-keys` and set both variables.'
    );
  }
  const push = new PushService({ store, vapid });
  push.start();

  const app = createApp({ push, trustProxy: parseTrustProxy() });

  if (isProduction) {
    const distPath = path.resolve(process.env.STATIC_DIR || path.join(process.cwd(), 'dist'));
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

  app.use(errorHandler);

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(
      `PitchPulse Quant server listening on http://0.0.0.0:${PORT} (${isProduction ? 'production' : 'development'})`
    );
  });

  const shutdown = () => {
    push.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

startServer().catch((err) => {
  console.error('Server startup error:', err);
  process.exit(1);
});
