import React, { useMemo } from 'react';
import { View, Text, ActivityIndicator, StyleSheet, Modal } from 'react-native';

import { useTheme, type Theme } from '../theme';

interface ProcessingOverlayProps {
    visible: boolean;
    message?: string;
}

export function ProcessingOverlay({ visible, message = 'Processing...' }: ProcessingOverlayProps) {
    const theme = useTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);

    return (
        <Modal transparent animationType="fade" visible={visible}>
            <View style={styles.overlay}>
                <View style={styles.container}>
                    <ActivityIndicator size="large" color={theme.colors.accent} />
                    {/* Carries a per-file upload label ("Uploading 3/7: x.epub… 42%")
                        straight from ProgressProvider — byte-exact, not reworded. */}
                    <Text style={styles.text}>{message}</Text>
                </View>
            </View>
        </Modal>
    );
}

function createStyles(theme: Theme) {
    return StyleSheet.create({
        overlay: {
            flex: 1,
            // A warm scrim derived from the palette's own shadow colour, rather
            // than flat black: over the cream light theme, neutral black reads as a
            // cold grey sheet.
            backgroundColor: theme.alpha(theme.colors.shadow, 0.7),
            justifyContent: 'center',
            alignItems: 'center',
        },
        container: {
            backgroundColor: theme.colors.surface,
            padding: theme.spacing.xxl,
            borderRadius: theme.radii.lg,
            alignItems: 'center',
            borderWidth: 1,
            borderColor: theme.colors.border,
            ...theme.shadows.raised,
            minWidth: 200,
        },
        text: {
            ...theme.type.button,
            color: theme.colors.text,
            marginTop: theme.spacing.lg,
            textAlign: 'center',
        },
    });
}
