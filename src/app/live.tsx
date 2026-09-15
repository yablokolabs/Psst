import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';

import { GoalCard } from '@/components/GoalCard';
import { ListeningIndicator } from '@/components/ListeningIndicator';
import { ProBadge } from '@/components/ProBadge';
import { PrimaryButton } from '@/components/PrimaryButton';
import { PsstCueCard } from '@/components/PsstCue';
import { Screen } from '@/components/Screen';
import { SessionTimer } from '@/components/SessionTimer';
import { TranscriptLine } from '@/components/TranscriptLine';
import { FREE_LIVE_LIMIT_MS, FREE_LIVE_MINUTES } from '@/constants/plans';
import { DEFAULT_PRESET, getPreset } from '@/constants/presets';
import { Palette, Radii, Spacing } from '@/constants/theme';
import { useAudioCapture } from '@/hooks/use-audio-capture';
import { useConversation } from '@/hooks/useConversation';
import { usePro } from '@/hooks/use-pro';
import { useSessionHistory } from '@/hooks/use-session-history';
import { DEFAULT_CONVERSATION_MODE, describeMode, type ConversationMode } from '@/services/conversation';
import type {
  ConversationGoal,
  ConversationPreset,
  PsstCue,
  TranscriptEntry,
} from '@/types/conversation';
import { formatClock } from '@/utils/format';

type TimelineItem =
  | { key: string; at: number; kind: 'line'; entry: TranscriptEntry }
  | { key: string; at: number; kind: 'cue'; cue: PsstCue };

function readMode(value: string | string[] | undefined): ConversationMode {
  const single = Array.isArray(value) ? value[0] : value;
  return single === 'mock' || single === 'realtime' ? single : DEFAULT_CONVERSATION_MODE;
}

