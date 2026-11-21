// Bundles server.ts (and the shared engine code it imports) into dist-server/server.js
// so `npm start` can run with plain Node. Node's ESM loader cannot resolve the
// extensionless TypeScript imports used throughout the project, so running
// `node server.ts` directly never worked.
import { build } from 'esbuild';

await build({
  entryPoints: ['server.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external', // runtime dependencies are loaded from node_modules
  outfile: 'dist-server/server.js',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
});
