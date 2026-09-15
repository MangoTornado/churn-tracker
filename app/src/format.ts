/**
 * Formatting. Small, and worth its own file because every one of these appears on four screens.
 *
 * The date formats are the interesting part. Nothing in this app shows a full ISO date to a user:
 * `2026-11-20` is what the server stores and `Nov 20` is what a person reads, and the difference is
 * the ledger's left gutter staying narrow enough to leave room for the content beside it.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Parses `YYYY-MM-DD` by hand rather than through `new Date`.
 *
 * `new Date('2026-11-20')` is midnight UTC and `getMonth()` is local, so in the Americas that
 * renders as November 19th. The server is careful about this for exactly the same reason; the app
 * has to be too or the two disagree by a day.
 */
function parts(date: string): { year: number; month: number; day: number } | null {
  const found = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (found === null) return null;
  return { year: Number(found[1]), month: Number(found[2]), day: Number(found[3]) };
}

/** `Nov 20`. For the gutter. */
export function shortDate(date: string | null): string {
  const it = date === null ? null : parts(date);
  if (it === null) return '—';
  return `${MONTHS[it.month - 1]} ${it.day}`;
}

/** `Nov 20 '26`. Where the year matters — an expiry two years out, an open date. */
export function shortDateWithYear(date: string | null): string {
  const it = date === null ? null : parts(date);
  if (it === null) return '—';
  return `${MONTHS[it.month - 1]} ${it.day} '${String(it.year).slice(2)}`;
}

/** `Nov '26`. The slot rail, where a day would be false precision and would not fit. */
export function monthYear(date: string | null): string {
  const it = date === null ? null : parts(date);
  if (it === null) return '—';
  return `${MONTHS[it.month - 1]} '${String(it.year).slice(2)}`;
}

/** `$795`, `$1,250`, `$12.50`. Whole dollars unless there are cents to show. */
export function money(cents: number): string {
  const whole = cents / 100;
  return `$${whole.toLocaleString('en-US', {
    minimumFractionDigits: whole % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/** `175k`, `1,500`. Points and miles, where the thousands are the unit people speak in. */
export function points(amount: number): string {
  if (amount >= 10_000) return `${Math.round(amount / 1000)}k`;
  return amount.toLocaleString('en-US');
}

/** A bonus as one token: `175k points`, `$500`. */
export function bonusText(amount: number, unit: 'points' | 'miles' | 'dollars'): string {
  if (unit === 'dollars') return money(amount * 100);
  return `${points(amount)} ${unit}`;
}

/**
 * The community's own notation for a rule: `5/24`, `2/90`, `1/8`.
 *
 * Derived from the rule id rather than stored, because the ids already carry it — `chase-5-24`,
 * `amex-2-in-90-days`, `citi-1-in-8-days`. Where a rule has no fraction (`once-per-lifetime`) this
 * returns null and the caller shows the title instead. Showing the notation matters: it is how these
 * rules are named everywhere else the user reads about them, so a chip saying `5/24` is recognisable
 * in a way "Five accounts in twenty-four months" is not.
 */
export function ruleNotation(ruleId: string): string | null {
  const slashed = /(\d+)-(\d+)$/.exec(ruleId);
  if (slashed !== null) return `${slashed[1]}/${slashed[2]}`;

  const inDays = /(\d+)-in-(\d+)-days$/.exec(ruleId);
  if (inDays !== null) return `${inDays[1]}/${inDays[2]}`;

  const months = /(\d+)-months?$/.exec(ruleId);
  if (months !== null) return `${months[1]}mo`;

  const inquiries = /(\d+)-inquiries-(\d+)-months$/.exec(ruleId);
  if (inquiries !== null) return `${inquiries[1]}/${inquiries[2]}`;

  return null;
}

/** Sentence case for a status or verdict slug: `product-changed` → `Product changed`. */
export function humanise(slug: string): string {
  const spaced = slug.replace(/-/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** How far along a minimum spend is, as a fraction of one. Clamped, so a 110% overspend reads full. */
export function spendProgress(spentCents: number, minSpendCents: number): number {
  if (minSpendCents <= 0) return 1;
  return Math.max(0, Math.min(1, spentCents / minSpendCents));
}
