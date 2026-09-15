/**
 * Parsing Doctor of Credit's two "best bonuses" pages.
 *
 * Neither page is a table. Each offer is an `<h3>` heading with the bonus baked into the text, one
 * or two `<p>` blurbs of English prose, and — on the bank page only — a `<ul>` of two to five
 * bullets whose *wording* is the schema. So this is heuristic extraction, not parsing, and it is
 * written to fail in the least destructive direction available:
 *
 *   - **An offer that will not parse is still emitted**, with its heading verbatim and whatever
 *     fields were readable. The heading alone is a usable "best bonuses" row. Dropping it would
 *     silently shrink the list, and nobody would notice.
 *   - **An offer that will not match a catalog card keeps `cardId: null`** rather than guessing.
 *     A wrong match is worse than no match: it would attach a real offer to the wrong card and
 *     then run the wrong issuer's rules against it.
 *   - **`refresh` refuses to overwrite a good snapshot with a bad one.** If a redesign drops the
 *     yield below a floor, it fails loudly and leaves the previous JSON in place. A tracker with
 *     last week's bonuses is fine; one with four bonuses because the markup moved is not.
 *
 * The regexes are ugly and that is inherent. What keeps them honest is `test/doc.test.ts`, which
 * runs them against checked-in fixtures of the real pages and asserts on counts and on specific
 * offers — so a change here that quietly stops matching min-spend shows up as a failing test
 * rather than as blank fields in the app.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BankAccountType, BankOffer, CardOffer, IssuerId } from '../core/model.ts';
import { CARDS } from '../core/data/cards.ts';
import { request } from './http.ts';

export const CARD_BONUS_URL = 'https://www.doctorofcredit.com/best-current-credit-card-sign-bonuses/';
export const BANK_BONUS_URL = 'https://www.doctorofcredit.com/best-bank-account-bonuses/';

const CARD_OFFERS_PATH = fileURLToPath(new URL('../core/data/card-offers.json', import.meta.url));
const BANK_OFFERS_PATH = fileURLToPath(new URL('../core/data/bank-offers.json', import.meta.url));

/**
 * Below these and a refresh is treated as a parser failure rather than a quiet week.
 *
 * Set at roughly a third of the observed yield (68 cards, 96 bank offers as of the first run).
 * Loose enough that DoC pruning its list is not an outage, tight enough that a markup change is.
 */
const MIN_CARD_OFFERS = 25;
const MIN_BANK_OFFERS = 30;

// ---- HTML, without a parser --------------------------------------------------

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The article body: from `entry-content` to the "Recent Changes" heading.
 *
 * Both ends are load-bearing. Before `entry-content` is nav and a sidebar full of headings. After
 * "Recent Changes" is the dated add/remove log — whose entries are worded exactly like offer
 * headings, "[Added] Chase $400 Checking Bonus" — followed by a related-posts block of yet more
 * offer-shaped headings. Without the trailing cut the bank page yields 250 offers where the real
 * count is 255 minus duplicates, and the extras are all stale or invented.
 *
 * "Final Thoughts" is checked too because the card page puts it after Recent Changes and either
 * may come first.
 */
function articleBody(html: string): string {
  const start = html.indexOf('entry-content');
  const body = start === -1 ? html : html.slice(start);
  // Matched against the heading's own text, so a mention of "recent changes" in a blurb does not
  // truncate the page.
  const end = body.search(/<h2[^>]*>(?:(?!<\/h2>)[\s\S])*?(?:Recent Changes|Final Thoughts)/i);
  return end === -1 ? body : body.slice(0, end);
}

interface Block {
  /** The nearest preceding `<h2>`, which is the section this offer sits in. */
  section: string;
  title: string;
  /** Everything between this `<h3>` and the next heading, tags intact. */
  html: string;
}

/** Splits the article into one block per `<h3>`, tagged with its `<h2>` section. */
function blocks(html: string): Block[] {
  const body = articleBody(html);
  const headings = [...body.matchAll(/<(h2|h3)\b[^>]*>([\s\S]*?)<\/\1>/gi)];

  const out: Block[] = [];
  let section = '';

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const level = heading[1].toLowerCase();
    const title = stripTags(heading[2]);

    if (level === 'h2') {
      section = title;
      continue;
    }
    if (title === '') continue;

    const from = (heading.index ?? 0) + heading[0].length;
    const to = headings[index + 1]?.index ?? body.length;
    out.push({ section, title, html: body.slice(from, to) });
  }

  return out;
}

// ---- numbers out of prose ---------------------------------------------------

const WORD_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

