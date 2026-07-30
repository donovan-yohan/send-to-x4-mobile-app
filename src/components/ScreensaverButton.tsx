import React, { useMemo } from 'react';
import {
    TouchableOpacity,
    Text,
    StyleSheet,
    ActivityIndicator,
    Alert,
    View,
} from 'react-native';
import Animated, { useAnimatedStyle, withTiming, Easing } from 'react-native-reanimated';
import * as ImagePicker from 'expo-image-picker';

import { useTheme, type Theme } from '../theme';

interface ScreensaverButtonProps {
    connected: boolean;
    onImageSelected: (items: Array<{ uri: string, filename: string, width?: number, height?: number }>) => void;
    loading: boolean;
    progress?: number;
}

export function ScreensaverButton({ connected, onImageSelected, loading, progress }: ScreensaverButtonProps) {
    const theme = useTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);
    // Don't disable if not connected - allow picking to add to queue
    const disabled = loading;

    const fillStyle = useAnimatedStyle(() => {
        const percent = progress !== undefined ? Math.max(0, Math.min(100, progress)) : 0;
        return {
            width: withTiming(`${percent}%`, { duration: 200, easing: Easing.out(Easing.ease) }),
            opacity: progress !== undefined && progress > 0 ? 1 : 0,
        };
    }, [progress]);

    const handlePress = async () => {
        try {
            const result = await ImagePicker.launchImageLibraryAsync({
                mediaTypes: ['images'],
                allowsEditing: false,
                quality: 1,
                allowsMultipleSelection: true,
                selectionLimit: 10,
            });

            if (result.canceled || !result.assets || result.assets.length === 0) {
                return;
            }

            const selectedItems = result.assets.map(asset => {
                const uri = asset.uri;
                // Extract filename from URI
                const uriParts = uri.split('/');
                const originalName = uriParts[uriParts.length - 1];
                const baseName = originalName.replace(/\.[^.]+$/, '');
                const filename = `${baseName}.bmp`; // We might need unique names if multiple selected

                return {
                    uri,
                    filename,
                    width: asset.width,
                    height: asset.height
                };
            });

            onImageSelected(selectedItems);
        } catch (error) {
            console.warn('Image picker error:', error);
            Alert.alert('Error', "Couldn't open your photos — try again in a second.");
        }
    };

    const getButtonText = () => {
        if (loading) {
            return 'Converting and sending…';
        }
        return 'Pick an image';
    };

    return (
        <View>
            <TouchableOpacity
                style={[
                    styles.button,
                    disabled && styles.buttonDisabled,
                    loading && styles.buttonLoading,
                ]}
                onPress={handlePress}
                disabled={disabled}
                activeOpacity={0.7}
            >
                {/* Progress Fill Background */}
                {progress !== undefined && (
                    <Animated.View style={[styles.progressFill, fillStyle]} />
                )}

                <View style={styles.content}>
                    {loading && progress === undefined ? (
                        <ActivityIndicator color={theme.colors.accentText} size="small" style={styles.spinner} />
                    ) : null}
                    <Text style={[styles.buttonText, disabled && styles.buttonTextDisabled]}>
                        {progress !== undefined && progress >= 0 && progress < 100
                            ? `${getButtonText()} (${Math.round(progress)}%)`
                            : getButtonText()}
                    </Text>
                </View>
            </TouchableOpacity>

            {!connected && (
                <Text style={styles.hint}>
                    Join the reader's WiFi to send screensavers
                </Text>
            )}
        </View>
    );
}

function createStyles(theme: Theme) {
    return StyleSheet.create({
        button: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.colors.accent,
            paddingVertical: 18,
            paddingHorizontal: theme.spacing.xxl,
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
    });
}
