import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CARDS_BY_ID } from '../src/core/data/cards.ts';
import { assess, type Assessment, type Severity } from '../src/core/rules/issuers.ts';
import { bank, card, inquiry, state } from './helpers.ts';
import type { PlayerState } from '../src/core/model.ts';

const ASOF = '2026-09-14';

function check(playerState: PlayerState, cardId: string, asOf = ASOF): Assessment {
  const target = CARDS_BY_ID[cardId];
  assert.ok(target, `${cardId} is not in the catalog`);
  return assess({ state: playerState, target, asOf, catalog: CARDS_BY_ID });
}

function ruleIds(assessment: Assessment): string[] {
  return assessment.verdicts.map((verdict) => verdict.ruleId);
}

function severityOf(assessment: Assessment, ruleId: string): Severity | undefined {
  return assessment.verdicts.find((verdict) => verdict.ruleId === ruleId)?.severity;
}

/** A history long enough that the thin-file rule stays quiet and does not muddy other assertions. */
function established() {
  return card({ cardId: 'discover-it', openedAt: '2018-01-01' });
}

// ---- Chase ---------------------------------------------------------------

test('Chase declines at 5/24 and says when it will not', () => {
  const five = state([
    card({ cardId: 'chase-sapphire-preferred', openedAt: '2024-11-01' }),
    card({ cardId: 'amex-gold', openedAt: '2025-01-15' }),
    card({ cardId: 'capitalone-venture', openedAt: '2025-03-20' }),
    card({ cardId: 'citi-strata-premier', openedAt: '2025-06-10' }),
    card({ cardId: 'boa-premium-rewards', openedAt: '2025-08-05' }),
  ]);

  const it = check(five, 'chase-aeroplan');
  assert.ok(ruleIds(it).includes('chase-5-24'));
  assert.equal(severityOf(it, 'chase-5-24'), 'blocker');
  assert.equal(it.blocked, true);
  assert.equal(it.availableAt, '2026-11-01', 'the oldest card ages out and takes the count to 4');
});

test('5/24 blocks Chase business cards too', () => {
  // A point people get wrong in the other direction: business cards do not *count* toward 5/24,
  // but Chase still applies the rule when deciding a business application.
  const five = state(
    Array.from({ length: 5 }, (_, index) =>
      card({ cardId: 'amex-gold', openedAt: `2025-0${index + 1}-01` }),
    ),
  );
  assert.equal(check(five, 'chase-ink-cash').blocked, true);
});

test('four accounts is not 5/24', () => {
  const four = state([
    established(),
    card({ cardId: 'amex-gold', openedAt: '2025-01-15' }),
    card({ cardId: 'capitalone-venture', openedAt: '2025-03-20' }),
    card({ cardId: 'citi-strata-premier', openedAt: '2025-06-10' }),
    card({ cardId: 'boa-premium-rewards', openedAt: '2025-08-05' }),
  ]);
  assert.equal(check(four, 'chase-aeroplan').blocked, false);
});

test('the three-month Chase gap is a caution, not a block', () => {
  // The flowchart is explicit that breaking it once is usually fine and that repeatedly doing so
  // raises shutdown risk. An app that hard-blocks here is wrong about what the rule is.
  const recent = state([
    established(),
    card({ cardId: 'chase-freedom-flex', appliedAt: '2026-08-01', openedAt: '2026-08-01' }),
  ]);
  const it = check(recent, 'chase-aeroplan');
  assert.equal(severityOf(it, 'chase-velocity-3-months'), 'caution');
  assert.equal(it.blocked, false, 'a caution must not read as a decline');
  assert.equal(it.verdicts.find((v) => v.ruleId === 'chase-velocity-3-months')?.clearsAt, '2026-11-01');
});

test('the six-month Chase business gap ignores Chase personal cards in between', () => {
  // Straight from the notes panel: biz in January, personal in April, biz in July is fine.
  const history = state([
    established(),
    card({ cardId: 'chase-ink-cash', appliedAt: '2026-01-10', openedAt: '2026-01-10' }),
    card({ cardId: 'chase-sapphire-preferred', appliedAt: '2026-04-10', openedAt: '2026-04-10' }),
  ]);

  // Nine months since the last business card, so the business gate is clear...
  assert.ok(!ruleIds(check(history, 'chase-ink-preferred')).includes('chase-business-6-months'));
  // ...while the general three-month gap is measured from the April personal card and is also clear.
  assert.ok(!ruleIds(check(history, 'chase-ink-preferred')).includes('chase-velocity-3-months'));
});