/** `$12,000` / `$15k` / `12,000` → cents. Handles the `k` shorthand DoC uses interchangeably. */
function moneyToCents(raw: string, kSuffix: boolean): number {
  const value = Number(raw.replace(/,/g, ''));
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * (kSuffix ? 1000 : 1) * 100);
}

/**
 * The annual fee, and the phrase it came from.
 *
 * The phrase is returned so the caller can cut it out of the text before looking for the minimum
 * spend. Without that, "Card has $695 annual fee" hands `695` to the spend matcher — and $695 is a
 * perfectly plausible minimum spend, so the error is invisible.
 */
function annualFee(text: string): { cents: number; waivedFirstYear: boolean; phrase: string | null } {
  const waivedFirstYear = /annual fee[^.]{0,40}waived|waived[^.]{0,30}first year|no annual fee the first year/i.test(text);

  const patterns = [
    /\$\s?([\d,]+)(k)?\s*(?:non-waived\s+)?annual fee/i,
    /annual fee (?:of|is)\s*\$\s?([\d,]+)(k)?/i,
    /\$\s?([\d,]+)(k)?\s*(?:yearly|per year) fee/i,
  ];
  for (const pattern of patterns) {
    const found = pattern.exec(text);
    if (found) {
      return { cents: moneyToCents(found[1], Boolean(found[2])), waivedFirstYear, phrase: found[0] };
    }
  }
  if (/no annual fee/i.test(text)) return { cents: 0, waivedFirstYear, phrase: 'no annual fee' };
  return { cents: 0, waivedFirstYear, phrase: null };
}

/** The minimum spend. Run against text with the annual-fee phrase already removed. */
function minSpendCents(text: string): number {
  const patterns = [
    // "$12,000 spend", "$15k in spend", "$6,000 in spend"
    /\$\s?([\d,]+)(k)?\s+(?:in\s+)?spend/i,
    // "spending $4,000", "spend of $6,000", "spend $8,000"
    /spend(?:ing)?\s+(?:of\s+)?\$\s?([\d,]+)(k)?/i,
    // "after $3,000", "with $15k"
    /(?:after|with|requires?)\s+\$\s?([\d,]+)(k)?/i,
    // "$8,000 within four months"
    /\$\s?([\d,]+)(k)?\s+within/i,
  ];
  for (const pattern of patterns) {
    const found = pattern.exec(text);
    if (found) return moneyToCents(found[1], Boolean(found[2]));
  }
  return 0;
}

/**
 * The spend window, in days.
 *
 * Months are converted at 30 days, which is approximate and deliberately so. The real window is a
 * number of *statement cycles* whose length depends on the account's cycle date, which is not
 * knowable from a web page. It feeds a reminder with a 45-day lead, so being two days out changes
 * nothing; the alternative of storing "6 months" and re-deriving it everywhere would be precision
 * the source does not have.
 */
function spendWindowDays(text: string): number {
  const number = (raw: string): number => WORD_NUMBERS[raw.toLowerCase()] ?? Number(raw);

  const patterns: Array<{ pattern: RegExp; unit: 'day' | 'month' }> = [
    { pattern: /within\s+(?:the\s+first\s+)?([\d]+|[a-z]+)\s+days?/i, unit: 'day' },
    { pattern: /in\s+(?:the\s+first\s+)?([\d]+|[a-z]+)\s+days?/i, unit: 'day' },
    { pattern: /within\s+(?:the\s+first\s+)?([\d]+|[a-z]+)\s+months?/i, unit: 'month' },
    { pattern: /in\s+(?:the\s+first\s+)?([\d]+|[a-z]+)\s+months?/i, unit: 'month' },
    // "within three billing cycles" — a cycle is a month for this purpose.
    { pattern: /within\s+([\d]+|[a-z]+)\s+(?:billing\s+)?(?:cycles?|statements?)/i, unit: 'month' },
    { pattern: /first\s+([\d]+|[a-z]+)\s+months?/i, unit: 'month' },
  ];

  for (const { pattern, unit } of patterns) {
    const found = pattern.exec(text);
    if (found) {
      const count = number(found[1]);
      if (!Number.isFinite(count) || count <= 0) continue;
      return unit === 'day' ? count : count * 30;
    }
  }
  // Three months is the most common window by a wide margin, and it is the assumption the app
  // makes visible: a wrong deadline is corrected once, a missing one is never noticed.
  return 90;
}

const STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA',
  'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM',
  'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA',
  'WV', 'WI', 'WY',
]);

/**
 * State restrictions, from the heading.
 *
 * Only from the heading, never the blurb. DoC appends the states to a heading when an offer is
 * limited ("Simmons Bank – $900 Checking Bonus – AR, TX, TN, OK, MO & KS"), whereas the blurb
 * mentions states for all sorts of other reasons. Two-letter tokens are also ambiguous — `IN`,
 * `OR`, `ME`, `HI` and `DE` are all English words — so requiring two or more, or an explicit
 * "only"/"residents" nearby, keeps "Bonus available IN branch" from becoming Indiana.
 */
