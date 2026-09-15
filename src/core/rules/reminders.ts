/**
 * Reminders: the dates that cost money if you miss them.
 *
 * This is the half of the app that earns its keep. The recommender is advice and you can argue
 * with it; a reminder is a deadline, and missing one has a price you can name — an annual fee you
 * meant to avoid, a $1,200 bonus forfeited three days short of the minimum spend, a keeper card
 * auto-closed for inactivity after four years of history.
 *
 * Two design decisions worth keeping:
 *
 * **Reminders are derived, never stored.** Every call recomputes them from the accounts. There is
 * no reminders table to drift out of step with the history, no migration when a rule changes, and
 * correcting a wrong open date fixes every downstream date at once. What *is* stored is the small
 * set of ids the user has dismissed, which is why ids are stable and content-addressed rather
 * than sequential: `id` folds in the due date, so moving a deadline resurfaces the reminder
 * instead of leaving it silently dismissed.
 *
 * **Every reminder carries what is at stake, in cents.** Sorting by date alone buries a $695
 * annual fee under three $0 housekeeping notices. `stakeCents` is what makes the list read in the
 * order a person actually cares about.
 */

import type { BankAccount, CardAccount, IsoDate, PlayerState } from '../model.ts';
import { addDays, addMonths, daysBetween, pretty, relative, toEpoch } from '../dates.ts';
import { count524 } from './counts.ts';

export const REMINDER_KINDS = [
  'annual-fee-due',
  'annual-fee-decision',
  'annual-fee-reversal-window',
  'card-turns-one',
  'min-spend-deadline',
  'bonus-not-posted',
  'card-inactivity',
  'bonus-eligible-again',
  'slot-524-opens',
  'bank-requirements-deadline',
  'bank-safe-to-close',
  'bank-bonus-not-posted',
] as const;

export type ReminderKind = (typeof REMINDER_KINDS)[number];

export interface Reminder {
  /**
   * Stable across recomputation, and it includes the due date on purpose. A dismissal is a
   * statement about a specific deadline, so when the deadline moves the reminder is a new one.
   */
  id: string;
  kind: ReminderKind;
  playerId: string;
  subject: { type: 'card' | 'bank' | 'player'; id: string; name: string };
  /** The date the thing happens. Not the date to show it — that is `dueAt` minus `leadDays`. */
  dueAt: IsoDate;
  /** How far ahead this becomes worth saying. Wide for decisions, narrow for housekeeping. */
  leadDays: number;
  title: string;
  detail: string;
  /** Money on the line, in cents. Zero for informational reminders. Sorts the list. */
  stakeCents: number;
}

export interface ReminderView extends Reminder {
  daysUntil: number;
  /** `urgent` inside a week, `soon` inside the lead window, `upcoming` beyond it. */
  urgency: 'overdue' | 'urgent' | 'soon' | 'upcoming';
  /** "in 3 months", for the UI. */
  whenText: string;
}

const ACTIVE_STATUSES = new Set(['approved', 'open', 'product-changed']);

function isActive(account: CardAccount): boolean {
  return ACTIVE_STATUSES.has(account.status);
}

/**
 * When the next annual fee posts.
 *
 * Prefers the stored value, and falls back to the next anniversary of the open date. The fallback
 * is an estimate and is treated as one: issuers post the fee on the statement that *contains* the
 * anniversary, which can land up to a month either side, and a product change moves the fee to
 * the new card's schedule without moving the open date. That is exactly why the field is
 * overridable — see `CardAccount.nextAnnualFeeAt`.
 */
export function nextAnnualFee(account: CardAccount, asOf: IsoDate): IsoDate | null {
  if (account.nextAnnualFeeAt !== null) return account.nextAnnualFeeAt;
  if (account.openedAt === null || account.annualFeeCents === 0) return null;

  // Walk anniversaries forward rather than doing division, so the month clamping in `addMonths`
  // applies at every step — a card opened on the 31st keeps landing on month-ends.
  for (let year = 1; year <= 40; year += 1) {
    const anniversary = addMonths(account.openedAt, 12 * year);
    if (toEpoch(anniversary) > toEpoch(asOf)) return anniversary;
  }
  return null;
}

/**
 * The most recent annual fee to have posted, if any.
 *
 * Needed because `nextAnnualFee` rolls straight past a fee the moment it posts — correctly, since
 * the next one is a year out — which would leave the weeks *just after* a fee silent. Those weeks
 * are the last chance to act: most issuers refund an annual fee if the card is closed or
 * downgraded within about 30 days of it posting.
 */
