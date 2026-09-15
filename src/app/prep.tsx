import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { EngineSelector } from '@/components/EngineSelector';
import { PresetSelector } from '@/components/PresetSelector';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Screen } from '@/components/Screen';
import { TextField } from '@/components/TextField';
import { DEFAULT_PRESET, getPreset } from '@/constants/presets';
import { Palette, Radii, Spacing } from '@/constants/theme';
import {
  DEFAULT_CONVERSATION_MODE,
  isRealtimeAvailable,
  type ConversationMode,
} from '@/services/conversation';
import type { ConversationPreset } from '@/types/conversation';

export default function PrepScreen() {
  const router = useRouter();
  const [preset, setPreset] = useState<ConversationPreset>(DEFAULT_PRESET);
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  const [notes, setNotes] = useState('');
  // The default follows the build config; the user can always switch explicitly.
  const [mode, setMode] = useState<ConversationMode>(DEFAULT_CONVERSATION_MODE);

  const definition = getPreset(preset);
  const ready = title.trim().length > 0 || objective.trim().length > 0;

  const startListening = () => {
    router.push({
      pathname: '/live',
      params: {
        title: title.trim() === '' ? definition.titlePlaceholder : title.trim(),
        objective: objective.trim(),
        notes: notes.trim(),
        preset,
        mode,
      },
    });
  };

  return (
    <Screen
      scroll
      keyboardAvoiding
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
      <View style={styles.intro}>
        <Text style={styles.title}>Prep your Psst</Text>
        <Text style={styles.subtitle}>
          Tell Psst what this conversation is about. You can change everything later.
        </Text>
      </View>

      <View style={styles.block}>
        <Text style={styles.blockLabel}>WHAT KIND OF CONVERSATION?</Text>
        <PresetSelector value={preset} onChange={setPreset} />
      </View>

      <View style={styles.block}>
        <Text style={styles.blockLabel}>HOW SHOULD PSST LISTEN?</Text>
        <EngineSelector value={mode} onChange={setMode} />
      </View>

      <TextField
        label="Conversation title"
        value={title}
        onChangeText={setTitle}
        placeholder={definition.titlePlaceholder}
        returnKeyType="next"
        autoCapitalize="sentences"
        maxLength={60}
      />

      <TextField
        label="What do you want to achieve?"
        value={objective}
        onChangeText={setObjective}
        placeholder={definition.objectivePlaceholder}
        multiline
        maxLength={240}
        help="Psst uses this to decide which moments are worth interrupting for."
      />

      <TextField
        label="Anything you don't want to forget?"
        value={notes}
        onChangeText={setNotes}
        placeholder="Numbers, names, walk-away points, things to bring up."
        multiline
        maxLength={240}
        help="Optional. Psst will nudge you if these never come up."
      />

      <View style={styles.privacyCard}>
        <Text style={styles.privacyTitle}>Before you start</Text>
        <Text style={styles.privacyBody}>
          {mode === 'realtime' && isRealtimeAvailable()
            ? 'Psst will use your microphone for this session only, and shows a listening indicator the whole time. Audio is processed to produce your transcript and private cues. Make sure everyone involved is comfortable with audio processing, and follow the consent rules that apply where you are.'
            : 'Psst listens only during sessions you start, and shows a listening indicator the whole time. Make sure everyone involved is comfortable with audio processing, and follow the consent rules that apply where you are.'}
        </Text>
      </View>

      <View style={styles.footerBlock}>
        <PrimaryButton
          label={mode === 'realtime' ? 'Start listening' : 'Start demo session'}
          onPress={startListening}
          disabled={!ready}
          hint={ready ? undefined : 'Add a title or an objective first'}
          testID="start-listening"
        />
      </View>
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
    gap: Spacing.four,
  },
  intro: {
    gap: Spacing.one,
  },
  title: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '700',
    color: Palette.text,
  },
  subtitle: {
    fontSize: 15,
    lineHeight: 21,
    color: Palette.textSecondary,
  },
  block: {
    gap: Spacing.two,
  },
  blockLabel: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.4,
    color: Palette.textFaint,
  },
  privacyCard: {
    backgroundColor: Palette.backgroundElement,
    borderRadius: Radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.border,
    padding: Spacing.three,
    gap: Spacing.one,
  },
  privacyTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: Palette.accentSoft,
  },
  privacyBody: {
    fontSize: 13,
    lineHeight: 19,
    color: Palette.textSecondary,
  },
  footerBlock: {
    paddingTop: Spacing.two,
  },
});