function statesFrom(title: string): string[] {
  // Two conventions, both in use. The bank page's state-specific section leads with a bracket —
  // "[AR, MS, TN only] Orion Financial $150 Checking Bonus" — while everywhere else the states are
  // appended after a dash. A bracket is unambiguous, so it is trusted even for a single state.
  const bracket = /^\s*\[([^\]]*)\]/.exec(title);
  const scope = bracket ? bracket[1] : title.split(/[–—-]/).slice(1).join(' ');

  const unique = [
    ...new Set(
      [...scope.matchAll(/\b([A-Z]{2})\b/g)].map((match) => match[1]).filter((code) => STATE_CODES.has(code)),
    ),
  ];

  if (bracket !== null) return unique;
  if (unique.length >= 2) return unique;
  // A lone two-letter token is as likely to be an English word — IN, OR, ME, HI, DE — so it needs
  // corroboration from the heading.
  if (unique.length === 1 && /\b(only|residents?|state)\b/i.test(title)) return unique;
  return [];
}

// ---- matching a heading to a catalog card -----------------------------------

/**
 * Issuer names as DoC writes them, mapped to ids.
 *
 * Longest-first matching, because "Bank of America" contains "America" and "U.S. Bank" contains
 * "Bank" — a shortest-first pass assigns half the page to the wrong issuer.
 */
const ISSUER_PATTERNS: Array<[RegExp, IssuerId]> = [
  [/american express|amex/i, 'amex'],
  [/bank of america|\bboa\b/i, 'boa'],
  [/capital one|cap ?1\b/i, 'capitalone'],
  [/u\.?s\.? bank/i, 'usbank'],
  [/wells fargo/i, 'wellsfargo'],
  [/navy federal|navyfed/i, 'navyfed'],
  [/first national/i, 'firstnational'],
  [/barclays?/i, 'barclays'],
  [/synchrony/i, 'synchrony'],
  [/discover/i, 'discover'],
  [/penfed/i, 'penfed'],
  [/truist/i, 'truist'],
  [/\bbilt\b/i, 'bilt'],
  [/\bciti\b/i, 'citi'],
  [/\bchase\b/i, 'chase'],
];

function issuerOf(text: string): IssuerId | null {
  for (const [pattern, issuer] of ISSUER_PATTERNS) {
    if (pattern.test(text)) return issuer;
  }
  return null;
}

/**
 * Headings that token matching gets wrong, mapped by hand.
 *
 * Each of these is here for a reason token overlap cannot fix: DoC calls the card by a different
 * name than the issuer does ("Ink Cash/Unlimited Business" is *three* cards in one heading), or the
 * heading omits the issuer entirely. Checked before the token matcher, against the full heading.
 *
 * **Order matters, and the rule is most specific first.** Every entry is a substring test, so
 * `/sapphire reserve/` also matches "Sapphire Reserve for Business" — a genuinely different card
 * with different rules — and would claim it before a business-specific pattern ever ran. The
 * business and premium variants therefore come before the plain ones throughout.
 */
