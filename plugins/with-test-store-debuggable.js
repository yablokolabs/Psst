/**
 * RevenueCat Test Store support for the internal `preview` APK.
 *
 * A `test_` API key is the only one we have until Psst is set up in Google
 * Play, and the SDK refuses to run it outside a debuggable build: in a release
 * build it logs "Wrong API Key", shows an alert and closes the app on purpose.
 * Its check is `android:debuggable`, not how the app was distributed.
 *
 * `preview` is the hand-out APK for testers: release JavaScript (so it runs
 * without a Metro server) that is never uploaded to a store. Marking that build
 * type debuggable lets the Test Store work there while the APK stays otherwise
 * unchanged. It has to be done on the build type rather than in the manifest:
 * hardcoding android:debuggable trips lint's HardcodedDebugMode check, which
 * runs as lintVitalRelease and fails the build.
 *
 * The gate is the EAS profile name, so `production` can never pick this up,
 * even if an environment variable leaks.
 */

const { withAppBuildGradle } = require('expo/config-plugins');

const TEST_STORE_PROFILE = 'preview';

const GRADLE_BLOCK = `
// Added by plugins/with-test-store-debuggable.js - see that file for why.
// Never promote an artifact built from this configuration to a store.
android {
    buildTypes {
        release {
            debuggable true
        }
    }
    lint {
        // HardcodedDebugMode is the check for exactly the attribute we are
        // asking for. It still sees the merged manifest, where the build type
        // puts android:debuggable="true", so it has to be switched off here.
        disable 'HardcodedDebugMode'
    }
}
`;

/** @type {import('expo/config-plugins').ConfigPlugin} */
module.exports = function withTestStoreDebuggable(config) {
  if (process.env.EAS_BUILD_PROFILE !== TEST_STORE_PROFILE) return config;

  return withAppBuildGradle(config, (config) => {
    if (config.modResults.language !== 'groovy') {
      throw new Error('with-test-store-debuggable expects a Groovy android/app/build.gradle');
    }

    if (!config.modResults.contents.includes('debuggable true')) {
      config.modResults.contents = `${config.modResults.contents.trimEnd()}\n${GRADLE_BLOCK}`;
    }

    return config;
  });
};
