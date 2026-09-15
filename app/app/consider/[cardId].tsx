/**
 * "Can I get this?" — one card, every rule that bears on it, and the date each one lifts.
 *
 * This is the screen the whole rules engine exists for. It answers with reasons rather than a verdict,
 * ordered worst-first, each one naming the rule in the community's own notation so the user can go and
 * check it. Every rule here is undocumented issuer behaviour observed by strangers on the internet —
 * presenting it as an oracle would be dishonest and would also be less useful, because the user is the
 * one who eats the denial and knows things the app does not.
 *
 * So the strongest thing it ever says is "expect a decline until April", and the last line on the page
 * is that you can ignore all of it.
 */

import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { api, type AssessResponse } from '@/api.ts';
import { useSession } from '@/session.tsx';
import { useLoad } from '@/useLoad.ts';
import { Button, Chip, ChipRow, Eyebrow, Loading, Problem } from '@/components/ui.tsx';
import { colour, radius, severityBackground, severityColour, space, tabular, type } from '@/theme.ts';
import { bonusText, money, monthYear, ruleNotation, shortDateWithYear } from '@/format.ts';

/** What each severity means, in the user's terms rather than the engine's. */
const SEVERITY_TEXT = {
  blocker: 'Will be declined',
  'likely-denial': 'Probably declined, or no bonus',
  caution: 'Allowed, but not advisable',
  note: 'Worth knowing',
} as const;

