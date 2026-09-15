import assert from 'node:assert/strict';
import { test } from 'node:test';

import { activeReminders, nextAnnualFee, reminders } from '../src/core/rules/reminders.ts';
import type { Reminder, ReminderKind } from '../src/core/rules/reminders.ts';
import { bank, card, state } from './helpers.ts';
import type { PlayerState } from '../src/core/model.ts';

const ASOF = '2026-09-14';

function kinds(playerState: PlayerState, asOf = ASOF): ReminderKind[] {
  return reminders(playerState, asOf).map((reminder) => reminder.kind);
}

function only(playerState: PlayerState, kind: ReminderKind, asOf = ASOF): Reminder {
  const found = reminders(playerState, asOf).filter((reminder) => reminder.kind === kind);
  assert.equal(found.length, 1, `expected exactly one ${kind}, got ${found.length}`);
  return found[0];
}

// ---- annual fees ---------------------------------------------------------

test('the next annual fee is the next anniversary of the open date', () => {
  const account = card({ cardId: 'chase-sapphire-reserve', openedAt: '2024-03-10' });
  assert.equal(nextAnnualFee(account, ASOF), '2027-03-10', 'the 2025 and 2026 anniversaries are past');
});

test('a stored annual-fee date wins over the derived one', () => {
  // Issuers post the fee on the statement containing the anniversary, which can land either side
  // of the date itself — so a value read off a statement must not be recomputed away.
  const account = card({
    cardId: 'chase-sapphire-reserve',
    openedAt: '2024-03-10',
    nextAnnualFeeAt: '2027-04-02',
  });
  assert.equal(nextAnnualFee(account, ASOF), '2027-04-02');
});

test('a no-fee card has no annual-fee date and no fee reminders', () => {
  const account = card({ cardId: 'chase-freedom-flex', openedAt: '2024-03-10' });
  assert.equal(nextAnnualFee(account, ASOF), null);
  assert.ok(!kinds(state([account])).includes('annual-fee-due'));
  assert.ok(!kinds(state([account])).includes('annual-fee-decision'));
});

test('an annual fee anniversary on a 31st clamps to the end of a short month', () => {
  const account = card({ cardId: 'amex-hilton-aspire', openedAt: '2025-01-31' });
  assert.equal(nextAnnualFee(account, '2026-01-01'), '2026-01-31');
  assert.equal(nextAnnualFee(account, '2026-02-01'), '2027-01-31', 'not March 3rd');
});

test('the fee decision reminder leads the fee itself by 45 days', () => {
  // Separate from the fee because a retention offer has to be asked for *before* it posts, and a
  // downgrade takes a phone call.
  const account = card({ cardId: 'chase-sapphire-reserve', openedAt: '2024-11-20' });
  const it = state([account]);
  assert.equal(only(it, 'annual-fee-due').dueAt, '2026-11-20');
  assert.equal(only(it, 'annual-fee-decision').dueAt, '2026-10-06');
  assert.equal(only(it, 'annual-fee-due').stakeCents, 79_500);
});

test('no fee decision is offered before the card is a year old', () => {
  // Closing or downgrading inside the first year annoys the issuer and, at Chase, counts against
  // you — so there is no decision to prompt for yet.
  const account = card({ cardId: 'chase-sapphire-preferred', openedAt: '2026-08-01' });
  assert.ok(!kinds(state([account])).includes('annual-fee-decision'));
  assert.ok(kinds(state([account])).includes('card-turns-one'));
});

test('the first-anniversary reminder disappears once it has passed', () => {
  const young = card({ cardId: 'chase-sapphire-preferred', openedAt: '2026-01-01' });
  assert.ok(kinds(state([young])).includes('card-turns-one'));

  const old = card({ cardId: 'chase-sapphire-preferred', openedAt: '2020-01-01' });
  assert.ok(!kinds(state([old])).includes('card-turns-one'));
});

// ---- minimum spend, the one hard forfeit --------------------------------

