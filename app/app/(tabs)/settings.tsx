/**
 * Settings — players, notifications, the server, and what this app knows about you.
 *
 * The last section is not boilerplate. This app asks for dates and dollar amounts and nothing else,
 * and that is a design decision worth stating where someone will actually read it: a tracker that
 * cannot be used to move money is a tracker whose breach is a nuisance rather than a catastrophe. If
 * a user is deciding whether to trust it, this is the screen they will look at.
 */

import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { api, currentBaseUrl, type HealthResponse } from '@/api.ts';
import { useSession } from '@/session.tsx';
import { useLoad } from '@/useLoad.ts';
import { currentPushToken, disablePush, enablePush } from '@/push.ts';
import { Button, Chip, Eyebrow, Field, Loading, Problem } from '@/components/ui.tsx';
import { colour, radius, space, tabular, type } from '@/theme.ts';
import { shortDateWithYear } from '@/format.ts';

export default function Settings() {
  const session = useSession();
  const router = useRouter();

  const [newPlayer, setNewPlayer] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [pushToken, setPushToken] = useState<string | null>(null);
  const [pushProblem, setPushProblem] = useState<string | null>(null);

  const loaded = useLoad<HealthResponse>(() => api.health(), []);

  useEffect(() => {
    void currentPushToken().then(setPushToken);
  }, []);

  const togglePush = useCallback(async () => {
    setBusy('push');
    setPushProblem(null);
    try {
      if (pushToken !== null) {
        await disablePush(pushToken);
        setPushToken(null);
      } else {
        const outcome = await enablePush();
        if (outcome.ok) setPushToken(outcome.token);
        else setPushProblem(outcome.detail);
      }
    } finally {
      setBusy(null);
    }
  }, [pushToken]);

  const addPlayer = useCallback(async () => {
    const name = newPlayer.trim();
    if (name === '') return;
    setBusy('player');
    try {
      await api.createPlayer(name);
      await session.refresh();
      setNewPlayer('');
    } finally {
      setBusy(null);
    }
  }, [newPlayer, session]);

  const removePlayer = useCallback(
    (id: string, name: string) => {
      // A confirm, because this deletes every card and bank account belonging to that person and
      // there is no undo. Named in the message so it cannot be misread as removing the current one.
      Alert.alert(
        `Delete ${name}?`,
        'Their cards, bank accounts and inquiries go with them. This cannot be undone.',
        [
          { text: 'Keep', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => {
              void (async () => {
                await api.deletePlayer(id);
                await session.refresh();
              })();
            },
          },
        ],
      );
    },
    [session],
  );

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={loaded.refreshing} onRefresh={loaded.refresh} tintColor={colour.when} />
      }
    >
      <View style={styles.section}>
        <Eyebrow>Who</Eyebrow>
        <Text style={styles.explain}>
          A second person runs a separate 5/24 count and a separate Amex history, sharing this login.
          Switching here changes every screen.
        </Text>

        {session.players.map((player) => {
          const active = player.id === session.playerId;
          return (
            <Pressable
              key={player.id}
              onPress={() => void session.selectPlayer(player.id)}
              style={[styles.playerRow, active && styles.playerRowActive]}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
            >
              <View style={styles.playerBody}>
                <Text style={[styles.playerName, active && styles.playerNameActive]}>{player.name}</Text>
                {player.primary ? <Text style={styles.playerCaption}>Primary</Text> : null}
              </View>
              {active ? <Chip colour={colour.when} background={colour.whenDim}>Showing</Chip> : null}
              {session.players.length > 1 && !player.primary ? (
                <Text
                  style={styles.remove}
                  accessibilityRole="button"
                  onPress={() => removePlayer(player.id, player.name)}
                  suppressHighlighting
                >
                  Delete
                </Text>
              ) : null}
            </Pressable>
          );
        })}

        <View style={styles.addPlayer}>
          <Field label="Add someone" value={newPlayer} onChangeText={setNewPlayer} placeholder="Partner" autoCapitalize="words" />
          <Button label="Add" onPress={() => void addPlayer()} kind="secondary" busy={busy === 'player'} disabled={newPlayer.trim() === ''} />
        </View>
      </View>

      <View style={styles.section}>
        <Eyebrow>Reminders</Eyebrow>
        <Text style={styles.explain}>
          One batch a day, and only for deadlines inside a week — at most three at a time, biggest
          amount first. Everything else waits on the Position screen.
        </Text>
        <Button
          label={pushToken !== null ? 'Turn off notifications' : 'Turn on notifications'}
          onPress={() => void togglePush()}
          kind={pushToken !== null ? 'secondary' : 'primary'}
          busy={busy === 'push'}
        />
        {pushProblem !== null ? <Text style={styles.problem}>{pushProblem}</Text> : null}
        {pushToken !== null ? <Text style={styles.ok}>This device is registered.</Text> : null}
      </View>

      <View style={styles.section}>
        <Eyebrow>Server</Eyebrow>
        <Text style={[styles.address, tabular]}>{currentBaseUrl()}</Text>

        {loaded.loading ? (
          <Loading />
        ) : loaded.data === null ? (
          <Problem message={loaded.error ?? 'The server is not answering.'} onRetry={loaded.reload} />
        ) : (
          <View style={styles.facts}>
            <Fact label="Card catalog" value={`${loaded.data.catalog.cards} cards`} />
            <Fact
              label="Live card offers"
              value={`${loaded.data.offers.cards}`}
              caption={
                loaded.data.offers.cardsFetchedAt === null
                  ? 'never fetched'
                  : `checked ${shortDateWithYear(loaded.data.offers.cardsFetchedAt.slice(0, 10))}`
              }
            />
            <Fact label="Live bank offers" value={`${loaded.data.offers.banks}`} />
            <Fact
              label="Flowchart"
              value={loaded.data.flowchart.version.replace('Card Recommendation Flowchart ', '')}
              caption={
                loaded.data.flowchart.updatedAt === null
                  ? undefined
                  : `updated ${shortDateWithYear(loaded.data.flowchart.updatedAt)}`
              }
            />
            {loaded.data.registrationOpen ? (
              <Text style={styles.warn}>
                Registration is open on this server. Anyone who can reach it can create an account.
              </Text>
            ) : null}
          </View>
        )}
      </View>

      <View style={styles.section}>
        <Eyebrow>What this app knows</Eyebrow>
        <Text style={styles.explain}>
          Dates and amounts you typed in, and your email and password. That is all of it — there are no
          account numbers, no balances, no transaction feed and no connection to any bank. This app
          cannot see or move your money, and could not be used to.
        </Text>
        <Text style={styles.explain}>
          The rules it applies are community-observed behaviour, not issuer policy. They change without
          notice and every one of them is overridable. You are the one who gets denied, so the last
          word is yours.
        </Text>
      </View>

      <View style={styles.section}>
        <Eyebrow>Account</Eyebrow>
        {session.user !== null ? <Text style={[styles.address, tabular]}>{session.user.email}</Text> : null}
        <Button
          label="Sign out"
          kind="secondary"
          onPress={() => {
            void (async () => {
              await session.signOut();
              router.replace('/sign-in');
            })();
          }}
        />
      </View>
    </ScrollView>
  );
}

