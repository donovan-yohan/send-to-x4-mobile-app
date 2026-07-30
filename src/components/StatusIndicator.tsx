import React, { useMemo } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native';
import type { ConnectionStatus } from '../types';
import { useTheme, type Theme } from '../theme';

interface StatusIndicatorProps {
    status: ConnectionStatus;
    onRetry?: () => void;
}

export function StatusIndicator({ status, onRetry }: StatusIndicatorProps) {
    const theme = useTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);

    return (
        <View style={styles.container}>
            <View style={styles.statusRow}>
                {status.checking ? (
                    <ActivityIndicator size="small" color={theme.colors.accent} />
                ) : (
                    <View
                        style={[
                            styles.dot,
                            status.connected ? styles.dotConnected : styles.dotDisconnected,
                        ]}
                    />
                )}
                <View style={styles.textContainer}>
                    <Text style={styles.statusText}>
                        {status.checking
                            ? 'Checking connection...'
                            : status.connected
                                ? `Connected to reader (${status.ip})`
                                : "Can't reach the reader right now."}
                    </Text>
                </View>
                {!status.connected && !status.checking && onRetry && (
                    <TouchableOpacity onPress={onRetry} style={styles.retryButton}>
                        <Text style={styles.retryText}>↺</Text>
                    </TouchableOpacity>
                )}
            </View>

            {/* Replaces the old "Firmware: CrossPoint/Stock" line — there is only
                one firmware now, so the useful thing to show is which half of the
                pairing this install is. */}
            <Text style={styles.roleText}>
                Role: {status.role === 'host' ? 'Host (paired with reader)' : 'Client (sends via mailbox)'}
            </Text>

            {/* `lastError` VERBATIM — the transport's own message, url and all.
                The FALLBACK is gone: "Join the reader's WiFi to send files" was
                both redundant (the line above already says the reader can't be
                reached) and, for notes and books, FALSE — those travel by
                mailbox or by handover with the reader nowhere in sight. With no
                error to report there is nothing here worth a second line. */}
            {!status.connected && !status.checking && status.lastError ? (
                <Text style={styles.helpText}>{`Error: ${status.lastError}`}</Text>
            ) : null}
        </View>
    );
}

function createStyles(theme: Theme) {
    return StyleSheet.create({
        container: {
            paddingVertical: theme.spacing.md,
            paddingHorizontal: theme.spacing.lg,
            backgroundColor: theme.colors.surface2,
            borderRadius: theme.radii.md,
        },
        statusRow: {
            flexDirection: 'row',
            alignItems: 'center',
        },
        dot: {
            width: 8,
            height: 8,
            borderRadius: 4,
            marginRight: theme.spacing.sm,
        },
        dotConnected: {
            backgroundColor: theme.colors.success,
        },
        dotDisconnected: {
            backgroundColor: theme.colors.danger,
        },
        textContainer: {
            flex: 1,
        },
        statusText: {
            ...theme.type.body,
            color: theme.colors.text,
        },
        retryButton: {
            padding: theme.spacing.xs,
            paddingHorizontal: theme.spacing.sm,
            backgroundColor: theme.colors.surface,
            borderRadius: theme.radii.sm,
            marginLeft: theme.spacing.sm,
        },
        retryText: {
            color: theme.colors.accent,
            fontSize: 16,
            fontWeight: 'bold',
        },
        roleText: {
            ...theme.type.caption,
            color: theme.colors.textMuted,
            marginTop: theme.spacing.xs,
            marginLeft: theme.spacing.lg,
        },
        helpText: {
            ...theme.type.caption,
            color: theme.colors.danger,
            marginTop: theme.spacing.xs,
            marginLeft: theme.spacing.lg,
        },
    });
}
