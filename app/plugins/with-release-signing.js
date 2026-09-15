/**
 * Injects Android release signing and version overrides into the generated Gradle build.
 *
 * Expo regenerates `android/` from scratch on every prebuild, so the signing config cannot be edited
 * into `android/app/build.gradle` and committed — the next prebuild throws it away. A config plugin is
 * the supported way to make a change survive that, which is why this exists rather than a patch.
 *
 * Credentials come from the environment, never from a file in the repo:
 *
 *   CT_ANDROID_KEYSTORE_FILE      absolute path to the .jks
 *   CT_ANDROID_KEYSTORE_PASSWORD
 *   CT_ANDROID_KEY_ALIAS
 *   CT_ANDROID_KEY_PASSWORD
 *
 * and the version from Gradle properties, because Expo bakes `versionCode 1` in from app.json and CI
 * needs a number that goes up on every run:
 *
 *   -PctVersionName=0.2.0  -PctVersionCode=1002
 *
 * **It falls back to debug signing when the credentials are absent, rather than failing.** That keeps
 * the project buildable for anyone who clones it without a keystore. The cost is that a
 * misconfiguration could silently ship a debug-signed APK, so the release workflow checks the
 * generated Gradle *and* runs `apksigner verify --print-certs` afterwards and fails on
 * `CN=Android Debug`.
 *
 * That is not a hypothetical. The first version of this plugin appeared to work — the markers were in
 * the file, the build succeeded — and produced a debug-signed APK anyway, because the regex meant to
 * find the *release build type* matched the `signingConfigs.release` block the plugin had itself just
 * inserted, and rewrote the debug build type instead. Hence the brace-scoped block finder below
 * rather than regexes over the whole file: `release {` occurs in two places that mean different
 * things, and `signingConfig signingConfigs.debug` occurs in both build types.
 */

const { withAppBuildGradle } = require('expo/config-plugins');

const MARKER = '// churn-tracker: release signing (injected by plugins/with-release-signing.js)';

/**
 * The body of a named block, located by brace matching.
 *
 * Returns the span of the block's contents, or null. `startAt` scopes the search so `release {` can be
 * found inside `buildTypes { … }` specifically rather than wherever it first appears.
 */
function findBlock(contents, name, startAt = 0) {
  const opener = new RegExp(`(^|[\\s{])${name}\\s*\\{`, 'm');
  const region = contents.slice(startAt);
  const match = opener.exec(region);
  if (!match) return null;

  // Index of the `{` that opens the block.
  const open = startAt + match.index + match[0].length - 1;

  let depth = 0;
  for (let index = open; index < contents.length; index += 1) {
    const character = contents[index];
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return { open, close: index, body: contents.slice(open + 1, index) };
    }
  }
  return null;
}

