/**
 * Renders every icon asset the app needs from one SVG.
 *
 * There are five of them at four sizes with two different framings, and doing that by hand is how you
 * end up with a favicon that is a year out of date. One source, one command:
 *
 *   node scripts/render-icons.ts                          # from docs/branding/icon.svg
 *   node scripts/render-icons.ts path/to/other.svg
 *
 * The two framings are the part worth knowing about. **Android's adaptive icon crops.** The launcher
 * masks the foreground layer to whatever shape the device uses — circle, squircle, rounded square —
 * and it also parallax-shifts it, so only the central 66% of the canvas is guaranteed to survive. A
 * mark drawn to fill a 1024px square loses its edges. So `adaptive-icon.png` is rendered at 66% and
 * padded back out to 1024, which is the same thing as reserving the safe zone.
 *
 * Everything else is the mark at full bleed, because iOS and the web apply their own rounded corners
 * to a square that is expected to be filled.
 *
 * Needs `rsvg-convert` (`brew install librsvg`). Deliberately not a JS rasteriser: this is the one
 * place a native dependency is cheaper than the alternative, it runs on a developer's machine rather
 * than in the server, and the alternative is adding a rendering library to a project whose whole
 * point is not having dependencies.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const source = resolve(process.argv[2] ?? `${ROOT}docs/branding/icon.svg`);

interface Target {
  path: string;
  size: number;
  /**
   * Fraction of the canvas the mark occupies, the rest becoming transparent padding.
   *
   * 1 for everything except the Android adaptive foreground — see the header.
   */
  inset: number;
  why: string;
}

const TARGETS: Target[] = [
  { path: 'app/assets/icon.png', size: 1024, inset: 1, why: 'iOS app icon and the Expo default' },
  {
    path: 'app/assets/adaptive-icon.png',
    size: 1024,
    inset: 0.66,
    why: 'Android adaptive foreground — inset so the launcher mask cannot clip the mark',
  },
  {
    path: 'app/assets/splash-icon.png',
    size: 1024,
    // The splash sits on the ground colour with the mark centred and small; Expo scales it to fit,
    // and a full-bleed mark on a launch screen looks like an error rather than a brand.
    inset: 0.6,
    why: 'launch screen, centred on the ground colour',
  },
  { path: 'app/assets/favicon.png', size: 64, inset: 1, why: 'browser tab' },
  { path: 'docs/branding/icon.png', size: 512, inset: 1, why: 'the README header' },
];

function render(target: Target): void {
  const output = resolve(ROOT, target.path);
  mkdirSync(dirname(output), { recursive: true });

  const drawn = Math.round(target.size * target.inset);
  const pad = Math.round((target.size - drawn) / 2);

  // `--page-*` sets the canvas and `--top`/`--left` offsets the drawing inside it, which is how the
  // inset is achieved in one pass. Scaling afterwards would resample twice and soften hairlines.
  execFileSync(
    'rsvg-convert',
    [
      '-w', String(drawn),
      '-h', String(drawn),
      '--page-width', String(target.size),
      '--page-height', String(target.size),
      '--top', String(pad),
      '--left', String(pad),
      '--background-color', 'none',
      source,
      '-o', output,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );

  const { size } = statSync(output);
  // A zero-byte or near-empty PNG means rsvg parsed the SVG but drew nothing — a broken `use`
  // reference, or a font it could not find. It exits 0 either way, so the size is the only signal.
  if (size < 200) {
    throw new Error(
      `${target.path} came out at ${size} bytes, which means nothing was drawn. Check the SVG for ` +
        `external font or image references.`,
    );
  }

  console.log(`  ${target.path.padEnd(34)} ${String(target.size).padStart(4)}px  inset ${target.inset}  ${(size / 1024).toFixed(1)}KB`);
}

if (!existsSync(source)) {
  console.error(`No SVG at ${source}`);
  console.error('Pass one as an argument, or put the winning design at docs/branding/icon.svg.');
  process.exit(1);
}

try {
  execFileSync('rsvg-convert', ['--version'], { stdio: 'ignore' });
} catch {
  console.error('rsvg-convert is not installed. `brew install librsvg`.');
  process.exit(1);
}

console.log(`Rendering from ${source}\n`);
for (const target of TARGETS) render(target);

// A quick contact sheet, so the next person to change the icon can look at every size at once rather
// than opening five files.
const sheet = resolve(ROOT, 'docs/branding/contact-sheet.png');
for (const size of [48, 96, 192]) {
  execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), source, '-o', resolve(ROOT, `docs/branding/at-${size}.png`)], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}
console.log(`\nAlso wrote docs/branding/at-{48,96,192}.png for eyeballing the small sizes.`);
void sheet;