function lastAnnualFee(account: CardAccount, asOf: IsoDate): IsoDate | null {
  if (account.openedAt === null || account.annualFeeCents === 0) return null;

  let latest: IsoDate | null = null;
  for (let year = 1; year <= 40; year += 1) {
    const anniversary = addMonths(account.openedAt, 12 * year);
    if (toEpoch(anniversary) > toEpoch(asOf)) break;
    latest = anniversary;
  }
  return latest;
}

function cardReminders(account: CardAccount, asOf: IsoDate): Reminder[] {
  const out: Reminder[] = [];
  const subject = { type: 'card' as const, id: account.id, name: account.cardName };
  const push = (
    kind: ReminderKind,
    dueAt: IsoDate,
    leadDays: number,
    title: string,
    detail: string,
    stakeCents = 0,
  ): void => {
    out.push({
      id: `${kind}:${account.id}:${dueAt}`,
      kind,
      playerId: account.playerId,
      subject,
      dueAt,
      leadDays,
      title,
      detail,
      stakeCents,
    });
  };

  // ---- the minimum spend, which is the only deadline with a hard forfeit ----
  if (account.bonus !== null && account.bonus.earnedAt === null && account.openedAt !== null) {
    const deadline = addDays(account.openedAt, account.bonus.spendWindowDays);
    const remaining = Math.max(0, account.bonus.minSpendCents - account.bonus.spentCents);
    if (toEpoch(deadline) >= toEpoch(asOf)) {
      push(
        'min-spend-deadline',
        deadline,
        // Six weeks: long enough to still be able to *do* something about a shortfall, which a
        // two-week warning on a $15,000 minimum spend is not.
        45,
        remaining === 0 ? 'Minimum spend met — bonus pending' : `Spend ${dollars(remaining)} more`,
        remaining === 0
          ? `${account.cardName}: the ${account.bonus.amount.toLocaleString()} ${account.bonus.unit} bonus should post within a statement cycle or two.`
          : `${account.cardName}: ${dollars(remaining)} of the ${dollars(account.bonus.minSpendCents)} minimum spend is still outstanding, due ${pretty(deadline)}. Missing it forfeits the whole bonus.`,
        // The stake is the bonus, not the shortfall — that is what is actually lost.
        account.bonus.unit === 'dollars' ? account.bonus.amount * 100 : estimatePointsCents(account.bonus.amount),
      );
    }
  }

  // ---- the bonus that met its terms and then did not arrive ----------------
  if (account.bonus !== null && account.bonus.earnedAt === null && account.bonus.spentCents >= account.bonus.minSpendCents && account.openedAt !== null) {
    // Two statement cycles is the point at which "it is processing" becomes "call them". Before
    // that a nag is noise; after it, the window to complain is finite.
    const chase = addDays(account.openedAt, account.bonus.spendWindowDays + 60);
    if (toEpoch(chase) >= toEpoch(asOf)) {
      push(
        'bonus-not-posted',
        chase,
        14,
        'Chase up an unposted bonus',
        `${account.cardName}: the spend was met but nothing has posted. Two cycles is long enough — contact the issuer while the offer terms are still fresh.`,
        account.bonus.unit === 'dollars' ? account.bonus.amount * 100 : estimatePointsCents(account.bonus.amount),
      );
    }
  }

  if (!isActive(account) || account.openedAt === null) return out;

  // ---- the first anniversary, which is when a card becomes closable ---------
  const oneYear = addMonths(account.openedAt, 12);
  if (toEpoch(oneYear) > toEpoch(asOf)) {
    push(
      'card-turns-one',
      oneYear,
      30,
      'Card reaches one year old',
      `${account.cardName} was opened ${pretty(account.openedAt)}. Closing or downgrading before a year is up annoys the issuer and, at Chase, counts against you — this is the date it becomes safe.`,
    );
  }

  // ---- the annual fee ------------------------------------------------------
  const feeAt = nextAnnualFee(account, asOf);
  if (feeAt !== null && account.annualFeeCents > 0) {
    const firstFee = toEpoch(feeAt) <= toEpoch(addMonths(account.openedAt, 12));

    push(
      'annual-fee-due',
      feeAt,
      30,
      `${dollars(account.annualFeeCents)} annual fee posts`,
      `${account.cardName}: ${dollars(account.annualFeeCents)} posts around ${pretty(feeAt)}${account.annualFeeWaivedFirstYear && firstFee ? ' — though the first year is waived on this card' : ''}.`,
      account.annualFeeCents,
    );

    // The fee has posted and there is still time to undo it. A short, sharp window — and the only
    // reminder here whose lead is the whole window, because there is no point warning about it
    // before it opens.
    const posted = lastAnnualFee(account, asOf);
    if (posted !== null && daysBetween(posted, asOf) <= 30) {
      push(
        'annual-fee-reversal-window',
        addDays(posted, 30),
        30,
        `Last chance to reverse ${account.cardName}'s fee`,
        `${dollars(account.annualFeeCents)} posted around ${pretty(posted)}. Most issuers refund an annual fee if you close or downgrade within about 30 days of it posting — after that it is spent. Ask for a retention offer first.`,
        account.annualFeeCents,
      );
    }

    // The decision reminder, and the one people actually want. Deliberately a separate reminder
    // from the fee itself with a much longer lead: retention offers are worth asking for before
    // the fee posts, downgrades take a phone call, and after a fee posts you have roughly 30 days
    // to reverse it and not always that.
    const decideBy = addDays(feeAt, -45);
    if (toEpoch(decideBy) > toEpoch(asOf) && toEpoch(decideBy) >= toEpoch(oneYear)) {
      push(
        'annual-fee-decision',
        decideBy,
        45,
        `Decide on ${account.cardName} before its fee`,
        `${dollars(account.annualFeeCents)} posts around ${pretty(feeAt)}. Keep it, ask for a retention offer, downgrade it to a no-fee card in the same family, or close it. Downgrading keeps the account age; closing does not.`,
        account.annualFeeCents,
      );
    }
  }

  // ---- inactivity, straight from the flowchart's timing panel ---------------
  const idleSince = account.lastUsedAt ?? account.openedAt;
  // Only for cards worth keeping — a no-fee keeper is exactly what gets auto-closed, and a card
  // you are about to cancel anyway does not need a coffee bought on it.
  if (account.annualFeeCents === 0) {
    // Pushed unconditionally, including when the date is already past. A card idle for two years
    // is the case this reminder exists for, and filtering to future dates would drop exactly that
    // one — `activeReminders` marks it `overdue` instead, which is the truth.
    push(
      'card-inactivity',
      addMonths(idleSince, 7),
      30,
      `Put a small purchase on ${account.cardName}`,
      `Last used ${pretty(idleSince)}. Banks auto-close idle cards, and that costs you the account age that made the card worth keeping. A cup of coffee every 6–8 months is enough.`,
    );
  }

  return out;
}

