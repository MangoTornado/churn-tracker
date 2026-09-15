/**
 * The HTTP surface.
 *
 * No framework, on purpose: the router is one table of patterns and it fits on a screen. For a
 * server whose entire job is CRUD over a few tables plus four derived views, a dependency tree is a
 * worse trade than sixty lines of matching.
 *
 * Three things are structural rather than incidental:
 *
 * **Every authenticated route resolves a player through `store.playerFor(user.id, playerId)`.** That
 * function filters by owner in the query. The alternative — load by id, then compare owners — is the
 * shape that eventually ships with the comparison missing, and what is on the other side is
 * somebody's complete financial history.
 *
 * **Nothing derived is stored, so nothing derived can go stale.** `/v1/standing`, `/v1/reminders`,
 * `/v1/plan` and `/v1/assess` all recompute from the accounts on every request. Over a few dozen
 * rows that is microseconds, and it means correcting a mistyped open date fixes every number at
 * once.
 *
 * **Writes go through `src/core/accounts.ts` rather than validating here.** So the rules can assume
 * well-formed input, and a malformed date produces a 400 instead of a wrong 5/24 count.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { Auth, AuthError, bearerToken, SESSION_TTL_SECONDS } from './auth.ts';
import { Settings } from './config.ts';
import { Store } from './db.ts';
import { loadBankOffers, loadCardOffers, refresh } from './doc.ts';
import { notifyEveryone } from './notify.ts';
import { serveStatic, serveWeb, webDirectory } from './web.ts';
import { ValidationError, newBankAccount, newCardAccount, suggestedCloseNotBefore } from '../core/accounts.ts';
import { CARDS, familyName } from '../core/data/cards.ts';
import { isIsoDate, today } from '../core/dates.ts';
import { ISSUER_NAMES } from '../core/model.ts';
import type { Inquiry, IssuerId, Player, User } from '../core/model.ts';
import { RULES, assess, standing } from '../core/rules/issuers.ts';
import { FLOWCHART, plan, type Goal } from '../core/rules/recommend.ts';
import { activeReminders, reminders } from '../core/rules/reminders.ts';

export interface App {
  store: Store;
  settings: Settings;
  auth: Auth;
  /** Cleared on shutdown; otherwise the process will not exit. */
  timers: Set<NodeJS.Timeout>;
}

export function createApp(databasePath: string): App {
  const store = new Store(databasePath);
  return { store, settings: new Settings(store), auth: new Auth(store), timers: new Set() };
}

export function start(
  app: App,
  overrides: { host?: string; port?: number; quiet?: boolean; background?: boolean } = {},
): ReturnType<typeof createServer> {
  const stored = app.settings.read();
  const host = overrides.host ?? stored.host;
  const port = overrides.port ?? stored.port;

  const server = createServer((request, response) => {
    handle(app, request, response).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      app.store.log('error', `unhandled: ${message}`);
      if (!response.headersSent) send(response, 500, { error: 'internal error' });
    });
  });

  server.listen(port, host, () => {
    const say = overrides.quiet ? () => {} : (line: string) => console.log(line);
    const where = `http://${host === '0.0.0.0' ? 'localhost' : host}:${(server.address() as { port: number }).port}`;
    say(`churn-tracker listening on ${where}`);
    say(`status:  ${where}/`);

    if (serveWeb()) say(`web app:  ${where}  (from ${webDirectory()})`);
    else say('web app: not served — this is an API-only deployment');

    const config = app.settings.read();
    if (config.openRegistration) {
      // Worth being loud about. There is no email verification, so open registration on a public
      // host means anyone who finds it can make an account.
      if (!overrides.quiet) {
        console.warn(
          `\n!! registration is OPEN — anyone who can reach ${host} can create an account.\n` +
            `   Register, then set CT_OPEN_REGISTRATION=0 and redeploy.\n`,
        );
      }
      app.store.log('warn', 'registration is open');
    } else if (app.store.userCount() === 0) {
      say('no accounts yet — set CT_OPEN_REGISTRATION=1 to register the first one');
    }

    if (overrides.background !== false) startBackgroundWork(app, overrides.quiet === true);
  });

  return server;
}

// ---- background work ------------------------------------------------------

/**
 * The refresh and notify timers.
 *
 * Both check the clock rather than being scheduled precisely, and both run on an hourly tick. A
 * container restarts whenever it is deployed, so anything scheduled for "23 hours from boot" is
 * really scheduled for never — an hourly tick that asks "is it time yet" survives that.
 */
