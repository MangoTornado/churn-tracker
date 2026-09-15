<div align="center">

<img src="docs/branding/icon.png" width="104" alt="" />

# churn-tracker

**A churning tracker whose rules engine answers with a date instead of a yes or a no.**

What you hold, when each 5/24 slot comes back, which deadlines cost money if you miss them, and what
to apply for next. One person or two. One Node 24 process you run yourself.

[![Release](https://img.shields.io/github/v/release/MangoTornado/churn-tracker?display_name=tag&color=B9A0F5)](https://github.com/MangoTornado/churn-tracker/releases/latest)
[![iOS · Android · Web](https://img.shields.io/badge/iOS%20%C2%B7%20Android%20%C2%B7%20Web-Expo-B9A0F5?logo=expo&logoColor=white)](#getting-the-app)
[![Node 24+](https://img.shields.io/badge/Node-24%2B-5FA04E?logo=nodedotjs&logoColor=white)](#quick-start)
[![Dependencies: none](https://img.shields.io/badge/dependencies-none-7DD8A6)](#how-it-is-built)
[![Licence AGPL-3.0](https://img.shields.io/badge/licence-AGPL--3.0-blue)](LICENSE)
[![CI](https://github.com/MangoTornado/churn-tracker/actions/workflows/ci.yml/badge.svg)](https://github.com/MangoTornado/churn-tracker/actions/workflows/ci.yml)

</div>

```
                            ┌──────┬──────┬──────┬──────┬ ─ ─ ─┐
                            │ NOV  │ JAN  │ FEB  │ JUN  │      │
                            │ '26  │ '27  │ '28  │ '28  │ open │
                            └──────┴──────┴──────┴──────┴ ─ ─ ─┘
                              frees up →

                            4/24   1 slot to spend
                                   Next returns Nov '26.
```

<!-- Placeholder, deliberately not a table of images: there are no screenshots checked in yet, and
     this README will not link to files that do not exist. When they land, a three-up goes here —
     home with the slot rail, an assessment with its verdicts, and the reminders list. -->

Two things about it are unusual enough to say before anything else, because they are why you would
trust it with your own history rather than someone else's:

1. **No rule returns a boolean.** "Denied" is not useful. Every one of the 25 issuer rules returns
   the date it stops applying, and the reminder engine reads those dates straight out of the
   verdicts rather than working them out a second time.
2. **The server is one process with zero npm dependencies.** Node 24, `node:sqlite`, TypeScript run
   directly by stripping the types, no build step and no lockfile. The app is a separate Expo
   codebase that imports the server's *types* and none of its logic, so there is exactly one
   implementation of every rule and it is the tested one.

> [!IMPORTANT]
> The rules in here are **community-observed issuer behaviour, not issuer policy**. Almost none of it
> is documented, all of it changes without notice, and the app is built so you can overrule any of
> it — see [Accuracy, and who has the last word](#accuracy-and-who-has-the-last-word).

## Contents

- [What it does](#what-it-does)
- [What it deliberately does not do](#what-it-deliberately-does-not-do)
- [Quick start](#quick-start)
- [Getting the app](#getting-the-app)
- [Deploying it](#deploying-it)
- [How it is built](#how-it-is-built)
- [Accuracy, and who has the last word](#accuracy-and-who-has-the-last-word)
- [Docs](#docs)
- [Licence](#licence)
- [Credits](#credits)

## What it does

🗂️ **Tracks the accounts.** Cards and bank bonuses, open and closed, for one person or two. Closed
cards stay: 5/24 counts accounts *opened* in the last 24 months whether or not they are still open,
so deleting one would quietly give you the wrong number.

✅ **Answers "can I get this?"** for any of 107 catalogued cards, listing every rule that bears on it
and the date each one lifts — Chase's 5/24 and its three-month velocity guideline, Amex's 2/90,
1-in-5, five-credit-card limit and card-family language, Citi's 1/8 and 2/65, Barclays' 6/24, Bank of
America's 2/3/4 and 3/12-or-7/12, Capital One's opaque underwriting, plus per-card and per-family
bonus cooldowns. Verdicts come back at four severities, because a wall enforced by software and a
community-observed shutdown risk are not the same warning.

⏰ **Reminds you before it costs you.** Annual fees six weeks out, the roughly 30-day window to
reverse one that has already posted, minimum-spend deadlines with the shortfall named, bonuses that
met their terms and never arrived, bank bonuses you can finally close safely, and idle no-fee cards
about to be auto-closed. Sorted by date, then by how much is at stake.

🧭 **Recommends the next card**, following [/u/m16p's Card Recommendation Flowchart][flowchart]
(v21, updated 2025-06-09, 14 panels extracted) — quoted, attributed and versioned, because it is
explicitly subjective and says so itself. Under 5/24 the plan is Chase-first with business cards as
spacers; past it, the biggest bonus a bank will still approve.

📈 **Keeps the bonus data current** from Doctor of Credit's two best-bonuses pages: 70 live card
offers (48 of them matched to the catalog) and 250 bank offers, refreshed daily and checked in as a
snapshot, so a fresh clone and a server with no network still work.

The domain talks in fractions — 5/24, 2/90, 1/8, 6/24, 8/65 — and every one of them is a time
window, which is the whole reason the engine deals in dates. The home screen draws your 5/24 count as
the rule's own shape: five cells, the spent ones labelled with the month that slot frees up.

## What it deliberately does not do

**It never asks for a bank credential, and it cannot connect to an account.** There is no
aggregator, no Plaid key, no OAuth to any bank, no account number, no balance, no transaction feed,
no card number, no statement import. You type in dates and dollar amounts, and that is all the engine
is given.

That is not a roadmap gap. Every rule in churning is a function of *when* an account was opened, so
dates and amounts are genuinely sufficient — and the consequences of the choice are the reason to
mention it in the first place:

- A breach of this server is embarrassing rather than ruinous. There is nothing on it that moves
  money and nothing that identifies an account.
- There is no third-party secret to rotate, so `.kamal/secrets` holds exactly two values: a registry
  username and a registry password.
- Nothing phones home. No analytics, no crash reporting, no telemetry. The only outbound requests are
  the daily Doctor of Credit scrape and push notifications, both of which you can turn off with an
  environment variable.

Registration is off by default, and it stays a deliberate two-step to open it and close it again.
While it is on, the server logs a warning on every boot, `/health` reports `registrationOpen: true`,
and the deploy workflow raises that as a GitHub annotation.

## Quick start

Needs **Node 24 or newer**, and that is a floor rather than a preference: the server uses
`node:sqlite` and runs its TypeScript directly, and both arrived in 24.

```sh
git clone https://github.com/MangoTornado/churn-tracker
cd churn-tracker

make install    # checks the Node version. There is nothing to install.
make test       # 251 tests, no network
make dev        # API on :8811
```

The first account needs registration opened, because it is off by default:

```sh
CT_OPEN_REGISTRATION=1 npm start
```

| Command | |
|---|---|
| `make dev` | server on :8811, restarting on change |
| `make test` | the suite — no network, no fixtures to download |
| `make typecheck` | `tsc`, installed into a scratch dir rather than as a dependency |
| `make data` | re-scrape Doctor of Credit and re-extract the flowchart, then read the diff |
| `make refresh-force` | ignore `Last-Modified` — what you want after changing a parser regex |
| `make docker-run` | the image locally on :8811, app at `/` and API under `/v1` |

## Getting the app

One Expo codebase covers iOS, Android and the web.

| | |
|---|---|
| **Web** | Ships inside the server image. Open your own hostname and that is the entire setup — the app takes the origin it was served from as its API. |
| **Android** | A signed APK on each [release](https://github.com/MangoTornado/churn-tracker/releases/latest), split by ABI. |
| **iOS** | Built on your own Mac with your own Apple Developer identity, to TestFlight or a local install — see [RELEASING.md](docs/RELEASING.md). |
| **Either, in development** | `make app-install` then `make app-start`, and scan the QR code with Expo Go. |

On a phone there is no origin to inherit, so the app asks for your server's address on first launch.
That is the one field the deployed web app hides. Push reminders need an EAS project id; without one
a standalone build cannot mint a push token, and the Settings screen says so rather than failing
quietly.

## Deploying it

[Kamal 2](https://kamal-deploy.org), one container, one hostname. The image serves the web app at `/`
and the API under `/v1`, from one process.

```sh
cp .kamal/secrets.sample .kamal/secrets   # registry username and password. That is the whole list.
$EDITOR config/deploy.yml                 # five TODO(...) markers
make setup                                # bootstrap the host and first deploy
make deploy                               # tests, then build and ship
```

`builder.arch` is `arm64`, for an Oracle Ampere A1 host; change it if your VM is x86. TLS is not
terminated in the container — put a Cloudflare Tunnel or another terminator in front of
`kamal-proxy`. `docker build --target api` gives an API-only image instead, and the server picks its
behaviour from whether a web build is present, so there is no flag to keep in step.

> [!WARNING]
> **Back the volume up.** It holds the only copy of everybody's churning history. Unlike a cache
> there is nothing to re-fetch — this data only ever existed there. `make backup` writes a
> timestamped copy locally; put it on a schedule.

Deploys from GitHub Actions are **manual by default**, for the same reason: shipping to the host that
holds the only copy of the data should be a thing you decide to do, not something a merge does while
you are looking elsewhere.

**Everything else, including the full environment table → [docs/DEPLOYING.md](docs/DEPLOYING.md).**

## How it is built

```
src/core/            the domain. No I/O, no framework, no dependencies.
  model.ts           what a churner's history is, and what the app is allowed to know
  dates.ts           YYYY-MM-DD arithmetic, with its own tests
  data/cards.ts      107 cards, hand-curated — the structural facts DoC does not publish
  data/*.json        generated: the flowchart, and the live bonus snapshots
  rules/counts.ts    5/24, inquiries per window, per-issuer velocity
  rules/issuers.ts   25 issuer rules as predicates, each returning when it lifts
  rules/reminders.ts the deadlines, derived and never stored
  rules/recommend.ts the flowchart, transcribed

src/server/          Node 24, no npm dependencies. One switch, no framework, no ORM.
app/                 Expo Router — iOS, Android and web from one codebase
test/                251 tests
```

**Every rule returns a date.** A verdict is `{ ruleId, issuer, title, severity, message, clearsAt }`,
where `clearsAt` is when the rule stops applying on its own and `null` means it never will. Severity
has four levels rather than two, because Chase's 5/24 is enforced by software, Amex's lifetime
language costs you the bonus but still opens the account, and Chase's velocity guideline is a
community-observed shutdown risk that a churner sometimes breaks on purpose. Collapsing those into
"blocked" makes an app either uselessly timid or dangerously quiet.

**Nothing derived is ever stored.** Not the 5/24 count, not a reminder, not a recommendation. They
are pure functions of the accounts, recomputed per request — microseconds over a few dozen rows, and
it means correcting a mistyped open date fixes every downstream date at once. A reminders table would
be a second source of truth that drifts the moment somebody fixes a typo.

**The app shares the types and none of the logic.** `@core/*` in the app's `tsconfig.json` is a
types-only path: `import type` is erased before Metro sees it, so nothing outside `app/` is bundled or
watched, and the app cannot accidentally grow its own copy of a rule that then disagrees with the
server's. The server computes, the app renders and fetches.

**No build step anywhere in the server.** The image is Node plus the source. Nothing to compile means
nothing to be out of date, and it is why `npm start` on a fresh clone works with an empty
`dependencies`.

**The tests run three times.** 251 of them, in UTC, `America/Los_Angeles` and `Asia/Tokyo`, because
every answer this thing gives is a date and a date library that is correct only in one timezone is
not correct.

<details>
<summary>The API surface</summary>

```
POST /v1/auth/register  /v1/auth/login  /v1/auth/logout  /v1/auth/password
GET  /v1/me             the user and their players
GET  /v1/catalog        the 107 cards, plus the live card offers matched onto them
GET  /v1/bank-offers    the bank bonus snapshot
GET  /v1/rules          the 25 rules, so the app can explain one it did not compute
GET  /v1/standing       the 5/24 count and the slot expiries behind it
GET  /v1/assess         every card, every rule that bears on it, and every date
GET  /v1/plan           the flowchart's recommendation, with its reasoning quoted
GET  /v1/reminders      the deadlines, derived per request
     /v1/cards  /v1/banks  /v1/inquiries  /v1/players  /v1/devices  /v1/sync
GET  /health            unauthenticated, and carries nothing worth reading
```

One version prefix, and a second would be a different prefix rather than a different shape. The three
read-only views check the method themselves, because a `PATCH /v1/standing` that answers 200 teaches
a client that a write succeeded.

</details>

Neither upstream data source is machine-readable — the flowchart is a draw.io diagram of prose
panels, and Doctor of Credit publishes an `<h3>` per offer with loose bullets under it — so both
parsers are heuristic and both are pinned by tests against checked-in fixtures of the real pages. The
scrape refuses to overwrite a good snapshot with a bad one: if the yield falls below a floor it fails
loudly and keeps the previous data, because a tracker showing last week's bonuses is fine and one
showing four bonuses because the markup moved is not.

## Accuracy, and who has the last word

**These are community-observed rules, not issuer policy.** Almost none of it is published by anyone
who could be held to it, all of it changes without notice, and the flowchart's own "Limitations"
panel leads with exactly that. Treat every date in here as an informed estimate.

So the app is built to be argued with:

- It always names the rule it is applying, and shows the arithmetic that produced the date.
- It always says when it expects an answer to change, rather than presenting one as permanent.
- It never refuses to let you record something it believes is impossible. If you were approved for a
  card the engine says you could not get, the engine is wrong and your history is right.
- The recommender's advice is quoted and attributed to a named, versioned source, so you can go and
  read the original and disagree with it.

You are the one who applies, and you are the one who gets denied. This is a tracker, not an oracle,
and a rule that has silently changed will look exactly like a rule that has not.

## Docs

| | |
|---|---|
| **[DEPLOYING.md](docs/DEPLOYING.md)** | Kamal, the two image shapes, the environment, and what to check when something is wrong |
| **[RELEASING.md](docs/RELEASING.md)** | Cutting a release, Android signing, and the iOS build |

## Licence

**AGPL-3.0** — see [LICENSE](LICENSE).

Chosen rather than inherited: nothing here is a port of anything, and none of the upstream work this
depends on imposes a licence on it. It matches the author's other projects, and §13 is the clause
that matters for something meant to be self-hosted — anyone who runs a *modified* version where other
people can reach it has to offer them the source. Plain GPL does not require that, and a server you
are asked to trust with your own financial history is precisely the case that gap was written for.

The card catalog's structural facts, the issuer rules and the flowchart transcription are
descriptions of publicly discussed behaviour. No code licence changes what the sources' own terms
allow.

## Credits

The two sources this is built on, neither of them affiliated with this project and neither asked for
anything in return:

- **[/u/m16p's Card Recommendation Flowchart][flowchart]** — the strategy the recommender follows,
  credited to **/u/m16p** and **/u/kevlarlover** and to the r/churning readers who have argued it into
  its current shape. Used at v21 (2025-06-09), quoted with its version recorded, and never
  paraphrased into something that sounds more certain than the original.
- **[Doctor of Credit](https://www.doctorofcredit.com)** — the live card and bank bonus data, read
  from the two public best-bonuses pages once a day and cached, so this project is not a load on
  theirs.

Issuer names and card names belong to their issuers. Nothing here is endorsed by, affiliated with, or
supported by any bank.

[flowchart]: https://m16p-churning.s3.us-east-2.amazonaws.com/Card+Recommendation+Flowchart+Latest.html
