/**
 * Issuer application rules, as checkable predicates.
 *
 * The flowchart names these rules in passing and assumes you know them — "respect banks'
 * application rules (Amex's 2/90 and 5-credit-card-limit, and 1/90 same-card rule; Barclay's
 * 6/24; Citi's 8/65 and 6/6; BoA's 2/3/4 and 3/12-or-7/12)". This file is that parenthesis,
 * written out and testable. The prose panels stay prose, in `data/flowchart.json`, and feed the
 * recommender as strategy; what is here is arithmetic that either passes or fails.
 *
 * Rules are objects rather than a switch because the interesting output is not a boolean — it is
 * *when the answer changes*. "Denied" is not useful; "denied until 2026-04-03" is the entire
 * product. So every rule that clears on its own returns the date it does, and the reminder engine
 * reads those dates straight out of the verdicts rather than recomputing them.
 *
 * On severity, and why there are four levels rather than two: these rules are not all the same
 * kind of thing. Chase's 5/24 is enforced by software and is simply a wall. Amex's lifetime
 * language costs you the bonus but still opens the account. Chase's three-month velocity
 * guideline is not a rule at all — it is a community-observed shutdown risk, and a churner
 * occasionally and knowingly breaks it. Collapsing those into "blocked" would make the app
 * either uselessly timid or dangerously quiet.
 *
 * **This encodes community-observed behaviour, not issuer policy.** Most of it is undocumented,
 * all of it changes without notice, and the flowchart's own "Limitations" panel says so first.
 * The app surfaces these as reasons, always with the rule named, so the user can overrule any of
 * them — which is the correct division of labour, because they are the one who gets denied.
 */

import type { Card, IssuerId, IsoDate, PlayerState } from '../model.ts';
import { addDays, addMonths, latest, monthsBetween, pretty, toEpoch } from '../dates.ts';
import { familyName } from '../data/cards.ts';
import {
  count524,
  everHeld,
  inquiriesInMonths,
  issuerAccountsInMonths,
  issuerApprovalsInDays,
  lastAppliedTo,
  newAccountsInMonths,
  openWithIssuer,
  openedAccounts,
} from './counts.ts';

/**
 * How much a rule matters.
 *
 * - `blocker`      — the issuer's system will decline. Waiting is the only move.
 * - `likely-denial` — approval or the bonus is unlikely. Applying is a real gamble, not a formality.
 * - `caution`      — community guidance, breakable on purpose. Velocity and shutdown risk live here.
 * - `note`         — something to know that does not bear on this application's odds.
 */
export type Severity = 'blocker' | 'likely-denial' | 'caution' | 'note';

const SEVERITY_ORDER: Record<Severity, number> = {
  blocker: 0,
  'likely-denial': 1,
  caution: 2,
  note: 3,
};

export interface Verdict {
  ruleId: string;
  issuer: IssuerId | 'any';
  title: string;
  severity: Severity;
  /** One sentence, with the actual numbers in it. Shown verbatim in the UI. */
  message: string;
  /** When this stops applying without the user doing anything. Null when it never will. */
  clearsAt: IsoDate | null;
}

export interface RuleContext {
  state: PlayerState;
  /** The card being considered. */
  target: Card;
  asOf: IsoDate;
  /** The catalog, for following `cardId` on the user's history to find family members. */
  catalog: Record<string, Card>;
}

interface Rule {
  id: string;
  issuer: IssuerId | 'any';
  title: string;
  /** Cheap filter, so 30-odd rules do not all run against every card in the catalog. */
  applies(context: RuleContext): boolean;
  check(context: RuleContext): Omit<Verdict, 'ruleId' | 'issuer' | 'title'> | null;
}

/**
 * When a "no more than `max` in `windowDays`" count next falls below `max`.
 *
 * The subtlety is which account's expiry to return. Sorted newest first, the count drops below
 * `max` the moment `accounts[max - 1]` ages out — not the oldest one. With three Amex approvals
 * inside 90 days, the oldest ageing out still leaves two, and two is still blocked.
 */
