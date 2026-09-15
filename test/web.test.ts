/**
 * Serving the web app, and refusing to serve anything else.
 *
 * Most of this file is traversal attempts. That is proportionate: this is the only place in the
 * project that turns an attacker-controlled string into a filesystem read, and the failure mode is
 * handing over `../../data/churn-tracker.db` — which holds every user's history and their password
 * hashes.
 *
 * The fixture is a real directory tree in a temp folder, including a symlink pointing out of it and a
 * secret file next door, because the interesting cases only exist on a filesystem.
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { resolveWebFile, serveWeb } from '../src/server/web.ts';
import { createApp, start, stop, type App } from '../src/server/server.ts';

let sandbox: string;
let root: string;
let app: App;
let server: ReturnType<typeof start>;
let base: string;

before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'churn-web-'));
  root = join(sandbox, 'web');

  mkdirSync(join(root, '_expo', 'static', 'js'), { recursive: true });
  mkdirSync(join(root, 'card'), { recursive: true });

  writeFileSync(join(root, 'index.html'), '<!doctype html><title>Churn Tracker</title>');
  writeFileSync(join(root, 'cards.html'), '<!doctype html><title>Cards</title>');
  writeFileSync(join(root, 'card', '[id].html'), '<!doctype html><title>Card</title>');
  writeFileSync(join(root, '_expo', 'static', 'js', 'entry-abc123.js'), 'console.log(1)');

  // A secret next door and a dot-file inside, which is what the traversal tests aim at.
  writeFileSync(join(sandbox, 'secrets.txt'), 'KAMAL_REGISTRY_PASSWORD=hunter2');
  writeFileSync(join(root, '.env'), 'CT_SECRET=nope');

  // A sibling whose name starts with the root's name, to catch a prefix test with no separator.
  mkdirSync(join(sandbox, 'web-secrets'), { recursive: true });
  writeFileSync(join(sandbox, 'web-secrets', 'leak.txt'), 'do not serve me');

  // A symlink inside the served tree pointing out of it.
  try {
    symlinkSync(join(sandbox, 'secrets.txt'), join(root, 'escape.txt'));
  } catch {
    /* Some filesystems refuse symlinks; the test below tolerates its absence. */
  }

  process.env.CT_WEB_DIR = root;
  process.env.CT_SERVE_WEB = '1';

  app = createApp(':memory:');
  server = start(app, { host: '127.0.0.1', port: 0, quiet: true, background: false });
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  stop(app);
  app.store.close();
  rmSync(sandbox, { recursive: true, force: true });
  delete process.env.CT_WEB_DIR;
  delete process.env.CT_SERVE_WEB;
});

// ---- traversal, which is the whole point of the file ----------------------

/**
 * Never reaches the file it was aiming at.
 *
 * Not "returns null": a route-shaped path legitimately falls back to the app shell, and asserting
 * null would fail for the wrong reason and would have to be loosened until it asserted nothing. What
 * must be true is narrower and stronger — whatever comes back, it is inside the served root and it is
 * not the file being probed for.
 */
async function refuses(attempt: string, target: string): Promise<void> {
  const resolved = await resolveWebFile(root, attempt);
  if (resolved === null) return;
  assert.ok(!resolved.includes(target), `${attempt} reached ${resolved}`);
  assert.ok(resolved.startsWith(await realpath(root)), `${attempt} escaped to ${resolved}`);
}

test('a path that climbs out of the root is refused', async () => {
  for (const attempt of [
    '/../secrets.txt',
    '/../../secrets.txt',
    '/card/../../secrets.txt',
    '/./../secrets.txt',
    '/subdir/../../secrets.txt',
  ]) {
    await refuses(attempt, 'secrets.txt');
  }
});

test('a percent-encoded climb is refused too', async () => {
  // The one that defeats a check written before decoding. `%2e%2e%2f` is `../`.
  for (const attempt of [
    '/%2e%2e/secrets.txt',
    '/%2e%2e%2fsecrets.txt',
    '/%2e%2e%2f%2e%2e%2fsecrets.txt',
    '/card/%2e%2e/%2e%2e/secrets.txt',
  ]) {
    await refuses(attempt, 'secrets.txt');
  }
});

test('a double-encoded climb is refused', async () => {
  // `%252e` decodes to `%2e`, which is not itself a traversal — so this must not resolve, and must
  // also not be decoded twice.
  await refuses('/%252e%252e/secrets.txt', 'secrets.txt');
});

test('a sibling directory sharing the root prefix is refused', async () => {
  // What a prefix test without a trailing separator would let through: `/web-secrets/leak.txt`
  // starts with the string `/web`.
  await refuses('/../web-secrets/leak.txt', 'web-secrets');
});

test('a symlink out of the root is refused', async () => {
  // The target exists and is inside the directory listing, so only the realpath check catches it.
  await refuses('/escape.txt', 'secrets.txt');
});

test('a dot-file inside the root is refused', async () => {
  await refuses('/.env', '.env');
  await refuses('/.git/config', '.git');
});