const ALIASES: Array<[RegExp, string]> = [
  [/sapphire reserve for business/i, 'chase-sapphire-reserve-business'],
  [/business[^,;.]{0,20}altitude connect|altitude connect[^,;.]{0,20}business/i, 'usbank-business-altitude-connect'],
  // "VentureOne Business" and "Venture Business" differ by three letters and are different cards,
  // so the one-word variant has to be tested first.
  [/venture\s?one\s?business/i, 'capitalone-venture-one-business'],
  [/venture x business|venture business/i, 'capitalone-venture-x-business'],
  [/ink (?:business )?cash/i, 'chase-ink-cash'],
  [/ink (?:business )?unlimited/i, 'chase-ink-unlimited'],
  [/ink (?:business )?preferred/i, 'chase-ink-preferred'],
  [/ink (?:business )?premier/i, 'chase-ink-premier'],
  [/aadvantage executive/i, 'citi-aa-executive'],
  [/aadvantage (?:platinum|select)/i, 'citi-aa-platinum'],
  [/aadvantage business/i, 'citi-aa-business'],
  [/aviator/i, 'barclays-aviator-red'],
  [/strata premier/i, 'citi-strata-premier'],
  [/strata elite/i, 'citi-strata-elite'],
  [/blue business plus/i, 'amex-blue-business-plus'],
  [/blue business cash/i, 'amex-blue-business-cash'],
  [/blue cash preferred/i, 'amex-blue-cash-preferred'],
  [/blue cash everyday/i, 'amex-blue-cash-everyday'],
  [/business platinum/i, 'amex-business-platinum'],
  [/business gold/i, 'amex-business-gold'],
  [/spark cash plus/i, 'capitalone-spark-cash-plus'],
  [/venture x business/i, 'capitalone-venture-x-business'],
  [/venture x/i, 'capitalone-venture-x'],
  [/signify/i, 'wellsfargo-signify-business'],
  [/autograph journey/i, 'wellsfargo-autograph-journey'],
  [/triple cash/i, 'usbank-triple-cash-business'],
  [/business altitude connect/i, 'usbank-business-altitude-connect'],
  [/altitude reserve/i, 'usbank-altitude-reserve'],
  [/leverage/i, 'usbank-leverage'],
  [/premium rewards elite/i, 'boa-premium-rewards-elite'],
  [/premium rewards/i, 'boa-premium-rewards'],
  [/sapphire preferred/i, 'chase-sapphire-preferred'],
  [/sapphire reserve/i, 'chase-sapphire-reserve'],
  [/marriott bonvoy brilliant/i, 'amex-marriott-brilliant'],
  [/marriott bonvoy bevy/i, 'amex-marriott-bevy'],
  [/marriott bonvoy business/i, 'amex-marriott-business'],
  [/marriott bonvoy boundless/i, 'chase-marriott-boundless'],
  [/marriott bonvoy bountiful/i, 'chase-marriott-bountiful'],
  [/wyndham (?:rewards )?earner premier/i, 'barclays-wyndham-earner-premier'],
  [/wyndham (?:rewards )?earner business/i, 'barclays-wyndham-business'],
  [/hilton (?:honors )?aspire/i, 'amex-hilton-aspire'],
  [/hilton (?:honors )?surpass/i, 'amex-hilton-surpass'],
  [/hilton (?:honors )?business/i, 'amex-hilton-business'],
  [/flagship/i, 'navyfed-flagship'],
  [/pathfinder/i, 'penfed-pathfinder'],
];

/** Words that carry no signal and would otherwise dominate a token overlap score. */
const STOP_WORDS = new Set([
  'card', 'cards', 'credit', 'rewards', 'reward', 'bonus',
  // Not stopped either: `headingCore` has already cut the heading before the bonus, so a surviving
  // "Points" or "Miles" is part of the product's name — "Discover it Miles", "Citi AT&T Points
  // Plus" — and both are distinct cards from the ones they would otherwise collide with. No
  // catalog name contains either word, so keeping them can only prevent false matches.
  'signup', 'sign', 'up', 'the', 'a', 'and', 'or', 'with', 'new',
  'increased', 'offer', 'k', 'airlines', 'airline', 'plus',
  // Not stopped, deliberately: "business" and "personal" are the only thing separating Amex Gold
  // from Amex Business Gold, and BoA Alaska from BoA Alaska Business.
  // The issuer's own name, on both sides. Matching is already constrained to one issuer, so these
  // tokens can only inflate a score — and inflate it most for the cards with the fewest
  // distinguishing words. Leaving them in matched the catalog's "Wells Fargo Autograph" against
  // DoC's "Wells Fargo Choice Privileges" at 2/3, because two of the three tokens were the bank.
  'american', 'express', 'amex', 'chase', 'citi', 'citibank', 'capital', 'one', 'bank', 'of',
  'america', 'boa', 'barclays', 'barclay', 'us', 'u', 's', 'usbank', 'wells', 'fargo', 'discover',
  'synchrony', 'penfed', 'navy', 'federal', 'truist', 'bilt', 'mastercard', 'visa',
]);

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word !== '' && !STOP_WORDS.has(word) && !/^\d+$/.test(word)),
  );
}

/**
 * The card-name part of a heading, with the bonus and the sales pitch cut off.
 *
 * Doctor of Credit writes every heading as `<card name>` followed by the offer, separated by a
 * dash, a colon, a dollar sign, or just the number — "Chase Freedom Unlimited $200 – 5% On Gas &
 * Grocery First Year – In Branch". Cutting at the first of those is what makes the scoring below
 * safe in both directions at once, and neither normalisation survives without it:
 *
 *   - Scoring against the whole heading loses real matches, because eight words of promotion
 *     swamp the two that name the card.
 *   - Scoring only on how much of the *catalog* name appears creates false ones, because "Capital
 *     One Venture" is fully contained in "Capital One Venture OneBusiness" and "Spark Cash" in
 *     "Spark Cash Select" — different cards, matched confidently and wrongly.
 *
 * With the tail gone, both sides are card names and a symmetric comparison is meaningful.
 */
