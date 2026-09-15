/**
 * Turns /u/m16p's Card Recommendation Flowchart into `src/core/data/flowchart.json`.
 *
 * The name "flowchart" oversells it. What is published is a draw.io diagram, and the diagram is
 * not a decision tree — it is fifteen prose panels laid out on a canvas, with five edges total,
 * four of which are the travel/cashback split at the top. There is nothing to walk. So this does
 * not try to build a graph: it lifts each panel out whole, keyed by what the panel is about, and
 * the recommender reads those panels as *strategy text* while the machine-checkable rules live in
 * `src/core/rules/issuers.ts` where they can be unit-tested.
 *
 * Getting at the panels takes three layers of unwrapping, which is the only real work here:
 *
 *   1. The `.html` is a draw.io viewer stub. The diagram is the `data-mxgraph` attribute, which is
 *      HTML-entity-encoded JSON.
 *   2. That JSON's `xml` field is the mxGraphModel — sometimes deflate+base64 (`<diagram>` with no
 *      child element), sometimes plain. Both are handled; v21 is plain.
 *   3. Every panel's `value` is HTML *inside* an XML attribute, so it is entity-encoded twice, and
 *      the line breaks that make the panel readable are `<br>` tags rather than newlines.
 *
 * Run it with a path or a URL:
 *   node scripts/extract-flowchart.ts
 *   node scripts/extract-flowchart.ts ./Card+Recommendation+Flowchart+Latest.html
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const SOURCE_URL =
  'https://m16p-churning.s3.us-east-2.amazonaws.com/Card+Recommendation+Flowchart+Latest.html';

const OUTPUT = fileURLToPath(new URL('../src/core/data/flowchart.json', import.meta.url));

/**
 * Which panel is which.
 *
 * Matched on the panel's own opening words rather than on the diagram's cell ids. The ids are
 * draw.io's internal handles (`zXaCHsxm6DPE4VEspXh3-61`) and they change whenever the author
 * copy-pastes a box, so keying on them means a silent empty section on the next revision. The
 * headings are what a reader sees, so they are what the author is careful about.
 *
 * Anything unmatched still ends up in `sections`, keyed by a slug of its first line — a new panel
 * appearing is not a reason to drop it on the floor.
 */
const PANELS: Array<{ id: string; match: RegExp }> = [
  { id: 'under524Approach', match: /^Under-5\/24 approach/i },
  { id: 'chaseCards', match: /^Chase Cards/i },
  { id: 'nonChaseBusinessCards', match: /^Non-Chase Business Cards/i },
  { id: 'over524Travel', match: /^This is where things get fuzzy/i },
  { id: 'over524Cashback', match: /^For cashback signup bonuses/i },
  { id: 'burnA524Slot', match: /^Cards possibly worth burning/i },
  { id: 'notesUnder524', match: /^NOTES FOR UNDER 5\/24/i },
  { id: 'limitations', match: /^LIMITATIONS OF THIS FLOWCHART/i },
  { id: 'notesNewbies', match: /^NOTES FOR NEWBIES/i },
  { id: 'notesTiming', match: /^NOTES FOR TIMING/i },
  { id: 'notesAmexFamily', match: /^NOTES FOR AMEX CARD-FAMILY RULES/i },
  { id: 'notesMarriott', match: /^NOTES FOR MARRIOTT CARDS/i },
  { id: 'notesTwoPlayerMode', match: /^NOTES FOR 2\+ PLAYER MODE/i },
  { id: 'generalNotes', match: /^GENERAL NOTES/i },
];

/** Panels that are credit, not content. Kept out of `sections` so consumers can render them all. */
const SKIP = [/^flowchart maintained by/i, /^My thanks to \/r\/churning/i];

export interface FlowchartSection {
  id: string;
  /** The panel's first line, which is its heading in every panel that has one. */
  heading: string;
  /** The rest of the panel, blank-line separated, `<br>`s resolved to newlines. */
  body: string;
  /** Canvas position. The author lays the chart out meaningfully; this preserves reading order. */
  x: number;
  y: number;
}

export interface Flowchart {
  source: string;
  /** The diagram's own version, from its `<title>`. */
  version: string;
  /** "last updated on MM/DD/YYYY" out of the credits panel, as ISO. */
  updatedAt: string | null;
  /** When this file was generated. */
  extractedAt: string;
  sections: Record<string, FlowchartSection>;
}

/**
 * Undoes one round of HTML entity encoding.
 *
 * Called twice on panel text on purpose — see the header. `&amp;` is decoded last within each
 * round, because decoding it first would turn `&amp;lt;` into `<` a round early and eat markup
 * that was meant to survive as literal text.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Panel text: HTML in an XML attribute, wanted as plain text with its line breaks intact. */
