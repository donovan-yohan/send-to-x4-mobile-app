/**
 * RouteChip — the delivery route as a dot and one word.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT REPLACED
 * ---------------------------------------------------------------------------
 * Under every send button sat a sentence explaining where the note was about to
 * go, branched four ways over role and reachability, re-worded slightly on each
 * screen. All four branches say the same thing — WHICH ROAD — and a road is a
 * word, not a paragraph. This is that word, drawn from
 * {@link DeliverabilitySummary} so Compose and Library cannot describe the same
 * state differently.
 *
 * ---------------------------------------------------------------------------
 * WHY 'setup-needed' IS NOT RED
 * ---------------------------------------------------------------------------
 * Nothing has failed. The user has not been told they need a mailbox yet, and
 * the note they are about to write is still recoverable — `sendLoveNote` parks
 * it in the outbox whatever happens. A danger tint here would be the same lie
 * the "Not connected" walls were: a normal, unconfigured state dressed as an
 * incident. It gets the muted treatment and, where the call site passes
 * `onPress`, it becomes the ONE small pointer at Settings on that screen.
 *
 * The other three states are all "this works", so they differ only in hue —
 * success for the immediate road, accent for the one that needs no reader
 * present, muted for the one that needs the user to do something later.
 *
 * PURE: takes the summary, renders it. The hook (`useDeliverability`) stays at
 * the call site so a screen can gate other things on the same object without
 * deriving it twice.
 */

import React, { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View, type StyleProp, type ViewStyle } from 'react-native';

import type { DeliverabilitySummary } from '../services/deliverability';
import { useTheme, type Theme } from '../theme';

/**
 * One word per road.
 *
 * 'Next sync' is two, and deliberately: 'Handover' is the codebase's word, not a
 * user's, and it does not say the part that matters — that nothing moves until
 * they do something. 'Set up' is a verb because it is the only state that asks.
 */
const ROUTE_WORD: Record<DeliverabilitySummary, string> = {
    'ready-direct': 'Direct',
    'ready-mailbox': 'Mailbox',
    'ready-handover': 'Next sync',
    'setup-needed': 'Set up',
};

/**
 * What each road promises, for screen readers and for the tip.
 *
 * The chip itself must NOT render these — that is the paragraph this component
 * exists to delete. They are here because a lone word like "Mailbox" is opaque
 * to a screen reader with no visual context to lean on.
 */
const ROUTE_HINT: Record<DeliverabilitySummary, string> = {
    'ready-direct': 'The reader is awake — this lands on it now.',
    'ready-mailbox': 'This waits in the mailbox and the reader collects it on its own.',
    'ready-handover': 'This waits on your phone until you sync with the reader.',
    'setup-needed': 'No delivery route set up yet. Tap to open Settings.',
};

export interface RouteChipProps {
    summary: DeliverabilitySummary;
    /**
     * Makes the chip a button. Intended for ONE use — sending 'setup-needed' to
     * Settings — but harmless on the ready states, where it reads as "show me
     * the connection settings".
     */
    onPress?: () => void;
    style?: StyleProp<ViewStyle>;
    testID?: string;
}

export function RouteChip({ summary, onPress, style, testID }: RouteChipProps) {
    const theme = useTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);

    const tone =
        summary === 'ready-direct'
            ? styles.toneDirect
            : summary === 'ready-mailbox'
                ? styles.toneMailbox
                : styles.toneQuiet;
    const dotTone =
        summary === 'ready-direct'
            ? styles.dotDirect
            : summary === 'ready-mailbox'
                ? styles.dotMailbox
                : styles.dotQuiet;

    const body = (
        <View style={styles.chip}>
            <View style={[styles.dot, dotTone]} />
            <Text style={[styles.word, tone]}>{ROUTE_WORD[summary]}</Text>
        </View>
    );

    if (!onPress) {
        return (
            <View
                style={style}
                testID={testID}
                accessibilityRole="text"
                accessibilityLabel={`${ROUTE_WORD[summary]}. ${ROUTE_HINT[summary]}`}
            >
                {body}
            </View>
        );
    }

    return (
        <TouchableOpacity
            style={style}
            onPress={onPress}
            testID={testID}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={`${ROUTE_WORD[summary]}. ${ROUTE_HINT[summary]}`}
        >
            {body}
        </TouchableOpacity>
    );
}

function createStyles(theme: Theme) {
    return StyleSheet.create({
        chip: {
            flexDirection: 'row',
            alignItems: 'center',
            alignSelf: 'center',
            paddingVertical: theme.spacing.xs,
            paddingHorizontal: theme.spacing.md,
            borderRadius: theme.radii.pill,
            // `surface2`, never a tint: the tints are translucent and this chip
            // sits on cards, on the page and (on Wallpaper) over a notice card,
            // so a tint would resolve against three different backdrops. See the
            // flattening note in ConnectionBanner for how that goes wrong.
            backgroundColor: theme.colors.surface2,
        },
        dot: {
            width: 6,
            height: 6,
            borderRadius: 3,
            marginRight: theme.spacing.sm,
        },
        dotDirect: { backgroundColor: theme.colors.success },
        dotMailbox: { backgroundColor: theme.colors.accent },
        dotQuiet: { backgroundColor: theme.colors.textMuted },
        word: {
            ...theme.type.caption,
        },
        toneDirect: { color: theme.colors.success },
        // The accent as TEXT on surface2, which the token comment measures as a
        // passing pair; the 3.92:1 icons-only caveat applies to accent on the
        // translucent tints, which this chip does not use.
        toneMailbox: { color: theme.colors.accent },
        toneQuiet: { color: theme.colors.textMuted },
    });
}