test('a Chase business card inside six months of another is flagged', () => {
  const history = state([
    established(),
    card({ cardId: 'chase-ink-cash', appliedAt: '2026-06-01', openedAt: '2026-06-01' }),
  ]);
  const it = check(history, 'chase-ink-unlimited');
  assert.equal(severityOf(it, 'chase-business-6-months'), 'caution');
  assert.equal(it.verdicts.find((v) => v.ruleId === 'chase-business-6-months')?.clearsAt, '2026-12-01');
});

test('the Sapphire pair shares one 48-month bonus clock', () => {
  const held = state([
    established(),
    card({
      cardId: 'chase-sapphire-preferred',
      openedAt: '2025-01-01',
      status: 'closed',
      closedAt: '2026-03-01',
      bonus: { amount: 60_000, unit: 'points', minSpendCents: 400_000, spentCents: 400_000, earnedAt: '2025-04-01' },
    }),
  ]);
  const it = check(held, 'chase-sapphire-reserve');
  assert.equal(severityOf(it, 'family-bonus-cooldown'), 'blocker');
  assert.equal(it.availableAt, '2029-04-01', '48 months after the bonus posted');
  // The card is closed, so "only one at a time" must not also fire.
  assert.ok(!ruleIds(it).includes('family-one-open'));
});

test('holding a Sapphire blocks the other one on top of the clock', () => {
  const held = state([
    established(),
    card({ cardId: 'chase-sapphire-preferred', openedAt: '2025-01-01' }),
  ]);
  const it = check(held, 'chase-sapphire-reserve');
  assert.ok(ruleIds(it).includes('family-one-open'));
  // Nothing to wait for — the user has to close or product-change it, so no date is offered.
  assert.equal(it.availableAt, null);
});

test('Sapphire Reserve for Business is not in the Sapphire family', () => {
  // It is a business card: no 5/24 slot and no share of the personal cards' 48-month clock.
  const held = state([
    established(),
    card({
      cardId: 'chase-sapphire-preferred',
      openedAt: '2025-01-01',
      bonus: { amount: 60_000, unit: 'points', minSpendCents: 400_000, spentCents: 400_000, earnedAt: '2025-04-01' },
    }),
  ]);
  const it = check(held, 'chase-sapphire-reserve-business');
  assert.ok(!ruleIds(it).includes('family-bonus-cooldown'));
  assert.ok(!ruleIds(it).includes('family-one-open'));
});

test('a Chase co-brand bonus is blocked for 24 months', () => {
  const held = state([
    established(),
    card({
      cardId: 'chase-ihg-premier',
      openedAt: '2025-06-01',
      status: 'closed',
      closedAt: '2026-08-01',
      bonus: { amount: 140_000, unit: 'points', minSpendCents: 300_000, spentCents: 300_000, earnedAt: '2025-09-15' },
    }),
  ]);
  const it = check(held, 'chase-ihg-premier');
  assert.equal(severityOf(it, 'card-bonus-cooldown'), 'blocker');
  assert.equal(it.availableAt, '2027-09-15');
});

test('a thin file is a likely denial at Chase, and a Chase bank account softens it', () => {
  const thin = state([card({ cardId: 'discover-it', openedAt: '2026-04-01' })]);
  assert.equal(severityOf(check(thin, 'chase-freedom-flex'), 'chase-thin-file'), 'likely-denial');

  const withDeposit = state([card({ cardId: 'discover-it', openedAt: '2026-04-01' })], {
    banks: [bank({ playerId: 'player-1', bankName: 'Chase', openedAt: '2026-01-01' })],
  });
  assert.equal(severityOf(check(withDeposit, 'chase-freedom-flex'), 'chase-thin-file'), 'caution');
});

test('three or more open Chase business cards is a likely denial', () => {
  const many = state([
    established(),
    card({ cardId: 'chase-ink-cash', openedAt: '2024-01-01' }),
    card({ cardId: 'chase-ink-unlimited', openedAt: '2024-06-01' }),
    card({ cardId: 'chase-ink-preferred', openedAt: '2025-01-01' }),
  ]);
  assert.equal(severityOf(check(many, 'chase-united-business'), 'chase-two-business-open'), 'likely-denial');
});

// ---- Amex ----------------------------------------------------------------

test('Amex allows one credit card approval every five days', () => {
  const recent = state([established(), card({ cardId: 'amex-blue-business-plus', openedAt: '2026-09-12' })]);
  const it = check(recent, 'amex-hilton-honors');
  assert.equal(severityOf(it, 'amex-1-in-5-days'), 'blocker');
  assert.equal(it.availableAt, '2026-09-17');
});