test('the minimum spend deadline counts from the open date and names the shortfall', () => {
  const account = card({
    cardId: 'chase-ink-preferred',
    openedAt: '2026-08-01',
    bonus: {
      amount: 100_000,
      unit: 'points',
      minSpendCents: 800_000,
      spentCents: 300_000,
      spendWindowDays: 120,
    },
  });
  const it = only(state([account]), 'min-spend-deadline');
  assert.equal(it.dueAt, '2026-11-29');
  assert.match(it.title, /Spend \$5,000 more/);
  assert.match(it.detail, /\$5,000 of the \$8,000/);
  // The stake is the whole bonus, not the shortfall — that is what missing the deadline costs.
  assert.ok(it.stakeCents > 100_000);
});

test('a met minimum spend switches to waiting for the bonus', () => {
  const account = card({
    cardId: 'chase-ink-preferred',
    openedAt: '2026-08-01',
    bonus: {
      amount: 100_000,
      unit: 'points',
      minSpendCents: 800_000,
      spentCents: 800_000,
      spendWindowDays: 120,
    },
  });
  const it = only(state([account]), 'min-spend-deadline');
  assert.match(it.title, /Minimum spend met/);
  // And a nudge to chase it up, two statement cycles after the window closes.
  assert.equal(only(state([account]), 'bonus-not-posted').dueAt, '2027-01-28');
});

test('an earned bonus ends all of its reminders', () => {
  const account = card({
    cardId: 'chase-ink-preferred',
    openedAt: '2026-01-01',
    bonus: {
      amount: 100_000,
      unit: 'points',
      minSpendCents: 800_000,
      spentCents: 800_000,
      spendWindowDays: 120,
      earnedAt: '2026-05-01',
    },
  });
  const it = kinds(state([account]));
  assert.ok(!it.includes('min-spend-deadline'));
  assert.ok(!it.includes('bonus-not-posted'));
});

test('a spend deadline already past is not resurfaced', () => {
  const account = card({
    cardId: 'chase-ink-preferred',
    openedAt: '2025-01-01',
    bonus: { amount: 100_000, unit: 'points', minSpendCents: 800_000, spentCents: 100_000, spendWindowDays: 90 },
  });
  assert.ok(!kinds(state([account])).includes('min-spend-deadline'), 'nothing can be done about it now');
});

// ---- inactivity, from the flowchart's timing panel ----------------------

test('an idle no-fee card is nudged, and an overdue one is not dropped', () => {
  // "Remember to put occasional purchases on old cards to avoid the banks auto-closing them."
  // A card idle for two years is exactly the case this exists for, so filtering to future dates
  // would drop the only one that matters.
  const idle = card({ cardId: 'chase-freedom-flex', openedAt: '2020-01-01', lastUsedAt: '2024-06-01' });
  const it = only(state([idle]), 'card-inactivity');
  assert.equal(it.dueAt, '2025-01-01');
  assert.equal(activeReminders(state([idle]), ASOF).find((r) => r.kind === 'card-inactivity')?.urgency, 'overdue');
});

test('a fee-paying card is not nudged about inactivity', () => {
  // You are already deciding whether to keep it; a card you are about to cancel does not need a
  // coffee bought on it.
  const account = card({ cardId: 'chase-sapphire-reserve', openedAt: '2020-01-01', lastUsedAt: '2024-06-01' });
  assert.ok(!kinds(state([account])).includes('card-inactivity'));
});

test('inactivity falls back to the open date when the card has never been used', () => {
  const account = card({ cardId: 'chase-freedom-flex', openedAt: '2026-01-01' });
  assert.equal(only(state([account]), 'card-inactivity').dueAt, '2026-08-01');
});

// ---- closed cards ------------------------------------------------------

test('a closed card generates no reminders', () => {
  const account = card({
    cardId: 'chase-sapphire-reserve',
    openedAt: '2024-01-01',
    status: 'closed',
    closedAt: '2026-01-01',
  });
  assert.deepEqual(kinds(state([account])), []);
});

