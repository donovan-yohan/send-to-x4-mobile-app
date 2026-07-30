// src/theme/index.ts
//
// Import surface for the cozy theme. Screens should import from here:
//
//   import { useTheme } from '../theme';
//
// and read colors off the returned theme instead of hardcoding hex.
// `tokens` stays importable for the few places that need raw data outside a
// component (e.g. a StyleSheet factory or an SVG geometry constant).

export {
    bezelByScheme,
    darkColors,
    fonts,
    lightColors,
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

export {
    TAB_BAR_PILL_GAP,
    TAB_BAR_PILL_HEIGHT,
    useTabBarInset,
    useTabBarPillLayout,
} from './tabBar';

export {
    DEFAULT_SCHEME,
    buildTheme,
    useTheme,
    type Theme,
    type ThemeShadows,
    type ThemeTextStyle,
    type ThemeTints,
} from './useTheme';
