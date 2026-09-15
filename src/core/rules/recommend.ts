/**
 * What to apply for next.
 *
 * The flowchart is the authority and this file is a transcription of it, not a rewrite. Its
 * central claim is that the right next card depends on one thing above all others — whether you
 * are under 5/24 — and that the two branches are almost different games:
 *
 *   - **Under 5/24**: slots are the scarce resource. Spend them on Chase personal cards, which are
 *     the only cards you *cannot* get later, and fill the three-month gaps between Chase
 *     applications with business cards that are invisible to the count. Burning a slot on a
 *     non-Chase personal card is a real cost and only four or five cards justify it.
 *   - **Over 5/24**: slots are worthless and the constraint is bonus size against each bank's own
 *     patience. Work down the list from biggest bonus to smallest, spreading applications across
 *     banks. The flowchart's own words for this branch are "this is where things get fuzzy".
 *
 * So the scoring is not a single ranking with a 5/24 term in it. It is two rankings, and which one
 * runs is the first thing decided. A single blended score is how you end up recommending Amex
 * Platinum to someone at 2/24 — which the flowchart now explicitly says not to do, because taking
 * Platinum early costs the Gold and Green bonuses permanently *and* a Chase slot.
 *
 * The ordered lists below are transcribed from the v21 panels. They are opinions, and they are
 * `/u/m16p`'s opinions rather than this app's — which is why the strategy text travels with the
 * recommendations, quoted, so the user can see the reasoning and disagree with it.
 */

import type { Card, CardOffer, IssuerId, IsoDate, PlayerState } from '../model.ts';
import { CARDS, CARDS_BY_ID } from '../data/cards.ts';
import flowchartData from '../data/flowchart.json' with { type: 'json' };
import { assess, type Assessment, type Severity } from './issuers.ts';
import { count524, everHeld } from './counts.ts';
import { earliest, monthsBetween } from '../dates.ts';

/** The extracted flowchart, typed at the boundary. See `scripts/extract-flowchart.ts`. */
export interface FlowchartSection {
  id: string;
  heading: string;
  body: string;
}

export const FLOWCHART = flowchartData as {
  source: string;
  version: string;
  updatedAt: string | null;
  extractedAt: string;
  sections: Record<string, FlowchartSection>;
};

/**
 * Chase personal cards, in the flowchart's stated priority order.
 *
 * "Depending on your #/24-status, you'll be able to get up to 5 Chase personal cards in a
 * 24-month period. My highly-subjective and rough priority order:" — and then this list. Cards
 * the chart groups on one line ("United Quest, Explorer and/or Club") share a rank here, because
 * the chart is telling you to pick among them rather than take all three in order.
 */
const CHASE_PERSONAL_ORDER: string[][] = [
  ['chase-sapphire-preferred', 'chase-sapphire-reserve'],
  ['chase-united-quest', 'chase-united-explorer', 'chase-united-club'],
  ['chase-aeroplan'],
  ['chase-southwest-priority', 'chase-southwest-plus'],
  ['chase-marriott-boundless', 'chase-marriott-bountiful'],
  ['chase-ihg-premier'],
  ['chase-hyatt'],
  ['chase-british-airways', 'chase-aer-lingus', 'chase-iberia'],
  ['chase-freedom-flex', 'chase-freedom-unlimited'],
];

/** "For Chase business cards, my suggested priority order is:" */
const CHASE_BUSINESS_ORDER: string[][] = [
  ['chase-ink-cash', 'chase-ink-unlimited', 'chase-ink-preferred'],
  ['chase-united-business'],
  ['chase-hyatt-business'],
  ['chase-southwest-premier-business', 'chase-southwest-performance-business'],
  ['chase-ihg-business'],
];

/**
 * The over-5/24 travel column, in order.
 *
 * Transcribed from the "This is where things get fuzzy" panel. Its first two entries are
 * conditional on the count rather than absolute — Barclays at exactly 5/24, Capital One at 5–6/24
 * — because both issuers stop approving shortly after. `only524Range` carries that.
 */
