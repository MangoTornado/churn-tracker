/**
 * The domain: what a churner's history actually is, and what the app is allowed to know.
 *
 * Two decisions here shape everything downstream.
 *
 * **Nothing that could log in to a bank is modelled.** No account numbers, no credentials, no
 * balances, no transaction feed, no aggregator token. The whole product is dates and dollar
 * amounts the user typed in — which is all the churning rules need, because every rule in this
 * space is a function of *when* an account opened. That is not an accident of scope, it is the
 * feature: a tracker that cannot be used to move money is a tracker whose breach is a nuisance
 * rather than a catastrophe.
 *
 * **History is denormalised on write.** A `CardAccount` stores `cardName`, `issuer`, `annualFee`
 * and `counts524` on the row rather than reading them through `cardId` at display time. The
 * catalog is a snapshot of an ever-changing internet; the user's own history is a fact. If Chase
 * renames Sapphire Preferred, or a refresh drops a card that no longer has a public offer, the
 * account opened in 2023 must still say what it said. `cardId` is a link for the recommender to
 * follow, and it is allowed to dangle.
 *
 * Dates are ISO `YYYY-MM-DD` strings, not timestamps. Every rule in churning is denominated in
 * whole days or whole months against a date a statement printed, so an instant is false
 * precision — and a `Date` would drag the user's timezone into "am I under 5/24", which is
 * exactly the kind of off-by-one that costs a real application.
 */

/** `YYYY-MM-DD`. See the header for why this is not a timestamp. */
export type IsoDate = string;

export const ISSUERS = [
  'chase',
  'amex',
  'citi',
  'capitalone',
  'boa',
  'barclays',
  'usbank',
  'wellsfargo',
  'discover',
  'synchrony',
  'penfed',
  'navyfed',
  'bilt',
  'firstnational',
  'truist',
  'other',
] as const;

export type IssuerId = (typeof ISSUERS)[number];

export const ISSUER_NAMES: Record<IssuerId, string> = {
  chase: 'Chase',
  amex: 'American Express',
  citi: 'Citi',
  capitalone: 'Capital One',
  boa: 'Bank of America',
  barclays: 'Barclays',
  usbank: 'U.S. Bank',
  wellsfargo: 'Wells Fargo',
  discover: 'Discover',
  synchrony: 'Synchrony',
  penfed: 'PenFed',
  navyfed: 'Navy Federal',
  bilt: 'Bilt',
  firstnational: 'First National Bank',
  truist: 'Truist',
  other: 'Other',
};

/** What the points are worth to you is subjective; what they *are* is not. */
export const CURRENCIES = [
  'ur', // Chase Ultimate Rewards
  'mr', // Amex Membership Rewards
  'typ', // Citi ThankYou Points
  'venture', // Capital One miles
  'bilt', // Bilt Rewards
  'wf', // Wells Fargo Rewards
  'cash',
  'airline',
  'hotel',
] as const;

export type Currency = (typeof CURRENCIES)[number];

export type ProductType = 'personal' | 'business';

/**
 * A card as the catalog knows it. Refreshed from Doctor of Credit; never user-owned.
 *
 * `showsOnPersonalReport` is the single most consequential field in this file, and it is the one
 * a catalog is most likely to get wrong. Almost every business card is invisible to 5/24 — but
 * Capital One's business cards report to your personal bureau except for Spark Cash Plus and
 * Venture X Business, and so do Discover's. A business card wrongly marked invisible silently
 * under-counts 5/24, and the user finds out by being denied.
 */
export interface Card {
  id: string;
  issuer: IssuerId;
  name: string;
  productType: ProductType;
  /** Cents, matching `CardAccount.annualFeeCents`, so money never crosses a unit boundary. */
  annualFeeCents: number;
  /** Whether the first year's fee is waived. Changes when the close-before-fee reminder fires. */
  annualFeeWaivedFirstYear: boolean;
  currency: Currency;
  /** See the note above. Business cards default to false; Cap1 and Discover business are true. */
  showsOnPersonalReport: boolean;
  /**
   * A charge card rather than a revolving one. Amex's Platinum, Gold and Green.
   *
   * Only Amex distinguishes, and only for one rule: the five-credit-card limit does not count
   * charge cards. Getting this wrong on Platinum means telling someone with five Amex cards that
   * they cannot apply, when they can.
   */
  chargeCard: boolean;
  /**
   * A family of cards whose bonus eligibility is entangled.
   *
   * Three different issuer behaviours ride on this field, and which one applies is decided by the
   * three that follow rather than by the family name: Amex's "a higher card forecloses a lower
   * one" (`familyRank`), Chase Sapphire's and Citi ThankYou's shared bonus clock
   * (`familyBonusCooldownMonths`), and Sapphire's and Southwest's "only one at a time"
   * (`familyOnlyOneOpen`). Null for the majority of cards, which are entangled with nothing.
   */
  family: string | null;
  /** Within an Amex family, higher outranks lower. Platinum 3 > Gold 2 > Green 1. */
  familyRank: number;
  /**
   * Months between bonuses anywhere in the family — 48 for Sapphire, 48 for Citi ThankYou.
   *
   * Distinct from `bonusCooldownMonths`, which is per card. Sapphire Preferred and Reserve have a
   * 48-month *shared* clock, so earning one blocks the other; a co-brand's 24-month cooldown
   * blocks only itself.
   */
  familyBonusCooldownMonths: number | null;
  /** Whether two cards in this family can be held at once. False for Sapphire and Southwest personal. */
  familyOnlyOneOpen: boolean;
  /**
   * Whether the issuer's offer terms say the welcome bonus is once per lifetime.
   *
   * True for Amex, whose language is the reason its cards are ordered the way they are. Issuers
   * with a *cooldown* rather than a ban express it as `bonusCooldownMonths` instead.
   */
  bonusOncePerLifetime: boolean;
  /** Months after receiving this card's bonus before it can be earned again. 24 for most Chase. */
  bonusCooldownMonths: number | null;
  /** Free-text, from the catalog: "NLL", "in-branch only", "requires an authorized user". */
  notes: string;
}

