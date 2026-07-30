/**
 * SegmentedControl — the app's one segmented picker.
 *
 * There were FOUR copy-pasted `TouchableOpacity` loops before this existed
 * (ComposeScreen ×3 — mode, orientation, framing — and WallpaperScreen ×2 —
 * framing, preview mode — plus SettingsScreen's role picker), each with its own
 * `segmentedControl`/`segment`/`segmentActive`/`segmentText` style block. They
 * were already visually identical, which is exactly why they were guaranteed to
 * drift the moment the tokens changed: retokenizing five copies by hand is five
 * chances to miss one.
 *
 * Shape/color come from the cozy theme (see src/theme/tokens.ts):
 *   track    `surface2`, radii.md, padding spacing.xs
 *   segment  flex 1, paddingVertical spacing.md, radii.sm inset
 *   active   `accent` fill, `accentText` label, weight 700
 *   inactive transparent, `textMuted` label, weight 600
 *   disabled opacity 0.5 on the WHOLE control (not per segment), so a control
 *            that is off during a send reads as one inert object
 *
 * Behaviour is deliberately identical to the loops it replaces: a tap on the
 * already-selected segment still calls `onChange` (the screens all early-return
 * on `next === current` themselves, and swallowing it here would hide that).
 */

import React, { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme, type Theme } from '../theme';

export interface SegmentedOption<T extends string> {
    value: T;
    label: string;
}

export interface SegmentedControlProps<T extends string> {
    options: ReadonlyArray<SegmentedOption<T>>;
    value: T;
    onChange: (next: T) => void;
    /** Greys and inerts the whole control — e.g. while a send is in flight. */
    disabled?: boolean;
    style?: StyleProp<ViewStyle>;
    testID?: string;
}

export function SegmentedControl<T extends string>({
    options,
    value,
    onChange,
    disabled = false,
    style,
    testID,
}: SegmentedControlProps<T>) {
    const theme = useTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);

    return (
        <View style={[styles.track, disabled && styles.trackDisabled, style]} testID={testID}>
            {options.map(option => {
                const active = option.value === value;
                return (
                    <TouchableOpacity
                        key={option.value}
                        style={[styles.segment, active && styles.segmentActive]}
                        onPress={() => onChange(option.value)}
                        disabled={disabled}
                        accessibilityRole="button"
                        accessibilityState={{ selected: active, disabled }}
                    >
                        <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                            {option.label}
                        </Text>
                    </TouchableOpacity>
                );
            })}
        </View>
    );
}

function createStyles(theme: Theme) {
    return StyleSheet.create({
        track: {
            flexDirection: 'row',
            backgroundColor: theme.colors.surface2,
            borderRadius: theme.radii.md,
            padding: theme.spacing.xs,
        },
        trackDisabled: {
            opacity: 0.5,
        },
        segment: {
            flex: 1,
            paddingVertical: theme.spacing.md,
            alignItems: 'center',
            borderRadius: theme.radii.sm,
        },
        segmentActive: {
            backgroundColor: theme.colors.accent,
        },
        segmentText: {
            ...theme.type.label,
            fontWeight: '600',
            color: theme.colors.textMuted,
        },
        segmentTextActive: {
            fontWeight: '700',
            color: theme.colors.accentText,
        },
    });
}
