/**
 * The shared pieces every screen is built from.
 *
 * `LedgerRow` is the important one. Both the home screen and the plan are laid out as a ledger: a
 * fixed left gutter holding a date in violet mono, and content flowing to the right of it. That is a
 * structural device carrying something true rather than a decoration — in churning every answer is a
 * date, so the date is the axis the whole app is organised around, and a shared gutter width is what
 * makes two unrelated screens read as one spine instead of two indented lists.
 *
 * The spine is drawn as a hairline through the gutter with a small marker at each row, coloured by
 * urgency. It gives the dates something to hang from without another border per row.
 */

import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type ViewStyle } from 'react-native';

import { colour, GUTTER, radius, space, tabular, type } from '../theme.ts';

// ---- text ------------------------------------------------------------------

export function Eyebrow({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return (
    <View style={[styles.eyebrowRow, style]}>
      <Text style={styles.eyebrow}>{children}</Text>
      <View style={styles.eyebrowLine} />
    </View>
  );
}

export function Title({ children }: { children: ReactNode }) {
  return <Text style={styles.title}>{children}</Text>;
}

export function Heading({ children }: { children: ReactNode }) {
  return <Text style={styles.heading}>{children}</Text>;
}

export function Body({ children, dim }: { children: ReactNode; dim?: boolean }) {
  return <Text style={[styles.body, dim === true && styles.bodyDim]}>{children}</Text>;
}

export function Data({ children, tone }: { children: ReactNode; tone?: keyof typeof toneColour }) {
  return <Text style={[styles.data, tabular, tone !== undefined && { color: toneColour[tone] }]}>{children}</Text>;
}

const toneColour = {
  go: colour.go,
  stop: colour.stop,
  warn: colour.warn,
  when: colour.when,
  points: colour.points,
  dim: colour.textDim,
  faint: colour.textFaint,
} as const;

// ---- the ledger ------------------------------------------------------------

/**
 * A row with a date in the left gutter.
 *
 * `marker` is the spine dot's colour. Passing `null` for the date leaves the gutter empty but keeps
 * the alignment, which is what a row with no deadline needs — an aligned blank is much quieter than
 * a dash, and it keeps the eye on the rows that do have dates.
 */
export function LedgerRow({
  date,
  caption,
  marker,
  onPress,
  children,
  last,
}: {
  date: string | null;
  caption?: string;
  marker: string;
  onPress?: () => void;
  children: ReactNode;
  last?: boolean;
}) {
  const content = (
    <View style={styles.ledgerRow}>
      <View style={styles.gutter}>
        {date !== null ? <Text style={[styles.gutterDate, tabular]}>{date}</Text> : null}
        {caption !== undefined ? <Text style={styles.gutterCaption}>{caption}</Text> : null}
      </View>

      <View style={styles.spine}>
        <View style={[styles.spineLine, last === true && styles.spineLineLast]} />
        <View style={[styles.spineDot, { backgroundColor: marker }]} />
      </View>

      <View style={styles.ledgerContent}>{children}</View>
    </View>
  );

  if (onPress === undefined) return content;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => (pressed ? styles.pressed : undefined)}>
      {content}
    </Pressable>
  );
}

// ---- surfaces --------------------------------------------------------------

export function Panel({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[styles.panel, style]}>{children}</View>;
}

/**
 * A tappable row in a list of accounts.
 *
 * The issuer is set as a letterspaced mono label above the card name rather than shown as artwork,
 * and that is the deliberate risk this design takes. Someone with fifteen cards is scanning for a
 * fee date and an issuer, not admiring a wallet — card art would take the whole left edge and carry
 * one bit of information. Set as type, the issuer becomes a column you can run your eye down.
 */
export function AccountRow({
  issuer,
  name,
  right,
  detail,
  tone,
  onPress,
  dimmed,
}: {
  issuer: string;
  name: string;
  right?: ReactNode;
  detail?: ReactNode;
  tone?: string;
  onPress?: () => void;
  dimmed?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.accountRow, pressed && styles.pressed]}
      accessibilityRole={onPress === undefined ? undefined : 'button'}
    >
      {tone !== undefined ? <View style={[styles.accountStripe, { backgroundColor: tone }]} /> : null}
      <View style={styles.accountBody}>
        <Text style={styles.accountIssuer}>{issuer}</Text>
        <Text style={[styles.accountName, dimmed === true && styles.accountNameDimmed]} numberOfLines={2}>
          {name}
        </Text>
        {detail !== undefined ? <View style={styles.accountDetail}>{detail}</View> : null}
      </View>
      {right !== undefined ? <View style={styles.accountRight}>{right}</View> : null}
    </Pressable>
  );
}

// ---- chips -----------------------------------------------------------------