test('a NUL byte is refused', async () => {
  await refuses('/index.html\0.png', '\0');
});

test('a malformed escape is refused rather than throwing', async () => {
  assert.equal(await resolveWebFile(root, '/%zz'), null);
  assert.equal(await resolveWebFile(root, '/%'), null);
});

test('an extension outside the allowlist is not served, and does not fall back to the shell', async () => {
  // An asset-shaped miss has to 404 rather than answering with HTML — see `routeLike` in web.ts.
  writeFileSync(join(root, 'notes.db'), 'sqlite');
  writeFileSync(join(root, 'bundle.js.map'), '{}');
  assert.equal(await resolveWebFile(root, '/notes.db'), null);
  assert.equal(await resolveWebFile(root, '/bundle.js.map'), null, 'source maps are not served');

  assert.equal((await fetch(`${base}/notes.db`)).status, 404);
  assert.equal((await fetch(`${base}/bundle.js.map`)).status, 404);
});

test('a missing asset is a 404, not the app shell', async () => {
  // Serving HTML for a missing bundle gives the browser a syntax error for a diagnosis and hides the
  // real problem, which is a deploy that shipped mismatched files.
  const response = await fetch(`${base}/_expo/static/js/entry-doesnotexist.js`);
  assert.equal(response.status, 404);
  assert.ok(!(await response.text()).includes('<!doctype html'));
});

// ---- what it should serve ------------------------------------------------

test('the root serves the app shell', async () => {
  const response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await response.text(), /Churn Tracker/);
});

test('a route with its own HTML file is served without the extension', async () => {
  // Expo Router's static output writes `cards.html`; the app links to `/cards`.
  const response = await fetch(`${base}/cards`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<title>Cards<\/title>/);
});

test('an unknown path falls back to the shell so client-side routing works', async () => {
  // A deep link to a card the server has no file for still has to boot the app.
  const response = await fetch(`${base}/card/some-uuid`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Churn Tracker|<title>Card<\/title>/);
});

test('hashed assets are cached forever and HTML is not cached at all', async () => {
  // The filename carries a content hash, so it can never be stale. The HTML has no hash, so caching
  // it would leave clients on the previous build with no way to notice.
  const asset = await fetch(`${base}/_expo/static/js/entry-abc123.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('cache-control') ?? '', /immutable/);
  assert.match(asset.headers.get('content-type') ?? '', /javascript/);

  const html = await fetch(`${base}/`);
  assert.equal(html.headers.get('cache-control'), 'no-cache');
});

test('an unchanged file answers 304', async () => {
  const first = await fetch(`${base}/_expo/static/js/entry-abc123.js`);
  const etag = first.headers.get('etag');
  assert.ok(etag);

  const second = await fetch(`${base}/_expo/static/js/entry-abc123.js`, {
    headers: { 'If-None-Match': etag },
  });
  assert.equal(second.status, 304);
});

test('static responses are not allowed to be sniffed', async () => {
  const response = await fetch(`${base}/`);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('HEAD returns the headers and no body', async () => {
  const response = await fetch(`${base}/`, { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
});

// ---- the API still wins --------------------------------------------------

test('the API takes precedence over any file that could shadow it', async () => {
  // A file called `v1` in the build must not be able to answer for the API, and `/health` must stay
  // JSON because it is the container healthcheck.
  writeFileSync(join(root, 'v1'), 'not the api');

  const health = await fetch(`${base}/health`);
  assert.match(health.headers.get('content-type') ?? '', /application\/json/);
  assert.equal((await health.json()).ok, true);

  const api = await fetch(`${base}/v1/cards`);
  assert.equal(api.status, 401, 'a data route must still demand a token');
});

test('health reports that this server is serving the app', async () => {
  // The app reads this to decide whether to ask for a server address at all.
  const response = await fetch(`${base}/health`);
  assert.equal((await response.json()).servesWebApp, true);
});

test('an unauthenticated static request needs no token', async () => {
  // Stated as a test because the handler order is what makes it true, and reordering the router
  // would silently put the whole app behind a 401.
  const response = await fetch(`${base}/cards`);
  assert.equal(response.status, 200);
});

// ---- the flag ------------------------------------------------------------

test('CT_SERVE_WEB=0 turns web serving off even with a build present', () => {
  process.env.CT_SERVE_WEB = '0';
  try {
    assert.equal(serveWeb(), false);
  } finally {
    process.env.CT_SERVE_WEB = '1';
  }
});

test('with no flag set, serving follows whether a build is present', () => {
  const flag = process.env.CT_SERVE_WEB;
  const directory = process.env.CT_WEB_DIR;
  delete process.env.CT_SERVE_WEB;
  try {
    assert.equal(serveWeb(), true, 'the fixture build exists');
    process.env.CT_WEB_DIR = join(sandbox, 'nothing-here');
    assert.equal(serveWeb(), false, 'an API-only image has no build directory');
  } finally {
    if (flag !== undefined) process.env.CT_SERVE_WEB = flag;
    if (directory !== undefined) process.env.CT_WEB_DIR = directory;
  }
});
