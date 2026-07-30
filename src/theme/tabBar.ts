// src/theme/tabBar.ts
//
// Geometry for the FLOATING tab pill. Two independent consumers have to agree
// on it, so it lives here instead of inside App.tsx:
//
//   - App.tsx draws the pill: `position: 'absolute'`, inset from every edge by
//     GAP, exactly PILL_HEIGHT tall.
//   - every scrollable screen leaves `useTabBarInset()` of padding at the end of
//     its content. This is not cosmetic: an absolutely-positioned tab bar is out
//     of the flex flow and therefore reserves NO layout space, so without the
//     inset the last row scrolls under the pill and stays there, unreachable.
//
// If you change PILL_HEIGHT or GAP, both sides move together — that is the whole
// point of the shared module.

import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { spacing } from './tokens';

/** Height of the pill itself. Excludes the safe-area inset, which sits BELOW it. */
export const TAB_BAR_PILL_HEIGHT = 60;

/** Breathing room between the pill and the screen edges (and the content above it). */
export const TAB_BAR_PILL_GAP = spacing.md;

/**
 * Where the pill sits, and how much room the content under it needs.
 *
 * `bottom` is `max(inset, GAP)` rather than `inset + GAP`: the safe-area inset
 * IS the clearance the OS asks for, so adding a gap on top of a 34pt home
 * indicator would strand the pill halfway up the screen. The max only kicks in on
 * devices reporting no bottom inset at all, which would otherwise glue the pill
 * to the screen edge and stop it reading as floating.
 */
export function useTabBarPillLayout(): { bottom: number; contentInset: number } {
    const insets = useSafeAreaInsets();
    const bottom = Math.max(insets.bottom, TAB_BAR_PILL_GAP);

    return {
        bottom,
        contentInset: bottom + TAB_BAR_PILL_HEIGHT + TAB_BAR_PILL_GAP,
    };
}

/**
 * Bottom padding a scrollable screen needs so its last row clears the pill.
 *
 * Deliberately NOT `useBottomTabBarHeight()`: that hook throws outside a tab
 * navigator, and SettingsScreen is mounted both as a tab AND as a modal stack
 * route (see `isModal` there).
 */
export function useTabBarInset(): number {
    return useTabBarPillLayout().contentInset;
}
