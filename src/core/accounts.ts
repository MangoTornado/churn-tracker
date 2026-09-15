/**
 * Building and validating the rows the user types in.
 *
 * The defaults are the interesting part. Someone adding "Chase Ink Business Cash, opened
 * 2025-03-04" should not also have to answer whether it reports to their personal bureau, what its
 * annual fee is, or when the next one posts — the catalog knows all three, and a form that asks is
 * a form nobody fills in correctly. So `newCardAccount` derives everything derivable from
 * `cardId`, and every derived field stays overridable afterwards because the catalog is a snapshot
 * of the internet and the user is the one holding the card.
 *
 * Validation is here rather than at the HTTP boundary so that the rules can assume well-formed
 * input. A malformed date reaching `count524` does not produce an error, it produces a *wrong
 * number*, and a wrong 5/24 count is the one failure mode this app cannot have.
 */

import type {
  BankAccount,
  BankAccountType,
  BonusRequirements,
  CardAccount,
  EarnedBonus,
  IssuerId,
  IsoDate,
} from './model.ts';
import { ACCOUNT_STATUSES, BANK_ACCOUNT_TYPES, ISSUERS } from './model.ts';
import { addMonths, isIsoDate } from './dates.ts';
import { catalog } from './data/cards.ts';

export class ValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
  }
}

function requireIsoDate(field: string, value: unknown): IsoDate {
  if (!isIsoDate(value)) {
    throw new ValidationError(field, `${field} must be a YYYY-MM-DD date, got ${JSON.stringify(value)}`);
  }
  return value;
}

function optionalIsoDate(field: string, value: unknown): IsoDate | null {
  if (value === null || value === undefined || value === '') return null;
  return requireIsoDate(field, value);
}