/** A live public offer on a card. Separate from `Card` because it changes weekly and the card does not. */
export interface CardOffer {
  /**
   * The catalog card this offer is for, or null when the scraper could not match it.
   *
   * Null is a normal outcome and not an error. Doctor of Credit's list runs well past the ~90
   * cards the flowchart discusses — regional credit unions, one-off promotions, cards nobody has
   * curated — and an unmatched offer is still worth showing on a "best bonuses" screen. What it
   * cannot get is rule checking, because there is no `Card` to check against. So it is kept,
   * labelled, and excluded from recommendations rather than dropped.
   */
  cardId: string | null;
  /** Doctor of Credit's own heading, verbatim. What to show when `cardId` is null. */
  title: string;
  issuer: IssuerId | null;
  /** As advertised: 175000 points, or 75000 miles, or 200 dollars. */
  amount: number;
  unit: 'points' | 'miles' | 'dollars';
  /** Cents, to keep money out of floats. */
  minSpendCents: number;
  /** The window to meet the spend, in days. DoC quotes months and billing cycles; normalised here. */
  spendWindowDays: number;
  /** Whether DoC flags this as at or near its historical high. Drives ranking, not eligibility. */
  historicalHigh: boolean;
  /** DoC's YMMV / targeted section. Real offers, but not ones to plan around. */
  targeted: boolean;
  /** Two-letter state codes when the offer is geographically limited; empty means nationwide. */
  states: string[];
  notes: string;
  /** Which snapshot this came from, so a stale recommendation can say so. */
  seenAt: IsoDate;
}

export const ACCOUNT_STATUSES = [
  'planned',
  'pending',
  'approved',
  'open',
  'closed',
  'product-changed',
  'denied',
] as const;

export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/** The bonus on a card the user actually holds, as they experienced it. */
export interface EarnedBonus {
  amount: number;
  unit: 'points' | 'miles' | 'dollars';
  minSpendCents: number;
  spendWindowDays: number;
  /** How much of the minimum spend is done. The app nags off this. */
  spentCents: number;
  /** When the bonus posted. Null while still working on it. Starts most cooldown clocks. */
  earnedAt: IsoDate | null;
}

/**
 * A card in the user's history.
 *
 * `openedAt` and not `appliedAt` is what the rules count. An application is an inquiry; an
 * *account* is what appears on a credit report with an open date, and 5/24 counts accounts. The
 * two differ by days normally and by weeks when an application goes to manual review, which is
 * long enough to move a card across a month boundary and change the answer.
 */
export interface CardAccount {
  id: string;
  /** Which player. Two-player mode is a first-class case, not a second account. */
  playerId: string;

  /** Catalog link, allowed to dangle. See the header. */
  cardId: string | null;
  cardName: string;
  issuer: IssuerId;
  productType: ProductType;

  status: AccountStatus;
  appliedAt: IsoDate | null;
  /** The date on the credit report. Null until approved. */
  openedAt: IsoDate | null;
  closedAt: IsoDate | null;

  annualFeeCents: number;
  annualFeeWaivedFirstYear: boolean;
  /**
   * When the next annual fee posts.
   *
   * Derived from `openedAt` by default, and overridable because it is genuinely not derivable:
   * issuers post the fee on the statement containing the anniversary, which can land either side
   * of the date itself, and a product change resets it to the *new* card's schedule without
   * changing the open date.
   */
  nextAnnualFeeAt: IsoDate | null;

  bonus: EarnedBonus | null;

  /**
   * Whether this account counts against 5/24.
   *
   * Defaulted from the catalog and then overridable, because the two things that break the
   * default are both invisible to a catalog: an authorized-user card counts even though the user
   * never applied for it, and an issuer can quietly start or stop reporting a business product.
   */
  counts524: boolean;
  /** An AU card someone else added you to. Counts toward 5/24; earns you no bonus. */
  authorizedUser: boolean;

