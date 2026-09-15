import { StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';

import { Palette, Radii, Spacing } from '@/constants/theme';

export interface TextFieldProps extends TextInputProps {
  label: string;
  /** Small helper line under the input. */
  help?: string;
}

export function TextField({ label, help, style, multiline, ...rest }: TextFieldProps) {
  return (
    <View style={styles.container}>
      <Text style={styles.label}>{label.toUpperCase()}</Text>
      <TextInput
        {...rest}
        multiline={multiline}
        placeholderTextColor={Palette.textFaint}
        selectionColor={Palette.accent}
        style={[styles.input, multiline && styles.inputMultiline, style]}
      />
      {help ? <Text style={styles.help}>{help}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: Spacing.two,
  },
  label: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.4,
    color: Palette.textFaint,
  },
  input: {
    backgroundColor: Palette.backgroundElement,
    borderRadius: Radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.border,
    paddingHorizontal: Spacing.three,
    paddingVertical: 14,
    fontSize: 16,
    color: Palette.text,
    minHeight: 48,
  },
  inputMultiline: {
    minHeight: 96,
    textAlignVertical: 'top',
  },
  help: {
    fontSize: 12,
    color: Palette.textFaint,
  },
});
