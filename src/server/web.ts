/**
 * Serving the web app off the same origin as the API.
 *
 * The point of this file is that the deployed web app should need no configuration. Open
 * `churn.example.com`, sign in, done — no server address to type, because the API is the origin the
 * page came from. Pointing at a different server stays possible, but it becomes an escape hatch
 * rather than the first thing a new user has to get right.
 *
 * Same-origin also removes CORS from the picture for the common case, and means the app's static
 * assets ride the same TLS terminator and the same deploy as the API. One container, one hostname,
 * one thing to keep running.
 *
 * **On path handling, which is the whole risk here.** This maps a URL onto a filesystem read, and the
 * URL is attacker-controlled. Four things guard it, and each is doing separate work:
 *
 *   1. The path is decoded *before* traversal checks, not after — otherwise `%2e%2e%2f` walks straight
 *      past a check for `..`.
 *   2. `resolve` then a prefix test against the root, so any `..` that survives lands outside and is
 *      rejected. Comparing strings after normalising is not enough on its own; the prefix test is
 *      what actually confines it.
 *   3. `realpath`, so a symlink inside the directory cannot point out of it. The web build has no
 *      symlinks today, which is exactly why this would go unnoticed if one appeared.
 *   4. A content-type allowlist. An extension nobody expects is not served at all rather than being
 *      guessed at, so a stray `.env` or `.db` in the directory is a 404.
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Where the built web app lives.
 *
 * `web/` next to `src/` rather than `app/dist/`: the container copies the build in from a separate
 * stage and never has the Expo project, so a path into `app/` would only ever work on a developer's
 * machine. `CT_WEB_DIR` overrides it.
 */
export function webDirectory(): string {
  return process.env.CT_WEB_DIR ?? fileURLToPath(new URL('../../web/', import.meta.url));
}

/**
 * Whether to serve the web app at all.
 *
 * Defaults to "yes if a build is present". That makes the two deployment shapes the user asked for
 * fall out of what is in the image rather than out of a setting they have to remember: an image built
 * with the app serves it, an API-only image does not. `CT_SERVE_WEB=0` forces API-only even with a
 * build present, for running the app from a dev server against a deployed API.
 */
export function serveWeb(): boolean {
  const flag = process.env.CT_SERVE_WEB?.trim();
  if (flag === '0' || flag?.toLowerCase() === 'false') return false;
  if (flag === '1' || flag?.toLowerCase() === 'true') return true;
  return existsSync(webDirectory());
}

/**
 * Extension to content type.
 *
 * An allowlist, not a lookup with a fallback. Anything not here is a 404 — see the header. `.map` is
 * absent deliberately: source maps in a production bundle hand over the app's source, and while that
 * source is not secret, it is not something to serve by accident.
 */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/**
 * The file a request path should serve, or null.
 *
 * Expo Router's static output writes one HTML file per route — `cards.html`, `card/[id].html` — plus a
 * hashed asset tree under `_expo/`. So a request is tried as a literal file, then with `.html`, then
 * as a directory index, and only then falls back to `index.html` so a client-side route still boots.
 *
 * Exported for the tests, which is most of why the resolution is separate from the serving.
 */
export async function resolveWebFile(root: string, urlPath: string): Promise<string | null> {
  // Decoded first: a check for `..` that runs before decoding is defeated by `%2e%2e%2f`.
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    // A malformed escape is not a path worth guessing at.
    return null;
  }

  // A NUL byte truncates a path in some syscalls, which historically turned `a.html\0.png` into a
  // read of `a.html`. Node rejects it, but rejecting it here keeps the reason legible.
  if (decoded.includes('\0')) return null;

  const relative = decoded.replace(/^\/+/, '');

  // Dot-directories are never part of a web build and are where secrets live — `.git`, `.env`,
  // `.kamal`. Refused by name rather than relying on the extension allowlist to catch them.
  if (relative.split('/').some((part) => part.startsWith('.'))) return null;

  const rootReal: string | null = await realpath(root).catch(() => null);
  if (rootReal === null) return null;

  /**
   * Whether an unmatched path should fall back to the app shell.
   *
   * Only for paths that look like routes — no extension, or `.html`. An unmatched *asset* must 404.
   *
   * This distinction is load-bearing in two directions. Serving `index.html` for a missing
   * `entry-abc.js` gives the browser HTML where it expected JavaScript, a 200 status, and a syntax
   * error for a diagnosis — while hiding the actual problem, which is a deploy that shipped a stale
   * HTML file. And it is what makes a refusal a refusal: without it, every rejected traversal
   * silently fell through to the shell and answered 200, so a test could not tell "denied" from
   * "served the wrong thing".
   */
  const routeLike = relative === '' || !/\.[a-z0-9]{1,8}$/i.test(relative) || relative.endsWith('.html');

  const candidates =
    relative === ''
      ? ['index.html']
      : [
          relative,
          `${relative}.html`,
          join(relative, 'index.html'),
          ...(routeLike ? ['index.html'] : []),
        ];

  for (const candidate of candidates) {
    const absolute = resolve(rootReal, candidate);

    // The confinement test. `resolve` has collapsed any `..` by now, so anything that escaped the
    // root no longer starts with it. The trailing separator matters: without it, a sibling directory
    // named `web-secrets` passes a prefix test against `web`.
    if (absolute !== rootReal && !absolute.startsWith(rootReal + sep)) continue;

    if (CONTENT_TYPES[extname(absolute).toLowerCase()] === undefined) continue;

    let stats;
    try {
      stats = statSync(absolute);
    } catch {
      continue;
    }
    if (!stats.isFile()) continue;

    // And again after following symlinks, so a link inside the build cannot point outside it.
    // Annotated because `realpath`'s overloads leave the inferred type circular otherwise.
    const real: string | null = await realpath(absolute).catch(() => null);
    if (real === null) continue;
    if (real !== rootReal && !real.startsWith(rootReal + sep)) continue;

    return real;
  }

  return null;
}

export interface ServeResult {
  served: boolean;
}

/**
 * Serves a static file, or reports that there was nothing to serve.
 *
 * Returns rather than 404s on a miss so the caller keeps control of what a miss means — with the web
 * app present an unknown path is the app's own not-found page, and without it the response should be
 * the API's JSON 404 rather than an HTML one.
 */
export async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  urlPath: string,
): Promise<ServeResult> {
  if (!serveWeb()) return { served: false };

  const root = webDirectory();
  const file = await resolveWebFile(root, urlPath);
  if (file === null) return { served: false };

  const extension = extname(file).toLowerCase();
  const contentType = CONTENT_TYPES[extension] ?? 'application/octet-stream';
  const stats = statSync(file);

  // Everything under `_expo/static` has a content hash in its filename, so it can be cached
  // permanently. Everything else — the HTML, the manifest — must not be, or a deploy leaves clients
  // on the previous build indefinitely with no way to notice.
  const immutable = /(^|\/)_expo\/static\//.test(file.slice(root.length).replaceAll(sep, '/'));

  const etag = `W/"${stats.size.toString(16)}-${stats.mtimeMs.toString(16)}"`;
  if (request.headers['if-none-match'] === etag) {
    response.writeHead(304, { ETag: etag }).end();
    return { served: true };
  }

  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stats.size,
    ETag: etag,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    // The app is a single-page bundle from this origin and loads nothing else executable. Stated
    // here rather than left to a proxy, since the proxy in front of this only terminates TLS.
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  });

  if (request.method === 'HEAD') {
    response.end();
    return { served: true };
  }

  createReadStream(file).pipe(response);
  return { served: true };
}
