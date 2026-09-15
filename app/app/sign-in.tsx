/**
 * Sign in.
 *
 * When the app was served by its own API — the deployed web case — there is no server to choose, so
 * the address is a line of small print and a link rather than the first field on the page. That is
 * the difference between "open the site and sign in" and "open the site and answer a question about
 * infrastructure", and it is worth the branch.
 *
 * On a phone, or against a different server, the address comes first because nothing works until it
 * is right. Either way it is probed live: the health check confirms the server is there, says which
 * revision of the flowchart it is running, and reports whether registration is open — so "Create
 * account" is never offered when the server would refuse it.
 */

import { useCallback, useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  api,
  ApiError,
  currentBaseUrl,
  DEFAULT_BASE_URL,
  isSameOrigin,
  resetBaseUrl,
  setBaseUrl,
  type HealthResponse,
} from '@/api.ts';
import { useSession } from '@/session.tsx';
import { Body, Button, Chip, Data, Eyebrow, Field, Segments, Title } from '@/components/ui.tsx';
import { colour, radius, space, type } from '@/theme.ts';

type Mode = 'sign-in' | 'register';

export default function SignIn() {
  const session = useSession();
  const insets = useSafeAreaInsets();

  const [mode, setMode] = useState<Mode>('sign-in');
  const [address, setAddress] = useState(currentBaseUrl());
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('Me');

  // Recomputed after every probe rather than read once: switching servers changes the answer, and it
  // decides whether the address field is even on screen.
  const [sameOrigin, setSameOrigin] = useState(isSameOrigin());
  const [showServer, setShowServer] = useState(false);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [probing, setProbing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const probe = useCallback(async (candidate: string) => {
    setProbing(true);
    setHealth(null);
    await setBaseUrl(candidate);
    setSameOrigin(isSameOrigin());
    try {
      setHealth(await api.health());
      setError(null);
    } catch (problem) {
      setError(problem instanceof ApiError ? problem.message : 'Cannot reach that address.');
    } finally {
      setProbing(false);
    }
  }, []);

  useEffect(() => {
    void probe(currentBaseUrl());
  }, [probe]);

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    setFieldError(null);
    try {
      await setBaseUrl(address);
      if (mode === 'register') await session.register(email, password, name);
      else await session.signIn(email, password);
    } catch (problem) {
      if (problem instanceof ApiError) {
        setError(problem.message);
        setFieldError(problem.field);
      } else {
        setError('Something went wrong. Try again.');
      }
    } finally {
      setBusy(false);
    }
  }, [address, mode, email, password, name, session]);

  const canRegister = health?.registrationOpen === true;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.flex}
    >
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + space.xxxl, paddingBottom: insets.bottom + space.xxl }]}
        keyboardShouldPersistTaps="handled"
      >
        {/* The masthead states what the app is for in the user's own vocabulary — 5/24 and annual
            fees, not "financial management". Someone who does not recognise those words is not who
            this is for. */}
        <View style={styles.masthead}>
          <Text style={styles.wordmark}>CHURN</Text>
          <Text style={styles.wordmarkThin}>TRACKER</Text>
        </View>
        <Body dim>Your 5/24 position, when each slot comes back, and what to apply for next.</Body>

        {/* Collapsed when the API is this page's own origin. The user opened a hostname that works;
            asking them to confirm where the server is would be asking a question they cannot get
            wrong and did not think to have. */}
        {sameOrigin && !showServer ? (
          <View style={styles.originRow}>
            {probing ? (
              <Data tone="dim">Connecting…</Data>
            ) : health !== null ? (
              <Text style={styles.originText}>
                Connected. {health.catalog.cards} cards, {health.offers.cards} live offers,{' '}
                {health.flowchart.version.replace('Card Recommendation Flowchart ', '')}.{' '}
                <Text style={styles.link} onPress={() => setShowServer(true)} suppressHighlighting>
                  Use a different server
                </Text>
              </Text>
            ) : (
              <Text style={styles.error}>
                This server is not answering.{' '}
                <Text style={styles.link} onPress={() => setShowServer(true)} suppressHighlighting>
                  Point somewhere else
                </Text>
              </Text>
            )}
          </View>
        ) : (
          <View style={styles.block}>
            <Eyebrow>Server</Eyebrow>
            <Field
              label="Address"
              value={address}
              onChangeText={setAddress}
              placeholder="https://churn.example.com"
              keyboardType="url"
              hint="Where your churn-tracker server is running."
            />
            <View style={styles.probeRow}>
              <Button label="Check" onPress={() => void probe(address)} kind="secondary" busy={probing} />
              <View style={styles.probeStatus}>
                {probing ? (
                  <Data tone="dim">Checking…</Data>
                ) : health !== null ? (
                  <>
                    <Chip colour={colour.go} background={colour.goDim}>
                      Reachable
                    </Chip>
                    <Text style={styles.probeDetail}>
                      {health.catalog.cards} cards · {health.offers.cards} live offers ·{' '}
                      {health.flowchart.version.replace('Card Recommendation Flowchart ', '')}
                    </Text>
                  </>
                ) : (
                  <Chip colour={colour.stop} background={colour.stopDim}>
                    No answer
                  </Chip>
                )}
              </View>
            </View>
            {DEFAULT_BASE_URL !== address ? (
              <Text
                style={styles.link}
                onPress={() => {
                  void (async () => {
                    setAddress(DEFAULT_BASE_URL);
                    await resetBaseUrl();
                    await probe(DEFAULT_BASE_URL);
                    setShowServer(false);
                  })();
                }}
                suppressHighlighting
              >
                Back to this site's own server
              </Text>
            ) : null}
          </View>
        )}

        <View style={styles.block}>
          <Segments<Mode>
            value={mode}
            onChange={setMode}
            options={[
              { value: 'sign-in', label: 'Sign in' },
              { value: 'register', label: 'Create account' },
            ]}
          />

          {mode === 'register' && health !== null && !canRegister ? (
            // Said plainly, with the fix, rather than letting the user fill in a form that will be
            // refused. The server refuses registration by default and this is how you turn it on.
            <View style={styles.notice}>
              <Text style={styles.noticeText}>
                This server has registration closed. Set{' '}
                <Text style={styles.code}>CT_OPEN_REGISTRATION=1</Text> on it, create your account,
                then set it back to 0.
              </Text>
            </View>
          ) : null}

          <Field
            label="Email"
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            keyboardType="email-address"
            error={fieldError === 'email' ? error : null}
          />
          <Field
            label="Password"
            value={password}
            onChangeText={setPassword}
            secure
            hint={mode === 'register' ? 'At least 12 characters. Length beats punctuation.' : undefined}
            error={fieldError === 'password' ? error : null}
          />
          {mode === 'register' ? (
            <Field
              label="Your name"
              value={name}
              onChangeText={setName}
              autoCapitalize="words"
              hint="Whose cards these are. You can add a partner later."
            />
          ) : null}

          {error !== null && fieldError === null ? <Text style={styles.error}>{error}</Text> : null}

          <View style={styles.submit}>
            <Button
              label={mode === 'register' ? 'Create account' : 'Sign in'}
              onPress={() => void submit()}
              busy={busy}
              disabled={email === '' || password === '' || (mode === 'register' && !canRegister)}
            />
          </View>
        </View>

        <Text style={styles.footnote}>
          This app stores dates and amounts you type in. It never asks for bank credentials and cannot
          connect to your accounts.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colour.ground },
  content: { paddingHorizontal: space.lg, gap: space.xl, maxWidth: 520, width: '100%', alignSelf: 'center' },

  masthead: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  // The wordmark is the type doing the work: one word heavy and tight, the other in letterspaced
  // mono, so the pairing that runs through the whole app is stated in the first thing you see.
  wordmark: { ...type.title, fontSize: 34, letterSpacing: -1.4, color: colour.text },
  wordmarkThin: { ...type.label, fontSize: 13, letterSpacing: 3, color: colour.when },

  block: { gap: space.md },
  probeRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  probeStatus: { flex: 1, gap: space.xs, alignItems: 'flex-start' },
  probeDetail: { ...type.dataSmall, fontSize: 11, color: colour.textFaint },

  originRow: { paddingVertical: space.xs },
  originText: { ...type.small, fontSize: 12, color: colour.textFaint, lineHeight: 18 },
  link: { ...type.smallStrong, fontSize: 12, color: colour.when },

  notice: {
    backgroundColor: colour.warnDim,
    borderRadius: radius.md,
    padding: space.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colour.warn,
  },
  noticeText: { ...type.small, color: colour.text },
  code: { ...type.dataSmall, color: colour.warn },

  error: { ...type.small, color: colour.stop },
  submit: { marginTop: space.xs },
  footnote: { ...type.small, fontSize: 12, color: colour.textFaint, lineHeight: 17 },
});
