/**
 * The signed-in session, and which player is being looked at.
 *
 * The token goes in SecureStore on a phone — Keychain on iOS, EncryptedSharedPreferences on Android
 * — and falls back to AsyncStorage on the web, where SecureStore does not exist. That fallback is a
 * real downgrade and is worth naming: on the web the token sits in localStorage where any script on
 * the origin can read it. It is the same trade every web app makes, and the mitigation is that this
 * origin serves nothing but the app.
 *
 * The selected player lives here too rather than in each screen, because it is the one piece of
 * state every screen needs and the one that must not disagree between them: seeing your partner's
 * 5/24 count next to your own reminders would be worse than useless.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import { api, loadBaseUrl, setToken, type Player, type User } from './api.ts';

const TOKEN_KEY = 'churn-tracker.token';
const PLAYER_KEY = 'churn-tracker.playerId';

/** SecureStore where it exists, AsyncStorage where it does not. See the header. */
const secure = {
  get: (key: string): Promise<string | null> =>
    Platform.OS === 'web' ? AsyncStorage.getItem(key) : SecureStore.getItemAsync(key),
  set: (key: string, value: string): Promise<void> =>
    Platform.OS === 'web' ? AsyncStorage.setItem(key, value) : SecureStore.setItemAsync(key, value),
  remove: (key: string): Promise<void> =>
    Platform.OS === 'web' ? AsyncStorage.removeItem(key) : SecureStore.deleteItemAsync(key),
};

interface SessionValue {
  /** Null while the stored token is still being read — distinct from "signed out". */
  ready: boolean;
  user: User | null;
  players: Player[];
  playerId: string | null;
  player: Player | null;
  signIn(email: string, password: string): Promise<void>;
  register(email: string, password: string, name: string): Promise<void>;
  signOut(): Promise<void>;
  selectPlayer(id: string): Promise<void>;
  /** Re-reads the account after a change to players. */
  refresh(): Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [playerId, setPlayerId] = useState<string | null>(null);

  const adopt = useCallback(async (nextUser: User, nextPlayers: Player[]) => {
    setUser(nextUser);
    setPlayers(nextPlayers);

    // Keep the stored selection if it still exists, so restarting the app does not silently switch
    // which person you are looking at.
    const stored = await AsyncStorage.getItem(PLAYER_KEY);
    const keep = nextPlayers.find((entry) => entry.id === stored);
    setPlayerId(keep?.id ?? nextPlayers.find((entry) => entry.primary)?.id ?? nextPlayers[0]?.id ?? null);
  }, []);

  useEffect(() => {
    void (async () => {
      await loadBaseUrl();
      const stored = await secure.get(TOKEN_KEY);
      if (stored !== null) {
        setToken(stored);
        try {
          const me = await api.me();
          await adopt(me.user, me.players);
        } catch {
          // An expired or revoked token, or a server that has moved. Either way the stored token is
          // no longer usable, and holding on to it would mean a permanently broken launch.
          setToken(null);
          await secure.remove(TOKEN_KEY);
        }
      }
      setReady(true);
    })();
  }, [adopt]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const session = await api.signIn(email, password);
      setToken(session.token);
      await secure.set(TOKEN_KEY, session.token);
      await adopt(session.user, session.players);
    },
    [adopt],
  );

  const register = useCallback(
    async (email: string, password: string, name: string) => {
      const session = await api.register(email, password, name);
      setToken(session.token);
      await secure.set(TOKEN_KEY, session.token);
      await adopt(session.user, session.players);
    },
    [adopt],
  );

  const signOut = useCallback(async () => {
    // Told to the server first so the session row is actually deleted, but not waited on for
    // correctness: if the request fails the local token is dropped regardless, because a sign-out
    // that leaves you signed in is the wrong failure.
    await api.signOut().catch(() => undefined);
    setToken(null);
    await secure.remove(TOKEN_KEY);
    setUser(null);
    setPlayers([]);
    setPlayerId(null);
  }, []);

  const selectPlayer = useCallback(async (id: string) => {
    setPlayerId(id);
    await AsyncStorage.setItem(PLAYER_KEY, id);
  }, []);

  const refresh = useCallback(async () => {
    const me = await api.me();
    await adopt(me.user, me.players);
  }, [adopt]);

  const value = useMemo<SessionValue>(
    () => ({
      ready,
      user,
      players,
      playerId,
      player: players.find((entry) => entry.id === playerId) ?? null,
      signIn,
      register,
      signOut,
      selectPlayer,
      refresh,
    }),
    [ready, user, players, playerId, signIn, register, signOut, selectPlayer, refresh],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('useSession must be used inside a SessionProvider');
  return value;
}
