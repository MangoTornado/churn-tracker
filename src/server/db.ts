/**
 * Storage. One SQLite file, no migrations framework, no ORM.
 *
 * The design decision that shapes the rest: **every row is soft-deleted and carries `updated_at`,
 * and nothing is ever computed and stored.** Two consequences.
 *
 * Sync works. Three clients — a phone, a tablet, a browser — each ask "what changed since T" and
 * get rows back including tombstones, so a delete propagates rather than silently reappearing on
 * the next upload. Last-write-wins on `updated_at` is a crude merge, and it is the right one here:
 * the conflicting edit is one person correcting an open date on two devices, not two people
 * disagreeing.
 *
 * Nothing derived is persisted — not the 5/24 count, not a reminder, not a recommendation. They are
 * all pure functions of the accounts in `src/core`, recomputed per request. A reminders table would
 * be a second source of truth that drifts the moment someone fixes a typo in a date, and the
 * derived values are microseconds to recompute over a few dozen rows.
 *
 * What is stored and cannot be recomputed: the accounts themselves, which reminder ids the user has
 * dismissed, and the credentials. Nothing here can move money — see the header of `core/model.ts`
 * — so the worst case for this file is embarrassing rather than ruinous. It is still chmod 600 and
 * the password hashes are still scrypt.
 */

import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type {
  BankAccount,
  CardAccount,
  Inquiry,
  Player,
  PlayerState,
  User,
} from '../core/model.ts';

export interface StoredUser extends User {
  passwordHash: string;
}

export interface Device {
  id: string;
  userId: string;
  pushToken: string;
  platform: 'ios' | 'android' | 'web';
  createdAt: string;
  /** Cleared when Expo tells us the token is dead, so a broken device stops being retried. */
  failedAt: string | null;
}

/** A row as the sync endpoint hands it over: the record, or a tombstone. */
export interface SyncRow<T> {
  id: string;
  updatedAt: string;
  deleted: boolean;
  record: T | null;
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const isNew = path === ':memory:' || !existsSync(path);

    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();

    if (path !== ':memory:') {
      try {
        // Password hashes and every user's financial history. Other accounts on the machine have
        // no business reading it.
        chmodSync(path, 0o600);
      } catch {
        /* A filesystem without permissions is not worth failing to start over. */
      }
      if (isNew) this.log('info', 'created a new database');
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        -- Lowercased on the way in. Unique so a second registration is a clear 409 rather than two
        -- accounts one letter apart that the user cannot tell between.
        email         TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at    TEXT NOT NULL
      );

      -- Sessions, not JWTs. A stolen JWT is valid until it expires and there is nothing to be done
      -- about it; a row can be deleted. The cost is a lookup per request, which for a personal
      -- server is free.
      --
      -- The token itself is never stored — only its SHA-256 — so a leaked database does not hand
      -- over live sessions.
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

