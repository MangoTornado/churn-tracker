/**
 * Configuration, held in the database so it survives a redeploy, with the environment winning.
 *
 * The one trap worth naming, because it has bitten this pattern before: `??` is wrong for reading an
 * environment override. An empty string is neither null nor undefined, so a variable set to nothing
 * shadows the stored value permanently — and that is exactly what a Kamal secret left blank
 * becomes, since `.kamal/secrets` lists every optional secret and passes the unfilled ones through
 * as `""`. Hence `envOr`, which treats blank as absent.
 */

import type { Store } from './db.ts';

export interface Config {
  host: string;
  port: number;

  /**
   * Whether anyone can register.
   *
   * Off by default, which is the safe direction for a server that will sit on the public internet
   * behind a tunnel. Turn it on, register, turn it off — or leave it on and accept that anyone who
   * finds the host can make an account. There is no email verification to lean on.
   */
  openRegistration: boolean;

  /** How often to re-scrape Doctor of Credit, in hours. Zero disables it. */
  refreshEveryHours: number;

  /**
   * The hour, in UTC, at which to send reminder pushes. Once a day, one batch.
   *
   * A fixed hour rather than "every N hours" because a notification about an annual fee is not
   * urgent to the minute and is very annoying at 3am. Set it to the morning of whichever timezone
   * the user actually lives in.
   */
  notifyAtHourUtc: number;

  /** Turns pushes off entirely without unregistering devices. */
  notificationsEnabled: boolean;

  /**
   * Trust `X-Forwarded-For` for logging and rate limiting.
   *
   * On when behind kamal-proxy, which always sets it. Off by default: if nothing is in front, the
   * header is attacker-controlled and trusting it makes the per-address login limit trivially
   * bypassable.
   */
  trustProxy: boolean;
}

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8811,
  openRegistration: false,
  refreshEveryHours: 24,
  notifyAtHourUtc: 14,
  notificationsEnabled: true,
  trustProxy: false,
};

export class Settings {
  // Written out rather than a constructor parameter property: Node runs this TypeScript by
  // stripping the types, which rules out any syntax that would have to generate code.
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  read(): Config {
    const stored = this.store.allSettings();

    /** The environment wins, but only when it actually says something. See the header. */
    const value = (key: string, envKey: string): string | undefined => {
      const fromEnv = process.env[envKey]?.trim();
      return fromEnv ? fromEnv : stored[key];
    };

    return {
      host: value('server.host', 'CT_HOST') ?? DEFAULTS.host,
      port: int(value('server.port', 'CT_PORT'), DEFAULTS.port),
      openRegistration: bool(value('auth.openRegistration', 'CT_OPEN_REGISTRATION'), DEFAULTS.openRegistration),
      refreshEveryHours: int(value('refresh.everyHours', 'CT_REFRESH_HOURS'), DEFAULTS.refreshEveryHours),
      notifyAtHourUtc: clampHour(int(value('notify.hourUtc', 'CT_NOTIFY_HOUR_UTC'), DEFAULTS.notifyAtHourUtc)),
      notificationsEnabled: bool(value('notify.enabled', 'CT_NOTIFICATIONS'), DEFAULTS.notificationsEnabled),
      trustProxy: bool(value('server.trustProxy', 'CT_TRUST_PROXY'), DEFAULTS.trustProxy),
    };
  }

  update(patch: Record<string, string | null>): void {
    for (const [key, value] of Object.entries(patch)) {
      if (!WRITABLE.has(key)) continue;
      this.store.setSetting(key, value === null ? null : String(value).trim());
    }
  }
}

/**
 * Which settings keys may be written.
 *
 * An allowlist, because the alternative is an endpoint that writes anything into the settings
 * table — and `auth.openRegistration` is in that table.
 */
const WRITABLE = new Set([
  'server.host',
  'server.port',
  'server.trustProxy',
  'auth.openRegistration',
  'refresh.everyHours',
  'notify.hourUtc',
  'notify.enabled',
]);

function bool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  return raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'yes';
}

function int(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampHour(hour: number): number {
  // A misconfigured hour would otherwise mean the daily job never matches and no reminder is ever
  // sent — a silent failure, which is the worst kind for a notification.
  return Math.min(23, Math.max(0, hour));
}
