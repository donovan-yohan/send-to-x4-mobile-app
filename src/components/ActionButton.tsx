import React, { useMemo } from 'react';
import {
    TouchableOpacity,
    Text,
    StyleSheet,
    ActivityIndicator,
    ViewStyle,
    View,
} from 'react-native';
import Animated, { useAnimatedStyle, withTiming, Easing } from 'react-native-reanimated';

import { useTheme, type Theme } from '../theme';

interface ActionButtonProps {
    title: string;
    /**
     * Optional leading glyph.
     *
     * A STRING renders as text (the historical behaviour); a ReactNode renders
     * as-is, which is what lets a call site pass an SVG icon from
     * `components/icons` instead of an emoji. The cozy pass removed every emoji
     * value that used to be passed here (`🖼`, `◉`, `＋`) — most labels read
     * fine with no glyph at all, which is the preferred answer.
     */
    icon?: React.ReactNode;
    onPress: () => void;
    loading?: boolean;
    disabled?: boolean;
    variant?: 'primary' | 'secondary';
    style?: ViewStyle;
    progress?: number; // 0 to 100
}

export function ActionButton({
    title,
    icon,
    onPress,
    loading = false,
    disabled = false,
    variant = 'primary',
    style,
    progress,
}: ActionButtonProps) {
    const theme = useTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);
    const isDisabled = disabled || loading;

    const fillStyle = useAnimatedStyle(() => {
        const percent = progress !== undefined ? Math.max(0, Math.min(100, progress)) : 0;
        return {
            width: withTiming(`${percent}%`, { duration: 200, easing: Easing.out(Easing.ease) }),
            opacity: progress !== undefined && progress > 0 ? 1 : 0,
        };
    }, [progress]);

    return (
        <TouchableOpacity
            style={[
                styles.button,
                variant === 'primary' ? styles.primary : styles.secondary,
                isDisabled && styles.disabled,
                style,
            ]}
            onPress={onPress}
            disabled={isDisabled}
            activeOpacity={0.7}
        >
            {/*
              * The clip lives HERE, not on the TouchableOpacity, so the primary
              * variant's `shadows.raised` survives on iOS. See `clip` below.
              */}
            <View style={styles.clip}>
                {/* Progress Fill Background */}
                {progress !== undefined && (
                    <Animated.View style={[styles.progressFill, fillStyle]} />
                )}

                <View style={styles.content}>
                    {loading && progress === undefined ? (
                        <ActivityIndicator
                            color={
                                variant === 'primary'
                                    ? theme.colors.accentText
                                    : theme.colors.accent
                            }
                            size="small"
                            style={{ marginRight: 8 }}
                        />
                    ) : icon != null && icon !== '' ? (
                        <View style={styles.iconSlot}>
                            {typeof icon === 'string' || typeof icon === 'number' ? (
                                <Text style={styles.icon}>{icon}</Text>
                            ) : (
                                icon
                            )}
                        </View>
                    ) : null}
                    <Text
                        style={[
                            styles.text,
                            variant === 'primary' ? styles.textPrimary : styles.textSecondary,
                        ]}
                    >
                        {progress !== undefined && progress >= 0 && progress < 100
                            ? `${title} (${Math.round(progress)}%)`
                            : title}
                    </Text>
                </View>
            </View>
        </TouchableOpacity>
    );
}

function createStyles(theme: Theme) {
    return StyleSheet.create({
        button: {
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: theme.radii.lg,
            width: '100%',
            // NO `overflow: 'hidden'` here. On iOS that maps to
            // `clipsToBounds = YES`, which clips the layer's OWN shadow — the
            // primary variant's `shadows.raised` lift would silently never
            // render. The clip that contains the progress fill lives on the
            // inner `clip` View instead, which carries no shadow.
        },
        clip: {
            // Rounds and clips the progress fill; shares the button's radius so
            // the fill cannot square off the corners. Stretches because the
            // parent centres its children.
            alignSelf: 'stretch',
            borderRadius: theme.radii.lg,
            overflow: 'hidden',
        },
        content: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            paddingVertical: theme.spacing.lg,
            paddingHorizontal: theme.spacing.xxl,
            zIndex: 2, // Stay above the progress fill
        },
        progressFill: {
            position: 'absolute',
            top: 0,
            left: 0,
            bottom: 0,
            // A WARM DARK wash in light mode, a white wash in dark mode. White at
            // 25% over the light palette's terracotta reads chalky, and it drops
            // the cream label's contrast against the filled part of the track;
            // darkening the terracotta raises it instead. In dark mode the accent
            // is already an amber ember with near-black text on it, so lightening
            // is the direction that helps there.
            backgroundColor:
                theme.scheme === 'light'
                    ? theme.alpha(theme.colors.text, 0.12)
                    : 'rgba(255, 255, 255, 0.25)',
            zIndex: 1,
        },
        primary: {
            backgroundColor: theme.colors.accent,
            ...theme.shadows.raised,
        },
        secondary: {
            backgroundColor: 'transparent',
            borderWidth: 1,
            borderColor: theme.colors.border,
        },
        disabled: {
            opacity: 0.5,
        },
        iconSlot: {
            marginRight: theme.spacing.sm,
            alignItems: 'center',
            justifyContent: 'center',
        },
        icon: {
            fontSize: 18,
        },
        text: {
            ...theme.type.button,
        },
        textPrimary: {
            color: theme.colors.accentText,
        },
        textSecondary: {
            color: theme.colors.textMuted,
        },
    });
}
