/**
 * Banks — your bank bonuses, and the ones on offer.
 *
 * Two lists on one screen because bank churning is a shorter loop than card churning: you open an
 * account, meet a direct-deposit requirement, wait out a clawback window, close it, and go again.
 * Having the browse list beside your own accounts is the whole workflow.
 *
 * The browse list is filtered to what is actually actionable by default. Doctor of Credit's page runs
 * to 250 offers, 174 of which are limited to particular states and 10 of which are in-branch only —
 * so an unfiltered list is mostly things you cannot do, and the filter is not a nicety.
 */

import { useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';

import { api, type BankAccount, type BankOffer } from '@/api.ts';
import { useSession } from '@/session.tsx';
import { useLoad } from '@/useLoad.ts';
import { AccountRow, Button, Chip, ChipRow, Empty, Loading, Problem, Segments } from '@/components/ui.tsx';
import { colour, radius, space, tabular, type } from '@/theme.ts';
import { humanise, money, shortDateWithYear } from '@/format.ts';

type Tab = 'mine' | 'offers';

export default function Banks() {
  const session = useSession();
  const router = useRouter();
  const playerId = session.playerId ?? undefined;

  const [tab, setTab] = useState<Tab>('mine');
  const [search, setSearch] = useState('');
  const [nationwideOnly, setNationwideOnly] = useState(true);

  const loaded = useLoad<{ banks: BankAccount[]; offers: BankOffer[]; fetchedAt: string }>(async () => {
    const [mine, listed] = await Promise.all([api.banks(playerId), api.bankOffers()]);
    return { banks: mine.banks, offers: listed.offers, fetchedAt: listed.fetchedAt };
  }, [playerId]);

  const offers = useMemo(() => {
    const all = loaded.data?.offers ?? [];
    const needle = search.trim().toLowerCase();
    return all
      .filter((offer) => !offer.inBranchOnly)
      .filter((offer) => (nationwideOnly ? offer.states.length === 0 : true))
      .filter((offer) => needle === '' || offer.bankName.toLowerCase().includes(needle))
      // Biggest bonus first, which is the only order anybody browses these in.
      .sort((a, b) => b.bonusMaxCents - a.bonusMaxCents)
      .slice(0, 60);
  }, [loaded.data, search, nationwideOnly]);

  if (loaded.loading) return <Loading label="Loading bank bonuses" />;
  if (loaded.data === null) {
    return (
      <View style={styles.padded}>
        <Problem message={loaded.error ?? 'Could not load bank bonuses.'} onRetry={loaded.reload} />
      </View>
    );
  }

  const mine = loaded.data.banks;
  const open = mine.filter((account) => account.status === 'open');
  const earned = mine
    .filter((account) => account.bonusPostedAt !== null)
    .reduce((total, account) => total + account.bonusCents, 0);

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={loaded.refreshing} onRefresh={loaded.refresh} tintColor={colour.when} />
      }
    >
      <Segments<Tab>
        value={tab}
        onChange={setTab}
        options={[
          { value: 'mine', label: `Mine ${mine.length}` },
          { value: 'offers', label: 'Browse offers' },
        ]}
      />

      {tab === 'mine' ? (
        mine.length === 0 ? (
          <Empty
            title="No bank bonuses tracked"
            detail="Bank bonuses are the other half of churning, and the deadlines are tighter — a direct deposit window, then a period where closing costs you the bonus back."
            action={{ label: 'Add a bank account', onPress: () => router.push('/bank/new') }}
          />
        ) : (
          <>
            {earned > 0 ? (
              <Text style={styles.earned}>
                <Text style={[styles.earnedAmount, tabular]}>{money(earned)}</Text> collected across{' '}
                {mine.filter((account) => account.bonusPostedAt !== null).length} bonuses
              </Text>
            ) : null}

            <View>
              {mine.map((account) => (
                <BankRow key={account.id} account={account} />
              ))}
            </View>

            <Button label="Add a bank account" onPress={() => router.push('/bank/new')} />
          </>
        )
      ) : (
        <>
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search banks"
            placeholderTextColor={colour.textFaint}
            style={styles.search}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable
            onPress={() => setNationwideOnly((previous) => !previous)}
            style={styles.toggle}
            accessibilityRole="switch"
            accessibilityState={{ checked: nationwideOnly }}
          >
            <View style={[styles.checkbox, nationwideOnly && styles.checkboxOn]}>
              {nationwideOnly ? <Text style={styles.checkmark}>✓</Text> : null}
            </View>
            <Text style={styles.toggleLabel}>Nationwide only</Text>
          </Pressable>

          <View>
            {offers.map((offer) => (
              <OfferRow key={offer.id} offer={offer} onAdd={() => router.push(`/bank/new?offerId=${offer.id}`)} />
            ))}
          </View>

          <Text style={styles.footnote}>
            {loaded.data.offers.length} offers from Doctor of Credit, checked{' '}
            {loaded.data.fetchedAt === '' ? 'never' : shortDateWithYear(loaded.data.fetchedAt.slice(0, 10))}. Terms
            change without notice — read the bank's page before opening anything.
          </Text>
        </>
      )}
    </ScrollView>
  );
}

