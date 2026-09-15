/**
 * Refreshes the bonus snapshots from Doctor of Credit.
 *
 * Thin on purpose: the fetching, parsing and the refusal to overwrite a good snapshot with a bad
 * one all live in `src/server/doc.ts`, because the server's daily refresh runs exactly the same
 * code. A scraper that behaves differently when a person runs it is a scraper whose failures only
 * show up in production.
 *
 *   node scripts/refresh-doc.ts            # conditional — a 304 does nothing
 *   node scripts/refresh-doc.ts --force    # ignore Last-Modified and re-parse anyway
 *
 * `--force` is what you want after changing a regex in `doc.ts`: the pages have not changed, so a
 * conditional fetch would report "unchanged" and leave the snapshot parsed by the old code.
 */

import { refresh, loadCardOffers, loadBankOffers } from '../src/server/doc.ts';

const force = process.argv.includes('--force');

const result = await refresh({ force });

for (const warning of result.warnings) console.warn(`note: ${warning}`);

const cards = loadCardOffers();
const banks = loadBankOffers();

if (result.cards.changed) {
  const matched = result.cards.matched;
  const percent = Math.round((100 * matched) / Math.max(1, result.cards.count));
  console.log(
    `cards: ${result.cards.count} offers, ${matched} matched to the catalog (${percent}%)`,
  );
} else {
  console.log(`cards: unchanged — ${cards.offers.length} offers from ${cards.fetchedAt || 'never'}`);
}

if (result.banks.changed) {
  console.log(`banks: ${result.banks.count} offers`);
} else {
  console.log(`banks: unchanged — ${banks.offers.length} offers from ${banks.fetchedAt || 'never'}`);
}

// Unmatched offers are normal and expected — DoC's list runs well past the curated catalog — but
// a sudden jump in the count is the signal that a heading convention changed, so it is worth
// printing rather than hiding.
const unmatched = cards.offers.filter((offer) => offer.cardId === null);
if (unmatched.length > 0) {
  console.log(`\n${unmatched.length} card offers matched no catalog card:`);
  for (const offer of unmatched) console.log(`  ${offer.title}`);
  console.log(
    '\nAdd any of these to src/core/data/cards.ts to give them rule checking; they are shown in the app either way.',
  );
}
