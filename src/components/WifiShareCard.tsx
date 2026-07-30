/**
 * WifiShareCard — "Share WiFi with reader", the whole feature's UI.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AS A CARD AND NOT AS TWO MORE SETTINGS FIELDS
 * ---------------------------------------------------------------------------
 * A WiFi password typed into a settings form reads like configuration — a value
 * the app keeps and uses. This one is neither: it is staged, handed to the
 * reader over the next 'Sync with app' session, and then DELETED off the phone.
 * A card with its own status line can say that; a labelled TextInput sitting
 * between "Mailbox URL" and "Device Host" cannot, and would leave the user with
 * no way to know whether anything happened.
 *
 * MOUNTED WITH ONE LINE (`<WifiShareCard />`) so the screen it lives on owns
 * nothing about it: no state, no handler, no copy. That is deliberate — this
 * landed while a separate pass was rewriting the same screens, and a feature
 * whose entire footprint in a shared file is one self-contained element is a
 * feature that cannot lose an argument with a merge.
 *
 * ---------------------------------------------------------------------------
 * THE SSID FIELD STARTS EMPTY, AND THAT IS NOT AN OVERSIGHT
 * ---------------------------------------------------------------------------
 * Android will not tell an app the name of the network it is on without
 * location permission — see {@link WIFI_SHARE_NO_PREFILL} in
 * `services/wifi_share`, which is rendered here rather than buried in a comment,
 * because a user looking at an empty field that "obviously" could be filled in
 * deserves the reason. The app deliberately holds no location permission.
 *
 * There is no password prefill for anyone, ever: no Android API returns a saved
 * PSK to a non-system app. That is why this is typed once, here, instead of
 * being read off the phone.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    Modal,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
    type StyleProp,
    type ViewStyle,
} from 'react-native';

import { useTheme, type Theme } from '../theme';
import {
    WIFI_SHARE_NO_PREFILL,
    clearWifiShare,
    describeWifiShare,
    getWifiShare,
    stageWifiShare,
    subscribeWifiShare,
    type WifiShareRecord,
} from '../services/wifi_share';

export interface WifiShareCardProps {
    style?: StyleProp<ViewStyle>;
}

export function WifiShareCard({ style }: WifiShareCardProps) {
    const theme = useTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);

    const [record, setRecord] = useState<WifiShareRecord | null>(null);
    const [open, setOpen] = useState(false);
    const [ssid, setSsid] = useState('');
    const [password, setPassword] = useState('');
    const [reveal, setReveal] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    // Read once, then follow. The subscription is what makes the handover
    // visible: the sync session wipes the staging on the reader's ack, and this
    // card flips to "Handed over" with nothing polling and no screen involved.
    useEffect(() => {
        let alive = true;
        void getWifiShare().then(next => {
            if (alive) setRecord(next);
        });
        const off = subscribeWifiShare(next => setRecord(next));
        return () => {
            alive = false;
            off();
        };
    }, []);

    const openSheet = useCallback(() => {
        // The SSID of an already-staged network is offered back (it is not a
        // secret, and re-typing it to change only the password is busywork). The
        // PASSWORD never is — a delivered record no longer holds one, and even a
        // pending one is not worth re-displaying when the field can simply be
        // retyped.
        setSsid(record?.ssid ?? '');
        setPassword('');
        setReveal(false);
        setError(null);
        setOpen(true);
    }, [record]);

    const closeSheet = useCallback(() => {
        setOpen(false);
        // Dropped on the way out rather than left in state: a passphrase has no
        // reason to outlive the sheet it was typed into.
        setSsid('');
        setPassword('');
        setReveal(false);
        setError(null);
    }, []);

    const save = useCallback(() => {
        if (saving) return;
        setSaving(true);
        void (async () => {
            const result = await stageWifiShare({ ssid: ssid.trim(), password });
            setSaving(false);
            if (!result.ok) {
                setError(result.error);
                return;
            }
            closeSheet();
        })();
    }, [saving, ssid, password, closeSheet]);

    const remove = useCallback(() => {
        void clearWifiShare();
    }, []);

    const status = describeWifiShare(record);

    return (
        <View style={[styles.card, style]}>
            <Text style={styles.title}>Share WiFi with reader</Text>
            {/* THE ONE PROMISE THIS CARD MAKES, and the only line shown when
                nothing is staged. It says where the passphrase goes (nowhere but
                the reader) and when (the next sync), because both are things a
                user would otherwise have to guess about a password field. */}
            <Text style={styles.body}>
                {status ??
                    'Type your network once here and the reader picks it up over the next sync — nothing is typed on the reader itself.'}
            </Text>

            <View style={styles.actions}>
                <TouchableOpacity
                    style={styles.primaryAction}
                    onPress={openSheet}
                    accessibilityRole="button"
                    accessibilityLabel={record ? 'Change the WiFi shared with the reader' : 'Share WiFi with the reader'}
                >
                    <Text style={styles.primaryActionText}>{record ? 'Change' : 'Share WiFi'}</Text>
                </TouchableOpacity>
                {record ? (
                    <TouchableOpacity
                        style={styles.secondaryAction}
                        onPress={remove}
                        accessibilityRole="button"
                        accessibilityLabel="Remove the WiFi shared with the reader"
                    >
                        <Text style={styles.secondaryActionText}>Remove</Text>
                    </TouchableOpacity>
                ) : null}
            </View>

            <Modal
                visible={open}
                animationType="fade"
                transparent
                onRequestClose={closeSheet}
            >
                <View style={styles.backdrop}>
                    <View style={styles.sheet}>
                        <ScrollView keyboardShouldPersistTaps="handled">
                            <Text style={styles.sheetTitle}>Share WiFi with reader</Text>

                            <Text style={styles.fieldLabel}>Network name</Text>
                            <TextInput
                                style={styles.input}
                                value={ssid}
                                onChangeText={value => {
                                    setSsid(value);
                                    setError(null);
                                }}
                                placeholder="Your WiFi network"
                                placeholderTextColor={theme.colors.textMuted}
                                autoCapitalize="none"
                                autoCorrect={false}
                                accessibilityLabel="WiFi network name"
                            />
                            <Text style={styles.help}>{WIFI_SHARE_NO_PREFILL}</Text>

                            <Text style={styles.fieldLabel}>Password</Text>
                            <TextInput
                                style={styles.input}
                                value={password}
                                onChangeText={value => {
                                    setPassword(value);
                                    setError(null);
                                }}
                                placeholder="Leave blank for an open network"
                                placeholderTextColor={theme.colors.textMuted}
                                autoCapitalize="none"
                                autoCorrect={false}
                                // REVEALABLE, and that is a correctness feature
                                // here rather than a convenience: this passphrase
                                // is typed from memory and a single wrong
                                // character presents on the reader as "it will
                                // not join my WiFi", with nothing on either side
                                // able to say why.
                                secureTextEntry={!reveal}
                                accessibilityLabel="WiFi password"
                            />
                            <TouchableOpacity
                                onPress={() => setReveal(value => !value)}
                                accessibilityRole="button"
                                accessibilityLabel={reveal ? 'Hide the password' : 'Show the password'}
                            >
                                <Text style={styles.reveal}>{reveal ? 'Hide password' : 'Show password'}</Text>
                            </TouchableOpacity>

                            {error ? <Text style={styles.error}>{error}</Text> : null}

                            <View style={styles.sheetActions}>
                                <TouchableOpacity
                                    style={styles.secondaryAction}
                                    onPress={closeSheet}
                                    accessibilityRole="button"
                                    accessibilityLabel="Cancel"
                                >
                                    <Text style={styles.secondaryActionText}>Cancel</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={styles.primaryAction}
                                    onPress={save}
                                    disabled={saving}
                                    accessibilityRole="button"
                                    accessibilityLabel="Save the WiFi to hand over"
                                >
                                    <Text style={styles.primaryActionText}>Save</Text>
                                </TouchableOpacity>
                            </View>
                        </ScrollView>
                    </View>
                </View>
            </Modal>
        </View>
    );
}

