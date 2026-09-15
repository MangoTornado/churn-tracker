/**
 * The HTTP surface, end to end, against an in-memory database.
 *
 * In memory and with background work off: these tests are about routing, authorisation and the
 * derived views, and a test that reaches the network is a test that fails on a train.
 *
 * The authorisation tests are the ones worth keeping honest. Everything behind `/v1` is one user's
 * complete financial history, and the failure mode to prevent is not a crash — it is a 200 with
 * somebody else's cards in it.
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';

import { createApp, start, stop, type App } from '../src/server/server.ts';

let app: App;
let server: ReturnType<typeof start>;
let base: string;

/** Two separate accounts, so cross-account access can actually be attempted. */
let alice: { token: string; playerId: string };
let bob: { token: string; playerId: string };

const PASSWORD = 'a-perfectly-fine-password';

before(async () => {
  app = createApp(':memory:');
  app.settings.update({ 'auth.openRegistration': '1' });

  server = start(app, { host: '127.0.0.1', port: 0, quiet: true, background: false });
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  alice = await register('alice@example.com');
  bob = await register('bob@example.com');
});

after(() => {
  server.close();
  stop(app);
  app.store.close();
});

// ---- helpers -------------------------------------------------------------

async function call(
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : JSON.parse(text) };
}

async function register(email: string): Promise<{ token: string; playerId: string }> {
  const created = await call('POST', '/v1/auth/register', { body: { email, password: PASSWORD, name: 'Me' } });
  assert.equal(created.status, 201, `register ${email}: ${JSON.stringify(created.body)}`);
  return { token: created.body.token, playerId: created.body.players[0].id };
}

async function addCard(who: { token: string }, body: Record<string, unknown>): Promise<string> {
  const created = await call('POST', '/v1/cards', { token: who.token, body });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.card.id;
}

// ---- health and the unauthenticated surface -----------------------------

test('the health endpoint answers unauthenticated', async () => {
  // It is the container healthcheck, so it must need no credential — and it must therefore carry
  // nothing worth reading.
  const it = await call('GET', '/health');
  assert.equal(it.status, 200);
  assert.equal(it.body.ok, true);
  assert.ok(it.body.catalog.cards > 80);
  assert.match(it.body.flowchart.version, /Flowchart v\d+/);
  assert.equal(JSON.stringify(it.body).includes('password'), false);
});

test('the catalog answers unauthenticated because the app needs it before sign-in', async () => {
  const it = await call('GET', '/v1/catalog');
  assert.equal(it.status, 200);
  assert.ok(it.body.cards.length > 80);
  assert.ok(it.body.flowchart.sections.under524Approach.body.length > 100);
  // The display label travels with the card, so no UI has to know about family slugs.
  const sapphire = it.body.cards.find((card: any) => card.id === 'chase-sapphire-preferred');
  assert.equal(sapphire.familyLabel, 'Sapphire');
});

test('the rule list is published so a user can see what the app believes', async () => {
  const it = await call('GET', '/v1/rules');
  assert.equal(it.status, 200);
  assert.ok(it.body.rules.some((rule: any) => rule.id === 'chase-5-24'));
});

test('everything else needs a token', async () => {
  for (const [method, path] of [
    ['GET', '/v1/me'],
    ['GET', '/v1/cards'],
    ['GET', '/v1/standing'],
    ['GET', '/v1/reminders'],
    ['GET', '/v1/plan'],
    ['GET', '/v1/sync'],
    ['GET', '/v1/admin/status'],
  ] as const) {
    assert.equal((await call(method, path)).status, 401, `${method} ${path} should be closed`);
  }
});

test('a wrong or malformed token is rejected', async () => {
  assert.equal((await call('GET', '/v1/me', { token: 'not-a-real-token' })).status, 401);
  assert.equal((await call('GET', '/v1/me', { token: '' })).status, 401);
});

// ---- registration and login --------------------------------------------