test('Amex 2/90 clears when the second-newest approval ages out, not the oldest', () => {
  // With three approvals inside 90 days, the oldest leaving still leaves two — and two is blocked.
  const three = state([
    established(),
    card({ cardId: 'amex-hilton-honors', openedAt: '2026-07-01' }),
    card({ cardId: 'amex-blue-cash-everyday', openedAt: '2026-07-20' }),
    card({ cardId: 'amex-blue-business-cash', openedAt: '2026-08-10' }),
  ]);
  const it = check(three, 'amex-hilton-surpass');
  assert.equal(severityOf(it, 'amex-2-in-90-days'), 'blocker');
  assert.equal(it.availableAt, '2026-10-18', '90 days after the 2026-07-20 approval');
});

test('charge cards are exempt from 2/90 and from the five-card limit', () => {
  const fiveCredit = state([
    established(),
    card({ cardId: 'amex-hilton-honors', openedAt: '2024-01-01' }),
    card({ cardId: 'amex-hilton-surpass', openedAt: '2024-04-01' }),
    card({ cardId: 'amex-blue-cash-everyday', openedAt: '2024-08-01' }),
    card({ cardId: 'amex-blue-business-cash', openedAt: '2025-01-01' }),
    card({ cardId: 'amex-blue-business-plus', openedAt: '2025-06-01' }),
  ]);

  const credit = check(fiveCredit, 'amex-hilton-aspire');
  assert.equal(severityOf(credit, 'amex-five-credit-card-limit'), 'blocker');

  const charge = check(fiveCredit, 'amex-platinum');
  assert.ok(
    !ruleIds(charge).includes('amex-five-credit-card-limit'),
    'the Platinum is a charge card and does not use a credit-card slot',
  );
});

test('holding five Amex charge cards does not reach the credit-card limit', () => {
  const chargeOnly = state([
    established(),
    card({ cardId: 'amex-platinum', openedAt: '2024-01-01' }),
    card({ cardId: 'amex-gold', openedAt: '2024-04-01' }),
    card({ cardId: 'amex-green', openedAt: '2024-08-01' }),
    card({ cardId: 'amex-business-platinum', openedAt: '2025-01-01' }),
    card({ cardId: 'amex-business-gold', openedAt: '2025-06-01' }),
  ]);
  assert.ok(!ruleIds(check(chargeOnly, 'amex-hilton-honors')).includes('amex-five-credit-card-limit'));
});

test('Amex grants a welcome offer once per lifetime', () => {
  const had = state([
    established(),
    card({ cardId: 'amex-gold', openedAt: '2019-01-01', status: 'closed', closedAt: '2021-01-01' }),
  ]);
  const it = check(had, 'amex-gold');
  assert.equal(severityOf(it, 'once-per-lifetime'), 'likely-denial');
  // The application still gets approved — it is the bonus that does not appear — so this is not a
  // blocker and there is no date at which it lapses.
  assert.equal(it.blocked, false);
  assert.equal(it.verdicts.find((v) => v.ruleId === 'once-per-lifetime')?.clearsAt, null);
});

test('a higher Amex card forecloses a lower one in the same family', () => {
  const platinum = state([established(), card({ cardId: 'amex-platinum', openedAt: '2025-01-01' })]);
  assert.equal(severityOf(check(platinum, 'amex-gold'), 'amex-family-rank'), 'likely-denial');
  assert.equal(severityOf(check(platinum, 'amex-green'), 'amex-family-rank'), 'likely-denial');
});

test('a lower Amex card does not foreclose a higher one', () => {
  // Which is the whole reason the flowchart says to work *up* each family.
  const green = state([established(), card({ cardId: 'amex-green', openedAt: '2025-01-01' })]);
  assert.ok(!ruleIds(check(green, 'amex-gold')).includes('amex-family-rank'));
  assert.ok(!ruleIds(check(green, 'amex-platinum')).includes('amex-family-rank'));
});

test('Amex families do not leak into each other', () => {
  const platinum = state([established(), card({ cardId: 'amex-platinum', openedAt: '2025-01-01' })]);
  assert.ok(
    !ruleIds(check(platinum, 'amex-blue-cash-everyday')).includes('amex-family-rank'),
    'Blue Cash is a separate family from Membership Rewards',
  );
  assert.ok(!ruleIds(check(platinum, 'amex-delta-gold')).includes('amex-family-rank'));
});

