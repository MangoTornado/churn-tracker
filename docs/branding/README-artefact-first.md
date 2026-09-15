<div align="center">

<img src="docs/branding/icon.png" width="104" alt="" />

# churn-tracker

**Every churning rule is a window of time, so every real answer is a date. This gives you the date.**

Cards and bank bonuses, 5/24 slots, annual-fee and minimum-spend deadlines, and what to apply for
next. iOS, Android and the web, against a server you run yourself.

[![Release](https://img.shields.io/github/v/release/MangoTornado/churn-tracker?display_name=tag&color=B9A0F5)](https://github.com/MangoTornado/churn-tracker/releases/latest)
[![iOS · Android · web](https://img.shields.io/badge/iOS%20%C2%B7%20Android%20%C2%B7%20web-Expo-7DD8A6?logo=expo&logoColor=white)](#getting-the-app)
[![Node 24+](https://img.shields.io/badge/Node-24%2B-5FA04E?logo=nodedotjs&logoColor=white)](#quick-start)
[![Licence AGPL-3.0](https://img.shields.io/badge/licence-AGPL--3.0-blue)](LICENSE)
[![CI](https://github.com/MangoTornado/churn-tracker/actions/workflows/ci.yml/badge.svg)](https://github.com/MangoTornado/churn-tracker/actions/workflows/ci.yml)

</div>

```
                     ┌──────┬──────┬──────┬ ─ ─ ─┬ ─ ─ ─┐
                     │ NOV  │ JAN  │ FEB  │      │      │
                     │ '26  │ '27  │ '28  │ open │ open │
                     └──────┴──────┴──────┴ ─ ─ ─┴ ─ ─ ─┘
                       frees up →

                     3/24   2 slots to spend
                            Next returns Nov '26.
```

That is the top of the home screen, and it is the entire argument for this app.

A number would not do it. "You are 3/24" answers half the question — it says how much room you have
and nothing about when you get more, which is the thing you opened the app to find out. So the count
is drawn as the rule's own shape: five cells, because the rule says five. A spent cell carries the
month that slot frees up, ordered soonest first, so the rail reads left to right as a queue of
returning capacity. An open slot is drawn as an absence rather than as another kind of cell. Two
slots now, a third in November: one glance, no arithmetic.

The same shape has to survive being stuck, which is where a digit fails completely:

```
                     ┌──────┬──────┬──────┬──────┬──────┐ ┌────┐
                     │ MAR  │ MAY  │ AUG  │ DEC  │ APR  │ │ +2 │
                     │ '27  │ '27  │ '27  │ '27  │ '28  │ │    │
                     └──────┴──────┴──────┴──────┴──────┘ └────┘

                     7/24   Chase is closed to you
                            Reopens Aug '27, when you drop to 4.
```

Seven is not a fuller version of five. It is two accounts standing outside a wall, so it is drawn
outside the wall. Being 7/24 *looks* like what it is, and it still tells you the month it ends — and
note that the month is August, the *third* cell, not March. Three accounts have to age out before you
are back under the wall. That is the kind of off-by-two a big number invites and a diagram does not.

Every other answer in here is that same move: 2/90, 1/8, 6/24, 2/3/4, 3/12-or-7/12 — 25 issuer rules,
none of which return a verdict, all of which return the date they stop applying.

> [!IMPORTANT]
> This never asks for a bank credential and cannot connect to an account. There is no aggregator, no
> account number, no balance, no transaction feed. Dates and dollar amounts you type in are all the
> rules need — see [What it does not do](#what-it-does-not-do).

## Contents

- [What it does](#what-it-does)
- [What it does not do](#what-it-does-not-do)
- [Quick start](#quick-start)
- [Getting the app](#getting-the-app)
- [Deploying it](#deploying-it)
- [How accurate is any of this](#how-accurate-is-any-of-this)
- [How it works](#how-it-works)
- [The data](#the-data)
- [Docs](#docs)
- [Credits](#credits)
- [Licence](#licence)

## What it does

🗂 **Tracks the accounts.** Cards and bank bonuses, open and closed, for one person or two. Closed
cards stay: 5/24 counts accounts *opened* in the last 24 months whether or not they are still open,
so deleting one would quietly give you a wrong number.

🚦 **Answers "can I get this?"** for any of 107 catalogued cards, naming every rule that bears on it
and the date each one lifts. Chase's 5/24 and its three-month velocity guideline, Amex's 2/90, 1-in-5,
five-credit-card limit and card-family rules, Citi's 1/8 and 2/65, Barclays' 6/24, Bank of America's
2/3/4 and 3/12-or-7/12, Capital One's opaque underwriting, US Bank and Wells Fargo, plus per-card and
per-family bonus cooldowns. Twenty-five rules across four severities, because a wall enforced by
software and a community-observed shutdown risk are not the same warning.

⏰ **Reminds you before it costs you.** Annual fees six weeks out, the roughly 30-day window to
reverse one that has already posted, minimum-spend deadlines with the shortfall named, bonuses that
met their terms and never arrived, bank bonuses you can finally close safely, and idle no-fee cards
about to be auto-closed. Sorted by date, then by how much is at stake. At most three pushes a person
a day, urgent and overdue only — a reminder app that cries wolf gets muted, and then the annual fee
that mattered arrives in silence.

🧭 **Recommends the next card** from [/u/m16p's Card Recommendation Flowchart][flowchart] (v21,
updated 2025-06-09), quoted and attributed rather than paraphrased, because it is explicitly
subjective and says so itself. Under 5/24 the plan is Chase-first with business cards as spacers;
past it, the biggest bonus a bank will still approve.

📈 **Keeps the bonus data current** from Doctor of Credit: 70 live card offers, 48 of them matched to
the catalog, and 250 bank offers. Refreshed daily and checked in as a snapshot, so the app still
works with the network down.

## What it does not do

This is the half worth reading before you run anything.

- **No bank credentials.** There is no login field for your bank, because there is nothing that could
  use one. No aggregator, no Plaid key, no OAuth to an issuer.
- **No account numbers, no balances, no transactions.** None of it is stored because none of it is
  asked for. What an account row holds is an issuer, a card, an open date, a fee date and an amount.
- **No third-party secret on the host.** The registry login for deploying is the whole list. There is
  nothing here to rotate and nothing worth stealing the database for.
- **Two outbound requests, both boring.** The daily Doctor of Credit refresh, and — only if you turn
  notifications on — a push through Expo's service. No analytics, no crash reporting.
- **No accounts for other people.** Registration is off by default; you open it, register, and close
  it again. The server logs a warning on every boot while it is open.

This is not a trade-off the app made to be careful. Every rule in churning is a function of *when* an
account opened, so dates are genuinely all the engine needs. The consequence is that a breach of this
server is embarrassing rather than ruinous.

## Quick start

Needs **Node 24 or newer**. That is a floor, not a preference: the server uses `node:sqlite` and runs
its TypeScript directly by stripping the types, and both arrived in 24.

```sh
git clone https://github.com/MangoTornado/churn-tracker
cd churn-tracker
make install   # checks the Node version. The server has zero dependencies.
make test      # 251 tests, no network
make dev       # API on :8811
```

The first account needs registration opened, since it is off by default:

```sh
CT_OPEN_REGISTRATION=1 npm start
```

| Command | |
|---|---|
| `make dev` | server on :8811, restarting on change |
| `make test` | the suite — no network required |
| `make typecheck` | `tsc --noEmit`, from a scratch install rather than a dependency |
| `make data` | re-scrape both data sources, then show you the diff |
| `make status` | ask a running server how it is doing |

There is no build step, no lockfile and no `node_modules` on the server side at all.

## Getting the app

The app is one Expo codebase on iOS, Android and the web.

```sh
make app-install      # the app does have dependencies
make app-start        # Expo dev server — scan the QR code with Expo Go
make app-web          # or just run it in a browser
make app-serve-local  # what production does: one origin, app at / and API under /v1
```

Deployed, the web app ships inside the server image, so opening the hostname is the entire setup —
there is no address to type, because the app takes the origin it was served from as its API. On a
phone there is no origin to inherit, so a standalone build asks for the server address on first
launch.

Each tagged release publishes a signed Android APK and the static web bundle as GitHub release
assets. iOS is not in CI: a distributable build needs an Apple Developer account and provisioning
profiles that cannot go in a public repo, so it is a local `make ios-archive`. A job that always
failed would be worse than the gap. See [docs/RELEASING.md](docs/RELEASING.md).

<!--
PLACEHOLDER — screenshots are not committed yet. When they are, drop the table below in here,
under the diagram at the top, and delete this comment. Do not uncomment it before the files exist.

| Home | Can I get this? | The plan |
|---|---|---|
| ![](docs/screenshots/home.png) | ![](docs/screenshots/consider.png) | ![](docs/screenshots/plan.png) |
-->

## Deploying it

Kamal 2, one container, one hostname, arm64 by default because the target is an Oracle Ampere box.
`kamal-proxy` takes port 80; put a Cloudflare Tunnel or another TLS terminator in front of it.

```sh
cp .kamal/secrets.sample .kamal/secrets   # registry username and password. That is the whole file.
$EDITOR config/deploy.yml                 # five TODO(...) markers
make setup                                # bootstrap and first deploy
make deploy                               # tests, then build and ship, every time after
make backup                               # copy the database down. Put this on a schedule.
```

**Back it up.** That volume holds the only copy of everybody's churning history. Unlike a cache there
is nothing to re-fetch — this data only ever existed there.

The image's final stage builds the web app and copies it in, so one process serves the app at `/` and
the API under `/v1`. `docker build --target api` gives you an API-only image instead; the server picks
its behaviour from whether a build is present, so there is no flag to keep in step.

**Everything else → [docs/DEPLOYING.md](docs/DEPLOYING.md).**

## How accurate is any of this

The rules here are **community-observed issuer behaviour, not issuer policy**. Almost none of it is
documented. All of it changes without notice, sometimes quietly and sometimes in the middle of an
application. The flowchart's own "Limitations" panel leads with that, and it is right to.

So the engine is built to be overruled:

- It **always names the rule** it is applying, in the domain's own notation, with the actual numbers
  in the sentence. `2/90` and "denied until 2026-04-03" are checkable claims; "not recommended" is not.
- It **separates a wall from a warning.** Chase's 5/24 is enforced by software. Amex's lifetime
  language costs you the bonus but still opens the account. Chase's three-month velocity guideline is
  not a rule at all — it is a shutdown risk that churners knowingly take. Collapsing those into
  "blocked" would make the app either uselessly timid or dangerously quiet.
- It **never refuses to let you record something** it believes is impossible. If you were approved
  through a wall, the app is wrong and your history is right.
- It **does not pretend Capital One is knowable.** Where underwriting is opaque, the app says so
  instead of inventing a threshold.

You are the one who gets denied, so you have the last word. Treat every date in here as a well-sourced
guess with its working shown, and verify anything expensive against r/churning before you act on it.

## How it works

Two decisions shape most of the rest.

**Nothing derived is ever stored.** Not the 5/24 count, not a reminder, not a recommendation. They are
pure functions of your accounts, recomputed per request. Over a few dozen rows that costs microseconds,
and it means correcting a mistyped open date fixes every downstream date at once. A reminders table
would be a second source of truth that starts drifting the moment somebody fixes a typo.

**The rules live in one place and the app fetches their answers.** `src/core` has no I/O, no framework
and no dependencies; the app imports it for types only and never recomputes a rule. One
implementation, tested once, rather than two that slowly disagree.

The suite is 251 tests and runs in UTC, `America/Los_Angeles` and `Asia/Tokyo` on every push. Date
arithmetic that is only correct in your own timezone is the failure mode this whole domain is made of:
every rule is a date comparison, and an off-by-one day west of Greenwich is a wrong answer about money.

## The data

Neither source is machine-readable, so both parsers are heuristic and both are pinned by tests against
checked-in fixtures of the real pages.

The flowchart is a draw.io diagram and not actually a flowchart: prose panels with a handful of edges
between them. `scripts/extract-flowchart.ts` lifts out the 14 panels and they stay prose, feeding the
recommender as strategy. The machine-checkable rules are written out by hand in
`src/core/rules/issuers.ts`, where they can be tested.

Doctor of Credit publishes an `<h3>` per offer with loose bullets underneath. The parser refuses to
overwrite a good snapshot with a bad one: if the yield falls below a floor it fails loudly and keeps
the previous data. A tracker showing last week's bonuses is fine. One showing four bonuses because the
markup moved is not.

```sh
make data          # re-scrape both sources, then review the diff
make refresh-force # ignore Last-Modified — what you want after changing a regex
```

Both sources are fetched conditionally and at most once a day. They are somebody else's pages and
somebody else's bandwidth.

## Docs

| | |
|---|---|
| **[DEPLOYING.md](docs/DEPLOYING.md)** | Kamal setup, the environment, the two image shapes, what to check when it breaks |
| **[RELEASING.md](docs/RELEASING.md)** | Cutting a release, Android signing, why iOS is a local build |

## Credits

This project is mostly other people's freely published work, wired together and given dates.

**[/u/m16p's Card Recommendation Flowchart][flowchart]**, maintained by **/u/m16p** with
**/u/kevlarlover**, is the recommendation logic. It is the accumulated judgement of r/churning, given
away for free, and the strategy in this app is theirs rather than mine. The version and update date
ship in the app next to every quotation, the panels are quoted rather than paraphrased so the wording
stays theirs, and the app links back to the original. If the two ever disagree, the flowchart is
right. Neither of them is affiliated with this, and neither has endorsed it.

**[Doctor of Credit](https://www.doctorofcredit.com)** is where the live card and bank bonuses come
from — two pages, read once a day, conditionally. Their reporting is the reason a churning tracker can
know what is on offer at all. Not affiliated, not endorsed, and not asked to carry any of this
traffic; if that ever becomes a problem, the polite fix is fewer requests, and the interval is one
environment variable.

The issuer rules are r/churning's collective observation, gathered over years by people who got
denied and then wrote it up. This repo only writes them down in a form a computer can check.

## Licence

**AGPL-3.0** — see [LICENSE](LICENSE).

Chosen for two plain reasons. It matches my other projects, so there is one licence to reason about
across all of them. And §13 is the clause that matters for something meant to be self-hosted: anyone
who runs a *modified* version where other people can reach it has to offer them the source. Plain GPL
does not require that, and a server you deploy for yourself and your partner is exactly the case that
gap was written for.

Nothing here is a port of anything. The rules are transcribed from public community knowledge and the
flowchart panels are quoted with attribution, which is a citation rather than a derivation — no code
came from anywhere. The design, the rules engine and the app are all first-party.

[flowchart]: https://m16p-churning.s3.us-east-2.amazonaws.com/Card+Recommendation+Flowchart+Latest.html