/** Replaces a block's body, given the span `findBlock` returned. */
function replaceBody(contents, span, body) {
  return contents.slice(0, span.open + 1) + body + contents.slice(span.close);
}

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (gradleConfig) => {
    let contents = gradleConfig.modResults.contents;

    // Idempotent. A plugin that appends on every prebuild produces four copies of the same block, and
    // Gradle's error for that does not obviously point here.
    if (contents.includes(MARKER)) return gradleConfig;

    const fail = (why) => {
      throw new Error(
        `with-release-signing: ${why}. Expo probably changed its build.gradle template — ` +
          `update this plugin rather than editing android/ by hand, which prebuild would overwrite.`,
      );
    };

    // ---- 1. the keystore lookup, above `android { }` so both blocks below can see it ----------
    //
    // Read at Gradle evaluation time rather than baked in at prebuild time, so one generated
    // `android/` can produce a debug build now and a signed release later without regenerating.
    if (!/^android \{/m.test(contents)) fail('could not find the top-level `android {` block');
    contents = contents.replace(
      /^android \{/m,
      `${MARKER}
def ctKeystorePath = System.getenv("CT_ANDROID_KEYSTORE_FILE")
def ctHasKeystore = ctKeystorePath != null && !ctKeystorePath.isEmpty() && file(ctKeystorePath).exists()

// Resolved here, as plain variables, rather than inline in defaultConfig. Groovy's
// command-expression syntax parses \`versionCode (expr).toInteger()\` as
// \`versionCode(expr).toInteger()\` — calling the setter and then chaining onto its null return,
// which fails at configuration time with the wonderfully unhelpful "Value is null".
def ctVersionCode = (findProperty('ctVersionCode') ?: '__CODE__').toString().toInteger()
def ctVersionName = (findProperty('ctVersionName') ?: '__NAME__').toString()

android {`,
    );

    // ---- 2. version overrides inside defaultConfig ------------------------------------------
    //
    // Expo writes `versionCode 1` from app.json, and `-PversionCode` is not read by anything. These
    // keep the app.json values as the default so a local build needs no flags.
    const androidBlock = findBlock(contents, 'android');
    if (!androidBlock) fail('could not brace-match the `android` block');

    const defaultConfig = findBlock(contents, 'defaultConfig', androidBlock.open);
    if (!defaultConfig) fail('could not find `defaultConfig`');

    let defaultBody = defaultConfig.body;
    const codeMatch = /versionCode\s+(\d+)/.exec(defaultBody);
    const nameMatch = /versionName\s+"([^"]*)"/.exec(defaultBody);
    if (!codeMatch) fail('could not find `versionCode` in defaultConfig');
    if (!nameMatch) fail('could not find `versionName` in defaultConfig');

    // The app.json values become the fallbacks, so a local build with no -P flags behaves exactly as
    // it did before this plugin existed.
    contents = contents
      .replace('__CODE__', codeMatch[1])
      .replace('__NAME__', nameMatch[1]);

    // Re-locate after that substitution changed the file's length.
    const dc = findBlock(contents, 'defaultConfig', findBlock(contents, 'android').open);
    defaultBody = dc.body
      .replace(/versionCode\s+\d+/, `${MARKER}\n        versionCode ctVersionCode`)
      .replace(/versionName\s+"[^"]*"/, 'versionName ctVersionName');
    contents = replaceBody(contents, dc, defaultBody);

    // ---- 3. a `release` entry inside signingConfigs -----------------------------------------
    const signingConfigs = findBlock(contents, 'signingConfigs', findBlock(contents, 'android').open);
    if (!signingConfigs) fail('could not find the `signingConfigs` block');

    contents = replaceBody(
      contents,
      signingConfigs,
      `${signingConfigs.body}
        ${MARKER}
        release {
            if (ctHasKeystore) {
                storeFile file(System.getenv("CT_ANDROID_KEYSTORE_FILE"))
                storePassword System.getenv("CT_ANDROID_KEYSTORE_PASSWORD")
                keyAlias System.getenv("CT_ANDROID_KEY_ALIAS")
                keyPassword System.getenv("CT_ANDROID_KEY_PASSWORD")
            }
        }
`,
    );

    // ---- 4. point the *release build type* at it --------------------------------------------
    //
    // Scoped to `buildTypes` and then to `release` within it. This is the step that got it wrong
    // before — see the header. Expo's template ships `signingConfig signingConfigs.debug` under the
    // release build type, and shipping an APK signed with Android's universally-known debug key is
    // the exact failure this plugin exists to prevent.
    const buildTypes = findBlock(contents, 'buildTypes', findBlock(contents, 'android').open);
    if (!buildTypes) fail('could not find the `buildTypes` block');

    const releaseType = findBlock(contents, 'release', buildTypes.open);
    if (!releaseType || releaseType.close > buildTypes.close) {
      fail('could not find a `release` build type inside `buildTypes`');
    }
    if (!/signingConfig\s+signingConfigs\.debug/.test(releaseType.body)) {
      fail('the release build type does not contain `signingConfig signingConfigs.debug` to replace');
    }

    contents = replaceBody(
      contents,
      releaseType,
      releaseType.body.replace(
        /signingConfig\s+signingConfigs\.debug/,
        // Parenthesised deliberately. Groovy's command-expression syntax makes
        // `signingConfig a ? b : c` ambiguous, and the parentheses remove the ambiguity rather than
        // relying on which way the parser happens to lean.
        `signingConfig(ctHasKeystore ? signingConfigs.release : signingConfigs.debug)`,
      ),
    );

    // ---- 5. ABI splits ----------------------------------------------------------------------
    //
    // A universal APK with all four ABIs came out at 101MB, three quarters of which is native code
    // for architectures no phone has — x86 and x86_64 exist for emulators. Splitting by ABI and
    // dropping the emulator ones gets the arm64 APK to roughly a third of that.
    //
    // No universal APK: this is sideloaded, so the person downloading it picks their architecture, and
    // arm64-v8a covers every phone made since about 2017.
    const androidForSplits = findBlock(contents, 'android');
    contents = replaceBody(
      contents,
      androidForSplits,
      `${androidForSplits.body}
    ${MARKER}
    splits {
        abi {
            reset()
            enable true
            universalApk false
            include "arm64-v8a", "armeabi-v7a"
        }
    }
`,
    );

    gradleConfig.modResults.contents = contents;
    return gradleConfig;
  });
};
