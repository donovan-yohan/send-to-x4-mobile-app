/**
 * InfoTip — a small pressable ⓘ that says ONE thing, on demand.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS: THE ALTERNATIVE WAS A PARAGRAPH UNDER EVERY CONTROL
 * ---------------------------------------------------------------------------
 * Every field on Settings, every segmented control on Compose and Wallpaper,
 * used to carry a permanent caption explaining itself. Read once each, then
 * re-read never, and paid for on every single render by every single user — the
 * screens were mostly explanation by volume. The copy pass deleted them.
 *
 * A few genuinely could not just go. "Mailbox Write Token" cannot be inferred
 * from its label, and the consequence of getting it wrong (silent publish
 * failures) is invisible; "Reader AP password" is blank-is-valid, which no label
 * can say; the Host/Client toggle silently changes which tabs exist. Those are
 * the shape this component is for: A CONTROL WHOSE CONSEQUENCE IS NOT VISIBLE
 * FROM THE CONTROL. If the screen already shows the answer — the preview shows
 * the crop, the chip shows the route, the disabled button shows the gate — there
 * is no tip to write.
 *
 * ---------------------------------------------------------------------------
 * THE BUDGET IS FIVE, AND IT IS A NUMBER SO IT CAN BE ARGUED WITH
 * ---------------------------------------------------------------------------
 * "Use sparingly" is not a bar anyone can fail. The whole app carries FIVE
 * tips — Settings x4 (Host/Client role, mailbox write token, "Set up reader
 * sync", reader AP password) and Wallpaper x1 (e-ink preview accuracy) — and a
 * sixth needs a reason on the record, not a feeling. One has already been cut
 * against this bar: "Set as sleep screen" explained that the sleep screen
 * outranks the rotation, which the LAYOUT states — the two destination buttons
 * are adjacent, weighted primary and secondary, and the Rotation (n) list sits
 * directly under its own button. Inferable from the arrangement is not
 * invisible.
 *
 * Past five, the honest read is that a screen is explaining itself rather than
 * showing itself, and the fix is the design, not another ⓘ.
 *
 * ---------------------------------------------------------------------------
 * WHY `Alert`, NOT A POPOVER
 * ---------------------------------------------------------------------------
 * Every call site is inside a ScrollView, several inside a collapsed disclosure.
 * An absolutely-positioned bubble there needs measurement, flip-on-overflow, an
 * outside-press catcher and a z-index that survives `overflow: hidden` on
 * Android — a few hundred lines of layout code to render one sentence. The
 * platform dialog is already modal, already dismissible, already accessible, and
 * already themed by the OS. The tip is one line either way.
 *
 * The TAP TARGET is the whole point of the padding: the glyph is 14 px, and a
 * 14 px target fails every touch guideline. `hitSlop` widens it to ~40 px
 * without changing the glyph's optical relationship to the label beside it.
 */

import React, { useCallback, useMemo } from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme, type Theme } from '../theme';

/** Widens the 14 px glyph to a ~40 px touch target without moving it. */
const HIT_SLOP = { top: 12, bottom: 12, left: 12, right: 12 } as const;

export interface InfoTipProps {
    /**
     * The one line. Keep it ONE line — if it needs a second, the control needs
     * a different design, not a longer tip.
     */
    text: string;
    /**
     * Dialog heading. Defaults to the generic 'About this', because the useful
     * heading is almost always the field label the tip already sits next to.
     */
    title?: string;
    /**
     * Screen-reader label. Defaults to 'More information'; pass the field name
     * ('About the mailbox write token') wherever several tips share a screen,
     * since a list of identical "More information" buttons is unnavigable.
     */
    accessibilityLabel?: string;
    style?: StyleProp<ViewStyle>;
}

export function InfoTip({ text, title = 'About this', accessibilityLabel, style }: InfoTipProps) {
    const theme = useTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);

    const handlePress = useCallback(() => {
        Alert.alert(title, text, [{ text: 'Got it' }]);
    }, [title, text]);

    return (
        <TouchableOpacity
            onPress={handlePress}
            hitSlop={HIT_SLOP}
            style={style}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel ?? 'More information'}
            accessibilityHint={text}
        >
            <View style={styles.glyph}>
                <Text style={styles.glyphText}>i</Text>
            </View>
        </TouchableOpacity>
    );
}

/**
 * A field label with its tip on the same baseline.
 *
 * Exists because that pairing is otherwise four lines of flexbox at every call
 * site, and getting it wrong (tip on its own line, or vertically off-centre
 * against a 13 px label) is the visible failure mode.
 */
export function LabelWithTip({
    label,
    tip,
    tipTitle,
    accessibilityLabel,
    style,
}: {
    label: string;
    tip: string;
    tipTitle?: string;
    accessibilityLabel?: string;
    style?: StyleProp<ViewStyle>;
}) {
    const theme = useTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);

    return (
        <View style={[styles.labelRow, style]}>
            <Text style={styles.label}>{label}</Text>
            <InfoTip
                text={tip}
                title={tipTitle ?? label}
                accessibilityLabel={accessibilityLabel ?? `About ${label}`}
            />
        </View>
    );
}

function createStyles(theme: Theme) {
    return StyleSheet.create({
        // A RING, not a filled dot: filled reads as a status indicator (the app
        // already has three of those), and an outline reads as "optional detail",
        // which is exactly what this is.
        glyph: {
            width: 16,
            height: 16,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: theme.colors.textMuted,
            alignItems: 'center',
            justifyContent: 'center',
        },
        glyphText: {
            // Not `theme.type.caption`: at 16 px the ring needs a 10 px glyph to
            // stay optically centred, and the caption scale's lineHeight would
            // push the serif off the ring's baseline.
            fontSize: 10,
            lineHeight: 12,
            fontWeight: '700',
            fontStyle: 'italic',
            color: theme.colors.textMuted,
        },
        labelRow: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.sm,
        },
        label: {
            ...theme.type.label,
            color: theme.colors.textMuted,
        },
    });
}
