import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { DebriefRow } from '@/components/DebriefRow';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ProBadge } from '@/components/ProBadge';
import { PsstLogo, PsstMark } from '@/components/PsstLogo';
import { Screen } from '@/components/Screen';
import { TextField } from '@/components/TextField';
import { FREE_HISTORY_LIMIT } from '@/constants/plans';
import { Palette, Radii, Spacing } from '@/constants/theme';
import { useDebriefs } from '@/hooks/use-debriefs';
import { usePro } from '@/hooks/use-pro';
import { createDemoDebrief } from '@/services/demoDebrief';

export default function HomeScreen() {
  const router = useRouter();
  const { debriefs, loading, error, add, search } = useDebriefs();
  const { isPro } = usePro();
  const [query, setQuery] = useState('');
  const [sampleBusy, setSampleBusy] = useState(false);

  const results = useMemo(() => {
    const filtered = search(query);
    // Search reads the whole timeline: hiding matches behind the free limit
    // would look like a broken search rather than a paywall.
    return query.trim() === '' && !isPro ? filtered.slice(0, FREE_HISTORY_LIMIT) : filtered;
  }, [search, query, isPro]);

  const lockedCount =
    query.trim() === '' && !isPro ? Math.max(0, debriefs.length - FREE_HISTORY_LIMIT) : 0;

  /** The offline demo path: a full example debrief with no credentials at all. */
  const openSample = useCallback(async () => {
    setSampleBusy(true);
    try {
      const debrief = createDemoDebrief({
        title: 'Sample: Acme pilot call',
        contact: 'Priya Raman',
        callType: 'sales',
        recordedAt: new Date().toISOString(),
        durationMs: 31 * 60 * 1000,
        audio: { uri: '', fileName: '', bytes: 0, mimeType: '' },
        consentAt: new Date().toISOString(),
      });
      // The sample has no source audio, only the debrief.
      const stored = { ...debrief, id: `sample-${debrief.id}`, audio: null };
      await add(stored);
      router.push({ pathname: '/debrief', params: { id: stored.id } });
    } finally {
      setSampleBusy(false);
    }
  }, [add, router]);

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
        <Text style={styles.tagline}>Record anywhere.{'\n'}Let Psst remember everything.</Text>
        <Text style={styles.subtitle}>
          Import a call recording and get the decisions, commitments and follow-ups out of it.
        </Text>
      </View>

      <PrimaryButton
        label="Import a recording"
        onPress={() => router.push('/import')}
        testID="import-recording"
      />

      <Pressable
        onPress={openSample}
        disabled={sampleBusy}
        accessibilityRole="button"
        accessibilityLabel="Try a sample debrief"
        testID="try-sample"
        style={({ pressed }) => [styles.sampleButton, pressed && styles.pressed]}>
        <Text style={styles.sampleLabel}>
          {sampleBusy ? 'Opening…' : 'Try a sample debrief'}
        </Text>
      </Pressable>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>YOUR DEBRIEFS</Text>

        {debriefs.length > 0 ? (
          <TextField
            label="Search"
            value={query}
            onChangeText={setQuery}
            placeholder="Name, company, or anything said"
            autoCorrect={false}
            returnKeyType="search"
            testID="search-debriefs"
          />
        ) : null}

        {error ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>Storage problem</Text>
            <Text style={styles.emptyBody}>{error}</Text>
          </View>
        ) : null}

        {!error && loading ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyBody}>Opening your debriefs…</Text>
          </View>
        ) : null}

        {!error && !loading && debriefs.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>No debriefs yet</Text>
            <Text style={styles.emptyBody}>
              Import a call recording and Psst will write the debrief. Try the sample if you just
              want to see one.
            </Text>
          </View>
        ) : null}

        {!error && debriefs.length > 0 && results.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>No match for “{query.trim()}”</Text>
            <Text style={styles.emptyBody}>Search looks at titles, names, and what was said.</Text>
          </View>
        ) : null}

        {results.length > 0 ? (
          <View style={styles.list}>
            {results.map((debrief) => (
              <DebriefRow
                key={debrief.id}
                debrief={debrief}
                onPress={() => router.push({ pathname: '/debrief', params: { id: debrief.id } })}
              />
            ))}
          </View>
        ) : null}

        {lockedCount > 0 ? (
          <Pressable
            onPress={() => router.push('/pro')}
            accessibilityRole="button"
            accessibilityLabel={`${lockedCount} more debriefs in Psst Pro`}
            style={({ pressed }) => [styles.lockedRow, pressed && styles.pressed]}>
            <ProBadge />
            <Text style={styles.lockedText}>
              {lockedCount} older {lockedCount === 1 ? 'debrief' : 'debriefs'} kept with Psst Pro
            </Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.flowRow}>
        <FlowStep index="1" title="Record" body="Any recorder, or a file someone sent you" />
        <FlowStep index="2" title="Import" body="Share it to Psst and agree to the notice" />
        <FlowStep index="3" title="Debrief" body="Decisions, follow-ups and what you promised" />
      </View>

      <Text style={styles.privacy}>
        Psst only reads the recordings you import, and tells you before anything is sent for
        analysis. It never records a call and never joins one.
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
    lineHeight: 33,
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
  sampleButton: {
    alignSelf: 'center',
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
  },
  sampleLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: Palette.accentSoft,
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
  privacy: {
    fontSize: 12,
    lineHeight: 17,
    color: Palette.textFaint,
    textAlign: 'center',
  },
});
