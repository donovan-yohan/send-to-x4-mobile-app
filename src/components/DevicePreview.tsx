/**
 * DevicePreview — the encoder's own output, rendered AS the reader.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS (and what it deliberately is not)
 * ---------------------------------------------------------------------------
 * A picture frame shaped like an Xteink X3: a thin bezel around a panel-shaped
 * screen, with `previewUri` — the PNG of the encoder's `previewRgba` — filling
 * that screen edge to edge.
 *
 * It is NOT a simulation of the panel. It adds no crop, no fit, no letterbox,
 * no filter, no scaling other than the aspect-correct fill:
 *
 *     previewRgba IS the packed frame's pixels.
 *
 * The bytes on screen went through `prepareLoveNoteFrame` -> `encodeFrame`,
 * which produced the preview buffer alongside the very frame the sender
 * uploads. A cover-crop cut or a fit letterbox bar is therefore already IN the
 * image, put there by the same geometry pass the device will honour — this
 * component only has to avoid distorting it. That is why the screen box is
 * pinned to `composeDimsFor(orientation)` (the exact compose-view aspect the
 * encoder just produced) and the image is `resizeMode="contain"`: at a matching
 * aspect, contain is an exact fill, and if the two ever disagreed it would show
 * a visible bar rather than silently crop pixels the reader will display.
 *
 * ---------------------------------------------------------------------------
 * ORIENTATION
 * ---------------------------------------------------------------------------
 * The frame on the wire is always the same 792x528 landscape buffer; what
 * changes is how the reader is HELD, and therefore how the note is composed:
 *
 *   'portrait'   compose 528x792 -> device frame stands tall (book-style).
 *   'landscape'  compose 792x528 -> device frame lies wide (reader turned).
 *
 * Both come straight from `composeDimsFor`, so the box on screen is the panel's
 * true aspect in both cases, never a CSS approximation of one.
 *
 * The bezel is symmetric on purpose. A real e-reader has a wider chin along one
 * edge, but WHICH physical edge that is in a given hold is not something the
 * frame contract pins down, and inventing one would be the single decorative
 * detail in a component whose whole job is not lying about the panel.
 *
 * ---------------------------------------------------------------------------
 * FOOTPRINT
 * ---------------------------------------------------------------------------
 * The screen's height is derived from its width by `aspectRatio`, so in PORTRAIT
 * an unbounded device frame is 1.5x as tall as the column is wide — on a 412 dp
 * phone that is a 528 dp panel under ~420 dp of chrome, which pushes the send
 * button off screen and makes the user scroll to see the preview and scroll back
 * to send. So the WIDTH is capped ({@link MAX_DEVICE_WIDTH}) and the frame is
 * centred; `style` can widen or narrow it per call site.
 *
 * The cap is on width ONLY, never height: a maxHeight would clamp the box
 * without clamping the aspect, and `contain` would then letterbox the encoder's
 * buffer inside it — a bar this component did not get from the encoder, which is
 * exactly the lie the rest of this file exists to avoid.
 *
 * Pure presentation: no encoding, no state, no measurement. Nothing here can
 * drift from the send path because nothing here computes pixels.
 */

import React, { useMemo } from 'react';
import {
    ActivityIndicator,
    Image,
    StyleSheet,
    Text,
    View,
    type StyleProp,
    type ViewStyle,
} from 'react-native';

import { composeDimsFor, type NoteOrientation } from '../device/x3';
import { lightColors, useTheme, type Theme } from '../theme';

export interface DevicePreviewProps {
    /**
     * `data:image/png;base64,...` of the encoder's `previewRgba`, or null when
     * there is nothing to show yet (no source, an encode in flight, a failure).
     *
     * MUST be the preview buffer that came back with the frame being sent. A
     * separately rendered approximation would make this component a lie.
     */
    previewUri: string | null;
    /** Which way the reader is held. Sets the screen's exact aspect. */
    orientation: NoteOrientation;
    /** Shown on the blank panel when `previewUri` is null. */
    emptyText?: string;
    /** Dims the panel and spins while an encode is in flight. */
    busy?: boolean;
    /** Caption under the device. Pass null to drop it. */
    caption?: string | null;
    /**
     * Extra layout style for the outer wrapper (margins, max width).
     *
     * Applied AFTER the built-in width cap, so a call site with room to spare
     * can raise `maxWidth` (or drop it with `maxWidth: undefined`) without
     * touching this file.
     */
    style?: StyleProp<ViewStyle>;
    testID?: string;
}

/** Bezel thickness in dp — thin, because the X3's is thin. */
const BEZEL = 10;

/**
 * Widest the device frame is allowed to get, in dp (bezel included).
 *
 * Sized from the PORTRAIT case, which is the tall one and the default: 300 dp of
 * frame is a 280 dp panel, so 420 dp of panel height — a preview that reads
 * clearly and still leaves the send button on screen. Landscape at the same cap
 * is only ~187 dp tall, so one number covers both.
 *
 * Not a design flourish: without it the panel is as wide as the column, and see
 * FOOTPRINT above for what that costs.
 */
const MAX_DEVICE_WIDTH = 300;

/**
 * Unlit e-ink is not white; it is a faintly warm gray. Using it (rather than
 * #fff) keeps a fit-mode letterbox bar visible as a slightly BRIGHTER white
 * inside the panel instead of dissolving into the background.
 */
const PAPER = '#e9e8e3';