function panelText(rawValue: string): string {
  let text = decodeEntities(decodeEntities(rawValue));
  // Structure first, while the tags are still there — `<br>` and a closing block tag are the only
  // things in these panels that mean "new line".
  text = text.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p|li|tr|h\d)>/gi, '\n');
  text = text.replace(/<li\b[^>]*>/gi, '\n');
  text = text.replace(/<[^>]+>/g, '');
  // draw.io emits a lot of `<font>`/`<span>` wrappers, so the result is full of stray runs of
  // spaces and blank lines where a tag used to be.
  return text
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function slug(heading: string): string {
  return (
    heading
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'section'
  );
}

/** The mxGraphModel XML, from the viewer stub. */
export function diagramXml(html: string): string {
  const attribute = html.match(/data-mxgraph="([^"]*)"/);
  if (!attribute) throw new Error('no data-mxgraph attribute — is this a draw.io viewer export?');

  const config = JSON.parse(decodeEntities(attribute[1])) as { xml?: string };
  const xml = config.xml;
  if (!xml) throw new Error('data-mxgraph carried no xml');

  // A `<diagram>` whose content is text rather than a nested element is deflate+base64. draw.io
  // writes raw deflate; older exports wrote zlib. Try raw, then zlib, then give up and assume the
  // payload was plain after all.
  const compressed = xml.match(/<diagram[^>]*>([A-Za-z0-9+/=\s]+)<\/diagram>/);
  if (compressed && !/<mxGraphModel/i.test(xml)) {
    const bytes = Buffer.from(compressed[1].replace(/\s+/g, ''), 'base64');
    for (const inflate of [inflateRawSync, inflateSync]) {
      try {
        return decodeURIComponent(inflate(bytes).toString('utf8'));
      } catch {
        /* Try the other framing. */
      }
    }
    throw new Error('a compressed <diagram> would not inflate');
  }
  return xml;
}

export function parseFlowchart(html: string): Flowchart {
  const xml = diagramXml(html);

  // Split rather than match-all: an mxCell's own attributes and its `<mxGeometry>` child both
  // want reading, and a single regex over nested tags is how that goes wrong.
  const cells = xml.split('<mxCell').slice(1);

  const panels: FlowchartSection[] = [];
  let credits = '';

  for (const cell of cells) {
    if (/\bedge="1"/.test(cell)) continue;

    const value = cell.match(/\bvalue="([^"]*)"/);
    if (!value) continue;
    const text = panelText(value[1]);
    if (!text) continue;

    const geometry = cell.match(/<mxGeometry\b[^>]*/);
    const x = Number(geometry?.[0].match(/\bx="(-?[\d.]+)"/)?.[1] ?? 0);
    const y = Number(geometry?.[0].match(/\by="(-?[\d.]+)"/)?.[1] ?? 0);

    if (SKIP.some((pattern) => pattern.test(text))) {
      credits += `${text}\n`;
      continue;
    }

    // The travel/cashback split and its two labels are three one-word boxes. They carry no
    // strategy, and the two big columns they point at are captured as panels of their own.
    if (text.length < 60 && !/\n/.test(text)) continue;

    const [heading, ...rest] = text.split('\n');
    const known = PANELS.find((panel) => panel.match.test(text));
    panels.push({
      id: known?.id ?? slug(heading),
      heading: heading.replace(/:$/, ''),
      body: rest.join('\n').trim(),
      x,
      y,
    });
  }

  panels.sort((a, b) => a.y - b.y || a.x - b.x);

  const sections: Record<string, FlowchartSection> = {};
  for (const panel of panels) sections[panel.id] = panel;

  const missing = PANELS.filter((panel) => !(panel.id in sections)).map((panel) => panel.id);
  if (missing.length > 0) {
    // Loud, but not fatal: a renamed panel should be visible to whoever ran this, while still
    // producing a usable file from the panels that did match.
    console.warn(`warning: expected panels not found: ${missing.join(', ')}`);
  }

  const updated = credits.match(/last updated on\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i);

  return {
    source: SOURCE_URL,
    version: (html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? 'unknown').trim(),
    updatedAt: updated
      ? `${updated[3]}-${updated[1].padStart(2, '0')}-${updated[2].padStart(2, '0')}`
      : null,
    extractedAt: new Date().toISOString().slice(0, 10),
    sections,
  };
}

async function main(): Promise<void> {
  const argument = process.argv[2];
  const html =
    argument && existsSync(argument)
      ? readFileSync(argument, 'utf8')
      : await fetch(argument ?? SOURCE_URL).then((response) => {
          if (!response.ok) throw new Error(`fetching the flowchart gave HTTP ${response.status}`);
          return response.text();
        });

  const flowchart = parseFlowchart(html);
  writeFileSync(OUTPUT, `${JSON.stringify(flowchart, null, 2)}\n`);

  const count = Object.keys(flowchart.sections).length;
  console.log(`${flowchart.version} — ${count} sections, last updated ${flowchart.updatedAt}`);
  console.log(`wrote ${OUTPUT}`);
}

// Importable for the tests without running the fetch.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
