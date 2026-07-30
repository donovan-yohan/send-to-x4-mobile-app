/**
 * SettingsScreen — Tab for configuring device connection settings.
 *
 * Full-screen tab replacing the previous modal.
 * Settings auto-save when the user navigates away.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
    View,
    Text,
    TextInput,
    TouchableOpacity,
    StyleSheet,
    ScrollView,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';

import { useConnection } from '../contexts/ConnectionProvider';
import { ActionButton } from '../components/ActionButton';
import { SegmentedControl } from '../components/SegmentedControl';
import { StatusIndicator } from '../components/StatusIndicator';
import { useTabBarInset, useTheme, type Theme } from '../theme';
import { getDefaultIp } from '../services/settings';
import { fetchMailboxStatus } from '../services/mailbox_client';
import { provisionReaderSync, validateReaderSyncUrl } from '../services/reader_provision';
import type { Role, Settings } from '../types';
import Constants from 'expo-constants';

/**
 * The mailbox WRITE TOKEN lives in settings alongside `mailboxUrl`, but it is
 * deliberately NOT part of the URL: `mailboxUrl` is the exact string handed to
 * the reader (which sends no auth headers at all — its reads are protected only
 * by the unguessable path), so folding the bearer token into it would ship the
 * app's write credential onto the device and into every reader-side log.
 *
 * Typed locally as an intersection rather than assumed on `Settings` so this
 * screen compiles whether or not the field has been declared in `src/types`
 * yet — the persistence layer carries unknown keys through untouched by
 * contract (see the PERSISTENCE CONTRACT note on `Settings`).
 */
type MailboxSettings = Settings & { mailboxWriteToken?: string };

/**
 * Read the write token out of an unversioned, hand-editable settings blob.
 *
 * `normalizeSettings` has no coercion for this key while it lives outside the
 * declared `Settings` shape, so a blob holding a number or null would otherwise
 * reach `.trim()` in handleSave and throw inside a save the user cannot retry.
 */
function readMailboxWriteToken(settings: Settings): string {
    const value = (settings as MailboxSettings).mailboxWriteToken;
    return typeof value === 'string' ? value : '';
}

/** Outcome of one long-running Mailbox/Reader action, rendered inline. */
interface ActionState {
    busy: boolean;
    ok?: boolean;
    message?: string;
}

const IDLE: ActionState = { busy: false };

/** Host/Client, for the shared segmented picker. */
const ROLE_OPTIONS: ReadonlyArray<{ value: Role; label: string }> = [
    { value: 'host', label: 'Host' },
    { value: 'client', label: 'Client' },
];

/**
 * Which text field has focus, or null.
 *
 * Only exists to draw the accent focus ring the fields previously lacked — no
 * value, no validation, no persistence hangs off it.
 */
type FocusableField =
    | 'pairingSecret'
    | 'mailboxUrl'
    | 'mailboxWriteToken'
    | 'crossPointIp'
    | 'readerApPsk';