function bankReminders(account: BankAccount, asOf: IsoDate): Reminder[] {
  const out: Reminder[] = [];
  if (account.status !== 'open' || account.openedAt === null) return out;

  const subject = { type: 'bank' as const, id: account.id, name: account.bankName };
  const push = (
    kind: ReminderKind,
    dueAt: IsoDate,
    leadDays: number,
    title: string,
    detail: string,
    stakeCents = 0,
  ): void => {
    out.push({
      id: `${kind}:${account.id}:${dueAt}`,
      kind,
      playerId: account.playerId,
      subject,
      dueAt,
      leadDays,
      title,
      detail,
      stakeCents,
    });
  };

  // Requirements deadline. Bank bonuses state their window in the offer and it is usually 60–90
  // days from opening; `holdDays` is the closest thing the model has to it, and where a bonus has
  // no hold requirement there is nothing to remind about.
  if (account.requirementsMetAt === null && account.requirements.holdDays > 0) {
    const deadline = addDays(account.openedAt, account.requirements.holdDays);
    if (toEpoch(deadline) >= toEpoch(asOf)) {
      const asks: string[] = [];
      if (account.requirements.directDepositCents > 0) {
        asks.push(
          `${dollars(account.requirements.directDepositCents)} in direct deposits${account.requirements.directDepositCount > 1 ? ` across ${account.requirements.directDepositCount} deposits` : ''}`,
        );
      }
      if (account.requirements.minBalanceCents > 0) {
        asks.push(`a ${dollars(account.requirements.minBalanceCents)} balance held`);
      }
      if (account.requirements.debitTransactions > 0) {
        asks.push(`${account.requirements.debitTransactions} debit transactions`);
      }
      push(
        'bank-requirements-deadline',
        deadline,
        30,
        `Finish ${account.bankName}'s requirements`,
        `${dollars(account.bonusCents)} bonus needs ${asks.join(', ') || 'its stated requirements'} by ${pretty(deadline)}.`,
        account.bonusCents,
      );
    }
  }

  // The bonus that met its terms and did not arrive. Banks are slower than card issuers about
  // this and the money is usually larger, so it gets its own reminder.
  if (account.requirementsMetAt !== null && account.bonusPostedAt === null) {
    const chase = addDays(account.requirementsMetAt, 60);
    if (toEpoch(chase) >= toEpoch(asOf)) {
      push(
        'bank-bonus-not-posted',
        chase,
        14,
        `Chase up ${account.bankName}'s bonus`,
        `Requirements were met ${pretty(account.requirementsMetAt)} and ${dollars(account.bonusCents)} has not posted. Most offers say 60–90 days; this is the point to ask.`,
        account.bonusCents,
      );
    }
  }

  // Safe to close. The reason bank churning needs a tracker at all: close early and the bonus is
  // clawed back or an early-termination fee applies, but leave it open and a monthly fee eats it.
  if (account.closeNotBeforeAt !== null && toEpoch(account.closeNotBeforeAt) > toEpoch(asOf)) {
    push(
      'bank-safe-to-close',
      account.closeNotBeforeAt,
      14,
      `${account.bankName} becomes safe to close`,
      account.monthlyFeeCents > 0
        ? `Closing before ${pretty(account.closeNotBeforeAt)} risks a clawback or fee. It carries a ${dollars(account.monthlyFeeCents)}/month fee${account.feeWaiverNote ? ` (${account.feeWaiverNote})` : ''}, so close it promptly after.`
        : `Closing before ${pretty(account.closeNotBeforeAt)} risks a clawback or an early-termination fee.`,
      account.monthlyFeeCents > 0 ? account.monthlyFeeCents : account.bonusCents,
    );
  }

  return out;
}

