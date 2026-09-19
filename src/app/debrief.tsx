/**
 * The Psst Debrief.
 *
 * This is the product: everything the call cost the user to forget, written
 * down. A debrief is a draft they own, so tasks can be ticked or removed, the
 * title and contact can be corrected, the follow-up message can be copied and
 * sent, and the recording can be deleted while the debrief stays.
 *
 * Nothing here pretends to be certain. Diarized voices are labelled "Speaker 1"
 * because a recording cannot tell Psst which voice was the user's, and a debrief
 * that did not come from the audio says so at the top.
 */

import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, Share, StyleSheet, Text, View } from 'react-native';

import { AudioReviewCard } from '@/components/AudioReviewCard';
import { DebriefSection } from '@/components/DebriefSection';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Screen } from '@/components/Screen';
import { TaskRow } from '@/components/TaskRow';
import { TextField } from '@/components/TextField';
import { getCallType } from '@/constants/callTypes';
import { Palette, Radii, Spacing } from '@/constants/theme';
import { useDebriefs } from '@/hooks/use-debriefs';
import { createTaskReminder } from '@/services/reminders';
import type { DebriefCommitment, TranscriptLine } from '@/types/debrief';
import { buildDebriefText } from '@/utils/debriefText';
import { formatSessionDate } from '@/utils/format';
import { formatDuration } from '@/utils/importMetadata';

