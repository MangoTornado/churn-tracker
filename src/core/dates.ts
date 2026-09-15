/**
 * Date arithmetic on `YYYY-MM-DD` strings.
 *
 * Every churning rule is a date comparison, so a bug in here is a wrong answer everywhere and
 * silently — the app would confidently say "under 5/24" and the user would eat a denial. Hence a
 * whole file, and a test for each function.
 *
 * Two things are done deliberately and are worth not undoing:
 *
 * **UTC throughout.** `new Date('2024-03-01')` is midnight UTC, but `new Date(2024, 2, 1)` is
 * midnight *local*, and mixing them shifts dates by a day for anyone west of Greenwich. So
 * parsing goes through the numeric fields by hand and every constructor is `Date.UTC`. The user's
 * timezone has no business in "was this card opened within 24 months".
 *
 * **Month arithmetic clamps, it does not overflow.** `Date.UTC(2024, 1, 31)` silently becomes
 * March 2nd, which would put an annual-fee reminder in the wrong month for every card opened on a
 * 29th, 30th or 31st. `addMonths` clamps to the last day of the target month instead, which is
 * also what issuers do: a card opened January 31st has its anniversary statement in February.
 */

import type { IsoDate } from './model.ts';

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== 'string') return false;
  const parts = ISO.exec(value);
  if (!parts) return false;

  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);

  // The month is checked before the day because `daysInMonth` would otherwise be asked about
  // month 13 and answer for January of the next year — so `2024-13-01` looked valid, and
  // `toEpoch` then quietly turned it into 2025-01-01.
  if (month < 1 || month > 12) return false;
  // Rejects 2024-02-31, which `Date.UTC` would happily roll into March.
  return day >= 1 && day <= daysInMonth(year, month - 1);
}

/** Milliseconds since the epoch at UTC midnight. Throws rather than returning NaN to compare with. */
export function toEpoch(date: IsoDate): number {
  const parts = ISO.exec(date);
  if (!parts) throw new TypeError(`not a YYYY-MM-DD date: ${JSON.stringify(date)}`);
  return Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
}

export function fromEpoch(ms: number): IsoDate {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Today, in UTC. Passed explicitly through the rules rather than read inside them, so tests can lie. */
export function today(): IsoDate {
  return new Date().toISOString().slice(0, 10);
}

export function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return fromEpoch(toEpoch(date) + days * 86_400_000);
}

/**
 * The same day-of-month N months on, clamped to the end of a short month.
 *
 * So January 31st plus one month is February 29th in a leap year and February 28th otherwise —
 * never March 2nd. See the header.
 */
export function addMonths(date: IsoDate, months: number): IsoDate {
  const parts = ISO.exec(date);
  if (!parts) throw new TypeError(`not a YYYY-MM-DD date: ${JSON.stringify(date)}`);
  const year = Number(parts[1]);
  const monthIndex = Number(parts[2]) - 1 + months;
  const day = Number(parts[3]);

  const targetYear = year + Math.floor(monthIndex / 12);
  // `%` keeps the sign of the dividend, so a negative month index needs bringing back into range.
  const targetMonth = ((monthIndex % 12) + 12) % 12;

  return fromEpoch(
    Date.UTC(targetYear, targetMonth, Math.min(day, daysInMonth(targetYear, targetMonth))),
  );
}

/** Whole days from `from` to `to`. Negative when `to` is earlier. */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((toEpoch(to) - toEpoch(from)) / 86_400_000);
}

/**
 * Whole months elapsed from `from` to `to`, floored.
 *
 * "Whole" is the point, and it is why this is not `daysBetween / 30.44`. Every issuer rule is
 * phrased in months against a calendar — 24 months, 48 months, 6 months — and a card opened on
 * March 3rd 2023 falls out of a 24-month window on March 3rd 2025, not 730 days later. Rounding
 * days would put that boundary two days early and green-light an application that gets denied.
 */
export function monthsBetween(from: IsoDate, to: IsoDate): number {
  const start = ISO.exec(from);
  const end = ISO.exec(to);
  if (!start || !end) throw new TypeError(`not a YYYY-MM-DD date: ${JSON.stringify(!start ? from : to)}`);

  let months =
    (Number(end[1]) - Number(start[1])) * 12 + (Number(end[2]) - Number(start[2]));
  // The final month has not elapsed until the day-of-month comes round again.
  if (Number(end[3]) < Number(start[3])) months -= 1;
  return months;
}

/** Whether `date` falls in the last `months` months counting back from `asOf`, inclusive. */
export function withinMonths(date: IsoDate, months: number, asOf: IsoDate): boolean {
  const start = addMonths(asOf, -months);
  return toEpoch(date) > toEpoch(start) && toEpoch(date) <= toEpoch(asOf);
}

/** Whether `date` falls in the last `days` days counting back from `asOf`, inclusive. */
export function withinDays(date: IsoDate, days: number, asOf: IsoDate): boolean {
  const elapsed = daysBetween(date, asOf);
  return elapsed >= 0 && elapsed < days;
}

export function earliest(dates: Array<IsoDate | null>): IsoDate | null {
  const known = dates.filter((date): date is IsoDate => date !== null);
  if (known.length === 0) return null;
  return known.reduce((best, date) => (toEpoch(date) < toEpoch(best) ? date : best));
}

export function latest(dates: Array<IsoDate | null>): IsoDate | null {
  const known = dates.filter((date): date is IsoDate => date !== null);
  if (known.length === 0) return null;
  return known.reduce((best, date) => (toEpoch(date) > toEpoch(best) ? date : best));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * `20 Nov 2026`. For dates that appear inside a sentence.
 *
 * The rule and reminder messages are user-facing prose, and an ISO date in the middle of one reads
 * as a leaked internal value — especially next to a client that formats its own dates properly, which
 * is exactly how it looked in the app: "Sep 1" in the gutter and "Last used 2024-02-01" in the body
 * of the same row.
 *
 * Day-month-year rather than the American order, because it is unambiguous: `11/20` and `20/11` are
 * the same date to different readers, and `20 Nov` is only ever one thing.
 */
export function pretty(date: IsoDate): string {
  const parts = ISO.exec(date);
  if (!parts) return date;
  return `${Number(parts[3])} ${MONTHS[Number(parts[2]) - 1]} ${parts[1]}`;
}

/**
 * "in 3 months", "in 12 days", "today", "2 months ago".
 *
 * Coarse on purpose. A countdown to an annual fee is a decision about whether to act this week,
 * and "in 3 months" answers that better than "in 94 days" does.
 */
export function relative(from: IsoDate, to: IsoDate): string {
  const days = daysBetween(from, to);
  if (days === 0) return 'today';

  const ahead = days > 0;
  const magnitude = Math.abs(days);
  const phrase = (count: number, unit: string): string =>
    `${count} ${unit}${count === 1 ? '' : 's'}`;

  let text: string;
  if (magnitude === 1) text = '1 day';
  else if (magnitude < 31) text = phrase(magnitude, 'day');
  else {
    const months = Math.abs(monthsBetween(ahead ? from : to, ahead ? to : from));
    if (months < 1) text = phrase(magnitude, 'day');
    else if (months < 24) text = phrase(months, 'month');
    else text = phrase(Math.floor(months / 12), 'year');
  }

  return ahead ? `in ${text}` : `${text} ago`;
}