function windowClears(
  openDatesNewestFirst: IsoDate[],
  max: number,
  windowDays: number,
): IsoDate | null {
  const pivot = openDatesNewestFirst[max - 1];
  return pivot === undefined ? null : addDays(pivot, windowDays);
}

function newestFirst(dates: Array<IsoDate | null>): IsoDate[] {
  return dates
    .filter((date): date is IsoDate => date !== null)
    .sort((a, b) => toEpoch(b) - toEpoch(a));
}

/** Accounts in the same entangled family as the target. Follows `cardId` through the catalog. */
function familyAccounts(context: RuleContext) {
  const family = context.target.family;
  if (family === null) return [];
  return context.state.cards.filter((account) => {
    if (account.authorizedUser || account.cardId === null) return false;
    return context.catalog[account.cardId]?.family === family;
  });
}

function isCustomerOf(state: PlayerState, bankNamePattern: RegExp): boolean {
  return state.banks.some(
    (account) => account.status === 'open' && bankNamePattern.test(account.bankName),
  );
}

// ---- cross-issuer -----------------------------------------------------------

const ONCE_PER_LIFETIME: Rule = {
  id: 'once-per-lifetime',
  issuer: 'any',
  title: 'Welcome offer is once per lifetime',
  applies: ({ target }) => target.bonusOncePerLifetime,
  check({ state, target }) {
    const held = everHeld(state, target.id);
    if (!held) return null;
    return {
      // The application will very likely be approved; it is the bonus that will not appear. That
      // is a different failure from a decline, and worth distinguishing — the card may still be
      // worth opening for a targeted or upgrade offer, which the flowchart explicitly suggests.
      severity: 'likely-denial',
      message: `You have held ${target.name} before (opened ${pretty(held.openedAt as IsoDate)}). ${target.issuer === 'amex' ? 'Amex' : 'This issuer'} grants the welcome offer once per lifetime, so expect the application to be approved without a bonus. A targeted NLL or upgrade offer is the way in.`,
      clearsAt: null,
    };
  },
};

const CARD_BONUS_COOLDOWN: Rule = {
  id: 'card-bonus-cooldown',
  issuer: 'any',
  title: 'Same-card bonus cooldown',
  applies: ({ target }) => target.bonusCooldownMonths !== null,
  check({ state, target, asOf }) {
    const months = target.bonusCooldownMonths as number;
    const earned = latest(
      state.cards
        .filter((account) => account.cardId === target.id && account.bonus?.earnedAt)
        .map((account) => account.bonus?.earnedAt ?? null),
    );
    if (earned === null) return null;
    const elapsed = monthsBetween(earned, asOf);
    if (elapsed >= months) return null;
    return {
      severity: 'blocker',
      message: `You received the ${target.name} bonus ${elapsed} month${elapsed === 1 ? '' : 's'} ago (${pretty(earned)}). It is available again ${months} months after that.`,
      clearsAt: addMonths(earned, months),
    };
  },
};

const FAMILY_BONUS_COOLDOWN: Rule = {
  id: 'family-bonus-cooldown',
  issuer: 'any',
  title: 'Shared family bonus clock',
  applies: ({ target }) => target.familyBonusCooldownMonths !== null,
  check(context) {
    const { target, asOf } = context;
    const months = target.familyBonusCooldownMonths as number;
    const relatives = familyAccounts(context).filter(
      (account) => account.bonus?.earnedAt && account.cardId !== target.id,
    );
    const earned = latest(relatives.map((account) => account.bonus?.earnedAt ?? null));
    if (earned === null) return null;
    const elapsed = monthsBetween(earned, asOf);
    if (elapsed >= months) return null;
    const which = relatives.find((account) => account.bonus?.earnedAt === earned);
    return {
      severity: 'blocker',
      message: `${which?.cardName ?? 'A card in the same family'} paid its bonus ${elapsed} month${elapsed === 1 ? '' : 's'} ago (${pretty(earned)}). The ${familyName(target.family)} cards share one ${months}-month bonus clock, so ${target.name} is not bonus-eligible yet.`,
      clearsAt: addMonths(earned, months),
    };
  },
};

