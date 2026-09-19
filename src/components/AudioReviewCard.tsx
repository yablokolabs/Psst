/**
 * The imported recording, as the user's own file.
 *
 * Playback exists so the user can check what Psst analysed, and deleting the
 * recording sits right next to it: the source audio is private by default and
 * leaving it behind should be one deliberate tap, not a settings hunt. Deleting
 * the recording never deletes the debrief.
 */

import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Palette, Radii, Spacing, TouchTarget } from '@/constants/theme';
import type { DebriefAudio } from '@/types/debrief';
import { formatClock } from '@/utils/format';
import { formatBytes } from '@/utils/importMetadata';

export interface AudioReviewCardProps {
  audio: DebriefAudio | null;
  onDeleteRecording: () => void;
}

export function AudioReviewCard({ audio, onDeleteRecording }: AudioReviewCardProps) {
  // Hooks run unconditionally; a null source is how the player is left idle.
  const player = useAudioPlayer(audio ? { uri: audio.uri } : null);
  const status = useAudioPlayerStatus(player);

  if (!audio) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>SOURCE RECORDING</Text>
        <Text style={styles.body}>
          The recording has been deleted. This debrief stays — it is the memory, not the audio.
        </Text>
      </View>
    );
  }

  const duration = status.duration > 0 ? status.duration * 1000 : 0;
  const position = status.currentTime > 0 ? status.currentTime * 1000 : 0;
  const progress = duration > 0 ? Math.min(1, position / duration) : 0;

  const toggle = () => {
    if (status.playing) {
      player.pause();
      return;
    }
    if (status.didJustFinish || (duration > 0 && position >= duration)) player.seekTo(0);
    player.play();
  };

  return (
    <View style={styles.card}>
      <Text style={styles.title}>SOURCE RECORDING</Text>

      <View style={styles.fileRow}>
        <Text style={styles.fileName} numberOfLines={1}>
          {audio.fileName}
        </Text>
        <Text style={styles.meta}>
          {audio.bytes > 0 ? formatBytes(audio.bytes) : ''}
          {audio.bytes > 0 && duration > 0 ? ' · ' : ''}
          {duration > 0 ? formatClock(duration) : ''}
        </Text>
      </View>

      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]} />
      </View>

      <View style={styles.actions}>
        <Pressable
          onPress={toggle}
          accessibilityRole="button"
          accessibilityLabel={status.playing ? 'Pause the recording' : 'Play the recording'}
          testID="play-recording"
          style={({ pressed }) => [styles.playButton, pressed && styles.pressed]}>
          <Text style={styles.playLabel}>
            {status.playing ? 'Pause' : position > 0 ? 'Resume' : 'Play'}
          </Text>
        </Pressable>

        <Pressable
          onPress={onDeleteRecording}
          accessibilityRole="button"
          accessibilityLabel="Delete the source recording"
          testID="delete-recording"
          style={({ pressed }) => [styles.deleteButton, pressed && styles.pressed]}>
          <Text style={styles.deleteLabel}>Delete recording</Text>
        </Pressable>
      </View>

      <Text style={styles.hint}>
        The recording stays on this device. Psst keeps the debrief if you delete it.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Palette.backgroundElement,
    borderRadius: Radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.border,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  title: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.5,
    color: Palette.textFaint,
  },
  body: {
    fontSize: 14,
    lineHeight: 20,
    color: Palette.textSecondary,
  },
  fileRow: {
    gap: 2,
  },
  fileName: {
    fontSize: 15,
    fontWeight: '600',
    color: Palette.text,
  },
  meta: {
    fontSize: 12,
    color: Palette.textFaint,
  },
  progressTrack: {
    height: 4,
    borderRadius: Radii.pill,
    backgroundColor: Palette.backgroundSelected,
    overflow: 'hidden',
  },
  progressFill: {
    height: 4,
    backgroundColor: Palette.accent,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingTop: Spacing.one,
  },
  playButton: {
    minHeight: TouchTarget,
    paddingHorizontal: Spacing.four,
    borderRadius: Radii.pill,
    backgroundColor: Palette.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: Palette.onAccent,
  },
  deleteButton: {
    minHeight: TouchTarget,
    paddingHorizontal: Spacing.three,
    borderRadius: Radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: Palette.textSecondary,
  },
  pressed: {
    opacity: 0.8,
  },
  hint: {
    fontSize: 12,
    lineHeight: 17,
    color: Palette.textFaint,
  },
});