function createStyles(theme: Theme) {
    return StyleSheet.create({
        card: {
            backgroundColor: theme.colors.surface,
            borderRadius: theme.radii.md,
            borderWidth: 1,
            borderColor: theme.colors.border,
            padding: theme.spacing.lg,
            marginTop: theme.spacing.lg,
        },
        title: {
            ...theme.type.label,
            color: theme.colors.text,
            marginBottom: theme.spacing.xs,
        },
        body: {
            ...theme.type.caption,
            color: theme.colors.textMuted,
        },
        actions: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.sm,
            marginTop: theme.spacing.md,
        },
        primaryAction: {
            backgroundColor: theme.colors.accent,
            borderRadius: theme.radii.sm,
            paddingVertical: theme.spacing.sm,
            paddingHorizontal: theme.spacing.lg,
        },
        primaryActionText: {
            ...theme.type.button,
            color: theme.colors.accentText,
        },
        secondaryAction: {
            borderRadius: theme.radii.sm,
            borderWidth: 1,
            borderColor: theme.colors.border,
            paddingVertical: theme.spacing.sm,
            paddingHorizontal: theme.spacing.lg,
        },
        secondaryActionText: {
            ...theme.type.button,
            color: theme.colors.textMuted,
        },
        backdrop: {
            flex: 1,
            backgroundColor: theme.alpha(theme.colors.shadow, 0.5),
            justifyContent: 'center',
            padding: theme.spacing.lg,
        },
        sheet: {
            backgroundColor: theme.colors.surface,
            borderRadius: theme.radii.md,
            padding: theme.spacing.lg,
            maxHeight: '80%',
        },
        sheetTitle: {
            ...theme.type.h2,
            color: theme.colors.text,
            marginBottom: theme.spacing.md,
        },
        fieldLabel: {
            ...theme.type.label,
            color: theme.colors.text,
            marginTop: theme.spacing.md,
            marginBottom: theme.spacing.xs,
        },
        input: {
            backgroundColor: theme.colors.surface2,
            borderRadius: theme.radii.sm,
            borderWidth: 1,
            borderColor: theme.colors.border,
            color: theme.colors.text,
            paddingHorizontal: theme.spacing.md,
            paddingVertical: theme.spacing.sm,
        },
        help: {
            ...theme.type.caption,
            color: theme.colors.textMuted,
            marginTop: theme.spacing.xs,
        },
        reveal: {
            ...theme.type.caption,
            color: theme.colors.accent,
            marginTop: theme.spacing.xs,
        },
        error: {
            ...theme.type.caption,
            color: theme.colors.danger,
            marginTop: theme.spacing.md,
        },
        sheetActions: {
            flexDirection: 'row',
            justifyContent: 'flex-end',
            gap: theme.spacing.sm,
            marginTop: theme.spacing.xl,
        },
    });
}
