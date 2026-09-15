import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo } from 'react';
import { Pressable, Share, StyleSheet, Text, View } from 'react-native';

import { PrimaryButton } from '@/components/PrimaryButton';
import { ProBadge } from '@/components/ProBadge';
import { RecapSection } from '@/components/RecapSection';
import { Screen } from '@/components/Screen';
import { getPreset } from '@/constants/presets';
import { Palette, Radii, Spacing } from '@/constants/theme';
import { usePro } from '@/hooks/use-pro';
import { useSessionHistory } from '@/hooks/use-session-history';
import { formatDurationWords, formatSessionDate } from '@/utils/format';
import { buildRecapText } from '@/utils/recap';

export default function RecapScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const { sessions, getSession } = useSessionHistory();
  const { isPro } = usePro();

  const recap = useMemo(() => {
    const id = typeof params.id === 'string' ? params.id : undefined;
    return (id ? getSession(id) : undefined) ?? sessions[0];
  }, [getSession, params.id, sessions]);

  const shareRecap = useCallback(async () => {
    if (!recap) return;
    try {
      await Share.share({ message: buildRecapText(recap), title: recap.title });
    } catch {
      // The share sheet was dismissed — nothing to recover from.
    }
  }, [recap]);

  if (!recap) {
    return (
      <Screen
        centered
        header={<Header onBack={() => router.replace('/')} />}
        contentStyle={styles.content}>
        <Text style={styles.emptyTitle}>No recap to show</Text>
        <Text style={styles.emptyBody}>
          Finish a Psst session and the recap will appear here.
        </Text>
        <PrimaryButton label="Start a Psst" onPress={() => router.push('/prep')} />
      </Screen>
    );
  }

  const preset = getPreset(recap.preset);

  return (
    <Screen
      scroll
      header={<Header onBack={() => router.replace('/')} />}
      contentStyle={styles.content}
      footer={
        <View style={styles.footer}>
          <PrimaryButton
            label="New Psst"
            onPress={() => router.push('/prep')}
            style={styles.footerButton}
          />
          <PrimaryButton
            label="Share recap"
            variant="secondary"
            onPress={shareRecap}
            style={styles.footerButton}
          />
        </View>
      }>
      <View style={styles.titleBlock}>
        <Text style={styles.eyebrow}>RECAP</Text>
        <Text style={styles.title}>{recap.title}</Text>
        <Text style={styles.meta}>
          {preset.label} · {formatSessionDate(recap.startedAt)} ·{' '}
          {formatDurationWords(recap.durationMs)} · {recap.cueCount}{' '}
          {recap.cueCount === 1 ? 'cue' : 'cues'}
        </Text>
      </View>

      {recap.goal.objective.trim() !== '' ? (
        <View style={styles.goalCard}>
          <Text style={styles.goalLabel}>YOUR GOAL</Text>
          <Text style={styles.goalText}>{recap.goal.objective}</Text>
        </View>
      ) : null}

      <RecapSection title="Summary" body={recap.summary} />
      <RecapSection title="Key points" items={recap.keyPoints} tone="accent" />
      <RecapSection title="Commitments" items={recap.commitments} tone="success" />
      <RecapSection title="Things you may have missed" items={recap.missed} tone="warning" />
      <RecapSection title="Next actions" items={recap.nextActions} numbered tone="accent" />

      {!isPro ? (
        <View style={styles.upsell}>
          <View style={styles.upsellHeader}>
            <ProBadge />
            <Text style={styles.upsellTitle}>Keep every recap</Text>
          </View>
          <Text style={styles.upsellBody}>
            Psst Pro stores your full conversation history and keeps live sessions running with no
            time limit.
          </Text>
          <PrimaryButton label="See Psst Pro" onPress={() => router.push('/pro')} />
        </View>
      ) : null}
    </Screen>
  );
}

function Header({ onBack }: { onBack: () => void }) {
  return (
    <View style={styles.header}>
      <Pressable
        onPress={onBack}
        accessibilityRole="button"
        accessibilityLabel="Back to home"
        style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}>
        <Text style={styles.backLabel}>‹ Home</Text>
      </Pressable>
    </View>
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
  titleBlock: {
    gap: Spacing.one,
  },
  eyebrow: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.5,
    color: Palette.textFaint,
  },
  title: {
    fontSize: 26,
    lineHeight: 32,
    fontWeight: '700',
    color: Palette.text,
  },
  meta: {
    fontSize: 13,
    color: Palette.textSecondary,
  },
  goalCard: {
    backgroundColor: Palette.backgroundElement,
    borderRadius: Radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.border,
    padding: Spacing.three,
    gap: Spacing.one,
  },
  goalLabel: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.4,
    color: Palette.textFaint,
  },
  goalText: {
    fontSize: 14,
    lineHeight: 20,
    color: Palette.text,
  },
  upsell: {
    backgroundColor: Palette.accentWash,
    borderRadius: Radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.accent,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  upsellHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  upsellTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: Palette.text,
  },
  upsellBody: {
    fontSize: 13,
    lineHeight: 19,
    color: Palette.textSecondary,
    marginBottom: Spacing.one,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: Palette.text,
    marginBottom: Spacing.one,
  },
  emptyBody: {
    fontSize: 14,
    lineHeight: 20,
    color: Palette.textSecondary,
    marginBottom: Spacing.three,
  },
  footer: {
    flexDirection: 'row',
    gap: Spacing.two,
    paddingBottom: Spacing.two,
  },
  footerButton: {
    flex: 1,
  },
});
