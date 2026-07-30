/**
 * ConnectionBanner — top bar that appears ONLY when the app has something the
 * user actually has to act on.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A PERSISTENT "DISCONNECTED" BANNER ANY MORE
 * ---------------------------------------------------------------------------
 * The reader sleeps with its radio off almost all of the time, and the phone is
 * often nowhere near it — so "can't reach the reader" is the NORMAL, expected
 * state of this app, and the mailbox exists precisely to cover it. A permanent
 * error strip across every tab described the default state as a failure, for a
 * condition the user cannot and need not act on.
 *
 * So the banner now renders NOTHING while a delivery route exists. It speaks up
 * in exactly one failure case: NO ROUTE AT ALL, i.e. a composed note has nowhere
 * to go. That IS actionable, and the copy points at the one place that fixes it
 * (Settings).
 *
 * "A route exists" is no longer this component's own opinion. It asks
 * `useDeliverability`, which counts all three roads — direct, mailbox AND a
 * saved reader-AP passphrase (Sync-with-reader). The mailbox-only version of
 * this test used to shout at a phone that was perfectly capable of handing its
 * outbox over at the next sync. Same truth table, one more true cell.
 *
 * Compose's route chip names the road in the normal "asleep reader" case, and
 * Settings' connection card keeps showing plain connection state — neither needs
 * a global banner repeating it.
 *
 * Device + Wallpaper genuinely require a DIRECT connection (there is no mailbox
 * route for a file browser). They keep their own inline disabled states; this
 * module exports {@link useDirectConnectionRequired} so they can share one
 * source of truth for "is direct access available, and if not, why" instead of
 * re-deriving it per screen.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TINT IS FLATTENED INSTEAD OF USED AS AN rgba FILL
 * ---------------------------------------------------------------------------
 * `theme.tints.*` are translucent (`rgba(...)`), and a translucent background
 * resolves against WHATEVER OPAQUE SURFACE HAPPENS TO BE BEHIND IT — not
 * against `theme.colors.bg`. That is a real hazard here: Android's
 * `windowBackground` is `@color/activityBackground` = `#F6EEDF` (warm cream) and
 * `android/app/src/main/res/values-night/colors.xml` is empty, so there is a
 * LIGHT surface underneath the whole app in dark mode. Any gap in the opaque JS
 * chain and the dark danger tint composited over cream instead of over
 * `#231714`, producing `#F4DDCF` — a pale pink strip in dark mode, with the dark
 * salmon `danger` text at 2.02:1 (WCAG fail).
 *
 * `flattenTint` removes the dependency entirely: the tint is composited against
 * the ACTIVE scheme's `bg` here, in JS, and the banner paints an OPAQUE color.
 * It cannot pick up a light backdrop no matter what is behind it. Measured
 * (WCAG relative luminance) on the resulting fills:
 *
 *   dark  error  #432824 : danger 5.08:1, text 10.72:1, textMuted 5.28:1
 *   light error  #EBD9CA : danger 5.04:1, text  9.96:1, textMuted 4.77:1
 *   dark  ok     #363529 : success 5.87:1, textMuted 4.88:1
 *   light ok     #DEDDCA : success 4.53:1, textMuted 4.77:1
 *   checking (opaque surface2) : textMuted 5.40:1 dark / 5.03:1 light
 */

import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useConnection } from '../contexts/ConnectionProvider';
import { useDeliverability } from '../services/useDeliverability';
import { useTheme, type Theme } from '../theme';
import { SettingsIcon } from './icons';

/** Matches the old inline `fontSize: 20` gear the SVG replaces. */
const SETTINGS_ICON_SIZE = 20;

/** The one banner message left. Short, warm, and it names the fix. */
const NO_ROUTE_MESSAGE = 'Notes have nowhere to go yet.';

/**
 * Composite a translucent `rgba(r,g,b,a)` tint onto an opaque hex background.
 *
 * This is the same math the compositor would do, done eagerly so the result is
 * an OPAQUE color pinned to the active scheme's `bg` (see the header note — a
 * light surface really is sitting behind this app in dark mode). Anything that
 * is not an `rgba()` string is already opaque and passes through untouched.
 */
function flattenTint(tint: string, overHex: string): string {
    const parts = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(tint);
    if (!parts) return tint;

    const alpha = parts[4] === undefined ? 1 : Math.max(0, Math.min(1, Number(parts[4])));
    const hex = overHex.replace('#', '');
    const expanded = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex.slice(0, 6);
    const base = parseInt(expanded, 16);
    if (expanded.length !== 6 || Number.isNaN(base)) return tint;

    const src = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
    const dst = [(base >> 16) & 255, (base >> 8) & 255, base & 255];
    const channel = (i: number) => {
        const v = Math.round(src[i] * alpha + dst[i] * (1 - alpha));
        return Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0');
    };
    return `#${channel(0)}${channel(1)}${channel(2)}`;
}

