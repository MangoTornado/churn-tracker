/**
 * Cards — the portfolio, as a ledger of counterparties.
 *
 * Sorted by what needs attention rather than by date opened: a card with an unmet minimum spend
 * comes first, then one with a fee approaching, then everything else newest-first, then closed cards
 * at the bottom in a collapsed group. Sorting by open date would be tidier and would bury the two
 * cards that actually need something this week.
 *
 * No card artwork, deliberately. Someone with fifteen cards is scanning for an issuer and a date,
 * and artwork would take the left edge of every row to carry one bit of information. The issuer is
 * set as a letterspaced mono label instead, which makes it a column you can run your eye down.
 */

import { useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { api, type CardAccount, type CatalogResponse } from '@/api.ts';
import { useSession } from '@/session.tsx';
import { useLoad } from '@/useLoad.ts';
import {
  AccountRow,
  Button,
  Chip,
  ChipRow,
  Empty,
  Eyebrow,
  Loading,
  Problem,
  Segments,
  SpendBar,
} from '@/components/ui.tsx';
import { colour, space, tabular, type } from '@/theme.ts';
import { bonusText, humanise, money, shortDateWithYear, spendProgress } from '@/format.ts';

type Filter = 'open' | 'all' | 'closed';

export default function Cards() {
  const session = useSession();
  const router = useRouter();
  const playerId = session.playerId ?? undefined;
  const [filter, setFilter] = useState<Filter>('open');

  const loaded = useLoad<{ cards: CardAccount[]; catalog: CatalogResponse }>(async () => {
    const [cards, catalog] = await Promise.all([api.cards(playerId), api.catalog()]);
    return { cards: cards.cards, catalog };
  }, [playerId]);

  const issuers = loaded.data?.catalog.issuers;

  const shown = useMemo(() => {
    const all = loaded.data?.cards ?? [];
    const live = all.filter((card) => card.status !== 'closed' && card.status !== 'denied');
    const gone = all.filter((card) => card.status === 'closed' || card.status === 'denied');
    const list = filter === 'open' ? live : filter === 'closed' ? gone : all;
    return list.slice().sort(byAttention);
  }, [loaded.data, filter]);

  if (loaded.loading) return <Loading label="Loading your cards" />;
  if (loaded.data === null) {
    return (
      <View style={styles.padded}>
        <Problem message={loaded.error ?? 'Could not load your cards.'} onRetry={loaded.reload} />
      </View>
    );
  }

  const all = loaded.data.cards;
  const openCount = all.filter((card) => card.status === 'open' || card.status === 'approved').length;
  const feeTotal = all
    .filter((card) => card.status === 'open' || card.status === 'approved')
    .reduce((total, card) => total + card.annualFeeCents, 0);

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={loaded.refreshing} onRefresh={loaded.refresh} tintColor={colour.when} />
      }
    >
      {all.length === 0 ? (
        <Empty
          title="No cards yet"
          detail="Add the cards you already hold, including closed ones. The closed ones matter — a card you closed last year still counts against 5/24."
          action={{ label: 'Add a card', onPress: () => router.push('/card/new') }}
        />
      ) : (
        <>
          <View style={styles.header}>
            <Segments<Filter>
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'open', label: `Open ${openCount}` },
                { value: 'closed', label: 'Closed' },
                { value: 'all', label: `All ${all.length}` },
              ]}
            />
            {feeTotal > 0 ? (
              <Text style={styles.feeTotal}>
                <Text style={[styles.feeAmount, tabular]}>{money(feeTotal)}</Text> in annual fees
              </Text>
            ) : null}
          </View>

          <View style={styles.list}>
            {shown.length === 0 ? (
              <Text style={styles.none}>Nothing here.</Text>
            ) : (
              shown.map((card) => (
                <CardListRow
                  key={card.id}
                  card={card}
                  issuerName={issuers?.[card.issuer] ?? card.issuer}
                  onPress={() => router.push(`/card/${card.id}`)}
                />
              ))
            )}
          </View>

          <View style={styles.actions}>
            <Button label="Add a card" onPress={() => router.push('/card/new')} />
          </View>

          <View style={styles.note}>
            <Eyebrow>Why closed cards stay</Eyebrow>
            <Text style={styles.noteText}>
              5/24 counts accounts opened in the last 24 months, open or closed. Closing a card does
              not free a slot, so deleting it here would give you a wrong count.
            </Text>
          </View>
        </>
      )}
    </ScrollView>
  );
}