function Fact({ label, value, caption }: { label: string; value: string; caption?: string }) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{label}</Text>
      <View style={styles.factRight}>
        <Text style={[styles.factValue, tabular]}>{value}</Text>
        {caption !== undefined ? <Text style={styles.factCaption}>{caption}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingBottom: space.xxxl, gap: space.xxl },
  section: { gap: space.md },
  explain: { ...type.small, color: colour.textDim },

  playerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    backgroundColor: colour.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colour.line,
  },
  playerRowActive: { borderColor: colour.when },
  playerBody: { flex: 1 },
  playerName: { ...type.bodyStrong, color: colour.textDim },
  playerNameActive: { color: colour.text },
  playerCaption: { ...type.label, fontSize: 9, color: colour.textFaint, marginTop: 2 },
  remove: { ...type.smallStrong, fontSize: 12, color: colour.stop },
  addPlayer: { gap: space.sm },

  problem: { ...type.small, color: colour.stop },
  ok: { ...type.small, color: colour.go },
  warn: { ...type.small, color: colour.warn },

  address: { ...type.dataSmall, color: colour.textDim },
  facts: { gap: 0 },
  fact: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colour.lineSoft,
    gap: space.md,
  },
  factLabel: { ...type.small, color: colour.textDim },
  factRight: { alignItems: 'flex-end' },
  factValue: { ...type.dataStrong, color: colour.text },
  factCaption: { ...type.dataSmall, fontSize: 10, color: colour.textFaint },
});
