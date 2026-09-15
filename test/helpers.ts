/**
 * Fixtures for the rule tests.
 *
 * Everything takes an explicit `asOf` and every date in a test is written out in full. That is
 * verbose on purpose: a helper like `monthsAgo(14)` computes the expected value with the same
 * arithmetic as the code under test, so a bug in `addMonths` would cancel out and the test would
 * pass. Literal dates are the only thing that actually pins the boundaries down.
 */

import type { BankAccount, CardAccount, Inquiry, Player, PlayerState } from '../src/core/model.ts';
import { newBankAccount, newCardAccount, type CardAccountInput } from '../src/core/accounts.ts';

export const PLAYER: Player = {
  id: 'player-1',
  userId: 'user-1',
  name: 'Test',
  primary: true,
  createdAt: '2020-01-01T00:00:00.000Z',
};

/** A card account with a fixed `createdAt`, so snapshots and ids are stable across runs. */
export function card(input: Omit<CardAccountInput, 'playerId'> & { playerId?: string }): CardAccount {
  return newCardAccount(
    { playerId: PLAYER.id, ...input, id: input.id ?? `card-${nextId()}` },
    '2020-01-01T00:00:00.000Z',
  );
}

export function bank(input: Parameters<typeof newBankAccount>[0]): BankAccount {
  return newBankAccount(
    { ...input, playerId: input.playerId ?? PLAYER.id, id: input.id ?? `bank-${nextId()}` },
    '2020-01-01T00:00:00.000Z',
  );
}

export function inquiry(at: string, overrides: Partial<Inquiry> = {}): Inquiry {
  return {
    id: `inquiry-${nextId()}`,
    playerId: PLAYER.id,
    bureau: 'experian',
    issuer: 'other',
    at,
    cardAccountId: null,
    notes: '',
    ...overrides,
  };
}

export function state(
  cards: CardAccount[],
  extras: { banks?: BankAccount[]; inquiries?: Inquiry[] } = {},
): PlayerState {
  return {
    player: PLAYER,
    cards,
    banks: extras.banks ?? [],
    inquiries: extras.inquiries ?? [],
  };
}

let counter = 0;

function nextId(): number {
  counter += 1;
  return counter;
}