const TRAVEL_ORDER: Array<{ ids: string[]; only524Range?: [number, number]; note?: string }> = [
  {
    ids: ['barclays-jetblue-plus', 'barclays-aviator-red', 'barclays-hawaiian', 'barclays-wyndham-earner-premier'],
    only524Range: [5, 5],
    note: 'At exactly 5/24 Barclays is still approving — one or two cards, same day if two. At 6+/24 expect a denial.',
  },
  {
    ids: ['capitalone-venture', 'capitalone-venture-x'],
    only524Range: [0, 6],
    note: 'Capital One approvals dry up above 5–6/24 and there is no reconsideration line.',
  },
  { ids: ['citi-strata-premier'], note: 'Look for 70k+. Usually wants 0–1 inquiries in 6 months.' },
  {
    ids: ['boa-alaska', 'boa-alaska-business', 'boa-virgin-atlantic', 'boa-air-france', 'boa-premium-rewards', 'boa-premium-rewards-elite'],
    note: 'A BoA deposit account helps approvals greatly. Two on the same day is sometimes possible.',
  },
  {
    ids: ['amex-platinum', 'amex-gold', 'amex-green', 'amex-delta-reserve', 'amex-delta-platinum', 'amex-delta-gold', 'amex-hilton-aspire', 'amex-hilton-surpass', 'amex-hilton-honors', 'amex-marriott-brilliant', 'amex-marriott-bevy'],
    note: 'Work up each family from the bottom so you collect every bonus on the way — see the Amex card-family panel.',
  },
  { ids: ['amex-blue-business-plus'], note: 'Great keeper: 2x on everything, no fee, keeps your MR account alive.' },
  { ids: ['wellsfargo-autograph-journey'] },
  { ids: ['citi-aa-platinum', 'citi-aa-business'] },
  { ids: ['bilt'], note: 'Priority depends entirely on your rent.' },
  { ids: ['citi-custom-cash'], note: 'Adds to your TYP balance without resetting the 48-month ThankYou clock.' },
  { ids: ['usbank-flexperks-gold'] },
  { ids: ['penfed-pathfinder', 'navyfed-flagship'] },
];

/** The over-5/24 cashback column, in order. From the "For cashback signup bonuses" panel. */
const CASHBACK_ORDER: Array<{ ids: string[]; only524Range?: [number, number]; note?: string }> = [
  {
    ids: ['capitalone-venture', 'capitalone-venture-x'],
    only524Range: [0, 6],
    note: 'There are ways to redeem Venture points essentially for cash.',
  },
  { ids: ['boa-business-unlimited', 'boa-business-customized'], note: '$500+.' },
  { ids: ['boa-premium-rewards', 'boa-premium-rewards-elite'] },
  { ids: ['usbank-leverage'], note: '$750+.' },
  { ids: ['usbank-business-altitude-connect'], note: '$600–$750.' },
  { ids: ['usbank-triple-cash-business'], note: '$500–$750. Be very careful with manufactured spend here.' },
  { ids: ['capitalone-spark-cash-plus'], note: 'Six months after Venture.' },
  { ids: ['capitalone-spark-miles'], note: 'Six months after Spark Cash.' },
  { ids: ['wellsfargo-signify-business'], note: 'Requires an existing Wells Fargo bank account.' },
  { ids: ['penfed-pathfinder'] },
  { ids: ['navyfed-flagship'] },
  { ids: ['usbank-altitude-reserve'], note: 'Inquiry count probably needs to be 0/6.' },
  { ids: ['citi-strata-premier'], note: '70k+; inquiries may need to be 0–1/6.' },
  { ids: ['amex-blue-business-cash'] },
  { ids: ['amex-blue-cash-everyday', 'amex-blue-cash-preferred'], note: 'BCE at $250+, BCP at $300+.' },
  { ids: ['capitalone-savor'], note: 'Six months after Spark.' },
  { ids: ['amex-gold', 'amex-platinum'], note: 'With a Schwab Platinum, MRs redeem to cash at 1.1 cents.' },
  { ids: ['usbank-altitude-connect'] },
];

/**
 * "Cards possibly worth burning a 5/24-slot for."
 *
 * The whole list, and it is short on purpose. Any other non-Chase personal card taken while under
 * 5/24 costs a Chase card you cannot get later, which is why `scoreUnder524` penalises it hard.
 */
const WORTH_BURNING_A_SLOT: Record<string, string> = {
  'capitalone-venture': 'Cap1 rarely approves above 5–6/24, and Venture points transfer 1:1 to airlines.',
  'capitalone-venture-x': 'Cap1 rarely approves above 5–6/24, and Venture points transfer 1:1 to airlines.',
  'citi-strata-premier': 'Starts the 48-month ThankYou clock sooner rather than later.',
  bilt: 'Only at roughly $4k+/month rent, with other spend to spare, and a year still to run under 5/24.',
};

