import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FLOWCHART, phaseOf, plan } from '../src/core/rules/recommend.ts';
import type { CardOffer } from '../src/core/model.ts';
import { card, state } from './helpers.ts';
import type { PlayerState } from '../src/core/model.ts';

const ASOF = '2026-09-14';

/** A history long enough that the thin-file rule stays out of the way. */
const ESTABLISHED = () => card({ cardId: 'discover-it', openedAt: '2018-01-01' });

/**
 * `count` non-Chase personal cards, to drive the 5/24 number.
 *
 * The list is chosen as carefully as it looks. None of these is on the flowchart's burn-a-slot list
 * and none is a card the tests below assert about, because a card in the history is a card that
 * will never be recommended — so using Capital One Venture as filler quietly broke the test that
 * checks Venture gets recommended. Spread across months so no issuer velocity rule fires, and no
 * more than two per issuer so BoA's 2/3/4 and Citi's 2/65 stay quiet.
 */
function fiveTwentyFour(count: number) {
  const filler = [
    'amex-hilton-honors',
    'citi-double-cash',
    'boa-alaska',
    'wellsfargo-active-cash',
    'usbank-cash-plus',
    'discover-it-miles',
    'boa-virgin-atlantic',
    'citi-att-points-plus',
  ];
  assert.ok(count <= filler.length, 'need more filler cards');
  return Array.from({ length: count }, (_, index) =>
    card({ cardId: filler[index], openedAt: `2025-0${index + 1}-01` }),
  );
}

function ids(playerState: PlayerState, options: Parameters<typeof plan>[0]['preferences'] = {}): string[] {
  return plan({ state: playerState, asOf: ASOF, preferences: options }).recommendations.map(
    (entry) => entry.card.id,
  );
}

/**
 * Every recommended card, leads and alternatives alike.
 *
 * Needed because equal-rank cards collapse: the flowchart's "JetBlue Plus, AA, Hawaiian, Wyndham" is
 * one recommendation with three alternatives, so asking whether a specific one of them is recommended
 * cannot just look at the leads.
 */
function recommendedIds(result: ReturnType<typeof plan>): string[] {
  return result.recommendations.flatMap((entry) => [
    entry.card.id,
    ...entry.alternatives.map((alternative) => alternative.card.id),
  ]);
}

function offer(cardId: string, overrides: Partial<CardOffer> = {}): CardOffer {
  return {
    cardId,
    title: cardId,
    issuer: null,
    amount: 60_000,
    unit: 'points',
    minSpendCents: 400_000,
    spendWindowDays: 90,
    historicalHigh: false,
    targeted: false,
    states: [],
    notes: '',
    seenAt: ASOF,
    ...overrides,
  };
}

// ---- the branch, which decides everything else --------------------------

test('the phase follows the 5/24 count, with exactly five as its own moment', () => {
  // The flowchart repeatedly treats exactly-5/24 specially: it is when Barclays and Capital One
  // are still possible and Chase is not, and it says to take those cards now.
  assert.equal(phaseOf(state([]), ASOF), 'thin-file');
  assert.equal(phaseOf(state([ESTABLISHED(), ...fiveTwentyFour(2)]), ASOF), 'under-5-24');
  assert.equal(phaseOf(state([ESTABLISHED(), ...fiveTwentyFour(5)]), ASOF), 'at-the-edge');
  assert.equal(phaseOf(state([ESTABLISHED(), ...fiveTwentyFour(6)]), ASOF), 'over-5-24');
});

test('the strategy panels shown match the phase and the goal', () => {
  const under = plan({ state: state([ESTABLISHED(), ...fiveTwentyFour(2)]), asOf: ASOF });
  assert.deepEqual(
    under.strategy.map((section) => section.id),
    ['under524Approach', 'chaseCards', 'nonChaseBusinessCards', 'burnA524Slot', 'notesUnder524'],
  );

  const overTravel = plan({
    state: state([ESTABLISHED(), ...fiveTwentyFour(6)]),
    asOf: ASOF,
    preferences: { goal: 'travel' },
  });
  assert.ok(overTravel.strategy.some((section) => section.id === 'over524Travel'));

  const overCash = plan({
    state: state([ESTABLISHED(), ...fiveTwentyFour(6)]),
    asOf: ASOF,
    preferences: { goal: 'cashback' },
  });
  assert.ok(overCash.strategy.some((section) => section.id === 'over524Cashback'));
  assert.ok(!overCash.strategy.some((section) => section.id === 'over524Travel'));
});

