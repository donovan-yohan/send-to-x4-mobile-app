// src/components/TabBarScrim.tsx
//
// The fade-out behind the FLOATING tab pill.
//
// The pill is `position: 'absolute'` (see App.tsx + src/theme/tabBar.ts), so
// content scrolls UNDER it by design. That reads fine over the themed bg, but a
// large paper-white surface — DevicePreview's e-ink panel above all — sliding
// behind the pill turns into a hard white rectangle framing it. Nothing is
// broken; it just looks pasted on.
//
// So: a vertical scrim pinned to the bottom of the navigator, BEHIND the pill,
// that eases from fully transparent down into solid `colors.bg`. Content
// dissolves into the background before it ever reaches the pill's top edge.
//
// Geometry comes from the same shared constants the pill and the scroll insets
// use, so the three cannot drift:
//
//   [ screen bottom ] ── bottom ──> pill ── PILL_HEIGHT ──> pill top
//                                                            │ GAP + FEATHER  = the ramp
//                                                            v scrim top (transparent)
//
// Everything from the pill's top edge DOWN is solid bg on purpose: the pill is
// inset by GAP on both sides and floats above the safe-area inset, so content is
// visible in those margins and a partly-transparent scrim there would leak the
// white box back in around the pill.
//
// Uses react-native-svg (already a dependency — expo-linear-gradient is not
// installed and must not be added for this).

import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Defs, LinearGradient, Rect, Stop, Svg } from 'react-native-svg';

import { TAB_BAR_PILL_GAP, TAB_BAR_PILL_HEIGHT, useTabBarPillLayout, useTheme } from '../theme';

/**
 * Extra softening above the pill's clearance gap. The ramp is
 * `TAB_BAR_PILL_GAP + this` tall — enough to read as a fade rather than a cut,
 * short enough that a fully-scrolled last row is only feathered at its very
 * bottom edge (the scroll inset already keeps that row out from under the pill).
 */
export const TAB_BAR_SCRIM_FEATHER = 40;

/**
 * Gradient ids live in a per-<Svg> definition map, but keep this distinctive
 * anyway — a generic "grad" is exactly the kind of name that collides once a
 * second gradient shows up somewhere else in the tree.
 */
const GRADIENT_ID = 'tabBarScrimFade';

/**
 * Renders nothing interactive: `pointerEvents="none"` on the wrapper so taps,
 * scrolls and swipes pass straight through to the scene underneath. Must be
 * rendered BEFORE the tab bar itself (see App.tsx's `tabBar` prop) so the pill
 * paints on top of it.
 */
export function TabBarScrim() {
    const theme = useTheme();
    const { bottom } = useTabBarPillLayout();

    // Solid from the pill's top edge down to the screen edge; the ramp sits
    // entirely above it.
    const solidHeight = bottom + TAB_BAR_PILL_HEIGHT;
    const rampHeight = TAB_BAR_PILL_GAP + TAB_BAR_SCRIM_FEATHER;
    const height = solidHeight + rampHeight;

    // The ramp as a fraction of the whole rect, so the stop offsets below stay
    // pinned to the pill's top edge whatever the device's safe-area inset is.
    const ramp = rampHeight / height;

    return (
        <View pointerEvents="none" style={[styles.root, { height }]}>
            {/* No width/height props: <Svg> then defaults to 100%/100% and fills
                the wrapper, which is what the percentage <Rect> resolves against. */}
            <Svg>
                <Defs>
                    <LinearGradient id={GRADIENT_ID} x1="0" y1="0" x2="0" y2="1">
                        {/* Eased, not linear: a straight ramp puts its steepest
                            perceptual change right at the top, where the fade is
                            supposed to be invisible. Slow start, quick finish. */}
                        <Stop offset={0} stopColor={theme.colors.bg} stopOpacity={0} />
                        <Stop offset={ramp * 0.35} stopColor={theme.colors.bg} stopOpacity={0.25} />
                        <Stop offset={ramp * 0.75} stopColor={theme.colors.bg} stopOpacity={0.75} />
                        <Stop offset={ramp} stopColor={theme.colors.bg} stopOpacity={1} />
                        <Stop offset={1} stopColor={theme.colors.bg} stopOpacity={1} />
                    </LinearGradient>
                </Defs>
                <Rect x={0} y={0} width="100%" height="100%" fill={`url(#${GRADIENT_ID})`} />
            </Svg>
        </View>
    );
}

const styles = StyleSheet.create({
    root: {
        position: 'absolute',
        // Logical props, matching the pill's `start`/`end` — Yoga resolves these
        // ahead of left/right, so mixing the two families invites a silent loss.
        start: 0,
        end: 0,
        bottom: 0,
    },
});
