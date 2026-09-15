/**
 * The design system, and the reasoning behind it.
 *
 * **Colour means one thing each, taken from the domain.** The rules engine already classifies every
 * verdict into four severities — blocker, likely-denial, caution, note — so the palette is that
 * classification rather than a decorative set. Green means you can, coral means you cannot, amber
 * means you probably should not, and violet means *when*. That last one is the useful part: in
 * churning every answer is a date, so dates get their own colour and are recognisable anywhere in
 * the app without a label.
 *
 * The base is a warm near-black with a violet cast rather than the usual blue-grey or pure #000.
 * Two reasons: a violet-tinted ground makes the violet date accent read as part of the same family
 * instead of a sticker, and #000 on an OLED phone makes hairline borders disappear entirely, which
 * matters when the layout is built out of hairlines.
 *
 * **Two families, three roles.** Instrument Sans for anything you read, JetBrains Mono for anything
 * you compare. That split is not stylistic: this app is full of numbers that line up in columns —
 * dates, dollar amounts, and the community's own rule notation (`5/24`, `2/90`, `1/8`) — and a
 * proportional face makes those ragged and makes the fractions read as prose rather than as the
 * tokens they are. Display is Instrument Sans at its heaviest with tight tracking, not a third
 * family; one accessory removed.
 */

import { Platform } from 'react-native';

export const colour = {
  /** Warm near-black with a violet cast. See the header for why not #000 or a blue-grey. */
  ground: '#17161C',
  /** Raised surfaces: rows, sheets, inputs. */
  surface: '#221F29',
  /** One step further up, for a pressed row or a nested block. */
  surfaceHigh: '#2C2836',
  /** Hairlines. The layout is built from these, so they have to be visible without being lines. */
  line: '#312D3B',
  lineSoft: '#282430',

  text: '#F2EFF5',
  textDim: '#9A93A8',
  /** For things present but inert — an aged-out card, a closed account. */
  textFaint: '#635C70',

  /** You can do this. The `apply-now` verdict, an open 5/24 slot, a met minimum spend. */
  go: '#7DD8A6',
  goDim: '#2C4A3B',

  /** You cannot. A blocker, a card past its wall, an overdue deadline. */
  stop: '#E8705A',
  stopDim: '#4A2A24',

  /** You probably should not. Velocity guidance, inquiry sensitivity, a slot being burned. */
  warn: '#E8B75A',
  warnDim: '#463819',

  /** A date. Countdowns, expiries, the slot rail's labels. Never used for anything else. */
  when: '#B9A0F5',
  whenDim: '#332B4A',

  /** Points and miles, which are neither money nor a date. */
  points: '#7FC5E8',
} as const;

/**
 * Severity to colour, matching `Severity` in the server's rules engine exactly.
 *
 * Kept as one mapping so a new severity is a compile error here rather than a silently grey chip.
 */
export const severityColour = {
  blocker: colour.stop,
  'likely-denial': colour.stop,
  caution: colour.warn,
  note: colour.textDim,
} as const;

export const severityBackground = {
  blocker: colour.stopDim,
  'likely-denial': colour.stopDim,
  caution: colour.warnDim,
  note: colour.surfaceHigh,
} as const;

/** Reminder urgency to colour. Overdue and urgent are the same red on purpose — both need today. */
export const urgencyColour = {
  overdue: colour.stop,
  urgent: colour.stop,
  soon: colour.warn,
  upcoming: colour.textDim,
} as const;

export const font = {
  body: 'InstrumentSans_400Regular',
  bodyMedium: 'InstrumentSans_500Medium',
  bodySemi: 'InstrumentSans_600SemiBold',
  display: 'InstrumentSans_700Bold',
  mono: 'JetBrainsMono_400Regular',
  monoMedium: 'JetBrainsMono_500Medium',
  monoBold: 'JetBrainsMono_700Bold',
} as const;

/**
 * The type scale.
 *
 * Tight tracking on the large sizes and loose on the small caps labels — the two ends of a scale
 * need opposite treatment, and applying one letterSpacing everywhere is what makes a type system
 * look unconsidered.
 */
export const type = {
  /** The slot rail's count, and nothing else. */
  hero: { fontFamily: font.mono, fontSize: 40, letterSpacing: -1.5, lineHeight: 44 },
  title: { fontFamily: font.display, fontSize: 26, letterSpacing: -0.7, lineHeight: 31 },
  heading: { fontFamily: font.display, fontSize: 18, letterSpacing: -0.3, lineHeight: 23 },
  body: { fontFamily: font.body, fontSize: 15, lineHeight: 21 },
  bodyStrong: { fontFamily: font.bodySemi, fontSize: 15, lineHeight: 21 },
  small: { fontFamily: font.body, fontSize: 13, lineHeight: 18 },
  smallStrong: { fontFamily: font.bodyMedium, fontSize: 13, lineHeight: 18 },

  /** Numbers that line up: dates, money, counts. */
  data: { fontFamily: font.mono, fontSize: 14, lineHeight: 19 },
  dataSmall: { fontFamily: font.mono, fontSize: 12, lineHeight: 16 },
  dataStrong: { fontFamily: font.monoMedium, fontSize: 14, lineHeight: 19 },

  /**
   * Section eyebrows and issuer names: small, letterspaced, uppercase.
   *
   * Used for the issuer in the card list rather than card artwork, which is the one real risk this
   * design takes — see the note on `Row`.
   */
  label: {
    fontFamily: font.monoMedium,
    fontSize: 11,
    letterSpacing: 1.2,
    lineHeight: 14,
    textTransform: 'uppercase' as const,
  },
} as const;

/** A four-based spacing scale. Named by size so a layout reads as intent rather than arithmetic. */
export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
  pill: 999,
} as const;

/**
 * The date gutter width.
 *
 * The home screen and the plan are laid out as a ledger: a fixed left column of dates in violet
 * mono, and content flowing right of it. Shared as a constant because the alignment across
 * unrelated screens is the whole effect — the moment two screens disagree by two pixels it stops
 * reading as one spine and starts reading as two lists that happen to be indented.
 */
export const GUTTER = 62;

/**
 * `fontVariant` for tabular figures, where the platform supports it.
 *
 * JetBrains Mono is already monospaced so this is belt-and-braces on native, but react-native-web
 * falls back to a system mono on the web before the font loads and the fallback is often
 * proportional. Without this, columns of numbers visibly reflow as the font arrives.
 */
export const tabular = Platform.select({
  web: { fontVariant: ['tabular-nums'] as ['tabular-nums'] },
  default: {},
});
