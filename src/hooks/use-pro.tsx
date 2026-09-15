/**
 * Psst Pro entitlement context.
 *
 * Wraps the RevenueCat abstraction so screens can read `isPro` without caring
 * whether purchases are actually available on this device. When the native SDK
 * is missing (Expo Go, web, missing key) `isPro` stays false and `availability`
 * carries a human readable explanation.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import {
  addEntitlementListener,
  fetchIsPro,
  initializePurchases,
  presentProPaywall,
  restoreProPurchases,
  type PaywallOutcome,
  type PurchasesAvailability,
} from '@/services/revenuecat';

export interface ProContextValue {
  isPro: boolean;
  availability: PurchasesAvailability;
  /** Explanation for a non-ready state, safe to display. */
  message: string | null;
  loading: boolean;
  /** Presents the RevenueCat paywall. Returns `unavailable` when unsupported. */
  upgrade: () => Promise<PaywallOutcome>;
  restore: () => Promise<PaywallOutcome>;
  refresh: () => Promise<void>;
}

const ProContext = createContext<ProContextValue | null>(null);

export function ProProvider({ children }: { children: ReactNode }) {
  const [isPro, setIsPro] = useState(false);
  const [availability, setAvailability] = useState<PurchasesAvailability>('unknown');
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const state = await initializePurchases();
    setAvailability(state.availability);
    setMessage(state.message);

    if (state.availability === 'ready') {
      setIsPro(await fetchIsPro());
    } else {
      setIsPro(false);
    }
    setLoading(false);
  }, []);

  // Connects to RevenueCat once on mount. State is only written after the
  // async handshake resolves, so nothing cascades during the first render.
  useEffect(() => {
    let active = true;

    void (async () => {
      const state = await initializePurchases();
      if (!active) return;

      setAvailability(state.availability);
      setMessage(state.message);

      const pro = state.availability === 'ready' ? await fetchIsPro() : false;
      if (!active) return;

      setIsPro(pro);
      setLoading(false);
    })();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (availability !== 'ready') return;
    return addEntitlementListener(setIsPro);
  }, [availability]);

  const upgrade = useCallback(async () => {
    const outcome = await presentProPaywall();
    if (outcome === 'purchased' || outcome === 'restored') {
      setIsPro(true);
    }
    return outcome;
  }, []);

  const restore = useCallback(async () => {
    const outcome = await restoreProPurchases();
    if (outcome === 'restored') {
      setIsPro(true);
    }
    return outcome;
  }, []);

  const value = useMemo(
    () => ({ isPro, availability, message, loading, upgrade, restore, refresh }),
    [isPro, availability, message, loading, upgrade, restore, refresh]
  );

  return <ProContext.Provider value={value}>{children}</ProContext.Provider>;
}

export function usePro(): ProContextValue {
  const context = useContext(ProContext);
  if (!context) {
    throw new Error('usePro must be used inside a ProProvider');
  }
  return context;
}