  /**
   * Last time the card was used for anything.
   *
   * Tracked for one reminder, and it comes straight out of the flowchart's timing panel:
   * "Remember to put occasional purchases on old cards to avoid the banks auto-closing them. I
   * recommend a purchase every 6-8 months." An auto-closed keeper card costs you the account age
   * that made it worth keeping, and it happens silently.
   */
  lastUsedAt: IsoDate | null;

  notes: string;
  createdAt: string;
  updatedAt: string;
}

export const BANK_ACCOUNT_TYPES = [
  'checking',
  'savings',
  'business-checking',
  'business-savings',
  'brokerage',
] as const;

export type BankAccountType = (typeof BANK_ACCOUNT_TYPES)[number];

/** What a bank bonus asks for. Every field is "not required" as zero, so absent and none agree. */
export interface BonusRequirements {
  /** Total direct deposit needed, in cents. */
  directDepositCents: number;
  /** Some bonuses want N separate deposits rather than one total. */
  directDepositCount: number;
  /** A balance to hold, and for how long — the pair is the requirement, so they travel together. */
  minBalanceCents: number;
  holdDays: number;
  /** Debit card transactions, which is how the smaller credit unions structure theirs. */
  debitTransactions: number;
}

/**
 * A bank account in the user's history.
 *
 * Structurally close to `CardAccount` and deliberately not merged with it. Bank churning is a
 * different game with different clocks: the binding constraint is the issuer's own "one bonus
 * every N months per customer" language and an early-termination fee for closing too soon, and
 * there is no 5/24 equivalent. Sharing a table would mean a status enum where half the values
 * are wrong for half the rows.
 */
export interface BankAccount {
  id: string;
  playerId: string;

  offerId: string | null;
  bankName: string;
  accountType: BankAccountType;

  status: 'planned' | 'pending' | 'open' | 'closed';
  openedAt: IsoDate | null;
  closedAt: IsoDate | null;

  bonusCents: number;
  requirements: BonusRequirements;
  /** When the requirements were satisfied, as opposed to when the money showed up. */
  requirementsMetAt: IsoDate | null;
  bonusPostedAt: IsoDate | null;

  /**
   * Closing before this date costs a fee or claws the bonus back.
   *
   * Stored as a date rather than "90 days" because the number of days is quoted from account
   * opening at some banks and from bonus posting at others, and resolving that once at entry
   * beats getting it wrong on every reminder.
   */
  closeNotBeforeAt: IsoDate | null;
  monthlyFeeCents: number;
  /** What it takes to avoid the monthly fee, in plain words. Not machine-checked. */
  feeWaiverNote: string;

  notes: string;
  createdAt: string;
  updatedAt: string;
}

/** A bank bonus as the catalog knows it. Refreshed from Doctor of Credit. */
export interface BankOffer {
  id: string;
  bankName: string;
  accountType: BankAccountType;
  bonusCents: number;
  /** DoC quotes tiers as a range; this is the top of it, with the detail in `notes`. */
  bonusMaxCents: number;
  requirements: BonusRequirements;
  directDepositRequired: boolean;
  /** Soft, hard, or genuinely unknown — DoC says so explicitly and often says unknown. */
  creditPull: 'soft' | 'hard' | 'unknown';
  /** How much of the opening deposit a credit card can fund. Zero for not allowed. */
  creditCardFundingCents: number;
  /** Whether funding by card is billed as a cash advance, which makes the allowance worthless. */
  creditCardFundingCodesAsCashAdvance: boolean;
  states: string[];
  /** In-branch-only offers, which are unactionable for most people. */
  inBranchOnly: boolean;
  /** Banks known to deny on ChexSystems inquiries. Only where DoC says so in prose. */
  chexSensitive: boolean;
  /** Months before the same customer can earn this bonus again, when stated. */
  churnCooldownMonths: number | null;
  url: string;
  notes: string;
  seenAt: IsoDate;
}

/** Hard credit inquiries, which several issuers care about more than 5/24. */
export interface Inquiry {
  id: string;
  playerId: string;
  bureau: 'experian' | 'equifax' | 'transunion' | 'unknown';
  issuer: IssuerId;
  at: IsoDate;
  /** The account it produced, when known. Lets the UI stop double-counting an app and its card. */
  cardAccountId: string | null;
  notes: string;
}

/**
 * A person whose cards are being tracked.
 *
 * The flowchart's "2+ player mode" panel is the reason this exists as a row rather than being
 * implied by the user. A couple churning together runs two entirely separate rule states — two
 * 5/24 counts, two Amex lifetime histories — while sharing one login, one set of reminders and
 * one referral strategy. Modelling the second person as a second *user account* would break all
 * three of those.
 */
export interface Player {
  id: string;
  userId: string;
  name: string;
  /** The one whose numbers show by default. */
  primary: boolean;
  createdAt: string;
}

/** A user of the app. Cloud-synced, so this is the only row with a credential on it. */
export interface User {
  id: string;
  email: string;
  createdAt: string;
}

/** The complete churning state of one player, which is what every rule takes as input. */
export interface PlayerState {
  player: Player;
  cards: CardAccount[];
  banks: BankAccount[];
  inquiries: Inquiry[];
}