const FAMILY_ONE_OPEN: Rule = {
  id: 'family-one-open',
  issuer: 'any',
  title: 'Only one card in this family at a time',
  applies: ({ target }) => target.familyOnlyOneOpen,
  check(context) {
    const open = familyAccounts(context).filter(
      (account) =>
        (account.status === 'open' || account.status === 'approved') && account.cardId !== context.target.id,
    );
    if (open.length === 0) return null;
    return {
      severity: 'blocker',
      // No `clearsAt`: this one is not waited out, it is acted on. The user closes or product-changes
      // the card they hold, and a date would imply otherwise.
      message: `You hold ${open.map((account) => account.cardName).join(' and ')}. Only one ${familyName(context.target.family)} card can be open at a time — close or product-change it first, and not before it is a year old.`,
      clearsAt: null,
    };
  },
};

// ---- Chase ------------------------------------------------------------------

const CHASE_524: Rule = {
  id: 'chase-5-24',
  issuer: 'chase',
  title: '5/24',
  applies: ({ target }) => target.issuer === 'chase',
  check({ state, asOf }) {
    const count = count524(state, asOf);
    if (count.count < 5) return null;
    return {
      severity: 'blocker',
      message: `You are ${count.count}/24. Chase declines every application at 5 or more, personal and business alike${count.under5At ? `; you drop under 5 on ${pretty(count.under5At)}` : ''}.`,
      clearsAt: count.under5At,
    };
  },
};

const CHASE_VELOCITY: Rule = {
  id: 'chase-velocity-3-months',
  issuer: 'chase',
  title: 'Three months between Chase applications',
  applies: ({ target }) => target.issuer === 'chase',
  check({ state, asOf }) {
    const last = lastAppliedTo(state, 'chase');
    if (last === null) return null;
    const elapsed = monthsBetween(last, asOf);
    if (elapsed >= 3) return null;
    return {
      // The flowchart is explicit that this is breakable and about shutdown risk rather than
      // approval: "Occasionally breaking that rule is okay, but doing so repeatedly will greatly
      // heighten Chase Shutdown risk."
      severity: 'caution',
      message: `Your last Chase application was ${pretty(last)}. The community guideline is a 3-month gap; breaking it once is usually fine, repeatedly raises Chase shutdown risk.`,
      clearsAt: addMonths(last, 3),
    };
  },
};

const CHASE_BUSINESS_VELOCITY: Rule = {
  id: 'chase-business-6-months',
  issuer: 'chase',
  title: 'Six months between Chase business cards',
  applies: ({ target }) => target.issuer === 'chase' && target.productType === 'business',
  check({ state, asOf }) {
    const last = lastAppliedTo(state, 'chase', 'business');
    if (last === null) return null;
    const elapsed = monthsBetween(last, asOf);
    if (elapsed >= 6) return null;
    return {
      severity: 'caution',
      message: `Your last Chase business application was ${pretty(last)}. Wait 6 months between Chase business cards — Chase personal cards in between do not count against this.`,
      clearsAt: addMonths(last, 6),
    };
  },
};

const CHASE_THIN_FILE: Rule = {
  id: 'chase-thin-file',
  issuer: 'chase',
  title: 'Chase wants a year of credit history',
  applies: ({ target }) => target.issuer === 'chase',
  check({ state, asOf }) {
    const oldest = openedAccounts(state)[0];
    // No history recorded at all is not evidence of a thin file — it is a new user who has not
    // finished typing. Staying quiet is the right call; the newbie strategy panel covers it.
    if (oldest === undefined) return null;

    const months = monthsBetween(oldest.openedAt as IsoDate, asOf);
    if (months >= 12) return null;

    // A Chase deposit account or loan history is the documented way round this, so the message
    // names it rather than just saying no.
    const chaseCustomer = isCustomerOf(state, /chase/i);
    return {
      severity: chaseCustomer ? 'caution' : 'likely-denial',
      message: `Your oldest card account opened ${pretty(oldest.openedAt as IsoDate)}, ${months} month${months === 1 ? '' : 's'} ago. Chase usually declines under a year of credit history${chaseCustomer ? ', though your Chase deposit account helps' : ' unless you have loan history or a Chase bank account'}.`,
      clearsAt: addMonths(oldest.openedAt as IsoDate, 12),
    };
  },
};

