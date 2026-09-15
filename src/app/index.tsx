import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { PrimaryButton } from '@/components/PrimaryButton';
import { ProBadge } from '@/components/ProBadge';
import { PsstLogo, PsstMark } from '@/components/PsstLogo';
import { Screen } from '@/components/Screen';
import { SessionRow } from '@/components/SessionRow';
import { FREE_HISTORY_LIMIT } from '@/constants/plans';
import { Palette, Radii, Spacing } from '@/constants/theme';
import { usePro } from '@/hooks/use-pro';
import { useSessionHistory } from '@/hooks/use-session-history';

export default function HomeScreen() {
  const router = useRouter();
  const { sessions } = useSessionHistory();
  const { isPro } = usePro();

  const visibleSessions = isPro ? sessions : sessions.slice(0, FREE_HISTORY_LIMIT);
  const lockedCount = sessions.length - visibleSessions.length;

  return (
    <Screen scroll contentStyle={styles.content}>
      <View style={styles.topBar}>
        <PsstLogo size="sm" />
        <View style={styles.topBarActions}>
          <Pressable
            onPress={() => router.push('/pro')}
            accessibilityRole="button"
            accessibilityLabel="Psst Pro"
            style={({ pressed }) => [styles.topBarButton, pressed && styles.pressed]}>
            <Text style={styles.topBarButtonLabel}>Pro</Text>
            {isPro ? <ProBadge label="ACTIVE" solid /> : null}
          </Pressable>
          <Pressable
            onPress={() => router.push('/settings')}
            accessibilityRole="button"
            accessibilityLabel="Settings"
            style={({ pressed }) => [styles.topBarButton, pressed && styles.pressed]}>
            <Text style={styles.topBarButtonLabel}>Settings</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.hero}>
        <PsstMark size="lg" />
        <Text style={styles.tagline}>Know what to say next.</Text>
        <Text style={styles.subtitle}>Your real-time AI conversation copilot.</Text>
      </View>

      <PrimaryButton
        label="Start a Psst"
        onPress={() => router.push('/prep')}
        testID="start-psst"
      />

      <View style={styles.flowRow}>
        <FlowStep index="1" title="Prep" body="What it's about and what you want" />
        <FlowStep index="2" title="Live" body="Short private cues, only when useful" />
        <FlowStep index="3" title="Recap" body="Commitments and next actions" />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>RECENT CONVERSATIONS</Text>

        {sessions.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>No conversations yet</Text>
            <Text style={styles.emptyBody}>
              Start a Psst and your recaps will appear here.
            </Text>
          </View>
        ) : (
          <View style={styles.list}>
            {visibleSessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                onPress={() =>
                  router.push({ pathname: '/recap', params: { id: session.id } })
                }
              />
            ))}

            {lockedCount > 0 ? (
              <Pressable
                onPress={() => router.push('/pro')}
                accessibilityRole="button"
                accessibilityLabel={`${lockedCount} more conversations in Psst Pro`}
                style={({ pressed }) => [styles.lockedRow, pressed && styles.pressed]}>
                <ProBadge />
                <Text style={styles.lockedText}>
                  {lockedCount} older {lockedCount === 1 ? 'conversation' : 'conversations'} kept
                  with Psst Pro
                </Text>
              </Pressable>
            ) : null}
          </View>
        )}
      </View>

      <Text style={styles.privacy}>
        Psst only listens during sessions you start, and tells you while it is listening.
      </Text>
    </Screen>
  );
}

function FlowStep({ index, title, body }: { index: string; title: string; body: string }) {
  return (
    <View style={styles.flowStep}>
      <Text style={styles.flowIndex}>{index}</Text>
      <Text style={styles.flowTitle}>{title}</Text>
      <Text style={styles.flowBody}>{body}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: Spacing.four,
    paddingTop: Spacing.two,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  topBarActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  topBarButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: Radii.pill,
    backgroundColor: Palette.backgroundElement,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.border,
  },
  topBarButtonLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: Palette.textSecondary,
  },
  pressed: {
    opacity: 0.8,
  },
  hero: {
    alignItems: 'center',
    gap: Spacing.two,
    paddingTop: Spacing.four,
  },
  tagline: {
    fontSize: 26,
    lineHeight: 32,
    fontWeight: '700',
    color: Palette.text,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 15,
    lineHeight: 21,
    color: Palette.textSecondary,
    textAlign: 'center',
  },
  flowRow: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  flowStep: {
    flex: 1,
    backgroundColor: Palette.backgroundElement,
    borderRadius: Radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.border,
    padding: Spacing.two,
    gap: 2,
  },
  flowIndex: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.2,
    color: Palette.accent,
  },
  flowTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: Palette.text,
  },
  flowBody: {
    fontSize: 12,
    lineHeight: 16,
    color: Palette.textFaint,
  },
  section: {
    gap: Spacing.two,
  },
  sectionTitle: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.5,
    color: Palette.textFaint,
  },
  list: {
    gap: Spacing.two,
  },
  emptyCard: {
    backgroundColor: Palette.backgroundElement,
    borderRadius: Radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.border,
    padding: Spacing.three,
    gap: Spacing.one,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: Palette.text,
  },
  emptyBody: {
    fontSize: 14,
    lineHeight: 20,
    color: Palette.textSecondary,
  },
  lockedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    padding: Spacing.three,
    borderRadius: Radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: 'dashed',
    borderColor: Palette.borderStrong,
  },
  lockedText: {
    flex: 1,
    fontSize: 13,
    color: Palette.textSecondary,
  },
  privacy: {
    fontSize: 12,
    lineHeight: 17,
    color: Palette.textFaint,
    textAlign: 'center',
  },
});