export default function Consider() {
  const { cardId } = useLocalSearchParams<{ cardId: string }>();
  const session = useSession();
  const router = useRouter();
  const playerId = session.playerId ?? undefined;

  const loaded = useLoad<AssessResponse>(() => api.assess(cardId, playerId), [cardId, playerId]);

  if (loaded.loading) return <Loading label="Checking the rules" />;
  if (loaded.data === null) {
    return (
      <View style={styles.padded}>
        <Problem message={loaded.error ?? 'Could not check this card.'} onRetry={loaded.reload} />
      </View>
    );
  }

  const { card, offer, assessment, standing } = loaded.data;
  const blockers = assessment.verdicts.filter((verdict) => verdict.severity === 'blocker');
  const clear = assessment.verdicts.length === 0;

  return (
    <ScrollView
      contentContainerStyle={styles.scroll}
      refreshControl={
        <RefreshControl refreshing={loaded.refreshing} onRefresh={loaded.refresh} tintColor={colour.when} />
      }
    >
        <View style={styles.header}>
          <Text style={styles.name}>{card.name}</Text>
          <ChipRow>
            {card.annualFeeCents > 0 ? (
              <Chip colour={colour.warn}>{money(card.annualFeeCents)}/yr</Chip>
            ) : (
              <Chip>No fee</Chip>
            )}
            {card.productType === 'business' ? <Chip>Business</Chip> : null}
            {card.showsOnPersonalReport ? (
              <Chip colour={colour.when} background={colour.whenDim} notation>
                Costs a 5/24 slot
              </Chip>
            ) : (
              <Chip colour={colour.go}>Invisible to 5/24</Chip>
            )}
            {card.familyLabel !== '' ? <Chip colour={colour.textDim}>{card.familyLabel} family</Chip> : null}
          </ChipRow>
        </View>

        {/* The answer, stated first and in one line. Everything below it is the working. */}
        <View
          style={[
            styles.answer,
            {
              backgroundColor: clear ? colour.goDim : assessment.blocked ? colour.stopDim : colour.warnDim,
              borderColor: clear ? colour.go : assessment.blocked ? colour.stop : colour.warn,
            },
          ]}
        >
          <Text
            style={[
              styles.answerText,
              { color: clear ? colour.go : assessment.blocked ? colour.stop : colour.warn },
            ]}
          >
            {clear
              ? 'Nothing is in your way'
              : assessment.blocked
                ? assessment.availableAt !== null
                  ? `Blocked until ${monthYear(assessment.availableAt)}`
                  : 'Blocked — waiting will not clear this'
                : 'Allowed, with things to weigh'}
          </Text>
          {/* Said explicitly, because a blocker with no date sitting next to one that shows `Mar '29`
              otherwise reads as a contradiction. One of them needs an action, not patience. */}
          {assessment.blocked && assessment.availableAt === null ? (
            <Text style={styles.answerDetail}>
              At least one of these needs you to do something — closing or product-changing a card you
              hold — rather than to wait it out.
            </Text>
          ) : null}
          <Text style={styles.answerDetail}>
            You are {standing.count524.count}/24 with {standing.inquiries6Months.total} hard{' '}
            {standing.inquiries6Months.total === 1 ? 'inquiry' : 'inquiries'} in six months.
          </Text>
        </View>

        {offer !== null ? (
          <View style={styles.offer}>
            <Eyebrow>Current offer</Eyebrow>
            <Text style={styles.offerBonus}>{bonusText(offer.amount, offer.unit)}</Text>
            <Text style={styles.offerTerms}>
              {offer.minSpendCents > 0
                ? `After ${money(offer.minSpendCents)} of spend within ${offer.spendWindowDays} days.`
                : 'Doctor of Credit does not state the minimum spend — check the issuer.'}
            </Text>
            <ChipRow>
              {offer.historicalHigh ? (
                <Chip colour={colour.go} background={colour.goDim}>
                  At or near its historical high
                </Chip>
              ) : null}
              {offer.targeted ? <Chip colour={colour.warn}>Targeted — not something to plan around</Chip> : null}
              {offer.states.length > 0 ? <Chip colour={colour.warn}>{offer.states.join(', ')} only</Chip> : null}
            </ChipRow>
            <Text style={styles.offerSeen}>Seen {shortDateWithYear(offer.seenAt)}</Text>
          </View>
        ) : (
          <Text style={styles.noOffer}>
            No public offer on Doctor of Credit's best-bonuses list right now. That does not mean there
            is no offer — only that it is not among the best.
          </Text>
        )}

        <View style={styles.section}>
          <Eyebrow>{clear ? 'Rules checked' : 'What the rules say'}</Eyebrow>

          {clear ? (
            <Text style={styles.clear}>
              Every rule this app knows about — 5/24, application velocity, family and lifetime rules,
              inquiry sensitivity — came back clean for this card.
            </Text>
          ) : (
            assessment.verdicts.map((verdict) => {
              const notation = ruleNotation(verdict.ruleId);
              return (
                <View key={verdict.ruleId} style={styles.verdict}>
                  <View style={styles.verdictHead}>
                    {notation !== null ? (
                      <View style={[styles.notation, { backgroundColor: severityBackground[verdict.severity] }]}>
                        <Text style={[styles.notationText, { color: severityColour[verdict.severity] }]}>
                          {notation}
                        </Text>
                      </View>
                    ) : null}
                    <View style={styles.verdictTitles}>
                      <Text style={styles.verdictTitle}>{verdict.title}</Text>
                      <Text style={[styles.verdictSeverity, { color: severityColour[verdict.severity] }]}>
                        {SEVERITY_TEXT[verdict.severity]}
                      </Text>
                    </View>
                    {verdict.clearsAt !== null ? (
                      <Text style={[styles.verdictWhen, tabular]}>{monthYear(verdict.clearsAt)}</Text>
                    ) : null}
                  </View>
                  <Text style={styles.verdictMessage}>{verdict.message}</Text>
                </View>
              );
            })
          )}
        </View>

        {blockers.length > 0 && assessment.availableAt !== null ? (
          <Text style={styles.waitNote}>
            {blockers.length === 1 ? 'This lifts' : 'The last of these lifts'} on{' '}
            <Text style={[styles.waitDate, tabular]}>{shortDateWithYear(assessment.availableAt)}</Text>.
          </Text>
        ) : null}

        <View style={styles.section}>
          <Button
            label="I got this card"
            onPress={() => router.push(`/card/new?cardId=${card.id}`)}
            kind={assessment.blocked ? 'secondary' : 'primary'}
          />
          <Text style={styles.override}>
            These are community-observed rules, not issuer policy. They change without notice and this
            app can be wrong — if you know better, add the card anyway.
          </Text>
        </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: space.lg, paddingBottom: space.xxxl, gap: space.xl },
  padded: { padding: space.lg },
  section: { gap: space.md },

  header: { gap: space.sm },
  name: { ...type.title, color: colour.text },

  answer: {
    padding: space.lg,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    gap: space.xs,
  },
  answerText: { ...type.heading, fontSize: 19 },
  answerDetail: { ...type.small, color: colour.textDim },

  offer: { gap: space.xs },
  offerBonus: { ...type.heading, color: colour.go },
  offerTerms: { ...type.small, color: colour.textDim },
  offerSeen: { ...type.dataSmall, fontSize: 10, color: colour.textFaint },
  noOffer: { ...type.small, color: colour.textFaint },

  clear: { ...type.body, color: colour.textDim },

  verdict: {
    paddingVertical: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colour.lineSoft,
    gap: space.xs,
  },
  verdictHead: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  // The rule's fraction, set as a token. This is the community's own name for the rule and the
  // thing a user can search for.
  notation: { paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.sm, minWidth: 46, alignItems: 'center' },
  notationText: { ...type.dataStrong, fontSize: 12 },
  verdictTitles: { flex: 1 },
  verdictTitle: { ...type.bodyStrong, color: colour.text },
  verdictSeverity: { ...type.label, fontSize: 9, marginTop: 2 },
  verdictWhen: { ...type.dataSmall, color: colour.when, paddingTop: 3 },
  verdictMessage: { ...type.small, color: colour.textDim },

  waitNote: { ...type.body, color: colour.textDim },
  waitDate: { ...type.dataStrong, color: colour.when },
  override: { ...type.small, fontSize: 12, color: colour.textFaint },
});
