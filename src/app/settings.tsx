import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { PrimaryButton } from '@/components/PrimaryButton';
import { ProBadge } from '@/components/ProBadge';
import { Screen } from '@/components/Screen';
import { FREE_HISTORY_LIMIT, FREE_IMPORTS_PER_MONTH } from '@/constants/plans';
import { Palette, Radii, Spacing } from '@/constants/theme';
import { useDebriefs } from '@/hooks/use-debriefs';
import { usePro } from '@/hooks/use-pro';
import { isBackendConfigured } from '@/services/backend';

export default function SettingsScreen() {
  const router = useRouter();
  const { isPro, availability, message, restore } = usePro();
  const { debriefs, clearAll } = useDebriefs();
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const appVersion = Constants.expoConfig?.version ?? '1.0.0';

  const withRecording = useMemo(
    () => debriefs.filter((debrief) => debrief.audio !== null).length,
    [debriefs]
  );
  const openTasks = useMemo(
    () => debriefs.reduce((total, debrief) => total + debrief.tasks.filter((task) => !task.done).length, 0),
    [debriefs]
  );

  const handleRestore = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    const outcome = await restore();
    setBusy(false);
    if (outcome === 'restored') setNotice('Psst Pro restored.');
    else if (outcome === 'dismissed') setNotice('No Psst Pro subscription found.');
    else if (outcome === 'unavailable') setNotice('Purchases are unavailable in this build.');
  }, [restore]);

  const confirmClear = useCallback(() => {
    Alert.alert(
      'Delete every debrief?',
      'This removes every debrief and every recording Psst saved on this device. It cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete all',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              await clearAll();
              setNotice('Every debrief and recording was deleted.');
            })();
          },
        },
      ]
    );
  }, [clearAll]);

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
      <Text style={styles.title}>Settings</Text>

      {notice ? (
        <View style={styles.noticeCard}>
          <Text style={styles.noticeText}>{notice}</Text>
        </View>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>PRIVACY & RETENTION</Text>
        <Row label="Debriefs stored" value={`${debriefs.length}`} />
        <Row label="Recordings kept" value={`${withRecording}`} />
        <Row label="Open follow-ups" value={`${openTasks}`} />
        <Text style={styles.cardBody}>
          Psst never records a call and never joins one. It only reads recordings you import, and
          only after you confirm the consent notice. Every debrief and its recording stay on this
          device; the audio you send for analysis is used once and discarded, never stored on the
          backend.
        </Text>
        <Text style={styles.cardBody}>
          Deleting a recording keeps its debrief. Deleting a debrief removes both.
        </Text>
        <PrimaryButton
          label="Delete all debriefs and recordings"
          variant="destructive"
          onPress={confirmClear}
          disabled={debriefs.length === 0}
          hint={debriefs.length === 0 ? 'Nothing stored yet' : undefined}
        />
      </View>

      <View style={styles.card}>
        <View style={styles.cardTitleRow}>
          <Text style={styles.cardTitle}>PSST PRO</Text>
          {isPro ? <ProBadge label="ACTIVE" solid /> : <ProBadge />}
        </View>
        <Row label="Plan" value={isPro ? 'Psst Pro' : 'Free'} />
        <Row
          label="Analysed recordings"
          value={isPro ? 'Unlimited' : `${FREE_IMPORTS_PER_MONTH} per month`}
        />
        <Row
          label="Timeline"
          value={isPro ? 'Everything, searchable' : `Last ${FREE_HISTORY_LIMIT} debriefs`}
        />
        <Row label="Store status" value={availabilityLabel(availability)} />
        {message && availability !== 'ready' ? (
          <Text style={styles.cardBody}>{message}</Text>
        ) : null}
        <View style={styles.actions}>
          <PrimaryButton
            label={isPro ? 'Manage Psst Pro' : 'See Psst Pro'}
            onPress={() => router.push('/pro')}
          />
          <PrimaryButton
            label="Restore purchases"
            variant="secondary"
            onPress={handleRestore}
            loading={busy}
          />
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>ANALYSIS</Text>
        <Row
          label="Backend"
          value={isBackendConfigured() ? 'Configured' : 'Not configured'}
        />
        <Text style={styles.cardBody}>
          {isBackendConfigured()
            ? 'An imported recording is transcribed and analysed by the Psst backend, which holds the provider keys. The app only ever holds the backend URL.'
            : 'No analysis backend is configured in this build, so imports produce an offline demo debrief instead. Nothing is uploaded anywhere.'}
        </Text>
        <Row label="Microphone" value="Not used — Psst has no recording permission" />
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>ABOUT</Text>
        <Row label="Psst" value={`Version ${appVersion}`} />
        <Row label="Build" value="Import-first · debrief and memory" />
        <Row label="Platform" value="Android first (Galaxy S24 Ultra target)" />
        <Text style={styles.cardBody}>
          Psst is not a call recorder. It is the memory, follow-through and relationship layer that
          comes after a call.
        </Text>
      </View>
    </Screen>
  );
}

function availabilityLabel(availability: string): string {
  switch (availability) {
    case 'ready':
      return 'Connected';
    case 'missing-key':
      return 'Public SDK key missing';
    case 'unsupported-platform':
      return 'Not supported on this platform';
    case 'unavailable':
      return 'Unavailable in this build';
    default:
      return 'Checking…';
  }
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
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
  title: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '700',
    color: Palette.text,
  },
  noticeCard: {
    backgroundColor: Palette.backgroundSelected,
    borderRadius: Radii.md,
    padding: Spacing.three,
  },
  noticeText: {
    fontSize: 14,
    color: Palette.text,
  },
  card: {
    backgroundColor: Palette.backgroundElement,
    borderRadius: Radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.border,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  cardTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cardTitle: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.5,
    color: Palette.textFaint,
  },
  cardBody: {
    fontSize: 13,
    lineHeight: 19,
    color: Palette.textSecondary,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: Spacing.three,
  },
  rowLabel: {
    fontSize: 14,
    color: Palette.textSecondary,
  },
  rowValue: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: Palette.text,
    textAlign: 'right',
  },
  actions: {
    gap: Spacing.two,
    marginTop: Spacing.one,
  },
});