/**
 * The one caption a direct-only surface is allowed to render when it is off.
 *
 * Two words, no colour, no call to action. The reader sleeping with its radio
 * off is the DEFAULT state of this product, not an incident, and the screen has
 * already said everything actionable by greying the control out. The paragraph
 * this replaced ("This needs a direct connection to the reader — wake it and
 * join its Wi-Fi") explained a precondition the user cannot satisfy on demand
 * and had already met or not.
 */
export const READER_ASLEEP_CAPTION = 'Reader asleep';

/** What a direct-connection-only surface needs to know. */
export interface DirectConnectionRequirement {
    /** True when the reader answered the last probe — direct-only features work. */
    available: boolean;
    /**
     * The STRICT reading: the reader answered AND that answer is still inside
     * `reader_reachability`'s freshness window.
     *
     * NOT what `available` is built on, on purpose — see the hook. Exposed so a
     * surface whose action is expensive or destructive can opt into the stricter
     * test without re-deriving it.
     */
    directNow: boolean;
    /** True while a probe is in flight. */
    checking: boolean;
    // NO `reason` FIELD. It returned `available ? null : READER_ASLEEP_CAPTION`
    // and not one of the three call sites ever read it — Device, Wallpaper and
    // History each import {@link READER_ASLEEP_CAPTION} and render it directly,
    // which is the same one wording from the same one constant. A field that
    // only a comment claims is load-bearing is worse than no field: it reads as
    // a wired-up affordance to the next person to touch this hook.
    /** The transport's own last message, VERBATIM, or undefined. */
    lastError?: string;
    /** Re-probe now. Intended for a user-initiated control only. */
    recheck: () => void;
}

/**
 * Shared truth for the Device/Wallpaper class of screen: features that talk to
 * the reader's HTTP API directly and have no mailbox fallback.
 *
 * ---------------------------------------------------------------------------
 * WHY `available` IS THE UN-DECAYED `connected`, NOT `directNow`
 * ---------------------------------------------------------------------------
 * `directNow` is `connected` AND-ed with a 30 SECOND freshness window, and
 * `useDeliverability` holds no timer — it recomputes on settings changes, app
 * foreground and user-driven re-checks, and nothing else. Gating the file
 * browser on it would therefore grey out every folder, every delete and the
 * wallpaper upload roughly half a minute after each probe, on a reader that is
 * sitting there awake and answering, and un-grey them on the next foreground.
 * That is a control flickering on the CLOCK rather than on the world — strictly
 * worse than the state it replaced.
 *
 * Freshness earns its keep in the ROUTING decision, where a stale observation
 * must not be allowed to promise 'direct'; it does not earn its keep in an
 * enable/disable gate, where the failure mode of being wrong is one honest error
 * message from a request the user chose to make.
 *
 * The right fix, if a surface ever needs decay here, is periodic re-probing in
 * ConnectionProvider so the whole app decays together. Until that exists,
 * `directNow` is offered alongside rather than substituted in.
 */
export function useDirectConnectionRequired(): DirectConnectionRequirement {
    const { connectionStatus, checkConnection } = useConnection();
    const { directNow } = useDeliverability();

    return useMemo(
        () => ({
            available: connectionStatus.connected,
            directNow,
            checking: connectionStatus.checking,
            lastError: connectionStatus.lastError,
            recheck: () => {
                void checkConnection();
            },
        }),
        [connectionStatus, directNow, checkConnection]
    );
}

