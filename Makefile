# churn-tracker — operational commands.
#
# Most deploy targets delegate to Kamal. Requires Kamal 2.x (gem install kamal).
#
# First-time setup:
#   1. cp .kamal/secrets.sample .kamal/secrets  && fill in the registry details
#   2. edit config/deploy.yml and replace the TODO(...) markers
#   3. make setup        (builds image, pushes, boots server, boots app)
#   4. make open-signup  (lets you register), register, then make close-signup
#
# Regular workflow:
#   make test            (248 tests, no network)
#   make refresh         (re-scrape Doctor of Credit into src/core/data)
#   make deploy          (rebuild + ship)
#   make logs            (tail app logs)
#   make backup          (copy the deployed database here, timestamped)

.PHONY: help install dev test typecheck refresh refresh-force flowchart data \
        docker-build docker-build-api docker-run setup deploy redeploy logs app-logs \
        console restart rollback stop backup status open-signup close-signup \
        app-install app-start app-web app-build-web app-serve-local app-typecheck

help:
	@grep -E '^[a-zA-Z_-]+:.*?##' Makefile | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-16s %s\n", $$1, $$2}'

# ---- the server -----------------------------------------------------------

install: ## Nothing to install — zero dependencies. Checks the Node version instead.
	@node -e "const [major] = process.versions.node.split('.').map(Number); \
	  if (major < 24) { console.error('Node 24+ required, found ' + process.versions.node); process.exit(1); } \
	  console.log('Node ' + process.versions.node + ' — good. No dependencies to install.')"

dev: ## Local server on :8811, restarting on change
	npm run dev

test: ## Run the suite (no network required)
	npm test

typecheck: ## Typecheck with tsc, installed into a scratch dir rather than as a dependency
	@# Not a dependency: nothing compiles, Node strips the types. But `erasableSyntaxOnly` in
	@# tsconfig.json is what stops a stray enum or parameter property from reaching the runtime,
	@# where it would be a startup crash rather than a type error.
	@#
	@# Into `.tools/` rather than through `npx -p`: npx puts the packages somewhere tsc's own
	@# type-root walk does not reach, so `@types/node` is invisible and every `node:` import fails
	@# with TS2688. A real node_modules with an explicit --typeRoots is the version that works.
	@mkdir -p .tools
	@test -x .tools/node_modules/.bin/tsc || \
	  npm install --silent --no-save --no-package-lock --prefix .tools typescript@5.9 @types/node@24
	.tools/node_modules/.bin/tsc --noEmit -p tsconfig.json --typeRoots .tools/node_modules/@types

# ---- the data pipeline ----------------------------------------------------

refresh: ## Re-scrape Doctor of Credit (conditional — a 304 does nothing)
	npm run refresh

refresh-force: ## Re-scrape ignoring Last-Modified. Use after changing a parser regex.
	node scripts/refresh-doc.ts --force

flowchart: ## Re-extract the r/churning card recommendation flowchart
	npm run flowchart

data: refresh flowchart ## Refresh every checked-in data snapshot
	@echo "\nReview the diff before committing — these are somebody else's pages and the parsers are heuristic."
	@git --no-pager diff --stat src/core/data/ || true

# ---- deployment ----------------------------------------------------------

docker-build: ## Build the image locally (server + web app)
	docker build -t churn-tracker:local .

docker-build-api: ## Build an API-only image, with no web app in it
	docker build --target api -t churn-tracker:api .

docker-run: ## Run the image locally on :8811 — web app at / and API under /v1
	docker run --rm -p 8811:8811 -v churn-tracker-data:/data -e CT_OPEN_REGISTRATION=1 churn-tracker:local

setup: ## First-time Kamal bootstrap on the target host
	kamal setup

deploy: test ## Run the tests, then rebuild and ship
	kamal deploy

redeploy: ## Redeploy without rebuilding (hot roll the current image)
	kamal redeploy

logs: ## Stream proxy + app logs
	kamal logs -f

app-logs: ## Stream just app container logs
	kamal app logs -f

console: ## Open a shell inside the running container
	kamal app exec --interactive --reuse sh

restart: ## Restart the app containers
	kamal app restart

rollback: ## Roll back to the previous image version
	kamal rollback

stop: ## Stop the app (leaves the proxy up)
	kamal app stop

status: ## Ask the deployed server how it is doing
	kamal app exec --reuse "node -e \"fetch('http://127.0.0.1:8811/health').then(r=>r.json()).then(j=>console.log(JSON.stringify(j,null,2)))\""

backup: ## Copy the deployed database here, timestamped
	@# The only irreplaceable thing in this project. Unlike melisma's cache there is nothing to
	@# re-fetch — this data only ever existed on that volume.
	kamal app exec --reuse "cat /data/churn-tracker.db" > "churn-tracker-$$(date +%Y%m%d-%H%M%S).db"
	@echo "Wrote churn-tracker-$$(date +%Y%m%d-%H%M%S).db"

open-signup: ## Allow registration on the deployed server (remember to close it again)
	kamal app exec --reuse "node -e \"process.exit(0)\"" >/dev/null 2>&1 || true
	@echo "Set CT_OPEN_REGISTRATION=1 in config/deploy.yml and run 'make deploy'."
	@echo "Registration is also togglable at runtime:"
	@echo "  curl -X PATCH https://<host>/v1/admin/settings -H 'Authorization: Bearer <token>' \\"
	@echo "       -H 'Content-Type: application/json' -d '{\"auth.openRegistration\":\"1\"}'"
	@echo "...but that needs an account already, so the first one has to come from the env var."

close-signup: ## Reminder of how to close registration again
	@echo "Set CT_OPEN_REGISTRATION=0 in config/deploy.yml and run 'make deploy'."

# ---- the app ------------------------------------------------------------

app-install: ## Install the Expo app's dependencies
	cd app && npm ci

app-typecheck: ## Typecheck the app (it has its own tsconfig and lib)
	cd app && npx tsc --noEmit

app-start: ## Expo dev server — scan the QR code with Expo Go
	cd app && npx expo start

app-web: ## Run the app in a browser
	cd app && npx expo start --web

app-build-web: ## Static web build into app/dist (the image builds this itself)
	cd app && npx expo export --platform web --output-dir dist

app-serve-local: app-build-web ## Build the web app and serve it from the local API on :8811
	@# What the deployed container does, reproduced locally: one origin, both halves, no address to
	@# type on the sign-in screen.
	CT_WEB_DIR=$(PWD)/app/dist CT_OPEN_REGISTRATION=1 npm start
