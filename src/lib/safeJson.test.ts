import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonResponse } from './safeJson';

test('parseJsonResponse parses valid JSON and rejects HTML fallback pages cleanly', async () => {
  const valid = new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  assert.deepEqual(await parseJsonResponse(valid, 'Live scrape'), { ok: true });

  const htmlFallback = new Response('<!doctype html><html><body>SPA</body></html>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });
  await assert.rejects(
    parseJsonResponse(htmlFallback, 'Live scrape'),
    /returned HTML instead of live JSON/
  );

  const html403 = new Response('<html>403</html>', {
    status: 403,
    headers: { 'content-type': 'text/html' },
  });
  await assert.rejects(parseJsonResponse(html403, 'Live scrape'), /HTTP 403 HTML response/);

  const apiErr = new Response(JSON.stringify({ error: 'Upstream unavailable' }), {
    status: 502,
    headers: { 'content-type': 'application/json' },
  });
  await assert.rejects(parseJsonResponse(apiErr, 'Live scrape'), /Upstream unavailable/);
});