// ---- Citi ----------------------------------------------------------------

test('Citi accepts one application every eight days and two every 65', () => {
  // Applications, not approvals: Citi's clocks run from when you asked, so a decision still
  // pending has already used a slot. Hence `status: 'pending'` with no open date.
  const one = state([
    established(),
    card({ cardId: 'citi-custom-cash', status: 'pending', appliedAt: '2026-09-10' }),
  ]);
  const eight = check(one, 'citi-double-cash');
  assert.equal(severityOf(eight, 'citi-1-in-8-days'), 'blocker');
  assert.equal(eight.availableAt, '2026-09-18');

  const two = state([
    established(),
    card({ cardId: 'citi-custom-cash', status: 'pending', appliedAt: '2026-08-20' }),
    card({ cardId: 'citi-double-cash', status: 'pending', appliedAt: '2026-09-01' }),
  ]);
  const sixtyFive = check(two, 'citi-strata-premier');
  assert.equal(severityOf(sixtyFive, 'citi-2-in-65-days'), 'blocker');
  assert.equal(sixtyFive.availableAt, '2026-10-24', '65 days after the older of the two');
});

test('the Citi ThankYou family shares a 48-month clock but Custom Cash does not', () => {
  const held = state([
    established(),
    card({
      cardId: 'citi-strata-premier',
      openedAt: '2025-01-01',
      bonus: { amount: 75_000, unit: 'points', minSpendCents: 400_000, spentCents: 400_000, earnedAt: '2025-05-01' },
    }),
  ]);
  assert.equal(severityOf(check(held, 'citi-strata-elite'), 'family-bonus-cooldown'), 'blocker');
  assert.ok(
    !ruleIds(check(held, 'citi-custom-cash')).includes('family-bonus-cooldown'),
    'the flowchart names Custom Cash as the way to add TYP without resetting the clock',
  );
});

test('Citi hardens from caution to likely denial as inquiries pile up', () => {
  const two = state([established()], {
    inquiries: [inquiry('2026-08-01'), inquiry('2026-07-01')],
  });
  assert.equal(severityOf(check(two, 'citi-strata-premier'), 'citi-6-inquiries-6-months'), 'caution');

  const six = state([established()], {
    inquiries: ['2026-08-01', '2026-07-01', '2026-06-01', '2026-05-01', '2026-04-15', '2026-04-01'].map(
      (at) => inquiry(at),
    ),
  });
  assert.equal(severityOf(check(six, 'citi-strata-premier'), 'citi-6-inquiries-6-months'), 'likely-denial');
});

// ---- Barclays, BoA, Capital One -----------------------------------------

test('Barclays says nothing at exactly 5/24 and denies at 6', () => {
  const five = state(
    Array.from({ length: 5 }, (_, index) =>
      card({ cardId: 'amex-gold', openedAt: `2025-0${index + 1}-01` }),
    ),
  );
  // Silence at exactly 5/24 is the point. The flowchart treats that as the moment to *go and get*
  // the Barclays cards, because approvals stop right after — so a rule that warned there demoted
  // Barclays out of the recommendations at precisely the wrong moment. The encouragement lives in
  // the recommender's travel column; a rule states obstacles only.
  assert.equal(severityOf(check(five, 'barclays-jetblue-plus'), 'barclays-6-24'), undefined);

  const six = state([...five.cards, card({ cardId: 'bilt', openedAt: '2025-07-01' })]);
  const it = check(six, 'barclays-jetblue-plus');
  assert.equal(severityOf(it, 'barclays-6-24'), 'likely-denial');
  assert.ok(it.verdicts.find((v) => v.ruleId === 'barclays-6-24')?.clearsAt, 'and it says when it lifts');
});

test('BoA 2/3/4 reports the tightest window that is breached', () => {
  const twoRecent = state([
    established(),
    card({ cardId: 'boa-alaska', openedAt: '2026-08-01' }),
    card({ cardId: 'boa-virgin-atlantic', openedAt: '2026-08-15' }),
  ]);
  const it = check(twoRecent, 'boa-premium-rewards');
  assert.equal(severityOf(it, 'boa-2-3-4'), 'blocker');
  assert.equal(it.availableAt, '2026-10-01', 'two months after the older of the two');
});

