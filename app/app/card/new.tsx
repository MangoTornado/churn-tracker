/**
 * Add a card.
 *
 * Picking from the catalog rather than typing a name is the difference between a form that produces a
 * correct 5/24 count and one that produces a plausible wrong one. The catalog knows the annual fee,
 * the product type, and — the field that actually matters — whether the card reports to your personal
 * credit report. Nobody types that in correctly for a Capital One business card.
 *
 * So the flow is: search the catalog, pick a card, give the open date, done. Everything else is
 * optional and derived. There is an escape hatch for a card the catalog has never heard of, which
 * gets full rule coverage from its issuer and none of the card-specific rules — and says so.
 */

import { useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';

import { api, ApiError, type Card, type CatalogResponse, type IssuerId } from '@/api.ts';
import { useSession } from '@/session.tsx';
import { useLoad } from '@/useLoad.ts';
import { Button, Chip, ChipRow, Eyebrow, Field, Loading, Problem, Segments } from '@/components/ui.tsx';
import { colour, radius, space, tabular, type } from '@/theme.ts';
import { money } from '@/format.ts';

type Status = 'open' | 'closed' | 'pending' | 'denied';

export default function NewCard() {
  const session = useSession();
  const router = useRouter();
  const playerId = session.playerId ?? undefined;

  const catalog = useLoad<CatalogResponse>(() => api.catalog(), []);

  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<Card | null>(null);
  const [custom, setCustom] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customIssuer, setCustomIssuer] = useState<IssuerId>('other');

  const [status, setStatus] = useState<Status>('open');
  const [openedAt, setOpenedAt] = useState('');
  const [closedAt, setClosedAt] = useState('');
  const [authorizedUser, setAuthorizedUser] = useState(false);
  const [bonusAmount, setBonusAmount] = useState('');
  const [minSpend, setMinSpend] = useState('');
  const [notes, setNotes] = useState('');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const matches = useMemo(() => {
    const all = catalog.data?.cards ?? [];
    const needle = search.trim().toLowerCase();
    if (needle === '') return all.slice(0, 12);
    return all.filter((card) => card.name.toLowerCase().includes(needle)).slice(0, 20);
  }, [catalog.data, search]);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    setFieldError(null);
    try {
      const bonus =
        bonusAmount.trim() === ''
          ? undefined
          : {
              amount: Number(bonusAmount.replace(/[^\d]/g, '')),
              // Points unless the card earns cash back, which the catalog already knows. One fewer
              // question for the common case.
              unit: picked?.currency === 'cash' ? ('dollars' as const) : ('points' as const),
              minSpendCents: minSpend.trim() === '' ? 0 : Math.round(Number(minSpend.replace(/[^\d.]/g, '')) * 100),
            };

      await api.createCard(
        {
          cardId: custom ? null : picked?.id,
          cardName: custom ? customName : picked?.name,
          issuer: custom ? customIssuer : picked?.issuer,
          status,
          openedAt: openedAt.trim() === '' ? null : openedAt.trim(),
          closedAt: closedAt.trim() === '' ? null : closedAt.trim(),
          authorizedUser,
          bonus,
          notes,
        },
        playerId,
      );
      router.back();
    } catch (problem) {
      if (problem instanceof ApiError) {
        setError(problem.message);
        setFieldError(problem.field);
      } else {
        setError('Could not save this card.');
      }
    } finally {
      setSaving(false);
    }
  };

  if (catalog.loading) return <Loading label="Loading the card catalog" />;
  if (catalog.data === null) {
    return (
      <View style={styles.padded}>
        <Problem message={catalog.error ?? 'Could not load the catalog.'} onRetry={catalog.reload} />
      </View>
    );
  }

  // Bound to a local after the guard above: TypeScript cannot carry the narrowing of
  // `catalog.data` into the closures inside JSX, and a non-null assertion on each use would be five
  // assertions instead of one honest binding.
  const { issuers } = catalog.data;
  const chosen = custom ? customName !== '' : picked !== null;

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.section}>
          <Eyebrow>Which card</Eyebrow>

          {picked !== null && !custom ? (
            <Pressable onPress={() => setPicked(null)} style={styles.chosen}>
              <View style={styles.chosenBody}>
                <Text style={styles.chosenIssuer}>{issuers[picked.issuer]}</Text>
                <Text style={styles.chosenName}>{picked.name}</Text>
                <ChipRow>
                  {picked.productType === 'business' ? <Chip>Business</Chip> : <Chip>Personal</Chip>}
                  {picked.annualFeeCents > 0 ? (
                    <Chip colour={colour.warn}>{money(picked.annualFeeCents)}/yr</Chip>
                  ) : (
                    <Chip>No fee</Chip>
                  )}
                  {/* The consequential fact, stated at the moment of adding so it is never a
                      surprise later. */}
                  {picked.showsOnPersonalReport ? (
                    <Chip colour={colour.when} background={colour.whenDim} notation>
                      Costs a 5/24 slot
                    </Chip>
                  ) : (
                    <Chip colour={colour.go}>Invisible to 5/24</Chip>
                  )}
                  {picked.chargeCard ? <Chip colour={colour.go}>Charge card</Chip> : null}
                </ChipRow>
                {picked.notes !== '' ? <Text style={styles.chosenNote}>{picked.notes}</Text> : null}
              </View>
              <Text style={styles.change}>Change</Text>
            </Pressable>
          ) : custom ? (
            <>
              <Field label="Card name" value={customName} onChangeText={setCustomName} placeholder="Local Credit Union Visa" autoCapitalize="words" />
              <Text style={styles.hint}>Issuer</Text>
              <View style={styles.issuerGrid}>
                {(Object.keys(issuers) as IssuerId[]).map((issuer) => (
                  <Pressable
                    key={issuer}
                    onPress={() => setCustomIssuer(issuer)}
                    style={[styles.issuerChip, customIssuer === issuer && styles.issuerChipOn]}
                  >
                    <Text style={[styles.issuerChipText, customIssuer === issuer && styles.issuerChipTextOn]}>
                      {issuers[issuer]}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <Text style={styles.warn}>
                A card outside the catalog gets its issuer's rules — 5/24, velocity, inquiry sensitivity
                — but no card-specific ones, so no bonus cooldown and no family rules.
              </Text>
              <Pressable onPress={() => setCustom(false)}>
                <Text style={styles.link}>Search the catalog instead</Text>
              </Pressable>
            </>
          ) : (
            <>
              <TextInput
                value={search}
                onChangeText={setSearch}
                placeholder="Search 100+ cards"
                placeholderTextColor={colour.textFaint}
                style={styles.search}
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
              />
              <View>
                {matches.map((card) => (
                  <Pressable key={card.id} onPress={() => setPicked(card)} style={styles.match}>
                    <View style={styles.matchBody}>
                      <Text style={styles.matchIssuer}>{issuers[card.issuer]}</Text>
                      <Text style={styles.matchName}>{card.name}</Text>
                    </View>
                    {card.annualFeeCents > 0 ? (
                      <Text style={[styles.matchFee, tabular]}>{money(card.annualFeeCents)}</Text>
                    ) : null}
                  </Pressable>
                ))}
                {matches.length === 0 ? <Text style={styles.none}>Nothing matches "{search}".</Text> : null}
              </View>
              <Pressable onPress={() => setCustom(true)}>
                <Text style={styles.link}>Add a card that isn't listed</Text>
              </Pressable>
            </>
          )}
        </View>

        {chosen ? (
          <>
            <View style={styles.section}>
              <Eyebrow>When</Eyebrow>
              <Segments<Status>
                value={status}
                onChange={setStatus}
                options={[
                  { value: 'open', label: 'Open' },
                  { value: 'closed', label: 'Closed' },
                  { value: 'pending', label: 'Pending' },
                  { value: 'denied', label: 'Denied' },
                ]}
              />
              <Field
                label="Opened"
                value={openedAt}
                onChangeText={setOpenedAt}
                placeholder="2025-03-14"
                keyboardType="numeric"
                hint="The date on your credit report, not the day you applied. That date is what 5/24 counts."
                error={fieldError === 'openedAt' ? error : null}
              />
              {status === 'closed' ? (
                <Field
                  label="Closed"
                  value={closedAt}
                  onChangeText={setClosedAt}
                  placeholder="2026-04-01"
                  keyboardType="numeric"
                  hint="It still counts toward 5/24 until 24 months after it opened."
                  error={fieldError === 'closedAt' ? error : null}
                />
              ) : null}

              <Pressable
                onPress={() => setAuthorizedUser((previous) => !previous)}
                style={styles.toggle}
                accessibilityRole="switch"
                accessibilityState={{ checked: authorizedUser }}
              >
                <View style={[styles.checkbox, authorizedUser && styles.checkboxOn]}>
                  {authorizedUser ? <Text style={styles.checkmark}>✓</Text> : null}
                </View>
                <View style={styles.toggleText}>
                  <Text style={styles.toggleLabel}>Someone added me as an authorized user</Text>
                  <Text style={styles.toggleHint}>Counts toward 5/24 even though you did not apply.</Text>
                </View>
              </Pressable>
            </View>

            {!authorizedUser ? (
              <View style={styles.section}>
                <Eyebrow>Bonus (optional)</Eyebrow>
                <Field
                  label={picked?.currency === 'cash' ? 'Bonus in dollars' : 'Bonus in points'}
                  value={bonusAmount}
                  onChangeText={setBonusAmount}
                  placeholder={picked?.currency === 'cash' ? '500' : '60000'}
                  keyboardType="numeric"
                />
                <Field
                  label="Minimum spend in dollars"
                  value={minSpend}
                  onChangeText={setMinSpend}
                  placeholder="4000"
                  keyboardType="numeric"
                  hint="Leave blank to skip the spend reminder."
                />
              </View>
            ) : null}

            <View style={styles.section}>
              <Field label="Notes" value={notes} onChangeText={setNotes} placeholder="Referral from …" autoCapitalize="sentences" />
            </View>

            {error !== null && fieldError === null ? <Text style={styles.error}>{error}</Text> : null}

            <Button label="Save card" onPress={() => void save()} busy={saving} />
          </>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colour.ground },
  content: { padding: space.lg, paddingBottom: space.xxxl, gap: space.xl },
  padded: { padding: space.lg },
  section: { gap: space.md },

  search: {
    ...type.body,
    color: colour.text,
    backgroundColor: colour.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colour.line,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
  },
  match: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colour.lineSoft,
    gap: space.md,
  },
  matchBody: { flex: 1 },
  matchIssuer: { ...type.label, fontSize: 9, color: colour.textDim },
  matchName: { ...type.body, color: colour.text, marginTop: 2 },
  matchFee: { ...type.dataSmall, color: colour.warn },
  none: { ...type.small, color: colour.textFaint, paddingVertical: space.md },

  chosen: {
    flexDirection: 'row',
    padding: space.md,
    backgroundColor: colour.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colour.when,
    gap: space.md,
  },
  chosenBody: { flex: 1, gap: space.xs },
  chosenIssuer: { ...type.label, color: colour.textDim },
  chosenName: { ...type.heading, fontSize: 16, color: colour.text },
  chosenNote: { ...type.small, fontSize: 12, color: colour.textFaint },
  change: { ...type.smallStrong, fontSize: 12, color: colour.when },

  issuerGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  issuerChip: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.sm,
    backgroundColor: colour.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colour.line,
  },
  issuerChipOn: { borderColor: colour.go, backgroundColor: colour.goDim },
  issuerChipText: { ...type.small, fontSize: 12, color: colour.textDim },
  issuerChipTextOn: { color: colour.text },

  toggle: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  toggleText: { flex: 1 },
  toggleLabel: { ...type.small, color: colour.text },
  toggleHint: { ...type.small, fontSize: 12, color: colour.textFaint, marginTop: 2 },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colour.line,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  checkboxOn: { backgroundColor: colour.go, borderColor: colour.go },
  checkmark: { ...type.smallStrong, fontSize: 12, color: colour.ground },

  hint: { ...type.label, color: colour.textDim },
  warn: { ...type.small, fontSize: 12, color: colour.warn },
  link: { ...type.smallStrong, fontSize: 13, color: colour.when },
  error: { ...type.small, color: colour.stop },
});
