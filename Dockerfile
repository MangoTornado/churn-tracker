# syntax=docker/dockerfile:1.7
#
# Two stages, and the asymmetry between them is the point.
#
# The **server** has no npm dependencies and nothing to compile: Node 24 runs its TypeScript directly
# by stripping the types, so there is no `npm ci` in the runtime stage and no lockfile to keep in
# step. Node 24 is a hard floor rather than a preference — `node:sqlite` and type stripping are both
# from it, and the server uses each in its first ten lines.
#
# The **app** genuinely does need building: it is an Expo project with a real dependency tree, and its
# web build is a Metro bundle. That happens in a stage that is thrown away, so none of it — not the
# 900MB of node_modules, not the Expo CLI, not a package manager — reaches the image that runs in
# production. What crosses over is a directory of static files.
#
# The result is one container serving one hostname: the API and the web app on the same origin, which
# is what lets the app need no configuration at all. See `src/server/web.ts`.
#
# Build the API alone with `--target api`, and the server then reports itself as API-only because the
# web directory is simply absent — see `serveWeb()`.

# ---- the web app ------------------------------------------------------------

FROM node:24-alpine AS web

WORKDIR /build

# The manifest first, so a change to app source does not invalidate the dependency layer. `npm ci`
# rather than `npm install` because the lockfile is what makes this build reproducible.
COPY app/package.json app/package-lock.json ./
RUN npm ci

COPY app/ ./

# `../src/core` is reachable from the app through a types-only path alias, and type-only imports are
# erased before Metro sees them — so the bundle needs the core sources present for the typecheck but
# not for the build. Copied in so `tsc` has something to resolve if it runs here.
COPY src/core/ /src/core/

# `--platform web` produces `dist/`: static HTML per route plus a content-hashed asset tree.
RUN npx expo export --platform web --output-dir dist

# ---- the server, with no app ------------------------------------------------

FROM node:24-alpine AS api

WORKDIR /app
ENV NODE_ENV=production

# `ca-certificates` because both outbound hosts are TLS, and `tzdata` because the notification hour
# is configured in UTC and an operator reading logs should be able to set TZ and have timestamps make
# sense.
RUN apk add --no-cache ca-certificates tzdata \
 && rm -rf /var/cache/apk/*

# In a container the only useful bind is every interface — the port is published to the host, or
# reached by kamal-proxy over the Docker network, and neither can see 127.0.0.1 in here.
ENV CT_HOST=0.0.0.0
ENV CT_PORT=8811

# The database holds password hashes and every user's churning history, so it lives on a volume rather
# than in an image layer. Created here with the right owner: a fresh named volume inherits the
# ownership of the directory it shadows, which is the only way the unprivileged user can write to it.
ENV CT_DATA=/data/churn-tracker.db
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

# `src/core/data` carries the checked-in bonus snapshots, so a container that has never managed to
# reach Doctor of Credit still starts with a usable catalog. The daily refresh writes over them inside
# the container, which means those writes do not survive a redeploy — deliberately: the snapshot in
# the image is reviewed in a diff, and the refresh is a convenience on top of it.
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts

USER node
EXPOSE 8811

# `/health` needs no credential and carries nothing worth reading — offer counts, the flowchart
# version, and whether registration is open. That makes it usable as a health check without baking a
# token into the image, and it stays JSON even when the web app is being served at `/`.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:8811/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "src/server/main.ts"]

# ---- the default: both ------------------------------------------------------

FROM api AS full

# The only difference from `api`. `serveWeb()` defaults to "yes if a build is present", so copying
# this directory in is what turns web serving on — no flag to remember, and the two deployment shapes
# fall out of which target was built. `CT_SERVE_WEB=0` still forces API-only at runtime.
COPY --from=web --chown=node:node /build/dist ./web