      -- The flowchart's "2+ player mode" as a first-class row. A couple churning together runs two
      -- separate rule states while sharing one login, one set of reminders and one referral
      -- strategy; a second user account would break all three.
      CREATE TABLE IF NOT EXISTS players (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        is_primary INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS players_user ON players (user_id);

      -- Denormalised on write: card_name, issuer, annual_fee_cents and counts_524 are copied from
      -- the catalog at entry rather than read through card_id at display time. The catalog is a
      -- snapshot of an ever-changing internet; an account opened in 2023 is a fact. card_id is a
      -- link for the recommender to follow and it is allowed to dangle.
      CREATE TABLE IF NOT EXISTS card_accounts (
        id                    TEXT PRIMARY KEY,
        player_id             TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        card_id               TEXT,
        card_name             TEXT NOT NULL,
        issuer                TEXT NOT NULL,
        product_type          TEXT NOT NULL,
        status                TEXT NOT NULL,
        applied_at            TEXT,
        opened_at             TEXT,
        closed_at             TEXT,
        annual_fee_cents      INTEGER NOT NULL DEFAULT 0,
        annual_fee_waived     INTEGER NOT NULL DEFAULT 0,
        next_annual_fee_at    TEXT,
        -- The whole EarnedBonus, or null. A JSON column because it is read and written as one
        -- thing and never queried by its parts.
        bonus                 TEXT,
        counts_524            INTEGER NOT NULL DEFAULT 1,
        authorized_user       INTEGER NOT NULL DEFAULT 0,
        last_used_at          TEXT,
        notes                 TEXT NOT NULL DEFAULT '',
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL,
        deleted_at            TEXT
      );
      CREATE INDEX IF NOT EXISTS card_accounts_player ON card_accounts (player_id, deleted_at);
      CREATE INDEX IF NOT EXISTS card_accounts_updated ON card_accounts (updated_at);

      CREATE TABLE IF NOT EXISTS bank_accounts (
        id                  TEXT PRIMARY KEY,
        player_id           TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        offer_id            TEXT,
        bank_name           TEXT NOT NULL,
        account_type        TEXT NOT NULL,
        status              TEXT NOT NULL,
        opened_at           TEXT,
        closed_at           TEXT,
        bonus_cents         INTEGER NOT NULL DEFAULT 0,
        requirements        TEXT NOT NULL DEFAULT '{}',
        requirements_met_at TEXT,
        bonus_posted_at     TEXT,
        close_not_before_at TEXT,
        monthly_fee_cents   INTEGER NOT NULL DEFAULT 0,
        fee_waiver_note     TEXT NOT NULL DEFAULT '',
        notes               TEXT NOT NULL DEFAULT '',
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        deleted_at          TEXT
      );
      CREATE INDEX IF NOT EXISTS bank_accounts_player ON bank_accounts (player_id, deleted_at);
      CREATE INDEX IF NOT EXISTS bank_accounts_updated ON bank_accounts (updated_at);

      CREATE TABLE IF NOT EXISTS inquiries (
        id              TEXT PRIMARY KEY,
        player_id       TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        bureau          TEXT NOT NULL,
        issuer          TEXT NOT NULL,
        at              TEXT NOT NULL,
        card_account_id TEXT,
        notes           TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        deleted_at      TEXT
      );
      CREATE INDEX IF NOT EXISTS inquiries_player ON inquiries (player_id, deleted_at);
      CREATE INDEX IF NOT EXISTS inquiries_updated ON inquiries (updated_at);

      -- Reminders are derived, so the only thing worth storing about them is which ones the user
      -- has waved away. The id folds in the due date, so moving a deadline resurfaces the reminder
      -- rather than leaving it silently dismissed.
      CREATE TABLE IF NOT EXISTS dismissed_reminders (
        player_id   TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        reminder_id TEXT NOT NULL,
        at          TEXT NOT NULL,
        PRIMARY KEY (player_id, reminder_id)
      );

      CREATE TABLE IF NOT EXISTS devices (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        push_token TEXT NOT NULL UNIQUE,
        platform   TEXT NOT NULL,
        created_at TEXT NOT NULL,
        failed_at  TEXT
      );
      CREATE INDEX IF NOT EXISTS devices_user ON devices (user_id);

      -- What has already been pushed, so a daily job that runs twice does not notify twice. Keyed
      -- by the reminder's own content-addressed id, which is what makes that work.
      CREATE TABLE IF NOT EXISTS sent_notifications (
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reminder_id TEXT NOT NULL,
        sent_at     TEXT NOT NULL,
        PRIMARY KEY (user_id, reminder_id)
      );

      CREATE TABLE IF NOT EXISTS logs (
        at      INTEGER NOT NULL,
        level   TEXT NOT NULL,
        message TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS logs_at ON logs (at DESC);
    `);
  }

  close(): void {
    this.db.close();
  }

  // ---- settings ----------------------------------------------------------

  allSettings(): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as Array<{
      key: string;
      value: string;
    }>;
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  setSetting(key: string, value: string | null): void {
    if (value === null) {
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
      return;
    }
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?')
      .run(key, value, value);
  }

  // ---- logs -------------------------------------------------------------

  log(level: 'info' | 'warn' | 'error', message: string): void {
    this.db.prepare('INSERT INTO logs (at, level, message) VALUES (?, ?, ?)').run(Date.now(), level, message);
    // Kept small on purpose: this is a diagnostic tail, not an audit trail, and an unbounded log
    // table in the same file as the data is how a personal server runs out of disk.
    this.db.prepare('DELETE FROM logs WHERE at < ?').run(Date.now() - 30 * 86_400_000);
  }

  recentLogs(limit = 200): Array<{ at: number; level: string; message: string }> {
    return this.db.prepare('SELECT at, level, message FROM logs ORDER BY at DESC LIMIT ?').all(limit) as Array<{
      at: number;
      level: string;
      message: string;
    }>;
  }

  // ---- users and sessions ----------------------------------------------

  createUser(user: StoredUser): void {
    this.db
      .prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(user.id, user.email, user.passwordHash, user.createdAt);
  }

  /**
   * Replaces a password hash and drops every session for that user.
   *
   * The two go together. A password change that leaves old sessions alive does not achieve the
   * thing people change passwords for — and the device doing the changing gets a fresh session
   * back, so the only party logged out is whoever the user was worried about.
   */
  updatePasswordHash(userId: string, passwordHash: string): void {
    this.transaction(() => {
      this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    });
  }

  userByEmail(email: string): StoredUser | null {
    const row = this.db
      .prepare('SELECT id, email, password_hash, created_at FROM users WHERE email = ?')
      .get(email.trim().toLowerCase()) as
      | { id: string; email: string; password_hash: string; created_at: string }
      | undefined;
    return row === undefined
      ? null
      : { id: row.id, email: row.email, passwordHash: row.password_hash, createdAt: row.created_at };
  }

  userById(id: string): User | null {
    const row = this.db.prepare('SELECT id, email, created_at FROM users WHERE id = ?').get(id) as
      | { id: string; email: string; created_at: string }
      | undefined;
    return row === undefined ? null : { id: row.id, email: row.email, createdAt: row.created_at };
  }

  userCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }

  createSession(tokenHash: string, userId: string, expiresAt: number): void {
    this.db
      .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(tokenHash, userId, Date.now(), expiresAt);
  }

  /** The user a session belongs to, or null. Expired rows are cleaned up as they are found. */
  userForSession(tokenHash: string): User | null {
    const row = this.db.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?').get(tokenHash) as
      | { user_id: string; expires_at: number }
      | undefined;
    if (row === undefined) return null;
    if (row.expires_at < Date.now()) {
      this.deleteSession(tokenHash);
      return null;
    }
    return this.userById(row.user_id);
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  deleteExpiredSessions(): number {
    return this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()).changes as number;
  }

  // ---- players ---------------------------------------------------------

  createPlayer(player: Player, updatedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO players (id, user_id, name, is_primary, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(player.id, player.userId, player.name, player.primary ? 1 : 0, player.createdAt, updatedAt);
  }

  players(userId: string): Player[] {
    const rows = this.db
      .prepare(
        `SELECT id, user_id, name, is_primary, created_at FROM players
         WHERE user_id = ? AND deleted_at IS NULL ORDER BY is_primary DESC, created_at ASC`,
      )
      .all(userId) as Array<{
      id: string;
      user_id: string;
      name: string;
      is_primary: number;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      name: row.name,
      primary: row.is_primary === 1,
      createdAt: row.created_at,
    }));
  }

  /**
   * The player, but only if this user owns it.
   *
   * Every handler that takes a `playerId` goes through here. Ownership checked in the query rather
   * than after it, because a "load then compare" is the shape that eventually ships with the
   * comparison missing — and the thing on the other side is somebody's financial history.
   */
  playerFor(userId: string, playerId: string): Player | null {
    return this.players(userId).find((player) => player.id === playerId) ?? null;
  }

  renamePlayer(userId: string, playerId: string, name: string, updatedAt: string): boolean {
    return (
      (this.db
        .prepare('UPDATE players SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?')
        .run(name, updatedAt, playerId, userId).changes as number) > 0
    );
  }

  deletePlayer(userId: string, playerId: string, at: string): boolean {
    // Soft, and cascading by hand: the children have to be tombstoned too, or a client that synced
    // them earlier keeps showing cards belonging to a player that no longer exists.
    const changed = this.db
      .prepare('UPDATE players SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
      .run(at, at, playerId, userId).changes as number;
    if (changed === 0) return false;
    for (const table of ['card_accounts', 'bank_accounts', 'inquiries']) {
      this.db
        .prepare(`UPDATE ${table} SET deleted_at = ?, updated_at = ? WHERE player_id = ? AND deleted_at IS NULL`)
        .run(at, at, playerId);
    }
    return true;
  }

  // ---- card accounts --------------------------------------------------

  upsertCard(account: CardAccount): void {
    this.db
      .prepare(
        `INSERT INTO card_accounts (
           id, player_id, card_id, card_name, issuer, product_type, status,
           applied_at, opened_at, closed_at, annual_fee_cents, annual_fee_waived,
           next_annual_fee_at, bonus, counts_524, authorized_user, last_used_at, notes,
           created_at, updated_at, deleted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET
           card_id = excluded.card_id, card_name = excluded.card_name, issuer = excluded.issuer,
           product_type = excluded.product_type, status = excluded.status,
           applied_at = excluded.applied_at, opened_at = excluded.opened_at, closed_at = excluded.closed_at,
           annual_fee_cents = excluded.annual_fee_cents, annual_fee_waived = excluded.annual_fee_waived,
           next_annual_fee_at = excluded.next_annual_fee_at, bonus = excluded.bonus,
           counts_524 = excluded.counts_524, authorized_user = excluded.authorized_user,
           last_used_at = excluded.last_used_at, notes = excluded.notes,
           updated_at = excluded.updated_at, deleted_at = NULL`,
      )
      .run(
        account.id,
        account.playerId,
        account.cardId,
        account.cardName,
        account.issuer,
        account.productType,
        account.status,
        account.appliedAt,
        account.openedAt,
        account.closedAt,
        account.annualFeeCents,
        account.annualFeeWaivedFirstYear ? 1 : 0,
        account.nextAnnualFeeAt,
        account.bonus === null ? null : JSON.stringify(account.bonus),
        account.counts524 ? 1 : 0,
        account.authorizedUser ? 1 : 0,
        account.lastUsedAt,
        account.notes,
        account.createdAt,
        account.updatedAt,
      );
  }

  cards(playerId: string): CardAccount[] {
    const rows = this.db
      .prepare('SELECT * FROM card_accounts WHERE player_id = ? AND deleted_at IS NULL ORDER BY opened_at ASC')
      .all(playerId) as Array<Record<string, unknown>>;
    return rows.map(toCardAccount);
  }

  card(playerId: string, id: string): CardAccount | null {
    const row = this.db
      .prepare('SELECT * FROM card_accounts WHERE id = ? AND player_id = ? AND deleted_at IS NULL')
      .get(id, playerId) as Record<string, unknown> | undefined;
    return row === undefined ? null : toCardAccount(row);
  }

  deleteCard(playerId: string, id: string, at: string): boolean {
    return (
      (this.db
        .prepare(
          'UPDATE card_accounts SET deleted_at = ?, updated_at = ? WHERE id = ? AND player_id = ? AND deleted_at IS NULL',
        )
        .run(at, at, id, playerId).changes as number) > 0
    );
  }

  // ---- bank accounts -------------------------------------------------

  upsertBank(account: BankAccount): void {
    this.db
      .prepare(
        `INSERT INTO bank_accounts (
           id, player_id, offer_id, bank_name, account_type, status, opened_at, closed_at,
           bonus_cents, requirements, requirements_met_at, bonus_posted_at, close_not_before_at,
           monthly_fee_cents, fee_waiver_note, notes, created_at, updated_at, deleted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET
           offer_id = excluded.offer_id, bank_name = excluded.bank_name,
           account_type = excluded.account_type, status = excluded.status,
           opened_at = excluded.opened_at, closed_at = excluded.closed_at,
           bonus_cents = excluded.bonus_cents, requirements = excluded.requirements,
           requirements_met_at = excluded.requirements_met_at, bonus_posted_at = excluded.bonus_posted_at,
           close_not_before_at = excluded.close_not_before_at, monthly_fee_cents = excluded.monthly_fee_cents,
           fee_waiver_note = excluded.fee_waiver_note, notes = excluded.notes,
           updated_at = excluded.updated_at, deleted_at = NULL`,
      )
      .run(
        account.id,
        account.playerId,
        account.offerId,
        account.bankName,
        account.accountType,
        account.status,
        account.openedAt,
        account.closedAt,
        account.bonusCents,
        JSON.stringify(account.requirements),
        account.requirementsMetAt,
        account.bonusPostedAt,
        account.closeNotBeforeAt,
        account.monthlyFeeCents,
        account.feeWaiverNote,
        account.notes,
        account.createdAt,
        account.updatedAt,
      );
  }

  banks(playerId: string): BankAccount[] {
    const rows = this.db
      .prepare('SELECT * FROM bank_accounts WHERE player_id = ? AND deleted_at IS NULL ORDER BY opened_at ASC')
      .all(playerId) as Array<Record<string, unknown>>;
    return rows.map(toBankAccount);
  }

  bank(playerId: string, id: string): BankAccount | null {
    const row = this.db
      .prepare('SELECT * FROM bank_accounts WHERE id = ? AND player_id = ? AND deleted_at IS NULL')
      .get(id, playerId) as Record<string, unknown> | undefined;
    return row === undefined ? null : toBankAccount(row);
  }

  deleteBank(playerId: string, id: string, at: string): boolean {
    return (
      (this.db
        .prepare(
          'UPDATE bank_accounts SET deleted_at = ?, updated_at = ? WHERE id = ? AND player_id = ? AND deleted_at IS NULL',
        )
        .run(at, at, id, playerId).changes as number) > 0
    );
  }

  // ---- inquiries -----------------------------------------------------

  upsertInquiry(inquiry: Inquiry, timestamps: { createdAt: string; updatedAt: string }): void {
    this.db
      .prepare(
        `INSERT INTO inquiries (id, player_id, bureau, issuer, at, card_account_id, notes, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET
           bureau = excluded.bureau, issuer = excluded.issuer, at = excluded.at,
           card_account_id = excluded.card_account_id, notes = excluded.notes,
           updated_at = excluded.updated_at, deleted_at = NULL`,
      )
      .run(
        inquiry.id,
        inquiry.playerId,
        inquiry.bureau,
        inquiry.issuer,
        inquiry.at,
        inquiry.cardAccountId,
        inquiry.notes,
        timestamps.createdAt,
        timestamps.updatedAt,
      );
  }

  inquiries(playerId: string): Inquiry[] {
    const rows = this.db
      .prepare('SELECT * FROM inquiries WHERE player_id = ? AND deleted_at IS NULL ORDER BY at DESC')
      .all(playerId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as string,
      playerId: row.player_id as string,
      bureau: row.bureau as Inquiry['bureau'],
      issuer: row.issuer as Inquiry['issuer'],
      at: row.at as string,
      cardAccountId: (row.card_account_id as string | null) ?? null,
      notes: (row.notes as string) ?? '',
    }));
  }

  deleteInquiry(playerId: string, id: string, at: string): boolean {
    return (
      (this.db
        .prepare(
          'UPDATE inquiries SET deleted_at = ?, updated_at = ? WHERE id = ? AND player_id = ? AND deleted_at IS NULL',
        )
        .run(at, at, id, playerId).changes as number) > 0
    );
  }

  // ---- the shape every rule takes -----------------------------------

  playerState(player: Player): PlayerState {
    return {
      player,
      cards: this.cards(player.id),
      banks: this.banks(player.id),
      inquiries: this.inquiries(player.id),
    };
  }

  // ---- dismissed reminders ------------------------------------------

  dismissReminder(playerId: string, reminderId: string, at: string): void {
    this.db
      .prepare(
        `INSERT INTO dismissed_reminders (player_id, reminder_id, at) VALUES (?, ?, ?)
         ON CONFLICT(player_id, reminder_id) DO NOTHING`,
      )
      .run(playerId, reminderId, at);
  }

  undismissReminder(playerId: string, reminderId: string): void {
    this.db
      .prepare('DELETE FROM dismissed_reminders WHERE player_id = ? AND reminder_id = ?')
      .run(playerId, reminderId);
  }

  dismissed(playerId: string): Set<string> {
    const rows = this.db
      .prepare('SELECT reminder_id FROM dismissed_reminders WHERE player_id = ?')
      .all(playerId) as Array<{ reminder_id: string }>;
    return new Set(rows.map((row) => row.reminder_id));
  }

  // ---- devices and notifications ------------------------------------

  registerDevice(device: Device): void {
    this.db
      .prepare(
        `INSERT INTO devices (id, user_id, push_token, platform, created_at, failed_at)
         VALUES (?, ?, ?, ?, ?, NULL)
         ON CONFLICT(push_token) DO UPDATE SET
           user_id = excluded.user_id, platform = excluded.platform, failed_at = NULL`,
      )
      .run(device.id, device.userId, device.pushToken, device.platform, device.createdAt);
  }

  devices(userId: string): Device[] {
    const rows = this.db
      .prepare('SELECT * FROM devices WHERE user_id = ? AND failed_at IS NULL')
      .all(userId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as string,
      userId: row.user_id as string,
      pushToken: row.push_token as string,
      platform: row.platform as Device['platform'],
      createdAt: row.created_at as string,
      failedAt: (row.failed_at as string | null) ?? null,
    }));
  }

  markDeviceFailed(pushToken: string, at: string): void {
    this.db.prepare('UPDATE devices SET failed_at = ? WHERE push_token = ?').run(at, pushToken);
  }

  deleteDevice(userId: string, pushToken: string): boolean {
    return (
      (this.db.prepare('DELETE FROM devices WHERE user_id = ? AND push_token = ?').run(userId, pushToken)
        .changes as number) > 0
    );
  }

  /** Whether this exact reminder has already been pushed. See the table comment. */
  alreadyNotified(userId: string, reminderId: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 FROM sent_notifications WHERE user_id = ? AND reminder_id = ?')
        .get(userId, reminderId) !== undefined
    );
  }

  recordNotified(userId: string, reminderId: string, at: string): void {
    this.db
      .prepare(
        `INSERT INTO sent_notifications (user_id, reminder_id, sent_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id, reminder_id) DO NOTHING`,
      )
      .run(userId, reminderId, at);
  }

  userIdsWithDevices(): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT user_id FROM devices WHERE failed_at IS NULL')
      .all() as Array<{ user_id: string }>;
    return rows.map((row) => row.user_id);
  }

  // ---- sync ---------------------------------------------------------

  /**
   * Everything belonging to this user that changed at or after `since`, tombstones included.
   *
   * Scoped by a join through `players` rather than by trusting a client-supplied player id, so a
   * sync request cannot reach another account's rows however it is crafted.
   *
   * `>=` and not `>`: the boundary row is returned again rather than risking its omission. A client
   * that re-applies an identical row is idempotent; one that misses a row is silently wrong until
   * the next edit to that row, which may be never.
   */
  changedSince(userId: string, since: string): {
    players: Array<SyncRow<Player>>;
    cards: Array<SyncRow<CardAccount>>;
    banks: Array<SyncRow<BankAccount>>;
    inquiries: Array<SyncRow<Inquiry>>;
  } {
    const playerRows = this.db
      .prepare(
        `SELECT id, user_id, name, is_primary, created_at, updated_at, deleted_at FROM players
         WHERE user_id = ? AND updated_at >= ?`,
      )
      .all(userId, since) as Array<Record<string, unknown>>;

    const forTable = (table: string): Array<Record<string, unknown>> =>
      this.db
        .prepare(
          `SELECT t.* FROM ${table} t
             JOIN players p ON p.id = t.player_id
            WHERE p.user_id = ? AND t.updated_at >= ?`,
        )
        .all(userId, since) as Array<Record<string, unknown>>;

    return {
      players: playerRows.map((row) => ({
        id: row.id as string,
        updatedAt: row.updated_at as string,
        deleted: row.deleted_at !== null,
        record:
          row.deleted_at !== null
            ? null
            : {
                id: row.id as string,
                userId: row.user_id as string,
                name: row.name as string,
                primary: row.is_primary === 1,
                createdAt: row.created_at as string,
              },
      })),
      cards: forTable('card_accounts').map((row) => ({
        id: row.id as string,
        updatedAt: row.updated_at as string,
        deleted: row.deleted_at !== null,
        record: row.deleted_at !== null ? null : toCardAccount(row),
      })),
      banks: forTable('bank_accounts').map((row) => ({
        id: row.id as string,
        updatedAt: row.updated_at as string,
        deleted: row.deleted_at !== null,
        record: row.deleted_at !== null ? null : toBankAccount(row),
      })),
      inquiries: forTable('inquiries').map((row) => ({
        id: row.id as string,
        updatedAt: row.updated_at as string,
        deleted: row.deleted_at !== null,
        record:
          row.deleted_at !== null
            ? null
            : {
                id: row.id as string,
                playerId: row.player_id as string,
                bureau: row.bureau as Inquiry['bureau'],
                issuer: row.issuer as Inquiry['issuer'],
                at: row.at as string,
                cardAccountId: (row.card_account_id as string | null) ?? null,
                notes: (row.notes as string) ?? '',
              },
      })),
    };
  }

  /**
   * The `updated_at` a stored row carries, or null if there is no such row.
   *
   * The whole of last-write-wins: an upload only lands if it is newer than what is here.
   */
  updatedAtOf(table: 'card_accounts' | 'bank_accounts' | 'inquiries' | 'players', id: string): string | null {
    const row = this.db.prepare(`SELECT updated_at FROM ${table} WHERE id = ?`).get(id) as
      | { updated_at: string }
      | undefined;
    return row?.updated_at ?? null;
  }

  /** Runs `work` in a transaction, so a partial sync upload cannot land. */
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  stats(): Record<string, number> {
    const count = (sql: string): number => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      users: count('SELECT COUNT(*) AS n FROM users'),
      players: count('SELECT COUNT(*) AS n FROM players WHERE deleted_at IS NULL'),
      cardAccounts: count('SELECT COUNT(*) AS n FROM card_accounts WHERE deleted_at IS NULL'),
      bankAccounts: count('SELECT COUNT(*) AS n FROM bank_accounts WHERE deleted_at IS NULL'),
      sessions: count('SELECT COUNT(*) AS n FROM sessions'),
      devices: count('SELECT COUNT(*) AS n FROM devices WHERE failed_at IS NULL'),
    };
  }
}

// ---- row mapping ----------------------------------------------------

function toCardAccount(row: Record<string, unknown>): CardAccount {
  return {
    id: row.id as string,
    playerId: row.player_id as string,
    cardId: (row.card_id as string | null) ?? null,
    cardName: row.card_name as string,
    issuer: row.issuer as CardAccount['issuer'],
    productType: row.product_type as CardAccount['productType'],
    status: row.status as CardAccount['status'],
    appliedAt: (row.applied_at as string | null) ?? null,
    openedAt: (row.opened_at as string | null) ?? null,
    closedAt: (row.closed_at as string | null) ?? null,
    annualFeeCents: (row.annual_fee_cents as number) ?? 0,
    annualFeeWaivedFirstYear: row.annual_fee_waived === 1,
    nextAnnualFeeAt: (row.next_annual_fee_at as string | null) ?? null,
    bonus: parseJson<CardAccount['bonus']>(row.bonus) ?? null,
    counts524: row.counts_524 === 1,
    authorizedUser: row.authorized_user === 1,
    lastUsedAt: (row.last_used_at as string | null) ?? null,
    notes: (row.notes as string) ?? '',
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function toBankAccount(row: Record<string, unknown>): BankAccount {
  return {
    id: row.id as string,
    playerId: row.player_id as string,
    offerId: (row.offer_id as string | null) ?? null,
    bankName: row.bank_name as string,
    accountType: row.account_type as BankAccount['accountType'],
    status: row.status as BankAccount['status'],
    openedAt: (row.opened_at as string | null) ?? null,
    closedAt: (row.closed_at as string | null) ?? null,
    bonusCents: (row.bonus_cents as number) ?? 0,
    requirements: parseJson<BankAccount['requirements']>(row.requirements) ?? {
      directDepositCents: 0,
      directDepositCount: 0,
      minBalanceCents: 0,
      holdDays: 0,
      debitTransactions: 0,
    },
    requirementsMetAt: (row.requirements_met_at as string | null) ?? null,
    bonusPostedAt: (row.bonus_posted_at as string | null) ?? null,
    closeNotBeforeAt: (row.close_not_before_at as string | null) ?? null,
    monthlyFeeCents: (row.monthly_fee_cents as number) ?? 0,
    feeWaiverNote: (row.fee_waiver_note as string) ?? '',
    notes: (row.notes as string) ?? '',
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/** A JSON column, or null when it is empty or unreadable. Never throws into a request. */
function parseJson<T>(value: unknown): T | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
