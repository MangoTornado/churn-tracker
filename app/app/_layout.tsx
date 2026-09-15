/**
 * The root layout: fonts, session, and the gate between signed in and not.
 *
 * The splash screen is held until the fonts have loaded *and* the stored token has been checked.
 * Both, not either — releasing it early gives you either a flash of system-font text reflowing into
 * Instrument Sans, or a sign-in screen that vanishes half a second later because a valid session
 * turned out to be there all along. Neither is expensive to avoid.
 */

import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
import {
  InstrumentSans_400Regular,
  InstrumentSans_500Medium,
  InstrumentSans_600SemiBold,
  InstrumentSans_700Bold,
} from '@expo-google-fonts/instrument-sans';
import {
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
  JetBrainsMono_700Bold,
} from '@expo-google-fonts/jetbrains-mono';

import { SessionProvider, useSession } from '@/session.tsx';
import { colour, font, type } from '@/theme.ts';

void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    [font.body]: InstrumentSans_400Regular,
    [font.bodyMedium]: InstrumentSans_500Medium,
    [font.bodySemi]: InstrumentSans_600SemiBold,
    [font.display]: InstrumentSans_700Bold,
    [font.mono]: JetBrainsMono_400Regular,
    [font.monoMedium]: JetBrainsMono_500Medium,
    [font.monoBold]: JetBrainsMono_700Bold,
  });

  /**
   * Give up waiting for fonts after a few seconds.
   *
   * `useFonts` reports success and failure, but not "still going". A font that neither loads nor
   * errors would hold the splash screen forever, and the splash screen is the one piece of UI with
   * no way for the user to get past it — the app would be a black rectangle with no error and no
   * exit. That is not hypothetical for this app: the same class of bug, an unresolved promise
   * during startup, is what a missing Keychain entitlement produced.
   *
   * Three seconds because the fonts are bundled in the app, not fetched — if they are not ready by
   * then they are not coming.
   */
  const [fontsTimedOut, setFontsTimedOut] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setFontsTimedOut(true), 3000);
    return () => clearTimeout(timer);
  }, []);

  // A font that fails to load is not a reason to show nothing: the app is entirely usable in the
  // system face, and a blank screen forever is much worse than slightly wrong typography.
  const typographyReady = fontsLoaded || fontError !== null || fontsTimedOut;

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <SessionProvider>
        <Gate ready={typographyReady} />
      </SessionProvider>
    </SafeAreaProvider>
  );
}

/**
 * Redirects to sign-in or into the app, once both the fonts and the session are settled.
 *
 * Driven off `useSegments` rather than rendering one tree or the other, so that a deep link into a
 * card survives a cold start: the router keeps the intended route and this only intervenes when the
 * current route is on the wrong side of the fence.
 */
function Gate({ ready }: { ready: boolean }) {
  const session = useSession();
  const segments = useSegments();
  const router = useRouter();

  const settled = ready && session.ready;

  useEffect(() => {
    if (!settled) return;
    // `.catch` because hideAsync rejects if the splash is already gone, and an unhandled
    // rejection here would be a warning at best and a hang at worst.
    void SplashScreen.hideAsync().catch(() => undefined);

    const onSignIn = segments[0] === 'sign-in';
    if (session.user === null && !onSignIn) router.replace('/sign-in');
    if (session.user !== null && onSignIn) router.replace('/');
  }, [settled, session.user, segments, router]);

  if (!settled) return <View style={styles.holding} />;

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colour.ground },
        headerShadowVisible: false,
        headerTintColor: colour.text,
        headerTitleStyle: { ...type.heading, fontSize: 17 },
        contentStyle: { backgroundColor: colour.ground },
        headerBackButtonDisplayMode: 'minimal',
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="sign-in" options={{ headerShown: false }} />
      <Stack.Screen name="card/new" options={{ title: 'Add a card', presentation: 'modal' }} />
      <Stack.Screen name="card/[id]" options={{ title: 'Card' }} />
      <Stack.Screen name="bank/new" options={{ title: 'Add a bank account', presentation: 'modal' }} />
      <Stack.Screen name="consider/[cardId]" options={{ title: 'Can I get this?' }} />
    </Stack>
  );
}

const styles = StyleSheet.create({
  // Matches the splash background, so the handover is invisible rather than a flash.
  holding: { flex: 1, backgroundColor: colour.ground },
});