export type Goal = 'travel' | 'cashback';

export interface Preferences {
  goal: Goal;
  /**
   * Whether business cards are on the table.
   *
   * The flowchart assumes yes — "It takes surprisingly little to qualify" — and the under-5/24
   * strategy largely collapses without them, since they are what fills the gaps between Chase
   * applications. Worth asking, because the chart also names the real exception: a work visa.
   */
  businessCards: boolean;
  /** Rent, in cents per month. Decides whether Bilt is anywhere near worth a slot. */
  monthlyRentCents: number;
  /** The largest minimum spend that is realistically meetable, in cents. Zero means no limit. */
  maxMinSpendCents: number;
  /** Issuers to leave alone — a past shutdown, or a bank someone simply refuses to deal with. */
  excludeIssuers: IssuerId[];
}

export const DEFAULT_PREFERENCES: Preferences = {
  goal: 'travel',
  businessCards: true,
  monthlyRentCents: 0,
  maxMinSpendCents: 0,
  excludeIssuers: [],
};

export type Phase = 'thin-file' | 'under-5-24' | 'at-the-edge' | 'over-5-24';

export type Verdict =
  | 'apply-now'
  | 'wait'
  | 'costs-a-slot'
  | 'blocked'
  | 'no-current-offer';

export interface Recommendation {
  card: Card;
  offer: CardOffer | null;
  verdict: Verdict;
  /** Lower sorts first. Comparable only within one call — it is a ranking, not a rating. */
  score: number;
  /** Why this card, in the order that matters. Shown as bullets. */
  reasons: string[];
  assessment: Assessment;
  /** When a `wait` or `blocked` card becomes available. */
  availableAt: IsoDate | null;
  /**
   * Cards the flowchart puts at the same rank as this one.
   *
   * The chart groups cards on a single line — "United Quest, Explorer and/or Club", "Sapphire
   * Preferred or Reserve" — and that phrasing means *pick one*, not take all three. Listing them as
   * three separate numbered recommendations both misrepresents the advice and repeats one sentence
   * down three rows. So the group collapses: the best-scoring member leads and the rest ride along
   * here, for the UI to show as "or".
   */
  alternatives: Array<{ card: Card; offer: CardOffer | null }>;
}

export interface Plan {
  asOf: IsoDate;
  phase: Phase;
  count524: number;
  /** The flowchart panels that apply right now, quoted, to show the reasoning behind the list. */
  strategy: FlowchartSection[];
  /** The flowchart's own version and date, so a stale plan can say so. */
  flowchart: { version: string; updatedAt: string | null };
  recommendations: Recommendation[];
  /** Cards worth having that are currently gated, with the date each opens up. */
  waiting: Recommendation[];
}

/**
 * Which branch of the flowchart applies.
 *
 * `at-the-edge` is not in the chart as a named state, but the chart repeatedly treats exactly-5/24
 * as its own moment — it is when Barclays and Capital One are still possible and Chase is not, and
 * the chart says to take those cards *now*. Collapsing it into `over-5-24` loses that.
 */
export function phaseOf(state: PlayerState, asOf: IsoDate): Phase {
  const count = count524(state, asOf).count;

  // The newbie panel is about the *age* of the file, not the size of it: "Usually at least a year
  // of CC history is required to get many cards listed here." Counting cards instead put someone
  // with a single card from 2018 — eight years of history and an obvious Chase candidate — on the
  // beginner path.
  const oldest = earliest(state.cards.map((account) => account.openedAt));
  if (oldest === null || monthsBetween(oldest, asOf) < 12) return 'thin-file';

  if (count < 5) return 'under-5-24';
  if (count === 5) return 'at-the-edge';
  return 'over-5-24';
}

function orderFor(goal: Goal): Array<{ ids: string[]; only524Range?: [number, number]; note?: string }> {
  return goal === 'travel' ? TRAVEL_ORDER : CASHBACK_ORDER;
}

/** Rank of a card within an ordered list of groups, or null when it is not on the list at all. */
function rankIn(orders: string[][], cardId: string): number | null {
  const index = orders.findIndex((group) => group.includes(cardId));
  return index === -1 ? null : index;
}

