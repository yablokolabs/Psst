/**
 * Import a recording.
 *
 * The whole flow is here, in one screen, because the user is doing one job:
 * bring a recording in and agree to what happens to it. The consent notice is a
 * required, unchecked-by-default acknowledgement — not a dismissible banner —
 * and it sits before the file is sent anywhere.
 *
 * Details are prefilled from the file name and always editable: a wrong guess
 * costs one tap to fix, a wrong date silently baked in would be permanent.
 */

import { getDocumentAsync } from 'expo-document-picker';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { CallTypeSelector } from '@/components/CallTypeSelector';
import { Checkbox } from '@/components/Checkbox';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Screen } from '@/components/Screen';
import { TextField } from '@/components/TextField';
import { DEFAULT_CALL_TYPE } from '@/constants/callTypes';
import { Palette, Radii, Spacing } from '@/constants/theme';
import { useDebriefs } from '@/hooks/use-debriefs';
import { readAudioDurationMs } from '@/services/audioDuration';
import { analyzeRecording, type AnalysisProgress } from '@/services/debriefAnalysis';
import { deleteRecording, storeRecording } from '@/services/debriefDb';
import type { CallType, DebriefAudio, DebriefDraft } from '@/types/debrief';
import {
  describeDurationProblem,
  describeImportProblem,
  formatBytes,
  formatDuration,
  fromDateInputValue,
  inferRecordedAt,
  inferTitleAndContact,
  mimeTypeForExtension,
  toDateInputValue,
} from '@/utils/importMetadata';

type Step = 'pick' | 'details' | 'working';

/** The consent line. Wording is deliberate: it claims nothing on the user's behalf. */
const CONSENT_LABEL =
  'I confirm I have the right and any required consent to upload and analyze this recording.';

