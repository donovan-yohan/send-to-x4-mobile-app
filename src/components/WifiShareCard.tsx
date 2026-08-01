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
 * THE SSID FIELD IS PREFILLABLE, AND THE PERMISSION IS ASKED FOR *HERE*
 * ---------------------------------------------------------------------------
 * Android will not tell an app the name of the network it is on without location
 * permission. This card used to state that as a closed door and leave the field
 * empty; it now offers to open it, from one button, at the only moment where
 * asking is honest — the user is looking at the field and has just been told
 * what the permission is for.
 *
 * THE RULES THIS FLOW OBEYS, all of them visible in `openSheet` and `prefill`
 * below:
 *   - NOTHING IS REQUESTED ON MOUNT, or at app launch, or anywhere else in the
 *     app. Opening the sheet only CHECKS (`checkFineLocationPermission` never
 *     prompts). The system dialog appears on a tap and on nothing else.
 *   - THE EXPLAINER COMES FIRST. `WIFI_PREFILL_NOTE` is on screen before the
 *     button can be pressed, because a system permission dialog with no context
 *     is one people deny by reflex.
 *   - THE FIELD IS EDITABLE IN EVERY STATE. Granted, denied, permanently denied,
 *     not on WiFi, location services off, native module one build behind — every
 *     branch ends at a field the user can type into, and the note says so.
 *   - A PREFILL NEVER CLOBBERS. It fills an empty field; a staged SSID offered
 *     back by `openSheet`, or anything typed, wins over a speculative read.
 * The state machine behind the copy is `describeWifiPrefill` in
 * `services/wifi_ssid`, kept pure so `scripts/wifi-ssid.test.js` pins every cell.
 *
 * There is no password prefill for anyone, ever: no Android API returns a saved
 * PSK to a non-system app. That is why this is typed once, here, instead of
 * being read off the phone.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
    WIFI_SHARE_PREFILL_HELP,
    clearWifiShare,
    describeWifiShare,
    getWifiShare,
    stageWifiShare,
    subscribeWifiShare,
    type WifiShareRecord,
} from '../services/wifi_share';
import {
    checkFineLocationPermission,
    ensureFineLocationPermission,
    type FineLocationState,
} from '../services/android_permissions';
import {
    WIFI_PREFILL_NOTE,
    describeWifiPrefill,
    readCurrentSsid,
    wifiPrefillButtonRequests,
    wifiPrefillHasButton,
    type SsidReadReason,
} from '../services/wifi_ssid';

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

    // Prefill state. `permission` is null until the (non-prompting) check for
    // this opening lands, which is what keeps the sheet from flashing an
    // "allow location" affordance at someone who already granted it.
    const [permission, setPermission] = useState<FineLocationState | null>(null);
    const [readReason, setReadReason] = useState<SsidReadReason | null>(null);
    const [prefilling, setPrefilling] = useState(false);

    // Every opening of the sheet gets a token, and an async result from an
    // earlier one is DROPPED. Without it, a permission dialog answered after the
    // user backed out writes an SSID into the state that `closeSheet` just
    // cleared, and it reappears on the next open as if it had been typed.
    const openToken = useRef(0);

    /**
     * The single value the prefill UI renders from, so that "which note" and
     * "is there a button" cannot drift apart.
     *
     * `null` permission means the check for this opening has not landed yet
     * (roughly one frame). It renders the neutral help line and NO button rather
     * than guessing, because guessing wrong shows an "allow location" prompt to
     * someone who has already allowed it.
     */
    const prefillState = useMemo(
        () => (permission === null ? null : describeWifiPrefill(permission, readReason)),
        [permission, readReason]
    );

    /**
     * The one line under the field, or nothing.
     *
     * `unsupported` is the only state that renders NOTHING: on a platform with
     * no such permission there is no decision to explain, and the generic help
     * line talks about Android. Every other state either has its own note or
     * falls back to the general one, so the field is never bare while the check
     * is in flight.
     */
    const prefillHelp = useMemo(() => {
        if (prefillState === null) return WIFI_SHARE_PREFILL_HELP;
        if (prefillState === 'unsupported') return null;
        return WIFI_PREFILL_NOTE[prefillState] ?? WIFI_SHARE_PREFILL_HELP;
    }, [prefillState]);

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
        setPermission(null);
        setReadReason(null);
        setPrefilling(false);
        setOpen(true);

        // CHECK, NEVER REQUEST. This runs on open, so it must not be able to
        // raise a dialog: `checkFineLocationPermission` is the non-prompting
        // half of the pair. When the grant is already in place from a previous
        // visit the read happens silently here and the user never sees the
        // permission flow at all — which is the whole point of separating the
        // two calls.
        const token = ++openToken.current;
        void (async () => {
            const state = (await checkFineLocationPermission()).state;
            if (openToken.current !== token) return;
            setPermission(state);
            if (state !== 'granted') return;

            const read = await readCurrentSsid();
            if (openToken.current !== token) return;
            setReadReason(read.reason);
            // Fills an EMPTY field only. A staged SSID offered back above, or
            // anything typed while this was in flight, outranks the read.
            if (read.ssid) setSsid(current => (current.trim().length === 0 ? read.ssid! : current));
        })();
    }, [record]);

    const closeSheet = useCallback(() => {
        setOpen(false);
        // Invalidate any in-flight permission/read for this opening.
        openToken.current += 1;
        // Dropped on the way out rather than left in state: a passphrase has no
        // reason to outlive the sheet it was typed into.
        setSsid('');
        setPassword('');
        setReveal(false);
        setError(null);
        setPermission(null);
        setReadReason(null);
        setPrefilling(false);
    }, []);

    /**
     * "Use current network" — THE ONLY PLACE IN THIS APP THAT REQUESTS LOCATION.
     *
     * Requests only when the state says a request is what is missing
     * (`wifiPrefillButtonRequests`); with the grant already held it goes straight
     * to the read, so the app can never fire a system dialog it does not need.
     *
     * Unlike the speculative read in `openSheet`, this DOES overwrite the field:
     * the user asked for it by name.
     */
    const prefill = useCallback(() => {
        // `prefillState === null` is unreachable from the UI (the button does not
        // exist until the check lands) and is a no-op rather than a guess.
        if (prefilling || prefillState === null) return;
        const token = openToken.current;
        setPrefilling(true);
        void (async () => {
            try {
                if (wifiPrefillButtonRequests(prefillState)) {
                    const granted = await ensureFineLocationPermission();
                    if (openToken.current !== token) return;
                    setPermission(granted.state);
                    if (!granted.granted) {
                        // The note for `denied`/`blocked` carries it from here.
                        setReadReason(null);
                        return;
                    }
                }
                const read = await readCurrentSsid();
                if (openToken.current !== token) return;
                setReadReason(read.reason);
                if (read.ssid) {
                    setSsid(read.ssid);
                    setError(null);
                }
            } finally {
                if (openToken.current === token) setPrefilling(false);
            }
        })();
        // `prefillState` is read at call time from the render that owns this
        // handler, which is the state the user was looking at when they tapped.
    }, [prefilling, prefillState]);

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

                            {/* THE EXPLAINER IS ALWAYS ON SCREEN BEFORE THE
                                BUTTON CAN BE PRESSED — that ordering is the
                                consent story, not decoration. Until the
                                permission check for this opening lands there is
                                no button at all and the neutral help line
                                stands in, so nothing ever flickers between two
                                different asks. */}
                            {prefillHelp ? <Text style={styles.help}>{prefillHelp}</Text> : null}
                            {prefillState !== null && wifiPrefillHasButton(prefillState) ? (
                                <TouchableOpacity
                                    onPress={prefill}
                                    disabled={prefilling}
                                    accessibilityRole="button"
                                    accessibilityLabel="Fill in the name of the network this phone is on"
                                >
                                    <Text style={styles.reveal}>
                                        {prefilling ? 'Checking…' : 'Use current network'}
                                    </Text>
                                </TouchableOpacity>
                            ) : null}

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
