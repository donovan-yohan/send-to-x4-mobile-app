// src/components/icons/TabIcons.tsx
//
// The cozy icon set — stroke glyphs drawn with react-native-svg (already a
// dependency; no new native modules). Five replace the emoji tab icons
// (✍️ 🕘 🖼️ 📱 ⚙️) and the inline ⚙️ in ConnectionBanner; `bin` and `eraser`
// replace the last two emoji in live UI (🗑️ on the swipe-delete danger fill and
// in row buttons, 🩹 on the canvas erase tool).
//
// STYLE CONTRACT — every glyph in this file obeys it, and any future glyph must:
//   - 24x24 canvas, viewBox "0 0 24 24".
//   - stroke={color}, strokeWidth={1.75} (default), fill="none".
//   - strokeLinecap="round", strokeLinejoin="round" — soft ends and joins
//     everywhere, no sharp mitres. This is the single geometric signature that
//     reads as "cozy" instead of "techy" across the whole set.
//   - Active tab: color = theme.colors.accent, strokeWidth = 2 (ACTIVE_STROKE),
//     i.e. slightly bolder rather than a fill swap, so the set keeps feeling
//     hand-drawn instead of icon-font-swapped.
//   - Inactive tab: color = theme.colors.textMuted, strokeWidth = 1.75.
//   - The Compose heart is the ONE filled shape in the set: it is the app's
//     signature mark (a pen that has just drawn a little heart).
//
// Colors come in as props — nothing here reads the theme itself, so these stay
// usable inside SVG-free contexts (tab bar options, buttons) and in tests.

import React from 'react';
import { Circle, Path, Rect, Svg } from 'react-native-svg';
import type { StyleProp, ViewStyle } from 'react-native';

export const DEFAULT_ICON_SIZE = 24;
/** Inactive / default stroke weight. */
export const DEFAULT_STROKE = 1.75;
/** Active-tab stroke weight (bolder, same geometry). */
export const ACTIVE_STROKE = 2;

export interface IconProps {
    /** Rendered box, in px. The geometry scales with it (24x24 viewBox). */
    size?: number;
    /**
     * Stroke/fill color. Defaults to `currentColor`, which react-native-svg
     * resolves from the inherited color context — pass a theme color explicitly
     * for anything user-visible.
     */
    color?: string;
    strokeWidth?: number;
    style?: StyleProp<ViewStyle>;
    /** Forwarded to the root <Svg> for RTL/opacity tweaks at call sites. */
    opacity?: number;
}

type GlyphProps = Required<Pick<IconProps, 'size' | 'color' | 'strokeWidth'>> &
    Pick<IconProps, 'style' | 'opacity'>;

function resolveGlyphProps(props: IconProps): GlyphProps {
    const {
        size = DEFAULT_ICON_SIZE,
        color = 'currentColor',
        strokeWidth = DEFAULT_STROKE,
        style,
        opacity,
    } = props;
    return { size, color, strokeWidth, style, opacity };
}

/**
 * The signature heart. This is the §2 heart template
 *   M7 18.5 C4.2 16.2 3 14.6 3 13.1 C3 11.7 4.1 10.6 5.4 10.6 C6.2 10.6 6.7 11
 *   7 11.5 C7.3 11 7.8 10.6 8.6 10.6 C9.9 10.6 11 11.7 11 13.1 C11 14.6 9.8
 *   16.2 7 18.5 Z
 * scaled 0.55x about its own bbox center and re-centered on (7, 16.9), which is
 * what puts a ~4.4x4.3 heart under the pen nib at (9.5, 13.5) — the nib just
 * grazes the heart's upper-right lobe, so the pen reads as having drawn it.
 * The un-scaled template above is also the app-icon wax seal (assets/brand).
 */
export const COMPOSE_HEART_PATH =
    'M7 19.07 C5.46 17.81 4.8 16.93 4.8 16.1 C4.8 15.33 5.41 14.73 6.12 14.73 ' +
    'C6.56 14.73 6.84 14.95 7 15.22 C7.17 14.95 7.44 14.73 7.88 14.73 ' +
    'C8.6 14.73 9.2 15.33 9.2 16.1 C9.2 16.93 8.54 17.81 7 19.07 Z';

