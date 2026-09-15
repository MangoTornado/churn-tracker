# Deploying

Kamal 2, one container, one hostname. The image serves the web app at `/` and the API under `/v1`, so
the deployed app needs no configuration at all — it takes the origin it was served from as its API.

Set up the same way as the melisma server: kamal-proxy on the host's port 80, with a Cloudflare Tunnel
or another TLS terminator in front. TLS is not terminated in the container.

## First deploy

1. **Install Kamal.** It is a gem; `mise.toml` pulls Ruby in for exactly this reason.

   ```sh
   gem install kamal
   ```

2. **Fill in `config/deploy.yml`.** Five `TODO(...)` markers: the registry path, the host, the SSH
   user, the registry server, and the hostname you will point at it.

3. **Fill in `.kamal/secrets`.**

   ```sh
   cp .kamal/secrets.sample .kamal/secrets
   ```

   Two values, and that is the whole list — the registry username and password. This server holds no
   third-party credential of any kind; see the note at the bottom of `config/deploy.yml`.

4. **Bootstrap.**

   ```sh
   make setup
   ```

   This builds the image (including the web app, in a stage that is thrown away), pushes it, installs
   Docker and kamal-proxy on the host if needed, and boots the container.

5. **Create your account.** Registration is off by default and there is no email verification, so the
   sequence is deliberate:

   ```sh
   # In config/deploy.yml, set CT_OPEN_REGISTRATION: "1"
   make deploy
   # Open the hostname, create your account (and your partner's, if two-player)
   # Set CT_OPEN_REGISTRATION: "0"
   make deploy
   ```

   While it is on, the server logs a warning on every boot and `/health` reports
   `registrationOpen: true`. The deploy workflow surfaces that as a GitHub warning annotation.

## Day to day

```sh
make deploy     # tests, then build and ship
make redeploy   # roll the current image again, no rebuild
make logs       # tail proxy + app
make status     # ask the running server how it is doing
make console    # a shell inside the container
make rollback   # back to the previous image
make backup     # copy the database down, timestamped
```

**Back up.** That volume holds the only copy of everybody's churning history. Unlike a cache there is
nothing to re-fetch — this data only ever existed there. `make backup` writes a timestamped copy into
the working directory; put it on a schedule.

## Two deployment shapes

The Dockerfile has two useful targets, and the server picks its behaviour from what is in the image
rather than from a setting you have to keep in step.

| | `make docker-build` (default) | `make docker-build-api` |
|---|---|---|
| Target | `full` | `api` |
| `/` | the web app | the health JSON |
| `/v1` | the API | the API |
| Image size | app bundle included | server only |

`serveWeb()` defaults to "serve it if a build is present", so the `full` image serves both and the
`api` image serves only the API. `CT_SERVE_WEB=0` forces API-only from a `full` image — useful when
running the app from a local Expo dev server against a deployed API.

## Deploying from GitHub Actions

`.github/workflows/deploy.yml` runs the same `kamal deploy`. It is **manual by default** — the volume
on that host holds the only copy of everyone's data, so shipping is a thing to decide to do rather than
something a merge does while you are looking elsewhere. Uncomment the `push:` trigger if you disagree.

Four repository secrets:

| Secret | What it is | How to get it |
|---|---|---|
| `KAMAL_REGISTRY_USERNAME` | Registry user | Your registry account |
| `KAMAL_REGISTRY_PASSWORD` | Registry token | A deploy token, not your password |
| `SSH_PRIVATE_KEY` | Deploy key, in full | `ssh-keygen -t ed25519 -f deploy_key`, then add `deploy_key.pub` to the host's `~/.ssh/authorized_keys` |
| `SSH_KNOWN_HOSTS` | The host's public key | `ssh-keyscan <host>` |

`SSH_KNOWN_HOSTS` is pinned rather than the workflow using `StrictHostKeyChecking=no`. Turning the
check off would let anything answering on that address receive an SSH agent connection and a registry
login.

## The environment

Everything is optional; the defaults are the deployed shape.

| Variable | Default | What it does |
|---|---|---|
| `CT_HOST` | `127.0.0.1` | Bind address. The container sets `0.0.0.0`. |
| `CT_PORT` | `8811` | Not melisma's 8787 — two services on one host cannot share a container port. |
| `CT_DATA` | `data/churn-tracker.db` | The SQLite file. The container points it at the volume. |
| `CT_OPEN_REGISTRATION` | `0` | Whether anyone can create an account. See above. |
| `CT_SERVE_WEB` | *build present* | Force web serving on or off. Normally leave unset. |
| `CT_WEB_DIR` | `web/` | Where the built app is. Overridden locally by `make app-serve-local`. |
| `CT_REFRESH_HOURS` | `24` | How often to re-scrape Doctor of Credit. `0` disables it. |
| `CT_NOTIFY_HOUR_UTC` | `14` | The hour, UTC, that push reminders go out. One batch a day. |
| `CT_NOTIFICATIONS` | `1` | Turns pushes off without unregistering devices. |
| `CT_TRUST_PROXY` | `0` | Trust `X-Forwarded-For`. On behind kamal-proxy, off with nothing in front. |

## The mobile apps

The web app ships with the server. iOS and Android are separate, through EAS:

```sh
cd app
npx eas init                          # once, to get a project id for push tokens
npx eas build --platform android
npx eas build --platform ios
```

Push notifications need that project id — without one, a standalone build cannot mint an Expo push
token, and the Settings screen says so explicitly rather than failing quietly.

On a phone there is no origin to inherit, so the app asks for the server address on first launch. That
is the field the deployed web app hides.

## When something is wrong

```sh
make logs                  # proxy + app
make app-logs              # just the app container
make status                # the health JSON from inside the container
kamal app exec --reuse "cat /data/churn-tracker.db" | wc -c   # is the volume mounted?
```

`/health` answers unauthenticated and carries nothing worth reading — offer counts, the flowchart
version, whether registration is open, and whether the web app is being served. It is also the
container healthcheck and the app's own reachability probe, which is why it stays JSON even when the
web app is being served at `/`.

Two failures worth recognising:

**A deploy that fails at the pull rather than the build**, with `no matching manifest for
linux/arm64/v8`. The target is an Oracle Ampere A1; `builder.arch` in `config/deploy.yml` is `arm64`
for that reason, and CI builds arm64 so this surfaces on a pull request instead.

**The app loads but every request fails.** Check `/health` in a browser. If that works and the app does
not, the bundle and the API have gone out of step — a cached bundle against a newer server. A hard
reload fixes it; the app is built to degrade rather than white-screen when a response is shaped by a
different version.
