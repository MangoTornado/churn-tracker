/**
 * Add a bank account.
 *
 * Prefilled from a Doctor of Credit offer when you arrived from the browse list, because the fields it
 * fills in are the ones nobody remembers to type: the bonus amount, the direct-deposit requirement, and
 * the hold period. Everything stays editable — the offer is a snapshot of someone else's summary of a
 * bank's fine print, and the fine print is what actually binds.
 *
 * The safe-to-close date is filled in whether or not there is an offer, defaulted to six months. That
 * is the field this whole screen exists for: closing too early claws the bonus back, and leaving it
 * open lets a monthly fee eat it, so a bank bonus is a pair of dates and everything else is detail.
 */

import { useEffect, useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { api, ApiError, type BankOffer } from '@/api.ts';
import { useSession } from '@/session.tsx';
import { useLoad } from '@/useLoad.ts';
import { Button, Chip, ChipRow, Eyebrow, Field, Loading, Segments } from '@/components/ui.tsx';
import { colour, radius, space, type } from '@/theme.ts';
import { money } from '@/format.ts';

type AccountType = 'checking' | 'savings' | 'business-checking' | 'business-savings';

export default function NewBank() {
  const { offerId } = useLocalSearchParams<{ offerId?: string }>();
  const session = useSession();
  const router = useRouter();
  const playerId = session.playerId ?? undefined;

  const offers = useLoad<BankOffer[]>(async () => (await api.bankOffers()).offers, []);
  const offer = useMemo(
    () => offers.data?.find((entry) => entry.id === offerId) ?? null,
    [offers.data, offerId],
  );

  const [bankName, setBankName] = useState('');
  const [accountType, setAccountType] = useState<AccountType>('checking');
  const [openedAt, setOpenedAt] = useState(new Date().toISOString().slice(0, 10));
  const [bonus, setBonus] = useState('');
  const [directDeposit, setDirectDeposit] = useState('');
  const [holdDays, setHoldDays] = useState('');
  const [monthlyFee, setMonthlyFee] = useState('');
  const [closeNotBefore, setCloseNotBefore] = useState('');
  const [notes, setNotes] = useState('');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Prefilled once the offer arrives, and only into fields the user has not touched — an effect that
  // overwrote edits would fight anyone who typed while the request was in flight.
  useEffect(() => {
    if (offer === null) return;
    setBankName((current) => (current === '' ? offer.bankName : current));
    setAccountType((current) =>
      current === 'checking' && offer.accountType !== 'brokerage' ? (offer.accountType as AccountType) : current,
    );
    setBonus((current) => (current === '' ? String(offer.bonusCents / 100) : current));
    setDirectDeposit((current) =>
      current === '' && offer.requirements.directDepositCents > 0
        ? String(offer.requirements.directDepositCents / 100)
        : current,
    );
    setHoldDays((current) =>
      current === '' && offer.requirements.holdDays > 0 ? String(offer.requirements.holdDays) : current,
    );
  }, [offer]);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    setFieldError(null);
    try {
      const dollars = (raw: string): number =>
        raw.trim() === '' ? 0 : Math.round(Number(raw.replace(/[^\d.]/g, '')) * 100);

      await api.createBank(
        {
          offerId: offer?.id ?? null,
          bankName,
          accountType,
          status: 'open',
          openedAt: openedAt.trim(),
          bonusCents: dollars(bonus),
          requirements: {
            directDepositCents: dollars(directDeposit),
            holdDays: holdDays.trim() === '' ? 0 : Number(holdDays.replace(/[^\d]/g, '')),
          },
          monthlyFeeCents: dollars(monthlyFee),
          closeNotBeforeAt: closeNotBefore.trim() === '' ? null : closeNotBefore.trim(),
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
        setError('Could not save this account.');
      }
    } finally {
      setSaving(false);
    }
  };

  if (offerId !== undefined && offers.loading) return <Loading label="Loading the offer" />;

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {offer !== null ? (
          <View style={styles.offer}>
            <Eyebrow>From Doctor of Credit</Eyebrow>
            <Text style={styles.offerBonus}>
              {offer.bonusCents === offer.bonusMaxCents
                ? money(offer.bonusMaxCents)
                : `${money(offer.bonusCents)}–${money(offer.bonusMaxCents)}`}
            </Text>
            <ChipRow>
              {offer.creditPull === 'hard' ? (
                <Chip colour={colour.stop} background={colour.stopDim}>
                  Hard pull — costs you an inquiry
                </Chip>
              ) : offer.creditPull === 'soft' ? (
                <Chip colour={colour.go}>Soft pull</Chip>
              ) : (
                <Chip colour={colour.textFaint}>Pull unknown</Chip>
              )}
              {offer.churnCooldownMonths !== null ? (
                <Chip colour={colour.when}>Once every {offer.churnCooldownMonths} months</Chip>
              ) : null}
            </ChipRow>
            {offer.notes !== '' ? (
              <Text style={styles.offerNotes} numberOfLines={4}>
                {offer.notes}
              </Text>
            ) : null}
            {offer.url !== '' ? (
              <Pressable onPress={() => void openUrl(offer.url)}>
                <Text style={styles.link}>Open the offer page</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        <View style={styles.section}>
          <Field
            label="Bank"
            value={bankName}
            onChangeText={setBankName}
            placeholder="U.S. Bank"
            autoCapitalize="words"
            error={fieldError === 'bankName' ? error : null}
          />
          <Segments<AccountType>
            value={accountType}
            onChange={setAccountType}
            options={[
              { value: 'checking', label: 'Checking' },
              { value: 'savings', label: 'Savings' },
              { value: 'business-checking', label: 'Business' },
            ]}
          />
          <Field
            label="Opened"
            value={openedAt}
            onChangeText={setOpenedAt}
            placeholder="2026-09-14"
            keyboardType="numeric"
            error={fieldError === 'openedAt' ? error : null}
          />
        </View>

        <View style={styles.section}>
          <Eyebrow>The bonus</Eyebrow>
          <Field label="Bonus in dollars" value={bonus} onChangeText={setBonus} placeholder="450" keyboardType="numeric" />
          <Field
            label="Direct deposit needed, in dollars"
            value={directDeposit}
            onChangeText={setDirectDeposit}
            placeholder="2000"
            keyboardType="numeric"
            hint="Leave blank if none is required."
          />
          <Field
            label="Days to meet the requirements"
            value={holdDays}
            onChangeText={setHoldDays}
            placeholder="90"
            keyboardType="numeric"
            hint="From the offer's fine print. Drives the deadline reminder."
          />
        </View>

        <View style={styles.section}>
          <Eyebrow>Closing it</Eyebrow>
          <Field
            label="Do not close before"
            value={closeNotBefore}
            onChangeText={setCloseNotBefore}
            placeholder="leave blank for six months out"
            keyboardType="numeric"
            hint="Closing early claws the bonus back or triggers a fee. Some banks count from opening, some from when the bonus posts — put the real date in."
          />
          <Field
            label="Monthly fee in dollars"
            value={monthlyFee}
            onChangeText={setMonthlyFee}
            placeholder="0"
            keyboardType="numeric"
            hint="If there is one, you will be reminded to close as soon as it is safe."
          />
        </View>

        <Field label="Notes" value={notes} onChangeText={setNotes} placeholder="Fee waived with a $1,500 balance" autoCapitalize="sentences" />

        {error !== null && fieldError === null ? <Text style={styles.error}>{error}</Text> : null}

        <Button label="Save account" onPress={() => void save()} busy={saving} disabled={bankName.trim() === ''} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** Opens a bank's offer page in the browser. Imported lazily so the web build does not need Linking. */
async function openUrl(url: string): Promise<void> {
  const Linking = await import('expo-linking');
  await Linking.openURL(url).catch(() => undefined);
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colour.ground },
  content: { padding: space.lg, paddingBottom: space.xxxl, gap: space.xl },
  section: { gap: space.md },

  offer: {
    padding: space.lg,
    backgroundColor: colour.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colour.line,
    gap: space.sm,
  },
  offerBonus: { ...type.title, fontSize: 22, color: colour.go },
  offerNotes: { ...type.small, fontSize: 12, color: colour.textDim },
  link: { ...type.smallStrong, fontSize: 13, color: colour.when },
  error: { ...type.small, color: colour.stop },
});