/**
 * Score under 5/24, where the scarce resource is slots.
 *
 * The gaps in the returned numbers are deliberate: Chase personal cards occupy 0–99, business
 * spacers 100–199, slot-burners 200–299, and everything else starts at 1000. That means no
 * combination of small bonuses can float an ordinary non-Chase personal card above a Chase card,
 * which is the entire point of the branch.
 */
function scoreUnder524(
  card: Card,
  offer: CardOffer | null,
  preferences: Preferences,
): { score: number; reasons: string[]; verdict: Verdict | null; group: string | null } {
  const reasons: string[] = [];

  if (card.issuer === 'chase') {
    const order = card.productType === 'personal' ? CHASE_PERSONAL_ORDER : CHASE_BUSINESS_ORDER;
    const rank = rankIn(order, card.id);
    if (rank === null) {
      return { score: 900, reasons: ['A Chase card, but not one the flowchart ranks.'], verdict: null, group: null };
    }

    /**
     * Row reasons say what is true of *this card*, not of the branch.
     *
     * These used to lead with "Chase personal cards are the only ones 5/24 can take away from you",
     * which is the single most important thing to know — and is therefore already stated once, above
     * the list, by whatever is presenting the phase. Repeated verbatim down five rows it stopped
     * being an argument and became wallpaper, and made the list look generated. The branch claim
     * belongs in `strategyFor`; a row gets the rank and the group it shares.
     */
    // Nothing here says "the flowchart groups this with two others" — `alternatives` carries that
    // structurally now, and a sentence repeating what the row already shows was the last of the
    // duplication that made this list look generated.
    if (card.productType === 'personal') {
      reasons.push(`#${rank + 1} of ${CHASE_PERSONAL_ORDER.length} on the flowchart's Chase personal list.`);
      return { score: rank * 10 - offerBonus(offer), reasons, verdict: null, group: `chase-personal-${rank}` };
    }
    reasons.push(
      `#${rank + 1} of ${CHASE_BUSINESS_ORDER.length} on the flowchart's Chase business list, and invisible to 5/24.`,
    );
    return { score: 100 + rank * 10 - offerBonus(offer), reasons, verdict: null, group: `chase-business-${rank}` };
  }

  // Non-Chase business cards that stay off the personal report: the spacers. The flowchart is
  // unambiguous that these are free — "get non-Chase business cards whenever you'd like".
  if (card.productType === 'business' && !card.showsOnPersonalReport) {
    if (!preferences.businessCards) return { score: 9000, reasons: [], verdict: null, group: null };
    reasons.push(
      'Costs no 5/24 slot, so it works as a spacer between Chase applications without delaying anything.',
    );
    return { score: 150 - offerBonus(offer), reasons, verdict: null, group: null };
  }

  // A personal card, or a business card that reports. Either way it costs a slot.
  const justification = WORTH_BURNING_A_SLOT[card.id];
  if (justification !== undefined) {
    if (card.id === 'bilt' && preferences.monthlyRentCents < 400_000) {
      return {
        score: 8000,
        reasons: [
          'The flowchart only puts Bilt on the burn-a-slot list at roughly $4k+/month rent; yours is below that.',
        ],
        verdict: 'costs-a-slot',
        group: null,
      };
    }
    reasons.push(`On the flowchart's short list of cards worth a 5/24 slot: ${justification}`);
    return { score: 200 - offerBonus(offer), reasons, verdict: 'costs-a-slot', group: null };
  }

  reasons.push(
    'Burns a 5/24 slot and is not on the flowchart\'s list of cards worth one. Every slot spent here is a Chase card you cannot get later.',
  );
  return { score: 1000 - offerBonus(offer), reasons, verdict: 'costs-a-slot', group: null };
}

