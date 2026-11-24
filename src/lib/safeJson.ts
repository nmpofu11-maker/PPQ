/**
 * Safely parses JSON from an API response, catching HTML error/fallback pages
 * (such as SPA index.html or upstream 403 HTML pages) with an actionable error.
 */
export async function parseJsonResponse<T = Record<string, unknown>>(
  res: Response,
  actionLabel: string
): Promise<T> {
  const text = await res.text();
  const contentType = (res.headers.get('content-type') || '').toLowerCase();

  if (!text) {
    if (!res.ok) {
      throw new Error(`${actionLabel} failed (HTTP ${res.status})`);
    }
    return {} as T;
  }

  const trimmed = text.trimStart();
  if (trimmed.startsWith('<') || contentType.includes('text/html')) {
    throw new Error(
      res.ok
        ? 'API endpoint returned HTML instead of live JSON. Run the full-stack server (`npm run dev` or `npm start`) so /api/* routes are active.'
        : `${actionLabel} failed (HTTP ${res.status} HTML response)`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${actionLabel} returned invalid JSON (HTTP ${res.status})`);
  }

  if (!res.ok) {
    const errMsg =
      parsed && typeof parsed === 'object' && 'error' in parsed && typeof (parsed as { error?: unknown }).error === 'string'
        ? (parsed as { error: string }).error
        : `${actionLabel} failed (HTTP ${res.status})`;
    throw new Error(errMsg);
  }

  return parsed as T;
}
