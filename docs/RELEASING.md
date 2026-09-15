# Releasing

Three artefacts come out of a release, and they are built in different places for different reasons:

| | Where | Signed with | Distributed as |
|---|---|---|---|
| **Android APK** | GitHub Actions | the project release key | a GitHub release asset |
| **Web bundle** | GitHub Actions, and inside the container image | — | a release asset, and served by the server |
| **iOS build** | your Mac | your Apple Developer identity | TestFlight, or a local install |

Android and web are one `git push --tags`. iOS is not, and the next section is why.

## Cutting a release

```sh
# 1. Write the notes first. The workflow looks for this exact path and warns if it is missing.
$EDITOR docs/release-notes/v0.2.0.md

# 2. Bump the version in app/app.json to match.
$EDITOR app/app.json

git commit -am "Release v0.2.0"
git tag v0.2.0
git push origin main --tags
```

The `Release` workflow then runs the test suite, prebuilds the native Android project, builds a signed
APK, **verifies the signature is not the debug key**, builds the web bundle, and publishes both to a
GitHub release with your notes plus a generated commit list.

`workflow_dispatch` does the same thing with a version you type, for a rebuild without moving a tag.

### The version code

The version *name* comes from the tag; the version *code* is `1000 + the workflow run number`. Only
that it increases matters to Android, and deriving it from the name goes wrong the first time you
release 0.10.0 after 0.9.0.

## Android signing

The keystore was generated once, and losing it is unrecoverable — Android identifies an app by its
signing key, so a different key means nobody who installed the old build can install an update. It is
`app/credentials/churn-tracker-release.jks`, which is **gitignored**.

```
alias      churn-tracker
algorithm  RSA 4096, SHA384withRSA
store      PKCS12
valid      30 years, to 2056
```

> [!IMPORTANT]
> Back the keystore and its password up somewhere that is not this repo and not only this machine. A
> password manager entry with the `.jks` attached is enough. If both are lost, the only way forward is
> a new application ID and every user reinstalling from scratch.

CI gets it as four repository secrets:

| Secret | What |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | the `.jks`, base64 with no newlines |
| `ANDROID_KEYSTORE_PASSWORD` | store password |
| `ANDROID_KEY_ALIAS` | `churn-tracker` |
| `ANDROID_KEY_PASSWORD` | key password (same as the store password here) |

To set or rotate them:

```sh
cd app/credentials
base64 -i churn-tracker-release.jks | tr -d '\n' | gh secret set ANDROID_KEYSTORE_BASE64
gh secret set ANDROID_KEYSTORE_PASSWORD   # reads stdin, so the value never lands in your shell history
gh secret set ANDROID_KEY_PASSWORD
printf 'churn-tracker' | gh secret set ANDROID_KEY_ALIAS
```

Piping rather than `--body` is deliberate: an argument is visible in `ps` and in shell history, and
stdin is not.

### How the signing config survives prebuild

Expo regenerates `android/` on every prebuild, so an edit to `android/app/build.gradle` cannot be
committed — the next prebuild throws it away. `app/plugins/with-release-signing.js` is a config plugin
that re-injects it each time, reading the credentials from four `CT_ANDROID_*` environment variables
at Gradle evaluation time.

**It falls back to debug signing when those are absent, rather than failing.** That keeps the project
buildable for anyone who clones it without a keystore. The consequence is that a misconfigured release
could silently produce a debug-signed APK, so the workflow checks twice: it greps the generated Gradle
for the injected release config, and afterwards runs `apksigner verify --print-certs` and fails if the
certificate is `CN=Android Debug`.

### Building an APK locally

```sh
cd app
export ANDROID_HOME="$HOME/Library/Android/sdk"
export CT_ANDROID_KEYSTORE_FILE="$PWD/credentials/churn-tracker-release.jks"
export CT_ANDROID_KEYSTORE_PASSWORD='…'
export CT_ANDROID_KEY_ALIAS=churn-tracker
export CT_ANDROID_KEY_PASSWORD="$CT_ANDROID_KEYSTORE_PASSWORD"

npx expo prebuild --platform android --clean --no-install
cd android && ./gradlew assembleRelease -PversionName=0.2.0 -PversionCode=1002
```

The APK lands at `android/app/build/outputs/apk/release/app-release.apk`. Check it:

```sh
"$ANDROID_HOME"/build-tools/36.0.0/apksigner verify --print-certs app/build/outputs/apk/release/app-release.apk
```

## iOS

**Not in CI, and not because it was skipped.** A distributable iOS build needs an Apple Developer
account, a distribution certificate and a provisioning profile tied to it. Those are per-developer
credentials that cannot go in a public repository, and a workflow that always failed for want of them
would be worse than an honest gap.

What works with no account at all:

```sh
cd app
npx expo prebuild --platform ios --clean --no-install
npx pod-install
# A simulator build — unsigned, runs in the Simulator, proves the native project is sound.
xcodebuild -workspace ios/ChurnTracker.xcworkspace -scheme ChurnTracker \
  -configuration Release -sdk iphonesimulator -derivedDataPath ios/build build
```

With a paid Apple Developer account, for a device or TestFlight:

```sh
# Open it once and let Xcode manage signing — pick your team under Signing & Capabilities.
open ios/ChurnTracker.xcworkspace

xcodebuild -workspace ios/ChurnTracker.xcworkspace -scheme ChurnTracker \
  -configuration Release -sdk iphoneos -archivePath ios/build/ChurnTracker.xcarchive archive
xcodebuild -exportArchive -archivePath ios/build/ChurnTracker.xcarchive \
  -exportOptionsPlist ios/ExportOptions.plist -exportPath ios/build/export
```

CocoaPods is required and is not installed by default on a fresh Mac:

```sh
gem install cocoapods    # into a mise/rbenv Ruby; do not sudo into the system Ruby
```

### Push notifications need an EAS project id

The app mints Expo push tokens, and a standalone build cannot do that without one. In Expo Go it is
inferred; in a real build it is not.

```sh
cd app && npx eas init     # writes extra.eas.projectId into app.json
```

Without it, the Settings screen says so explicitly — `enablePush()` returns a `no-project` reason with
the fix in it — rather than failing quietly. Everything except push works regardless.

## Release notes

One file per release at `docs/release-notes/vX.Y.Z.md`, written before the tag. The workflow appends
the install instructions and lets GitHub generate the commit list underneath, so the file should be
only what a reader cannot get from the commits: what changed for *them*, and anything that needs an
action on upgrade.

If the file is missing the release still publishes, with a placeholder and a warning annotation.

## The server

Deployed separately and continuously — see [DEPLOYING.md](DEPLOYING.md). It is not versioned with the
app, because the app talks to whatever server it is pointed at and the API has one version.

The container image is built from the same commit and already contains the web bundle, so a `kamal
deploy` ships both halves of the web experience together. The APK is the only artefact that has to be
released on its own schedule.