/** Score over 5/24, where the constraint is bonus size against each bank's patience. */
function scoreOver524(
  card: Card,
  offer: CardOffer | null,
  count: number,
  preferences: Preferences,
): { score: number; reasons: string[]; verdict: Verdict | null; group: string | null } {
  const reasons: string[] = [];
  const orders = orderFor(preferences.goal);
  const index = orders.findIndex((group) => group.ids.includes(card.id));

  if (index === -1) {
    // Not on the column. Still worth showing, below everything that is — the flowchart's tail is
    // explicitly open-ended ("Plenty of $100-$150 bonus cards from smaller banks/CUs to consider
    // when way past 5/24 and out of higher-bonus options").
    return {
      score: 500 - offerBonus(offer),
      reasons: [`Not on the flowchart's ${preferences.goal} column, so it ranks below everything that is.`],
      verdict: null,
      group: null,
    };
  }

  const group = orders[index];
  if (group.only524Range) {
    const [low, high] = group.only524Range;
    if (count < low || count > high) {
      return {
        score: 700,
        reasons: [
          `The flowchart places this at ${low === high ? `exactly ${low}` : `${low}–${high}`}/24; you are ${count}/24. ${group.note ?? ''}`.trim(),
        ],
        verdict: 'wait',
        group: null,
      };
    }
  }

  reasons.push(
    `#${index + 1} on the flowchart's ${preferences.goal} column for someone past 5/24.`,
  );
  if (group.note) reasons.push(group.note);
  if (card.productType === 'business' && !preferences.businessCards) {
    return { score: 9000, reasons, verdict: null, group: null };
  }

  return { score: index * 10 - offerBonus(offer), reasons, verdict: null, group: `${preferences.goal}-${index}` };
}

/**
 * How much a live offer improves a card's rank.
 *
 * Small on purpose — at most 9 points against tier gaps of 10. The flowchart is deliberately
 * "current opening-bonus agnostic" and warns that bonuses change far too often to bake in, so an
 * offer breaks ties within a tier and cannot promote a card past one. A card with no live offer
 * at all is pushed down by 5 rather than removed, because DoC's list is the best bonuses and not
 * every bonus.
 */
function offerBonus(offer: CardOffer | null): number {
  if (offer === null) return -5;
  let bonus = 3;
  if (offer.historicalHigh) bonus += 6;
  if (offer.targeted) bonus -= 4;
  return bonus;
}

export interface PlanInput {
  state: PlayerState;
  asOf: IsoDate;
  offers?: CardOffer[];
  preferences?: Partial<Preferences>;
  /** Restrict to these cards. Used by the "should I get X?" screen. */
  onlyCardIds?: string[];
}

/** The flowchart panels that bear on the current phase, in the order they should be read. */
function strategyFor(phase: Phase, goal: Goal): FlowchartSection[] {
  const sections = FLOWCHART.sections;
  const wanted: string[] =
    phase === 'thin-file'
      ? ['notesNewbies', 'generalNotes', 'limitations']
      : phase === 'under-5-24'
        ? ['under524Approach', 'chaseCards', 'nonChaseBusinessCards', 'burnA524Slot', 'notesUnder524']
        : phase === 'at-the-edge'
          ? ['burnA524Slot', goal === 'travel' ? 'over524Travel' : 'over524Cashback', 'notesTiming']
          : [goal === 'travel' ? 'over524Travel' : 'over524Cashback', 'notesAmexFamily', 'notesTiming'];

  return wanted.map((id) => sections[id]).filter((section): section is FlowchartSection => Boolean(section));
}

/**
 * The plan: what to apply for, why, and what to wait for.
 *
 * Cards already held are dropped unless their bonus is available again — holding a card is not a
 * reason to be told to get it, but a 24-month cooldown that has expired very much is.
 */