/** Compose — a nib-down fountain pen that has just drawn a small heart. */
export function ComposeIcon(props: IconProps) {
    const { size, color, strokeWidth, style, opacity } = resolveGlyphProps(props);
    // The shaft is the one deliberately heavier stroke in the set (3 at the
    // 1.75 default), kept proportional so the active/inactive weight change
    // scales the whole glyph instead of just its outline.
    const shaftWidth = strokeWidth * (3 / DEFAULT_STROKE);
    return (
        <Svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            style={style}
            opacity={opacity}
        >
            <Path
                d="M18.5 4.5 L9.5 13.5"
                stroke={color}
                strokeWidth={shaftWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            <Path
                d="M17 3 L20 6"
                stroke={color}
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            <Path d={COMPOSE_HEART_PATH} fill={color} stroke="none" />
        </Svg>
    );
}

/** History — a warm analog clock, no tech-radar feel. */
export function HistoryIcon(props: IconProps) {
    const { size, color, strokeWidth, style, opacity } = resolveGlyphProps(props);
    return (
        <Svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            style={style}
            opacity={opacity}
        >
            <Circle
                cx={12}
                cy={12}
                r={8.25}
                stroke={color}
                strokeWidth={strokeWidth}
                fill="none"
            />
            <Path
                d="M12 12 L12 8"
                stroke={color}
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            <Path
                d="M12 12 L15 13.5"
                stroke={color}
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            <Circle cx={12} cy={12} r={1} fill={color} stroke="none" />
        </Svg>
    );
}

/** Wallpaper — a framed picture: one peak, one small sun. */
export function WallpaperIcon(props: IconProps) {
    const { size, color, strokeWidth, style, opacity } = resolveGlyphProps(props);
    return (
        <Svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            style={style}
            opacity={opacity}
        >
            <Rect
                x={3.5}
                y={4.5}
                width={17}
                height={15}
                rx={2.5}
                stroke={color}
                strokeWidth={strokeWidth}
                strokeLinejoin="round"
                fill="none"
            />
            <Circle
                cx={9}
                cy={10}
                r={1.6}
                stroke={color}
                strokeWidth={strokeWidth}
                fill="none"
            />
            <Path
                d="M5.5 16.5 L10 11.5 L13 14.5 L15.5 12 L18.5 16.5"
                stroke={color}
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </Svg>
    );
}

/**
 * Device — an open book, not a phone. The Device tab is the READER, and the
 * app already calls it "held like a book" in the orientation copy.
 */
export function DeviceIcon(props: IconProps) {
    const { size, color, strokeWidth, style, opacity } = resolveGlyphProps(props);
    return (
        <Svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            style={style}
            opacity={opacity}
        >
            <Path
                d="M12 6.5 C9.5 5 6.5 4.7 4.5 5.3 L4.5 17.3 C6.5 16.7 9.5 17 12 18.5"
                stroke={color}
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
            />
            <Path
                d="M12 6.5 C14.5 5 17.5 4.7 19.5 5.3 L19.5 17.3 C17.5 16.7 14.5 17 12 18.5"
                stroke={color}
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
            />
            <Path
                d="M12 6.5 L12 18.5"
                stroke={color}
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </Svg>
    );
}

/**
 * Settings — a warm rounded knob, not a mechanical cog: a ring plus six short
 * rounded petals every 60°, generated from the spec's trig (0° points up,
 * clockwise; inner end at r=5.6, outer end at r=8.6) rather than hand-typed
 * approximations, so the six are exactly evenly spaced.
 */
const KNOB_CENTER = 12;
const KNOB_PETAL_INNER_R = 5.6;
const KNOB_PETAL_OUTER_R = 8.6;
const round2 = (n: number) => Math.round(n * 100) / 100;

export const SETTINGS_PETAL_PATHS: string[] = Array.from({ length: 6 }, (_, i) => {
    const rad = (i * 60 * Math.PI) / 180;
    const sin = Math.sin(rad);
    const cos = Math.cos(rad);
    const x1 = round2(KNOB_CENTER + KNOB_PETAL_INNER_R * sin);
    const y1 = round2(KNOB_CENTER - KNOB_PETAL_INNER_R * cos);
    const x2 = round2(KNOB_CENTER + KNOB_PETAL_OUTER_R * sin);
    const y2 = round2(KNOB_CENTER - KNOB_PETAL_OUTER_R * cos);
    return `M${x1} ${y1} L${x2} ${y2}`;
});

export function SettingsIcon(props: IconProps) {
    const { size, color, strokeWidth, style, opacity } = resolveGlyphProps(props);
    return (
        <Svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            style={style}
            opacity={opacity}
        >
            <Circle
                cx={12}
                cy={12}
                r={3.4}
                stroke={color}
                strokeWidth={strokeWidth}
                fill="none"
            />
            {SETTINGS_PETAL_PATHS.map((d) => (
                <Path
                    key={d}
                    d={d}
                    stroke={color}
                    strokeWidth={strokeWidth}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
            ))}
        </Svg>
    );
}

/**
 * Bin — the 6th glyph, and it is here for a contrast reason, not a taste one.
 *
 * The delete affordance used to be 🗑️, whose colors are baked into the font: a
 * fixed multicolor glyph sitting on `colors.danger`'s solid brick-red swipe
 * fill, which no recolor of the container can fix. As a stroke glyph it takes
 * `accentText` on that fill and `textMuted` on a surface, and both hold AA.
 *
 * Geometry: lid line + rounded handle + tapered body + two tick strokes. The
 * body narrows from 6.6/17.4 at the lid to 8.7/15.3 at the base and the ticks
 * converge with it, so the taper reads at 16px instead of looking like a box.
 */
export function BinIcon(props: IconProps) {
    const { size, color, strokeWidth, style, opacity } = resolveGlyphProps(props);
    return (
        <Svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            style={style}
            opacity={opacity}
        >
            <Path
                d="M4.5 7 L19.5 7"
                stroke={color}
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            <Path
                d="M9.6 7 L9.6 4.9 C9.6 4.4 10 4 10.5 4 L13.5 4 C14 4 14.4 4.4 14.4 4.9 L14.4 7"
                stroke={color}
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
            />
            <Path
                d="M6.6 7 L7.5 19.1 C7.55 19.72 8.07 20.2 8.7 20.2 L15.3 20.2 C15.93 20.2 16.45 19.72 16.5 19.1 L17.4 7"
                stroke={color}
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
            />
            <Path
                d="M10.5 10.6 L10.9 16.7"
                stroke={color}
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            <Path
                d="M13.5 10.6 L13.1 16.7"
                stroke={color}
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </Svg>
    );
}

/**
 * Eraser — the 7th glyph, replacing the 🩹 that stood in for the canvas's erase
 * tool (a bandage emoji, which said "injury" rather than "rub this out").
 *
 * Geometry: a rounded block tilted 45° (so it reads as held at an angle, not as
 * a square), a baseline it rests on, and one crease marking where the rubber
 * ends. Three continuous rounded strokes — same family as the book and the pen.
 */
export function EraserIcon(props: IconProps) {
    const { size, color, strokeWidth, style, opacity } = resolveGlyphProps(props);
    return (
        <Svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            style={style}
            opacity={opacity}
        >
            <Path
                d="M7.2 20.6 L3.1 16.5 C2.3 15.7 2.3 14.4 3.1 13.6 L12.6 4.1 C13.4 3.3 14.7 3.3 15.5 4.1 L20.9 9.5 C21.7 10.3 21.7 11.6 20.9 12.4 L12.7 20.6"
                stroke={color}
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
            />
            <Path
                d="M21.5 20.6 L7.2 20.6"
                stroke={color}
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            <Path
                d="M5.4 11.3 L13.7 19.6"
                stroke={color}
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </Svg>
    );
}

export const ICONS = {
    compose: ComposeIcon,
    history: HistoryIcon,
    wallpaper: WallpaperIcon,
    device: DeviceIcon,
    settings: SettingsIcon,
    bin: BinIcon,
    eraser: EraserIcon,
} as const;

export type IconName = keyof typeof ICONS;

export interface NamedIconProps extends IconProps {
    name: IconName;
}

/** `<Icon name="compose" size={24} color={theme.colors.accent} />` */
export function Icon({ name, ...rest }: NamedIconProps) {
    const Glyph = ICONS[name];
    return <Glyph {...rest} />;
}
