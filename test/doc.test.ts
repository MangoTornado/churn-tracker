/**
 * The scraper, against checked-in copies of the real pages.
 *
 * The fixtures are gzipped slices of doctorofcredit.com as of 2026-09-14, cut from `entry-content`
 * to a little past the "Recent Changes" heading — so the parser's own end-detection is inside the
 * fixture rather than assumed. Gzipped because the raw slices are 600KB of someone else's HTML and
 * compress to a tenth of that.
 *
 * These assert on *specific offers* rather than only on counts. A count test passes happily while
 * every minimum spend comes back as zero, which is precisely the failure the app cannot see: the
 * data looks present and is wrong. So the checks below name real cards and real numbers, and if DoC
 * restyles a section the test says which field stopped working.
 *
 * When the fixtures are refreshed the numbers here will need updating with them. That is the
 * intended cost — it forces a human to look at what changed.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { matchCard, parseBankOffers, parseCardOffers } from '../src/server/doc.ts';
import { CARDS_BY_ID } from '../src/core/data/cards.ts';
import type { BankOffer, CardOffer } from '../src/core/model.ts';

function fixture(name: string): string {
  return gunzipSync(readFileSync(fileURLToPath(new URL(`fixtures/${name}.html.gz`, import.meta.url)))).toString(
    'utf8',
  );
}

const SEEN = '2026-09-14';
const cardOffers = parseCardOffers(fixture('doc-card-bonuses'), SEEN);
const bankOffers = parseBankOffers(fixture('doc-bank-bonuses'), SEEN);

function cardFor(cardId: string): CardOffer {
  const found = cardOffers.find((offer) => offer.cardId === cardId);
  assert.ok(found, `no offer parsed for ${cardId}`);
  return found;
}

function bankFor(pattern: RegExp): BankOffer {
  const found = bankOffers.find((offer) => pattern.test(offer.bankName));
  assert.ok(found, `no bank offer matching ${pattern}`);
  return found;
}

// ---- yields ----------------------------------------------------------------

test('the card page yields a plausible number of offers, most of them matched', () => {
  assert.ok(cardOffers.length >= 60, `expected 60+ card offers, got ${cardOffers.length}`);
  const matched = cardOffers.filter((offer) => offer.cardId !== null);
  assert.ok(
    matched.length / cardOffers.length >= 0.6,
    `expected 60%+ matched to the catalog, got ${matched.length}/${cardOffers.length}`,
  );
});

test('the bank page yields its full list, not just the first section', () => {
  // 174 of the 255 headings are in the state-specific section, so a parser that stops early looks
  // almost right — 80 offers would be a plausible-looking number and badly wrong.
  assert.ok(bankOffers.length >= 200, `expected 200+ bank offers, got ${bankOffers.length}`);
});

test('the changelog and the related-posts tail are excluded', () => {
  // "Recent Changes" entries are worded exactly like offer headings, so leaking them in produces
  // stale offers that look current.
  for (const offer of [...cardOffers, ...bankOffers]) {
    const title = 'title' in offer ? offer.title : offer.bankName;
    assert.ok(!/^\s*\[?(added|removed|update)/i.test(title), `changelog entry leaked: ${title}`);
  }
});

test('every offer carries the snapshot date it came from', () => {
  for (const offer of [...cardOffers, ...bankOffers]) assert.equal(offer.seenAt, SEEN);
});

// ---- the fields that quietly come back empty ------------------------------

test('the annual fee is not mistaken for the minimum spend', () => {
  // "125k with $15k spend within five months. Card has $695 annual fee." A matcher that reads the
  // fee first assigns $695 as the spend, which is entirely plausible and entirely wrong.
  const executive = cardFor('citi-aa-executive');
  assert.equal(executive.minSpendCents, 1_500_000, '$15,000');
  assert.equal(executive.spendWindowDays, 150, 'five months');
  assert.equal(executive.amount, 125_000);
  assert.equal(executive.unit, 'miles');
});

test('a heading with a dollar credit beside a points bonus stays in points', () => {
  // "Capital One Venture 75,000 + $300" — reading the unit off the whole heading calls this a
  // $75,000 cash bonus.
  const venture = cardFor('capitalone-venture');
  assert.equal(venture.amount, 75_000);
  assert.equal(venture.unit, 'points');
  assert.equal(venture.minSpendCents, 400_000, '$4,000');
  assert.equal(venture.spendWindowDays, 90, '3 months');
});

test('a genuine dollar bonus is read as dollars', () => {
  const doubleCash = cardFor('citi-double-cash');
  assert.equal(doubleCash.amount, 200);
  assert.equal(doubleCash.unit, 'dollars');
  assert.equal(doubleCash.minSpendCents, 150_000, '$1,500');
  assert.equal(doubleCash.spendWindowDays, 180, 'six months');
});

test('the largest figure in a tiered heading is the headline bonus', () => {
  // "Barclays Wyndham Earner Premier – 120,000: 90k after $6,000 in 120 days and 30k after $750…"
  const wyndham = cardFor('barclays-wyndham-earner-premier');
  assert.equal(wyndham.amount, 120_000);
  assert.equal(wyndham.minSpendCents, 600_000, 'the first tier is the one to plan around');
  assert.equal(wyndham.spendWindowDays, 120);
});

test('a spend window in days is not converted as months', () => {
  const offers = cardOffers.filter((offer) => offer.spendWindowDays > 0);
  assert.ok(offers.length > 30);
  for (const offer of offers) {
    assert.ok(
      offer.spendWindowDays >= 30 && offer.spendWindowDays <= 400,
      `${offer.title}: ${offer.spendWindowDays} days is not a real spend window`,
    );
  }
});

test('most matched offers carry a minimum spend', () => {
  // Some DoC blurbs genuinely do not state one — the figure is in the linked review — so this is a
  // proportion rather than a per-offer assertion. A regex regression takes it to near zero.
  const matched = cardOffers.filter((offer) => offer.cardId !== null);
  const withSpend = matched.filter((offer) => offer.minSpendCents > 0);
  assert.ok(
    withSpend.length / matched.length >= 0.5,
    `only ${withSpend.length}/${matched.length} matched offers have a minimum spend`,
  );
});

// ---- matching -------------------------------------------------------------

test('a card name that is a prefix of another does not steal its offer', () => {
  // The failure this guards is specific and was real: `/sapphire reserve/` matched "Chase Sapphire
  // Reserve for Business", attaching a business card's offer to the personal card — and with it
  // the personal card's 5/24 cost and 48-month Sapphire clock.
  assert.equal(matchCard('Chase Sapphire Reserve for Business 200k Points'), 'chase-sapphire-reserve-business');
  assert.equal(matchCard('Chase Sapphire Reserve 100,000 Points'), 'chase-sapphire-reserve');
  assert.equal(matchCard('Capital One Business Spark Cash Select – $750'), 'capitalone-spark-cash-select');
  assert.equal(matchCard('Capital One Venture OneBusiness – 50,000 Points'), 'capitalone-venture-one-business');
  assert.equal(matchCard('American Express Business Gold 200,000 Points'), 'amex-business-gold');
  assert.equal(matchCard('Bank of America Premium Rewards Elite 75,000 Points'), 'boa-premium-rewards-elite');
  assert.equal(matchCard('Bank of America Premium Rewards 60,000 Points'), 'boa-premium-rewards');
  assert.equal(matchCard('Discover it Miles $100'), 'discover-it-miles');
});

test('an unrelated card from the same issuer is left unmatched', () => {
  // "Wells Fargo Choice Privileges" once matched Wells Fargo Autograph, because two of the three
  // tokens compared were the bank's own name.
  assert.equal(matchCard('Wells Fargo Choice Privileges 60,000 Points'), 'wellsfargo-choice-privileges');
  assert.equal(matchCard('Wells Fargo Some Card That Does Not Exist $500'), null);
  assert.equal(matchCard('Lafayette Federal Credit Union Mastercard – $600'), null);
  assert.equal(matchCard('Rakuten – Extra $250 On Bank of America Cards'), null);
});

test('a heading too vague to place is left unmatched rather than guessed', () => {
  // "American Express Delta – Up To 125,000" could be any of four Delta cards with different fees
  // and different family ranks. Guessing would attach the offer to the wrong rules.
  assert.equal(matchCard('American Express Delta – Up To 125,000'), null);
  assert.equal(matchCard('American Express Business Delta 70,000 Miles + $200'), null);
});

test('a heading beyond the promotional tail still matches', () => {
  assert.equal(
    matchCard('Chase Freedom Unlimited $200 – 5% On Gas & Grocery First Year – In Branch'),
    'chase-freedom-unlimited',
  );
  assert.equal(matchCard('Truist Premium Business Card: $1,000 Bonus After $15,000 In Spend'), 'truist-premium-business');
});

test('no two offers claim the same catalog card', () => {
  const ids = cardOffers.map((offer) => offer.cardId).filter((id): id is string => id !== null);
  assert.equal(new Set(ids).size, ids.length, 'a duplicate would make the recommender show a card twice');
});

test('every matched cardId exists in the catalog', () => {
  for (const offer of cardOffers) {
    if (offer.cardId === null) continue;
    assert.ok(CARDS_BY_ID[offer.cardId], `${offer.cardId} is not in the catalog`);
  }
});

test('an unmatched offer keeps its heading so it can still be shown', () => {
  const unmatched = cardOffers.filter((offer) => offer.cardId === null);
  assert.ok(unmatched.length > 0, 'DoC always lists cards nobody has curated');
  for (const offer of unmatched) {
    assert.ok(offer.title.length > 5);
    assert.ok(offer.amount > 0);
  }
});

// ---- bank offers ---------------------------------------------------------

test('the section decides the account type, not the heading', () => {
  // Chase's entry is under "Best Checking Account Bonuses" and titled "$300-$400 ($900 With
  // Savings)". Reading the heading first files a checking bonus under savings.
  const chase = bankFor(/^Chase$/);
  assert.equal(chase.accountType, 'checking');
  assert.equal(chase.bonusCents, 30_000, '$300 is the low tier');
  assert.equal(chase.bonusMaxCents, 90_000, '$900 with savings is the top');
});

test('the bullet list is read as a schema', () => {
  const usBank = bankFor(/^U\.S\. Bank$/);
  assert.equal(usBank.creditPull, 'soft');
  assert.equal(usBank.creditCardFundingCents, 25_000, 'can fund up to $250 with a credit card');
  assert.equal(usBank.requirements.directDepositCents, 200_000, 'direct deposit of $2,000-$8,000');
  assert.equal(usBank.directDepositRequired, true);
});

test('credit card funding that codes as a cash advance is flagged as such', () => {
  // An allowance that bills as a cash advance is worthless, so the two fields have to travel
  // together or the app recommends funding a bonus with a 25% APR withdrawal.
  const codesAsAdvance = bankOffers.filter((offer) => offer.creditCardFundingCodesAsCashAdvance);
  assert.ok(codesAsAdvance.length > 0, 'the page always has a few');
});

test('a bank offer with no credit card funding reports zero', () => {
  const wells = bankFor(/^Wells Fargo$/);
  assert.equal(wells.creditCardFundingCents, 0);
  assert.equal(wells.requirements.directDepositCents, 100_000, '$1,000 direct deposit required');
});

test('state restrictions are read from both heading conventions', () => {
  // Appended after a dash in most sections, and bracketed at the front in the state-specific one.
  const simmons = bankFor(/Simmons/);
  assert.deepEqual(simmons.states.sort(), ['AR', 'KS', 'MO', 'OK', 'TN', 'TX']);

  const bracketed = bankOffers.filter((offer) => offer.states.length > 0);
  assert.ok(bracketed.length >= 100, `expected 100+ state-restricted offers, got ${bracketed.length}`);
});

test('a nationwide offer claims no states', () => {
  // The trap being avoided: `IN`, `OR`, `ME`, `HI` and `DE` are all English words, so a loose
  // matcher turns "Bonus available IN branch" into an Indiana-only offer.
  assert.deepEqual(bankFor(/^Chase$/).states, []);
  assert.deepEqual(bankFor(/^Wells Fargo$/).states, []);
});

test('the bank name is stripped of the bonus, the product and the state bracket', () => {
  for (const offer of bankOffers) {
    assert.ok(offer.bankName.length > 1, `empty bank name from ${offer.id}`);
    assert.ok(!offer.bankName.includes('$'), `${offer.bankName} still has the bonus in it`);
    assert.ok(!/^\[/.test(offer.bankName), `${offer.bankName} still has the state bracket`);
    assert.ok(!/[&,:;-]$/.test(offer.bankName), `${offer.bankName} ends in a dangling conjunction`);
  }
});

test('every bank offer has a bonus and a usable id', () => {
  const ids = new Set<string>();
  for (const offer of bankOffers) {
    assert.ok(offer.bonusMaxCents > 0, `${offer.bankName} has no bonus`);
    assert.ok(offer.bonusCents <= offer.bonusMaxCents);
    assert.ok(!ids.has(offer.id), `duplicate id ${offer.id}`);
    ids.add(offer.id);
  }
});

test('account types are spread across the real sections', () => {
  const types = new Set(bankOffers.map((offer) => offer.accountType));
  assert.ok(types.has('checking'));
  assert.ok(types.has('savings'));
  assert.ok(types.has('business-checking'));
});

test('ChexSystems sensitivity is only claimed where the page says so', () => {
  // There is no field for it — DoC mentions it in prose or not at all — so inferring it from a
  // bank being a credit union would be inventing data about the user's approval odds.
  const sensitive = bankOffers.filter((offer) => offer.chexSensitive);
  assert.ok(sensitive.length < bankOffers.length / 10, 'far too many claimed as Chex-sensitive');
});
