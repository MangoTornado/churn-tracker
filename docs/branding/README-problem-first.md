<div align="center">

<img src="docs/branding/icon.png" width="104" alt="" />

# churn-tracker

**Churning goes wrong on dates, so this app answers in dates: when your next 5/24 slot comes back,
which deadline costs money this month, and what to apply for next.**

One server you run yourself, and one app on iOS, Android and the web.
It never asks for a bank credential and cannot connect to an account.

[![Release](https://img.shields.io/github/v/release/MangoTornado/churn-tracker?display_name=tag&color=B9A0F5)](https://github.com/MangoTornado/churn-tracker/releases/latest)
[![iOS · Android · Web](https://img.shields.io/badge/iOS%20%C2%B7%20Android%20%C2%B7%20Web-Expo-B9A0F5)](#getting-the-app)
[![Node 24+](https://img.shields.io/badge/Node-24%2B-5FA04E?logo=nodedotjs&logoColor=white)](#quick-start)
[![Server dependencies: none](https://img.shields.io/badge/server%20dependencies-none-7DD8A6)](#quick-start)
[![Licence AGPL-3.0](https://img.shields.io/badge/licence-AGPL--3.0-blue)](LICENSE)
[![CI](https://github.com/MangoTornado/churn-tracker/actions/workflows/ci.yml/badge.svg)](https://github.com/MangoTornado/churn-tracker/actions/workflows/ci.yml)

</div>

Three things go wrong when your churning history lives in a spreadsheet.

1. **You miscount 5/24 and Chase declines you.** The count is accounts *opened* in the last 24
   months, whether or not they are still open — so the row you deleted when you closed the card is
   still counting, an authorized-user card you forgot about is counting, and most business cards are
   not. You believed you were at 4/24. The hard pull is not refundable and you wait another month to
   try again.
2. **You pay an annual fee you meant to avoid.** The fee posts on a statement you skim. There is
   roughly a thirty-day window to call and have it reversed, and nothing tells you the window is
   open, so you find out in month four that a $695 card you were going to cancel renewed instead.
3. **You miss a minimum spend by four days.** Not by a lot of money — by $150 of spend and four
   days, on a bonus worth $1,200, because the deadline was six months out on the day you set it and
   six months is exactly long enough to forget.

And underneath all three, the quiet one: a bonus that met its terms months ago, never posted, and
nobody noticed, because nothing was keeping the score.

None of this is hard arithmetic. It is arithmetic nobody does on a Tuesday. So this app does it, and
draws the answer as the shape of the rule it came from:

```
                            ┌──────┬──────┬──────┬──────┬ ─ ─ ─┐
                            │ NOV  │ JAN  │ FEB  │ JUN  │      │
                            │ '26  │ '27  │ '28  │ '28  │ open │
                            └──────┴──────┴──────┴──────┴ ─ ─ ─┘
                              frees up →

                            4/24   1 slot to spend
                                   Next returns Nov '26.
```

Five cells, one per slot. Each filled cell carries the month that slot frees up, soonest first, so
the rail reads left to right as a timeline of returning capacity. A big number would tell you that
you are 4/24. This tells you the thing you opened the app for.

<!--
PLACEHOLDER — commented out on purpose. There are no screenshot files in the repo yet; uncomment
this table only once docs/screens/*.png actually exist.

| Home | Can I get this | Plan |
|---|---|---|
| ![](docs/screens/home.png) | ![](docs/screens/card.png) | ![](docs/screens/plan.png) |
-->

> [!IMPORTANT]
> This asks for dates and dollar amounts you type in yourself. It has no bank login, no aggregator
> and no read-only connection to anything — see [What it does not do](#what-it-does-not-do). Every
> rule in churning is a function of *when* an account opened, so dates are all the engine needs.

## Contents

- [What it does](#what-it-does)
- [What it does not do](#what-it-does-not-do)
- [Quick start](#quick-start)
- [Getting the app](#getting-the-app)
- [Deploying it](#deploying-it)
- [Accuracy, and who has the last word](#accuracy-and-who-has-the-last-word)
- [How it works](#how-it-works)
- [Docs](#docs)
- [Credits](#credits)
- [Licence](#licence)

## What it does

🗂️ **Tracks the accounts.** Cards and bank bonuses, open and closed, for one person or two. Closed
cards stay, because deleting one is how you get a wrong 5/24 number, and a wrong number is the first
failure on the list above.

🧮 **Answers "can I get this?"** for any of 107 catalogued cards, naming every rule that bears on it
and the date each one lifts. Chase's 5/24 and its three-month velocity guideline, Amex's 2/90, 1-in-5,
five-credit-card limit and card-family rules, Citi's 1/8 and 2/65, Barclays' 6/24, Bank of America's
2/3/4 and 3/12-or-7/12, Capital One's opaque underwriting, plus per-card and per-family bonus
cooldowns. Twenty-five rules, sorted into four severities — a wall, a likely denial, community
caution, a note — because "blocked" collapses things that are not the same kind of thing.

⏰ **Reminds you before it costs you.** Annual fees six weeks out, the reversal window on one that has
already posted, minimum-spend deadlines with the shortfall named in dollars, bonuses that met their
terms and never arrived, bank bonuses you can finally close safely, and idle no-fee cards about to be
auto-closed. Sorted by date, then by how much is at stake.

🧭 **Says what to apply for next**, following [/u/m16p's Card Recommendation Flowchart][flowchart]
(v21, updated 2025-06-09), quoted and attributed rather than paraphrased. Under 5/24 the plan is
Chase-first with business cards as spacers; past it, the biggest bonus a bank will still approve. The
flowchart's own reasoning travels with each recommendation, so you can read it and disagree.

📡 **Keeps the bonus data current** from Doctor of Credit's two best-bonuses pages: 70 live card
offers (48 of them matched to the catalogue) and 250 bank offers, refreshed daily and checked in as a
snapshot, so the app still works with the network down.

## What it does not do

**It never asks for a bank credential, and it could not use one.** There is no aggregator, no Plaid
key, no OAuth handshake with an issuer, no account number, no balance, no transaction feed, no
statement import. You type in open dates, fees and spend targets. That is the whole input.

That is a deliberate trade and it costs you some convenience — nothing is filled in for you. What it
buys:

| | |
|---|---|
| **A breach is embarrassing, not ruinous** | The database holds dates, dollar amounts and card names. Nobody's money is reachable from it. |
| **Nothing to rotate** | The server holds no third-party credential of any kind. Deploying it needs exactly two secrets, both of them your own container registry login. |
| **Nobody else's account either** | Registration is off by default. While it is on, the server logs a warning on every boot and says so in `/health`. |
| **No relationship with any issuer** | It does not apply for anything, tell anyone you are reading it, or transmit your history anywhere. The only outbound requests are to Doctor of Credit and the flowchart's own URL. |

It also cannot see anything you do not tell it. If you open a card and do not enter it, your 5/24
count is wrong, and the app has no way to know.

## Quick start

Needs **Node 24 or newer** and nothing else. That is a floor rather than a preference: the server
uses `node:sqlite` and runs its TypeScript directly by stripping the types, and both arrived in 24.

```sh
git clone https://github.com/MangoTornado/churn-tracker
cd churn-tracker

make install   # checks the Node version. There is nothing to install.
make test      # 251 tests, no network
make dev       # API on :8811
```

Registration is off by default, so the first account needs it opened once:

```sh
CT_OPEN_REGISTRATION=1 npm start
```

| Command | |
|---|---|
| `make dev` | server on :8811, restarting on change |
| `make test` | the suite — no network, no fixtures to download |
| `make typecheck` | `tsc --noEmit`, from a scratch install rather than a dependency |
| `make refresh` | re-scrape Doctor of Credit (conditional; a 304 does nothing) |
| `make data` | re-scrape both sources, then review the diff yourself |

Zero npm dependencies, no build step, no lockfile, no container required to run it.

## Getting the app

The app is one Expo codebase for iOS, Android and the web.

```sh
make app-install       # the app, unlike the server, does have dependencies
make app-start         # Expo dev server — scan the QR code with Expo Go
make app-web           # in a browser
make app-serve-local   # what production does: one origin, app at / and API under /v1
```

Or take a build from the [latest release](https://github.com/MangoTornado/churn-tracker/releases/latest):
a signed **Android APK** and the **web bundle** are published there by CI.

**There is no iOS download, and there will not be one from this repo.** A distributable iOS build
needs an Apple Developer account and provisioning profiles that cannot go in a public repository, so
iOS is a local `make ios-archive` on your own Mac with your own identity. A CI job that always failed
would be worse than saying so.

On a phone there is no origin to inherit, so the app asks for your server's address on first launch.
The deployed web app is served by the same process as the API and takes the origin it came from, which
is why opening the site is the entire setup.

## Deploying it

Kamal 2, one container, one hostname, arm64 by default. The image's final stage builds the web app and
copies it in, so `/` serves the app and `/v1` serves the API from one process — and the server decides
which it is doing by whether a build is present, so there is no flag to keep in step.

```sh
gem install kamal
cp .kamal/secrets.sample .kamal/secrets   # registry username and password. That is the list.
$EDITOR config/deploy.yml                 # five TODO(...) markers
make setup                                # bootstrap and first deploy
make deploy                               # every time after that
```

`docker build --target api` gives an API-only image instead, for running the app from a local Expo dev
server against a deployed API.

> [!WARNING]
> **Back up the volume.** It holds the only copy of everybody's churning history. Unlike a cache
> there is nothing to re-fetch — this data only ever existed there. `make backup` writes a timestamped
> copy into the working directory. Put it on a schedule.

**Everything else, including the environment table and the two failures worth recognising →
[docs/DEPLOYING.md](docs/DEPLOYING.md).**

## Accuracy, and who has the last word

**These rules are community-observed issuer behaviour, not issuer policy.** Almost none of it is
documented, all of it changes without notice, and the flowchart's own "Limitations" panel leads with
that. Chase's 5/24 is enforced by software and behaves like a wall; Chase's three-month velocity
guideline is not a rule at all but an observed shutdown risk that churners knowingly break; Amex's
lifetime language costs you a bonus while still opening the account. Those are three different things
and the app does not pretend otherwise.

So it is built to be overruled:

- Every verdict **names the rule it came from** and gives the date it expects the answer to change.
  You can check the reasoning against your own data points.
- It **never refuses to let you record something** it thinks is impossible. It has an opinion, not a
  veto.
- Recommendations arrive **with the flowchart's own words attached**, marked as one person's
  explicitly subjective priority order, because that is what they are.

The 251 tests run in UTC, `America/Los_Angeles` and `Asia/Tokyo`, because a date rule that is right in
one timezone and a day out in another is the most likely way this is wrong. But be clear about what
that proves: the tests pin the arithmetic, not the rules. They cannot tell you that Chase still
enforces 5/24 this month. You are the one who gets denied, so you get the last word.

## How it works

**Nothing derived is ever stored.** Not the 5/24 count, not a reminder, not a recommendation — they
are pure functions of your accounts, recomputed per request. Over a few dozen rows that costs
microseconds, and it means correcting a mistyped open date fixes every downstream date at once. A
reminders table would be a second source of truth that drifts the moment somebody fixes a typo.

**The rules live in one place.** `src/core` has no I/O, no framework and no dependencies; the app
imports it for types only and never recomputes a rule. One implementation, tested once, rather than
two that slowly disagree.

**Both data sources are prose, so both parsers are heuristic and both are pinned by tests against
checked-in fixtures of the real pages.** The Doctor of Credit parser refuses to overwrite a good
snapshot with a bad one: if the yield falls below a floor it fails loudly and keeps the previous data,
because a tracker showing last week's bonuses is fine and one showing four offers because the markup
moved is not. The flowchart is a draw.io diagram rather than an actual flowchart — 14 prose panels
with five edges between them — so the panels stay prose and feed the recommender as strategy, while
the machine-checkable rules are written out by hand where they can be unit-tested.

## Docs

| | |
|---|---|
| **[DEPLOYING.md](docs/DEPLOYING.md)** | Kamal, the environment, backups, and what breaks |
| **[RELEASING.md](docs/RELEASING.md)** | Tagging a release, Android signing, why iOS is local |

## Credits

The strategy is **[/u/m16p's Card Recommendation Flowchart][flowchart]**, maintained by **/u/m16p**
and originated by **/u/kevlarlover** on r/churning, and given away for free for years. This app
quotes it, versions it (v21, 2025-06-09) and attributes every panel it uses, because it is their
reasoning and not this app's, and because it says of itself that it is subjective. If you find it
useful here, read the original.

The live bonus data is **[Doctor of Credit](https://www.doctorofcredit.com)**'s
[best card bonuses](https://www.doctorofcredit.com/best-current-credit-card-sign-bonuses/) and
[best bank account bonuses](https://www.doctorofcredit.com/best-bank-account-bonuses/) pages. The
scraper is conditional and runs at most once a day, and a `304` does nothing, so it costs them a
header exchange rather than a page render. Offers link back to their write-ups.

**Neither is affiliated with this project, endorses it, or has been asked about it.** Both publish
freely and this reads what they publish; nothing here is scraped for republication, and the app is a
worse product than either source used directly if what you want is the source. Card names and issuer
marks belong to their issuers. The card catalogue is hand-curated in this repo — the structural facts
neither source publishes — and its mistakes are mine.

## Licence

**AGPL-3.0** — see [LICENSE](LICENSE).

Chosen for two reasons. It matches the author's other projects, so there is one licence to reason
about across all of them. And §13 is the clause that matters for something meant to be self-hosted:
anyone who runs a *modified* version where other people can reach it has to offer them the source.
Plain GPL does not require that, and a small server you are invited to put on the internet for your
household is exactly the case that gap was written for.

Nothing here is a port of anything. The rules engine was written from the community's own descriptions
of issuer behaviour, and the flowchart's text is quoted, attributed and versioned rather than absorbed
into the code. No licence here changes what either source's own terms allow.

[flowchart]: https://m16p-churning.s3.us-east-2.amazonaws.com/Card+Recommendation+Flowchart+Latest.html
