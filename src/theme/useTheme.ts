// src/theme/useTheme.ts
//
// The single way a screen gets colors. Follows the OS color scheme
// (`userInterfaceStyle: "automatic"` is already set in app.config.ts), so there
// is no manual toggle — adding one later means swapping the `useColorScheme()`
// line for a context read and nothing else.
//
// Screens should call this once and build their StyleSheet from the returned
// theme (or use inline style objects for the handful of themed properties).
// Do NOT import raw hex out of tokens.ts inside a screen: that is exactly the
// drift the theme exists to prevent.

import { useMemo } from 'react';
import { useColorScheme } from 'react-native';
import type { TextStyle, ViewStyle } from 'react-native';

import {
    bezelByScheme,
    fonts,
    palettes,
    radii,
    shadowOpacityByScheme,
    shadows,
    spacing,
    tintAlphaByScheme,
    type,
    withAlpha,
    type ColorScheme,
    type ThemeColors,
    type TypeStyle,
    type TypeVariant,
} from './tokens';

/** Ready-to-spread elevation styles, already carrying this scheme's shadow color/alpha. */
export interface ThemeShadows {
    card: ViewStyle;
    raised: ViewStyle;
}

/** Pre-composed soft status tints (see tokens.tintAlphaByScheme for the ratios). */
export interface ThemeTints {
    success: string;
    danger: string;
    accent: string;
}

export interface Theme {
    /** Resolved scheme — `useColorScheme()` with the documented fallback applied. */
    scheme: ColorScheme;
    colors: ThemeColors;
    radii: typeof radii;
    spacing: typeof spacing;
    type: Record<TypeVariant, TypeStyle>;
    fonts: typeof fonts;
    shadows: ThemeShadows;
    /** Soft status-tint backgrounds for banners/chips. */
    tints: ThemeTints;
    /** DevicePreview's bezel chrome (NOT the e-ink panel surface). */
    bezel: { bezel: string; bezelBorder: string };
    /** `theme.alpha(theme.colors.accent, 0.2)` -> rgba string. */
    alpha: (color: string, a: number) => string;
}

/** Text styles are plain objects; this is just a typed convenience for callers. */
export type ThemeTextStyle = TextStyle;

export function buildTheme(scheme: ColorScheme): Theme {
    const colors = palettes[scheme];
    const opacity = shadowOpacityByScheme[scheme];
    const alphas = tintAlphaByScheme[scheme];

    return {
        scheme,
        colors,
        radii,
        spacing,
        type,
        fonts,
        shadows: {
            card: {
                ...shadows.card,
                shadowColor: colors.shadow,
                shadowOpacity: opacity.card,
            },
            raised: {
                ...shadows.raised,
                shadowColor: colors.shadow,
                shadowOpacity: opacity.raised,
            },
        },
        tints: {
            success: withAlpha(colors.success, alphas.success),
            danger: withAlpha(colors.danger, alphas.danger),
            accent: withAlpha(colors.accent, alphas.accent),
        },
        bezel: bezelByScheme[scheme],
        alpha: withAlpha,
    };
}

// Both schemes are built once at module load: the hook then hands back a stable
// object identity per scheme, so a theme in a `useMemo`/`StyleSheet.create` dep
// array does not re-create styles on every render.
const THEMES: Record<ColorScheme, Theme> = {
    light: buildTheme('light'),
    dark: buildTheme('dark'),
};

/**
 * `useColorScheme()` returns null before the OS value is known (and on some web
 * targets). The rebrand spec pins that fallback to 'dark' — the app's historical
 * look — rather than flashing a light theme at a dark-mode user.
 */
export const DEFAULT_SCHEME: ColorScheme = 'dark';

export function useTheme(): Theme {
    const scheme = useColorScheme();
    return useMemo(() => THEMES[scheme ?? DEFAULT_SCHEME], [scheme]);
}
