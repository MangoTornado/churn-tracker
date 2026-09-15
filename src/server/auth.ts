/**
 * Accounts, passwords and sessions, with no dependencies.
 *
 * Rolling your own auth is usually the wrong answer. It is the right one here for a specific
 * reason: the whole server is zero-dependency by design, and the auth surface this needs is small
 * and entirely made of primitives `node:crypto` already ships — scrypt for passwords, random bytes
 * for tokens, SHA-256 to store them, `timingSafeEqual` to compare. There is no OAuth, no password
 * reset email, no MFA. Adding a framework to get those would be adding a supply chain to the one
 * file where a supply chain attack pays best.
 *
 * The choices worth defending:
 *
 * **scrypt, not SHA-256 and not bcrypt.** It is in the standard library, it is memory-hard, and the
 * parameters below are OWASP's current floor (N=2^17, r=8, p=1 — about 128 MB and ~100ms). bcrypt
 * would need a native module.
 *
 * **Opaque session tokens, hashed at rest.** A stolen JWT is valid until it expires and nothing can
 * be done about it; a session row can be deleted. Only the SHA-256 of the token is stored, so a
 * leaked database hands over no live sessions. Hashing needs no salt here because the input is 32
 * bytes of CSPRNG output, not a guessable secret.
 *
 * **Login timing does not reveal whether an email is registered.** A missing user still costs a
 * scrypt verification against a dummy hash. Without it, "is this person a customer" is readable
 * off the response time, and for a financial app the answer is worth knowing.
 */

import {
  randomBytes,
  createHash,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

import type { Player, User } from '../core/model.ts';
import { Store, type StoredUser } from './db.ts';

/**
 * `scrypt`, promised.
 *
 * Hand-written rather than `promisify`, whose types only describe the three-argument overload — so
 * passing the cost parameters compiled with an error while working perfectly at runtime. Since the
 * parameters are the entire point of using scrypt, an untyped call here is the wrong thing to leave
 * in place.
 */
function scrypt(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

/**
 * OWASP's current floor for scrypt. About 128 MB and ~100ms per verification.
 *
 * `maxmem` has to be raised explicitly: Node's default is 32 MB and N=2^17 needs roughly four
 * times that, so leaving it alone makes every hash throw rather than run slowly — which is a
 * failure mode that only appears once real parameters are used.
 */
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, keyLength: 64, maxmem: 256 * 1024 * 1024 };

const SESSION_TTL_MS = 90 * 86_400_000;

/** Long, because the alternative is people re-entering a password on a phone every week. */
export const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;

export class AuthError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT.keyLength, SCRYPT);
  // Self-describing, so the parameters can be raised later without invalidating existing hashes.
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, n, r, p, salt, expected] = parts;
  const expectedBytes = Buffer.from(expected, 'base64');

  let derived: Buffer;
  try {
    derived = await scrypt(password, Buffer.from(salt, 'base64'), expectedBytes.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: SCRYPT.maxmem,
    });
  } catch {
    // Unparseable parameters, or a cost so high it exceeds maxmem. Either way this is not a match,
    // and it must not take the request down.
    return false;
  }

  // Lengths must match before `timingSafeEqual`, which throws rather than returning false on a
  // mismatch — and a throw here would be an information leak of its own.
  return derived.length === expectedBytes.length && timingSafeEqual(derived, expectedBytes);
}

/**
 * A hash of a password nobody has, for the not-found path of login.
 *
 * Computed once at module load so that a login for an unknown address costs the same scrypt
 * verification as a real one. See the header.
 */
const DUMMY_HASH_PROMISE = hashPassword(randomBytes(32).toString('hex'));

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Password rules, kept to the one that matters.
 *
 * A length floor and nothing else — no character-class requirements, which NIST dropped years ago
 * because they push people towards `Password1!` and away from length. 12 rather than 8 because
 * there is no rate limit worth relying on here beyond scrypt's own cost.
 */
function assertUsablePassword(password: unknown): string {
  if (typeof password !== 'string' || password.length < 12) {
    throw new AuthError(400, 'password must be at least 12 characters');
  }
  if (password.length > 512) {
    // Not a strength rule: an unbounded password is an unbounded scrypt input, which is a cheap
    // way to make the server do 100ms of work per byte.
    throw new AuthError(400, 'password must be at most 512 characters');
  }
  return password;
}