test('a duplicate registration is a clear conflict', async () => {
  const it = await call('POST', '/v1/auth/register', {
    body: { email: 'alice@example.com', password: PASSWORD },
  });
  assert.equal(it.status, 409);
});

test('email is normalised, so case and whitespace do not make a second account', async () => {
  const it = await call('POST', '/v1/auth/register', {
    body: { email: '  ALICE@Example.com ', password: PASSWORD },
  });
  assert.equal(it.status, 409);
});

test('a short password is refused', async () => {
  const it = await call('POST', '/v1/auth/register', { body: { email: 'short@example.com', password: 'abc' } });
  assert.equal(it.status, 400);
  assert.match(it.body.error, /at least 12/);
});

test('a bad email is refused', async () => {
  for (const email of ['not-an-email', 'a@b', '@example.com', '']) {
    const it = await call('POST', '/v1/auth/register', { body: { email, password: PASSWORD } });
    assert.equal(it.status, 400, `${email} should be refused`);
  }
});

test('login works and a wrong password does not', async () => {
  const good = await call('POST', '/v1/auth/login', { body: { email: 'alice@example.com', password: PASSWORD } });
  assert.equal(good.status, 200);
  assert.ok(good.body.token);
  assert.equal(good.body.user.email, 'alice@example.com');

  const bad = await call('POST', '/v1/auth/login', { body: { email: 'alice@example.com', password: 'wrong' } });
  assert.equal(bad.status, 401);
});

test('login says the same thing for an unknown address as for a wrong password', async () => {
  // Response bodies at least; the timing equalisation is in `auth.ts` and not observable from here.
  const unknown = await call('POST', '/v1/auth/login', { body: { email: 'nobody@example.com', password: PASSWORD } });
  const wrong = await call('POST', '/v1/auth/login', { body: { email: 'alice@example.com', password: 'wrong' } });
  assert.equal(unknown.status, wrong.status);
  assert.deepEqual(unknown.body, wrong.body);
});

test('registration is refused when the server has it closed', async () => {
  app.settings.update({ 'auth.openRegistration': '0' });
  try {
    const it = await call('POST', '/v1/auth/register', { body: { email: 'late@example.com', password: PASSWORD } });
    assert.equal(it.status, 403);
  } finally {
    app.settings.update({ 'auth.openRegistration': '1' });
  }
});

test('logging out invalidates that token and no other', async () => {
  const session = await call('POST', '/v1/auth/login', { body: { email: 'bob@example.com', password: PASSWORD } });
  const throwaway = session.body.token;

  assert.equal((await call('GET', '/v1/me', { token: throwaway })).status, 200);
  assert.equal((await call('POST', '/v1/auth/logout', { token: throwaway })).status, 200);
  assert.equal((await call('GET', '/v1/me', { token: throwaway })).status, 401);
  assert.equal((await call('GET', '/v1/me', { token: bob.token })).status, 200, "bob's other session survives");
});

test('changing a password signs out other sessions and hands back a working one', async () => {
  const throwaway = await register('rotate@example.com');
  const second = await call('POST', '/v1/auth/login', { body: { email: 'rotate@example.com', password: PASSWORD } });

  const changed = await call('POST', '/v1/auth/password', {
    token: throwaway.token,
    body: { currentPassword: PASSWORD, newPassword: 'an-entirely-new-password' },
  });
  assert.equal(changed.status, 200);
  assert.ok(changed.body.token);

  assert.equal((await call('GET', '/v1/me', { token: second.body.token })).status, 401, 'old sessions are gone');
  assert.equal((await call('GET', '/v1/me', { token: changed.body.token })).status, 200, 'the new one works');
});

test('changing a password needs the current one', async () => {
  const it = await call('POST', '/v1/auth/password', {
    token: alice.token,
    body: { currentPassword: 'wrong', newPassword: 'another-fine-password' },
  });
  assert.equal(it.status, 401);
});

// ---- ownership, which is the thing that must never break --------------

