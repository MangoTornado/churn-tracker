import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  addDays,
  addMonths,
  daysBetween,
  earliest,
  isIsoDate,
  latest,
  monthsBetween,
  relative,
  withinDays,
  withinMonths,
} from '../src/core/dates.ts';

// ---- the timezone trap ----------------------------------------------------

test('dates do not shift with the local timezone', () => {
  // The whole reason `dates.ts` avoids `new Date(y, m, d)`. With TZ=America/Los_Angeles a
  // local-midnight constructor puts 2024-03-01 at 08:00 UTC the same day, but round-tripping
  // through `toISOString` on a local-constructed date lands on 2024-02-29.
  assert.equal(addDays('2024-03-01', 0), '2024-03-01');
  assert.equal(addDays('2024-03-01', -1), '2024-02-29');
  assert.equal(addMonths('2024-01-01', 1), '2024-02-01');
});

// ---- month arithmetic clamps ---------------------------------------------

test('adding a month to a 31st clamps instead of overflowing', () => {
  // `Date.UTC(2024, 1, 31)` is March 2nd. Every annual-fee reminder for a card opened on a 31st
  // would land in the wrong month.
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29', 'leap February');
  assert.equal(addMonths('2023-01-31', 1), '2023-02-28', 'ordinary February');
  assert.equal(addMonths('2024-01-31', 3), '2024-04-30', 'April has 30 days');
  assert.equal(addMonths('2024-03-31', 1), '2024-04-30');
});

test('adding twelve months lands on the anniversary', () => {
  assert.equal(addMonths('2025-06-15', 12), '2026-06-15');
  assert.equal(addMonths('2024-02-29', 12), '2025-02-28', 'a leap day has no anniversary');
  assert.equal(addMonths('2025-06-15', 24), '2027-06-15');
});

test('subtracting months crosses the year boundary correctly', () => {
  // `%` keeps the sign of the dividend, so a naive implementation returns month -1 here.
  assert.equal(addMonths('2026-01-15', -1), '2025-12-15');
  assert.equal(addMonths('2026-01-15', -13), '2024-12-15');
  assert.equal(addMonths('2026-01-15', -24), '2024-01-15');
});

// ---- whole months, not averaged days -------------------------------------

test('monthsBetween counts whole elapsed months', () => {
  assert.equal(monthsBetween('2024-01-15', '2024-02-14'), 0, 'a day short of a month');
  assert.equal(monthsBetween('2024-01-15', '2024-02-15'), 1, 'exactly a month');
  assert.equal(monthsBetween('2024-01-15', '2026-01-14'), 23, 'a day short of 24 months');
  assert.equal(monthsBetween('2024-01-15', '2026-01-15'), 24, 'exactly 24 months');
});

test('monthsBetween is not days divided by thirty', () => {
  // 2024-01-31 to 2024-03-01 is 30 days but not a whole month, and a 30-day divisor would call it
  // one — which for 5/24 means a card ageing out of the window early.
  assert.equal(daysBetween('2024-01-31', '2024-03-01'), 30);
  assert.equal(monthsBetween('2024-01-31', '2024-03-01'), 1);
  assert.equal(monthsBetween('2024-01-31', '2024-02-29'), 0, 'February cannot reach the 31st');
});

// ---- the windows the rules are built on ----------------------------------

test('a card opened exactly 24 months ago has aged out of the window', () => {
  // The boundary that decides 5/24. People wait for the anniversary and apply on it, so the far
  // edge must be exclusive.
  assert.equal(withinMonths('2024-03-10', 24, '2026-03-10'), false, 'exactly 24 months: out');
  assert.equal(withinMonths('2024-03-11', 24, '2026-03-10'), true, 'a day inside: in');
  assert.equal(withinMonths('2024-03-09', 24, '2026-03-10'), false, 'a day outside: out');
});

test('withinMonths excludes the future', () => {
  // A planned account with a future open date must not count against the present.
  assert.equal(withinMonths('2026-10-01', 24, '2026-09-14'), false);
});

test('withinDays counts the day itself as inside the window', () => {
  assert.equal(withinDays('2026-09-14', 5, '2026-09-14'), true, 'today');
  assert.equal(withinDays('2026-09-10', 5, '2026-09-14'), true, 'four days ago');
  assert.equal(withinDays('2026-09-09', 5, '2026-09-14'), false, 'five days ago is clear');
  assert.equal(withinDays('2026-09-20', 5, '2026-09-14'), false, 'the future is not inside');
});

// ---- validation ----------------------------------------------------------

test('isIsoDate rejects dates that Date.UTC would silently roll over', () => {
  assert.equal(isIsoDate('2024-02-29'), true, 'a real leap day');
  assert.equal(isIsoDate('2023-02-29'), false, 'not a leap year');
  assert.equal(isIsoDate('2024-02-31'), false);
  assert.equal(isIsoDate('2024-13-01'), false);
  assert.equal(isIsoDate('2024-1-1'), false, 'unpadded');
  assert.equal(isIsoDate('2024-01-01T00:00:00Z'), false, 'not a timestamp');
  assert.equal(isIsoDate(20240101), false);
  assert.equal(isIsoDate(null), false);
});

// ---- helpers -------------------------------------------------------------

test('earliest and latest ignore nulls', () => {
  assert.equal(earliest(['2026-01-01', null, '2025-06-30']), '2025-06-30');
  assert.equal(latest(['2026-01-01', null, '2025-06-30']), '2026-01-01');
  assert.equal(earliest([null, null]), null);
  assert.equal(latest([]), null);
});

test('relative reads as a human would say it', () => {
  assert.equal(relative('2026-09-14', '2026-09-14'), 'today');
  assert.equal(relative('2026-09-14', '2026-09-15'), 'in 1 day');
  assert.equal(relative('2026-09-14', '2026-09-24'), 'in 10 days');
  assert.equal(relative('2026-09-14', '2026-12-14'), 'in 3 months');
  assert.equal(relative('2026-09-14', '2026-08-14'), '1 month ago');
  assert.equal(relative('2026-09-14', '2029-09-14'), 'in 3 years');
});