const CHASE_TWO_BUSINESS_OPEN: Rule = {
  id: 'chase-two-business-open',
  issuer: 'chase',
  title: 'At most two Chase business cards open',
  applies: ({ target }) => target.issuer === 'chase' && target.productType === 'business',
  check({ state }) {
    const open = openWithIssuer(state, 'chase', 'business');
    if (open.length < 3) return null;
    return {
      severity: 'likely-denial',
      message: `You have ${open.length} Chase business cards open. Approvals generally need at most 2 open — but do not close one before it is a year old.`,
      clearsAt: null,
    };
  },
};

// ---- Amex -------------------------------------------------------------------

const AMEX_1_IN_5: Rule = {
  id: 'amex-1-in-5-days',
  issuer: 'amex',
  title: '1 in 5 days',
  // Unlike 2/90 and the five-card limit, this one is not documented as sparing charge cards, so
  // it applies to every Amex product.
  applies: ({ target }) => target.issuer === 'amex',
  check({ state, asOf }) {
    const recent = issuerApprovalsInDays(state, 'amex', 5, asOf).filter(
      (account) => account.openedAt !== null,
    );
    if (recent.length === 0) return null;
    const dates = newestFirst(recent.map((account) => account.openedAt));
    return {
      severity: 'blocker',
      message: `An Amex card was approved on ${pretty(dates[0])}. Amex allows one credit card approval every 5 days.`,
      clearsAt: windowClears(dates, 1, 5),
    };
  },
};

const AMEX_2_IN_90: Rule = {
  id: 'amex-2-in-90-days',
  issuer: 'amex',
  title: '2 in 90 days',
  applies: ({ target }) => target.issuer === 'amex' && !target.chargeCard,
  check({ state, asOf }) {
    const recent = issuerApprovalsInDays(state, 'amex', 90, asOf).filter(
      (account) => account.openedAt !== null && !isChargeCard(account.cardId),
    );
    if (recent.length < 2) return null;
    const dates = newestFirst(recent.map((account) => account.openedAt));
    return {
      severity: 'blocker',
      message: `You have had ${recent.length} Amex credit cards approved in the last 90 days (${dates.slice(0, 2).map(pretty).join(' and ')}). Amex allows two.`,
      clearsAt: windowClears(dates, 2, 90),
    };
  },
};

/**
 * Whether a held account was a charge card.
 *
 * Reads the id list below rather than the catalog, because these two rules count the user's
 * *history*, where a card may have been dropped from the catalog since it was opened. An unknown
 * card counts as a credit card, which is the conservative direction: it can warn when it need not,
 * and it will never quietly permit a sixth credit card.
 */
function isChargeCard(cardId: string | null): boolean {
  return cardId !== null && CHARGE_CARD_IDS.has(cardId);
}

/**
 * Amex's charge cards, by catalog id.
 *
 * Hardcoded rather than read from the catalog because the two rules that need it are counting the
 * user's *history*, where a card may have been dropped from the catalog since. The list is short
 * and changes about once a decade.
 */
export const CHARGE_CARD_IDS = new Set([
  'amex-platinum',
  'amex-gold',
  'amex-green',
  'amex-business-platinum',
  'amex-business-gold',
  'amex-business-green',
]);

const AMEX_FIVE_CARD_LIMIT: Rule = {
  id: 'amex-five-credit-card-limit',
  issuer: 'amex',
  title: 'Five credit cards at a time',
  applies: ({ target }) => target.issuer === 'amex' && !target.chargeCard,
  check({ state }) {
    const open = openWithIssuer(state, 'amex').filter((account) => !isChargeCard(account.cardId));
    if (open.length < 5) return null;
    return {
      severity: 'blocker',
      message: `You have ${open.length} Amex credit cards open, which is Amex's limit. Charge cards (Platinum, Gold, Green) are exempt and do not count — close a credit card or go for a charge card instead.`,
      clearsAt: null,
    };
  },
};

