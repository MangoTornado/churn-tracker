/**
 * Outbound HTTP, with manners.
 *
 * There is exactly one thing on the other end of this: doctorofcredit.com, a small independent
 * site that maintains by hand the two pages this app depends on. It owes us nothing. So requests
 * are serialised per host behind a minimum interval, a 429 backs off for real rather than being
 * retried, and every response is conditional — `If-Modified-Since` from the last fetch, so a
 * refresh that finds nothing new costs a 304 and no page render.
 *
 * The conditional part matters more than the interval. The pages change roughly weekly and the
 * server checks daily, so six out of seven refreshes should transfer nothing at all.
 */

const USER_AGENT =
  'ChurnTracker/0.1 (personal churning tracker; +https://github.com/asu-tw/churn-tracker)';

/** One request at a time per host, with a floor on the gap between them. */
const MIN_INTERVAL_MS: Record<string, number> = {
  'www.doctorofcredit.com': 2_000,
  'm16p-churning.s3.us-east-2.amazonaws.com': 1_000,
};

const DEFAULT_INTERVAL_MS = 1_000;

const queues = new Map<string, Promise<unknown>>();
const lastRequestAt = new Map<string, number>();
const backoffUntil = new Map<string, number>();

export interface FetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Sent as `If-Modified-Since`, so an unchanged page answers 304 with no body. */
  ifModifiedSince?: string;
}

export interface FetchResult {
  ok: boolean;
  status: number;
  body: string;
  /** The server's `Last-Modified`, to hand back on the next refresh. */
  lastModified: string | null;
  ms: number;
  error?: string;
}

export async function request(url: string, options: FetchOptions = {}): Promise<FetchResult> {
  const host = hostOf(url);
  // Chain onto whatever is already queued for this host, so two refreshes cannot race each other
  // into a rate limit.
  const previous = queues.get(host) ?? Promise.resolve();
  const attempt = previous.then(() => run(host, url, options));
  queues.set(
    host,
    attempt.catch(() => undefined),
  );
  return attempt;
}

async function run(host: string, url: string, options: FetchOptions): Promise<FetchResult> {
  const now = Date.now();

  const blockedUntil = backoffUntil.get(host) ?? 0;
  if (blockedUntil > now) {
    return {
      ok: false,
      status: 429,
      body: '',
      lastModified: null,
      ms: 0,
      error: `backing off for another ${Math.ceil((blockedUntil - now) / 1000)}s`,
    };
  }

  const interval = MIN_INTERVAL_MS[host] ?? DEFAULT_INTERVAL_MS;
  const since = now - (lastRequestAt.get(host) ?? 0);
  if (since < interval) await sleep(interval - since);
  lastRequestAt.set(host, Date.now());

  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    Accept: 'text/html,application/xhtml+xml',
    'Accept-Language': 'en-US,en;q=0.9',
    ...options.headers,
  };
  if (options.ifModifiedSince) headers['If-Modified-Since'] = options.ifModifiedSince;

  const started = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);

  try {
    const response = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' });
    // A 304 has no body and is a success — the caller keeps what it already had.
    const body = response.status === 304 ? '' : await response.text();

    if (response.status === 429) {
      const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
      backoffUntil.set(host, Date.now() + (Number.isFinite(retryAfter) ? retryAfter * 1000 : 300_000));
    }

    return {
      ok: response.ok || response.status === 304,
      status: response.status,
      body,
      lastModified: response.headers.get('last-modified'),
      ms: Math.round(performance.now() - started),
      error: response.ok || response.status === 304 ? undefined : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: '',
      lastModified: null,
      ms: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