export function plan(input: PlanInput): Plan {
  const { state, asOf } = input;
  const preferences: Preferences = { ...DEFAULT_PREFERENCES, ...input.preferences };
  const offers = input.offers ?? [];
  const offerByCard = new Map(offers.map((offer) => [offer.cardId, offer]));

  const phase = phaseOf(state, asOf);
  const count = count524(state, asOf).count;

  const candidates = (input.onlyCardIds ?? CARDS.map((card) => card.id))
    .map((id) => CARDS_BY_ID[id])
    .filter((card): card is Card => Boolean(card))
    .filter((card) => !preferences.excludeIssuers.includes(card.issuer))
    // Filtered here rather than inside the two scorers. It used to be handled in `scoreUnder524`,
    // and only in the branch for non-Chase business cards that stay off the personal report — so
    // Chase's Inks and the Capital One business cards that do report sailed straight past it, and
    // someone on a work visa was told to get an Ink Cash.
    .filter((card) => preferences.businessCards || card.productType === 'personal');

  const scored: Scored[] = [];

  for (const card of candidates) {
    const offer = offerByCard.get(card.id) ?? null;

    // A card whose minimum spend is out of reach is not a recommendation, it is a trap — the
    // flowchart's limitations panel says it assumes you can meet every MSR and that if you cannot,
    // "you have additional considerations beyond the scope of this flowchart".
    if (
      preferences.maxMinSpendCents > 0 &&
      offer !== null &&
      offer.minSpendCents > preferences.maxMinSpendCents
    ) {
      continue;
    }

    const assessment = assess({ state, target: card, asOf, catalog: CARDS_BY_ID });

    const held = everHeld(state, card.id);
    const stillHolding = state.cards.some(
      (account) => account.cardId === card.id && (account.status === 'open' || account.status === 'approved'),
    );
    // Held and blocked means "you have this and cannot get it again" — nothing to recommend.
    if (held !== null && (stillHolding || assessment.blocked)) continue;

    const branch =
      phase === 'under-5-24' || phase === 'thin-file'
        ? scoreUnder524(card, offer, preferences)
        : scoreOver524(card, offer, count, preferences);

    if (branch.score >= 8000) continue;

    const reasons = [...branch.reasons];
    let verdict: Verdict = branch.verdict ?? 'apply-now';
    let score = branch.score;

    if (assessment.blocked) {
      verdict = 'blocked';
      // Pushed below everything actionable, but kept: "blocked until April" is the answer to the
      // question people are really asking.
      score += 2000;
      reasons.unshift(...assessment.verdicts.filter((v) => v.severity === 'blocker').map((v) => v.message));
    } else {
      const gating = assessment.verdicts.filter(
        (v) => v.severity === 'caution' || v.severity === 'likely-denial',
      );
      if (gating.length > 0) {
        if (verdict === 'apply-now') verdict = 'wait';
        score += gating.some((v) => v.severity === 'likely-denial') ? 400 : 150;
        reasons.unshift(...gating.map((v) => v.message));
      }
      if (offer === null && verdict === 'apply-now') verdict = 'no-current-offer';
    }

    if (held !== null) {
      reasons.push(
        `You held this before (opened ${held.openedAt}) and closed it; the bonus cooldown has since expired.`,
      );
    }

    scored.push({
      card,
      offer,
      verdict,
      score,
      reasons,
      assessment,
      availableAt: assessment.availableAt,
      alternatives: [],
      group: branch.group,
    });
  }

  scored.sort((a, b) => a.score - b.score || a.card.name.localeCompare(b.card.name));

  return {
    asOf,
    phase,
    count524: count,
    strategy: strategyFor(phase, preferences.goal),
    flowchart: { version: FLOWCHART.version, updatedAt: FLOWCHART.updatedAt },
    recommendations: collapseGroups(
      scored.filter((entry) => entry.verdict !== 'blocked' && entry.verdict !== 'wait'),
    ),
    // The waiting list is not collapsed: each of those rows carries its own date and its own blocking
    // rule, so folding two of them into one would throw away the more useful half.
    waiting: scored.map(strip).filter((entry) => entry.verdict === 'blocked' || entry.verdict === 'wait'),
  };
}

/** A scored entry plus the flowchart group it came from, which only `collapseGroups` needs. */
type Scored = Recommendation & { group: string | null };

function strip(entry: Scored): Recommendation {
  const { group, ...rest } = entry;
  void group;
  return rest;
}

/**
 * Folds equal-rank cards into one recommendation with alternatives.
 *
 * The flowchart writes a rank as one line — "United Quest, Explorer and/or Club" — and means pick one.
 * Three numbered rows saying the same sentence is both a misreading of the advice and, on screen, the
 * thing that makes a generated list look generated.
 *
 * Ungrouped entries pass through untouched, and order is preserved: the list is already sorted, so the
 * first member of a group met is the best-scoring one and becomes the lead.
 */
function collapseGroups(entries: Scored[]): Recommendation[] {
  const leads = new Map<string, Recommendation>();
  const out: Recommendation[] = [];

  for (const entry of entries) {
    if (entry.group === null) {
      out.push(strip(entry));
      continue;
    }
    const lead = leads.get(entry.group);
    if (lead === undefined) {
      const fresh = strip(entry);
      leads.set(entry.group, fresh);
      out.push(fresh);
      continue;
    }
    lead.alternatives.push({ card: entry.card, offer: entry.offer });
  }

  return out;
}

/** The worst severity across a set of verdicts, for a single card's summary chip. */
export function worstSeverity(assessment: Assessment): Severity | null {
  return assessment.worst;
}