/**
 * Email validation, deliberately shallow.
 *
 * Enough to reject a typo and to guarantee something storable and comparable. It is an account
 * identifier, not a delivery address — nothing is ever sent to it — so RFC 5322 pedantry would only
 * lock out addresses that work.
 */
function assertUsableEmail(email: unknown): string {
  if (typeof email !== 'string') throw new AuthError(400, 'email is required');
  const trimmed = email.trim().toLowerCase();
  if (trimmed.length < 3 || trimmed.length > 320 || !/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(trimmed)) {
    throw new AuthError(400, 'that does not look like an email address');
  }
  return trimmed;
}

export interface Session {
  token: string;
  expiresAt: number;
  user: User;
  players: Player[];
}

export class Auth {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /**
   * Creates an account, its first player, and a session.
   *
   * The player is created here rather than lazily because every screen in the app needs one, and
   * "no players yet" would be an empty state that exists for a fraction of a second and has to be
   * handled everywhere forever.
   */
  async register(input: { email?: unknown; password?: unknown; name?: unknown }): Promise<Session> {
    const email = assertUsableEmail(input.email);
    const password = assertUsablePassword(input.password);

    if (this.store.userByEmail(email) !== null) {
      // A plain 409. Hiding it behind a generic error would be pointless — registration reveals
      // the same thing by succeeding or not — and it would leave the user unable to work out why
      // they cannot sign up.
      throw new AuthError(409, 'that email is already registered');
    }

    const now = new Date().toISOString();
    const user: StoredUser = {
      id: crypto.randomUUID(),
      email,
      passwordHash: await hashPassword(password),
      createdAt: now,
    };

    const name = typeof input.name === 'string' && input.name.trim() !== '' ? input.name.trim() : 'Me';
    const player: Player = {
      id: crypto.randomUUID(),
      userId: user.id,
      name: name.slice(0, 80),
      primary: true,
      createdAt: now,
    };

    this.store.transaction(() => {
      this.store.createUser(user);
      this.store.createPlayer(player, now);
    });
    this.store.log('info', `registered ${email}`);

    return this.issue(user);
  }

  async login(input: { email?: unknown; password?: unknown }): Promise<Session> {
    const email = assertUsableEmail(input.email);
    const password = typeof input.password === 'string' ? input.password : '';

    const stored = this.store.userByEmail(email);

    // The unknown-address path still pays for a verification, so response time says nothing about
    // whether the account exists. See the header.
    const matches = await verifyPassword(password, stored?.passwordHash ?? (await DUMMY_HASH_PROMISE));

    if (stored === null || !matches) {
      this.store.log('warn', `failed login for ${email}`);
      throw new AuthError(401, 'wrong email or password');
    }

    return this.issue(stored);
  }

  private issue(user: StoredUser | User): Session {
    const token = newToken();
    const expiresAt = Date.now() + SESSION_TTL_MS;
    this.store.createSession(hashToken(token), user.id, expiresAt);
    return {
      token,
      expiresAt,
      user: { id: user.id, email: user.email, createdAt: user.createdAt },
      players: this.store.players(user.id),
    };
  }

  /** The user a bearer token belongs to, or null. */
  authenticate(token: string | null): User | null {
    if (token === null || token === '') return null;
    return this.store.userForSession(hashToken(token));
  }

  logout(token: string | null): void {
    if (token === null || token === '') return;
    this.store.deleteSession(hashToken(token));
  }

  /**
   * Changes a password and issues a fresh session.
   *
   * `updatePasswordHash` deletes every existing session, including the one that made this request —
   * so a new token has to come back or the caller is signed out by its own success.
   */
  async changePassword(user: User, current: unknown, next: unknown): Promise<Session> {
    const stored = this.store.userByEmail(user.email);
    if (stored === null) throw new AuthError(401, 'unauthorised');

    const ok = await verifyPassword(typeof current === 'string' ? current : '', stored.passwordHash);
    if (!ok) throw new AuthError(401, 'current password is wrong');

    const password = assertUsablePassword(next);
    this.store.updatePasswordHash(stored.id, await hashPassword(password));
    this.store.log('info', `password changed for ${stored.email}`);

    return this.issue(stored);
  }
}

/** `Authorization: Bearer <token>`, or null. */
export function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match === null ? null : match[1].trim();
}
