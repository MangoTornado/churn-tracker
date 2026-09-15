import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  count524,
  everHeld,
  inquiriesInMonths,
  issuerApprovalsInDays,
  lastAppliedTo,
  newAccountsInMonths,
  openWithIssuer,
} from '../src/core/rules/counts.ts';
import { standing } from '../src/core/rules/issuers.ts';
import { card, inquiry, state } from './helpers.ts';

const ASOF = '2026-09-14';

// ---- 5/24, and the three ways it is usually got wrong ---------------------

test('5/24 counts personal cards opened in the window', () => {
  const it = count524(
    state([
      card({ cardId: 'chase-sapphire-preferred', openedAt: '2025-01-10' }),
      card({ cardId: 'amex-gold', openedAt: '2025-06-01' }),
      card({ cardId: 'capitalone-venture', openedAt: '2026-02-14' }),
    ]),
    ASOF,
  );
  assert.equal(it.count, 3);
});

test('a closed card still counts toward 5/24', () => {
  // The mistake that matters most. Closing a card does not remove it from your credit report, and
  // people close cards specifically believing it will free a slot.
  const it = count524(
    state([
      card({ cardId: 'amex-gold', openedAt: '2025-06-01', status: 'closed', closedAt: '2026-07-01' }),
    ]),
    ASOF,
  );
  assert.equal(it.count, 1);
  assert.equal(it.accounts[0].status, 'closed');
});

test('a denied application does not count toward 5/24', () => {
  // No account opened, so nothing appears on the report. It leaves an inquiry instead.
  const it = count524(
    state([card({ cardId: 'chase-sapphire-preferred', status: 'denied', appliedAt: '2026-01-05' })]),
    ASOF,
  );
  assert.equal(it.count, 0);
});

test('a planned card does not count until it opens', () => {
  const it = count524(
    state([card({ cardId: 'chase-aeroplan', status: 'planned', openedAt: null })]),
    ASOF,
  );
  assert.equal(it.count, 0);
});

test('an authorized-user card counts even though you never applied', () => {
  // Which is why the flowchart's two-player panel opens by telling couples not to add each other.
  const it = count524(
    state([card({ cardId: 'amex-platinum', openedAt: '2026-01-01', authorizedUser: true })]),
    ASOF,
  );
  assert.equal(it.count, 1);
});

test('business cards that stay off the personal report do not count', () => {
  const it = count524(
    state([
      card({ cardId: 'chase-ink-cash', openedAt: '2026-01-01' }),
      card({ cardId: 'amex-blue-business-plus', openedAt: '2026-02-01' }),
      card({ cardId: 'capitalone-spark-cash-plus', openedAt: '2026-03-01' }),
    ]),
    ASOF,
  );
  assert.equal(it.count, 0, 'three business cards, none visible to Chase');
});

test('Capital One and Discover business cards do count', () => {
  // The exception the catalog exists to record: these report to your personal bureau.
  const it = count524(
    state([
      card({ cardId: 'capitalone-spark-miles', openedAt: '2026-01-01' }),
      card({ cardId: 'discover-it-business', openedAt: '2026-02-01' }),
    ]),
    ASOF,
  );
  assert.equal(it.count, 2);
});

test('a card opened exactly 24 months ago has aged out', () => {
  const opened = state([card({ cardId: 'amex-gold', openedAt: '2024-09-14' })]);
  assert.equal(count524(opened, ASOF).count, 0, 'exactly 24 months: gone');
  assert.equal(count524(opened, '2026-09-13').count, 1, 'a day earlier: still counted');
});

// ---- the question the app exists to answer -------------------------------

test('5/24 reports when the count next drops and when it goes under five', () => {
  const it = count524(
    state([
      card({ cardId: 'chase-sapphire-preferred', openedAt: '2024-11-01' }),
      card({ cardId: 'amex-gold', openedAt: '2025-01-15' }),
      card({ cardId: 'capitalone-venture', openedAt: '2025-03-20' }),
      card({ cardId: 'citi-strata-premier', openedAt: '2025-06-10' }),
      card({ cardId: 'boa-premium-rewards', openedAt: '2025-08-05' }),
      card({ cardId: 'bilt', openedAt: '2026-02-01' }),
    ]),
    ASOF,
  );

  assert.equal(it.count, 6);
  assert.equal(it.nextDropAt, '2026-11-01', 'the oldest ages out 24 months after it opened');
  assert.equal(it.nextDropTo, 5);
  // Under 5 needs *two* to age out, since dropping to 5 is still a decline.
  assert.equal(it.under5At, '2027-01-15');
});

test('cards opened on the same day age out together', () => {
  const it = count524(
    state([
      card({ cardId: 'boa-alaska', openedAt: '2025-03-10' }),
      card({ cardId: 'boa-virgin-atlantic', openedAt: '2025-03-10' }),
      card({ cardId: 'amex-gold', openedAt: '2026-01-01' }),
    ]),
    ASOF,
  );
  assert.equal(it.count, 3);
  assert.equal(it.nextDropTo, 1, 'both BoA cards leave at once, so the count falls by two');
});

test('newest first, so the UI can show its work', () => {
  const it = count524(
    state([
      card({ cardId: 'amex-gold', openedAt: '2025-01-01' }),
      card({ cardId: 'bilt', openedAt: '2026-05-01' }),
    ]),
    ASOF,
  );
  assert.deepEqual(
    it.accounts.map((account) => account.openedAt),
    ['2026-05-01', '2025-01-01'],
  );
});