export default function DebriefScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string; notice?: string }>();
  const { debriefs, update, remove, forgetRecording } = useDebriefs();

  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [contactDraft, setContactDraft] = useState('');
  const [copied, setCopied] = useState(false);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showTranscript, setShowTranscript] = useState(false);

  const debrief = useMemo(() => {
    const id = typeof params.id === 'string' ? params.id : undefined;
    return (id ? debriefs.find((item) => item.id === id) : undefined) ?? debriefs[0];
  }, [debriefs, params.id]);

  const notice = typeof params.notice === 'string' && params.notice !== '' ? params.notice : null;

  const startEditing = useCallback(() => {
    if (!debrief) return;
    setTitleDraft(debrief.title);
    setContactDraft(debrief.contact);
    setEditing(true);
  }, [debrief]);

  const saveEdits = useCallback(async () => {
    if (!debrief) return;
    await update(debrief.id, {
      title: titleDraft.trim() === '' ? debrief.title : titleDraft.trim(),
      contact: contactDraft.trim(),
    });
    setEditing(false);
  }, [contactDraft, debrief, titleDraft, update]);

  const copyMessage = useCallback(async () => {
    if (!debrief) return;
    try {
      await Clipboard.setStringAsync(debrief.suggestedMessage);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setActionError('Psst could not reach the clipboard on this device.');
    }
  }, [debrief]);

  const shareDebrief = useCallback(async () => {
    if (!debrief) return;
    try {
      await Share.share({ message: buildDebriefText(debrief), title: debrief.title });
    } catch {
      // The share sheet was dismissed: nothing to recover from.
    }
  }, [debrief]);

  const toggleTask = useCallback(
    async (taskId: string, done: boolean) => {
      if (!debrief) return;
      await update(debrief.id, {
        tasks: debrief.tasks.map((task) => (task.id === taskId ? { ...task, done } : task)),
      });
    },
    [debrief, update]
  );

  const removeTask = useCallback(
    async (taskId: string) => {
      if (!debrief) return;
      await update(debrief.id, { tasks: debrief.tasks.filter((task) => task.id !== taskId) });
    },
    [debrief, update]
  );

  const addReminder = useCallback(
    async (taskId: string) => {
      if (!debrief) return;
      const task = debrief.tasks.find((item) => item.id === taskId);
      if (!task) return;

      setBusyTaskId(taskId);
      setActionError(null);
      try {
        const result = await createTaskReminder(task, {
          debriefTitle: debrief.title,
          contact: debrief.contact,
        });
        if (!result.ok) {
          setActionError(result.error ?? 'Psst could not add that reminder.');
          return;
        }
        await update(debrief.id, {
          tasks: debrief.tasks.map((item) =>
            item.id === taskId ? { ...item, calendarEventId: result.eventId ?? 'created' } : item
          ),
        });
      } finally {
        setBusyTaskId(null);
      }
    },
    [debrief, update]
  );

  const deleteTranscript = useCallback(async () => {
    if (!debrief) return;
    await update(debrief.id, { transcript: null });
  }, [debrief, update]);

  const deleteDebrief = useCallback(async () => {
    if (!debrief) return;
    await remove(debrief.id);
    router.replace('/');
  }, [debrief, remove, router]);

  if (!debrief) {
    return (
      <Screen centered header={<Header onBack={() => router.replace('/')} />} contentStyle={styles.content}>
        <Text style={styles.emptyTitle}>No debrief to show</Text>
        <Text style={styles.emptyBody}>Import a recording and the debrief will appear here.</Text>
        <PrimaryButton label="Import a recording" onPress={() => router.push('/import')} />
      </Screen>
    );
  }

  const callType = getCallType(debrief.callType);
  const meta = [callType.label, debrief.contact.trim(), formatSessionDate(debrief.recordedAt)]
    .filter((part) => part !== '')
    .join(' · ');
  const duration = debrief.durationMs > 0 ? formatDuration(debrief.durationMs) : '';
  const openTasks = debrief.tasks.filter((task) => !task.done).length;

  return (
    <Screen
      scroll
      header={<Header onBack={() => router.replace('/')} />}
      contentStyle={styles.content}
      footer={
        <View style={styles.footer}>
          <PrimaryButton
            label="Share debrief"
            onPress={shareDebrief}
            style={styles.footerButton}
            testID="share-debrief"
          />
          {debrief.suggestedMessage.trim() !== '' ? (
            <PrimaryButton
              label={copied ? 'Copied' : 'Copy follow-up'}
              variant="secondary"
              onPress={copyMessage}
              style={styles.footerButton}
              testID="copy-follow-up"
            />
          ) : null}
        </View>
      }>
      <View style={styles.titleBlock}>
        <Text style={styles.eyebrow}>DEBRIEF</Text>
        <Text style={styles.title}>{debrief.title}</Text>
        <Text style={styles.meta}>
          {meta}
          {duration !== '' ? ` · ${duration}` : ''}
          {openTasks > 0 ? ` · ${openTasks} open` : ''}
        </Text>
      </View>

      {debrief.origin === 'demo' ? (
        <View style={styles.noticeCard}>
          <Text style={styles.noticeTitle}>DEMO ANALYSIS</Text>
          <Text style={styles.noticeBody}>
            {notice ??
              'This debrief is an offline example rather than a reading of your recording. Nothing was sent anywhere.'}
          </Text>
        </View>
      ) : null}

      {debrief.origin === 'backend' && debrief.degraded ? (
        <View style={styles.noticeCard}>
          <Text style={styles.noticeTitle}>PARTIAL ANALYSIS</Text>
          <Text style={styles.noticeBody}>
            {notice ??
              'Psst transcribed the recording but could not write the summary. The transcript is below.'}
          </Text>
        </View>
      ) : null}

      {!editing ? (
        <Pressable
          onPress={startEditing}
          accessibilityRole="button"
          accessibilityLabel="Edit the title and contact"
          style={({ pressed }) => [styles.linkButton, pressed && styles.pressed]}>
          <Text style={styles.linkLabel}>Edit title and contact</Text>
        </Pressable>
      ) : (
        <View style={styles.editCard}>
          <TextField label="Title" value={titleDraft} onChangeText={setTitleDraft} />
          <TextField
            label="Who it was with"
            value={contactDraft}
            onChangeText={setContactDraft}
            placeholder="Name or company"
          />
          <View style={styles.editActions}>
            <PrimaryButton label="Save" onPress={saveEdits} style={styles.editButton} />
            <PrimaryButton
              label="Cancel"
              variant="secondary"
              onPress={() => setEditing(false)}
              style={styles.editButton}
            />
          </View>
        </View>
      )}

      {actionError ? (
        <View style={styles.problemCard}>
          <Text style={styles.problemText}>{actionError}</Text>
        </View>
      ) : null}

      <DebriefSection title="Summary" body={debrief.summary} hideWhenEmpty />
      <DebriefSection title="Key decisions" items={debrief.keyDecisions} tone="accent" hideWhenEmpty />

      <CommitmentsSection commitments={debrief.commitments} />

      <View style={styles.sectionCard}>
        <Text style={styles.sectionTitle}>FOLLOW-UP</Text>
        {debrief.tasks.length === 0 ? (
          <Text style={styles.sectionEmpty}>No follow-ups were captured.</Text>
        ) : (
          <View style={styles.taskList}>
            {debrief.tasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                onToggle={(done) => void toggleTask(task.id, done)}
                onAddReminder={() => void addReminder(task.id)}
                reminderBusy={busyTaskId === task.id}
                reminderAdded={Boolean(task.calendarEventId)}
                onRemove={() => void removeTask(task.id)}
              />
            ))}
          </View>
        )}
      </View>

      {debrief.suggestedMessage.trim() !== '' ? (
        <View style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>SUGGESTED FOLLOW-UP MESSAGE</Text>
          <Text style={styles.message}>{debrief.suggestedMessage}</Text>
          <Pressable
            onPress={copyMessage}
            accessibilityRole="button"
            accessibilityLabel="Copy the follow-up message"
            style={({ pressed }) => [styles.linkButton, pressed && styles.pressed]}>
            <Text style={styles.linkLabel}>{copied ? 'Copied to clipboard' : 'Copy message'}</Text>
          </Pressable>
        </View>
      ) : null}

      <DebriefSection
        title="People mentioned"
        items={debrief.people.map((person) =>
          person.context.trim() === '' ? person.name : `${person.name} — ${person.context}`
        )}
        hideWhenEmpty
      />
      <DebriefSection title="Open questions" items={debrief.openQuestions} hideWhenEmpty />
      <DebriefSection
        title="Risks and red flags"
        items={debrief.risks.map((risk) =>
          risk.detail.trim() === '' ? risk.label : `${risk.label} — ${risk.detail}`
        )}
        tone="warning"
        hideWhenEmpty
      />

      {debrief.tone.label.trim() !== '' || debrief.tone.note.trim() !== '' || debrief.relationship.trim() !== '' ? (
        <DebriefSection
          title="Tone and relationship"
          body={[debrief.tone.label, debrief.tone.note].filter((part) => part.trim() !== '').join(' — ')}
          items={debrief.relationship.trim() !== '' ? [debrief.relationship] : []}
        />
      ) : null}

      <DebriefSection
        title="Remember"
        items={debrief.reminders}
        tone="success"
        hideWhenEmpty
      />

      <AudioReviewCard audio={debrief.audio} onDeleteRecording={() => void forgetRecording(debrief.id)} />

      {debrief.transcript && debrief.transcript.length > 0 ? (
        <View style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>TRANSCRIPT</Text>
          <Text style={styles.sectionHint}>
            {debrief.transcript.length} line(s), labelled by voice. Psst cannot tell which voice is
            yours in a recording, so it does not guess.
          </Text>
          <Pressable
            onPress={() => setShowTranscript((previous) => !previous)}
            accessibilityRole="button"
            accessibilityLabel={showTranscript ? 'Hide the transcript' : 'Show the transcript'}
            style={({ pressed }) => [styles.linkButton, pressed && styles.pressed]}>
            <Text style={styles.linkLabel}>{showTranscript ? 'Hide transcript' : 'Show transcript'}</Text>
          </Pressable>
          {showTranscript ? (
            <View style={styles.transcript}>
              {debrief.transcript.map((line) => (
                <TranscriptRow key={line.id} line={line} />
              ))}
            </View>
          ) : null}
        </View>
      ) : null}

      <View style={styles.sectionCard}>
        <Text style={styles.sectionTitle}>PRIVACY</Text>
        <Text style={styles.sectionHint}>
          The debrief is stored on this device. Deleting it removes the debrief and its recording.
          Deleting only the recording leaves the debrief.
        </Text>
        <View style={styles.privacyActions}>
          {debrief.transcript && debrief.transcript.length > 0 ? (
            <Pressable
              onPress={() => void deleteTranscript()}
              accessibilityRole="button"
              accessibilityLabel="Delete the transcript"
              style={({ pressed }) => [styles.linkButton, pressed && styles.pressed]}>
              <Text style={styles.linkLabel}>Delete transcript</Text>
            </Pressable>
          ) : null}
          <Pressable
            onPress={() => void deleteDebrief()}
            accessibilityRole="button"
            accessibilityLabel="Delete this debrief"
            testID="delete-debrief"
            style={({ pressed }) => [styles.linkButton, pressed && styles.pressed]}>
            <Text style={styles.destructiveLabel}>Delete this debrief</Text>
          </Pressable>
        </View>
      </View>
    </Screen>
  );
}

