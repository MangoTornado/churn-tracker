/**
 * Position — where you stand, and what is coming.
 *
 * The slot rail first, because that is the question that brings anyone back to this app. Then a
 * single chronological spine of everything with a date on it, soonest first, in one list rather than
 * split into sections by kind. That is the deliberate choice: an annual fee, a minimum-spend deadline
 * and a bank clawback window are completely different things, and on any given Tuesday what matters
 * is only which comes first. Grouping by kind would hide that.
 *
 * The counts row underneath is the secondary numbers — inquiries, open cards, fees a year — set small
 * and in mono so they read as a footer to the rail rather than competing with it.
 */

import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { api, type RemindersResponse, type Standing } from '@/api.ts';
import { useSession } from '@/session.tsx';
import { useLoad } from '@/useLoad.ts';
import { SlotRail } from '@/components/SlotRail.tsx';
import { Button, Chip, Empty, Eyebrow, LedgerRow, Loading, Problem } from '@/components/ui.tsx';
import { colour, radius, space, tabular, type, urgencyColour } from '@/theme.ts';
import { money, shortDate, shortDateWithYear } from '@/format.ts';

export default function Position() {
  const session = useSession();
  const router = useRouter();
  const playerId = session.playerId ?? undefined;
  const [dismissing, setDismissing] = useState<string | null>(null);

  const loaded = useLoad<{ standing: Standing; reminders: RemindersResponse }>(
    async () => {
      // Both at once: they are two views of the same accounts and showing one before the other
      // arrives makes the screen shuffle.
      const [standing, reminders] = await Promise.all([api.standing(playerId), api.reminders(playerId)]);
      return { standing, reminders };
    },
    [playerId],
  );

  const dismiss = useCallback(
    async (reminderId: string) => {
      setDismissing(reminderId);
      try {
        await api.dismissReminder(reminderId, playerId);
        loaded.refresh();
      } finally {
        setDismissing(null);
      }
    },
    [playerId, loaded],
  );

  if (loaded.loading) return <Loading label="Working out where you stand" />;
  if (loaded.data === null) {
    return (
      <View style={styles.padded}>
        <Problem message={loaded.error ?? 'Could not load your position.'} onRetry={loaded.reload} />
      </View>
    );
  }

  const { standing, reminders } = loaded.data;
  const due = reminders.active;

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={loaded.refreshing} onRefresh={loaded.refresh} tintColor={colour.when} />
      }
    >
      {session.players.length > 1 && session.player !== null ? (
        <Text style={styles.who}>{session.player.name}</Text>
      ) : null}

      <View style={styles.rail}>
        <SlotRail standing={standing} />
      </View>

      <View style={styles.counts}>
        <Count label="Open cards" value={String(standing.openCards)} />
        <Count
          label="Fees a year"
          value={money(standing.annualFeesCents)}
          tone={standing.annualFeesCents > 0 ? colour.warn : undefined}
        />
        <Count
          label="Inquiries 6mo"
          value={String(standing.inquiries6Months.total)}
          tone={standing.inquiries6Months.total >= 6 ? colour.stop : undefined}
        />
        <Count label="New 12mo" value={String(standing.newAccounts12Months)} />
      </View>

      <View style={styles.section}>
        <Eyebrow>What's coming</Eyebrow>

        {due.length === 0 ? (
          <View style={styles.clear}>
            <Text style={styles.clearTitle}>Nothing needs you this month.</Text>
            <Text style={styles.clearDetail}>
              Deadlines appear here as they come into range — annual fees six weeks out, minimum
              spends, and bank bonuses you can safely close.
            </Text>
          </View>
        ) : (
          <View style={styles.ledger}>
            {due.map((reminder, index) => (
              <LedgerRow
                key={reminder.id}
                // The year appears once the date is far enough away for its absence to mislead. An
                // idle card two years overdue read as "Sep 1 / overdue", which looks like last week.
                date={
                  Math.abs(reminder.daysUntil) > 180
                    ? shortDateWithYear(reminder.dueAt)
                    : shortDate(reminder.dueAt)
                }
                caption={reminder.daysUntil < 0 ? 'overdue' : reminder.whenText.replace('in ', '')}
                marker={urgencyColour[reminder.urgency]}
                last={index === due.length - 1}
              >
                <Text style={styles.reminderTitle}>{reminder.title}</Text>
                <Text style={styles.reminderDetail}>{reminder.detail}</Text>
                <View style={styles.reminderFooter}>
                  {reminder.stakeCents > 0 ? (
                    <Chip colour={urgencyColour[reminder.urgency]}>{money(reminder.stakeCents)} at stake</Chip>
                  ) : null}
                  <Text
                    style={styles.dismiss}
                    accessibilityRole="button"
                    onPress={() => void dismiss(reminder.id)}
                    suppressHighlighting
                  >
                    {dismissing === reminder.id ? 'Dismissing…' : 'Dismiss'}
                  </Text>
                </View>
              </LedgerRow>
            ))}
          </View>
        )}
      </View>

      {standing.openCards === 0 ? (
        <Empty
          title="Add what you already have"
          detail="The 5/24 count, every reminder and every recommendation come from your open dates. Two cards is enough to make this useful."
          action={{ label: 'Add a card', onPress: () => router.push('/card/new') }}
        />
      ) : (
        <View style={styles.actions}>
          <Button label="What should I get next?" onPress={() => router.push('/(tabs)/plan')} kind="secondary" />
        </View>
      )}

      {reminders.dismissed.length > 0 ? (
        <Text style={styles.footnote}>
          {reminders.dismissed.length} dismissed. They come back if the date moves.
        </Text>
      ) : null}
    </ScrollView>
  );
}

/** One of the secondary numbers under the rail. */
function Count({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <View style={styles.count}>
      <Text style={[styles.countValue, tabular, tone !== undefined && { color: tone }]}>{value}</Text>
      <Text style={styles.countLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: space.xxxl, gap: space.xl },
  padded: { padding: space.lg },

  who: { ...type.label, color: colour.when, paddingHorizontal: space.lg, paddingTop: space.md },
  rail: { paddingHorizontal: space.lg, paddingTop: space.md },

  counts: {
    flexDirection: 'row',
    marginHorizontal: space.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colour.line,
    paddingVertical: space.md,
  },
  count: { flex: 1, gap: 3 },
  countValue: { ...type.dataStrong, color: colour.text },
  countLabel: { ...type.label, fontSize: 9, letterSpacing: 0.7, color: colour.textFaint },

  section: { gap: space.md },
  ledger: { paddingHorizontal: space.lg },

  reminderTitle: { ...type.bodyStrong, color: colour.text },
  reminderDetail: { ...type.small, color: colour.textDim, marginTop: 3 },
  reminderFooter: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.sm },
  dismiss: { ...type.smallStrong, fontSize: 12, color: colour.textFaint },

  clear: {
    marginHorizontal: space.lg,
    padding: space.lg,
    backgroundColor: colour.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colour.line,
    gap: space.xs,
  },
  clearTitle: { ...type.bodyStrong, color: colour.text },
  clearDetail: { ...type.small, color: colour.textDim },

  actions: { paddingHorizontal: space.lg },
  footnote: { ...type.small, fontSize: 12, color: colour.textFaint, paddingHorizontal: space.lg },
});