const AMEX_FAMILY_RANK: Rule = {
  id: 'amex-family-rank',
  issuer: 'amex',
  title: 'Card-family rules',
  applies: ({ target }) => target.issuer === 'amex' && target.family !== null && target.familyRank > 0,
  check(context) {
    const { target } = context;
    const higher = familyAccounts(context)
      .filter((account) => account.cardId !== null && account.cardId !== target.id)
      .filter((account) => (context.catalog[account.cardId as string]?.familyRank ?? 0) > target.familyRank);
    if (higher.length === 0) return null;
    return {
      severity: 'likely-denial',
      message: `You have held ${higher.map((account) => account.cardName).join(', ')}, which outranks ${target.name} in the same family. Since Fall 2023 holding a higher card permanently forecloses the lower card's welcome offer.`,
      clearsAt: null,
    };
  },
};

// ---- Citi -------------------------------------------------------------------

const CITI_1_IN_8: Rule = {
  id: 'citi-1-in-8-days',
  issuer: 'citi',
  title: '1 in 8 days',
  applies: ({ target }) => target.issuer === 'citi',
  check({ state, asOf }) {
    const blocking = newestFirst(
      state.cards
        .filter((account) => account.issuer === 'citi' && !account.authorizedUser)
        .map((account) => account.appliedAt ?? account.openedAt),
    ).filter((date) => toEpoch(addDays(date, 8)) > toEpoch(asOf));
    if (blocking.length === 0) return null;
    return {
      severity: 'blocker',
      message: `You applied to Citi on ${pretty(blocking[0])}. Citi accepts one application every 8 days.`,
      clearsAt: addDays(blocking[0], 8),
    };
  },
};

const CITI_2_IN_65: Rule = {
  id: 'citi-2-in-65-days',
  issuer: 'citi',
  title: '2 in 65 days',
  applies: ({ target }) => target.issuer === 'citi',
  check({ state, asOf }) {
    const dates = newestFirst(
      state.cards
        .filter((account) => account.issuer === 'citi' && !account.authorizedUser)
        .map((account) => account.appliedAt ?? account.openedAt),
    ).filter((date) => toEpoch(addDays(date, 65)) > toEpoch(asOf));
    if (dates.length < 2) return null;
    return {
      severity: 'blocker',
      message: `You have applied to Citi ${dates.length} times in the last 65 days (${dates.slice(0, 2).map(pretty).join(' and ')}). Citi accepts two.`,
      clearsAt: windowClears(dates, 2, 65),
    };
  },
};

const CITI_INQUIRY_SENSITIVITY: Rule = {
  id: 'citi-6-inquiries-6-months',
  issuer: 'citi',
  title: 'Inquiry sensitivity',
  applies: ({ target }) => target.issuer === 'citi',
  check({ state, asOf }) {
    const inquiries = inquiriesInMonths(state, 6, asOf);
    if (inquiries.total < 2) return null;
    // The flowchart puts this more strictly than the folk "6/6": for the Strata Premier it says
    // "may need to be 0-1/6". So this warns from 2 and hardens at 6 rather than only at 6.
    return {
      severity: inquiries.total >= 6 ? 'likely-denial' : 'caution',
      message: `You have ${inquiries.total} hard inquiries in the last 6 months. Citi is the most inquiry-sensitive major issuer — its better cards often want 0–1/6, and 6/6 is usually an automatic decline.`,
      clearsAt: null,
    };
  },
};

// ---- Barclays ---------------------------------------------------------------

const BARCLAYS_6_24: Rule = {
  id: 'barclays-6-24',
  issuer: 'barclays',
  title: '6/24',
  applies: ({ target }) => target.issuer === 'barclays',
  check({ state, asOf }) {
    const count = count524(state, asOf);
    // Nothing at all below 6, deliberately. Being at exactly 5/24 is not a reason for caution about
    // Barclays — it is the flowchart's cue to go and get the Barclays cards you want, because they
    // stop approving right after. Emitting a "caution" there demoted Barclays out of the
    // recommendations at precisely the moment the chart puts it first. That encouragement belongs
    // in `recommend.ts`, where the travel column already carries it; a rule states obstacles.
    if (count.count < 6) return null;
    return {
      severity: 'likely-denial',
      message: `You are ${count.count}/24. Barclays has a soft 6/24 rule — expect a denial, though it is sometimes worth trying at exactly 6.`,
      clearsAt: count.nextDropAt,
    };
  },
};

