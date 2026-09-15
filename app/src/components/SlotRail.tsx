/**
 * The 5/24 slot rail. The one thing this app should be remembered by.
 *
 * The obvious way to show a 5/24 count is a big number with a label under it. That is worse than it
 * looks, because the number alone answers half the question. "You are 3/24" does not tell you the
 * thing you actually opened the app for, which is *when the next slot comes back* — and at 5/24, the
 * number tells you nothing except that you are stuck, with no sense of how stuck.
 *
 * So the count is drawn as the rule's own shape: five cells, one per slot. A filled cell carries the
 * month that slot frees up, ordered soonest-first, so the rail reads left to right as a timeline of
 * returning capacity. Empty cells are visibly empty. Two things fall out of that for free:
 *
 *   - At 3/24 you can see both that you have two slots and that the first of the other three comes
 *     back in November — one glance, no arithmetic.
 *   - Past five, the overflow is drawn as a distinct block beyond the fifth cell rather than by
 *     changing a digit. Being 7/24 *looks* like being over a wall, which is what it is.
 *
 * The cells are not a progress bar and are deliberately not contiguous: a slot is a discrete thing
 * you spend, and the gaps say so.
 */

import { StyleSheet, Text, View } from 'react-native';

import { colour, radius, space, tabular, type } from '../theme.ts';
import { monthYear } from '../format.ts';
import type { Standing } from '../api.ts';

const SLOTS = 5;

export function SlotRail({ standing }: { standing: Standing }) {
  const { count, accounts, under5At, nextDropAt } = standing.count524;

  /**
   * One expiry per occupied slot, soonest first.
   *
   * `accounts` arrives newest-first from the server, so it is reversed: the *oldest* account is the
   * next to age out, and the rail is a queue of returning slots rather than a list of recent
   * applications.
   */
  const expiries = accounts
    .slice()
    .reverse()
    .map((account) => (account.openedAt === null ? null : addTwoYears(account.openedAt)));

  const filled = Math.min(count, SLOTS);
  const overflow = Math.max(0, count - SLOTS);
  const blocked = count >= SLOTS;

  return (
    <View>
      <View style={styles.rail}>
        {Array.from({ length: SLOTS }, (_, index) => {
          const taken = index < filled;
          return (
            <View
              key={index}
              style={[styles.cell, taken ? styles.cellTaken : styles.cellOpen]}
              // One label per cell rather than per glyph: a screen reader should hear "spent, frees
              // up November 2026", not the visual fragments.
              accessible
              accessibilityLabel={
                taken
                  ? `Slot ${index + 1} of 5, spent, frees up ${expiries[index] ?? 'unknown'}`
                  : `Slot ${index + 1} of 5, open`
              }
            >
              {taken ? (
                <>
                  <Text style={styles.cellMonth}>{monthYear(expiries[index])}</Text>
                  <Text style={styles.cellCaption}>frees</Text>
                </>
              ) : (
                <Text style={styles.cellOpenText}>open</Text>
              )}
            </View>
          );
        })}

        {overflow > 0 ? (
          <View
            style={styles.overflow}
            accessible
            accessibilityLabel={`${overflow} accounts beyond the five-slot limit`}
          >
            <Text style={styles.overflowText}>+{overflow}</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.summary}>
        <Text style={[styles.count, blocked && styles.countBlocked, tabular]}>
          {count}
          <Text style={styles.countDenominator}>/24</Text>
        </Text>

        <View style={styles.verdict}>
          {blocked ? (
            <>
              <Text style={styles.verdictTitle}>Chase is closed to you</Text>
              <Text style={styles.verdictDetail}>
                {under5At !== null ? (
                  <>
                    Reopens <Text style={styles.when}>{monthYear(under5At)}</Text>, when you drop to 4.
                  </>
                ) : (
                  'Applications are declined at 5 or more.'
                )}
              </Text>
            </>
          ) : (
            <>
              <Text style={styles.verdictTitle}>
                {SLOTS - count} slot{SLOTS - count === 1 ? '' : 's'} to spend
              </Text>
              <Text style={styles.verdictDetail}>
                {nextDropAt !== null ? (
                  <>
                    Next returns <Text style={styles.when}>{monthYear(nextDropAt)}</Text>.
                  </>
                ) : (
                  'Nothing counting against you.'
                )}
              </Text>
            </>
          )}
        </View>
      </View>
    </View>
  );
}

/**
 * When an account opened on this date leaves the 24-month window.
 *
 * Computed here rather than fetched because the server already sends the open dates and this is the
 * one place the app needs them shifted. Done on the UTC fields by hand for the same reason as
 * everywhere else: `setFullYear` on a locally-parsed date shifts by a day west of Greenwich.
 */
function addTwoYears(date: string): string {
  const found = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (found === null) return date;
  return `${Number(found[1]) + 2}-${found[2]}-${found[3]}`;
}

const styles = StyleSheet.create({
  rail: {
    flexDirection: 'row',
    gap: space.xs,
  },
  cell: {
    flex: 1,
    height: 54,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  cellTaken: {
    backgroundColor: colour.whenDim,
    borderColor: colour.when,
  },
  cellOpen: {
    backgroundColor: 'transparent',
    // Dashed, so an empty slot reads as an absence rather than as another kind of thing. It is the
    // one dashed border in the app and it is doing real work.
    borderColor: colour.line,
    borderStyle: 'dashed',
  },
  cellMonth: {
    ...type.dataSmall,
    color: colour.when,
  },
  cellCaption: {
    ...type.label,
    fontSize: 9,
    letterSpacing: 0.8,
    color: colour.textFaint,
    marginTop: 2,
  },
  cellOpenText: {
    ...type.label,
    fontSize: 10,
    color: colour.textFaint,
  },
  overflow: {
    width: 34,
    height: 54,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colour.stopDim,
    borderWidth: 1,
    borderColor: colour.stop,
  },
  overflowText: {
    ...type.dataStrong,
    color: colour.stop,
  },
  summary: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.lg,
    marginTop: space.lg,
  },
  count: {
    ...type.hero,
    color: colour.text,
  },
  countBlocked: {
    color: colour.stop,
  },
  countDenominator: {
    ...type.data,
    fontSize: 18,
    color: colour.textFaint,
  },
  verdict: {
    flex: 1,
    paddingBottom: space.xs,
  },
  verdictTitle: {
    ...type.bodyStrong,
    color: colour.text,
  },
  verdictDetail: {
    ...type.small,
    color: colour.textDim,
    marginTop: 2,
  },
  when: {
    ...type.dataSmall,
    color: colour.when,
  },
});
