import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { PrimaryButton } from '@/components/PrimaryButton';
import { ProBadge } from '@/components/ProBadge';
import { Screen } from '@/components/Screen';
import { FREE_LIVE_MINUTES } from '@/constants/plans';
import { Palette, Radii, Spacing } from '@/constants/theme';
import { usePro } from '@/hooks/use-pro';
import { useSessionHistory } from '@/hooks/use-session-history';
import { isBackendConfigured } from '@/services/backend';
import { DEFAULT_CONVERSATION_MODE } from '@/services/conversation';

export default function SettingsScreen() {
  const router = useRouter();
  const { isPro, availability, message, restore } = usePro();
  const { sessions, clearSessions } = useSessionHistory();
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const appVersion = Constants.expoConfig?.version ?? '1.0.0';

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
      'Clear conversation history?',
      'This removes the recaps stored on this device for the current app session.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: () => {
            clearSessions();
            setNotice('Conversation history cleared.');
          },
        },
      ]
    );
  }, [clearSessions]);

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
        <Text style={styles.cardTitle}>LISTENING & PRIVACY</Text>
        <Row label="Sessions" value="Only while you press start" />
        <Row label="Indicator" value="Listening state always visible" />
        <Row
          label="Free listening"
          value={isPro ? 'Unlimited (Psst Pro)' : `${FREE_LIVE_MINUTES} minutes per session`}
        />
        <Text style={styles.cardBody}>
          Psst never records in the background. Every session is started and ended by you, and the
          microphone indicator stays on screen while Psst is listening.
        </Text>
      </View>

      <View style={styles.card}>
        <View style={styles.cardTitleRow}>
          <Text style={styles.cardTitle}>PSST PRO</Text>
          {isPro ? <ProBadge label="ACTIVE" solid /> : <ProBadge />}
        </View>
        <Row label="Plan" value={isPro ? 'Psst Pro' : 'Free'} />
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
        <Text style={styles.cardTitle}>CONVERSATIONS</Text>
        <Row label="Stored recaps" value={`${sessions.length}`} />
        <Text style={styles.cardBody}>
          Recaps live in memory for this app session. Persistent history arrives with the backend.
        </Text>
        <PrimaryButton
          label="Clear conversation history"
          variant="secondary"
          onPress={confirmClear}
          disabled={sessions.length === 0}
          hint={sessions.length === 0 ? 'Nothing to clear yet' : undefined}
        />
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>CONNECTIONS</Text>
        <Row
          label="Realtime backend"
          value={isBackendConfigured() ? 'Configured' : 'Not configured'}
        />
        <Row
          label="Default engine"
          value={DEFAULT_CONVERSATION_MODE === 'realtime' ? 'Live audio' : 'Demo'}
        />
        <Row label="Microphone" value="Only during a session you start" />
        <Text style={styles.cardBody}>
          Live audio streams microphone samples to the Psst backend, which transcribes them and
          decides whether anything is worth saying. Both provider keys stay on the server; the app
          only ever holds the backend URL.
          {isBackendConfigured()
            ? ''
            : ' No backend is configured in this build, so Psst runs the offline demo engine.'}
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>ABOUT</Text>
        <Row label="Psst" value={`Version ${appVersion}`} />
        <Row label="Build" value="Phase 2b · live microphone + realtime transcription" />
        <Row label="Platform" value="Android first (Galaxy S24 Ultra target)" />
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