function CardListRow({
  card,
  issuerName,
  onPress,
}: {
  card: CardAccount;
  issuerName: string;
  onPress: () => void;
}) {
  const closed = card.status === 'closed' || card.status === 'denied';
  const bonus = card.bonus;
  const working = bonus !== null && bonus.earnedAt === null && bonus.minSpendCents > 0;
  const progress = working ? spendProgress(bonus.spentCents, bonus.minSpendCents) : 1;

  const tone = closed
    ? colour.textFaint
    : working && progress < 1
      ? colour.warn
      : card.counts524
        ? colour.when
        : colour.go;

  return (
    <AccountRow
      issuer={issuerName}
      name={card.cardName}
      tone={tone}
      dimmed={closed}
      onPress={onPress}
      right={
        <>
          {card.annualFeeCents > 0 ? (
            <Text style={[styles.rightFee, tabular]}>{money(card.annualFeeCents)}</Text>
          ) : (
            <Text style={styles.rightNoFee}>no fee</Text>
          )}
          <Text style={styles.rightDate}>{shortDateWithYear(card.openedAt)}</Text>
        </>
      }
      detail={
        <>
          <ChipRow>
            {card.productType === 'business' ? <Chip>Business</Chip> : null}
            {card.authorizedUser ? <Chip colour={colour.when}>Authorized user</Chip> : null}
            {/* The only chip that earns its space on every row: whether this card is costing a
                5/24 slot is the single most consequential fact about it. */}
            {!closed && card.counts524 ? (
              <Chip colour={colour.when} background={colour.whenDim} notation>
                5/24
              </Chip>
            ) : null}
            {!closed && !card.counts524 ? <Chip colour={colour.go}>Invisible to 5/24</Chip> : null}
            {closed ? <Chip colour={colour.textFaint}>{humanise(card.status)}</Chip> : null}
            {bonus !== null && bonus.earnedAt !== null ? (
              <Chip colour={colour.go}>{bonusText(bonus.amount, bonus.unit)} earned</Chip>
            ) : null}
          </ChipRow>

          {working ? (
            <View style={styles.spend}>
              <SpendBar progress={progress} tone={progress >= 1 ? colour.go : colour.warn} />
              <Text style={styles.spendText}>
                {money(bonus.spentCents)} of {money(bonus.minSpendCents)} minimum spend
                {progress >= 1 ? ' — met, waiting on the bonus' : ''}
              </Text>
            </View>
          ) : null}
        </>
      }
    />
  );
}

/**
 * Sorts by what needs attention.
 *
 * A card with an unmet minimum spend has a hard deadline and a forfeitable bonus, so it leads. Then
 * fee-paying cards, then the rest newest-first, with closed accounts last. Ties break on open date
 * so the order is stable between renders.
 */
function byAttention(a: CardAccount, b: CardAccount): number {
  const rank = (card: CardAccount): number => {
    if (card.status === 'closed' || card.status === 'denied') return 3;
    const working = card.bonus !== null && card.bonus.earnedAt === null && card.bonus.minSpendCents > 0;
    if (working) return 0;
    if (card.annualFeeCents > 0) return 1;
    return 2;
  };

  const difference = rank(a) - rank(b);
  if (difference !== 0) return difference;
  return (b.openedAt ?? '').localeCompare(a.openedAt ?? '');
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingBottom: space.xxxl, gap: space.lg },
  padded: { padding: space.lg },

  header: { gap: space.sm },
  feeTotal: { ...type.small, color: colour.textDim },
  feeAmount: { ...type.dataStrong, color: colour.warn },

  list: { gap: 0 },
  none: { ...type.body, color: colour.textFaint, paddingVertical: space.lg },

  rightFee: { ...type.dataStrong, color: colour.warn },
  rightNoFee: { ...type.label, fontSize: 9, color: colour.textFaint },
  rightDate: { ...type.dataSmall, fontSize: 11, color: colour.textFaint, marginTop: 2 },

  spend: { marginTop: space.sm, gap: space.xs },
  spendText: { ...type.dataSmall, fontSize: 11, color: colour.textDim },

  actions: { marginTop: space.xs },
  note: { gap: space.sm, marginTop: space.lg },
  noteText: { ...type.small, color: colour.textFaint },
});
