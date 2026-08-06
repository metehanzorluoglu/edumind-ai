import { forwardRef, useState } from 'react';
import { Platform, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import { useTheme } from '@/lib/Preferences';

/** '#RRGGBB' -> 'rgba(r,g,b,alpha)' — used only for the web-only focus-ring
 * glow below, since RN's shadow* props don't produce the soft, halo-like
 * ring a CSS box-shadow does; this stays a plain string, not a new
 * dependency, since it's one small conversion used in exactly one place. */
function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export interface TextFieldProps extends Omit<TextInputProps, 'style' | 'placeholderTextColor'> {
  label: string;
  /** Rendered under the label, above the input — "Forgot password?" etc. */
  labelAccessory?: React.ReactNode;
  error?: string | null;
  helperText?: string;
  /** Rendered inside the field on the right — a show/hide-password toggle. */
  trailingAccessory?: React.ReactNode;
}

/**
 * A labeled input with error/helper text and a visible focus ring, used
 * everywhere the app collects text (auth forms, dev settings, image
 * prompts). Always renders a real `<label>`-equivalent — every field has
 * an accessible name from the visible label text, not just a placeholder
 * (placeholders disappear on input and are not a substitute for a label).
 */
export const TextField = forwardRef<TextInput, TextFieldProps>(function TextField(
  { label, labelAccessory, error, helperText, trailingAccessory, editable = true, ...inputProps },
  ref
) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  const hasError = Boolean(error);

  return (
    <View style={styles.field}>
      <View style={styles.labelRow}>
        <Text
          style={[
            styles.label,
            {
              color: theme.subtext,
              fontFamily: theme.fonts.bodySemibold,
              fontSize: theme.scale(13),
            },
          ]}
        >
          {label}
        </Text>
        {labelAccessory}
      </View>
      <View
        style={[
          styles.inputRow,
          {
            backgroundColor: editable ? theme.card : theme.cardPressed,
            borderColor: hasError ? theme.danger : focused ? theme.focusRing : theme.border,
            borderWidth: focused || hasError ? 2 : StyleSheet.hairlineWidth * 2,
            borderRadius: theme.radius.md,
          },
          // A soft halo around the whole field on focus — box-shadow (not
          // RN's shadow* props) is what gets the diffuse, glow-like ring
          // real focus states use, rather than a hard-edged drop shadow.
          // Web-only: native has no equivalent visual convention for this
          // and the border-color/width change above already signals focus
          // clearly there.
          Platform.OS === 'web' && focused && !hasError
            ? ({ boxShadow: `0 0 0 4px ${hexToRgba(theme.focusRing, 0.15)}` } as object)
            : null,
        ]}
      >
        <TextInput
          ref={ref}
          style={[
            styles.input,
            {
              color: theme.text,
              fontFamily: theme.fonts.body,
              fontSize: theme.scale(15),
              // Compensate the row's border width so focus doesn't shift text (2px vs hairline).
              paddingVertical: focused || hasError ? 9 : 10,
            },
          ]}
          placeholderTextColor={theme.faint}
          editable={editable}
          onFocus={(e) => {
            setFocused(true);
            inputProps.onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            inputProps.onBlur?.(e);
          }}
          accessibilityLabel={label}
          {...inputProps}
        />
        {trailingAccessory}
      </View>
      {hasError ? (
        <Text
          style={[styles.helper, { color: theme.danger, fontFamily: theme.fonts.body }]}
          accessibilityRole="alert"
        >
          {error}
        </Text>
      ) : helperText ? (
        <Text style={[styles.helper, { color: theme.faint, fontFamily: theme.fonts.body }]}>
          {helperText}
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  field: { gap: 6 },
  labelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  label: { fontWeight: '600' },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    minHeight: 44,
    ...(Platform.OS === 'web'
      ? ({
          transitionProperty: 'border-color, border-width, box-shadow',
          transitionDuration: '180ms',
        } as object)
      : null),
  },
  input: { flex: 1, minWidth: 0 },
  helper: { fontSize: 12, lineHeight: 16 },
});