function headingCore(title: string): string {
  const cut = title.search(/[–—:$]| - |\d/);
  return cut === -1 ? title : title.slice(0, cut);
}

/**
 * The catalog card a DoC heading refers to, or null.
 *
 * Aliases first, then token overlap constrained to the matched issuer. The issuer constraint is
 * what makes the token matcher safe: without it "Gold" is a coin toss between Amex Gold and Amex
 * Business Gold and Alaska's card, and a wrong match silently attaches the offer to the wrong
 * rules. Below the threshold it returns null rather than the best guess.
 */
export function matchCard(title: string): string | null {
  const issuer = issuerOf(title);

  for (const [pattern, cardId] of ALIASES) {
    if (!pattern.test(title)) continue;
    // An alias still has to agree with the issuer when the heading names one — "Chase Ink Cash"
    // and a hypothetical other bank's "Ink" card must not collide.
    const card = CARDS.find((entry) => entry.id === cardId);
    if (card && (issuer === null || card.issuer === issuer)) return cardId;
  }

  if (issuer === null) return null;

  const wanted = tokens(headingCore(title));
  if (wanted.size === 0) return null;
  let best: { id: string; score: number } | null = null;

  for (const card of CARDS) {
    if (card.issuer !== issuer) continue;
    const have = tokens(card.name);
    if (have.size === 0) continue;
    let overlap = 0;
    for (const word of have) if (wanted.has(word)) overlap += 1;
    /**
     * Normalised by whichever side has more words, not by the catalog name.
     *
     * Normalising by the catalog name alone rewards being a *subset* of the heading, which is
     * exactly the wrong bias: "Amex Gold" is a perfect subset of "Amex Business Gold" and scored
     * 1.0 against it. Taking the max means a heading with a discriminating word the catalog name
     * lacks — "business", "elite", "x" — is penalised for it, which is the whole point.
     */
    const score = overlap / Math.max(have.size, wanted.size);
    if (best === null || score > best.score) best = { id: card.id, score };
  }

  // Two thirds of the distinguishing words have to line up. Below that, the heading is about
  // something else — a card not in the catalog, most often.
  return best !== null && best.score >= 0.66 ? best.id : null;
}

// ---- credit card offers -----------------------------------------------------

/**
 * The bonus amount and its unit, from the heading.
 *
 * The largest number wins, because DoC writes tiered bonuses as "$300-$400" or "120,000: 90k after
 * … and 30k after …" and the headline figure is the total.
 *
 * The unit is decided by *that* number rather than by the heading as a whole, which matters more
 * than it looks. "Capital One Venture 75,000 + $300" contains a dollar sign, so a heading-wide test
 * calls the 75,000 points a $75,000 cash bonus — off by a factor of a thousand and in the wrong
 * currency. Only a `$` immediately before the winning number makes it dollars.
 */
function bonusFromTitle(title: string): { amount: number; unit: 'points' | 'miles' | 'dollars' } {
  const found = [...title.matchAll(/(\$\s?)?([\d][\d,]*)(k)?\b/gi)].map((match) => ({
    amount: Number(match[2].replace(/,/g, '')) * (match[3] ? 1000 : 1),
    dollars: Boolean(match[1]),
  }));
  if (found.length === 0) return { amount: 0, unit: 'points' };

  const best = found.reduce((winner, entry) => (entry.amount > winner.amount ? entry : winner));

  const unit: 'points' | 'miles' | 'dollars' = best.dollars
    ? 'dollars'
    : /\bmiles?\b/i.test(title)
      ? 'miles'
      : 'points';

  return { amount: best.amount, unit };
}