function TranscriptRow({ line }: { line: TranscriptLine }) {
  const who = line.label !== '' ? line.label : line.speaker === 'you' ? 'You' : line.speaker === 'them' ? 'Them' : 'Speaker';
  return (
    <View style={styles.transcriptRow}>
      <Text style={styles.transcriptWho}>{who}</Text>
      <Text style={styles.transcriptText}>{line.text}</Text>
    </View>
  );
}

/** Who owes it, said plainly. A recording cannot resolve roles, so it can say so. */
function describeOwner(commitment: DebriefCommitment): string {
  if (commitment.owner === 'you') return 'You';
  if (commitment.person.trim() !== '') return commitment.person.trim();
  return commitment.owner === 'them' ? 'They' : 'Unclear who';
}

function CommitmentsSection({ commitments }: { commitments: DebriefCommitment[] }) {
  if (commitments.length === 0) return null;

  return (
    <View style={styles.sectionCard}>
      <Text style={styles.sectionTitle}>COMMITMENTS</Text>
      <View style={styles.commitmentList}>
        {commitments.map((commitment) => (
          <View key={commitment.id} style={styles.commitmentRow}>
            <Text style={styles.commitmentOwner}>{describeOwner(commitment)}</Text>
            <Text style={styles.commitmentText}>{commitment.what}</Text>
            {commitment.when.trim() !== '' ? (
              <Text style={styles.commitmentWhen}>by {commitment.when}</Text>
            ) : null}
          </View>
        ))}
      </View>
    </View>
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
    lineHeight: 19,
    color: Palette.textSecondary,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: Palette.text,
  },
  emptyBody: {
    fontSize: 15,
    lineHeight: 21,
    color: Palette.textSecondary,
    textAlign: 'center',
  },
  noticeCard: {
    backgroundColor: Palette.accentWash,
    borderRadius: Radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.borderStrong,
    padding: Spacing.three,
    gap: Spacing.one,
  },
  noticeTitle: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.4,
    color: Palette.accentSoft,
  },
  noticeBody: {
    fontSize: 13,
    lineHeight: 19,
    color: Palette.text,
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
  sectionCard: {
    backgroundColor: Palette.backgroundElement,
    borderRadius: Radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.border,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  sectionTitle: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.5,
    color: Palette.textFaint,
  },
  sectionEmpty: {
    fontSize: 14,
    color: Palette.textFaint,
  },
  sectionHint: {
    fontSize: 12,
    lineHeight: 17,
    color: Palette.textFaint,
  },
  taskList: {
    gap: Spacing.three,
  },
  message: {
    fontSize: 15,
    lineHeight: 22,
    color: Palette.text,
  },
  commitmentList: {
    gap: Spacing.two,
  },
  commitmentRow: {
    gap: 2,
  },
  commitmentOwner: {
    fontSize: 12,
    fontWeight: '700',
    color: Palette.accentSoft,
  },
  commitmentText: {
    fontSize: 15,
    lineHeight: 21,
    color: Palette.text,
  },
  commitmentWhen: {
    fontSize: 12,
    color: Palette.textFaint,
  },
  linkButton: {
    alignSelf: 'flex-start',
    paddingVertical: Spacing.one,
  },
  linkLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: Palette.accentSoft,
  },
  destructiveLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: Palette.danger,
  },
  editCard: {
    backgroundColor: Palette.backgroundElement,
    borderRadius: Radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.border,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  editActions: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  editButton: {
    flex: 1,
  },
  transcript: {
    gap: Spacing.two,
    paddingTop: Spacing.one,
  },
  transcriptRow: {
    gap: 2,
  },
  transcriptWho: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
    color: Palette.textFaint,
  },
  transcriptText: {
    fontSize: 14,
    lineHeight: 20,
    color: Palette.textSecondary,
  },
  privacyActions: {
    gap: Spacing.one,
  },
  footer: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  footerButton: {
    flex: 1,
  },
});