export default function LiveScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    title?: string;
    objective?: string;
    notes?: string;
    preset?: string;
    mode?: string;
  }>();
  const { isPro } = usePro();
  const { addSession } = useSessionHistory();

  const goal = useMemo<ConversationGoal>(() => {
    const preset = (params.preset as ConversationPreset | undefined) ?? DEFAULT_PRESET;
    const definition = getPreset(preset);
    const title = typeof params.title === 'string' ? params.title.trim() : '';
    return {
      title: title === '' ? definition.titlePlaceholder : title,
      objective: typeof params.objective === 'string' ? params.objective : '',
      notes: typeof params.notes === 'string' ? params.notes : '',
      preset,
    };
  }, [params.objective, params.notes, params.preset, params.title]);

  const [engine, setEngine] = useState<ConversationMode>(() => readMode(params.mode));

  const conversation = useConversation({
    mode: engine,
    limitMs: isPro ? undefined : FREE_LIVE_LIMIT_MS,
  });
  const {
    status,
    entries,
    cues,
    elapsedMs,
    error,
    notice,
    limitReached,
    start,
    restart,
    reset,
    pause,
    resume,
    pushAudio,
    end,
  } = conversation;

  const [finishing, setFinishing] = useState(false);
  const startedRef = useRef(false);
  const finishedRef = useRef(false);
  const engineRef = useRef(engine);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    start(goal);
  }, [goal, start]);

  /**
   * Microphone capture. Audio flows only while a realtime session is actually
   * listening, so the mic is never open in the background or while paused.
   */
  const capture = useAudioCapture({
    active: engine === 'realtime' && status === 'listening',
    onFrame: pushAudio,
  });

  // Switching engines (for example from a failed realtime session to the demo)
  // starts a fresh session with the new engine.
  useEffect(() => {
    if (engineRef.current === engine) return;
    engineRef.current = engine;
    finishedRef.current = false;
    restart();
  }, [engine, restart]);

  /**
   * Stops the session once, stores the recap and optionally opens it. Called by
   * the End session button and by Android back navigation, so leaving LIVE
   * always keeps what Psst captured.
   */
  const finish = useCallback(
    async (options: { openRecap: boolean }) => {
      if (finishedRef.current) return;
      finishedRef.current = true;

      const recap = await end();
      if (!recap) {
        finishedRef.current = false;
        return;
      }

      addSession(recap);
      if (options.openRecap) {
        router.replace({ pathname: '/recap', params: { id: recap.id } });
      }
    },
    [addSession, end, router]
  );

  useFocusEffect(
    useCallback(() => {
      return () => {
        // Leaving the screen (back gesture, hardware back, navigation) ends the
        // session instead of leaving it running in the background.
        void finish({ openRecap: false });
      };
    }, [finish])
  );

  const timeline = useMemo<TimelineItem[]>(() => {
    const items: TimelineItem[] = [
      ...entries.map((entry) => ({ key: `line-${entry.id}`, at: entry.at, kind: 'line' as const, entry })),
      ...cues.map((cue) => ({ key: `cue-${cue.id}`, at: cue.at, kind: 'cue' as const, cue })),
    ];
    return items.sort((a, b) => a.at - b.at);
  }, [entries, cues]);

  const handleContentSizeChange = useCallback(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, []);

  const handleEnd = useCallback(async () => {
    if (finishing) return;
    setFinishing(true);
    try {
      await finish({ openRecap: true });
    } finally {
      setFinishing(false);
    }
  }, [finish, finishing]);

  /**
   * Explicit switch to the demo engine. The engine is torn down first so the
   * change always takes effect, then the effect below restarts the session with
   * a scripted conversation instead of quietly reusing the failed realtime one.
   */
  const handleUseDemo = useCallback(() => {
    reset();
    setEngine('mock');
  }, [reset]);

  const isPaused = status === 'paused';
  const isLive = status === 'listening';
  const isRealtime = engine === 'realtime';
  const microphoneBlocked = isRealtime && (capture.status === 'denied' || capture.status === 'error');
  const microphoneProblem = capture.status === 'denied' ? capture.error : capture.status === 'error' ? capture.error : null;

  return (
    <Screen
      header={
        <View style={styles.header}>
          <View style={styles.headerRow}>
            <View style={styles.liveGroup}>
              <View style={[styles.liveChip, isLive && styles.liveChipActive]}>
                <Text style={[styles.liveLabel, isLive && styles.liveLabelActive]}>LIVE</Text>
              </View>
              <ListeningIndicator status={status} />
            </View>

            <SessionTimer
              elapsedMs={elapsedMs}
              note={isPro ? 'PSST PRO' : `OF ${formatClock(FREE_LIVE_LIMIT_MS)} FREE`}
            />
          </View>

          <GoalCard goal={goal} />

          {limitReached ? (
            <View style={styles.limitCard}>
              <View style={styles.limitHeader}>
                <ProBadge />
                <Text style={styles.limitTitle}>Free listening time used up</Text>
              </View>
              <Text style={styles.limitBody}>
                Psst paused your session after {FREE_LIVE_MINUTES} minutes. Psst Pro keeps listening
                for as long as the conversation runs.
              </Text>
              <PrimaryButton label="See Psst Pro" onPress={() => router.replace('/pro')} />
            </View>
          ) : null}
        </View>
      }
      footer={
        <View style={styles.controls}>
          <PrimaryButton
            label={limitReached ? 'Limit reached' : isPaused ? 'Resume' : 'Pause'}
            variant="secondary"
            onPress={isPaused ? resume : pause}
            disabled={limitReached || status === 'connecting' || status === 'ended'}
            style={styles.controlButton}
          />
          <PrimaryButton
            label="End session"
            variant="destructive"
            onPress={handleEnd}
            loading={finishing}
            style={styles.controlButton}
          />
        </View>
      }
      contentStyle={styles.liveContent}>
      <ScrollView
        ref={scrollRef}
        style={styles.transcriptScroll}
        contentContainerStyle={styles.transcriptContent}
        showsVerticalScrollIndicator={false}
        onContentSizeChange={handleContentSizeChange}>
        <View style={styles.modeRow}>
          <View style={styles.modeChip}>
            <Text style={styles.modeLabel}>{describeMode(engine)}</Text>
          </View>
          {isRealtime ? (
            <View style={[styles.modeChip, capture.isCapturing && styles.micChipActive]}>
              <Text style={[styles.modeLabel, capture.isCapturing && styles.micLabelActive]}>
                {capture.isCapturing ? `MIC LIVE ${Math.round(capture.sampleRate / 100) / 10}kHz` : 'MIC OFF'}
              </Text>
            </View>
          ) : null}
        </View>

        {isRealtime && capture.status === 'requesting' ? (
          <View style={styles.infoCard}>
            <Text style={styles.infoTitle}>Waiting for microphone access</Text>
            <Text style={styles.infoBody}>Approve the microphone prompt to start transcribing.</Text>
          </View>
        ) : null}

        {microphoneBlocked ? (
          <View style={styles.failureCard}>
            <Text style={styles.failureTitle}>
              {capture.status === 'denied' ? 'Microphone access is off' : 'The microphone did not start'}
            </Text>
            <Text style={styles.failureBody}>{microphoneProblem}</Text>
            <Text style={styles.failureHint}>
              Psst cannot transcribe without the microphone. Nothing was recorded.
            </Text>
            <View style={styles.failureActions}>
              {capture.status === 'denied' ? (
                <PrimaryButton
                  label="Open settings"
                  variant="secondary"
                  onPress={() => {
                    void Linking.openSettings();
                  }}
                  style={styles.failureButton}
                />
              ) : null}
              <PrimaryButton
                label="Try again"
                variant={capture.status === 'denied' ? 'secondary' : 'primary'}
                onPress={restart}
                style={styles.failureButton}
              />
              <PrimaryButton
                label="Use demo"
                variant="secondary"
                onPress={handleUseDemo}
                style={styles.failureButton}
              />
            </View>
          </View>
        ) : null}

        {timeline.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>
              {status === 'connecting'
                ? 'Connecting to Psst…'
                : isRealtime && capture.isCapturing
                  ? 'Listening to the room.'
                  : 'Listening in the background.'}
            </Text>
            <Text style={styles.emptyBody}>
              {isRealtime
                ? 'Speak normally. Words appear here as they are recognised, and Psst only interrupts when something is genuinely worth saying.'
                : 'Psst stays quiet unless something is genuinely worth saying. When it is, a short cue appears here.'}
            </Text>
          </View>
        ) : (
          timeline.map((item) =>
            item.kind === 'line' ? (
              <TranscriptLine key={item.key} entry={item.entry} />
            ) : (
              <PsstCueCard key={item.key} cue={item.cue} />
            )
          )
        )}

        {isPaused ? (
          <Text style={styles.pausedNote}>Paused. Psst is not listening until you resume.</Text>
        ) : null}

        {notice ? (
          <View style={[styles.infoCard, notice.level === 'warning' && styles.warningCard]}>
            <Text style={[styles.infoTitle, notice.level === 'warning' && styles.warningTitle]}>
              {notice.level === 'warning' ? 'Pipeline warning' : 'Heads up'}
            </Text>
            <Text style={styles.infoBody}>{notice.message}</Text>
          </View>
        ) : null}

        {error ? (
          <View style={styles.failureCard}>
            <Text style={styles.failureTitle}>Something stopped the session</Text>
            <Text style={styles.failureBody}>{error}</Text>
            <View style={styles.failureActions}>
              <PrimaryButton label="Try again" variant="secondary" onPress={restart} style={styles.failureButton} />
              <PrimaryButton label="Use demo" variant="secondary" onPress={handleUseDemo} style={styles.failureButton} />
              <PrimaryButton
                label="Finish"
                variant="ghost"
                onPress={handleEnd}
                loading={finishing}
                style={styles.failureButton}
              />
            </View>
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.three,
    gap: Spacing.three,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  liveGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  liveChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: Radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.borderStrong,
  },
  liveChipActive: {
    backgroundColor: Palette.accent,
    borderColor: Palette.accent,
  },
  liveLabel: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.6,
    color: Palette.textFaint,
  },
  liveLabelActive: {
    color: Palette.onAccent,
  },
  limitCard: {
    backgroundColor: Palette.accentWash,
    borderRadius: Radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.accent,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  limitHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  limitTitle: {
    flex: 1,
    fontSize: 15,
    fontWeight: '700',
    color: Palette.text,
  },
  limitBody: {
    fontSize: 13,
    lineHeight: 19,
    color: Palette.textSecondary,
    marginBottom: Spacing.one,
  },
  liveContent: {
    paddingHorizontal: 0,
  },
  transcriptScroll: {
    flex: 1,
  },
  transcriptContent: {
    gap: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.one,
    paddingBottom: Spacing.four,
  },
  modeRow: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  modeChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: Radii.pill,
    backgroundColor: Palette.backgroundElement,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.border,
  },
  micChipActive: {
    backgroundColor: Palette.accentWash,
    borderColor: Palette.accent,
  },
  modeLabel: {
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.2,
    color: Palette.textFaint,
  },
  micLabelActive: {
    color: Palette.accentSoft,
  },
  emptyState: {
    gap: Spacing.two,
    paddingVertical: Spacing.four,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: Palette.text,
  },
  emptyBody: {
    fontSize: 14,
    lineHeight: 20,
    color: Palette.textSecondary,
  },
  pausedNote: {
    fontSize: 13,
    color: Palette.warning,
    textAlign: 'center',
  },
  infoCard: {
    backgroundColor: Palette.backgroundElement,
    borderRadius: Radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.border,
    padding: Spacing.three,
    gap: Spacing.one,
  },
  warningCard: {
    borderColor: Palette.warning,
  },
  infoTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: Palette.text,
  },
  warningTitle: {
    color: Palette.warning,
  },
  infoBody: {
    fontSize: 13,
    lineHeight: 19,
    color: Palette.textSecondary,
  },
  failureCard: {
    backgroundColor: Palette.backgroundElement,
    borderRadius: Radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.danger,
    padding: Spacing.three,
    gap: Spacing.one,
  },
  failureTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: Palette.danger,
  },
  failureBody: {
    fontSize: 13,
    lineHeight: 19,
    color: Palette.textSecondary,
  },
  failureHint: {
    fontSize: 13,
    lineHeight: 19,
    color: Palette.textFaint,
  },
  failureActions: {
    gap: Spacing.two,
    marginTop: Spacing.two,
  },
  failureButton: {
    alignSelf: 'stretch',
  },
  controls: {
    flexDirection: 'row',
    gap: Spacing.two,
    paddingBottom: Spacing.two,
  },
  controlButton: {
    flex: 1,
  },
});
