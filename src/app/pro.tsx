import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { PrimaryButton } from '@/components/PrimaryButton';
import { ProBadge } from '@/components/ProBadge';
import { Screen } from '@/components/Screen';
import { FREE_FEATURES, PRO_FEATURES, PRO_TAGLINE } from '@/constants/plans';
import { Palette, Radii, Spacing } from '@/constants/theme';
import { usePro } from '@/hooks/use-pro';

export default function ProScreen() {
  const router = useRouter();
  const { isPro, availability, message, loading, upgrade, restore, refresh } = usePro();
  const [busy, setBusy] = useState<'upgrade' | 'restore' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const purchasesReady = availability === 'ready';

  const handleUpgrade = useCallback(async () => {
    setBusy('upgrade');
    setNotice(null);
    const outcome = await upgrade();
    setBusy(null);

    if (outcome === 'purchased') {
      setNotice('Welcome to Psst Pro. Live sessions are now unlimited.');
    } else if (outcome === 'restored') {
      setNotice('Your Psst Pro subscription was restored.');
    } else if (outcome === 'unavailable') {
      setNotice(message ?? 'Purchases are unavailable in this build.');
    }
  }, [message, upgrade]);

  const handleRestore = useCallback(async () => {
    setBusy('restore');
    setNotice(null);
    const outcome = await restore();
    setBusy(null);

    if (outcome === 'restored') {
      setNotice('Your Psst Pro subscription was restored.');
    } else if (outcome === 'dismissed') {
      setNotice('No Psst Pro subscription found for this store account.');
    } else if (outcome === 'unavailable') {
      setNotice(message ?? 'Purchases are unavailable in this build.');
    }
  }, [message, restore]);

  return (
    <Screen
      scroll
      header={
        <View style={styles.header}>
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Back"
            style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}>
            <Text style={styles.backLabel}>‹ Back</Text>
          </Pressable>
        </View>
      }
      contentStyle={styles.content}>
      <View style={styles.hero}>
        <ProBadge solid />
        <Text style={styles.title}>Psst Pro</Text>
        <Text style={styles.tagline}>{PRO_TAGLINE}</Text>
      </View>

      {isPro ? (
        <View style={styles.activeCard}>
          <Text style={styles.activeTitle}>You’re on Psst Pro</Text>
          <Text style={styles.activeBody}>
            Live sessions run for as long as the conversation does, and every recap is kept in your
            history.
          </Text>
        </View>
      ) : null}

      {loading ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator color={Palette.accentSoft} />
          <Text style={styles.loadingText}>Checking your subscription…</Text>
        </View>
      ) : null}

      <View style={styles.featureCard}>
        <Text style={styles.cardTitle}>PSST PRO INCLUDES</Text>
        {PRO_FEATURES.map((feature) => (
          <View key={feature} style={styles.featureRow}>
            <Text style={styles.featureCheck}>✓</Text>
            <Text style={styles.featureText}>{feature}</Text>
          </View>
        ))}
      </View>

      <View style={styles.featureCard}>
        <Text style={styles.cardTitle}>FREE FOR EVERYONE</Text>
        {FREE_FEATURES.map((feature) => (
          <View key={feature} style={styles.featureRow}>
            <Text style={styles.featureDot}>•</Text>
            <Text style={styles.featureTextMuted}>{feature}</Text>
          </View>
        ))}
      </View>

      {notice ? (
        <View style={styles.noticeCard}>
          <Text style={styles.noticeText}>{notice}</Text>
        </View>
      ) : null}

      {!purchasesReady && !loading ? (
        <View style={styles.warningCard}>
          <Text style={styles.warningTitle}>Purchases aren’t available here</Text>
          <Text style={styles.warningBody}>
            {message ?? 'The store connection could not be reached.'} RevenueCat needs a native
            build — use a development build or the EAS Android build, not Expo Go or the web
            preview.
          </Text>
        </View>
      ) : null}

      <View style={styles.actions}>
        {!isPro ? (
          <PrimaryButton
            label="Upgrade to Psst Pro"
            onPress={handleUpgrade}
            loading={busy === 'upgrade'}
            disabled={!purchasesReady || busy !== null}
            hint={
              purchasesReady
                ? 'Your store will show the available plans and prices'
                : 'Available in the Android and iOS builds'
            }
            testID="upgrade-cta"
          />
        ) : null}

        <PrimaryButton
          label="Restore purchases"
          variant="secondary"
          onPress={handleRestore}
          loading={busy === 'restore'}
          disabled={!purchasesReady || busy !== null}
        />

        {!purchasesReady && !loading ? (
          <PrimaryButton label="Retry connection" variant="ghost" onPress={() => void refresh()} />
        ) : null}
      </View>

      <Text style={styles.legal}>
        Subscriptions are managed by the store account you use to purchase. You can cancel any time
        from your store settings.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.two,
  },
  backButton: {
    alignSelf: 'flex-start',
    paddingVertical: Spacing.two,
    paddingRight: Spacing.three,
  },
  pressed: {
    opacity: 0.7,
  },
  backLabel: {
    fontSize: 15,
    fontWeight: '600',
    color: Palette.accentSoft,
  },
  content: {
    gap: Spacing.three,
  },
  hero: {
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.four,
  },
  title: {
    fontSize: 32,
    lineHeight: 38,
    fontWeight: '700',
    color: Palette.text,
  },
  tagline: {
    fontSize: 15,
    lineHeight: 21,
    color: Palette.textSecondary,
    textAlign: 'center',
    maxWidth: 320,
  },
  activeCard: {
    backgroundColor: Palette.accentWash,
    borderRadius: Radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.accent,
    padding: Spacing.three,
    gap: Spacing.one,
  },
  activeTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: Palette.accentSoft,
  },
  activeBody: {
    fontSize: 14,
    lineHeight: 20,
    color: Palette.textSecondary,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  loadingText: {
    fontSize: 14,
    color: Palette.textSecondary,
  },
  featureCard: {
    backgroundColor: Palette.backgroundElement,
    borderRadius: Radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.border,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  cardTitle: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.5,
    color: Palette.textFaint,
  },
  featureRow: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  featureCheck: {
    fontSize: 14,
    lineHeight: 21,
    fontWeight: '700',
    color: Palette.accentSoft,
  },
  featureDot: {
    fontSize: 14,
    lineHeight: 21,
    color: Palette.textFaint,
  },
  featureText: {
    flex: 1,
    fontSize: 15,
    lineHeight: 21,
    color: Palette.text,
  },
  featureTextMuted: {
    flex: 1,
    fontSize: 15,
    lineHeight: 21,
    color: Palette.textSecondary,
  },
  noticeCard: {
    backgroundColor: Palette.backgroundSelected,
    borderRadius: Radii.md,
    padding: Spacing.three,
  },
  noticeText: {
    fontSize: 14,
    lineHeight: 20,
    color: Palette.text,
  },
  warningCard: {
    backgroundColor: Palette.backgroundElement,
    borderRadius: Radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.warning,
    padding: Spacing.three,
    gap: Spacing.one,
  },
  warningTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: Palette.warning,
  },
  warningBody: {
    fontSize: 13,
    lineHeight: 19,
    color: Palette.textSecondary,
  },
  actions: {
    gap: Spacing.two,
  },
  legal: {
    fontSize: 12,
    lineHeight: 17,
    color: Palette.textFaint,
  },
});
