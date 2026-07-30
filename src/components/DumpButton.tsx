import React, { useMemo } from 'react';
import {
    TouchableOpacity,
    Text,
    StyleSheet,
    ActivityIndicator,
    View,
} from 'react-native';
import Animated, { useAnimatedStyle, withTiming, Easing } from 'react-native-reanimated';

import { useTheme, type Theme } from '../theme';

interface DumpButtonProps {
    count: number;
    connected: boolean;
    loading: boolean;
    progress?: { current: number; total: number; title?: string };
    uploadProgress?: number; // 0 to 100
    onPress: () => void;
    label?: string;
    hint?: string;
    disabled?: boolean;
}

export function DumpButton({ count, connected, loading, progress, uploadProgress, onPress, label, hint, disabled: forceDisabled }: DumpButtonProps) {
    const theme = useTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);
    const isDisabled = forceDisabled || count === 0 || (!connected && !label) || loading;

    const fillStyle = useAnimatedStyle(() => {
        const percent = uploadProgress !== undefined ? Math.max(0, Math.min(100, uploadProgress)) : 0;
        return {
            width: withTiming(`${percent}%`, { duration: 200, easing: Easing.out(Easing.ease) }),
            opacity: uploadProgress !== undefined && uploadProgress > 0 ? 1 : 0,
        };
    }, [uploadProgress]);

    const getButtonText = () => {
        if (loading && progress) {
            return `Sending ${progress.current}/${progress.total}…`;
        }
        if (loading) {
            return 'Sending…';
        }
        if (label) {
            return label;
        }
        if (!connected) {
            return `Send all to the reader (${count})`;
        }
        if (count === 0) {
            return 'Nothing queued';
        }
        return `Send all to the reader (${count})`;
    };

    return (
        <View>
            <TouchableOpacity
                style={[
                    styles.button,
                    isDisabled && styles.buttonDisabled,
                    loading && styles.buttonLoading,
                ]}
                onPress={onPress}
                disabled={isDisabled}
                activeOpacity={0.7}
            >
                {/* Progress Fill Background */}
                {uploadProgress !== undefined && (
                    <Animated.View style={[styles.progressFill, fillStyle]} />
                )}

                <View style={styles.content}>
                    {loading ? (
                        <ActivityIndicator
                            color={theme.colors.accentText}
                            size="small"
                            style={styles.spinner}
                        />
                    ) : null}
                    <Text style={[styles.buttonText, isDisabled && styles.buttonTextDisabled]}>
                        {uploadProgress !== undefined && uploadProgress >= 0 && uploadProgress < 100
                            ? `${getButtonText()} (${Math.round(uploadProgress)}%)`
                            : getButtonText()}
                    </Text>
                </View>
            </TouchableOpacity>

            {!connected && count > 0 && (
                <Text style={styles.hint}>
                    {hint || "Join the reader's WiFi to send queued items"}
                </Text>
            )}

            {loading && progress?.title && (
                <Text style={styles.progressTitle} numberOfLines={1}>
                    {progress.title}
                </Text>
            )}
        </View>
    );
}

function createStyles(theme: Theme) {
    return StyleSheet.create({
        button: {
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.colors.accent,
            borderRadius: theme.radii.lg,
            ...theme.shadows.raised,
            overflow: 'hidden',
        },
        content: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            paddingVertical: 18,
            paddingHorizontal: theme.spacing.xxl,
            zIndex: 2,
        },
        progressFill: {
            position: 'absolute',
            top: 0,
            left: 0,
            bottom: 0,
            backgroundColor:
                theme.scheme === 'light'
                    ? theme.alpha(theme.colors.text, 0.12)
                    : 'rgba(255, 255, 255, 0.25)',
            zIndex: 1,
        },
        buttonDisabled: {
            opacity: 0.5,
            shadowOpacity: 0,
            elevation: 0,
        },
        buttonLoading: {
            opacity: 0.9,
        },
        spinner: {
            marginRight: 10,
        },
        buttonText: {
            ...theme.type.button,
            color: theme.colors.accentText,
        },
        buttonTextDisabled: {
            opacity: 0.7,
        },
        hint: {
            ...theme.type.caption,
            color: theme.colors.textMuted,
            textAlign: 'center',
            marginTop: theme.spacing.sm,
        },
        progressTitle: {
            ...theme.type.caption,
            color: theme.colors.textMuted,
            textAlign: 'center',
            marginTop: 6,
        },
    });
}
