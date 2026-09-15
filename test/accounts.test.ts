import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ValidationError,
  newBankAccount,
  newCardAccount,
  suggestedCloseNotBefore,
} from '../src/core/accounts.ts';
import { CARDS, CARDS_BY_ID, catalog, familyName } from '../src/core/data/cards.ts';

const NOW = '2026-09-14T12:00:00.000Z';

function makeCard(input: Parameters<typeof newCardAccount>[0]) {
  return newCardAccount(input, NOW);
}

// ---- defaults from the catalog ------------------------------------------

test('a card in the catalog fills in its own details', () => {
  // The form should ask for a card and a date, not for sixteen fields nobody knows offhand.
  const it = makeCard({ playerId: 'p', cardId: 'chase-sapphire-reserve', openedAt: '2026-01-15' });
  assert.equal(it.cardName, 'Chase Sapphire Reserve');
  assert.equal(it.issuer, 'chase');
  assert.equal(it.productType, 'personal');
  assert.equal(it.annualFeeCents, 79_500);
  assert.equal(it.counts524, true);
});

test('a business card defaults to not counting toward 5/24', () => {
  const it = makeCard({ playerId: 'p', cardId: 'chase-ink-cash', openedAt: '2026-01-15' });
  assert.equal(it.productType, 'business');
  assert.equal(it.counts524, false);
});

test('the business cards that report are the exception the catalog exists for', () => {
  for (const cardId of ['capitalone-spark-miles', 'discover-it-business', 'capitalone-spark-cash-select']) {
    const it = makeCard({ playerId: 'p', cardId, openedAt: '2026-01-15' });
    assert.equal(it.counts524, true, `${cardId} reports to the personal bureau`);
  }
  for (const cardId of ['capitalone-spark-cash-plus', 'capitalone-venture-x-business']) {
    const it = makeCard({ playerId: 'p', cardId, openedAt: '2026-01-15' });
    assert.equal(it.counts524, false, `${cardId} is one of the two that stay off it`);
  }
});

test('an authorized-user business card still counts', () => {
  // The default composes two facts, and the AU one wins: an AU card appears on your report
  // regardless of whose card it is or what product it is.
  const it = makeCard({
    playerId: 'p',
    cardId: 'chase-ink-cash',
    openedAt: '2026-01-15',
    authorizedUser: true,
  });
  assert.equal(it.counts524, true);
});

test('an explicit counts524 overrides the catalog', () => {
  // Because an issuer can quietly start or stop reporting a product, and the user is the one
  // looking at their own credit report.
  const it = makeCard({
    playerId: 'p',
    cardId: 'chase-ink-cash',
    openedAt: '2026-01-15',
    counts524: true,
  });
  assert.equal(it.counts524, true);
});

test('a card not in the catalog is accepted with its details supplied', () => {
  const it = makeCard({
    playerId: 'p',
    cardId: null,
    cardName: 'Some Credit Union Visa',
    issuer: 'other',
    openedAt: '2026-01-15',
  });
  assert.equal(it.cardName, 'Some Credit Union Visa');
  assert.equal(it.counts524, true, 'a personal card unless told otherwise');
});

test('an unknown card without a name or issuer is rejected', () => {
  assert.throws(() => makeCard({ playerId: 'p', openedAt: '2026-01-15' }), {
    name: 'ValidationError',
    field: 'cardName',
  });
  assert.throws(() => makeCard({ playerId: 'p', cardName: 'Mystery Card', openedAt: '2026-01-15' }), {
    name: 'ValidationError',
    field: 'issuer',
  });
});

test('the annual fee date is left blank rather than guessed', () => {
  // A stored guess is indistinguishable from a date read off a statement. The reminder engine
  // derives it on demand and knows it is an estimate.
  const it = makeCard({ playerId: 'p', cardId: 'chase-sapphire-reserve', openedAt: '2026-01-15' });
  assert.equal(it.nextAnnualFeeAt, null);
});

