/**
 * The derived numbers a churner actually navigates by: 5/24, inquiries per window, and how
 * recently each issuer was asked for anything.
 *
 * Everything here counts *accounts that opened*, not applications. Three consequences, each of
 * which has cost somebody a denial:
 *
 *   - **Closing a card does not remove it from 5/24.** The rule counts accounts opened in the
 *     window, and a closed account keeps its open date on the report for a decade. So the filter
 *     is on `openedAt` and never on `status === 'open'`.
 *   - **A denial does not count.** No account opened, so nothing appears on the report. An
 *     application that was denied leaves an *inquiry*, which is a separate count that Citi and
 *     US Bank care about far more than Chase does.
 *   - **An authorized-user card counts, and you did not apply for it.** Which is why the
 *     flowchart's two-player panel opens by telling couples not to add each other.
 *
 * The window boundary is inclusive at the far end and exclusive at the near end — a card opened
 * exactly 24 months ago today has aged out. That is `withinMonths`, and it matches how the count
 * is read in practice: people wait for the anniversary and apply on it.
 */

import type { CardAccount, IssuerId, IsoDate, PlayerState } from '../model.ts';
import { addMonths, latest, monthsBetween, toEpoch, withinDays, withinMonths } from '../dates.ts';

/**
 * Statuses that mean an account exists on a credit report.
 *
 * `product-changed` is here because a product change keeps the original account and its open
 * date — that is the whole reason people do it instead of closing and reapplying. `approved` is
 * here because the account is open even if the user has not yet flipped the status.
 */
const ON_REPORT = new Set(['approved', 'open', 'closed', 'product-changed']);

export function isOnReport(account: CardAccount): boolean {
  return ON_REPORT.has(account.status) && account.openedAt !== null;
}

/** Accounts that exist, oldest first, with a known open date. Every count below starts here. */
export function openedAccounts(state: PlayerState): CardAccount[] {
  return state.cards
    .filter(isOnReport)
    .slice()
    .sort((a, b) => toEpoch(a.openedAt as IsoDate) - toEpoch(b.openedAt as IsoDate));
}

export interface Count524 {
  /** The number itself. Chase denies at 5 or more. */
  count: number;
  /** The accounts making it up, newest first, so the UI can show its work. */
  accounts: CardAccount[];
  /**
   * When the count next drops, and to what.
   *
   * Null when the count is already zero. This is the single most asked question in churning and
   * the reason the whole tracker is worth having.
   */
  nextDropAt: IsoDate | null;
  nextDropTo: number | null;
  /** When the count first reaches 4, i.e. when a Chase application becomes possible again. */
  under5At: IsoDate | null;
}

/**
 * The 5/24 count: personal accounts opened in the last 24 months.
 *
 * `counts524` on the account decides membership rather than anything recomputed here, because the
 * exceptions are user knowledge and not catalog knowledge — see the field's comment in `model.ts`.
 */
export function count524(state: PlayerState, asOf: IsoDate): Count524 {
  const counted = openedAccounts(state).filter(
    (account) => account.counts524 && withinMonths(account.openedAt as IsoDate, 24, asOf),
  );

  // Ordered by when each will age out, which is the same as open order.
  const expiries = counted.map((account) => addMonths(account.openedAt as IsoDate, 24));

  const nextDropAt = expiries.length > 0 ? expiries[0] : null;
  // Several cards opened on the same day age out together, so the drop is not always by one.
  const droppingTogether = expiries.filter((date) => date === nextDropAt).length;

  // When does the count first reach 4? Walk the expiries: after the k-th ages out the count is
  // `length - k`, so the first k where that is under 5 is the answer.
  let under5At: IsoDate | null = counted.length < 5 ? asOf : null;
  if (under5At === null) {
    for (let k = 1; k <= expiries.length; k += 1) {
      if (counted.length - k < 5) {
        under5At = expiries[k - 1];
        break;
      }
    }
  }

  return {
    count: counted.length,
    accounts: counted.slice().reverse(),
    nextDropAt,
    nextDropTo: nextDropAt === null ? null : counted.length - droppingTogether,
    under5At,
  };
}

/**
 * Accounts opened with one issuer in a window, which is what most issuer-specific rules count.
 *
 * `productType` narrows it, because Chase's six-month gap is between *business* cards only and
 * Barclays' 6/24 counts everything.
 */