function requireOneOf<T extends string>(field: string, value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ValidationError(field, `${field} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function cents(field: string, value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ValidationError(field, `${field} must be a non-negative number of cents`);
  }
  // Cents are integers. A fractional cent here means somebody multiplied dollars by 100 in
  // floating point and got 12345.000000000002, which would then survive into a stored total.
  return Math.round(value);
}

export interface CardAccountInput {
  id?: string;
  playerId: string;
  cardId?: string | null;
  cardName?: string;
  issuer?: IssuerId;
  productType?: 'personal' | 'business';
  status?: string;
  appliedAt?: string | null;
  openedAt?: string | null;
  closedAt?: string | null;
  annualFeeCents?: number;
  annualFeeWaivedFirstYear?: boolean;
  nextAnnualFeeAt?: string | null;
  bonus?: Partial<EarnedBonus> | null;
  counts524?: boolean;
  authorizedUser?: boolean;
  lastUsedAt?: string | null;
  notes?: string;
}

/**
 * A card account from user input, with everything derivable derived.
 *
 * The `counts524` default is the one to be careful with, and it composes two facts rather than
 * one: the catalog's `showsOnPersonalReport`, and whether this is an authorized-user card. An AU
 * card counts even though the user never applied — which is why it is `||` and not the catalog
 * value alone.
 */
export function newCardAccount(input: CardAccountInput, now = new Date().toISOString()): CardAccount {
  if (typeof input.playerId !== 'string' || input.playerId === '') {
    throw new ValidationError('playerId', 'playerId is required');
  }

  const cardId = input.cardId ?? null;
  const known = cardId === null ? null : catalog(cardId);
  const reference = known?.known ? known.card : null;

  const cardName = input.cardName ?? reference?.name;
  if (typeof cardName !== 'string' || cardName.trim() === '') {
    throw new ValidationError('cardName', 'cardName is required when cardId is not in the catalog');
  }

  const issuer = input.issuer ?? reference?.issuer;
  if (issuer === undefined) {
    throw new ValidationError('issuer', 'issuer is required when cardId is not in the catalog');
  }
  requireOneOf('issuer', issuer, ISSUERS);

  const productType = input.productType ?? reference?.productType ?? 'personal';
  requireOneOf('productType', productType, ['personal', 'business'] as const);

  const status = requireOneOf('status', input.status ?? 'open', ACCOUNT_STATUSES);
  const openedAt = optionalIsoDate('openedAt', input.openedAt);
  const appliedAt = optionalIsoDate('appliedAt', input.appliedAt);
  const closedAt = optionalIsoDate('closedAt', input.closedAt);

  if (status === 'closed' && closedAt === null) {
    throw new ValidationError('closedAt', 'a closed account needs closedAt');
  }
  if ((status === 'open' || status === 'approved') && openedAt === null) {
    throw new ValidationError('openedAt', `an ${status} account needs openedAt`);
  }
  if (openedAt !== null && closedAt !== null && closedAt < openedAt) {
    throw new ValidationError('closedAt', 'closedAt cannot be before openedAt');
  }
  if (openedAt !== null && appliedAt !== null && openedAt < appliedAt) {
    throw new ValidationError('openedAt', 'openedAt cannot be before appliedAt');
  }

  const annualFeeCents = cents('annualFeeCents', input.annualFeeCents, reference?.annualFeeCents ?? 0);
  const annualFeeWaivedFirstYear =
    input.annualFeeWaivedFirstYear ?? reference?.annualFeeWaivedFirstYear ?? false;

  const authorizedUser = input.authorizedUser ?? false;
  const counts524 =
    input.counts524 ?? (authorizedUser || (reference?.showsOnPersonalReport ?? productType === 'personal'));

  return {
    id: input.id ?? crypto.randomUUID(),
    playerId: input.playerId,
    cardId,
    cardName: cardName.trim(),
    issuer,
    productType,
    status,
    appliedAt,
    openedAt,
    closedAt,
    annualFeeCents,
    annualFeeWaivedFirstYear,
    // Left null rather than guessed: `reminders.nextAnnualFee` computes the anniversary on demand
    // and knows it is an estimate. Storing a guess would make it indistinguishable from a date the
    // user read off a statement.
    nextAnnualFeeAt: optionalIsoDate('nextAnnualFeeAt', input.nextAnnualFeeAt),
    bonus: normaliseBonus(input.bonus),
    counts524,
    authorizedUser,
    lastUsedAt: optionalIsoDate('lastUsedAt', input.lastUsedAt),
    notes: input.notes ?? '',
    createdAt: now,
    updatedAt: now,
  };
}

function normaliseBonus(input: Partial<EarnedBonus> | null | undefined): EarnedBonus | null {
  if (input === null || input === undefined) return null;
  const unit = requireOneOf('bonus.unit', input.unit ?? 'points', ['points', 'miles', 'dollars'] as const);
  const amount = input.amount ?? 0;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    throw new ValidationError('bonus.amount', 'bonus.amount must be a non-negative number');
  }
  return {
    amount,
    unit,
    minSpendCents: cents('bonus.minSpendCents', input.minSpendCents),
    // 90 days is the most common window by a wide margin, and a zero would make the deadline
    // reminder fire on the open date.
    spendWindowDays: input.spendWindowDays ?? 90,
    spentCents: cents('bonus.spentCents', input.spentCents),
    earnedAt: optionalIsoDate('bonus.earnedAt', input.earnedAt),
  };
}

export interface BankAccountInput {
  id?: string;
  playerId: string;
  offerId?: string | null;
  bankName?: string;
  accountType?: string;
  status?: string;
  openedAt?: string | null;
  closedAt?: string | null;
  bonusCents?: number;
  requirements?: Partial<BonusRequirements>;
  requirementsMetAt?: string | null;
  bonusPostedAt?: string | null;
  closeNotBeforeAt?: string | null;
  monthlyFeeCents?: number;
  feeWaiverNote?: string;
  notes?: string;
}

export function newBankAccount(input: BankAccountInput, now = new Date().toISOString()): BankAccount {
  if (typeof input.playerId !== 'string' || input.playerId === '') {
    throw new ValidationError('playerId', 'playerId is required');
  }
  if (typeof input.bankName !== 'string' || input.bankName.trim() === '') {
    throw new ValidationError('bankName', 'bankName is required');
  }

  const status = requireOneOf('status', input.status ?? 'open', ['planned', 'pending', 'open', 'closed'] as const);
  const openedAt = optionalIsoDate('openedAt', input.openedAt);
  const closedAt = optionalIsoDate('closedAt', input.closedAt);

  if (status === 'open' && openedAt === null) {
    throw new ValidationError('openedAt', 'an open account needs openedAt');
  }
  if (status === 'closed' && closedAt === null) {
    throw new ValidationError('closedAt', 'a closed account needs closedAt');
  }

  const requirements: BonusRequirements = {
    directDepositCents: cents('requirements.directDepositCents', input.requirements?.directDepositCents),
    directDepositCount: Math.max(0, Math.round(input.requirements?.directDepositCount ?? 0)),
    minBalanceCents: cents('requirements.minBalanceCents', input.requirements?.minBalanceCents),
    holdDays: Math.max(0, Math.round(input.requirements?.holdDays ?? 0)),
    debitTransactions: Math.max(0, Math.round(input.requirements?.debitTransactions ?? 0)),
  };

  return {
    id: input.id ?? crypto.randomUUID(),
    playerId: input.playerId,
    offerId: input.offerId ?? null,
    bankName: input.bankName.trim(),
    accountType: requireOneOf('accountType', input.accountType ?? 'checking', BANK_ACCOUNT_TYPES) as BankAccountType,
    status,
    openedAt,
    closedAt,
    bonusCents: cents('bonusCents', input.bonusCents),
    requirements,
    requirementsMetAt: optionalIsoDate('requirementsMetAt', input.requirementsMetAt),
    bonusPostedAt: optionalIsoDate('bonusPostedAt', input.bonusPostedAt),
    closeNotBeforeAt: optionalIsoDate('closeNotBeforeAt', input.closeNotBeforeAt),
    monthlyFeeCents: cents('monthlyFeeCents', input.monthlyFeeCents),
    feeWaiverNote: input.feeWaiverNote ?? '',
    notes: input.notes ?? '',
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * A suggested `closeNotBeforeAt` for a bank bonus.
 *
 * Six months from opening, which is the figure most offers use and the one DoC quotes when an
 * offer is silent. Only a suggestion: the actual term is in the fine print, it is sometimes
 * measured from the bonus posting rather than from opening, and the field exists so the user can
 * put the real date in.
 */
export function suggestedCloseNotBefore(openedAt: IsoDate): IsoDate {
  return addMonths(openedAt, 6);
}