// ---- validation ---------------------------------------------------------

test('dates have to be real dates', () => {
  for (const openedAt of ['2026-13-01', '2026-02-30', '15/01/2026', '2026-1-5', 'yesterday']) {
    assert.throws(
      () => makeCard({ playerId: 'p', cardId: 'chase-freedom-flex', openedAt }),
      ValidationError,
      `${openedAt} should have been rejected`,
    );
  }
});

test('a status and its dates have to agree', () => {
  assert.throws(
    () => makeCard({ playerId: 'p', cardId: 'chase-freedom-flex', status: 'open', openedAt: null }),
    { field: 'openedAt' },
  );
  assert.throws(
    () => makeCard({ playerId: 'p', cardId: 'chase-freedom-flex', status: 'closed', openedAt: '2026-01-01' }),
    { field: 'closedAt' },
  );
});

test('a card cannot close before it opened, or open before it was applied for', () => {
  assert.throws(
    () =>
      makeCard({
        playerId: 'p',
        cardId: 'chase-freedom-flex',
        status: 'closed',
        openedAt: '2026-06-01',
        closedAt: '2026-01-01',
      }),
    { field: 'closedAt' },
  );
  assert.throws(
    () =>
      makeCard({
        playerId: 'p',
        cardId: 'chase-freedom-flex',
        appliedAt: '2026-06-01',
        openedAt: '2026-01-01',
      }),
    { field: 'openedAt' },
  );
});

test('an unknown status or product type is rejected', () => {
  assert.throws(
    () => makeCard({ playerId: 'p', cardId: 'chase-freedom-flex', status: 'maybe', openedAt: '2026-01-01' }),
    { field: 'status' },
  );
});

test('a missing player is rejected', () => {
  assert.throws(() => makeCard({ playerId: '', cardId: 'chase-freedom-flex', openedAt: '2026-01-01' }), {
    field: 'playerId',
  });
});

test('money has to be a non-negative whole number of cents', () => {
  assert.throws(
    () => makeCard({ playerId: 'p', cardId: 'chase-freedom-flex', openedAt: '2026-01-01', annualFeeCents: -1 }),
    { field: 'annualFeeCents' },
  );
  // Rounded rather than rejected: a fractional cent means somebody multiplied dollars by 100 in
  // floating point, and 12345.000000000002 should not survive into a stored total.
  const it = makeCard({
    playerId: 'p',
    cardId: 'chase-freedom-flex',
    openedAt: '2026-01-01',
    annualFeeCents: 9500.000000000002,
  });
  assert.equal(it.annualFeeCents, 9500);
});

// ---- bonuses ------------------------------------------------------------

test('a bonus defaults to a 90-day window rather than zero', () => {
  // A zero would make the deadline reminder fire on the open date.
  const it = makeCard({
    playerId: 'p',
    cardId: 'chase-sapphire-preferred',
    openedAt: '2026-01-15',
    bonus: { amount: 60_000, unit: 'points', minSpendCents: 400_000 },
  });
  assert.equal(it.bonus?.spendWindowDays, 90);
  assert.equal(it.bonus?.spentCents, 0);
  assert.equal(it.bonus?.earnedAt, null);
});

test('a bonus unit outside the three is rejected', () => {
  assert.throws(
    () =>
      makeCard({
        playerId: 'p',
        cardId: 'chase-sapphire-preferred',
        openedAt: '2026-01-15',
        bonus: { amount: 60_000, unit: 'shillings' as 'points' },
      }),
    { field: 'bonus.unit' },
  );
});

// ---- bank accounts -----------------------------------------------------

test('a bank account needs a name and a consistent status', () => {
  assert.throws(() => newBankAccount({ playerId: 'p', bankName: '  ' }, NOW), { field: 'bankName' });
  assert.throws(() => newBankAccount({ playerId: 'p', bankName: 'Chase', status: 'open' }, NOW), {
    field: 'openedAt',
  });
});

