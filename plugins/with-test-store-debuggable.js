/**
 * RevenueCat Test Store support for the internal `preview` APK.
 *
 * A `test_` API key is the only one we have until Psst is set up in Google
 * Play, and the SDK refuses to run it outside a debuggable build: in a release
 * build it logs "Wrong API Key", shows an alert and closes the app on purpose.
 * Its check is `android:debuggable`, not how the app was distributed.
 *
 * `preview` is the hand-out APK for testers: release JavaScript (so it runs
 * without a Metro server) that is never uploaded to a store. Marking it
 * debuggable lets the Test Store work there while the APK stays otherwise
 * unchanged.
 *
 * The gate is the EAS profile name, so `production` can never pick this up,
 * even if an environment variable leaks.
 */

const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins');

const TEST_STORE_PROFILE = 'preview';

module.exports = function withTestStoreDebuggable(config) {
  if (process.env.EAS_BUILD_PROFILE !== TEST_STORE_PROFILE) return config;

  return withAndroidManifest(config, (config) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(config.modResults);
    application.$['android:debuggable'] = 'true';
    return config;
  });
};