function startBackgroundWork(app: App, quiet: boolean): void {
  const say = quiet ? () => {} : (line: string) => console.log(line);
  let lastRefreshDay = '';
  let lastNotifyDay = '';

  const tick = async (): Promise<void> => {
    const config = app.settings.read();
    const now = new Date();
    const day = now.toISOString().slice(0, 10);

    if (config.refreshEveryHours > 0 && lastRefreshDay !== day) {
      lastRefreshDay = day;
      const result = await refresh().catch((error: unknown) => {
        app.store.log('error', `refresh failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      if (result !== null) {
        const summary = `refresh: ${result.cards.count} card offers, ${result.banks.count} bank offers`;
        app.store.log('info', summary);
        say(summary);
        for (const warning of result.warnings) app.store.log('warn', `refresh: ${warning}`);
      }
    }

    if (config.notificationsEnabled && now.getUTCHours() === config.notifyAtHourUtc && lastNotifyDay !== day) {
      lastNotifyDay = day;
      const result = await notifyEveryone(app.store, app.settings);
      if (result.sent > 0 || result.errors.length > 0) {
        app.store.log('info', `notify: sent ${result.sent} to ${result.users} users`);
      }
      for (const error of result.errors) app.store.log('warn', `notify: ${error}`);
    }

    app.store.deleteExpiredSessions();
  };

  // Not awaited: startup should not block on the network, and a first refresh that fails is a log
  // line rather than a failed boot.
  void tick();

  const timer = setInterval(() => void tick(), 3_600_000);
  // Otherwise this timer alone keeps the process alive through a shutdown.
  timer.unref();
  app.timers.add(timer);
}

export function stop(app: App): void {
  for (const timer of app.timers) clearInterval(timer);
  app.timers.clear();
}

// ---- the router -----------------------------------------------------------

interface Context {
  app: App;
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  method: string;
  /** Path segments, so `/v1/cards/abc` gives `['v1', 'cards', 'abc']`. */
  parts: string[];
  user: User;
  token: string | null;
}

async function handle(app: App, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method ?? 'GET';

  // CORS, because the web build of the app is served from somewhere else entirely. Wide open on
  // purpose and safe here: every route needs a bearer token, and a bearer token is not a cookie —
  // a browser will not attach it to a cross-site request on its own, so there is no CSRF surface
  // for `*` to widen.
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  response.setHeader('Access-Control-Max-Age', '86400');
  if (method === 'OPTIONS') {
    response.writeHead(204).end();
    return;
  }

  // ---- unauthenticated ---------------------------------------------------

  // `/health` stays JSON whatever else is going on: it is the container healthcheck and the app's
  // reachability probe, and both need a machine-readable answer.
  if ((method === 'GET' || method === 'HEAD') && path === '/health') {
    return send(response, 200, health(app));
  }

  // `/` is the web app when one is built into this image, and the health JSON when it is not. So an
  // API-only deployment still answers something useful at its root rather than a bare 404.
  if ((method === 'GET' || method === 'HEAD') && path === '/' && !serveWeb()) {
    return send(response, 200, health(app));
  }

  if (method === 'POST' && path === '/v1/auth/register') {
    if (!app.settings.read().openRegistration) {
      return send(response, 403, { error: 'registration is closed on this server' });
    }
    return await withErrors(response, async () => {
      const body = await readJson<Record<string, unknown>>(request);
      return { status: 201, payload: sessionPayload(await app.auth.register(body ?? {})) };
    });
  }

  if (method === 'POST' && path === '/v1/auth/login') {
    return await withErrors(response, async () => {
      const body = await readJson<Record<string, unknown>>(request);
      return { status: 200, payload: sessionPayload(await app.auth.login(body ?? {})) };
    });
  }

  // The catalog is not secret and the app needs it before anyone signs in, so the card list and the
  // flowchart answer unauthenticated. Live offers do too — they are a public web page.
  if (method === 'GET' && path === '/v1/catalog') return send(response, 200, catalogPayload());
  if (method === 'GET' && path === '/v1/bank-offers') {
    const snapshot = loadBankOffers();
    return send(response, 200, { fetchedAt: snapshot.fetchedAt, source: snapshot.source, offers: snapshot.offers });
  }
  if (method === 'GET' && path === '/v1/rules') {
    return send(response, 200, {
      rules: RULES.map((rule) => ({ id: rule.id, issuer: rule.issuer, title: rule.title })),
    });
  }

  // ---- the web app ------------------------------------------------------
  //
  // Before authentication and after the API routes. The order matters in both directions: a static
  // file must not need a bearer token, and a path under `/v1` must never be answerable from disk.
  // Anything that is not an API route is offered to the static handler, which is also what makes a
  // deep link like `/card/abc` load the app rather than 404 — see `resolveWebFile`.
  if (!path.startsWith('/v1')) {
    if (method === 'GET' || method === 'HEAD') {
      const { served } = await serveStatic(request, response, path);
      if (served) return;
    }
    // Nothing outside `/v1` and `/health` is an API route, so a miss here is a 404 and the request
    // must not fall through to the bearer-token check. It used to, which answered a request for a
    // missing asset with 401 — telling the client to authenticate for a file that does not exist.
    return send(response, 404, { error: 'no such route' });
  }

  // ---- authenticated ----------------------------------------------------

  const token = bearerToken(request.headers.authorization);
  const user = app.auth.authenticate(token);
  if (user === null) return send(response, 401, { error: 'unauthorised' });

  const context: Context = {
    app,
    request,
    response,
    url,
    method,
    parts: pathSegments(path),
    user,
    token,
  };

  return await withErrors(response, () => route(context));
}

type Handled = { status: number; payload: unknown };

async function route(context: Context): Promise<Handled> {
  const { app, method, parts, user } = context;
  // `/v1/cards/abc/dismiss` -> resource 'cards', id 'abc', action 'dismiss'. The leading 'v1' is
  // dropped; there is one version and a second would be a different prefix, not a different shape.
  const [, resource, id, action] = parts;

  if (resource === 'me' && method === 'GET') {
    return { status: 200, payload: { user, players: app.store.players(user.id) } };
  }

  if (resource === 'auth' && id === 'logout' && method === 'POST') {
    app.auth.logout(context.token);
    return { status: 200, payload: { ok: true } };
  }

  if (resource === 'auth' && id === 'password' && method === 'POST') {
    const body = await readJson<{ currentPassword?: unknown; newPassword?: unknown }>(context.request);
    const session = await app.auth.changePassword(user, body?.currentPassword, body?.newPassword);
    return { status: 200, payload: sessionPayload(session) };
  }

  if (resource === 'players') return await players(context, id, method);
  if (resource === 'devices') return await devices(context, method);
  if (resource === 'sync') return await sync(context, method);
  if (resource === 'admin') return await admin(context, id, method);

  // Everything below is scoped to a player.
  if (['cards', 'banks', 'inquiries', 'standing', 'reminders', 'plan', 'assess'].includes(resource ?? '')) {
    const player = resolvePlayer(context);
    switch (resource) {
      case 'cards':
        return await cards(context, player, id, method);
      case 'banks':
        return await banks(context, player, id, method);
      case 'inquiries':
        return await inquiries(context, player, id, method);
      // The three read-only views check the method themselves. Without it the switch answered a
      // PATCH to /v1/standing with a cheerful 200 — harmless, but it teaches a client that the
      // write succeeded.
      case 'standing':
        return method === 'GET'
          ? { status: 200, payload: standing(app.store.playerState(player), asOfFrom(context)) }
          : { status: 405, payload: { error: 'method not allowed' } };
      case 'plan':
        return method === 'GET' ? planRoute(context, player) : { status: 405, payload: { error: 'method not allowed' } };
      case 'assess':
        return method === 'GET'
          ? assessRoute(context, player)
          : { status: 405, payload: { error: 'method not allowed' } };
      case 'reminders':
        return remindersRoute(context, player, id, action, method);
      default:
        break;
    }
  }

  return { status: 404, payload: { error: 'no such route' } };
}

// ---- players --------------------------------------------------------------

async function players(context: Context, id: string | undefined, method: string): Promise<Handled> {
  const { app, user } = context;

  if (method === 'GET' && id === undefined) {
    return { status: 200, payload: { players: app.store.players(user.id) } };
  }

  if (method === 'POST' && id === undefined) {
    const body = await readJson<{ name?: unknown }>(context.request);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (name === '') return { status: 400, payload: { error: 'name is required' } };

    const now = new Date().toISOString();
    const player: Player = {
      id: crypto.randomUUID(),
      userId: user.id,
      name: name.slice(0, 80),
      // The first player is the primary one; every later one is a second player in the flowchart's
      // sense, not a replacement.
      primary: app.store.players(user.id).length === 0,
      createdAt: now,
    };
    app.store.createPlayer(player, now);
    return { status: 201, payload: { player } };
  }

  if (id === undefined) return { status: 405, payload: { error: 'method not allowed' } };

  if (method === 'PATCH') {
    const body = await readJson<{ name?: unknown }>(context.request);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (name === '') return { status: 400, payload: { error: 'name is required' } };
    const ok = app.store.renamePlayer(user.id, id, name.slice(0, 80), new Date().toISOString());
    return ok ? { status: 200, payload: { ok: true } } : { status: 404, payload: { error: 'no such player' } };
  }

  if (method === 'DELETE') {
    if (app.store.players(user.id).length <= 1) {
      // Deleting the last player would leave every screen with nothing to render and no way back.
      return { status: 409, payload: { error: 'cannot delete your only player' } };
    }
    const ok = app.store.deletePlayer(user.id, id, new Date().toISOString());
    return ok ? { status: 200, payload: { ok: true } } : { status: 404, payload: { error: 'no such player' } };
  }

  return { status: 405, payload: { error: 'method not allowed' } };
}

// ---- card accounts -------------------------------------------------------

async function cards(context: Context, player: Player, id: string | undefined, method: string): Promise<Handled> {
  const { app } = context;

  if (method === 'GET' && id === undefined) {
    return { status: 200, payload: { cards: app.store.cards(player.id) } };
  }

  if (method === 'POST' && id === undefined) {
    const body = await readJson<Record<string, unknown>>(context.request);
    const account = newCardAccount({ ...(body ?? {}), playerId: player.id });
    app.store.upsertCard(account);
    return { status: 201, payload: { card: account } };
  }

  if (id === undefined) return { status: 405, payload: { error: 'method not allowed' } };

  if (method === 'GET') {
    const account = app.store.card(player.id, id);
    return account === null
      ? { status: 404, payload: { error: 'no such card' } }
      : { status: 200, payload: { card: account } };
  }

  if (method === 'PATCH') {
    const existing = app.store.card(player.id, id);
    if (existing === null) return { status: 404, payload: { error: 'no such card' } };

    const body = await readJson<Record<string, unknown>>(context.request);
    // Rebuilt through the validator from the merge rather than patched in place, so a partial edit
    // is checked against the same rules as a creation — a PATCH that sets `status: 'closed'` with
    // no `closedAt` has to fail the same way a POST would.
    const merged = newCardAccount(
      { ...existing, ...(body ?? {}), id: existing.id, playerId: player.id },
      existing.createdAt,
    );
    const updated = { ...merged, createdAt: existing.createdAt, updatedAt: new Date().toISOString() };
    app.store.upsertCard(updated);
    return { status: 200, payload: { card: updated } };
  }

  if (method === 'DELETE') {
    const ok = app.store.deleteCard(player.id, id, new Date().toISOString());
    return ok ? { status: 200, payload: { ok: true } } : { status: 404, payload: { error: 'no such card' } };
  }

  return { status: 405, payload: { error: 'method not allowed' } };
}

// ---- bank accounts ------------------------------------------------------

async function banks(context: Context, player: Player, id: string | undefined, method: string): Promise<Handled> {
  const { app } = context;

  if (method === 'GET' && id === undefined) {
    return { status: 200, payload: { banks: app.store.banks(player.id) } };
  }

  if (method === 'POST' && id === undefined) {
    const body = (await readJson<Record<string, unknown>>(context.request)) ?? {};
    const account = newBankAccount({ ...body, playerId: player.id });
    // Filled in only when the client did not say and the bonus has a real clawback risk. A
    // suggestion, and flagged as one in the response so the UI can ask.
    const suggested =
      account.closeNotBeforeAt === null && account.openedAt !== null && account.bonusCents > 0
        ? suggestedCloseNotBefore(account.openedAt)
        : null;
    const stored = suggested === null ? account : { ...account, closeNotBeforeAt: suggested };
    app.store.upsertBank(stored);
    return { status: 201, payload: { bank: stored, closeNotBeforeAtWasSuggested: suggested !== null } };
  }

  if (id === undefined) return { status: 405, payload: { error: 'method not allowed' } };

  if (method === 'GET') {
    const account = app.store.bank(player.id, id);
    return account === null
      ? { status: 404, payload: { error: 'no such bank account' } }
      : { status: 200, payload: { bank: account } };
  }

  if (method === 'PATCH') {
    const existing = app.store.bank(player.id, id);
    if (existing === null) return { status: 404, payload: { error: 'no such bank account' } };
    const body = await readJson<Record<string, unknown>>(context.request);
    const merged = newBankAccount(
      { ...existing, ...(body ?? {}), id: existing.id, playerId: player.id },
      existing.createdAt,
    );
    const updated = { ...merged, createdAt: existing.createdAt, updatedAt: new Date().toISOString() };
    app.store.upsertBank(updated);
    return { status: 200, payload: { bank: updated } };
  }

  if (method === 'DELETE') {
    const ok = app.store.deleteBank(player.id, id, new Date().toISOString());
    return ok ? { status: 200, payload: { ok: true } } : { status: 404, payload: { error: 'no such bank account' } };
  }

  return { status: 405, payload: { error: 'method not allowed' } };
}

// ---- inquiries ---------------------------------------------------------

async function inquiries(context: Context, player: Player, id: string | undefined, method: string): Promise<Handled> {
  const { app } = context;

  if (method === 'GET' && id === undefined) {
    return { status: 200, payload: { inquiries: app.store.inquiries(player.id) } };
  }

  if (method === 'POST' && id === undefined) {
    const body = (await readJson<Record<string, unknown>>(context.request)) ?? {};
    if (!isIsoDate(body.at)) throw new ValidationError('at', 'at must be a YYYY-MM-DD date');

    const bureau = ['experian', 'equifax', 'transunion', 'unknown'].includes(String(body.bureau))
      ? (body.bureau as Inquiry['bureau'])
      : 'unknown';
    const issuer = Object.keys(ISSUER_NAMES).includes(String(body.issuer))
      ? (body.issuer as IssuerId)
      : 'other';

    const inquiry: Inquiry = {
      id: typeof body.id === 'string' && body.id !== '' ? body.id : crypto.randomUUID(),
      playerId: player.id,
      bureau,
      issuer,
      at: body.at,
      cardAccountId: typeof body.cardAccountId === 'string' ? body.cardAccountId : null,
      notes: typeof body.notes === 'string' ? body.notes : '',
    };
    const now = new Date().toISOString();
    app.store.upsertInquiry(inquiry, { createdAt: now, updatedAt: now });
    return { status: 201, payload: { inquiry } };
  }

  if (id !== undefined && method === 'DELETE') {
    const ok = app.store.deleteInquiry(player.id, id, new Date().toISOString());
    return ok ? { status: 200, payload: { ok: true } } : { status: 404, payload: { error: 'no such inquiry' } };
  }

  return { status: 405, payload: { error: 'method not allowed' } };
}

// ---- derived views ----------------------------------------------------

function remindersRoute(
  context: Context,
  player: Player,
  id: string | undefined,
  action: string | undefined,
  method: string,
): Handled {
  const { app } = context;
  const asOf = asOfFrom(context);

  if (method === 'GET' && id === undefined) {
    const state = app.store.playerState(player);
    const dismissed = app.store.dismissed(player.id);
    return {
      status: 200,
      payload: {
        asOf,
        // `all` so the UI can offer "show dismissed" without a second request, and `active` so the
        // common case needs no client-side filtering.
        active: activeReminders(state, asOf, dismissed),
        all: reminders(state, asOf),
        dismissed: [...dismissed],
      },
    };
  }

  if (method === 'POST' && id !== undefined && action === 'dismiss') {
    app.store.dismissReminder(player.id, id, new Date().toISOString());
    return { status: 200, payload: { ok: true } };
  }

  if (method === 'DELETE' && id !== undefined && action === 'dismiss') {
    app.store.undismissReminder(player.id, id);
    return { status: 200, payload: { ok: true } };
  }

  return { status: 405, payload: { error: 'method not allowed' } };
}

function planRoute(context: Context, player: Player): Handled {
  const { app, url } = context;
  const goal: Goal = url.searchParams.get('goal') === 'cashback' ? 'cashback' : 'travel';

  const number = (key: string): number => {
    const raw = Number(url.searchParams.get(key));
    return Number.isFinite(raw) && raw >= 0 ? raw : 0;
  };

  const exclude = (url.searchParams.get('excludeIssuers') ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part): part is IssuerId => part !== '' && part in ISSUER_NAMES);

  const snapshot = loadCardOffers();
  const result = plan({
    state: app.store.playerState(player),
    asOf: asOfFrom(context),
    offers: snapshot.offers,
    preferences: {
      goal,
      // Absent means yes: the flowchart assumes business cards are available and its under-5/24
      // strategy largely collapses without them.
      businessCards: url.searchParams.get('businessCards') !== 'false',
      monthlyRentCents: number('monthlyRentCents'),
      maxMinSpendCents: number('maxMinSpendCents'),
      excludeIssuers: exclude,
    },
  });

  return { status: 200, payload: { ...result, offersFetchedAt: snapshot.fetchedAt } };
}

function assessRoute(context: Context, player: Player): Handled {
  const { app, url } = context;
  const cardId = url.searchParams.get('cardId');
  if (cardId === null) return { status: 400, payload: { error: 'cardId is required' } };

  const catalog = Object.fromEntries(CARDS.map((card) => [card.id, card]));
  const target = catalog[cardId];
  if (target === undefined) return { status: 404, payload: { error: 'no such card in the catalog' } };

  const state = app.store.playerState(player);
  const asOf = asOfFrom(context);
  const offer = loadCardOffers().offers.find((entry) => entry.cardId === cardId) ?? null;

  return {
    status: 200,
    payload: {
      card: { ...target, familyLabel: familyName(target.family) },
      offer,
      assessment: assess({ state, target, asOf, catalog }),
      standing: standing(state, asOf),
    },
  };
}

// ---- devices ---------------------------------------------------------

async function devices(context: Context, method: string): Promise<Handled> {
  const { app, user } = context;

  if (method === 'GET') {
    // Tokens are not echoed back: there is no use for them on the client that registered them, and
    // a response that carries every device's push token is a needless way to leak them all at once.
    return {
      status: 200,
      payload: {
        devices: app.store
          .devices(user.id)
          .map((device) => ({ id: device.id, platform: device.platform, createdAt: device.createdAt })),
      },
    };
  }

  if (method === 'POST') {
    const body = await readJson<{ pushToken?: unknown; platform?: unknown }>(context.request);
    const pushToken = typeof body?.pushToken === 'string' ? body.pushToken.trim() : '';
    if (!/^Expo(nent)?PushToken\[[^\]]+\]$/.test(pushToken)) {
      return { status: 400, payload: { error: 'pushToken must be an Expo push token' } };
    }
    const platform = ['ios', 'android', 'web'].includes(String(body?.platform))
      ? (body?.platform as 'ios' | 'android' | 'web')
      : 'ios';

    app.store.registerDevice({
      id: crypto.randomUUID(),
      userId: user.id,
      pushToken,
      platform,
      createdAt: new Date().toISOString(),
      failedAt: null,
    });
    return { status: 201, payload: { ok: true } };
  }

  if (method === 'DELETE') {
    const pushToken = context.url.searchParams.get('pushToken') ?? '';
    const ok = app.store.deleteDevice(user.id, pushToken);
    return ok ? { status: 200, payload: { ok: true } } : { status: 404, payload: { error: 'no such device' } };
  }

  return { status: 405, payload: { error: 'method not allowed' } };
}

// ---- sync -----------------------------------------------------------

/**
 * Pull with `?since=`, push with a POST.
 *
 * Last-write-wins per row on `updatedAt`, which is crude and correct for the conflict that actually
 * happens here: one person correcting the same open date on two devices. A CRDT would be solving a
 * problem this app does not have.
 *
 * A rejected row is reported rather than silently dropped, so the client knows to take the server's
 * copy instead of believing its own write landed.
 */
async function sync(context: Context, method: string): Promise<Handled> {
  const { app, user } = context;

  if (method === 'GET') {
    const since = context.url.searchParams.get('since') ?? '1970-01-01T00:00:00.000Z';
    return {
      status: 200,
      payload: { ...app.store.changedSince(user.id, since), serverTime: new Date().toISOString() },
    };
  }

  if (method !== 'POST') return { status: 405, payload: { error: 'method not allowed' } };

  const body = await readJson<{
    cards?: unknown[];
    banks?: unknown[];
    inquiries?: unknown[];
  }>(context.request);

  const owned = new Set(app.store.players(user.id).map((player) => player.id));
  const applied: string[] = [];
  const rejected: Array<{ id: string; reason: string }> = [];

  /**
   * The client's own timestamps, which last-write-wins depends on.
   *
   * `newCardAccount` sets both `createdAt` and `updatedAt` from its `now` argument, because for a
   * fresh account they are the same moment. On a sync upload they are not: the row was created on
   * the phone last March and edited there this morning, and it is the edit time that decides
   * whether it beats what the server holds. Taking `updatedAt` from `createdAt` made every upload
   * look as old as the row itself, so a genuinely stale edit won.
   */
  const stamps = (input: Record<string, unknown>): { createdAt: string; updatedAt: string } => {
    const now = new Date().toISOString();
    return {
      createdAt: typeof input.createdAt === 'string' ? input.createdAt : now,
      updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : now,
    };
  };

  app.store.transaction(() => {
    for (const raw of body?.cards ?? []) {
      const input = raw as Record<string, unknown>;
      const id = String(input.id ?? '');
      try {
        if (!owned.has(String(input.playerId))) throw new Error('not your player');
        const when = stamps(input);
        const account = { ...newCardAccount(input as never, when.createdAt), updatedAt: when.updatedAt };
        const existing = app.store.updatedAtOf('card_accounts', account.id);
        if (existing !== null && existing >= account.updatedAt) {
          rejected.push({ id, reason: 'the server has a newer version' });
          continue;
        }
        app.store.upsertCard(account);
        applied.push(account.id);
      } catch (error) {
        rejected.push({ id, reason: error instanceof Error ? error.message : String(error) });
      }
    }

    for (const raw of body?.banks ?? []) {
      const input = raw as Record<string, unknown>;
      const id = String(input.id ?? '');
      try {
        if (!owned.has(String(input.playerId))) throw new Error('not your player');
        const when = stamps(input);
        const account = { ...newBankAccount(input as never, when.createdAt), updatedAt: when.updatedAt };
        const existing = app.store.updatedAtOf('bank_accounts', account.id);
        if (existing !== null && existing >= account.updatedAt) {
          rejected.push({ id, reason: 'the server has a newer version' });
          continue;
        }
        app.store.upsertBank(account);
        applied.push(account.id);
      } catch (error) {
        rejected.push({ id, reason: error instanceof Error ? error.message : String(error) });
      }
    }

    for (const raw of body?.inquiries ?? []) {
      const input = raw as Record<string, unknown>;
      const id = String(input.id ?? '');
      try {
        if (!owned.has(String(input.playerId))) throw new Error('not your player');
        if (!isIsoDate(input.at)) throw new Error('at must be a YYYY-MM-DD date');
        app.store.upsertInquiry(
          {
            id: id === '' ? crypto.randomUUID() : id,
            playerId: String(input.playerId),
            bureau: input.bureau as Inquiry['bureau'],
            issuer: input.issuer as IssuerId,
            at: input.at,
            cardAccountId: typeof input.cardAccountId === 'string' ? input.cardAccountId : null,
            notes: typeof input.notes === 'string' ? input.notes : '',
          },
          stamps(input),
        );
        applied.push(id);
      } catch (error) {
        rejected.push({ id, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  });

  return { status: 200, payload: { applied, rejected, serverTime: new Date().toISOString() } };
}

// ---- admin ----------------------------------------------------------

/**
 * Operator endpoints, available to any signed-in user.
 *
 * Not a privilege escalation: this is a single-household server, and the only actions here are
 * re-scraping a public web page, sending yourself a notification, and reading a log that carries no
 * secrets. A role system would be ceremony over a server with one or two accounts.
 */
async function admin(context: Context, id: string | undefined, method: string): Promise<Handled> {
  const { app } = context;

  if (method === 'GET' && id === 'status') {
    return { status: 200, payload: { ...health(app), stats: app.store.stats(), config: app.settings.read() } };
  }

  if (method === 'GET' && id === 'logs') {
    return { status: 200, payload: { logs: app.store.recentLogs() } };
  }

  if (method === 'POST' && id === 'refresh') {
    const force = context.url.searchParams.get('force') === 'true';
    return { status: 200, payload: await refresh({ force }) };
  }

  if (method === 'POST' && id === 'notify') {
    return { status: 200, payload: await notifyEveryone(app.store, app.settings, asOfFrom(context)) };
  }

  if (method === 'PATCH' && id === 'settings') {
    const body = await readJson<Record<string, string | null>>(context.request);
    app.settings.update(body ?? {});
    return { status: 200, payload: { config: app.settings.read() } };
  }

  return { status: 404, payload: { error: 'no such route' } };
}

// ---- helpers --------------------------------------------------------

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Path segments, percent-decoded.
 *
 * `URL.pathname` stays encoded, and the decoding is not optional here: a reminder id is
 * `annual-fee-due:<uuid>:2026-11-20`, whose colons a client will send as `%3A`. Splitting without
 * decoding hands the dismiss handler a string that matches no reminder — and because dismissing is
 * an idempotent insert, it answered 200 and silently did nothing.
 *
 * A malformed escape decodes to itself rather than throwing, so a stray `%` in a URL is a 404
 * instead of a 500.
 */
function pathSegments(path: string): string[] {
  return path
    .split('/')
    .filter((part) => part !== '')
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
}

/**
 * The player named by `?playerId=`, or the primary one.
 *
 * Defaulting rather than requiring it keeps every URL short in the single-player case, which is
 * most of them. Ownership is enforced by `playerFor`, and a player belonging to someone else is a
 * 404 rather than a 403 — there is no reason to confirm that an id exists.
 */
function resolvePlayer(context: Context): Player {
  const { app, user } = context;
  const requested = context.url.searchParams.get('playerId');
  const all = app.store.players(user.id);

  if (requested === null) {
    const player = all[0];
    if (player === undefined) throw new HttpError(409, 'this account has no players');
    return player;
  }

  const player = all.find((entry) => entry.id === requested);
  if (player === undefined) throw new HttpError(404, 'no such player');
  return player;
}

/**
 * `?asOf=` for the date to evaluate against, defaulting to today.
 *
 * Overridable because every rule takes the date as a parameter, and being able to ask "what will my
 * 5/24 be in March" is genuinely useful — the flowchart's timing panel is entirely about that
 * question. It reads nothing and writes nothing, so there is nothing to abuse.
 */
function asOfFrom(context: Context): string {
  const raw = context.url.searchParams.get('asOf');
  return raw !== null && isIsoDate(raw) ? raw : today();
}

function health(app: App): Record<string, unknown> {
  const cards = loadCardOffers();
  const banks = loadBankOffers();
  return {
    ok: true,
    service: 'churn-tracker',
    now: new Date().toISOString(),
    catalog: { cards: CARDS.length },
    flowchart: { version: FLOWCHART.version, updatedAt: FLOWCHART.updatedAt },
    offers: {
      cards: cards.offers.length,
      banks: banks.offers.length,
      cardsFetchedAt: cards.fetchedAt || null,
      banksFetchedAt: banks.fetchedAt || null,
    },
    registrationOpen: app.settings.read().openRegistration,
    // So the app can tell whether it is being served by its own API — which is what lets the sign-in
    // screen skip asking for a server address.
    servesWebApp: serveWeb(),
  };
}

function catalogPayload(): Record<string, unknown> {
  const snapshot = loadCardOffers();
  return {
    cards: CARDS.map((card) => ({ ...card, familyLabel: familyName(card.family) })),
    issuers: ISSUER_NAMES,
    offers: snapshot.offers,
    offersFetchedAt: snapshot.fetchedAt,
    flowchart: {
      version: FLOWCHART.version,
      updatedAt: FLOWCHART.updatedAt,
      source: FLOWCHART.source,
      sections: FLOWCHART.sections,
    },
  };
}

function sessionPayload(session: {
  token: string;
  expiresAt: number;
  user: User;
  players: Player[];
}): Record<string, unknown> {
  return {
    token: session.token,
    expiresAt: new Date(session.expiresAt).toISOString(),
    expiresInSeconds: SESSION_TTL_SECONDS,
    user: session.user,
    players: session.players,
  };
}

/**
 * Turns the three error types the handlers throw into responses.
 *
 * One place, so no handler has to remember: `ValidationError` is a 400 that names the field,
 * `AuthError` and `HttpError` carry their own status, and anything else is a 500 that logs the real
 * message and tells the client nothing.
 */
async function withErrors(response: ServerResponse, work: () => Promise<Handled>): Promise<void> {
  try {
    const { status, payload } = await work();
    send(response, status, payload);
  } catch (error) {
    if (error instanceof ValidationError) {
      send(response, 400, { error: error.message, field: error.field });
      return;
    }
    if (error instanceof AuthError || error instanceof HttpError) {
      send(response, error.status, { error: error.message });
      return;
    }
    throw error;
  }
}

export function send(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    // Nothing here is cacheable: every response is either a derived view of the user's own data or
    // a session token.
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

/** A JSON body, capped. Returns null for an empty or unparseable body. */
async function readJson<T>(request: IncomingMessage): Promise<T | null> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    // A sync upload of a long churning history is still only tens of kilobytes. A megabyte is
    // generous and stops an unbounded body from being a memory attack.
    if (size > 1_048_576) throw new HttpError(413, 'request body too large');
    chunks.push(buffer);
  }

  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw new HttpError(400, 'body was not valid JSON');
  }
}