// ---- Bank of America --------------------------------------------------------

const BOA_2_3_4: Rule = {
  id: 'boa-2-3-4',
  issuer: 'boa',
  title: '2/3/4',
  applies: ({ target }) => target.issuer === 'boa',
  check({ state, asOf }) {
    // Three windows, one rule: 2 BoA cards per 2 months, 3 per 12 months, 4 per 24 months.
    const windows: Array<{ months: number; max: number }> = [
      { months: 2, max: 2 },
      { months: 12, max: 3 },
      { months: 24, max: 4 },
    ];
    for (const window of windows) {
      const accounts = issuerAccountsInMonths(state, 'boa', window.months, asOf);
      if (accounts.length < window.max) continue;
      const dates = newestFirst(accounts.map((account) => account.openedAt));
      return {
        severity: 'blocker',
        message: `You have opened ${accounts.length} Bank of America cards in the last ${window.months} months. BoA's 2/3/4 rule allows ${window.max} per ${window.months} months.`,
        clearsAt: addMonths(dates[window.max - 1], window.months),
      };
    }
    return null;
  },
};

const BOA_3_12_OR_7_12: Rule = {
  id: 'boa-3-12-or-7-12',
  issuer: 'boa',
  title: '3/12 or 7/12',
  applies: ({ target }) => target.issuer === 'boa',
  check({ state, asOf }) {
    // Being a BoA deposit customer raises the ceiling, which is why the flowchart says "Having a
    // BoA bank account helps greatly with approvals" — this is the mechanism behind that advice.
    const customer = isCustomerOf(state, /bank of america|BoA/i);
    const max = customer ? 7 : 3;
    const accounts = newAccountsInMonths(state, 12, asOf).filter((account) => !account.authorizedUser);
    if (accounts.length < max) return null;
    const dates = newestFirst(accounts.map((account) => account.openedAt));
    return {
      severity: 'likely-denial',
      message: `You have opened ${accounts.length} new card accounts anywhere in the last 12 months. BoA allows ${max} for ${customer ? 'existing deposit customers' : 'non-customers'}${customer ? '' : ' — opening a BoA checking account raises this to 7 and helps approvals generally'}.`,
      clearsAt: addMonths(dates[max - 1], 12),
    };
  },
};

// ---- Capital One ------------------------------------------------------------

const CAPITALONE_524_SENSITIVITY: Rule = {
  id: 'capitalone-524-sensitivity',
  issuer: 'capitalone',
  title: 'Capital One and new accounts',
  applies: ({ target }) => target.issuer === 'capitalone',
  check({ state, asOf }) {
    const count = count524(state, asOf);
    if (count.count < 5) return null;
    return {
      severity: count.count >= 7 ? 'likely-denial' : 'caution',
      message: `You are ${count.count}/24. Capital One almost never approves above 5–6/24, its underwriting is opaque, and it has no reconsideration line — so a denial is final. The flowchart lists Venture and Venture X as cards worth burning a 5/24 slot on for this reason.`,
      clearsAt: count.nextDropAt,
    };
  },
};

const CAPITALONE_6_MONTH_GAP: Rule = {
  id: 'capitalone-6-month-gap',
  issuer: 'capitalone',
  title: 'Six months between Capital One cards',
  applies: ({ target }) => target.issuer === 'capitalone',
  check({ state, asOf }) {
    const last = lastAppliedTo(state, 'capitalone');
    if (last === null) return null;
    const elapsed = monthsBetween(last, asOf);
    if (elapsed >= 6) return null;
    return {
      severity: 'caution',
      message: `Your last Capital One application was ${pretty(last)}. Cap1 approvals generally want about 6 months between cards — the flowchart sequences Venture, then Spark Cash 6 months later, then Spark Miles 6 months after that.`,
      clearsAt: addMonths(last, 6),
    };
  },
};