test('the plan says which flowchart it is quoting', () => {
  // The chart is opinionated, dated, and updated by one person. A recommendation that does not say
  // which revision it came from cannot be sanity-checked.
  const it = plan({ state: state([]), asOf: ASOF });
  assert.match(it.flowchart.version, /Card Recommendation Flowchart v\d+/);
  assert.equal(it.flowchart.updatedAt, '2025-06-09');
  assert.ok(it.strategy.every((section) => section.body.length > 50), 'panels should carry real text');
});

// ---- under 5/24: slots are the scarce resource -------------------------

test('under 5/24 the top of the list is Chase, in the flowchart order', () => {
  const it = ids(state([ESTABLISHED(), ...fiveTwentyFour(2)]));
  assert.equal(it[0], 'chase-sapphire-preferred', 'Sapphire is #1 on the Chase list');
  // The first several must all be Chase — the branch's whole claim is that these are the only
  // cards 5/24 can take away from you.
  assert.ok(
    it.slice(0, 6).every((cardId) => cardId.startsWith('chase-')),
    `expected Chase to lead, got ${it.slice(0, 6).join(', ')}`,
  );
});

test('each row states something about its own card, not about the branch', () => {
  // The reasons used to lead with the same branch-level sentence on every Chase row — the most
  // important thing to know, and therefore already said once above the list. Repeated down five rows
  // it stopped being an argument and became wallpaper.
  const it = plan({ state: state([ESTABLISHED(), ...fiveTwentyFour(2)]), asOf: ASOF });
  const chase = it.recommendations.filter((entry) => entry.card.issuer === 'chase').slice(0, 5);
  assert.ok(chase.length >= 4, 'expected several Chase cards to compare');

  const leads = chase.map((entry) => entry.reasons[0]);
  assert.equal(
    new Set(leads).size,
    leads.length,
    `every row repeated the same reason:\n${leads.join('\n')}`,
  );
  // And each one names its own rank, which is the row-specific fact.
  for (const lead of leads) assert.match(lead, /#\d+ of \d+/);
});

test('equal-rank cards collapse into one recommendation with alternatives', () => {
  // "Sapphire Preferred or Reserve", "United Quest, Explorer and/or Club" — the flowchart writes a
  // rank as one line and means pick one. Three numbered rows would misread that as three cards to
  // collect in order.
  const it = plan({ state: state([ESTABLISHED(), ...fiveTwentyFour(2)]), asOf: ASOF });

  const sapphire = it.recommendations.find((entry) =>
    ['chase-sapphire-preferred', 'chase-sapphire-reserve'].includes(entry.card.id),
  );
  assert.ok(sapphire);
  assert.deepEqual(
    sapphire.alternatives.map((alternative) => alternative.card.id),
    [sapphire.card.id === 'chase-sapphire-preferred' ? 'chase-sapphire-reserve' : 'chase-sapphire-preferred'],
  );

  // And each Sapphire appears exactly once across the whole list, lead or alternative.
  const all = recommendedIds(it);
  for (const cardId of ['chase-sapphire-preferred', 'chase-sapphire-reserve', 'chase-united-quest']) {
    assert.equal(all.filter((id) => id === cardId).length, 1, `${cardId} appears more than once`);
  }

  const united = it.recommendations.find((entry) => entry.card.id.startsWith('chase-united-'));
  assert.equal(united?.alternatives.length, 2, 'Quest, Explorer and Club are one rank');
});

test('a card the flowchart does not group keeps no alternatives', () => {
  const it = plan({ state: state([ESTABLISHED(), ...fiveTwentyFour(2)]), asOf: ASOF });
  const aeroplan = it.recommendations.find((entry) => entry.card.id === 'chase-aeroplan');
  assert.ok(aeroplan);
  assert.deepEqual(aeroplan.alternatives, [], 'Aeroplan is alone at its rank');
});

test('under 5/24 an ordinary non-Chase personal card is demoted, not hidden', () => {
  const it = plan({ state: state([ESTABLISHED(), ...fiveTwentyFour(2)]), asOf: ASOF });
  const hilton = it.recommendations.find((entry) => entry.card.id === 'amex-hilton-surpass');
  assert.ok(hilton, 'still listed — the user is allowed to overrule the flowchart');
  assert.equal(hilton.verdict, 'costs-a-slot');
  assert.match(hilton.reasons.join(' '), /Burns a 5\/24 slot/);

  const sapphire = it.recommendations.find((entry) => entry.card.id === 'chase-sapphire-preferred');
  assert.ok((sapphire?.score ?? 0) < hilton.score, 'and it must rank below every Chase card');
});

test('under 5/24 the four cards on the burn list are treated differently', () => {
  // "Cards possibly worth burning a 5/24-slot for" — a short list, and being on it is the whole
  // difference between a warning and a recommendation.
  const it = plan({ state: state([ESTABLISHED(), ...fiveTwentyFour(2)]), asOf: ASOF });
  const venture = it.recommendations.find((entry) => entry.card.id === 'capitalone-venture');
  const hilton = it.recommendations.find((entry) => entry.card.id === 'amex-hilton-surpass');
  assert.ok(venture);
  assert.match(venture.reasons.join(' '), /short list of cards worth a 5\/24 slot/);
  assert.ok(venture.score < (hilton?.score ?? Infinity));
});

test('Bilt is only worth a slot at high rent', () => {
  const lowRent = plan({
    state: state([ESTABLISHED(), ...fiveTwentyFour(2)]),
    asOf: ASOF,
    preferences: { monthlyRentCents: 150_000 },
  });
  assert.equal(
    lowRent.recommendations.find((entry) => entry.card.id === 'bilt'),
    undefined,
    'below $4k/month the flowchart takes it off the burn list entirely',
  );

  const highRent = plan({
    state: state([ESTABLISHED(), ...fiveTwentyFour(2)]),
    asOf: ASOF,
    preferences: { monthlyRentCents: 500_000 },
  });
  const bilt = highRent.recommendations.find((entry) => entry.card.id === 'bilt');
  assert.ok(bilt);
  assert.match(bilt.reasons.join(' '), /worth a 5\/24 slot/);
});

test('under 5/24 business cards that stay off the report are promoted as spacers', () => {
  const it = plan({ state: state([ESTABLISHED(), ...fiveTwentyFour(2)]), asOf: ASOF });
  const blueBusiness = it.recommendations.find((entry) => entry.card.id === 'amex-blue-business-plus');
  assert.ok(blueBusiness);
  assert.match(blueBusiness.reasons.join(' '), /no 5\/24 slot|spacer/i);

  const sparkMiles = it.recommendations.find((entry) => entry.card.id === 'capitalone-spark-miles');
  assert.ok(
    (blueBusiness.score ?? 0) < (sparkMiles?.score ?? Infinity),
    'a business card that reports is not a free spacer',
  );
});

test('turning business cards off removes them from the list', () => {
  // The flowchart names the real exception — a work visa — and says to skip over them if so.
  const without = ids(state([ESTABLISHED(), ...fiveTwentyFour(2)]), { businessCards: false });
  assert.ok(without.length > 0);
  assert.ok(
    !without.includes('amex-blue-business-plus') && !without.includes('chase-ink-cash'),
    `business cards leaked: ${without.filter((id) => /business|ink|spark/.test(id)).join(', ')}`,
  );
});

// ---- over 5/24: the ordered columns ------------------------------------

test('over 5/24 the travel and cashback columns give different answers', () => {
  const history = state([ESTABLISHED(), ...fiveTwentyFour(6)]);
  const travel = ids(history, { goal: 'travel' });
  const cashback = ids(history, { goal: 'cashback' });
  assert.notDeepEqual(travel.slice(0, 5), cashback.slice(0, 5));
  // Neither should still be leading with Chase — 5/24 blocks all of it.
  assert.ok(!travel.slice(0, 5).some((id) => id.startsWith('chase-')));
});

test('over 5/24 no Chase card is recommended at all', () => {
  const it = plan({ state: state([ESTABLISHED(), ...fiveTwentyFour(6)]), asOf: ASOF });
  assert.ok(
    !it.recommendations.some((entry) => entry.card.issuer === 'chase'),
    'every Chase card is blocked by 5/24',
  );
  const chase = it.waiting.find((entry) => entry.card.id === 'chase-sapphire-preferred');
  assert.ok(chase, 'and each should appear in the waiting list with a date');
  assert.equal(chase.verdict, 'blocked');
  assert.ok(chase.availableAt);
});

test('Barclays is recommended at exactly 5/24 and withdrawn at seven', () => {
  const edge = plan({ state: state([ESTABLISHED(), ...fiveTwentyFour(5)]), asOf: ASOF, preferences: { goal: 'travel' } });
  assert.ok(
    recommendedIds(edge).includes('barclays-jetblue-plus'),
    'the flowchart says this is the moment to take the Barclays cards you want',
  );

  const past = plan({ state: state([ESTABLISHED(), ...fiveTwentyFour(7)]), asOf: ASOF, preferences: { goal: 'travel' } });
  assert.ok(
    !recommendedIds(past).includes('barclays-jetblue-plus'),
    'at 7/24 Barclays is a denial, so it belongs in the waiting list',
  );
  assert.ok(past.waiting.some((entry) => entry.card.id === 'barclays-jetblue-plus'));
});

test('Capital One drops off the list well past 5/24', () => {
  const past = plan({ state: state([ESTABLISHED(), ...fiveTwentyFour(8)]), asOf: ASOF, preferences: { goal: 'travel' } });
  assert.equal(past.recommendations.find((entry) => entry.card.id === 'capitalone-venture'), undefined);
});

// ---- offers break ties, they do not reorder tiers ---------------------

test('a live offer promotes a card within its tier', () => {
  const history = state([ESTABLISHED(), ...fiveTwentyFour(2)]);
  const base = plan({ state: history, asOf: ASOF });
  const withOffer = plan({
    state: history,
    asOf: ASOF,
    offers: [offer('chase-aeroplan', { historicalHigh: true })],
  });

  const before = base.recommendations.find((entry) => entry.card.id === 'chase-aeroplan');
  const after = withOffer.recommendations.find((entry) => entry.card.id === 'chase-aeroplan');
  assert.ok(before, 'Aeroplan should be recommended with no offer at all');
  assert.ok(after, 'and still be recommended with one');
  assert.ok(after.score < before.score, 'a historical high should help');
  assert.equal(after.verdict, 'apply-now');
  assert.equal(before.verdict, 'no-current-offer');
});

test('an offer cannot lift a slot-burner above a Chase card', () => {
  // The flowchart is deliberately "current opening-bonus agnostic". An offer breaks ties inside a
  // tier; it must not promote a card past one, or the app recommends Amex Platinum at 2/24.
  const it = plan({
    state: state([ESTABLISHED(), ...fiveTwentyFour(2)]),
    asOf: ASOF,
    offers: [offer('amex-hilton-aspire', { amount: 200_000, historicalHigh: true })],
  });
  const first = it.recommendations[0];
  assert.ok(first.card.issuer === 'chase', `expected Chase first, got ${first.card.name}`);
});

test('a targeted offer is worth less than a public one', () => {
  const history = state([ESTABLISHED(), ...fiveTwentyFour(2)]);
  const scoreOf = (result: ReturnType<typeof plan>): number => {
    const found = result.recommendations.find((entry) => entry.card.id === 'chase-aeroplan');
    assert.ok(found, 'Aeroplan should be recommended either way');
    return found.score;
  };

  const openToAll = plan({ state: history, asOf: ASOF, offers: [offer('chase-aeroplan')] });
  const targeted = plan({ state: history, asOf: ASOF, offers: [offer('chase-aeroplan', { targeted: true })] });
  assert.ok(scoreOf(targeted) > scoreOf(openToAll), 'a targeted offer is not one you can plan around');
});

test('an unreachable minimum spend removes the card', () => {
  // The limitations panel says the chart assumes you can meet every MSR. A recommendation you
  // cannot fulfil is a trap, not advice.
  const it = plan({
    state: state([ESTABLISHED(), ...fiveTwentyFour(2)]),
    asOf: ASOF,
    offers: [offer('chase-ink-preferred', { minSpendCents: 800_000 })],
    preferences: { maxMinSpendCents: 300_000 },
  });
  assert.equal(it.recommendations.find((entry) => entry.card.id === 'chase-ink-preferred'), undefined);
  assert.equal(it.waiting.find((entry) => entry.card.id === 'chase-ink-preferred'), undefined);
});

// ---- what not to recommend --------------------------------------------

test('a card you already hold is not recommended', () => {
  const holding = state([
    ESTABLISHED(),
    card({ cardId: 'chase-sapphire-preferred', openedAt: '2025-06-01' }),
  ]);
  assert.ok(!ids(holding).includes('chase-sapphire-preferred'));
});

test('a card you closed and whose cooldown has expired comes back, and says so', () => {
  const past = state([
    ESTABLISHED(),
    card({
      cardId: 'chase-ihg-premier',
      openedAt: '2020-01-01',
      status: 'closed',
      closedAt: '2021-06-01',
      bonus: { amount: 140_000, unit: 'points', minSpendCents: 300_000, spentCents: 300_000, earnedAt: '2020-04-01' },
    }),
  ]);
  const it = plan({ state: past, asOf: ASOF });
  const again = it.recommendations.find((entry) => entry.card.id === 'chase-ihg-premier');
  assert.ok(again, 'six years on, the 24-month cooldown is long gone');
  assert.match(again.reasons.join(' '), /held this before/);
});

test('an excluded issuer disappears entirely', () => {
  // For a past shutdown, or a bank someone simply refuses to deal with.
  const it = ids(state([ESTABLISHED(), ...fiveTwentyFour(2)]), { excludeIssuers: ['chase'] });
  assert.ok(it.length > 0);
  assert.ok(!it.some((cardId) => cardId.startsWith('chase-')));
});

// ---- the shape of the output ------------------------------------------

test('recommendations are actionable and waiting entries carry a date', () => {
  const it = plan({ state: state([ESTABLISHED(), ...fiveTwentyFour(6)]), asOf: ASOF });

  for (const entry of it.recommendations) {
    assert.ok(entry.verdict !== 'blocked' && entry.verdict !== 'wait', `${entry.card.name} is not actionable`);
    assert.ok(entry.reasons.length > 0, `${entry.card.name} has no stated reason`);
  }
  for (const entry of it.waiting) {
    assert.ok(entry.verdict === 'blocked' || entry.verdict === 'wait');
    assert.ok(entry.reasons.length > 0);
  }
  assert.ok(it.waiting.some((entry) => entry.availableAt !== null), 'some blocks clear on a known date');
});

test('scores are ascending, so the list is already in order', () => {
  const it = plan({ state: state([ESTABLISHED(), ...fiveTwentyFour(2)]), asOf: ASOF });
  for (let index = 1; index < it.recommendations.length; index += 1) {
    assert.ok(
      it.recommendations[index - 1].score <= it.recommendations[index].score,
      'recommendations out of order',
    );
  }
});

test('asking about one card only checks that card', () => {
  const it = plan({
    state: state([ESTABLISHED(), ...fiveTwentyFour(2)]),
    asOf: ASOF,
    onlyCardIds: ['amex-platinum'],
  });
  assert.equal(it.recommendations.length + it.waiting.length, 1);
});

test('an empty history still produces a plan', () => {
  const it = plan({ state: state([]), asOf: ASOF });
  assert.equal(it.phase, 'thin-file');
  assert.ok(it.recommendations.length > 0);
  assert.ok(it.strategy.some((section) => section.id === 'notesNewbies'));
});

// ---- the extracted flowchart -----------------------------------------

test('every panel the recommender reads is present in the extracted flowchart', () => {
  for (const id of [
    'under524Approach',
    'chaseCards',
    'nonChaseBusinessCards',
    'burnA524Slot',
    'notesUnder524',
    'over524Travel',
    'over524Cashback',
    'notesAmexFamily',
    'notesTiming',
    'notesNewbies',
    'generalNotes',
    'limitations',
  ]) {
    const section = FLOWCHART.sections[id];
    assert.ok(section, `panel ${id} is missing — has the chart been restructured?`);
    assert.ok(section.body.length > 100, `panel ${id} came out nearly empty`);
  }
});