function BankRow({ account }: { account: BankAccount }) {
  const waiting = account.status === 'open' && account.bonusPostedAt === null;
  const tone =
    account.status === 'closed'
      ? colour.textFaint
      : account.bonusPostedAt !== null
        ? colour.go
        : colour.warn;

  return (
    <AccountRow
      issuer={humanise(account.accountType)}
      name={account.bankName}
      tone={tone}
      dimmed={account.status === 'closed'}
      right={
        <>
          <Text style={[styles.rightBonus, tabular]}>{money(account.bonusCents)}</Text>
          <Text style={styles.rightDate}>{shortDateWithYear(account.openedAt)}</Text>
        </>
      }
      detail={
        <ChipRow>
          {account.bonusPostedAt !== null ? (
            <Chip colour={colour.go}>Paid {shortDateWithYear(account.bonusPostedAt)}</Chip>
          ) : account.requirementsMetAt !== null ? (
            <Chip colour={colour.warn}>Requirements met — waiting</Chip>
          ) : waiting ? (
            <Chip colour={colour.warn}>Requirements outstanding</Chip>
          ) : null}
          {/* The date that matters most on a bank bonus, and the one people forget. */}
          {account.closeNotBeforeAt !== null && account.status === 'open' ? (
            <Chip colour={colour.when}>Hold until {shortDateWithYear(account.closeNotBeforeAt)}</Chip>
          ) : null}
          {account.monthlyFeeCents > 0 ? (
            <Chip colour={colour.stop}>{money(account.monthlyFeeCents)}/mo fee</Chip>
          ) : null}
          {account.status === 'closed' ? <Chip colour={colour.textFaint}>Closed</Chip> : null}
        </ChipRow>
      }
    />
  );
}

function OfferRow({ offer, onAdd }: { offer: BankOffer; onAdd: () => void }) {
  const requirements: string[] = [];
  if (offer.requirements.directDepositCents > 0) {
    requirements.push(`${money(offer.requirements.directDepositCents)} direct deposit`);
  } else if (!offer.directDepositRequired) {
    requirements.push('No direct deposit');
  }
  if (offer.requirements.minBalanceCents > 0) {
    requirements.push(`${money(offer.requirements.minBalanceCents)} balance`);
  }
  if (offer.requirements.debitTransactions > 0) {
    requirements.push(`${offer.requirements.debitTransactions} debit transactions`);
  }

  return (
    <Pressable onPress={onAdd} style={({ pressed }) => [styles.offer, pressed && styles.pressed]}>
      <View style={styles.offerHead}>
        <Text style={styles.offerBank} numberOfLines={1}>
          {offer.bankName}
        </Text>
        <Text style={[styles.offerBonus, tabular]}>
          {offer.bonusCents === offer.bonusMaxCents
            ? money(offer.bonusMaxCents)
            : `${money(offer.bonusCents)}–${money(offer.bonusMaxCents)}`}
        </Text>
      </View>
      {requirements.length > 0 ? <Text style={styles.offerRequirements}>{requirements.join(' · ')}</Text> : null}
      <ChipRow>
        <Chip>{humanise(offer.accountType)}</Chip>
        {/* Hard pull versus soft is the single fact that decides whether a bank bonus costs you an
            inquiry, which is what Citi and US Bank care about. It leads the chips for that reason. */}
        {offer.creditPull === 'hard' ? (
          <Chip colour={colour.stop} background={colour.stopDim}>
            Hard pull
          </Chip>
        ) : offer.creditPull === 'soft' ? (
          <Chip colour={colour.go}>Soft pull</Chip>
        ) : (
          <Chip colour={colour.textFaint}>Pull unknown</Chip>
        )}
        {offer.creditCardFundingCents > 0 ? (
          <Chip colour={offer.creditCardFundingCodesAsCashAdvance ? colour.stop : colour.go}>
            {money(offer.creditCardFundingCents)} card funding
            {offer.creditCardFundingCodesAsCashAdvance ? ' (cash advance)' : ''}
          </Chip>
        ) : null}
        {offer.chexSensitive ? <Chip colour={colour.warn}>ChexSystems sensitive</Chip> : null}
        {offer.churnCooldownMonths !== null ? (
          <Chip colour={colour.when}>Once per {offer.churnCooldownMonths}mo</Chip>
        ) : null}
      </ChipRow>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingBottom: space.xxxl, gap: space.lg },
  padded: { padding: space.lg },
  pressed: { opacity: 0.6 },

  earned: { ...type.small, color: colour.textDim },
  earnedAmount: { ...type.dataStrong, color: colour.go },

  rightBonus: { ...type.dataStrong, color: colour.text },
  rightDate: { ...type.dataSmall, fontSize: 11, color: colour.textFaint, marginTop: 2 },

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

  offer: {
    paddingVertical: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colour.lineSoft,
    gap: space.xs,
  },
  offerHead: { flexDirection: 'row', alignItems: 'baseline', gap: space.md },
  offerBank: { ...type.bodyStrong, color: colour.text, flex: 1 },
  offerBonus: { ...type.dataStrong, color: colour.go },
  offerRequirements: { ...type.small, fontSize: 12, color: colour.textDim },

  footnote: { ...type.small, fontSize: 12, color: colour.textFaint },
});
