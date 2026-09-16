/**
 * Minimal stand-in for `react-native`, covering only what the modules under test
 * import. If a test needs more of the real thing it should move to a device or
 * component test rather than growing this stub.
 */

export const Platform = { OS: 'android', select: (options) => options.android ?? options.default };

export const AppState = {
  currentState: 'active',
  addEventListener: () => ({ remove: () => {} }),
};

export default { Platform, AppState };