export function ConnectionBanner() {
    const { connectionStatus, checkConnection } = useConnection();
    const { anyRoute } = useDeliverability();
    const navigation = useNavigation<any>();
    const theme = useTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);

    /**
     * `connectionStatus.checking` is true for EVERY probe — mount, app
     * foreground, and after any settings save. Surfacing all of those made a
     * "Checking connection…" bar flash across the top of the app on every
     * return to it. Only an explicit tap on this banner sets this flag, so only
     * an explicit tap gets a spinner.
     */
    const [retryRequested, setRetryRequested] = useState(false);

    const handleRetry = useCallback(() => {
        setRetryRequested(true);
        void Promise.resolve(checkConnection()).finally(() => setRetryRequested(false));
    }, [checkConnection]);

    const openSettings = useCallback(() => {
        navigation.navigate('Settings');
    }, [navigation]);

    const settingsButton = (
        <TouchableOpacity
            onPress={openSettings}
            style={styles.settingsIcon}
            accessibilityRole="button"
            accessibilityLabel="Settings"
        >
            <SettingsIcon size={SETTINGS_ICON_SIZE} color={theme.colors.textMuted} />
        </TouchableOpacity>
    );

    // 1. A probe the USER asked for. Checked first: `checking` keeps the
    //    previous `connected` value, so this must win over the connected branch.
    if (connectionStatus.checking && retryRequested) {
        return (
            <View style={[styles.banner, styles.checkingBanner]}>
                {settingsButton}
                <View style={styles.contentWrap}>
                    <ActivityIndicator
                        size="small"
                        color={theme.colors.accent}
                        style={{ marginRight: theme.spacing.sm }}
                    />
                    <Text style={styles.checkingText}>Checking connection…</Text>
                </View>
            </View>
        );
    }

    // 2. Reachable. Worth saying, because it is the RARE state and it unlocks
    //    the direct-only tabs.
    if (connectionStatus.connected) {
        return (
            <View style={[styles.banner, styles.connectedBanner]}>
                {settingsButton}
                <TouchableOpacity
                    style={styles.contentWrap}
                    onPress={handleRetry}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel="Re-check reader connection"
                >
                    <View style={styles.dotConnected} />
                    <Text style={styles.connectedText}>
                        Connected to reader ({connectionStatus.ip})
                    </Text>
                    <Text style={styles.connectedHint}>Tap to refresh</Text>
                </TouchableOpacity>
            </View>
        );
    }

    // 3. Unreachable but SOME road exists — mailbox, or a saved AP passphrase to
    //    hand the outbox over at the next sync. The normal, covered state.
    //    Silence. Compose's route chip already names which road.
    if (anyRoute) return null;

    // 4. Unreachable and NO route at all: a composed note has nowhere to go.
    //    The only genuinely actionable state, and the only one that earns a tint.
    return (
        <View style={[styles.banner, styles.noRouteBanner]}>
            {settingsButton}
            <TouchableOpacity
                style={styles.contentColumn}
                onPress={handleRetry}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Retry reader connection"
            >
                <View style={styles.leadRow}>
                    <View style={styles.dotDisconnected} />
                    <Text style={styles.noRouteText} numberOfLines={2}>
                        {NO_ROUTE_MESSAGE}
                    </Text>
                </View>
                <View style={styles.actionRow}>
                    <Text style={styles.retryHint}>Tap to retry</Text>
                    <Text style={styles.actionDivider}>·</Text>
                    <TouchableOpacity
                        onPress={openSettings}
                        accessibilityRole="button"
                        accessibilityLabel="Set up a mailbox in Settings"
                    >
                        <Text style={styles.setupLink}>Set up a mailbox</Text>
                    </TouchableOpacity>
                </View>
                {/* VERBATIM. The transport's own message, url and all. */}
                {connectionStatus.lastError ? (
                    <Text style={styles.errorDetail} numberOfLines={2} ellipsizeMode="tail">
                        {connectionStatus.lastError}
                    </Text>
                ) : null}
            </TouchableOpacity>
        </View>
    );
}

function createStyles(theme: Theme) {
    // Flattened HERE, once per theme, so every state below paints an opaque
    // color pinned to the ACTIVE scheme's bg. See the header note.
    const dangerFill = flattenTint(theme.tints.danger, theme.colors.bg);
    const successFill = flattenTint(theme.tints.success, theme.colors.bg);

    return StyleSheet.create({
        banner: {
            flexDirection: 'row',
            alignItems: 'center',
            paddingVertical: theme.spacing.sm,
            paddingHorizontal: theme.spacing.lg,
        },
        settingsIcon: {
            marginRight: theme.spacing.md,
            justifyContent: 'center',
        },
        contentWrap: {
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
        },
        contentColumn: {
            flex: 1,
        },
        leadRow: {
            flexDirection: 'row',
            alignItems: 'center',
        },
        actionRow: {
            flexDirection: 'row',
            alignItems: 'center',
            marginTop: 2,
        },
        checkingBanner: {
            backgroundColor: theme.colors.surface2,
        },
        connectedBanner: {
            backgroundColor: successFill,
        },
        noRouteBanner: {
            backgroundColor: dangerFill,
        },
        dotConnected: {
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: theme.colors.success,
            marginRight: theme.spacing.sm,
        },
        dotDisconnected: {
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: theme.colors.danger,
            marginRight: theme.spacing.sm,
        },
        connectedText: {
            ...theme.type.caption,
            color: theme.colors.success,
        },
        noRouteText: {
            ...theme.type.caption,
            color: theme.colors.danger,
            flex: 1,
        },
        checkingText: {
            ...theme.type.caption,
            fontWeight: '400',
            color: theme.colors.textMuted,
            flex: 1,
        },
        connectedHint: {
            fontSize: 11,
            lineHeight: 15,
            color: theme.colors.textMuted,
        },
        retryHint: {
            fontSize: 11,
            lineHeight: 15,
            color: theme.colors.textMuted,
        },
        actionDivider: {
            fontSize: 11,
            lineHeight: 15,
            color: theme.colors.textMuted,
            marginHorizontal: theme.spacing.xs,
        },
        // `text`, not `accent`: accent on a soft tint is 3.92:1 in light mode
        // (icons/borders only — see the AA guardrail in tokens.ts), and this is
        // 11px copy. `text` measures 9.96:1 light / 10.72:1 dark on the fill.
        setupLink: {
            fontSize: 11,
            lineHeight: 15,
            fontWeight: '700',
            color: theme.colors.text,
            textDecorationLine: 'underline',
        },
        errorDetail: {
            fontSize: 11,
            lineHeight: 15,
            color: theme.colors.textMuted,
            marginTop: 2,
        },
    });
}