test("one user cannot read another's cards by naming their player", async () => {
  await addCard(bob, { cardId: 'chase-sapphire-preferred', openedAt: '2026-01-01' });

  const it = await call('GET', `/v1/cards?playerId=${bob.playerId}`, { token: alice.token });
  // A 404 rather than a 403: there is no reason to confirm that the id exists.
  assert.equal(it.status, 404);
});

test("one user cannot write to another's player", async () => {
  const it = await call('POST', '/v1/cards?playerId=' + bob.playerId, {
    token: alice.token,
    body: { cardId: 'amex-gold', openedAt: '2026-01-01' },
  });
  assert.equal(it.status, 404);
});

test("one user cannot delete another's card by id", async () => {
  const bobsCard = await addCard(bob, { cardId: 'amex-platinum', openedAt: '2026-02-01' });
  const it = await call('DELETE', `/v1/cards/${bobsCard}`, { token: alice.token });
  assert.equal(it.status, 404);
  assert.equal((await call('GET', `/v1/cards/${bobsCard}`, { token: bob.token })).status, 200, 'still there');
});

test("a sync upload naming another user's player is rejected per row", async () => {
  const it = await call('POST', '/v1/sync', {
    token: alice.token,
    body: {
      cards: [
        {
          id: crypto.randomUUID(),
          playerId: bob.playerId,
          cardId: 'chase-freedom-flex',
          openedAt: '2026-01-01',
          updatedAt: new Date().toISOString(),
        },
      ],
    },
  });
  assert.equal(it.status, 200);
  assert.equal(it.body.applied.length, 0);
  assert.match(it.body.rejected[0].reason, /not your player/);
});

test('a sync pull returns only your own rows', async () => {
  const it = await call('GET', '/v1/sync?since=1970-01-01T00:00:00.000Z', { token: alice.token });
  assert.equal(it.status, 200);
  const playerIds = new Set(it.body.cards.map((row: any) => row.record?.playerId).filter(Boolean));
  assert.ok(!playerIds.has(bob.playerId));
});

// ---- cards -----------------------------------------------------------

