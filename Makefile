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

# Overridable for a one-off build: make android-apk VERSION=0.2.0 VERSION_CODE=1002
VERSION ?= 0.1.0
VERSION_CODE ?= 1001

.PHONY: help install dev test typecheck refresh refresh-force flowchart data icons \
        android-apk android-verify ios-build ios-archive \
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

icons: ## Re-render every icon asset from docs/branding/icon.svg
	node scripts/render-icons.ts

android-apk: ## Signed release APKs, split by ABI. Needs credentials/ and CT_ANDROID_* set.
	@# Two APKs rather than one: a universal build came out at 101MB, three quarters of it native code
	@# for emulator architectures. arm64-v8a covers every phone since about 2017.
	@test -f app/credentials/churn-tracker-release.jks || \
	  { echo "No keystore at app/credentials/churn-tracker-release.jks — see docs/RELEASING.md"; exit 1; }
	@test -n "$$CT_ANDROID_KEYSTORE_PASSWORD" || \
	  { echo "CT_ANDROID_KEYSTORE_PASSWORD is not set — see docs/RELEASING.md"; exit 1; }
	cd app && ANDROID_HOME=$$HOME/Library/Android/sdk npx expo prebuild --platform android --clean --no-install
	cd app/android && \
	  ANDROID_HOME=$$HOME/Library/Android/sdk \
	  CT_ANDROID_KEYSTORE_FILE=$(PWD)/app/credentials/churn-tracker-release.jks \
	  CT_ANDROID_KEY_ALIAS=churn-tracker \
	  CT_ANDROID_KEY_PASSWORD=$$CT_ANDROID_KEYSTORE_PASSWORD \
	  ./gradlew assembleRelease -PctVersionName=$(VERSION) -PctVersionCode=$(VERSION_CODE) --no-daemon
	@$(MAKE) --no-print-directory android-verify

android-verify: ## Check the built APKs are signed with the release key and not the debug one
	@# The check that matters. The signing plugin falls back to debug signing when credentials are
	@# absent, so "the build succeeded" is not the same as "the APK is signed correctly" — and the
	@# first version of that plugin silently produced a debug-signed APK.
	@AS=$$HOME/Library/Android/sdk/build-tools/36.0.0/apksigner; 	for apk in app/android/app/build/outputs/apk/release/*.apk; do 	  printf '%-46s %6.1f MB  ' "$$(basename $$apk)" "$$(echo "scale=1; $$(stat -f%z $$apk)/1048576" | bc)"; 	  $$AS verify --print-certs "$$apk" 2>/dev/null | grep -m1 'certificate DN' | sed 's/.*DN: //'; 	  if $$AS verify --print-certs "$$apk" 2>/dev/null | grep -qi 'CN=Android Debug'; then 	    echo "  !! DEBUG SIGNED — do not ship this"; exit 1; fi; 	done; echo "all APKs signed with the release key"

ios-build: ## Unsigned iOS device build, to prove the native project compiles
	@# Needs the iOS platform component installed: Xcode > Settings > Components. `xcodebuild
	@# -downloadPlatform iOS` is a no-op on some setups, and without it xcodebuild reports
	@# "Found no destinations for the scheme" rather than anything about a missing SDK.
	cd app && npx expo prebuild --platform ios --clean --no-install && cd ios && pod install
	cd app && xcodebuild -workspace ios/ChurnTracker.xcworkspace -scheme ChurnTracker \
	  -configuration Release -sdk iphoneos -derivedDataPath ios/build \
	  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build

ios-archive: ## Signed iOS archive for TestFlight. Needs an Apple Developer account.
	@# Open the workspace once and set your team under Signing & Capabilities first; Xcode-managed
	@# signing cannot be configured from the command line.
	cd app && xcodebuild -workspace ios/ChurnTracker.xcworkspace -scheme ChurnTracker \
	  -configuration Release -sdk iphoneos \
	  -archivePath ios/build/ChurnTracker.xcarchive archive

app-build-web: ## Static web build into app/dist (the image builds this itself)
	cd app && npx expo export --platform web --output-dir dist

app-serve-local: app-build-web ## Build the web app and serve it from the local API on :8811
	@# What the deployed container does, reproduced locally: one origin, both halves, no address to
	@# type on the sign-in screen.
	CT_WEB_DIR=$(PWD)/app/dist CT_OPEN_REGISTRATION=1 npm start
