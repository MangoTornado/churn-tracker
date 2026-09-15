/**
 * One card: its dates, its bonus progress, and what it is costing you.
 *
 * Editing is inline and per-field rather than a form with a Save button, because the edits people
 * actually make here are single corrections — a spend figure after a statement, a close date, an
 * annual fee date read off a bill. A whole-form save would make every one of those a four-tap
 * operation and would make a mistyped field roll back the other three.
 */

import { useCallback, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { api, ApiError, type CardAccount, type CatalogResponse } from '@/api.ts';
import { useSession } from '@/session.tsx';
import { useLoad } from '@/useLoad.ts';
import { Button, Chip, ChipRow, Eyebrow, Field, Loading, Problem, SpendBar } from '@/components/ui.tsx';
import { colour, radius, space, tabular, type } from '@/theme.ts';
import { bonusText, humanise, money, shortDateWithYear, spendProgress } from '@/format.ts';

export default function CardDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const session = useSession();
  const router = useRouter();
  const playerId = session.playerId ?? undefined;

  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loaded = useLoad<{ card: CardAccount; catalog: CatalogResponse }>(async () => {
    const [card, catalog] = await Promise.all([api.card(id, playerId), api.catalog()]);
    return { card: card.card, catalog };
  }, [id, playerId]);

  const patch = useCallback(
    async (body: Record<string, unknown>) => {
      setSaving(true);
      setError(null);
      try {
        await api.updateCard(id, body, playerId);
        setEditing(null);
        loaded.refresh();
      } catch (problem) {
        setError(problem instanceof ApiError ? problem.message : 'Could not save that.');
      } finally {
        setSaving(false);
      }
    },
    [id, playerId, loaded],
  );

  const remove = useCallback(() => {
    Alert.alert(
      'Delete this card?',
      'If you actually held it, close it instead — a closed card still counts toward 5/24 and deleting it will give you a wrong count.',
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              await api.deleteCard(id, playerId);
              router.back();
            })();
          },
        },
      ],
    );
  }, [id, playerId, router]);

  if (loaded.loading) return <Loading />;
  if (loaded.data === null) {
    return (
      <View style={styles.padded}>
        <Problem message={loaded.error ?? 'Could not load this card.'} onRetry={loaded.reload} />
      </View>
    );
  }

  const { card, catalog } = loaded.data;
  const bonus = card.bonus;
  const working = bonus !== null && bonus.earnedAt === null;
  const progress = bonus === null ? 0 : spendProgress(bonus.spentCents, bonus.minSpendCents);
  const catalogCard = card.cardId === null ? null : catalog.cards.find((entry) => entry.id === card.cardId);

  const startEdit = (key: string, current: string): void => {
    setEditing(key);
    setDraft(current);
    setError(null);
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
      <ScrollView contentContainerStyle={styles.content}>
        <View>
          <Text style={styles.issuer}>{catalog.issuers[card.issuer] ?? card.issuer}</Text>
          <Text style={styles.name}>{card.cardName}</Text>
          <ChipRow>
            <Chip colour={card.status === 'open' ? colour.go : colour.textFaint}>{humanise(card.status)}</Chip>
            {card.productType === 'business' ? <Chip>Business</Chip> : null}
            {card.authorizedUser ? <Chip colour={colour.when}>Authorized user</Chip> : null}
            {card.counts524 ? (
              <Chip colour={colour.when} background={colour.whenDim} notation>
                Costs a 5/24 slot
              </Chip>
            ) : (
              <Chip colour={colour.go}>Invisible to 5/24</Chip>
            )}
            {catalogCard?.familyLabel !== undefined && catalogCard.familyLabel !== '' ? (
              <Chip colour={colour.textDim}>{catalogCard.familyLabel} family</Chip>
            ) : null}
          </ChipRow>
        </View>

        {working && bonus.minSpendCents > 0 ? (
          <View style={styles.spendBlock}>
            <View style={styles.spendHead}>
              <Text style={styles.spendTitle}>{bonusText(bonus.amount, bonus.unit)} bonus</Text>
              <Text style={[styles.spendNumbers, tabular]}>
                {money(bonus.spentCents)} / {money(bonus.minSpendCents)}
              </Text>
            </View>
            <SpendBar progress={progress} tone={progress >= 1 ? colour.go : colour.warn} />
            <Text style={styles.spendCaption}>
              {progress >= 1
                ? 'Minimum spend met. The bonus usually posts within a statement cycle or two.'
                : `${money(bonus.minSpendCents - bonus.spentCents)} to go, within ${bonus.spendWindowDays} days of opening.`}
            </Text>

            {editing === 'spent' ? (
              <View style={styles.inlineEdit}>
                <Field label="Spent so far, in dollars" value={draft} onChangeText={setDraft} keyboardType="numeric" error={error} />
                <View style={styles.inlineButtons}>
                  <Button
                    label="Save"
                    busy={saving}
                    onPress={() =>
                      void patch({
                        bonus: { ...bonus, spentCents: Math.round(Number(draft.replace(/[^\d.]/g, '')) * 100) },
                      })
                    }
                  />
                  <Button label="Cancel" kind="secondary" onPress={() => setEditing(null)} />
                </View>
              </View>
            ) : (
              <View style={styles.inlineButtons}>
                <Button
                  label="Update spend"
                  kind="secondary"
                  onPress={() => startEdit('spent', String(bonus.spentCents / 100))}
                />
                {progress >= 1 ? (
                  <Button
                    label="Bonus posted"
                    onPress={() => void patch({ bonus: { ...bonus, earnedAt: new Date().toISOString().slice(0, 10) } })}
                  />
                ) : null}
              </View>
            )}
          </View>
        ) : null}

        <View style={styles.section}>
          <Eyebrow>Dates</Eyebrow>
          <EditableRow
            label="Applied"
            value={shortDateWithYear(card.appliedAt)}
            onEdit={() => startEdit('appliedAt', card.appliedAt ?? '')}
            editing={editing === 'appliedAt'}
            draft={draft}
            setDraft={setDraft}
            onSave={() => void patch({ appliedAt: draft.trim() === '' ? null : draft.trim() })}
            onCancel={() => setEditing(null)}
            saving={saving}
            error={error}
          />
          <EditableRow
            label="Opened"
            value={shortDateWithYear(card.openedAt)}
            caption="What 5/24 counts"
            onEdit={() => startEdit('openedAt', card.openedAt ?? '')}
            editing={editing === 'openedAt'}
            draft={draft}
            setDraft={setDraft}
            onSave={() => void patch({ openedAt: draft.trim() === '' ? null : draft.trim() })}
            onCancel={() => setEditing(null)}
            saving={saving}
            error={error}
          />
          <EditableRow
            label="Next annual fee"
            value={card.nextAnnualFeeAt !== null ? shortDateWithYear(card.nextAnnualFeeAt) : 'estimated from the open date'}
            caption={card.annualFeeCents > 0 ? money(card.annualFeeCents) : 'no fee'}
            onEdit={() => startEdit('nextAnnualFeeAt', card.nextAnnualFeeAt ?? '')}
            editing={editing === 'nextAnnualFeeAt'}
            draft={draft}
            setDraft={setDraft}
            onSave={() => void patch({ nextAnnualFeeAt: draft.trim() === '' ? null : draft.trim() })}
            onCancel={() => setEditing(null)}
            saving={saving}
            error={error}
          />
          <EditableRow
            label="Last used"
            value={shortDateWithYear(card.lastUsedAt)}
            caption={card.annualFeeCents === 0 ? 'Idle no-fee cards get auto-closed' : undefined}
            onEdit={() => startEdit('lastUsedAt', card.lastUsedAt ?? '')}
            editing={editing === 'lastUsedAt'}
            draft={draft}
            setDraft={setDraft}
            onSave={() => void patch({ lastUsedAt: draft.trim() === '' ? null : draft.trim() })}
            onCancel={() => setEditing(null)}
            saving={saving}
            error={error}
          />
          {card.closedAt !== null ? (
            <EditableRow
              label="Closed"
              value={shortDateWithYear(card.closedAt)}
              onEdit={() => startEdit('closedAt', card.closedAt ?? '')}
              editing={editing === 'closedAt'}
              draft={draft}
              setDraft={setDraft}
              onSave={() => void patch({ closedAt: draft.trim() === '' ? null : draft.trim() })}
              onCancel={() => setEditing(null)}
              saving={saving}
              error={error}
            />
          ) : null}
        </View>

        {card.notes !== '' ? (
          <View style={styles.section}>
            <Eyebrow>Notes</Eyebrow>
            <Text style={styles.notes}>{card.notes}</Text>
          </View>
        ) : null}

        <View style={styles.section}>
          {card.status === 'open' ? (
            <Button
              label="Mark as closed"
              kind="secondary"
              onPress={() =>
                void patch({ status: 'closed', closedAt: new Date().toISOString().slice(0, 10) })
              }
            />
          ) : null}
          <Button label="Delete" kind="danger" onPress={remove} />
          <Text style={styles.deleteNote}>
            Deleting is for a card entered by mistake. If you held it, close it — 5/24 counts closed
            accounts too.
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function EditableRow({
  label,
  value,
  caption,
  onEdit,
  editing,
  draft,
  setDraft,
  onSave,
  onCancel,
  saving,
  error,
}: {
  label: string;
  value: string;
  caption?: string;
  onEdit: () => void;
  editing: boolean;
  draft: string;
  setDraft: (next: string) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  error: string | null;
}) {
  if (editing) {
    return (
      <View style={styles.inlineEdit}>
        <Field
          label={label}
          value={draft}
          onChangeText={setDraft}
          placeholder="2025-03-14"
          keyboardType="numeric"
          error={error}
        />
        <View style={styles.inlineButtons}>
          <Button label="Save" onPress={onSave} busy={saving} />
          <Button label="Cancel" kind="secondary" onPress={onCancel} />
        </View>
      </View>
    );
  }

  return (
    <Pressable onPress={onEdit} style={styles.row} accessibilityRole="button">
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.rowRight}>
        <Text style={[styles.rowValue, tabular]}>{value}</Text>
        {caption !== undefined ? <Text style={styles.rowCaption}>{caption}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colour.ground },
  content: { padding: space.lg, paddingBottom: space.xxxl, gap: space.xl },
  padded: { padding: space.lg },
  section: { gap: space.md },

  issuer: { ...type.label, color: colour.textDim },
  name: { ...type.title, color: colour.text, marginTop: space.xs, marginBottom: space.md },

  spendBlock: {
    padding: space.lg,
    backgroundColor: colour.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colour.line,
    gap: space.sm,
  },
  spendHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: space.sm },
  spendTitle: { ...type.bodyStrong, color: colour.text },
  spendNumbers: { ...type.dataStrong, color: colour.warn },
  spendCaption: { ...type.small, fontSize: 12, color: colour.textDim },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colour.lineSoft,
    gap: space.md,
  },
  rowLabel: { ...type.small, color: colour.textDim },
  rowRight: { alignItems: 'flex-end' },
  rowValue: { ...type.dataStrong, color: colour.text },
  rowCaption: { ...type.dataSmall, fontSize: 10, color: colour.textFaint, marginTop: 2 },

  inlineEdit: { gap: space.sm, paddingVertical: space.sm },
  inlineButtons: { flexDirection: 'row', gap: space.sm },

  notes: { ...type.body, color: colour.textDim },
  deleteNote: { ...type.small, fontSize: 12, color: colour.textFaint },
});