export function parseCardOffers(html: string, seenAt: string): CardOffer[] {
  const out: CardOffer[] = [];
  const seen = new Set<string>();

  for (const block of blocks(html)) {
    // Sections that are commentary rather than offers. "Recent Changes" in particular is a dated
    // add/remove log whose entries look exactly like offer headings.
    if (/recent changes|not on (?:the )?list|final thoughts|contents/i.test(block.section)) continue;
    if (/recent changes|final thoughts/i.test(block.title)) continue;

    const prose = stripTags(block.html);
    // A heading with no prose under it is a subheading, not an offer.
    if (prose.length < 20) continue;

    const fee = annualFee(prose);
    // Cut the fee phrase out before looking for spend — see `annualFee`.
    const forSpend = fee.phrase === null ? prose : prose.split(fee.phrase).join(' ');

    const { amount, unit } = bonusFromTitle(block.title);
    if (amount === 0) continue;

    const cardId = matchCard(block.title);
    // Two headings can match one card — DoC lists Ink Cash and Ink Unlimited under a shared
    // heading and sometimes separately. Keep the first, which is the higher-placed and so the
    // better offer, since the page is ordered best-first.
    const key = cardId ?? `unmatched:${block.title}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      cardId,
      title: block.title,
      issuer: issuerOf(block.title),
      amount,
      unit,
      minSpendCents: minSpendCents(forSpend),
      spendWindowDays: spendWindowDays(forSpend),
      historicalHigh: /historical(?:ly)? high|all[- ]time high|highest[- ]ever|best[- ]ever/i.test(prose),
      targeted: /ymmv|targeted/i.test(block.section) || /\btargeted\b/i.test(block.title),
      states: statesFrom(block.title),
      notes: prose.slice(0, 400),
      seenAt,
    });
  }

  return out;
}

// ---- bank offers ------------------------------------------------------------

/**
 * Checking, savings, or business — from the section first, and only then the heading.
 *
 * The section wins because it is the page's own classification and the heading is prose. Chase's
 * entry sits under "Best Checking Account Bonuses" and is titled "$300-$400 ($900 With Savings)";
 * reading the heading first files a checking bonus under savings.
 */
function accountTypeOf(section: string, title: string): BankAccountType {
  const business = /business/i.test(section) || /business/i.test(title);

  const sectionSavings = /savings?/i.test(section);
  const sectionChecking = /checking/i.test(section);
  // Only consult the heading when the section did not say. A section naming one of them is
  // decisive; the state-specific and region-specific sections name neither.
  const savings = sectionSavings || (!sectionChecking && /\bsavings?\b/i.test(title));

  if (business) return savings ? 'business-savings' : 'business-checking';
  if (savings) return 'savings';
  if (/brokerage|invest/i.test(section) || /brokerage|e\*?trade|schwab|fidelity/i.test(title)) {
    return 'brokerage';
  }
  return 'checking';
}

/** `$300-$400 ($900 With Savings)` → the low and the high, in cents. */
function bonusRange(title: string): { low: number; high: number } {
  const amounts = [...title.matchAll(/\$\s?([\d][\d,]*)(k)?/gi)].map((match) =>
    moneyToCents(match[1], Boolean(match[2])),
  );
  if (amounts.length === 0) return { low: 0, high: 0 };
  return { low: Math.min(...amounts), high: Math.max(...amounts) };
}

/**
 * The bullet list, which is where the bank page keeps its structured fields.
 *
 * Read as text per `<li>` rather than by position: the bullets are in a consistent order most of
 * the time and DoC does occasionally reorder or omit one, and a positional read would then assign
 * the direct-deposit line to credit-card funding.
 */
function bankBullets(html: string): string[] {
  return [...html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
    .map((match) => stripTags(match[1]))
    .filter((line) => line !== '');
}

export function parseBankOffers(html: string, seenAt: string): BankOffer[] {
  const out: BankOffer[] = [];
  const seen = new Set<string>();

  for (const block of blocks(html)) {
    if (/recent changes|contents|final thoughts/i.test(block.section)) continue;
    if (/recent changes/i.test(block.title)) continue;
    // The page's five real sections all contain one of these words. Anything else under an
    // unrecognised `<h2>` is commentary.
    if (!/checking|saving|bonus|business|state|region|branch/i.test(block.section)) continue;

    const bonus = bonusRange(block.title);
    if (bonus.high === 0) continue;

    const bullets = bankBullets(block.html);
    const bulletText = bullets.join(' | ');
    const prose = stripTags(block.html.replace(/<ul\b[\s\S]*?<\/ul>/gi, ' '));
    const all = `${prose} ${bulletText}`;

    const id = slug(block.title);
    if (seen.has(id)) continue;
    seen.add(id);

    // Direct deposit. Three shapes: "not required", "required, no minimum", and an amount — which
    // may be a range, in which case the low end is what actually unlocks a bonus tier.
    const ddNotRequired = /direct deposit(?:s)? (?:is |are )?not required|no direct deposit/i.test(all);
    const ddAmount = /\$\s?([\d][\d,]*)(k)?(?:\s*-\s*\$\s?[\d][\d,]*k?\+?)?\s*(?:in\s+)?(?:total\s+)?direct deposit|direct deposit(?:s)? of \$\s?([\d][\d,]*)(k)?/i.exec(all);
    const directDepositCents = ddNotRequired
      ? 0
      : ddAmount
        ? moneyToCents(ddAmount[1] ?? ddAmount[3], Boolean(ddAmount[2] ?? ddAmount[4]))
        : 0;
    const directDepositRequired =
      !ddNotRequired && /direct deposit/i.test(all) && !/optional/i.test(all);

    const ddCount = /(\d+|two|three|four|five|six)\s+(?:separate\s+)?direct deposits/i.exec(all);

    const balance = /\$\s?([\d][\d,]*)(k)?\s*(?:deposit|balance)/i.exec(all);
    const holdDays = /(\d+)\+?\s*days?/i.exec(all);
    const holdMonths = /(\d+|two|three|four|five|six)\s+months?/i.exec(all);
    const debits = /(\d+)\s+(?:debit|purchase|qualifying) transactions?/i.exec(all);

    const funding = creditCardFunding(all);

    out.push({
      id,
      bankName: bankNameOf(block.title),
      accountType: accountTypeOf(block.section, block.title),
      bonusCents: bonus.low,
      bonusMaxCents: bonus.high,
      requirements: {
        directDepositCents,
        directDepositCount: ddCount ? (WORD_NUMBERS[ddCount[1].toLowerCase()] ?? Number(ddCount[1])) : 0,
        minBalanceCents: balance ? moneyToCents(balance[1], Boolean(balance[2])) : 0,
        holdDays: holdDays
          ? Number(holdDays[1])
          : holdMonths
            ? (WORD_NUMBERS[holdMonths[1].toLowerCase()] ?? Number(holdMonths[1])) * 30
            : 0,
        debitTransactions: debits ? Number(debits[1]) : 0,
      },
      directDepositRequired,
      creditPull: /hard pull/i.test(bulletText) ? 'hard' : /soft pull/i.test(bulletText) ? 'soft' : 'unknown',
      creditCardFundingCents: funding.cents,
      creditCardFundingCodesAsCashAdvance: funding.cashAdvance,
      states: statesFrom(block.title),
      inBranchOnly: /in[- ]branch|branch (?:only|specific)/i.test(`${block.section} ${block.title}`),
      // Only where DoC says so in prose. There is no field for it, and inferring "sensitive" from
      // a bank being a credit union would be inventing data.
      chexSensitive: /chex\s?systems?[^.]{0,40}sensitiv|sensitiv[^.]{0,40}chex\s?systems?/i.test(all),
      churnCooldownMonths: churnCooldown(all),
      url: offerUrl(block.html),
      notes: prose.slice(0, 400),
      seenAt,
    });
  }

  return out;
}

function creditCardFunding(text: string): { cents: number; cashAdvance: boolean } {
  const cashAdvance = /cash advance/i.test(text);
  if (/no credit card funding|credit card funding is not allowed/i.test(text)) {
    return { cents: 0, cashAdvance };
  }
  // Three phrasings, all in use on the page: "Can fund up to $250 with a credit card",
  // "$500 credit card funding, but it codes as cash advance", and "Credit card funding of $1,000".
  const amount =
    /fund(?:ing)? (?:up to )?\$\s?([\d][\d,]*)(k)?\s*with a (?:credit|debit) card/i.exec(text) ??
    /\$\s?([\d][\d,]*)(k)? (?:credit|debit) card funding/i.exec(text) ??
    /(?:credit|debit) card funding (?:of|up to) \$\s?([\d][\d,]*)(k)?/i.exec(text);
  if (amount) return { cents: moneyToCents(amount[1], Boolean(amount[2])), cashAdvance };
  return { cents: 0, cashAdvance };
}

/**
 * The bank's own "one bonus every N months" language, when DoC quotes it.
 *
 * This is the single most valuable field on the page for a churner and the one least reliably
 * present — it is what decides whether a bonus already collected can be collected again. Only
 * matched next to churn language, never from a bare "12 months" elsewhere in the prose, which
 * would far more often be a balance-holding period.
 */
function churnCooldown(text: string): number | null {
  const found =
    /anti[- ]?churn(?:ing)?[^.]{0,60}?(\d+)\s*months/i.exec(text) ??
    /(\d+)\s*months?[^.]{0,30}(?:instead of \d+ months)/i.exec(text) ??
    /(?:once every|not (?:had|received)[^.]{0,40}within)\s*(\d+)\s*months/i.exec(text);
  return found ? Number(found[1]) : null;
}

/**
 * The bank's name: the heading up to where the money starts.
 *
 * Also strips a leading state bracket, which is how the state-specific section — 174 of the page's
 * 255 offers — prefixes every heading: "[AR, MS, TN only] Orion Financial $150 Checking Bonus".
 */
function bankNameOf(title: string): string {
  return (
    title
      .replace(/^\s*\[[^\]]*\]\s*/, '')
      .split(/\$|–|—| - /)[0]
      .replace(/\b(bonus|checking|savings|account)\b/gi, '')
      .replace(/\s+/g, ' ')
      // A heading like "SoFi & Checking" leaves a dangling conjunction once the noun is gone.
      .replace(/[\s&,:;-]+$/, '')
      .trim() || title.trim()
  );
}

function offerUrl(html: string): string {
  // The offer link, not the "Read our full post" link — the first is the bank, the second is DoC.
  const links = [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  const direct = links.find((link) => /direct link to offer/i.test(stripTags(link[2])));
  if (direct) return direct[1];
  const full = links.find((link) => /read our full post/i.test(stripTags(link[2])));
  return full ? full[1] : '';
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 72);
}

// ---- the refresh ------------------------------------------------------------

export interface Snapshot<T> {
  source: string;
  fetchedAt: string;
  /** The page's `Last-Modified`, so the next refresh can ask conditionally. */
  lastModified: string | null;
  offers: T[];
}

export interface RefreshResult {
  cards: { count: number; matched: number; changed: boolean };
  banks: { count: number; changed: boolean };
  warnings: string[];
}

function readSnapshot<T>(path: string): Snapshot<T> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Snapshot<T>;
  } catch {
    return null;
  }
}

function writeSnapshot<T>(path: string, snapshot: Snapshot<T>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`);
}