export default function ImportScreen() {
  const router = useRouter();
  const { add } = useDebriefs();

  const [step, setStep] = useState<Step>('pick');
  const [audio, setAudio] = useState<DebriefAudio | null>(null);
  const [durationMs, setDurationMs] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const [hardError, setHardError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [contact, setContact] = useState('');
  const [callType, setCallType] = useState<CallType>(DEFAULT_CALL_TYPE);
  const [dateText, setDateText] = useState(() => toDateInputValue(new Date().toISOString()));
  const [consent, setConsent] = useState(false);
  const [progress, setProgress] = useState<AnalysisProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);

  /** Guards against a second analysis starting before the first has navigated. */
  const analysing = useRef(false);

  /** Applies a chosen file: validate, copy into app storage, measure, prefill. */
  const acceptFile = useCallback(
    async (file: {
      uri: string;
      name: string;
      size?: number;
      mimeType?: string;
      lastModified?: number;
    }) => {
      setProblem(null);
      setHardError(null);

      const invalid = describeImportProblem({ name: file.name, size: file.size });
      if (invalid) {
        setProblem(invalid);
        return;
      }

      try {
        // Copying first means the file survives the picker cache expiring, and
        // the debrief always points at something the app owns.
        const stored = storeRecording(file.uri, file.name);
        const measured = await readAudioDurationMs(stored.uri);

        const durationProblem = measured > 0 ? describeDurationProblem(measured) : null;
        if (durationProblem) {
          deleteRecording(stored.uri);
          setProblem(durationProblem);
          return;
        }

        setAudio({ ...stored, mimeType: stored.mimeType || mimeTypeForExtension(file.name) });
        setDurationMs(measured);

        const guess = inferTitleAndContact(file.name);
        setTitle(guess.title);
        setContact(guess.contact);

        const guessedDate =
          inferRecordedAt(file.name) ??
          (typeof file.lastModified === 'number' && Number.isFinite(file.lastModified)
            ? new Date(file.lastModified).toISOString()
            : new Date().toISOString());
        setDateText(toDateInputValue(guessedDate));

        setStep('details');
      } catch {
        setProblem('Psst could not open that file. Try importing it from Files instead.');
      }
    },
    []
  );

  const pickFile = useCallback(async () => {
    setPicking(true);
    setProblem(null);
    try {
      const result = await getDocumentAsync({
        type: ['audio/*'],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled || !result.assets?.[0]) return;

      const asset = result.assets[0];
      await acceptFile({
        uri: asset.uri,
        name: asset.name,
        size: asset.size,
        mimeType: asset.mimeType,
        lastModified: asset.lastModified,
      });
    } catch {
      setProblem('The file picker did not open. Try again, or import from Files.');
    } finally {
      setPicking(false);
    }
  }, [acceptFile]);

  const recordedAt = useMemo(() => fromDateInputValue(dateText), [dateText]);
  const canSubmit = Boolean(audio) && consent && recordedAt !== null && !busy;

  const analyse = useCallback(async () => {
    if (!audio || analysing.current) return;
    const iso = fromDateInputValue(dateText);
    if (!iso) return;

    analysing.current = true;
    setBusy(true);
    setHardError(null);
    setStep('working');
    setProgress({ phase: 'uploading', ratio: 0 });

    const draft: DebriefDraft = {
      title: title.trim() === '' ? 'Call recording' : title.trim(),
      contact: contact.trim(),
      callType,
      recordedAt: iso,
      durationMs,
      audio,
      consentAt: new Date().toISOString(),
    };

    try {
      const outcome = await analyzeRecording(draft, { onProgress: setProgress });

      if (outcome.debrief) {
        await add(outcome.debrief);
        router.replace({
          pathname: '/debrief',
          params: { id: outcome.debrief.id, notice: outcome.notice ?? '' },
        });
        return;
      }

      // A hard failure is a real limit or a broken file: say so and keep the
      // details on screen so the user can fix the input rather than start over.
      setHardError(outcome.error);
      setStep('details');
    } finally {
      analysing.current = false;
      setBusy(false);
    }
  }, [add, audio, callType, contact, dateText, durationMs, router, title]);

  return (
    <Screen
      scroll
      keyboardAvoiding
      header={<Header onBack={() => router.replace('/')} />}
      contentStyle={styles.content}
      footer={
        step === 'details' ? (
          <PrimaryButton
            label="Create debrief"
            onPress={analyse}
            disabled={!canSubmit}
            hint={
              consent
                ? recordedAt === null
                  ? 'Enter the call date as YYYY-MM-DD.'
                  : undefined
                : 'Confirm the consent notice above to continue.'
            }
            testID="create-debrief"
          />
        ) : null
      }>
      {step === 'pick' ? (
        <>
          <View style={styles.titleBlock}>
            <Text style={styles.eyebrow}>IMPORT</Text>
            <Text style={styles.title}>Bring in a recording</Text>
            <Text style={styles.subtitle}>
              A call you recorded yourself, or a file someone sent you. Psst reads the recording and
              writes the debrief.
            </Text>
          </View>

          <PrimaryButton
            label={picking ? 'Opening Files…' : 'Choose a recording'}
            loading={picking}
            onPress={pickFile}
            testID="choose-recording"
          />

          <View style={styles.noteCard}>
            <Text style={styles.noteTitle}>FORMATS</Text>
            <Text style={styles.noteBody}>
              M4A, MP3, WAV or AAC. Up to 50 MB and four hours per recording. Psst cannot record a
              phone call and never joins one — you bring the file.
            </Text>
          </View>

          <Text style={styles.disclaimer}>
            Recording other people may require their permission, and the rules differ by country.
            Psst does not decide that for you.
          </Text>
        </>
      ) : null}

      {step === 'details' ? (
        <>
          <View style={styles.titleBlock}>
            <Text style={styles.eyebrow}>CHECK THE DETAILS</Text>
            <Text style={styles.title}>{audio?.fileName ?? 'Recording'}</Text>
            <Text style={styles.subtitle}>
              {audio && audio.bytes > 0 ? formatBytes(audio.bytes) : 'Size unknown'}
              {durationMs > 0 ? ` · ${formatDuration(durationMs)}` : ' · length read after upload'}
            </Text>
          </View>

          {problem ? (
            <View style={styles.problemCard}>
              <Text style={styles.problemText}>{problem}</Text>
            </View>
          ) : null}

          {hardError ? (
            <View style={styles.problemCard}>
              <Text style={styles.problemText}>{hardError}</Text>
            </View>
          ) : null}

          <TextField
            label="Title"
            value={title}
            onChangeText={setTitle}
            placeholder="Call with Acme"
            testID="import-title"
          />
          <TextField
            label="Who was it with"
            value={contact}
            onChangeText={setContact}
            placeholder="Name or company"
            testID="import-contact"
          />
          <TextField
            label="When was the call"
            value={dateText}
            onChangeText={setDateText}
            placeholder="2026-09-15"
            help={recordedAt === null ? 'Use YYYY-MM-DD, for example 2026-09-15.' : undefined}
            testID="import-date"
          />

          <CallTypeSelector value={callType} onChange={setCallType} />

          <View style={styles.consentCard}>
            <Checkbox
              checked={consent}
              onToggle={setConsent}
              label={CONSENT_LABEL}
              description="Required. Nothing is uploaded until you tick this."
              testID="import-consent"
            />
          </View>

          <View style={styles.noteCard}>
            <Text style={styles.noteTitle}>WHAT HAPPENS NEXT</Text>
            <Text style={styles.noteBody}>
              The recording is sent to the Psst backend for transcription, then to the analysis model
              that writes this debrief. The upload is discarded after analysis; Psst keeps the
              transcript and the debrief, and the recording itself stays on this device until you
              delete it.
            </Text>
          </View>

          <Pressable
            onPress={() => {
              setAudio(null);
              setStep('pick');
              setProblem(null);
              setHardError(null);
            }}
            accessibilityRole="button"
            accessibilityLabel="Choose a different file"
            style={({ pressed }) => [styles.linkButton, pressed && styles.pressed]}>
            <Text style={styles.linkLabel}>Choose a different file</Text>
          </Pressable>
        </>
      ) : null}

      {step === 'working' ? (
        <View style={styles.working}>
          <ActivityIndicator size="large" color={Palette.accent} />
          <Text style={styles.workingTitle}>
            {progress?.phase === 'uploading' ? 'Uploading the recording' : 'Reading the call'}
          </Text>
          <Text style={styles.workingBody}>
            {progress?.phase === 'uploading'
              ? progress.ratio !== null
                ? `${Math.round(progress.ratio * 100)}% sent`
                : 'Sending…'
              : 'Transcribing, then writing the summary, commitments and follow-ups.'}
          </Text>
          {progress?.phase === 'uploading' ? (
            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${Math.round((progress.ratio ?? 0) * 100)}%` },
                ]}
              />
            </View>
          ) : null}
          <Text style={styles.workingHint}>
            Keep Psst open until the debrief appears. A long call can take a few minutes.
          </Text>
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
  subtitle: {
    fontSize: 15,
    lineHeight: 21,
    color: Palette.textSecondary,
  },
  noteCard: {
    backgroundColor: Palette.backgroundElement,
    borderRadius: Radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.border,
    padding: Spacing.three,
    gap: Spacing.one,
  },
  noteTitle: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.4,
    color: Palette.textFaint,
  },
  noteBody: {
    fontSize: 13,
    lineHeight: 19,
    color: Palette.textSecondary,
  },
  consentCard: {
    backgroundColor: Palette.accentWash,
    borderRadius: Radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.borderStrong,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  problemCard: {
    backgroundColor: Palette.backgroundElement,
    borderRadius: Radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.danger,
    padding: Spacing.three,
  },
  problemText: {
    fontSize: 14,
    lineHeight: 20,
    color: Palette.text,
  },
  linkButton: {
    alignSelf: 'flex-start',
    paddingVertical: Spacing.two,
  },
  linkLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: Palette.accentSoft,
  },
  disclaimer: {
    fontSize: 12,
    lineHeight: 17,
    color: Palette.textFaint,
  },
  working: {
    alignItems: 'center',
    gap: Spacing.two,
    paddingTop: Spacing.five,
  },
  workingTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: Palette.text,
  },
  workingBody: {
    fontSize: 14,
    lineHeight: 20,
    color: Palette.textSecondary,
    textAlign: 'center',
  },
  progressTrack: {
    width: '100%',
    height: 6,
    borderRadius: Radii.pill,
    backgroundColor: Palette.backgroundSelected,
    overflow: 'hidden',
    marginTop: Spacing.two,
  },
  progressFill: {
    height: 6,
    backgroundColor: Palette.accent,
  },
  workingHint: {
    fontSize: 12,
    lineHeight: 17,
    color: Palette.textFaint,
    textAlign: 'center',
    paddingTop: Spacing.two,
  },
});