function playerReminders(state: PlayerState, asOf: IsoDate): Reminder[] {
  const out: Reminder[] = [];
  const subject = { type: 'player' as const, id: state.player.id, name: state.player.name };

  // The 5/24 slot. Only worth a reminder when it is currently the binding constraint — telling
  // someone at 2/24 that they will be at 1/24 in March is noise.
  const count = count524(state, asOf);
  if (count.count >= 5 && count.under5At !== null) {
    out.push({
      // The raw ISO date, not the formatted one: this is an identifier the client stores when the
      // user dismisses it, so it has to be stable and machine-shaped rather than readable.
      id: `slot-524-opens:${state.player.id}:${count.under5At}`,
      kind: 'slot-524-opens',
      playerId: state.player.id,
      subject,
      dueAt: count.under5At,
      // Long lead: this is the date the whole Chase plan hangs off, and knowing it three months
      // out is what lets someone line up business-card spacers in the meantime.
      leadDays: 120,
      title: 'You drop under 5/24',
      detail: `You are ${count.count}/24 now. On ${pretty(count.under5At)} you fall to 4/24 and Chase applications reopen — the flowchart's under-5/24 section is the plan to follow from there.`,
      stakeCents: 0,
    });
  }

  return out;
}

/** Every reminder for a player, soonest and most valuable first. */
export function reminders(state: PlayerState, asOf: IsoDate): Reminder[] {
  const out: Reminder[] = [
    ...state.cards.flatMap((account) => cardReminders(account, asOf)),
    ...state.banks.flatMap((account) => bankReminders(account, asOf)),
    ...playerReminders(state, asOf),
  ];

  return out.sort(
    (a, b) => toEpoch(a.dueAt) - toEpoch(b.dueAt) || b.stakeCents - a.stakeCents,
  );
}

/**
 * The reminders worth showing today, with their urgency resolved.
 *
 * `dismissed` is the set of ids the user has waved away. Filtered here rather than at the call
 * site so that "dismissed" and "not yet within its lead window" are the same kind of thing: not
 * on the list.
 */
export function activeReminders(
  state: PlayerState,
  asOf: IsoDate,
  dismissed: ReadonlySet<string> = new Set(),
): ReminderView[] {
  return reminders(state, asOf)
    .filter((reminder) => !dismissed.has(reminder.id))
    .map((reminder) => {
      const daysUntil = daysBetween(asOf, reminder.dueAt);
      return {
        ...reminder,
        daysUntil,
        urgency:
          daysUntil < 0
            ? ('overdue' as const)
            : daysUntil <= 7
              ? ('urgent' as const)
              : daysUntil <= reminder.leadDays
                ? ('soon' as const)
                : ('upcoming' as const),
        whenText: relative(asOf, reminder.dueAt),
      };
    })
    .filter((reminder) => reminder.urgency !== 'upcoming');
}

function dollars(cents: number): string {
  const whole = cents / 100;
  return `$${whole.toLocaleString('en-US', { minimumFractionDigits: whole % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/**
 * A points balance in cents, for sorting only.
 *
 * 1.5 cents a point, flat, across every currency. That is wrong for all of them and the
 * flowchart's "Limitations" panel explains why no single number could be right — an airline mile
 * is worth what your home airport and your travel dates make it worth. It is used strictly to
 * rank one reminder above another, never shown to the user and never summed into a total.
 */
function estimatePointsCents(points: number): number {
  return Math.round(points * 1.5);
}