/**
 * Warm scrim over the panel while an encode is in flight.
 *
 * NOT a theme token and NOT part of the panel contract: it is a translucent
 * veil ON TOP of PAPER, so it has to be a near-paper cream in BOTH schemes or a
 * dark-mode scrim would read as the panel itself having gone dark. The value it
 * replaced (`rgba(233,232,227,0.6)`, i.e. PAPER itself) was cool-gray and made
 * the busy state look like a dead panel rather than a warming one.
 */
const BUSY_SCRIM = 'rgba(245,238,224,0.7)';

/**
 * THE PANEL IS NOT THEMED, SO NEITHER IS THE INK ON IT.
 *
 * The busy spinner draws on BUSY_SCRIM over PAPER (composite `#F1ECE1`), a
 * near-paper cream that is deliberately identical in both schemes. So the
 * spinner is pinned to the LIGHT palette's accent, which is the pairing that
 * actually holds contrast against cream: `#A8552E` measures 4.45:1 there, while
 * the dark palette's accent (`#E0894F`, an amber ember tuned for an espresso
 * background) measures 2.27:1 — under the 3:1 non-text floor, which would make
 * the only in-flight-encode indicator nearly vanish on a dark-mode phone.
 *
 * Same escape hatch, same reason, as CanvasComposer's ON_CANVAS_ACCENT.
 * Everything OUTSIDE the panel (bezel, caption) is app chrome and does follow
 * the theme.
 */
const ON_PANEL_ACCENT = lightColors.accent;

export function DevicePreview({
    previewUri,
    orientation,
    emptyText,
    busy = false,
    caption = 'Xteink X3',
    style,
    testID,
}: DevicePreviewProps) {
    const { width, height } = composeDimsFor(orientation);
    const theme = useTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);

    return (
        <View style={[styles.wrapper, style]} testID={testID}>
            <View style={styles.body}>
                <View style={[styles.screen, { aspectRatio: width / height }]}>
                    {previewUri ? (
                        <Image
                            source={{ uri: previewUri }}
                            style={styles.image}
                            // Aspect already matches the box exactly, so this is
                            // a fill — but it fails LOUDLY (a bar) rather than
                            // silently cropping if that ever stops being true.
                            resizeMode="contain"
                            fadeDuration={0}
                        />
                    ) : (
                        <View style={styles.empty}>
                            {emptyText ? <Text style={styles.emptyText}>{emptyText}</Text> : null}
                        </View>
                    )}

                    {busy ? (
                        <View style={styles.spinner} pointerEvents="none">
                            <ActivityIndicator size="large" color={ON_PANEL_ACCENT} />
                        </View>
                    ) : null}
                </View>
            </View>

            {caption ? <Text style={styles.caption}>{caption}</Text> : null}
        </View>
    );
}

/**
 * THE PANEL IS NOT THEMED. `screen`, `image`, `empty`, `emptyText` and `spinner`
 * below are the e-ink surface and the ink sitting on it — they are the encoder's
 * true unlit-paper output and a fidelity feature, so they stay on their own
 * literals (PAPER, the neutral ink-gray, BUSY_SCRIM, ON_PANEL_ACCENT) in BOTH
 * schemes. Only the chrome AROUND the panel — bezel, its border, its lift, and
 * the caption under it — is brand surface, and only that changes with the theme.
 */
function createStyles(theme: Theme) {
    return StyleSheet.create({
    wrapper: {
        alignItems: 'center',
        // A DEFINITE width plus alignSelf 'center', rather than 'stretch' with a
        // maxWidth. Both clamp, but a clamped stretch lays out at the START of
        // the cross axis, leaving the device against the left edge under a
        // centred caption. And the width has to stay definite: `body` stretches
        // to it and `screen` is `width: '100%'` of `body`, so a shrink-wrapped
        // wrapper would leave that percentage resolving against nothing and
        // collapse the panel to zero.
        alignSelf: 'center',
        width: '100%',
        maxWidth: MAX_DEVICE_WIDTH,
    },
    body: {
        alignSelf: 'stretch',
        padding: BEZEL,
        // A device bezel should look like an OBJECT, not a card: a deep warm
        // brown (leather/wood), darker than the surrounding surface in BOTH
        // schemes, with a real lift under it so the frame sits ON the page.
        borderRadius: theme.radii.lg,
        backgroundColor: theme.bezel.bezel,
        borderWidth: 1,
        borderColor: theme.bezel.bezelBorder,
        ...theme.shadows.raised,
    },
    screen: {
        // Height comes from aspectRatio, so the panel — not the caller — decides
        // the shape of this box.
        width: '100%',
        borderRadius: 3,
        overflow: 'hidden',
        backgroundColor: PAPER,
        // The glass edge: a hairline so the panel reads as inset in the bezel.
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: 'rgba(0,0,0,0.35)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    image: {
        width: '100%',
        height: '100%',
    },
    empty: {
        paddingHorizontal: 24,
    },
    emptyText: {
        fontSize: 13,
        color: 'rgba(20,20,26,0.45)',
        textAlign: 'center',
        lineHeight: 19,
    },
    spinner: {
        ...StyleSheet.absoluteFillObject,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: BUSY_SCRIM,
    },
    caption: {
        // The uppercase + 1.6 letter-spacing treatment this used to carry was the
        // single clearest "spec-sheet render" tell on the component. Regular case
        // makes the same frame read as a labelled keepsake object.
        marginTop: theme.spacing.sm,
        fontSize: 11,
        lineHeight: 15,
        fontWeight: '600',
        textAlign: 'center',
        color: theme.colors.textMuted,
    },
    });
}