// ---- issuer-scoped counts ------------------------------------------------

test('issuer approvals in days counts only that issuer, excluding AU cards', () => {
  const it = state([
    card({ cardId: 'amex-gold', openedAt: '2026-09-12' }),
    card({ cardId: 'amex-platinum', openedAt: '2026-09-10', authorizedUser: true }),
    card({ cardId: 'chase-freedom-flex', openedAt: '2026-09-13' }),
  ]);
  assert.equal(issuerApprovalsInDays(it, 'amex', 5, ASOF).length, 1);
});

test('lastAppliedTo prefers the application date over the open date', () => {
  // The two differ by weeks when an application goes to manual review, and Chase's velocity
  // guideline is about how often you show up, not when the account finally opened.
  const it = state([
    card({ cardId: 'chase-ink-cash', appliedAt: '2026-06-01', openedAt: '2026-07-15' }),
  ]);
  assert.equal(lastAppliedTo(it, 'chase'), '2026-06-01');
});

test('lastAppliedTo can be narrowed to business cards', () => {
  const it = state([
    card({ cardId: 'chase-sapphire-preferred', appliedAt: '2026-08-01', openedAt: '2026-08-01' }),
    card({ cardId: 'chase-ink-cash', appliedAt: '2026-03-01', openedAt: '2026-03-01' }),
  ]);
  assert.equal(lastAppliedTo(it, 'chase'), '2026-08-01');
  assert.equal(lastAppliedTo(it, 'chase', 'business'), '2026-03-01');
});

test('openWithIssuer ignores closed cards and AU cards', () => {
  const it = state([
    card({ cardId: 'amex-gold', openedAt: '2025-01-01' }),
    card({ cardId: 'amex-green', openedAt: '2024-01-01', status: 'closed', closedAt: '2026-01-01' }),
    card({ cardId: 'amex-platinum', openedAt: '2025-05-01', authorizedUser: true }),
  ]);
  assert.equal(openWithIssuer(it, 'amex').length, 1);
});

test('newAccountsInMonths counts business cards too, unlike 5/24', () => {
  // Bank of America's 3/12 and 7/12 count every new account anywhere, which is a different
  // question from 5/24 and must not share its exclusions.
  const it = state([
    card({ cardId: 'chase-ink-cash', openedAt: '2026-01-01' }),
    card({ cardId: 'amex-gold', openedAt: '2026-02-01' }),
  ]);
  assert.equal(count524(it, ASOF).count, 1);
  assert.equal(newAccountsInMonths(it, 12, ASOF).length, 2);
});

// ---- inquiries -----------------------------------------------------------

test('inquiries are counted per bureau as well as in total', () => {
  // Citi only ever sees the one bureau it pulled, so being 4/6 overall but 1/6 on Equifax is an
  // approval rather than a denial.
  const it = inquiriesInMonths(
    state([], {
      inquiries: [
        inquiry('2026-08-01', { bureau: 'equifax' }),
        inquiry('2026-07-01', { bureau: 'experian' }),
        inquiry('2026-06-01', { bureau: 'experian' }),
        inquiry('2026-05-01', { bureau: 'unknown' }),
        inquiry('2025-01-01', { bureau: 'experian' }),
      ],
    }),
    6,
    ASOF,
  );
  assert.equal(it.total, 4, 'the 2025 inquiry is outside the window');
  assert.equal(it.byBureau.experian, 2);
  assert.equal(it.byBureau.equifax, 1);
  assert.equal(it.byBureau.unknown, 1);
});

// ---- history -------------------------------------------------------------

test('everHeld finds a closed card but not an AU one', () => {
  // Amex's lifetime language turns on whether you have *had* the card, and an AU card was never
  // yours to have.
  const closed = state([
    card({ cardId: 'amex-gold', openedAt: '2020-01-01', status: 'closed', closedAt: '2022-01-01' }),
  ]);
  assert.notEqual(everHeld(closed, 'amex-gold'), null);

  const asAu = state([card({ cardId: 'amex-gold', openedAt: '2020-01-01', authorizedUser: true })]);
  assert.equal(everHeld(asAu, 'amex-gold'), null);
});

// ---- the summary the home screen shows -----------------------------------

test('standing totals annual fees on open cards only', () => {
  const it = standing(
    state([
      card({ cardId: 'chase-sapphire-reserve', openedAt: '2025-01-01' }),
      card({ cardId: 'amex-gold', openedAt: '2024-01-01', status: 'closed', closedAt: '2026-01-01' }),
    ]),
    ASOF,
  );
  assert.equal(it.openCards, 1);
  assert.equal(it.annualFeesCents, 79_500, 'the closed Gold no longer costs anything');
});

test('standing records the last application per issuer', () => {
  const it = standing(
    state([
      card({ cardId: 'chase-ink-cash', appliedAt: '2026-03-01', openedAt: '2026-03-01' }),
      card({ cardId: 'chase-sapphire-preferred', appliedAt: '2026-07-01', openedAt: '2026-07-01' }),
      card({ cardId: 'amex-gold', appliedAt: '2026-01-01', openedAt: '2026-01-01' }),
    ]),
    ASOF,
  );
  assert.equal(it.lastAppliedByIssuer.chase, '2026-07-01');
  assert.equal(it.lastAppliedByIssuer.amex, '2026-01-01');
  assert.equal(it.lastAppliedByIssuer.citi, undefined);
});