const CAPITALONE_BUSINESS_REPORTS: Rule = {
  id: 'capitalone-business-reports',
  issuer: 'capitalone',
  title: 'This business card reports to your personal bureau',
  applies: ({ target }) =>
    target.issuer === 'capitalone' &&
    target.productType === 'business' &&
    target.showsOnPersonalReport,
  check({ state, asOf }) {
    const count = count524(state, asOf);
    return {
      severity: count.count < 5 ? 'caution' : 'note',
      message: `Unlike most business cards, this one appears on your personal credit report and will burn a 5/24 slot (you are ${count.count}/24). Only Spark Cash Plus and Venture X Business stay off it.`,
      clearsAt: null,
    };
  },
};

// ---- US Bank ----------------------------------------------------------------

const USBANK_INQUIRY_SENSITIVITY: Rule = {
  id: 'usbank-inquiry-sensitivity',
  issuer: 'usbank',
  title: 'Inquiry sensitivity',
  applies: ({ target }) => target.issuer === 'usbank',
  check({ state, asOf }) {
    const inquiries = inquiriesInMonths(state, 6, asOf);
    if (inquiries.total < 2) return null;
    return {
      severity: 'caution',
      message: `You have ${inquiries.total} hard inquiries in the last 6 months. US Bank is inquiry-sensitive — the Altitude Reserve in particular is usually described as wanting 0/6.`,
      clearsAt: null,
    };
  },
};

// ---- Wells Fargo ------------------------------------------------------------

const WELLSFARGO_6_MONTH_GAP: Rule = {
  id: 'wellsfargo-6-month-gap',
  issuer: 'wellsfargo',
  title: 'Six months between Wells Fargo cards',
  applies: ({ target }) => target.issuer === 'wellsfargo',
  check({ state, asOf }) {
    const last = lastAppliedTo(state, 'wellsfargo');
    if (last === null) return null;
    const elapsed = monthsBetween(last, asOf);
    if (elapsed >= 6) return null;
    return {
      severity: 'caution',
      message: `Your last Wells Fargo application was ${pretty(last)}. Wells Fargo generally wants about 6 months between cards.`,
      clearsAt: addMonths(last, 6),
    };
  },
};

const WELLSFARGO_DEPOSIT_ACCOUNT: Rule = {
  id: 'wellsfargo-deposit-account-age',
  issuer: 'wellsfargo',
  title: 'Signify Business needs an existing Wells Fargo account',
  applies: ({ target }) => target.id === 'wellsfargo-signify-business',
  check({ state, asOf }) {
    const account = state.banks
      .filter((bank) => /wells fargo/i.test(bank.bankName) && bank.status === 'open' && bank.openedAt)
      .sort((a, b) => toEpoch(a.openedAt as IsoDate) - toEpoch(b.openedAt as IsoDate))[0];
    if (account === undefined) {
      return {
        severity: 'blocker',
        message:
          'Signify Business requires an existing Wells Fargo bank account. You have none tracked — open one first; it needs to age before it counts.',
        clearsAt: null,
      };
    }
    const age = monthsBetween(account.openedAt as IsoDate, asOf);
    // Reported as 2 months by DoC and as a year by the flowchart's cashback column. Treated as 2
    // to unblock, and said out loud, because the honest answer is that reports disagree.
    if (age >= 2) return null;
    return {
      severity: 'caution',
      message: `Your Wells Fargo account opened ${pretty(account.openedAt as IsoDate)} (${age} month${age === 1 ? '' : 's'} ago). Signify needs one at least 2 months old; some data points say a full year.`,
      clearsAt: addMonths(account.openedAt as IsoDate, 2),
    };
  },
};

// ---- registry ---------------------------------------------------------------

/**
 * Every rule, in no significant order — `assess` sorts the output by severity instead.
 *
 * Exported so the app can show "which rules exist and what do they say", which matters for a tool
 * whose entire content is undocumented issuer behaviour: a user who can read the rule list can
 * tell when the app is out of date.
 */