test('a BoA deposit account raises the new-accounts ceiling from three to seven', () => {
  const three = [
    card({ cardId: 'amex-gold', openedAt: '2026-01-01' }),
    card({ cardId: 'capitalone-venture', openedAt: '2026-03-01' }),
    card({ cardId: 'citi-double-cash', openedAt: '2026-05-01' }),
  ];

  const nonCustomer = state([established(), ...three]);
  assert.equal(severityOf(check(nonCustomer, 'boa-alaska'), 'boa-3-12-or-7-12'), 'likely-denial');

  const customer = state([established(), ...three], {
    banks: [bank({ playerId: 'player-1', bankName: 'Bank of America', openedAt: '2025-01-01' })],
  });
  assert.ok(
    !ruleIds(check(customer, 'boa-alaska')).includes('boa-3-12-or-7-12'),
    'the flowchart says a BoA bank account helps approvals greatly; this is the mechanism',
  );
});

test('Capital One gets more pessimistic the further past 5/24 you are', () => {
  const five = state(
    Array.from({ length: 5 }, (_, index) =>
      card({ cardId: 'amex-gold', openedAt: `2025-0${index + 1}-01` }),
    ),
  );
  assert.equal(severityOf(check(five, 'capitalone-venture'), 'capitalone-524-sensitivity'), 'caution');

  const seven = state([
    ...five.cards,
    card({ cardId: 'bilt', openedAt: '2025-07-01' }),
    card({ cardId: 'citi-double-cash', openedAt: '2025-08-01' }),
  ]);
  assert.equal(
    severityOf(check(seven, 'capitalone-venture'), 'capitalone-524-sensitivity'),
    'likely-denial',
  );
});

test('a Capital One business card that reports warns about the 5/24 slot', () => {
  const clean = state([established()]);
  assert.ok(ruleIds(check(clean, 'capitalone-spark-miles')).includes('capitalone-business-reports'));
  assert.ok(
    !ruleIds(check(clean, 'capitalone-spark-cash-plus')).includes('capitalone-business-reports'),
    'Spark Cash Plus is one of the two that stay off the personal report',
  );
});

// ---- Wells Fargo --------------------------------------------------------

test('Signify needs a Wells Fargo deposit account, and it has to have aged', () => {
  const none = state([established()]);
  assert.equal(
    severityOf(check(none, 'wellsfargo-signify-business'), 'wellsfargo-deposit-account-age'),
    'blocker',
  );

  const fresh = state([established()], {
    banks: [bank({ playerId: 'player-1', bankName: 'Wells Fargo', openedAt: '2026-09-01' })],
  });
  assert.equal(
    severityOf(check(fresh, 'wellsfargo-signify-business'), 'wellsfargo-deposit-account-age'),
    'caution',
  );

  const aged = state([established()], {
    banks: [bank({ playerId: 'player-1', bankName: 'Wells Fargo', openedAt: '2025-01-01' })],
  });
  assert.ok(
    !ruleIds(check(aged, 'wellsfargo-signify-business')).includes('wellsfargo-deposit-account-age'),
  );
});

// ---- the shape of the result -------------------------------------------

test('a clean file against a clean card produces no verdicts at all', () => {
  const it = check(state([established()]), 'chase-sapphire-preferred');
  assert.deepEqual(it.verdicts, []);
  assert.equal(it.worst, null);
  assert.equal(it.blocked, false);
  assert.equal(it.availableAt, ASOF);
});

test('verdicts come back worst first', () => {
  const messy = state([
    established(),
    // 5/24 blocker...
    ...Array.from({ length: 5 }, (_, index) =>
      card({ cardId: 'amex-gold', openedAt: `2025-0${index + 1}-01` }),
    ),
    // ...and a velocity caution.
    card({ cardId: 'chase-freedom-flex', appliedAt: '2026-08-20', openedAt: '2026-08-20' }),
  ]);
  const it = check(messy, 'chase-aeroplan');
  assert.equal(it.verdicts[0].severity, 'blocker');
  assert.equal(it.worst, 'blocker');
  assert.ok(it.verdicts.length > 1, 'the caution is still reported, just after the blocker');
});

test('availableAt is the latest blocker to clear, ignoring cautions', () => {
  // A caution clearing is advice about timing, not a gate; folding it in would make a card look
  // unavailable when it is merely inadvisable.
  const it = check(
    state([
      established(),
      card({ cardId: 'amex-hilton-honors', openedAt: '2026-09-12' }),
      card({ cardId: 'amex-blue-cash-everyday', openedAt: '2026-08-01' }),
    ]),
    'amex-hilton-surpass',
  );
  assert.equal(it.availableAt, '2026-10-30', '2/90 clears after 1/5 does, so it decides');
});