// ---- bank accounts ----------------------------------------------------

test('a bank bonus deadline lists what is still outstanding', () => {
  const account = bank({
    playerId: 'player-1',
    bankName: 'U.S. Bank',
    openedAt: '2026-08-01',
    bonusCents: 45_000,
    requirements: { directDepositCents: 200_000, directDepositCount: 2, holdDays: 90, debitTransactions: 5 },
  });
  const it = only(state([], { banks: [account] }), 'bank-requirements-deadline');
  assert.equal(it.dueAt, '2026-10-30');
  assert.match(it.detail, /\$2,000 in direct deposits across 2 deposits/);
  assert.match(it.detail, /5 debit transactions/);
  assert.equal(it.stakeCents, 45_000);
});

test('met requirements switch a bank bonus to chasing it up', () => {
  const account = bank({
    playerId: 'player-1',
    bankName: 'Four Leaf Federal Credit Union',
    openedAt: '2026-06-01',
    bonusCents: 55_000,
    requirements: { holdDays: 60 },
    requirementsMetAt: '2026-08-01',
  });
  const it = kinds(state([], { banks: [account] }));
  assert.ok(!it.includes('bank-requirements-deadline'));
  assert.equal(only(state([], { banks: [account] }), 'bank-bonus-not-posted').dueAt, '2026-09-30');
});

test('the safe-to-close date warns about a monthly fee eating the bonus', () => {
  // The reason bank churning needs tracking at all: close early and the bonus is clawed back,
  // leave it open and the maintenance fee grinds it down.
  const account = bank({
    playerId: 'player-1',
    bankName: 'Some Bank',
    openedAt: '2026-06-01',
    bonusCents: 30_000,
    closeNotBeforeAt: '2026-12-01',
    monthlyFeeCents: 1_200,
    feeWaiverNote: 'waived with $1,500 balance',
  });
  const it = only(state([], { banks: [account] }), 'bank-safe-to-close');
  assert.equal(it.dueAt, '2026-12-01');
  assert.match(it.detail, /\$12\/month/);
  assert.match(it.detail, /waived with \$1,500 balance/);
});

test('a closed bank account generates no reminders', () => {
  const account = bank({
    playerId: 'player-1',
    bankName: 'Some Bank',
    status: 'closed',
    openedAt: '2025-01-01',
    closedAt: '2026-01-01',
    bonusCents: 30_000,
    closeNotBeforeAt: '2027-01-01',
  });
  assert.deepEqual(kinds(state([], { banks: [account] })), []);
});

// ---- the 5/24 slot ----------------------------------------------------

test('the 5/24 slot reminder appears only when 5/24 is the binding constraint', () => {
  const under = state([
    card({ cardId: 'amex-gold', openedAt: '2026-01-01' }),
    card({ cardId: 'bilt', openedAt: '2026-02-01' }),
  ]);
  assert.ok(!kinds(under).includes('slot-524-opens'), 'telling someone at 2/24 about March is noise');

  const over = state(
    ['2025-01-01', '2025-03-01', '2025-05-01', '2025-07-01', '2025-09-01'].map((openedAt) =>
      card({ cardId: 'amex-gold', openedAt }),
    ),
  );
  const it = only(over, 'slot-524-opens');
  assert.equal(it.dueAt, '2027-01-01');
  assert.equal(it.leadDays, 120, 'long enough out to line up business-card spacers in the meantime');
});

// ---- ordering, ids and dismissal -------------------------------------

test('reminders come back soonest first, and ties break on what is at stake', () => {
  const it = reminders(
    state([
      card({ cardId: 'chase-sapphire-reserve', openedAt: '2024-11-20' }),
      card({ cardId: 'chase-freedom-flex', openedAt: '2026-01-01' }),
    ]),
    ASOF,
  );
  for (let index = 1; index < it.length; index += 1) {
    assert.ok(it[index - 1].dueAt <= it[index].dueAt, 'out of date order');
  }
});

