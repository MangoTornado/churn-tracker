<div align="center">

<img src="docs/branding/icon.png" width="104" alt="" />

# churn-tracker

**A churning tracker whose rules engine answers with a date instead of a yes or a no.**

What you hold, when each 5/24 slot comes back, which deadlines cost money if you miss them, and what
to apply for next. Credit cards and bank bonuses, for one person or two, on iOS, Android and the web,
against a server you run yourself.

[![Release](https://img.shields.io/github/v/release/MangoTornado/churn-tracker?display_name=tag&color=B9A0F5)](https://github.com/MangoTornado/churn-tracker/releases/latest)
[![iOS · Android · web](https://img.shields.io/badge/iOS%20%C2%B7%20Android%20%C2%B7%20web-Expo-7DD8A6?logo=expo&logoColor=white)](#getting-the-app)
[![Node 24+](https://img.shields.io/badge/Node-24%2B-5FA04E?logo=nodedotjs&logoColor=white)](#quick-start)
[![Server dependencies: none](https://img.shields.io/badge/server%20dependencies-none-7DD8A6)](#how-it-works)
[![Licence AGPL-3.0](https://img.shields.io/badge/licence-AGPL--3.0-blue)](#licence)
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

**No rule returns a boolean.** "Denied" is not useful, so none of the 25 issuer rules returns one —
each returns the date it stops applying. That is why the home screen draws your 5/24 count as the
rule's own shape rather than as a digit: five cells, the spent ones carrying the month that slot
frees up, soonest first. Two slots now, a third in November, one glance, no arithmetic.

> [!IMPORTANT]
> This never asks for a bank credential and cannot connect to an account. There is no aggregator, no
> account number, no balance, no transaction feed. Dates and dollar amounts you type in are all the
> rules need — see [What it deliberately does not do](#what-it-deliberately-does-not-do).

<details>
<summary><b>Why five cells, and what the count actually counts</b></summary>

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

**What the count counts.** The count is accounts *opened* in the last 24 months, whether or not they
are still open — so the row you deleted when you closed the card is still counting, an authorized-user
card you forgot about is counting, and most business cards are not. You believed you were at 4/24. The
hard pull is not refundable and you wait another month to try again. Which is why a closed card is
never deleted here, only marked closed.

An empty slot is drawn as an absence rather than as another kind of cell, and the cells are
deliberately not contiguous: a slot is a discrete thing you spend, and the gaps say so.

</details>

## Contents

- [What it does](#what-it-does)
- [What it deliberately does not do](#what-it-deliberately-does-not-do)
- [Quick start](#quick-start)
- [Getting the app](#getting-the-app)
- [Deploying it](#deploying-it)
- [Accuracy, and who has the last word](#accuracy-and-who-has-the-last-word)
- [How it works](#how-it-works)
- [The data](#the-data)
- [Docs](#docs)
- [Credits](#credits)
- [Licence](#licence)

## What it does

🗂 **Tracks the accounts.** Cards and bank bonuses, open and closed, for one person or two. Closed
cards stay, because 5/24 counts what was opened rather than what is held, and deleting a row would
quietly give you a wrong number.

🚦 **Answers "can I get this?"** for any of 107 catalogued cards, naming every rule that bears on it
and the date each one lifts. Chase's 5/24 and its three-month velocity guideline, Amex's 2/90, 1-in-5,
five-credit-card limit and card-family rules, Citi's 1/8 and 2/65, Barclays' 6/24, Bank of America's
2/3/4 and 3/12-or-7/12, Capital One's opaque underwriting, plus per-card and per-family bonus
cooldowns. Twenty-five rules across four severities, because a wall enforced by software and a
community-observed shutdown risk are not the same warning.

⏰ **Reminds you before it costs you.** Annual fees six weeks out, the roughly 30-day window to
reverse one that has already posted, minimum-spend deadlines with the shortfall named, bonuses that
met their terms and never arrived, bank bonuses you can finally close safely, and idle no-fee cards
about to be auto-closed. Sorted by date, then by how much is at stake. At most three pushes a person
a day, urgent and overdue only — a reminder app that cries wolf gets muted, and then the annual fee
that mattered arrives in silence.

🧭 **Recommends the next card** from [/u/m16p's Card Recommendation Flowchart][flowchart] (v21,
updated 2025-06-09, 14 panels extracted), quoted and attributed rather than paraphrased, because it is
explicitly subjective and says so itself. Under 5/24 the plan is Chase-first with business cards as
spacers; past it, the biggest bonus a bank will still approve.

📈 **Keeps the bonus data current** from Doctor of Credit: 70 live card offers, 48 of them matched to
the catalog, and 250 bank offers. Refreshed daily and checked in as a snapshot, so a fresh clone and a
server with no network still work.

The domain talks in fractions — 5/24, 2/90, 1/8, 6/24, 8/65 — and every one of them is a window of
time, which is the whole reason the engine deals in dates.

## What it deliberately does not do

**It never asks for a bank credential, and it cannot connect to an account.** No aggregator, no Plaid
key, no OAuth to any bank, no account number, no balance, no transaction feed, no card number, no
statement import. You type in dates and dollar amounts, and that is all the engine is given.

That is not a roadmap gap. Every rule in churning is a function of *when* an account was opened, so
dates and amounts are genuinely sufficient — and the consequences are the checkable part:

- A breach of this server is embarrassing rather than ruinous. There is nothing on it that moves
  money and nothing that identifies an account.
- There is no third-party secret to rotate, so `.kamal/secrets` holds exactly two values: a registry
  username and a registry password.
- It talks to two places, and each has an environment variable that turns it off. `CT_REFRESH_HOURS=0`
  stops the daily Doctor of Credit refresh. `CT_NOTIFICATIONS=0` stops the daily push batch, which
  goes through Expo's public push endpoint and carries a reminder's title and body — so a card name, a
  dollar amount and a date leave the host if you turn notifications on. Nothing else does. No
  analytics, no crash reporting, no telemetry.

Registration is off by default, and opening it is a deliberate two-step: turn it on, register, turn it
off. While it is on, anybody who can reach the hostname can create an account, so the server logs a
warning on every boot, `/health` reports `registrationOpen: true`, and the deploy workflow raises that
as a GitHub annotation.

It also cannot see anything you do not tell it. If you open a card and do not enter it, your 5/24
count is wrong, and the app has no way to know.

## Quick start

Needs **Node 24 or newer**. That is a floor rather than a preference: the server uses `node:sqlite`
and runs its TypeScript directly by stripping the types, and both arrived in 24.

```sh
git clone https://github.com/MangoTornado/churn-tracker
cd churn-tracker

make install   # checks the Node version. There is nothing to install.
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
| `make test` | the suite — no network, no fixtures to download |
| `make typecheck` | `tsc`, installed into a scratch dir rather than as a dependency |
| `make data` | re-scrape Doctor of Credit and re-extract the flowchart, then read the diff |
| `make refresh-force` | ignore `Last-Modified` — what you want after changing a parser regex |
| `make docker-run` | the image locally on :8811, app at `/` and API under `/v1` |

Zero npm dependencies on the server side, no build step and no lockfile.

## Getting the app

One Expo codebase covers iOS, Android and the web.

| | |
|---|---|
| **Web** | Ships inside the server image. Open your own hostname and that is the entire setup — the app takes the origin it was served from as its API. |
| **Android** | A signed APK on each [release](https://github.com/MangoTornado/churn-tracker/releases/latest), alongside the static web bundle. |
| **iOS** | Built on your own Mac with your own Apple Developer identity — see [RELEASING.md](docs/RELEASING.md). |
| **Either, in development** | `make app-install`, then `make app-start` and scan the QR code with Expo Go. |

**There is no iOS download, and there will not be one from this repo.** A distributable iOS build
needs an Apple Developer account and provisioning profiles that cannot go in a public repository, so
iOS is a local `make ios-archive`. A CI job that always failed would be worse than saying so.

On a phone there is no origin to inherit, so the app asks for your server's address on first launch.
That is the one field the deployed web app hides. Push reminders also need an EAS project id; without
one a standalone build cannot mint a push token, and the Settings screen says so rather than failing
quietly.

## Deploying it

[Kamal 2](https://kamal-deploy.org), one container, one hostname. The image serves the web app at `/`
and the API under `/v1`, from one process.

```sh
gem install kamal
cp .kamal/secrets.sample .kamal/secrets   # registry username and password. That is the whole file.
$EDITOR config/deploy.yml                 # five TODO(...) markers
make setup                                # bootstrap the host and first deploy
make deploy                               # tests, then build and ship, every time after
make backup                               # copy the database down. Put this on a schedule.
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

## Accuracy, and who has the last word

**These rules are community-observed issuer behaviour, not issuer policy.** Almost none of it is
published by anyone who could be held to it, all of it changes without notice, and the flowchart's own
"Limitations" panel leads with exactly that. Chase's 5/24 is enforced by software and behaves like a
wall; Amex's lifetime language costs you the bonus but still opens the account; Chase's three-month
velocity guideline is not a rule at all but an observed shutdown risk that churners knowingly take.
Those are three different things and the app does not pretend otherwise.

So it is built to be overruled:

- Every verdict **names the rule it came from**, in the domain's own notation, and gives the date it
  expects the answer to change. `2/90` and "denied until 2026-04-03" are checkable claims; "not
  recommended" is not.
- It **never refuses to let you record something** it believes is impossible. If you were approved for
  a card the engine says you could not get, the engine is wrong and your history is right. It has an
  opinion, not a veto.
- It **does not pretend Capital One is knowable.** Where underwriting is opaque, the app says so
  instead of inventing a threshold.
- Recommendations arrive **with the flowchart's own words attached**, marked as one person's
  explicitly subjective priority order, because that is what they are.

The 251 tests run in UTC, `America/Los_Angeles` and `Asia/Tokyo`, because a date rule that is right in
one timezone and a day out in another is the most likely way this is wrong. But be clear about what
that proves: the tests pin the arithmetic, not the rules. They cannot tell you that Chase still
enforces 5/24 this month.

You are the one who applies, and you are the one who gets denied. This is a tracker, not an oracle,
and a rule that has silently changed will look exactly like a rule that has not.

## How it works

Two decisions shape most of the rest.

**Nothing derived is ever stored.** Not the 5/24 count, not a reminder, not a recommendation. They are
pure functions of your accounts, recomputed per request. Over a few dozen rows that costs microseconds,
and it means correcting a mistyped open date fixes every downstream date at once. A reminders table
would be a second source of truth that starts drifting the moment somebody fixes a typo.

**The rules live in one place and the app fetches their answers.** `src/core` has no I/O, no framework
and no dependencies. The app imports it for types only — `import type` is erased before Metro sees it,
so nothing outside `app/` is bundled — and it never recomputes a rule. One implementation, tested
once, rather than two that slowly disagree.

A verdict is `{ ruleId, issuer, title, severity, message, clearsAt }`, where `clearsAt` is when the
rule stops applying on its own and `null` means it never will. Severity has four levels rather than
two, for the reason in [Accuracy](#accuracy-and-who-has-the-last-word): collapsing a wall and a
shutdown risk into "blocked" makes an app either uselessly timid or dangerously quiet. The rules
themselves are in [`src/core/rules/issuers.ts`](src/core/rules/issuers.ts), one object each.

The server is one Node 24 process with zero npm dependencies: `node:sqlite` for storage, one switch
statement for the HTTP surface, no ORM, no framework, no build step. The image is Node plus the
source, which is why nothing in it can be out of date with anything else.

## The data

Neither upstream source is machine-readable, so both parsers are heuristic and both are pinned by
tests against checked-in fixtures of the real pages.

The flowchart is a draw.io diagram and not actually a flowchart: 14 prose panels with a handful of
edges between them. [`scripts/extract-flowchart.ts`](scripts/extract-flowchart.ts) lifts the panels
out and they stay prose, feeding the recommender as strategy. The machine-checkable rules are written
out by hand where they can be tested. That script is a development tool you run deliberately, not
something the server does.

Doctor of Credit publishes an `<h3>` per offer with loose bullets underneath. The parser refuses to
overwrite a good snapshot with a bad one: if the yield falls below a floor it fails loudly and keeps
the previous data. A tracker showing last week's bonuses is fine. One showing four bonuses because the
markup moved is not.

```sh
make refresh       # Doctor of Credit, conditionally — a 304 does nothing
make data          # both sources, then review the diff
make refresh-force # ignore Last-Modified — what you want after changing a regex
```

The running server asks Doctor of Credit at most once a day and asks conditionally, so an unchanged
page costs a header exchange rather than a page render. It is somebody else's bandwidth, and the
interval is one environment variable.

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
ship next to every quotation, the panels are quoted rather than paraphrased so the wording stays
theirs, and the app links back to the original. If the two ever disagree, the flowchart is right.

**[Doctor of Credit](https://www.doctorofcredit.com)** is where the live card and bank bonuses come
from — two public pages, read once a day, conditionally. Their reporting is the reason a churning
tracker can know what is on offer at all. If that traffic ever becomes a problem the polite fix is
fewer requests, and it is one variable.

Neither is affiliated with this project, endorses it, or has been asked about it. The issuer rules are
r/churning's collective observation, gathered over years by people who got denied and then wrote it
up; this repo only writes them down in a form a computer can check. The card catalog is hand-curated
here — the structural facts neither source publishes — and its mistakes are mine. Card and issuer
names belong to their issuers.

## Licence

**[AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.html).**

Chosen rather than inherited: nothing here is a port of anything, and none of the upstream work this
depends on imposes a licence on it. It matches the author's other projects, so there is one licence to
reason about across all of them. And §13 is the clause that matters for something meant to be
self-hosted — anyone who runs a *modified* version where other people can reach it has to offer them
the source. Plain GPL does not require that, and a server you are invited to put on the internet for
your household is exactly the case that gap was written for.

The card catalog's structural facts, the issuer rules and the flowchart transcription are descriptions
of publicly discussed behaviour, quoted and attributed where they are quoted. No code came from
anywhere, and no licence here changes what either source's own terms allow.

[flowchart]: https://m16p-churning.s3.us-east-2.amazonaws.com/Card+Recommendation+Flowchart+Latest.html
</content>
</invoke>