test('bank bonus requirements default to nothing required', () => {
  // So "absent" and "none" agree, and the reminder engine can tell there is nothing to chase.
  const it = newBankAccount({ playerId: 'p', bankName: 'Chase', openedAt: '2026-01-01' }, NOW);
  assert.deepEqual(it.requirements, {
    directDepositCents: 0,
    directDepositCount: 0,
    minBalanceCents: 0,
    holdDays: 0,
    debitTransactions: 0,
  });
});

test('the suggested safe-to-close date is six months out', () => {
  assert.equal(suggestedCloseNotBefore('2026-03-31'), '2026-09-30', 'and it clamps short months');
});

// ---- the catalog itself ------------------------------------------------

test('an uncurated card gets a permissive stand-in rather than nothing', () => {
  // Inventing a restriction is worse than missing one, so the stand-in claims no family and no
  // lifetime language — but the issuer-level rules still get to run.
  const it = catalog('some-card-nobody-curated');
  assert.equal(it.known, false);
  assert.equal(it.card.family, null);
  assert.equal(it.card.bonusOncePerLifetime, false);
  assert.equal(catalog('chase-sapphire-preferred').known, true);
});

test('every catalog id is unique', () => {
  const ids = CARDS.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('catalog invariants hold for every card', () => {
  for (const entry of CARDS) {
    assert.equal(CARDS_BY_ID[entry.id], entry);
    assert.ok(entry.name.length > 2, `${entry.id} has no name`);
    assert.ok(entry.annualFeeCents >= 0);
    assert.ok(Number.isInteger(entry.annualFeeCents), `${entry.id} has a fractional fee`);

    if (entry.productType === 'personal') {
      assert.equal(entry.showsOnPersonalReport, true, `${entry.id} is personal and must report`);
    }
    // A family rank without a family, or a family-wide clock without a family, is a typo that
    // would make the rule silently never fire.
    if (entry.familyRank > 0) assert.ok(entry.family, `${entry.id} has a rank but no family`);
    if (entry.familyBonusCooldownMonths !== null) {
      assert.ok(entry.family, `${entry.id} has a family clock but no family`);
    }
    if (entry.familyOnlyOneOpen) assert.ok(entry.family, `${entry.id} is one-at-a-time but has no family`);
    if (entry.chargeCard) assert.equal(entry.issuer, 'amex', 'only Amex has charge cards');
  }
});

test('only Amex cards carry lifetime language', () => {
  for (const entry of CARDS) {
    if (entry.issuer === 'amex') {
      assert.equal(entry.bonusOncePerLifetime, true, `${entry.id} should be once-per-lifetime`);
    } else {
      assert.equal(entry.bonusOncePerLifetime, false, `${entry.id} should not be`);
    }
  }
});

test('cards in an Amex family have distinct ranks', () => {
  // A tie would make "does a higher card outrank this one" quietly false in both directions.
  const families = new Map<string, number[]>();
  for (const entry of CARDS) {
    if (entry.family === null || entry.familyRank === 0) continue;
    families.set(entry.family, [...(families.get(entry.family) ?? []), entry.familyRank]);
  }
  for (const [family, ranks] of families) {
    assert.equal(new Set(ranks).size, ranks.length, `${family} has duplicate ranks: ${ranks.join(', ')}`);
  }
});

test('every family has a name fit to show a user', () => {
  for (const entry of CARDS) {
    if (entry.family === null) continue;
    const label = familyName(entry.family);
    assert.ok(label.length > 0);
    assert.ok(!label.includes('-'), `${entry.family} has no display name, so the slug would leak into the UI`);
  }
  assert.equal(familyName(null), '');
});

test('every Chase card has a bonus cooldown unless it uses a family clock', () => {
  for (const entry of CARDS) {
    if (entry.issuer !== 'chase') continue;
    assert.ok(
      entry.bonusCooldownMonths !== null || entry.familyBonusCooldownMonths !== null,
      `${entry.id} has no bonus clock at all`,
    );
  }
});