/**
 * A small labelled token.
 *
 * `notation` renders the community's own rule shorthand — `5/24`, `2/90` — in mono, which is how
 * these rules are named everywhere else the user reads about them. A chip saying `5/24` is
 * recognisable in a way "five accounts in twenty-four months" is not.
 */
export function Chip({
  children,
  colour: tint = colour.textDim,
  background,
  notation,
}: {
  children: ReactNode;
  colour?: string;
  background?: string;
  notation?: boolean;
}) {
  return (
    <View style={[styles.chip, background !== undefined && { backgroundColor: background }]}>
      <Text style={[notation === true ? styles.chipNotation : styles.chipText, { color: tint }, tabular]}>
        {children}
      </Text>
    </View>
  );
}

/** A row of chips that wraps. */
export function ChipRow({ children }: { children: ReactNode }) {
  return <View style={styles.chipRow}>{children}</View>;
}

// ---- progress --------------------------------------------------------------

/**
 * Minimum-spend progress.
 *
 * A bar rather than a percentage because the useful comparison is against the end, not against 100 —
 * and because at a glance "nearly there" is the whole message. Two segments, not a gradient: the
 * filled part is what you have spent and the rest is what you owe.
 */
export function SpendBar({ progress, tone }: { progress: number; tone: string }) {
  return (
    <View style={styles.spendTrack}>
      <View style={[styles.spendFill, { width: `${Math.round(progress * 100)}%`, backgroundColor: tone }]} />
    </View>
  );
}

// ---- controls --------------------------------------------------------------

export function Button({
  label,
  onPress,
  kind = 'primary',
  busy,
  disabled,
}: {
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'danger';
  busy?: boolean;
  disabled?: boolean;
}) {
  const inactive = disabled === true || busy === true;
  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy: busy === true }}
      style={({ pressed }) => [
        styles.button,
        kind === 'primary' && styles.buttonPrimary,
        kind === 'secondary' && styles.buttonSecondary,
        kind === 'danger' && styles.buttonDanger,
        pressed && styles.pressed,
        inactive && styles.buttonInactive,
      ]}
    >
      {busy === true ? (
        <ActivityIndicator color={kind === 'primary' ? colour.ground : colour.text} />
      ) : (
        <Text
          style={[
            styles.buttonLabel,
            kind === 'primary' && styles.buttonLabelPrimary,
            kind === 'danger' && styles.buttonLabelDanger,
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

/** A segmented control. Used for the travel/cashback goal and for status filters. */
export function Segments<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <View style={styles.segments}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            style={[styles.segment, active && styles.segmentActive]}
          >
            <Text style={[styles.segmentLabel, active && styles.segmentLabelActive]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  secure,
  autoCapitalize,
  hint,
  error,
}: {
  label: string;
  value: string;
  onChangeText: (next: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'email-address' | 'numeric' | 'url';
  secure?: boolean;
  autoCapitalize?: 'none' | 'words' | 'sentences';
  hint?: string;
  error?: string | null;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colour.textFaint}
        keyboardType={keyboardType ?? 'default'}
        secureTextEntry={secure === true}
        autoCapitalize={autoCapitalize ?? 'none'}
        autoCorrect={false}
        style={[
          styles.input,
          // Dates and amounts are typed into these too, and a proportional face makes a typo in
          // `2026-01-15` much harder to spot.
          keyboardType === 'numeric' && styles.inputMono,
          error != null && styles.inputError,
        ]}
      />
      {error != null ? (
        <Text style={styles.fieldError}>{error}</Text>
      ) : hint !== undefined ? (
        <Text style={styles.fieldHint}>{hint}</Text>
      ) : null}
    </View>
  );
}

// ---- states ----------------------------------------------------------------

export function Loading({ label }: { label?: string }) {
  return (
    <View style={styles.centred}>
      <ActivityIndicator color={colour.when} />
      {label !== undefined ? <Text style={styles.centredCaption}>{label}</Text> : null}
    </View>
  );
}

/**
 * An empty screen, treated as an invitation rather than an apology.
 *
 * `action` is required rather than optional on purpose: if there is nothing to do here, this is the
 * wrong component and the screen should say what it is waiting for instead.
 */
export function Empty({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action: { label: string; onPress: () => void };
}) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyDetail}>{detail}</Text>
      <View style={styles.emptyAction}>
        <Button label={action.label} onPress={action.onPress} />
      </View>
    </View>
  );
}

/**
 * A failed request.
 *
 * Names what went wrong and offers the retry, in the interface's voice. Never apologises — an error
 * that says sorry is spending the user's attention on sentiment instead of on the fix.
 */