export function SettingsScreen() {
    const navigation = useNavigation<any>();
    const route = useRoute();
    const { settings, connectionStatus, saveSettings, checkConnection } = useConnection();
    const theme = useTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);

    // This component is registered twice: as the 'SettingsTab' bottom tab and as
    // the 'Settings' modal Stack route (ConnectionBanner's gear icon targets the
    // latter by name). goBack() is only meaningful for the modal — pressed on the
    // tab it hits the TabRouter, whose default backBehavior is 'firstRoute', so
    // the ✕ silently jumps the user to Compose instead of closing anything.
    // canGoBack() cannot tell the two apart (it is true on any tab with index !== 0),
    // so gate on the route name instead.
    const isModal = route.name === 'Settings';

    // Same split for the bottom padding: the floating tab pill overlays the tab
    // copy of this screen and reserves no layout space, but the modal copy is
    // presented over the navigator with no tab bar at all, so it must not pay
    // for clearance it does not need. See src/theme/tabBar.ts.
    const tabBarInset = useTabBarInset();

    const [localRole, setLocalRole] = useState<Role>(settings.role);
    const [localPairingSecret, setLocalPairingSecret] = useState(settings.pairingSecret ?? '');
    const [localMailboxUrl, setLocalMailboxUrl] = useState(settings.mailboxUrl ?? '');
    const [localMailboxWriteToken, setLocalMailboxWriteToken] = useState(
        readMailboxWriteToken(settings)
    );
    const [localCrossPointIp, setLocalCrossPointIp] = useState(settings.crossPointIp);
    // Reader-AP passphrase for the M3 peer link. '' is legitimate — the firmware's
    // AP is open today — so this field has no validation and no default.
    const [localReaderApPsk, setLocalReaderApPsk] = useState(settings.readerApPsk ?? '');
    const [hasChanges, setHasChanges] = useState(false);
    const [mailboxTest, setMailboxTest] = useState<ActionState>(IDLE);
    const [readerSync, setReaderSync] = useState<ActionState>(IDLE);
    const [focused, setFocused] = useState<FocusableField | null>(null);

    /** `[baseStyle, focusRingIfThisFieldHasFocus]` for a TextInput. */
    const fieldStyle = useCallback(
        (field: FocusableField) => [styles.ipInput, focused === field && styles.ipInputFocused],
        [styles, focused]
    );
    const focusProps = useCallback(
        (field: FocusableField) => ({
            onFocus: () => setFocused(field),
            onBlur: () => setFocused(prev => (prev === field ? null : prev)),
        }),
        []
    );

    // Both actions below are network round-trips the user can navigate away from
    // (this component is also mounted as a modal). Without this guard their
    // setState lands on an unmounted tree.
    const mountedRef = useRef(true);
    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    // Sync when settings change externally
    useEffect(() => {
        setLocalRole(settings.role);
        setLocalPairingSecret(settings.pairingSecret ?? '');
        setLocalMailboxUrl(settings.mailboxUrl ?? '');
        setLocalMailboxWriteToken(readMailboxWriteToken(settings));
        setLocalCrossPointIp(settings.crossPointIp);
        setLocalReaderApPsk(settings.readerApPsk ?? '');
        setHasChanges(false);
    }, [settings]);

    const handleRoleChange = (role: Role) => {
        setLocalRole(role);
        setHasChanges(true);
    };

    const handleIpChange = (ip: string) => {
        setLocalCrossPointIp(ip);
        setHasChanges(true);
    };

    const handleSave = useCallback(async () => {
        // SPREAD `settings` FIRST, then override only the five fields this screen
        // actually owns. `saveSettings` takes a whole Settings object, so the
        // previous hand-enumerated literal had to re-list every unrelated key —
        // which is how a field silently reverted to its loaded-or-default value
        // whenever one was added to Settings and not copied in here. The legacy
        // article/notes/wallpaper-filter keys no longer have any control on this
        // screen; the spread carries them (and any unknown key from an older
        // install) through untouched, which is exactly what the unversioned,
        // no-migration blob needs (R8).
        //
        // Still a typed const rather than an inline literal so the extra
        // `mailboxWriteToken` key is not stripped by excess-property checking
        // before it reaches the (spread-preserving) persistence layer.
        const next: MailboxSettings = {
            ...settings,
            role: localRole,
            // Trim only — the pairing task owns validation.
            pairingSecret: localPairingSecret.trim(),
            mailboxUrl: localMailboxUrl.trim(),
            mailboxWriteToken: localMailboxWriteToken.trim(),
            crossPointIp: localCrossPointIp,
            // normalizeSettings trims this too; doing it here as well keeps the
            // saved value identical to what the next load will hand back, so
            // `hasChanges` cannot latch on a whitespace-only difference.
            readerApPsk: localReaderApPsk.trim(),
        };
        await saveSettings(next);
        setHasChanges(false);
    }, [localRole, localPairingSecret, localMailboxUrl, localMailboxWriteToken, localCrossPointIp, localReaderApPsk, settings, saveSettings]);

    const handleResetIp = () => {
        handleIpChange(getDefaultIp());
    };

    /**
     * Live warning under the Mailbox URL field.
     *
     * The reader stores `messageSyncUrl` in a fixed `char[128]` and TRUNCATES a
     * longer value while still answering 200, so an over-long capability URL is
     * a permanent, silent failure with no symptom on either side. Showing it
     * here is the earliest point the user can act on it — long before the
     * provisioning round-trip.
     */
    const mailboxUrlWarning = (() => {
        const trimmed = localMailboxUrl.trim();
        if (!trimmed) return null;                      // not an error, just unset
        // Do not shout "must start with http://" at someone who has typed "ht".
        // Only these exact prefixes are suppressed, so a genuinely scheme-less
        // host ("mailbox.example.com/m/x") is still flagged immediately.
        if (/^h(t(t(p(s?(:(\/?)?)?)?)?)?)?$/i.test(trimmed)) return null;
        const check = validateReaderSyncUrl(trimmed);
        return check.ok ? null : check.error;
    })();

    /**
     * Persist first, then act.
     *
     * Both actions below reach the network with the values in the input boxes.
     * If those were only in local state, "Set up reader sync" could write a URL
     * into the READER that the app itself never saved — the two would disagree
     * and nothing would say so.
     */
    const saveThen = useCallback(
        async <T,>(action: () => Promise<T>): Promise<T> => {
            if (hasChanges) await handleSave();
            return action();
        },
        [hasChanges, handleSave]
    );

    const handleTestMailbox = useCallback(async () => {
        setMailboxTest({ busy: true, message: 'Contacting mailbox…' });
        try {
            const result = await saveThen(() =>
                fetchMailboxStatus(localMailboxUrl.trim(), localMailboxWriteToken.trim())
            );
            if (!mountedRef.current) return;

            if (!result.success) {
                setMailboxTest({ busy: false, ok: false, message: result.error ?? 'Mailbox test failed.' });
                return;
            }

            const status = result.status;
            const latest = status?.latestId;
            setMailboxTest({
                busy: false,
                ok: true,
                message: latest
                    ? `Mailbox reachable. Latest note: ${latest}` +
                      (status?.bytes != null ? ` (${status.bytes} bytes)` : '')
                    : 'Mailbox reachable. No note published yet.',
            });
        } catch (error) {
            // fetchMailboxStatus documents NEVER THROWS; this only exists so a
            // contract change cannot turn Settings into a red box.
            if (!mountedRef.current) return;
            setMailboxTest({ busy: false, ok: false, message: `Mailbox test failed: ${String(error)}` });
        }
    }, [saveThen, localMailboxUrl, localMailboxWriteToken]);

    const handleProvisionReader = useCallback(async () => {
        setReaderSync({ busy: true, message: 'Writing settings to the reader…' });
        try {
            const result = await saveThen(() =>
                provisionReaderSync(localCrossPointIp, localMailboxUrl.trim())
            );
            if (!mountedRef.current) return;

            if (!result.ok) {
                setReaderSync({ busy: false, ok: false, message: result.error ?? 'Reader sync setup failed.' });
                return;
            }
            setReaderSync({
                busy: false,
                ok: true,
                message:
                    'Reader will now pull notes at sleep. Verified on device: ' +
                    `${result.verified?.messageSyncUrl ?? ''}`,
            });
        } catch (error) {
            if (!mountedRef.current) return;
            setReaderSync({ busy: false, ok: false, message: `Reader sync setup failed: ${String(error)}` });
        }
    }, [saveThen, localCrossPointIp, localMailboxUrl]);

    const canTestMailbox =
        !mailboxTest.busy && localMailboxUrl.trim().length > 0 && localMailboxWriteToken.trim().length > 0;
    // The reader write is HOST-only by role: a client has no direct reader
    // access at all, and the reader's permanent state is the host's to own.
    const canProvisionReader =
        !readerSync.busy && localRole === 'host' && localMailboxUrl.trim().length > 0;

    return (
        <View style={styles.container}>
            <ScrollView
                style={styles.content}
                contentContainerStyle={[
                    styles.contentContainer,
                    isModal ? null : { paddingBottom: tabBarInset },
                ]}
                keyboardShouldPersistTaps="handled"
            >
                <View style={styles.header}>
                    <Text style={styles.headerTitle}>Settings</Text>
                    {isModal && (
                        <TouchableOpacity
                            style={styles.closeButton}
                            onPress={() => navigation.goBack()}
                            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                        >
                            <Text style={styles.closeButtonText}>✕</Text>
                        </TouchableOpacity>
                    )}
                </View>

                {/* Connection Status */}
                <View style={styles.statusSection}>
                    <StatusIndicator
                        status={connectionStatus}
                        onRetry={checkConnection}
                    />
                </View>

                {/* Role — replaces the old Firmware Type picker. Host sees the
                    Wallpaper and Device tabs; client only composes messages. */}
                <Text style={styles.sectionTitle}>This Device</Text>
                <SegmentedControl
                    options={ROLE_OPTIONS}
                    value={localRole}
                    onChange={handleRoleChange}
                />
                <Text style={styles.helpText}>
                    {localRole === 'host'
                        ? 'Host: paired with the reader over WiFi. Owns wallpaper and device files, and relays incoming messages.'
                        : 'Client: no direct reader access. Messages are sent through the mailbox.'}
                </Text>

                {/* Pairing */}
                <Text style={styles.sectionTitle}>Pairing</Text>

                <Text style={styles.fieldLabel}>Pairing Secret</Text>
                <TextInput
                    style={fieldStyle('pairingSecret')}
                    {...focusProps('pairingSecret')}
                    value={localPairingSecret}
                    onChangeText={(v) => { setLocalPairingSecret(v); setHasChanges(true); }}
                    placeholder="Shared secret from the host"
                    placeholderTextColor={theme.colors.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    secureTextEntry
                />

                {/* Mailbox — the reader's pull endpoint, plus the app's write
                    credential for it. These two are stored separately ON PURPOSE:
                    only the URL is ever written to the reader. */}
                <Text style={styles.sectionTitle}>Mailbox</Text>

                <Text style={styles.fieldLabel}>Mailbox URL</Text>
                <TextInput
                    style={fieldStyle('mailboxUrl')}
                    {...focusProps('mailboxUrl')}
                    value={localMailboxUrl}
                    onChangeText={(v) => { setLocalMailboxUrl(v); setHasChanges(true); }}
                    placeholder="https://mailbox.example.com/m/<box-id>"
                    placeholderTextColor={theme.colors.textMuted}
                    keyboardType="url"
                    autoCapitalize="none"
                    autoCorrect={false}
                />
                {mailboxUrlWarning ? (
                    <Text style={styles.warningText}>{mailboxUrlWarning}</Text>
                ) : (
                    <Text style={styles.helpText}>
                        Base URL the reader pulls from. Clients publish here; the reader GETs
                        /latest.txt and /current.frame under it.
                    </Text>
                )}

                <Text style={styles.fieldLabel}>Mailbox Write Token</Text>
                <TextInput
                    style={fieldStyle('mailboxWriteToken')}
                    {...focusProps('mailboxWriteToken')}
                    value={localMailboxWriteToken}
                    onChangeText={(v) => { setLocalMailboxWriteToken(v); setHasChanges(true); }}
                    placeholder="Bearer token issued with the mailbox"
                    placeholderTextColor={theme.colors.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    secureTextEntry
                />
                <Text style={styles.helpText}>
                    Sent as an Authorization header when publishing. Never written to the reader —
                    the reader's reads are protected by the unguessable URL alone.
                </Text>

                <ActionButton
                    title="Test mailbox"
                    variant="secondary"
                    style={styles.secondaryAction}
                    onPress={() => void handleTestMailbox()}
                    loading={mailboxTest.busy}
                    disabled={!canTestMailbox}
                />
                {mailboxTest.message ? (
                    <Text
                        style={[
                            styles.resultText,
                            mailboxTest.ok === true && styles.resultTextOk,
                            mailboxTest.ok === false && styles.resultTextError,
                        ]}
                    >
                        {mailboxTest.message}
                    </Text>
                ) : null}

                {/* Host-only: writes messageSyncEnabled + messageSyncUrl into the
                    reader over its WiFi-transfer web server. A client never
                    touches the reader's permanent state. */}
                {localRole === 'host' && (
                    <>
                        <ActionButton
                            title="Set up reader sync"
                            variant="secondary"
                            style={styles.secondaryAction}
                            onPress={() => void handleProvisionReader()}
                            loading={readerSync.busy}
                            disabled={!canProvisionReader}
                        />
                        {readerSync.message ? (
                            <Text
                                style={[
                                    styles.resultText,
                                    readerSync.ok === true && styles.resultTextOk,
                                    readerSync.ok === false && styles.resultTextError,
                                ]}
                            >
                                {readerSync.message}
                            </Text>
                        ) : null}
                        <Text style={styles.helpText}>
                            Points the reader at this mailbox and turns on sleep-time sync. The
                            reader must be awake and in WiFi transfer mode.
                        </Text>
                    </>
                )}

                {/* Device Host/IP */}
                <Text style={styles.sectionTitle}>Device Host or IP</Text>
                <View style={styles.inputRow}>
                    <TextInput
                        style={fieldStyle('crossPointIp')}
                        {...focusProps('crossPointIp')}
                        value={localCrossPointIp}
                        onChangeText={handleIpChange}
                        placeholder="crosspoint.local or 192.168.x.x"
                        placeholderTextColor={theme.colors.textMuted}
                        keyboardType="default"
                        autoCapitalize="none"
                        autoCorrect={false}
                    />
                    <TouchableOpacity style={styles.resetButton} onPress={handleResetIp}>
                        <Text style={styles.resetButtonText}>Reset</Text>
                    </TouchableOpacity>
                </View>
                <Text style={styles.helpText}>
                    Default: {getDefaultIp()} · reader AP: {settings.apSsid}
                </Text>

                {/* Reader AP password — the M3 peer link.
                    Lives in the DEVICE section, not Pairing or Mailbox: it is a
                    property of this reader's own access point, the same way the
                    host/IP above is a property of this reader on the LAN. It is
                    never written to the reader and never travels in a URL; it
                    goes only into the platform's Wi-Fi join request.
                    BLANK IS VALID and is the shipping state — the firmware's
                    AP_PASSWORD is a compile-time nullptr, so the AP is open. */}
                <Text style={styles.fieldLabel}>Reader AP password</Text>
                <TextInput
                    style={fieldStyle('readerApPsk')}
                    {...focusProps('readerApPsk')}
                    value={localReaderApPsk}
                    onChangeText={(v) => { setLocalReaderApPsk(v); setHasChanges(true); }}
                    placeholder="Leave blank if the reader's WiFi is open"
                    placeholderTextColor={theme.colors.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    secureTextEntry
                />
                <Text style={styles.helpText}>
                    Used when "Sync with reader" joins {settings.apSsid} directly, so the reader
                    can pull from the mailbox through this phone's data. Shown on the reader's
                    Sync screen.
                </Text>

                {/* Device Host is the LAST configurable section. Two more used to
                    sit here and are deliberately gone:
                      · 'Wallpaper Filters' (Hide AI / Hide sensitive content) —
                        the lowio wallpaper gallery they filtered was deleted, so
                        both switches moved a flag nothing read.
                      · 'Storage Folders' (Article Folder / Notes Folder / Organize
                        by date) — pointed at the article pipeline this fork
                        deleted. Every path the messenger writes is fixed by the
                        firmware and owned as a constant by its sender.
                    Their KEYS still ride along in the persisted blob on purpose;
                    see the LEGACY block in services/settings.ts. Do not add a
                    control back here without a consumer to go with it. */}

                {/* Save Button */}
                {hasChanges && (
                    <ActionButton
                        title="Save changes"
                        variant="primary"
                        style={styles.saveButton}
                        onPress={() => void handleSave()}
                    />
                )}

                {/* Help */}
                <View style={styles.helpSection}>
                    <Text style={styles.sectionTitle}>Help</Text>
                    <Text style={styles.descriptionText}>
                        To transfer files directly, your phone must be on the reader's WiFi hotspot ({settings.apSsid}) or the same local network.
                    </Text>
                </View>

                {/* About */}
                <View style={styles.aboutSection}>
                    <Text style={styles.sectionTitle}>About</Text>
                    <Text style={styles.aboutText}>
                        Version {Constants.expoConfig?.version ?? 'Unknown'}
                    </Text>
                </View>
            </ScrollView>
        </View>
    );
}

function createStyles(theme: Theme) {
    return StyleSheet.create({
        container: {
            flex: 1,
            backgroundColor: theme.colors.bg,
        },
        content: {
            flex: 1,
        },
        contentContainer: {
            padding: theme.spacing.xl,
            // This is the MODAL presentation's bottom padding. The tab
            // presentation overrides it at the call site with useTabBarInset(),
            // which has to clear the floating pill.
            paddingBottom: 40,
        },
        header: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: theme.spacing.xl,
        },
        headerTitle: {
            ...theme.type.h1,
            fontFamily: theme.fonts.display,
            color: theme.colors.text,
        },
        closeButton: {
            paddingVertical: theme.spacing.sm,
            paddingHorizontal: theme.spacing.md,
            borderRadius: theme.radii.pill,
            backgroundColor: theme.colors.surface2,
        },
        closeButtonText: {
            ...theme.type.label,
            fontWeight: '700',
            color: theme.colors.text,
        },
        statusSection: {
            marginBottom: theme.spacing.sm,
        },
        sectionTitle: {
            // Functional groupings, kept VERBATIM as copy; only the styling loses
            // its dashboard treatment.
            ...theme.type.h2,
            color: theme.colors.text,
            marginBottom: theme.spacing.md,
            marginTop: theme.spacing.xxl,
        },
        inputRow: {
            flexDirection: 'row',
            alignItems: 'center',
        },
        ipInput: {
            // TECHNICAL FIELDS STAY TECHNICAL: system font, no display serif, no
            // "cute" treatment on values the user has to verify character by
            // character (URLs, bearer tokens, hostnames).
            flex: 1,
            backgroundColor: theme.colors.surface2,
            borderRadius: theme.radii.sm,
            padding: theme.spacing.lg,
            color: theme.colors.text,
            fontSize: 16,
            borderWidth: 1,
            borderColor: theme.colors.border,
        },
        /**
         * Focus ring — new, and pure presentation.
         *
         * Same 1px border WIDTH as the resting state deliberately: bumping it to
         * 1.5 would re-layout the field's content box on every focus and shift the
         * caret by half a pixel. The accent hue is the whole cue.
         */
        ipInputFocused: {
            borderColor: theme.colors.accent,
        },
        resetButton: {
            marginLeft: theme.spacing.md,
            paddingVertical: theme.spacing.lg,
            paddingHorizontal: theme.spacing.lg,
            backgroundColor: 'transparent',
            borderWidth: 1,
            borderColor: theme.colors.border,
            borderRadius: theme.radii.lg,
        },
        resetButtonText: {
            ...theme.type.label,
            color: theme.colors.textMuted,
        },
        helpText: {
            ...theme.type.caption,
            color: theme.colors.textMuted,
            marginTop: theme.spacing.sm,
        },
        warningText: {
            ...theme.type.caption,
            color: theme.colors.danger,
            marginTop: theme.spacing.sm,
        },
        /** Spacing for the two ActionButton `secondary` actions. */
        secondaryAction: {
            marginTop: theme.spacing.lg,
        },
        resultText: {
            // Carries `result.error` and the verified reader URL verbatim.
            ...theme.type.caption,
            color: theme.colors.textMuted,
            marginTop: theme.spacing.sm,
            lineHeight: 17,
        },
        resultTextOk: {
            color: theme.colors.success,
        },
        resultTextError: {
            color: theme.colors.danger,
        },
        saveButton: {
            marginTop: theme.spacing.xl,
        },
        helpSection: {
            marginTop: theme.spacing.xxl,
        },
        descriptionText: {
            ...theme.type.body,
            color: theme.colors.textMuted,
        },
        aboutSection: {
            marginTop: 40,
            paddingTop: theme.spacing.xxl,
            borderTopWidth: 1,
            borderTopColor: theme.colors.border,
        },
        aboutText: {
            ...theme.type.body,
            color: theme.colors.textMuted,
            marginBottom: theme.spacing.sm,
        },
        fieldLabel: {
            ...theme.type.label,
            color: theme.colors.textMuted,
            marginBottom: theme.spacing.sm,
            marginTop: theme.spacing.md,
        },
    });
}
