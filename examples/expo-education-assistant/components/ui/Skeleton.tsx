import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '@/lib/Preferences';

export interface SkeletonProps {
  width: number | `${number}%`;
  height: number;
  radius?: number;
  /** Override the block color — the always-dark sidebar passes its own
   * palette's pressed-token instead of the ambient theme's. */
  color?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * A shimmer-free loading placeholder: a flat `cardPressed` block that
 * gently pulses (1.6s, ease-in-out, opacity 1 → 0.45 → 1). Deliberately
 * CSS-transition-free and driver-side cheap — one Animated.value on
 * opacity, which is what keeps it smooth on native too. With the user's
 * "Reduce motion" preference on, it renders as a static block: the
 * shape still communicates "content is coming" without the pulse.
 */
export function Skeleton({ width, height, radius, color, style }: SkeletonProps) {
  const theme = useTheme();
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (theme.reduceMotion) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.45,
          duration: 800,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 800,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [opacity, theme.reduceMotion]);

  return (
    <Animated.View
      style={[
        styles.block,
        {
          width,
          height,
          borderRadius: radius ?? theme.radius.sm,
          backgroundColor: color ?? theme.cardPressed,
          opacity,
        },
        style,
      ]}
      accessibilityRole="none"
      importantForAccessibility="no"
    />
  );
}

const styles = StyleSheet.create({
  block: {},
});