test('a reminder id folds in its due date, so moving a deadline resurfaces it', () => {
  // Dismissal is a statement about a specific deadline. If the date moves it is a new reminder,
  // not a silently-dismissed one.
  const before = only(state([card({ cardId: 'chase-sapphire-reserve', openedAt: '2024-11-20' })]), 'annual-fee-due');
  const after = only(
    state([
      card({ cardId: 'chase-sapphire-reserve', openedAt: '2024-11-20', nextAnnualFeeAt: '2026-12-05' }),
    ]),
    'annual-fee-due',
  );
  assert.notEqual(before.id, after.id);
  assert.match(before.id, /^annual-fee-due:/);
});

test('the same input produces the same ids twice', () => {
  const build = () => state([card({ id: 'fixed', cardId: 'chase-sapphire-reserve', openedAt: '2024-11-20' })]);
  assert.deepEqual(
    reminders(build(), ASOF).map((r) => r.id),
    reminders(build(), ASOF).map((r) => r.id),
  );
});

test('dismissed reminders and ones outside their lead window are both simply absent', () => {
  const it = state([card({ cardId: 'chase-sapphire-reserve', openedAt: '2024-11-20' })]);

  const active = activeReminders(it, ASOF);
  assert.ok(
    active.every((reminder) => reminder.urgency !== 'upcoming'),
    'nothing beyond its lead window should show',
  );

  const dismissed = new Set(active.map((reminder) => reminder.id));
  assert.deepEqual(activeReminders(it, ASOF, dismissed), []);
});

test('urgency escalates as the date approaches', () => {
  const account = card({ cardId: 'chase-sapphire-reserve', openedAt: '2024-11-20' });
  const view = (asOf: string) =>
    activeReminders(state([account]), asOf).find((reminder) => reminder.kind === 'annual-fee-due');

  assert.equal(view('2026-09-14'), undefined, '67 days out, beyond the 30-day lead');
  assert.equal(view('2026-11-01')?.urgency, 'soon');
  assert.equal(view('2026-11-18')?.urgency, 'urgent');
});

test('once a fee posts, the reminder rolls forward a year', () => {
  // Not a bug: a fee that has already posted is not a deadline, and the next one is. What *is* a
  // deadline is the reversal window, which the next test covers.
  const account = card({ cardId: 'chase-sapphire-reserve', openedAt: '2024-11-20' });
  assert.equal(nextAnnualFee(account, '2026-11-25'), '2027-11-20');
});

test('the weeks after a fee posts are the last chance to reverse it', () => {
  const account = card({ cardId: 'chase-sapphire-reserve', openedAt: '2024-11-20' });

  const during = activeReminders(state([account]), '2026-11-25').find(
    (reminder) => reminder.kind === 'annual-fee-reversal-window',
  );
  assert.equal(during?.dueAt, '2026-12-20');
  assert.equal(during?.urgency, 'soon');
  assert.equal(during?.stakeCents, 79_500);
  assert.match(during?.detail ?? '', /refund an annual fee if you close or downgrade/);

  assert.equal(
    activeReminders(state([account]), '2027-01-05').find(
      (reminder) => reminder.kind === 'annual-fee-reversal-window',
    ),
    undefined,
    'the window has closed and the fee is spent',
  );
  assert.equal(
    activeReminders(state([account]), '2026-11-01').find(
      (reminder) => reminder.kind === 'annual-fee-reversal-window',
    ),
    undefined,
    'no point warning before the window opens',
  );
});

test('whenText reads the way a person would say it', () => {
  const view = activeReminders(
    state([card({ cardId: 'chase-sapphire-reserve', openedAt: '2024-11-20' })]),
    '2026-11-01',
  ).find((reminder) => reminder.kind === 'annual-fee-due');
  assert.equal(view?.whenText, 'in 19 days');
});