export const RULES: Rule[] = [
  ONCE_PER_LIFETIME,
  CARD_BONUS_COOLDOWN,
  FAMILY_BONUS_COOLDOWN,
  FAMILY_ONE_OPEN,
  CHASE_524,
  CHASE_VELOCITY,
  CHASE_BUSINESS_VELOCITY,
  CHASE_THIN_FILE,
  CHASE_TWO_BUSINESS_OPEN,
  AMEX_1_IN_5,
  AMEX_2_IN_90,
  AMEX_FIVE_CARD_LIMIT,
  AMEX_FAMILY_RANK,
  CITI_1_IN_8,
  CITI_2_IN_65,
  CITI_INQUIRY_SENSITIVITY,
  BARCLAYS_6_24,
  BOA_2_3_4,
  BOA_3_12_OR_7_12,
  CAPITALONE_524_SENSITIVITY,
  CAPITALONE_6_MONTH_GAP,
  CAPITALONE_BUSINESS_REPORTS,
  USBANK_INQUIRY_SENSITIVITY,
  WELLSFARGO_6_MONTH_GAP,
  WELLSFARGO_DEPOSIT_ACCOUNT,
];

export interface Assessment {
  cardId: string;
  /** Worst severity found, or null when nothing fired at all. */
  worst: Severity | null;
  /** True when something will actually decline the application. */
  blocked: boolean;
  /**
   * The earliest date at which every `blocker` has cleared, or null if one never will.
   *
   * Only blockers, on purpose: a `caution` clearing is advice about timing, not a gate, and
   * folding it in here would make a card look unavailable when it is merely inadvisable.
   */
  availableAt: IsoDate | null;
  verdicts: Verdict[];
}

/** Runs every applicable rule against one card. */
export function assess(context: RuleContext): Assessment {
  const verdicts: Verdict[] = [];

  for (const rule of RULES) {
    if (!rule.applies(context)) continue;
    const result = rule.check(context);
    if (result === null) continue;
    verdicts.push({ ruleId: rule.id, issuer: rule.issuer, title: rule.title, ...result });
  }

  verdicts.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  const blockers = verdicts.filter((verdict) => verdict.severity === 'blocker');
  const unclearable = blockers.some((verdict) => verdict.clearsAt === null);

  return {
    cardId: context.target.id,
    worst: verdicts[0]?.severity ?? null,
    blocked: blockers.length > 0,
    availableAt: unclearable
      ? null
      : (latest(blockers.map((verdict) => verdict.clearsAt)) ?? context.asOf),
    verdicts,
  };
}

/**
 * The player's standing, independent of any particular card.
 *
 * What the home screen shows, and what the user actually asks the app for: the numbers, and when
 * each of them next moves.
 */
export interface Standing {
  asOf: IsoDate;
  count524: ReturnType<typeof count524>;
  inquiries6Months: ReturnType<typeof inquiriesInMonths>;
  inquiries12Months: ReturnType<typeof inquiriesInMonths>;
  newAccounts12Months: number;
  openCards: number;
  /** Total annual fees on open cards, in cents. The number that makes people close things. */
  annualFeesCents: number;
  /** Last application per issuer, so the velocity gates are visible before a card is picked. */
  lastAppliedByIssuer: Partial<Record<IssuerId, IsoDate>>;
}

export function standing(state: PlayerState, asOf: IsoDate): Standing {
  const open = state.cards.filter(
    (account) => account.status === 'open' || account.status === 'approved' || account.status === 'product-changed',
  );

  const lastAppliedByIssuer: Partial<Record<IssuerId, IsoDate>> = {};
  for (const account of state.cards) {
    if (account.authorizedUser || account.status === 'planned') continue;
    const date = account.appliedAt ?? account.openedAt;
    if (date === null) continue;
    const current = lastAppliedByIssuer[account.issuer];
    if (current === undefined || toEpoch(date) > toEpoch(current)) {
      lastAppliedByIssuer[account.issuer] = date;
    }
  }

  return {
    asOf,
    count524: count524(state, asOf),
    inquiries6Months: inquiriesInMonths(state, 6, asOf),
    inquiries12Months: inquiriesInMonths(state, 12, asOf),
    newAccounts12Months: newAccountsInMonths(state, 12, asOf).length,
    openCards: open.length,
    annualFeesCents: open.reduce((total, account) => total + account.annualFeeCents, 0),
    lastAppliedByIssuer,
  };
}

export { openedAccounts };