export function Problem({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <View style={styles.problem}>
      <Text style={styles.problemText}>{message}</Text>
      {onRetry !== undefined ? (
        <View style={styles.problemAction}>
          <Button label="Try again" onPress={onRetry} kind="secondary" />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // text
  eyebrowRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  eyebrow: { ...type.label, color: colour.textDim },
  eyebrowLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colour.line },
  title: { ...type.title, color: colour.text },
  heading: { ...type.heading, color: colour.text },
  body: { ...type.body, color: colour.text },
  bodyDim: { color: colour.textDim },
  data: { ...type.data, color: colour.text },

  // ledger
  ledgerRow: { flexDirection: 'row', minHeight: 56 },
  gutter: { width: GUTTER, paddingTop: space.md, alignItems: 'flex-end', paddingRight: space.sm },
  gutterDate: { ...type.dataSmall, color: colour.when },
  gutterCaption: { ...type.label, fontSize: 9, letterSpacing: 0.6, color: colour.textFaint, marginTop: 2 },
  spine: { width: 13, alignItems: 'center' },
  spineLine: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: StyleSheet.hairlineWidth,
    backgroundColor: colour.line,
  },
  // The last row's line stops at its dot rather than running off the end of the list.
  spineLineLast: { bottom: undefined, height: 20 },
  spineDot: { width: 7, height: 7, borderRadius: radius.pill, marginTop: 17 },
  ledgerContent: { flex: 1, paddingLeft: space.md, paddingVertical: space.md, paddingRight: space.xs },

  // surfaces
  panel: {
    backgroundColor: colour.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colour.line,
    padding: space.lg,
  },
  pressed: { opacity: 0.6 },

  accountRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: colour.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colour.line,
    marginBottom: space.sm,
    overflow: 'hidden',
  },
  // A 3px status stripe rather than a coloured background: it reads at a glance down a long list
  // without tinting the text beside it.
  accountStripe: { width: 3 },
  accountBody: { flex: 1, padding: space.md, gap: 3 },
  accountIssuer: { ...type.label, color: colour.textDim },
  accountName: { ...type.bodyStrong, color: colour.text },
  accountNameDimmed: { color: colour.textFaint },
  accountDetail: { marginTop: space.xs },
  accountRight: { justifyContent: 'center', paddingRight: space.md, paddingLeft: space.sm, alignItems: 'flex-end' },

  // chips
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  chip: {
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.sm,
    backgroundColor: colour.surfaceHigh,
  },
  chipText: { ...type.dataSmall, fontSize: 11 },
  chipNotation: { ...type.dataSmall, fontFamily: type.dataStrong.fontFamily, fontSize: 11, letterSpacing: 0.3 },

  // progress
  spendTrack: {
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: colour.surfaceHigh,
    overflow: 'hidden',
  },
  spendFill: { height: 4, borderRadius: radius.pill },

  // controls
  button: {
    minHeight: 46,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  buttonPrimary: { backgroundColor: colour.go },
  buttonSecondary: {
    backgroundColor: colour.surfaceHigh,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colour.line,
  },
  buttonDanger: { backgroundColor: colour.stopDim, borderWidth: StyleSheet.hairlineWidth, borderColor: colour.stop },
  buttonInactive: { opacity: 0.45 },
  buttonLabel: { ...type.bodyStrong, color: colour.text },
  buttonLabelPrimary: { color: colour.ground },
  buttonLabelDanger: { color: colour.stop },

  segments: {
    flexDirection: 'row',
    backgroundColor: colour.surface,
    borderRadius: radius.md,
    padding: 3,
    gap: 3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colour.line,
  },
  segment: { flex: 1, paddingVertical: space.sm, borderRadius: radius.sm, alignItems: 'center' },
  segmentActive: { backgroundColor: colour.surfaceHigh },
  segmentLabel: { ...type.smallStrong, color: colour.textDim },
  segmentLabelActive: { color: colour.text },

  field: { gap: space.xs },
  fieldLabel: { ...type.label, color: colour.textDim },
  input: {
    ...type.body,
    color: colour.text,
    backgroundColor: colour.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colour.line,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    minHeight: 46,
  },
  inputMono: { ...type.data },
  inputError: { borderColor: colour.stop },
  fieldHint: { ...type.small, fontSize: 12, color: colour.textFaint },
  fieldError: { ...type.small, fontSize: 12, color: colour.stop },

  // states
  centred: { paddingVertical: space.xxxl, alignItems: 'center', gap: space.md },
  centredCaption: { ...type.small, color: colour.textDim },

  empty: { paddingVertical: space.xxl, paddingHorizontal: space.lg, alignItems: 'flex-start', gap: space.sm },
  emptyTitle: { ...type.heading, color: colour.text },
  emptyDetail: { ...type.body, color: colour.textDim, maxWidth: 420 },
  emptyAction: { marginTop: space.md, alignSelf: 'stretch', maxWidth: 280 },

  problem: {
    backgroundColor: colour.stopDim,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colour.stop,
    borderRadius: radius.md,
    padding: space.lg,
    gap: space.sm,
  },
  problemText: { ...type.body, color: colour.text },
  problemAction: { alignSelf: 'flex-start', minWidth: 140 },
});