export function issuerAccountsInMonths(
  state: PlayerState,
  issuer: IssuerId,
  months: number,
  asOf: IsoDate,
  productType?: 'personal' | 'business',
): CardAccount[] {
  return openedAccounts(state).filter(
    (account) =>
      account.issuer === issuer &&
      !account.authorizedUser &&
      (productType === undefined || account.productType === productType) &&
      withinMonths(account.openedAt as IsoDate, months, asOf),
  );
}

/**
 * Approvals with one issuer in a window measured in days.
 *
 * Amex's 2/90 and 1/5 are the reason this counts days rather than months, and they count
 * *approvals* — an application still pending decision has not used a slot yet, and one that was
 * denied never did.
 */
export function issuerApprovalsInDays(
  state: PlayerState,
  issuer: IssuerId,
  days: number,
  asOf: IsoDate,
): CardAccount[] {
  return openedAccounts(state).filter(
    (account) =>
      account.issuer === issuer &&
      !account.authorizedUser &&
      withinDays(account.openedAt as IsoDate, days, asOf),
  );
}

/** Cards currently open with an issuer. What Amex's five-credit-card limit is about. */
export function openWithIssuer(
  state: PlayerState,
  issuer: IssuerId,
  productType?: 'personal' | 'business',
): CardAccount[] {
  return state.cards.filter(
    (account) =>
      account.issuer === issuer &&
      !account.authorizedUser &&
      (account.status === 'open' || account.status === 'approved' || account.status === 'product-changed') &&
      (productType === undefined || account.productType === productType),
  );
}

/**
 * The last time this issuer was *asked* for anything, application or approval.
 *
 * Applications and not approvals, because Chase's three-month velocity guideline is about how
 * often you show up — a denial still counted as showing up. `appliedAt` is preferred and
 * `openedAt` is the fallback, since plenty of history gets entered with only the open date known.
 */
export function lastAppliedTo(state: PlayerState, issuer: IssuerId, productType?: 'personal' | 'business'): IsoDate | null {
  return latest(
    state.cards
      .filter(
        (account) =>
          account.issuer === issuer &&
          !account.authorizedUser &&
          account.status !== 'planned' &&
          (productType === undefined || account.productType === productType),
      )
      .map((account) => account.appliedAt ?? account.openedAt),
  );
}

export interface InquiryCount {
  /** Inquiries in the window, whichever bureau. */
  total: number;
  /** Per bureau, since an issuer only ever pulls one and only sees that one's count. */
  byBureau: Record<string, number>;
}

/**
 * Hard inquiries in the last N months.
 *
 * Split by bureau because that is how it is used: Citi pulls Equifax in most of the country, and
 * being 4/6 overall but 1/6 on Equifax is an approval rather than a denial. An application whose
 * bureau the user did not record lands in `unknown` and is counted in `total` only, which
 * understates every individual bureau — deliberately, since guessing would overstate one.
 */
export function inquiriesInMonths(state: PlayerState, months: number, asOf: IsoDate): InquiryCount {
  const recent = state.inquiries.filter((inquiry) => withinMonths(inquiry.at, months, asOf));
  const byBureau: Record<string, number> = { experian: 0, equifax: 0, transunion: 0, unknown: 0 };
  for (const inquiry of recent) byBureau[inquiry.bureau] += 1;
  return { total: recent.length, byBureau };
}

/**
 * Every distinct new account in a window, which is what Bank of America's 3/12 and 7/12 count.
 *
 * Not the same as 5/24: BoA counts business cards too, and it counts accounts at every issuer
 * including its own. Kept separate rather than parameterising `count524`, because conflating the
 * two is how a 5/24 exception silently leaks into a BoA answer.
 */
export function newAccountsInMonths(state: PlayerState, months: number, asOf: IsoDate): CardAccount[] {
  return openedAccounts(state).filter((account) =>
    withinMonths(account.openedAt as IsoDate, months, asOf),
  );
}

/** Months since a specific card's bonus posted, for the per-product cooldowns. Null if never. */
export function monthsSinceBonusOn(
  state: PlayerState,
  cardId: string,
  asOf: IsoDate,
): number | null {
  const earned = latest(
    state.cards
      .filter((account) => account.cardId === cardId && account.bonus?.earnedAt)
      .map((account) => account.bonus?.earnedAt ?? null),
  );
  return earned === null ? null : monthsBetween(earned, asOf);
}

/** Whether this exact card has ever been held, which is what Amex's lifetime language turns on. */
export function everHeld(state: PlayerState, cardId: string): CardAccount | null {
  return (
    state.cards.find(
      (account) => account.cardId === cardId && !account.authorizedUser && isOnReport(account),
    ) ?? null
  );
}