test('a card is created with its catalog details filled in', async () => {
  const created = await call('POST', '/v1/cards', {
    token: alice.token,
    body: { cardId: 'chase-sapphire-reserve', openedAt: '2026-03-01' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.card.cardName, 'Chase Sapphire Reserve');
  assert.equal(created.body.card.annualFeeCents, 79_500);
  assert.equal(created.body.card.counts524, true);
});

test('a malformed date is a 400 naming the field, not a wrong 5/24 count', async () => {
  const it = await call('POST', '/v1/cards', {
    token: alice.token,
    body: { cardId: 'amex-gold', openedAt: '2026-13-45' },
  });
  assert.equal(it.status, 400);
  assert.equal(it.body.field, 'openedAt');
});

test('a patch is validated against the same rules as a creation', async () => {
  const id = await addCard(alice, { cardId: 'chase-ink-cash', openedAt: '2026-04-01' });
  // Closing without a closedAt has to fail exactly as it would on a POST.
  const bad = await call('PATCH', `/v1/cards/${id}`, { token: alice.token, body: { status: 'closed' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.field, 'closedAt');

  const good = await call('PATCH', `/v1/cards/${id}`, {
    token: alice.token,
    body: { status: 'closed', closedAt: '2026-08-01' },
  });
  assert.equal(good.status, 200);
  assert.equal(good.body.card.status, 'closed');
});

test('a patch preserves createdAt and moves updatedAt', async () => {
  const id = await addCard(alice, { cardId: 'chase-freedom-unlimited', openedAt: '2026-05-01' });
  const before = (await call('GET', `/v1/cards/${id}`, { token: alice.token })).body.card;
  const after = (await call('PATCH', `/v1/cards/${id}`, { token: alice.token, body: { notes: 'keeper' } })).body.card;

  assert.equal(after.createdAt, before.createdAt);
  assert.ok(after.updatedAt >= before.updatedAt);
  assert.equal(after.notes, 'keeper');
});

test('a deleted card disappears from reads but is a tombstone in sync', async () => {
  // Which is the whole point of soft deletion: without the tombstone the row silently reappears on
  // the next upload from a device that still has it.
  const id = await addCard(alice, { cardId: 'chase-aeroplan', openedAt: '2026-06-01' });
  assert.equal((await call('DELETE', `/v1/cards/${id}`, { token: alice.token })).status, 200);
  assert.equal((await call('GET', `/v1/cards/${id}`, { token: alice.token })).status, 404);

  const synced = await call('GET', '/v1/sync?since=1970-01-01T00:00:00.000Z', { token: alice.token });
  const row = synced.body.cards.find((entry: any) => entry.id === id);
  assert.equal(row.deleted, true);
  assert.equal(row.record, null);
});

test('deleting a card twice is a 404 the second time', async () => {
  const id = await addCard(alice, { cardId: 'chase-british-airways', openedAt: '2026-06-15' });
  assert.equal((await call('DELETE', `/v1/cards/${id}`, { token: alice.token })).status, 200);
  assert.equal((await call('DELETE', `/v1/cards/${id}`, { token: alice.token })).status, 404);
});

test('a card outside the catalog is accepted with its own details', async () => {
  const created = await call('POST', '/v1/cards', {
    token: alice.token,
    body: { cardName: 'Local Credit Union Visa', issuer: 'other', openedAt: '2026-02-02' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.card.cardId, null);
  assert.equal(created.body.card.counts524, true);
});

// ---- bank accounts --------------------------------------------------

test('a bank account gets a suggested safe-to-close date, flagged as a suggestion', async () => {
  const created = await call('POST', '/v1/banks', {
    token: alice.token,
    body: { bankName: 'U.S. Bank', accountType: 'checking', openedAt: '2026-03-01', bonusCents: 45_000 },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.bank.closeNotBeforeAt, '2026-09-01');
  assert.equal(created.body.closeNotBeforeAtWasSuggested, true);
});

test('an explicit safe-to-close date is not overwritten', async () => {
  const created = await call('POST', '/v1/banks', {
    token: alice.token,
    body: {
      bankName: 'Chase',
      openedAt: '2026-03-01',
      bonusCents: 30_000,
      closeNotBeforeAt: '2027-01-15',
    },
  });
  assert.equal(created.body.bank.closeNotBeforeAt, '2027-01-15');
  assert.equal(created.body.closeNotBeforeAtWasSuggested, false);
});

// ---- inquiries -----------------------------------------------------

test('an inquiry needs a real date and defaults its bureau to unknown', async () => {
  assert.equal(
    (await call('POST', '/v1/inquiries', { token: alice.token, body: { at: 'whenever' } })).status,
    400,
  );

  const created = await call('POST', '/v1/inquiries', { token: alice.token, body: { at: '2026-07-01' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.inquiry.bureau, 'unknown');
  assert.equal(created.body.inquiry.issuer, 'other');
});

// ---- derived views -------------------------------------------------

test('standing is recomputed from the accounts', async () => {
  const fresh = await register('standing@example.com');
  for (const [index, cardId] of ['amex-hilton-honors', 'citi-double-cash', 'boa-alaska'].entries()) {
    await addCard(fresh, { cardId, openedAt: `2025-0${index * 2 + 1}-01` });
  }
  const it = await call('GET', '/v1/standing?asOf=2026-09-14', { token: fresh.token });
  assert.equal(it.status, 200);
  assert.equal(it.body.count524.count, 3);
  assert.equal(it.body.openCards, 3);
});

test('asOf lets you ask about a future date', async () => {
  // The flowchart's timing panel is entirely about this question, and every rule already takes the
  // date as a parameter.
  const fresh = await register('future@example.com');
  await addCard(fresh, { cardId: 'amex-gold', openedAt: '2025-01-15' });

  const now = await call('GET', '/v1/standing?asOf=2026-09-14', { token: fresh.token });
  assert.equal(now.body.count524.count, 1);

  const later = await call('GET', '/v1/standing?asOf=2027-02-01', { token: fresh.token });
  assert.equal(later.body.count524.count, 0, 'by then it has aged out of the 24-month window');
});

test('a nonsense asOf falls back to today rather than erroring', async () => {
  const it = await call('GET', '/v1/standing?asOf=not-a-date', { token: alice.token });
  assert.equal(it.status, 200);
  assert.match(it.body.asOf, /^\d{4}-\d{2}-\d{2}$/);
});

test('the plan comes back with strategy text and a flowchart version', async () => {
  const fresh = await register('plan@example.com');
  await addCard(fresh, { cardId: 'discover-it', openedAt: '2018-01-01' });

  const it = await call('GET', '/v1/plan?goal=travel&asOf=2026-09-14', { token: fresh.token });
  assert.equal(it.status, 200);
  assert.equal(it.body.phase, 'under-5-24');
  assert.ok(it.body.recommendations.length > 0);
  assert.ok(it.body.strategy.length > 0);
  assert.match(it.body.flowchart.version, /Flowchart v\d+/);
  assert.equal(it.body.recommendations[0].card.issuer, 'chase', 'under 5/24 Chase leads');
});

test('the goal changes the plan once past 5/24', async () => {
  // Only past 5/24. Under it the flowchart's advice is the same either way — spend your slots on
  // Chase — so identical strategy panels there are correct, not a bug.
  const fresh = await register('prefs@example.com');
  await addCard(fresh, { cardId: 'discover-it', openedAt: '2018-01-01' });
  for (const [index, cardId] of ['amex-hilton-honors', 'citi-double-cash', 'boa-alaska', 'wellsfargo-active-cash', 'usbank-cash-plus', 'discover-it-miles'].entries()) {
    await addCard(fresh, { cardId, openedAt: `2025-0${index + 1}-01` });
  }

  const travel = await call('GET', '/v1/plan?goal=travel&asOf=2026-09-14', { token: fresh.token });
  const cashback = await call('GET', '/v1/plan?goal=cashback&asOf=2026-09-14', { token: fresh.token });
  assert.equal(travel.body.phase, 'over-5-24');
  assert.notDeepEqual(
    travel.body.strategy.map((s: any) => s.id),
    cashback.body.strategy.map((s: any) => s.id),
  );
  assert.notDeepEqual(
    travel.body.recommendations.slice(0, 5).map((e: any) => e.card.id),
    cashback.body.recommendations.slice(0, 5).map((e: any) => e.card.id),
  );
});

test('turning business cards off removes them from the plan entirely', async () => {
  const fresh = await register('nobusiness@example.com');
  await addCard(fresh, { cardId: 'discover-it', openedAt: '2018-01-01' });

  const withThem = await call('GET', '/v1/plan?asOf=2026-09-14', { token: fresh.token });
  assert.ok(withThem.body.recommendations.some((entry: any) => entry.card.productType === 'business'));

  const noBusiness = await call('GET', '/v1/plan?businessCards=false&asOf=2026-09-14', { token: fresh.token });
  assert.ok(noBusiness.body.recommendations.length > 0);
  assert.ok(
    noBusiness.body.recommendations.every((entry: any) => entry.card.productType === 'personal'),
    'the flowchart names the real exception — a work visa — and says to skip over them',
  );
  assert.ok(noBusiness.body.waiting.every((entry: any) => entry.card.productType === 'personal'));
});

test('excluding an issuer removes it from the plan', async () => {
  const fresh = await register('exclude@example.com');
  await addCard(fresh, { cardId: 'discover-it', openedAt: '2018-01-01' });

  const it = await call('GET', '/v1/plan?excludeIssuers=chase,amex&asOf=2026-09-14', { token: fresh.token });
  assert.ok(it.body.recommendations.every((entry: any) => !['chase', 'amex'].includes(entry.card.issuer)));
});

test('assess explains one card and says when it opens up', async () => {
  const fresh = await register('assess@example.com');
  await addCard(fresh, { cardId: 'discover-it', openedAt: '2018-01-01' });
  await addCard(fresh, {
    cardId: 'chase-sapphire-preferred',
    openedAt: '2025-01-01',
    bonus: { amount: 60_000, unit: 'points', minSpendCents: 400_000, spentCents: 400_000, earnedAt: '2025-04-01' },
  });

  const it = await call('GET', '/v1/assess?cardId=chase-sapphire-reserve&asOf=2026-09-14', { token: fresh.token });
  assert.equal(it.status, 200);
  assert.equal(it.body.assessment.blocked, true);
  assert.ok(it.body.assessment.verdicts.some((v: any) => v.ruleId === 'family-bonus-cooldown'));
  // The family label, not the slug — a rule message is user-facing text.
  assert.ok(!JSON.stringify(it.body.assessment.verdicts).includes('chase-sapphire'));
  assert.equal(it.body.card.familyLabel, 'Sapphire');
});

test('assess needs a cardId and rejects one that is not in the catalog', async () => {
  assert.equal((await call('GET', '/v1/assess', { token: alice.token })).status, 400);
  assert.equal((await call('GET', '/v1/assess?cardId=nope', { token: alice.token })).status, 404);
});

// ---- reminders -----------------------------------------------------

test('reminders are derived, and dismissal is remembered', async () => {
  const fresh = await register('reminders@example.com');
  await addCard(fresh, { cardId: 'chase-sapphire-reserve', openedAt: '2024-11-20' });

  const listed = await call('GET', '/v1/reminders?asOf=2026-11-01', { token: fresh.token });
  assert.equal(listed.status, 200);
  const fee = listed.body.active.find((entry: any) => entry.kind === 'annual-fee-due');
  assert.ok(fee, 'the fee is 19 days out and inside its lead window');

  assert.equal(
    (await call('POST', `/v1/reminders/${encodeURIComponent(fee.id)}/dismiss`, { token: fresh.token })).status,
    200,
  );

  const after = await call('GET', '/v1/reminders?asOf=2026-11-01', { token: fresh.token });
  assert.ok(!after.body.active.some((entry: any) => entry.id === fee.id));
  assert.ok(after.body.all.some((entry: any) => entry.id === fee.id), 'still listed under `all`');
  assert.ok(after.body.dismissed.includes(fee.id));

  assert.equal(
    (await call('DELETE', `/v1/reminders/${encodeURIComponent(fee.id)}/dismiss`, { token: fresh.token })).status,
    200,
  );
  const restored = await call('GET', '/v1/reminders?asOf=2026-11-01', { token: fresh.token });
  assert.ok(restored.body.active.some((entry: any) => entry.id === fee.id));
});

test('correcting an open date moves every derived date with it', async () => {
  // The reason nothing derived is stored. A reminders table would still be pointing at November.
  const fresh = await register('correct@example.com');
  const id = await addCard(fresh, { cardId: 'chase-sapphire-reserve', openedAt: '2024-11-20' });

  const before = await call('GET', '/v1/reminders?asOf=2026-11-01', { token: fresh.token });
  assert.ok(before.body.all.some((entry: any) => entry.dueAt === '2026-11-20'));

  await call('PATCH', `/v1/cards/${id}`, { token: fresh.token, body: { openedAt: '2024-12-05' } });

  const after = await call('GET', '/v1/reminders?asOf=2026-11-01', { token: fresh.token });
  assert.ok(after.body.all.some((entry: any) => entry.dueAt === '2026-12-05'));
  assert.ok(!after.body.all.some((entry: any) => entry.dueAt === '2026-11-20'));
});

// ---- players -------------------------------------------------------

test('a second player is separate, and the flowchart treats it that way', async () => {
  const fresh = await register('players@example.com');
  const created = await call('POST', '/v1/players', { token: fresh.token, body: { name: 'Partner' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.player.primary, false);
  const partnerId = created.body.player.id;

  await addCard(fresh, { cardId: 'chase-sapphire-preferred', openedAt: '2026-01-01' });

  const mine = await call('GET', '/v1/standing?asOf=2026-09-14', { token: fresh.token });
  const theirs = await call('GET', `/v1/standing?playerId=${partnerId}&asOf=2026-09-14`, { token: fresh.token });
  assert.equal(mine.body.count524.count, 1);
  assert.equal(theirs.body.count524.count, 0, 'two players, two 5/24 counts');
});

test('a player can be renamed and deleted, but not the last one', async () => {
  const fresh = await register('lastplayer@example.com');
  const only = fresh.playerId;
  assert.equal((await call('DELETE', `/v1/players/${only}`, { token: fresh.token })).status, 409);

  const second = (await call('POST', '/v1/players', { token: fresh.token, body: { name: 'Two' } })).body.player.id;
  assert.equal((await call('PATCH', `/v1/players/${second}`, { token: fresh.token, body: { name: 'Renamed' } })).status, 200);
  assert.equal((await call('DELETE', `/v1/players/${second}`, { token: fresh.token })).status, 200);
});

test("deleting a player tombstones its cards so clients drop them too", async () => {
  const fresh = await register('cascade@example.com');
  const second = (await call('POST', '/v1/players', { token: fresh.token, body: { name: 'Two' } })).body.player.id;
  const cardId = (
    await call('POST', `/v1/cards?playerId=${second}`, {
      token: fresh.token,
      body: { cardId: 'amex-gold', openedAt: '2026-01-01' },
    })
  ).body.card.id;

  await call('DELETE', `/v1/players/${second}`, { token: fresh.token });

  const synced = await call('GET', '/v1/sync?since=1970-01-01T00:00:00.000Z', { token: fresh.token });
  const row = synced.body.cards.find((entry: any) => entry.id === cardId);
  assert.equal(row.deleted, true, 'a client holding this card must be told it is gone');
});

// ---- sync ----------------------------------------------------------

test('sync uploads apply and last-write-wins rejects a stale one', async () => {
  const fresh = await register('sync@example.com');
  const id = crypto.randomUUID();

  const first = await call('POST', '/v1/sync', {
    token: fresh.token,
    body: {
      cards: [
        {
          id,
          playerId: fresh.playerId,
          cardId: 'chase-freedom-flex',
          openedAt: '2026-01-01',
          notes: 'from the phone',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-06-01T00:00:00.000Z',
        },
      ],
    },
  });
  assert.deepEqual(first.body.applied, [id]);

  const properStale = await call('POST', '/v1/sync', {
    token: fresh.token,
    body: {
      cards: [
        {
          id,
          playerId: fresh.playerId,
          cardId: 'chase-freedom-flex',
          openedAt: '2026-01-01',
          notes: 'older',
          updatedAt: '2026-03-01T00:00:00.000Z',
        },
      ],
    },
  });
  assert.deepEqual(properStale.body.applied, []);
  assert.match(properStale.body.rejected[0].reason, /newer version/);

  const stored = await call('GET', `/v1/cards/${id}`, { token: fresh.token });
  assert.equal(stored.body.card.notes, 'from the phone');
});

test('a sync pull is scoped by since', async () => {
  const fresh = await register('since@example.com');
  await addCard(fresh, { cardId: 'amex-gold', openedAt: '2026-01-01' });

  const all = await call('GET', '/v1/sync?since=1970-01-01T00:00:00.000Z', { token: fresh.token });
  assert.ok(all.body.cards.length >= 1);

  const none = await call('GET', `/v1/sync?since=${new Date(Date.now() + 60_000).toISOString()}`, {
    token: fresh.token,
  });
  assert.equal(none.body.cards.length, 0);
  assert.ok(none.body.serverTime);
});

test('a malformed row is rejected without taking the batch down', async () => {
  const fresh = await register('partial@example.com');
  const goodId = crypto.randomUUID();

  const it = await call('POST', '/v1/sync', {
    token: fresh.token,
    body: {
      cards: [
        { id: goodId, playerId: fresh.playerId, cardId: 'amex-gold', openedAt: '2026-01-01', updatedAt: '2026-06-01T00:00:00.000Z' },
        { id: 'bad', playerId: fresh.playerId, cardId: 'amex-gold', openedAt: '2026-99-99' },
      ],
    },
  });
  assert.deepEqual(it.body.applied, [goodId]);
  assert.equal(it.body.rejected.length, 1);
  assert.equal(it.body.rejected[0].id, 'bad');
});

// ---- devices -------------------------------------------------------

test('a device registers with an Expo token and nothing else is accepted', async () => {
  assert.equal(
    (await call('POST', '/v1/devices', { token: alice.token, body: { pushToken: 'not-a-token' } })).status,
    400,
  );

  const good = await call('POST', '/v1/devices', {
    token: alice.token,
    body: { pushToken: 'ExponentPushToken[abcdef123456]', platform: 'ios' },
  });
  assert.equal(good.status, 201);

  const listed = await call('GET', '/v1/devices', { token: alice.token });
  assert.equal(listed.body.devices.length, 1);
  // The token itself is not echoed back — there is no use for it on the client that sent it.
  assert.equal(JSON.stringify(listed.body).includes('ExponentPushToken'), false);
});

test('registering the same push token twice does not duplicate it', async () => {
  const body = { pushToken: 'ExponentPushToken[dedupe-me]', platform: 'android' };
  await call('POST', '/v1/devices', { token: bob.token, body });
  await call('POST', '/v1/devices', { token: bob.token, body });
  assert.equal((await call('GET', '/v1/devices', { token: bob.token })).body.devices.length, 1);
});

test('a device can be unregistered', async () => {
  const pushToken = 'ExponentPushToken[remove-me]';
  await call('POST', '/v1/devices', { token: bob.token, body: { pushToken, platform: 'ios' } });
  assert.equal(
    (await call('DELETE', `/v1/devices?pushToken=${encodeURIComponent(pushToken)}`, { token: bob.token })).status,
    200,
  );
});

// ---- admin and errors ---------------------------------------------

test('admin status reports the stores and the config', async () => {
  const it = await call('GET', '/v1/admin/status', { token: alice.token });
  assert.equal(it.status, 200);
  assert.ok(it.body.stats.users >= 2);
  assert.equal(typeof it.body.config.openRegistration, 'boolean');
});

test('settings can be changed through the allowlist and only through it', async () => {
  const it = await call('PATCH', '/v1/admin/settings', {
    token: alice.token,
    body: { 'notify.hourUtc': '9', 'users.deleteEverything': 'yes' },
  });
  assert.equal(it.status, 200);
  assert.equal(it.body.config.notifyAtHourUtc, 9);
  assert.equal(app.store.allSettings()['users.deleteEverything'], undefined, 'not on the allowlist');
  app.settings.update({ 'notify.hourUtc': '14' });
});

test('an unknown route is a 404 and a wrong method on a real one is a 405', async () => {
  assert.equal((await call('GET', '/v1/nonsense', { token: alice.token })).status, 404);
  // Not a 404: the route exists, it just does not accept writes. A 404 would suggest the client had
  // the path wrong, and a 200 would suggest the write landed.
  assert.equal((await call('PATCH', '/v1/standing', { token: alice.token })).status, 405);
  assert.equal((await call('DELETE', '/v1/plan', { token: alice.token })).status, 405);
});

test('an unparseable body is a 400, not a 500', async () => {
  const response = await fetch(`${base}/v1/cards`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${alice.token}`, 'Content-Type': 'application/json' },
    body: '{not json',
  });
  assert.equal(response.status, 400);
});

test('CORS is answered so the web build can call this from another origin', async () => {
  const response = await fetch(`${base}/v1/me`, { method: 'OPTIONS' });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.match(response.headers.get('access-control-allow-headers') ?? '', /Authorization/);
});

test('no response is cacheable', async () => {
  const response = await fetch(`${base}/v1/me`, { headers: { Authorization: `Bearer ${alice.token}` } });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
