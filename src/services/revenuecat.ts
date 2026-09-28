/**
 * RevenueCat service abstraction.
 *
 * - Uses the PUBLIC mobile SDK key from `EXPO_PUBLIC_REVENUECAT_API_KEY`.
 * - Loads the SDK lazily and never throws into the UI: Expo Go, the web build
 *   and any build without the native module simply report a non-ready state so
 *   the rest of Psst keeps working.
 * - Never touches server-side secrets. ElevenLabs lives on the backend.
 */

import { Platform } from 'react-native';

import type { CustomerInfo } from 'react-native-purchases';

type PurchasesClass = (typeof import('react-native-purchases'))['default'];

/**
 * Must match the entitlement identifier in the RevenueCat dashboard exactly
 * (Project -> Entitlements). A mismatch is silent: the paywall purchases,
 * `entitlements.active` has no such key, and the app still reads as free.
 */
export const PRO_ENTITLEMENT_ID = 'create_a_project_called_psst_pro';
export const REVENUECAT_PUBLIC_SDK_KEY = process.env.EXPO_PUBLIC_REVENUECAT_API_KEY ?? '';

export type PurchasesAvailability =
  | 'unknown'
  | 'ready'
  | 'missing-key'
  | 'unsupported-platform'
  | 'unavailable';

export interface PurchasesState {
  availability: PurchasesAvailability;
  /** Human readable reason, safe to show in Settings. */
  message: string | null;
}

export type PaywallOutcome = 'purchased' | 'restored' | 'cancelled' | 'dismissed' | 'unavailable';

let PurchasesSdk: PurchasesClass | null = null;
let state: PurchasesState = { availability: 'unknown', message: null };
let initialized = false;

export function getPurchasesState(): PurchasesState {
  return state;
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Purchases are unavailable in this build.';
}

/** Configures RevenueCat once. Safe to call repeatedly. */
export async function initializePurchases(): Promise<PurchasesState> {
  if (initialized) return state;
  initialized = true;

  if (!REVENUECAT_PUBLIC_SDK_KEY) {
    state = {
      availability: 'missing-key',
      message: 'Add EXPO_PUBLIC_REVENUECAT_API_KEY to .env to enable Psst Pro.',
    };
    return state;
  }

  if (Platform.OS === 'web') {
    state = {
      availability: 'unsupported-platform',
      message: 'Psst Pro purchases are available in the Android and iOS builds only.',
    };
    return state;
  }

  try {
    const { default: Purchases } = await import('react-native-purchases');

    const alreadyConfigured = await Purchases.isConfigured().catch(() => false);
    if (!alreadyConfigured) {
      Purchases.configure({ apiKey: REVENUECAT_PUBLIC_SDK_KEY });
      // Touching the SDK once proves the native module is actually present.
      await Purchases.getCustomerInfo();
    }

    PurchasesSdk = Purchases;
    state = { availability: 'ready', message: null };
  } catch (error) {
    PurchasesSdk = null;
    state = {
      availability: 'unavailable',
      message: describeError(error),
    };
  }

  return state;
}

export function hasProEntitlement(info: CustomerInfo): boolean {
  return Boolean(info.entitlements.active[PRO_ENTITLEMENT_ID]);
}

/** Returns true when the Pro entitlement is active. False on any failure. */
export async function fetchIsPro(): Promise<boolean> {
  if (!PurchasesSdk) return false;
  try {
    return hasProEntitlement(await PurchasesSdk.getCustomerInfo());
  } catch {
    return false;
  }
}

/** Subscribes to entitlement changes. Returns an unsubscribe function. */
export function addEntitlementListener(listener: (isPro: boolean) => void): () => void {
  const Purchases = PurchasesSdk;
  if (!Purchases) return () => {};

  const handleCustomerInfo = (info: CustomerInfo) => listener(hasProEntitlement(info));
  Purchases.addCustomerInfoUpdateListener(handleCustomerInfo);
  return () => {
    Purchases.removeCustomerInfoUpdateListener(handleCustomerInfo);
  };
}

/**
 * Presents the RevenueCat paywall configured in the dashboard.
 * Falls back to `unavailable` so callers can show their own state instead of
 * crashing (Expo Go and web have no native paywall support).
 */
export async function presentProPaywall(): Promise<PaywallOutcome> {
  if (state.availability !== 'ready' || !PurchasesSdk) return 'unavailable';

  try {
    const ui = await import('react-native-purchases-ui');
    const result = await ui.default.presentPaywall({ displayCloseButton: true });

    if (result === ui.PAYWALL_RESULT.PURCHASED) return 'purchased';
    if (result === ui.PAYWALL_RESULT.RESTORED) return 'restored';
    if (result === ui.PAYWALL_RESULT.CANCELLED) return 'cancelled';
    return 'dismissed';
  } catch {
    return 'unavailable';
  }
}

export async function restoreProPurchases(): Promise<PaywallOutcome> {
  if (!PurchasesSdk) return 'unavailable';
  try {
    const info = await PurchasesSdk.restorePurchases();
    return hasProEntitlement(info) ? 'restored' : 'dismissed';
  } catch {
    return 'unavailable';
  }
}
