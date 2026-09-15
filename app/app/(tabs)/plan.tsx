/**
 * Next — what to apply for, and why.
 *
 * The reasons are the product here, not the ranking. A list of card names in an order is worth very
 * little; a list where each entry says "the flowchart ranks this #1 of 9 Chase personal cards, and
 * Chase cards are the only ones 5/24 can take away from you" is something you can disagree with,
 * which is the point. So every row leads with its reason and the card name is the label on it.
 *
 * The chart's own words travel with the list, quoted and attributed to a version and a date. This app
 * did not invent this advice — it is /u/m16p's flowchart, it is explicitly subjective, and its own
 * "Limitations" panel says so before anything else. Presenting it as the app's opinion would be both
 * a lie and less useful.
 */

import { useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { api, type Plan } from '@/api.ts';
import { useSession } from '@/session.tsx';
import { useLoad } from '@/useLoad.ts';
import { Chip, ChipRow, Eyebrow, Loading, Problem, Segments } from '@/components/ui.tsx';
import { colour, radius, severityColour, space, tabular, type } from '@/theme.ts';
import { bonusText, money, monthYear, ruleNotation, shortDateWithYear } from '@/format.ts';

type Goal = 'travel' | 'cashback';

/** What each phase of the flowchart means, in one line, in the user's terms. */
const PHASE_TEXT: Record<Plan['phase'], { title: string; detail: string }> = {
  'thin-file': {
    title: 'Building credit first',
    detail:
      'Under a year of card history. Most cards worth churning will decline you — get a year of history behind you before spending slots.',
  },
  'under-5-24': {
    title: 'Under 5/24 — spend slots on Chase',
    detail:
      'Chase cards are the only ones 5/24 can take away from you. Space applications three months apart and fill the gaps with business cards, which the count cannot see.',
  },
  'at-the-edge': {
    title: 'Exactly 5/24 — the last window for some issuers',
    detail:
      'Chase is closed, but Barclays and Capital One are still approving and stop shortly after. This is the moment for those cards.',
  },
  'over-5-24': {
    title: 'Past 5/24 — biggest bonus wins',
    detail:
      'Slots no longer cost you anything. Work down the list from the largest bonus, spreading applications across banks so no one issuer sees a burst.',
  },
};

export default function Next() {
  const session = useSession();
  const router = useRouter();
  const playerId = session.playerId ?? undefined;

  const [goal, setGoal] = useState<Goal>('travel');
  const [businessCards, setBusinessCards] = useState(true);
  const [showWaiting, setShowWaiting] = useState(false);
  const [openPanel, setOpenPanel] = useState<string | null>(null);

  const loaded = useLoad<Plan & { offersFetchedAt: string }>(
    () => api.plan({ playerId, goal, businessCards }),
    [playerId, goal, businessCards],
  );

  const phase = useMemo(() => (loaded.data === null ? null : PHASE_TEXT[loaded.data.phase]), [loaded.data]);

  if (loaded.loading) return <Loading label="Working out your next move" />;
  if (loaded.data === null) {
    return (
      <View style={styles.padded}>
        <Problem message={loaded.error ?? 'Could not work out a plan.'} onRetry={loaded.reload} />
      </View>
    );
  }

  const plan = loaded.data;

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={loaded.refreshing} onRefresh={loaded.refresh} tintColor={colour.when} />
      }
    >
      <View style={styles.controls}>
        <Segments<Goal>
          value={goal}
          onChange={setGoal}
          options={[
            { value: 'travel', label: 'Travel' },
            { value: 'cashback', label: 'Cashback' },
          ]}
        />
        <Pressable
          onPress={() => setBusinessCards((previous) => !previous)}
          style={styles.toggle}
          accessibilityRole="switch"
          accessibilityState={{ checked: businessCards }}
        >
          <View style={[styles.checkbox, businessCards && styles.checkboxOn]}>
            {businessCards ? <Text style={styles.checkmark}>✓</Text> : null}
          </View>
          <Text style={styles.toggleLabel}>Include business cards</Text>
        </Pressable>
      </View>

      {phase !== null ? (
        <View style={styles.phase}>
          <Text style={[styles.phaseCount, tabular]}>
            {plan.count524}
            <Text style={styles.phaseCountDenominator}>/24</Text>
          </Text>
          <View style={styles.phaseText}>
            <Text style={styles.phaseTitle}>{phase.title}</Text>
            <Text style={styles.phaseDetail}>{phase.detail}</Text>
          </View>
        </View>
      ) : null}

      <View style={styles.section}>
        <Eyebrow>Apply for</Eyebrow>
        {plan.recommendations.length === 0 ? (
          <Text style={styles.none}>
            Nothing is available right now. Everything worth having is in the waiting list below, with
            the date it opens up.
          </Text>
        ) : (
          plan.recommendations.slice(0, 12).map((entry, index) => (
            <Pressable
              key={entry.card.id}
              onPress={() => router.push(`/consider/${entry.card.id}`)}
              style={({ pressed }) => [styles.pick, pressed && styles.pressed]}
            >
              {/* The rank is a real ordinal here — this list is a sequence the flowchart puts in an
                  order, which is exactly when a number carries information. */}
              <Text style={[styles.rank, tabular]}>{String(index + 1).padStart(2, '0')}</Text>
              <View style={styles.pickBody}>
                <Text style={styles.pickName}>{entry.card.name}</Text>
                <Text style={styles.pickReason}>{entry.reasons[0]}</Text>

                <ChipRow>
                  {entry.offer !== null ? (
                    <Chip colour={colour.go} background={colour.goDim}>
                      {bonusText(entry.offer.amount, entry.offer.unit)}
                      {entry.offer.minSpendCents > 0
                        ? ` after ${money(entry.offer.minSpendCents)} in ${entry.offer.spendWindowDays}d`
                        : ''}
                    </Chip>
                  ) : (
                    <Chip colour={colour.textFaint}>No public offer listed</Chip>
                  )}
                  {entry.offer?.historicalHigh === true ? (
                    <Chip colour={colour.go} background={colour.goDim}>
                      At its high
                    </Chip>
                  ) : null}
                  {entry.offer?.targeted === true ? <Chip colour={colour.warn}>Targeted</Chip> : null}
                  {entry.card.annualFeeCents > 0 ? (
                    <Chip colour={colour.warn}>{money(entry.card.annualFeeCents)}/yr</Chip>
                  ) : (
                    <Chip>No fee</Chip>
                  )}
                  {entry.verdict === 'costs-a-slot' ? (
                    <Chip colour={colour.warn} background={colour.warnDim} notation>
                      Costs a 5/24 slot
                    </Chip>
                  ) : null}
                </ChipRow>

                {/* The flowchart puts these at the same rank, meaning pick one. Listed as "or"
                    rather than as their own numbered rows, which would read as a sequence to work
                    through. */}
                {/* `?? []` because a browser can hold a cached bundle across a server deploy, so the
                    app has to tolerate a response shaped by a different version of the API. A missing
                    field should degrade to showing less, not to a white screen. */}
                {(entry.alternatives ?? []).length > 0 ? (
                  <Text style={styles.alternatives}>
                    or{' '}
                    {(entry.alternatives ?? []).map((alternative, position) => (
                      <Text key={alternative.card.id}>
                        {position > 0 ? ', ' : ''}
                        <Text style={styles.alternativeName}>{alternative.card.name}</Text>
                        {alternative.offer !== null
                          ? ` (${bonusText(alternative.offer.amount, alternative.offer.unit)})`
                          : ''}
                      </Text>
                    ))}
                  </Text>
                ) : null}

                {entry.reasons.length > 1 ? (
                  <Text style={styles.more}>{entry.reasons.length - 1} more consideration{entry.reasons.length > 2 ? 's' : ''} →</Text>
                ) : null}
              </View>
            </Pressable>
          ))
        )}
      </View>

      {plan.waiting.length > 0 ? (
        <View style={styles.section}>
          <Pressable onPress={() => setShowWaiting((previous) => !previous)}>
            <Eyebrow>
              {showWaiting ? 'Hide' : 'Show'} {plan.waiting.length} gated {plan.waiting.length === 1 ? 'card' : 'cards'}
            </Eyebrow>
          </Pressable>

          {showWaiting
            ? plan.waiting.slice(0, 25).map((entry) => (
                <Pressable
                  key={entry.card.id}
                  onPress={() => router.push(`/consider/${entry.card.id}`)}
                  style={({ pressed }) => [styles.gated, pressed && styles.pressed]}
                >
                  <View style={styles.gatedHead}>
                    <Text style={styles.gatedName}>{entry.card.name}</Text>
                    {/* Violet, because it is a date — the same colour the slot rail uses for the
                        same meaning. */}
                    <Text style={[styles.gatedWhen, tabular]}>
                      {entry.availableAt !== null ? monthYear(entry.availableAt) : 'no date'}
                    </Text>
                  </View>
                  <Text style={styles.gatedReason}>{entry.reasons[0]}</Text>
                  <ChipRow>
                    {entry.assessment.verdicts.slice(0, 3).map((verdict) => {
                      const notation = ruleNotation(verdict.ruleId);
                      return (
                        <Chip
                          key={verdict.ruleId}
                          colour={severityColour[verdict.severity]}
                          notation={notation !== null}
                        >
                          {notation ?? verdict.title}
                        </Chip>
                      );
                    })}
                  </ChipRow>
                </Pressable>
              ))
            : null}
        </View>
      ) : null}

      <View style={styles.section}>
        <Eyebrow>The reasoning</Eyebrow>
        <Text style={styles.attribution}>
          From /u/m16p's card recommendation flowchart, {plan.flowchart.version.replace('Card Recommendation Flowchart ', '')}
          {plan.flowchart.updatedAt !== null ? `, updated ${shortDateWithYear(plan.flowchart.updatedAt)}` : ''}. It
          is deliberately subjective and does not account for current bonuses.
        </Text>

        {plan.strategy.map((section) => {
          const open = openPanel === section.id;
          return (
            <View key={section.id} style={styles.panel}>
              <Pressable
                onPress={() => setOpenPanel(open ? null : section.id)}
                style={styles.panelHead}
                accessibilityRole="button"
                accessibilityState={{ expanded: open }}
              >
                <Text style={styles.panelHeading}>{section.heading}</Text>
                <Text style={styles.panelChevron}>{open ? '−' : '+'}</Text>
              </Pressable>
              {open ? <Text style={styles.panelBody}>{section.body}</Text> : null}
            </View>
          );
        })}
      </View>

      <Text style={styles.footnote}>
        Offers last checked {plan.offersFetchedAt === '' ? 'never' : shortDateWithYear(plan.offersFetchedAt.slice(0, 10))}.
        Bonuses change weekly — confirm the current offer before applying.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingBottom: space.xxxl, gap: space.xl },
  padded: { padding: space.lg },
  pressed: { opacity: 0.6 },

  controls: { gap: space.md },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colour.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: colour.go, borderColor: colour.go },
  checkmark: { ...type.smallStrong, fontSize: 12, color: colour.ground },
  toggleLabel: { ...type.small, color: colour.textDim },

  phase: { flexDirection: 'row', gap: space.lg, alignItems: 'flex-start' },
  phaseCount: { ...type.hero, fontSize: 32, lineHeight: 34, color: colour.text },
  phaseCountDenominator: { ...type.data, fontSize: 15, color: colour.textFaint },
  phaseText: { flex: 1, gap: 3 },
  phaseTitle: { ...type.bodyStrong, color: colour.text },
  phaseDetail: { ...type.small, color: colour.textDim },

  section: { gap: space.md },
  none: { ...type.body, color: colour.textDim },

  pick: { flexDirection: 'row', gap: space.md, paddingVertical: space.md, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colour.lineSoft },
  rank: { ...type.dataSmall, color: colour.textFaint, paddingTop: 3, width: 20 },
  pickBody: { flex: 1, gap: space.xs },
  pickName: { ...type.heading, fontSize: 16, color: colour.text },
  pickReason: { ...type.small, color: colour.textDim },
  more: { ...type.dataSmall, fontSize: 11, color: colour.when, marginTop: 2 },
  alternatives: { ...type.small, fontSize: 12, color: colour.textFaint, marginTop: 2 },
  alternativeName: { ...type.smallStrong, fontSize: 12, color: colour.textDim },

  gated: {
    padding: space.md,
    backgroundColor: colour.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colour.line,
    gap: space.xs,
  },
  gatedHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: space.sm },
  gatedName: { ...type.bodyStrong, color: colour.textDim, flex: 1 },
  gatedWhen: { ...type.dataSmall, color: colour.when },
  gatedReason: { ...type.small, fontSize: 12, color: colour.textFaint },

  attribution: { ...type.small, color: colour.textFaint },
  panel: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colour.lineSoft,
  },
  panelHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: space.md, gap: space.md },
  panelHeading: { ...type.smallStrong, color: colour.text, flex: 1 },
  panelChevron: { ...type.data, color: colour.textFaint },
  // The flowchart's own prose, monospaced and slightly loose: it is quoted material with hard line
  // breaks the author put there, and setting it as body copy would reflow it into nonsense.
  panelBody: { ...type.dataSmall, fontSize: 11.5, lineHeight: 18, color: colour.textDim, paddingBottom: space.lg },

  footnote: { ...type.small, fontSize: 12, color: colour.textFaint },
});