/**
 * Fetches both pages and rewrites the snapshots.
 *
 * Called by the CLI and by the server's daily refresh. Returns rather than throws on a parse
 * shortfall, with the reason in `warnings` and the old snapshot left alone — a refresh is
 * best-effort background work and must never take the server down with it.
 */
export async function refresh(options: { force?: boolean } = {}): Promise<RefreshResult> {
  const warnings: string[] = [];
  const fetchedAt = new Date().toISOString();

  const previousCards = readSnapshot<CardOffer>(CARD_OFFERS_PATH);
  const previousBanks = readSnapshot<BankOffer>(BANK_OFFERS_PATH);

  const result: RefreshResult = {
    cards: { count: previousCards?.offers.length ?? 0, matched: 0, changed: false },
    banks: { count: previousBanks?.offers.length ?? 0, changed: false },
    warnings,
  };

  const cardPage = await request(CARD_BONUS_URL, {
    ifModifiedSince: options.force ? undefined : (previousCards?.lastModified ?? undefined),
  });
  if (cardPage.status === 304) {
    warnings.push('card bonuses unchanged since last fetch');
  } else if (!cardPage.ok) {
    warnings.push(`card bonuses: ${cardPage.error ?? 'fetch failed'}`);
  } else {
    const offers = parseCardOffers(cardPage.body, fetchedAt.slice(0, 10));
    const matched = offers.filter((offer) => offer.cardId !== null).length;
    if (offers.length < MIN_CARD_OFFERS) {
      warnings.push(
        `card bonuses: parsed only ${offers.length} offers (floor is ${MIN_CARD_OFFERS}) — keeping the previous snapshot, the page markup has probably changed`,
      );
    } else {
      writeSnapshot(CARD_OFFERS_PATH, {
        source: CARD_BONUS_URL,
        fetchedAt,
        lastModified: cardPage.lastModified,
        offers,
      });
      result.cards = { count: offers.length, matched, changed: true };
    }
  }

  const bankPage = await request(BANK_BONUS_URL, {
    ifModifiedSince: options.force ? undefined : (previousBanks?.lastModified ?? undefined),
  });
  if (bankPage.status === 304) {
    warnings.push('bank bonuses unchanged since last fetch');
  } else if (!bankPage.ok) {
    warnings.push(`bank bonuses: ${bankPage.error ?? 'fetch failed'}`);
  } else {
    const offers = parseBankOffers(bankPage.body, fetchedAt.slice(0, 10));
    if (offers.length < MIN_BANK_OFFERS) {
      warnings.push(
        `bank bonuses: parsed only ${offers.length} offers (floor is ${MIN_BANK_OFFERS}) — keeping the previous snapshot`,
      );
    } else {
      writeSnapshot(BANK_OFFERS_PATH, {
        source: BANK_BONUS_URL,
        fetchedAt,
        lastModified: bankPage.lastModified,
        offers,
      });
      result.banks = { count: offers.length, changed: true };
    }
  }

  return result;
}

/** The snapshots as the app reads them. Empty rather than throwing when a refresh has never run. */
export function loadCardOffers(): Snapshot<CardOffer> {
  return (
    readSnapshot<CardOffer>(CARD_OFFERS_PATH) ?? {
      source: CARD_BONUS_URL,
      fetchedAt: '',
      lastModified: null,
      offers: [],
    }
  );
}

export function loadBankOffers(): Snapshot<BankOffer> {
  return (
    readSnapshot<BankOffer>(BANK_OFFERS_PATH) ?? {
      source: BANK_BONUS_URL,
      fetchedAt: '',
      lastModified: null,
      offers: [],
    }
  );
}
