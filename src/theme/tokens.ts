// src/theme/tokens.ts
//
// Cozy rebrand tokens. Two palettes — light (beige/brown paper) and dark
// (candlelit brown/plum, explicitly NOT navy/black) — plus shared shape,
// spacing, and type scales. Pure data: no native deps, safe to import
// anywhere (components, StyleSheet factories, SVG icon fills).
//
// Contrast ratios below are computed against this exact palette (WCAG
// relative-luminance formula) and must be re-checked if any hex changes.
// Every ratio in this file was machine-computed, not estimated.

export type ColorScheme = 'light' | 'dark';

export interface ThemeColors {
    /** Screen background. */
    bg: string;
    /** Card / input / segmented-control track background, one step off bg. */
    surface: string;
    /** Second surface tier — nested cards, active segment, pressed states. */
    surface2: string;
    /** Primary text. */
    text: string;
    /** Secondary text — help text, captions, placeholders. */
    textMuted: string;
    /** Brand accent — primary buttons, active tab, links, focus rings. */
    accent: string;
    /** Text/icon color placed ON TOP of `accent` fills. */
    accentText: string;
    /** Errors, failed sends, destructive actions. Warm red-clay, not alarm-red. */
    danger: string;
    /** Success, connected state, sent confirmation. Warm moss, not neon green. */
    success: string;
    /** Hairlines, input borders, dividers. */
    border: string;
    /** Shadow color for elevation (see `shadows` below) — used as rgba base. */
    shadow: string;
}

export const lightColors: ThemeColors = {
    bg: '#F6EEDF',        // warm cream paper (bg/text contrast 11.85:1)
    surface: '#FFFBF4',   // card surface, slightly warmer/lighter than bg
    surface2: '#EDE0CB',  // nested surface: segmented-control track, input fill
    text: '#3B2A1F',      // deep warm umber, near-black brown
    textMuted: '#6E5A44', // warm taupe (bg 5.68:1, surface2 5.03:1, surface 6.34:1)
    accent: '#A8552E',    // terracotta clay (bg/accent-as-text 4.55:1; accent/surface 5.08:1)
    accentText: '#FFF7EC',// warm cream on accent fills (4.94:1 on accent)
    danger: '#9A3B2E',    // brick red-clay, warm not alarm (bg contrast 5.99:1)
    success: '#3F6B3A',   // warm moss green (bg contrast 5.40:1)
    border: '#DCC9AA',    // soft warm tan hairline
    shadow: '#3B2A1F',    // used at low alpha, see `shadows`
};

export const darkColors: ThemeColors = {
    bg: '#231714',        // candlelit espresso-brown (NOT navy) — bg/text 13.96:1
    surface: '#2E211C',   // card surface, one step up from bg
    surface2: '#3A2A22',  // nested surface: segmented track, active segment base
    text: '#F1E4D6',      // warm parchment white
    textMuted: '#B79E8C', // warm taupe-gray (bg 6.88:1, surface2 5.40:1)
    accent: '#E0894F',    // warm amber-ember (bg/accent-as-text 6.53:1; accent/dark-text 6.73:1)
    accentText: '#20140F',// near-black warm brown on accent fills (6.73:1)
    danger: '#E8837A',    // warm salmon-red, candlelit not alarm (bg 6.61:1)
    success: '#8FBF86',   // warm sage green (bg 8.28:1)
    border: '#4A362C',    // warm brown hairline
    shadow: '#000000',    // used at low alpha over the dark bg
};

export const palettes: Record<ColorScheme, ThemeColors> = {
    light: lightColors,
    dark: darkColors,
};

/**
 * AA GUARDRAIL — the one pairing in this palette that is NOT 4.5:1.
 *
 * `accent` on `surface2` is 4.03:1 (light) / 5.12:1 (dark). The light value
 * clears the 3:1 bar for icons, borders, focus rings and 18px+/14px-bold text
 * but NOT the 4.5:1 bar for normal body text. So: never put small accent-colored
 * body copy on a `surface2` fill in light mode — use `text` (10.49:1) or
 * `textMuted` (5.03:1) there, and keep `accent` on `surface2` for icons/strokes.
 * Every other fg/bg pairing in both palettes is >= 4.5:1 (measured).
 */

/**
 * The e-ink panel surface (DevicePreview's `screen`) is EXPLICITLY excluded
 * from theming — it is the encoder's true unlit-paper output, a fidelity
 * feature, not brand surface. Keep using the existing literal
 * (`PAPER = '#e9e8e3'`) inside DevicePreview; do not source it from here.
 */

// ── Shape ────────────────────────────────────────────────────────────────

export const radii = {
    sm: 8,    // inputs, small chips
    md: 14,   // cards, segmented control track (was 12 — softer, cozier)
    lg: 20,   // primary buttons, device-frame bezel
    pill: 999,// tab pills / rounded chips if needed
};

// ── Spacing scale (4px base, matches existing 4/8/12/16/20/24 usage) ──────

export const spacing = {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 20,
    xxl: 24,
    xxxl: 32,
};

// ── Type scale ──────────────────────────────────────────────────────────
//
// Font choice constrained to what Expo ships with zero new native deps:
//
//   - Primary UI typeface: SYSTEM FONT (`undefined` fontFamily → San Francisco
//     on iOS, Roboto on Android). No asset loading, no FOUT, no bundle size
//     cost, matches platform text-rendering/hinting. This is the safe default
//     for ALL body/label/button text below.
//   - `fonts.display` is deliberately left undefined: the optional warm-serif
//     display font (Fraunces/Lora via expo-font) is a separate, skippable PR.
//     Until it lands, screen H1s fall back to the system font, bold.
//   - Do NOT use a display font for input fields, numbers, URLs, or tokens —
//     anything the user has to read/verify letter-by-letter stays on the system
//     font's tabular, unambiguous glyphs.

export const fonts = {
    /** Default for all body copy, labels, buttons, inputs. Zero-cost. */
    body: undefined as string | undefined, // system font — do not set fontFamily
    /**
     * Optional warm serif for screen H1s ONLY. Leave undefined (falls back to
     * system font, bold) until/unless the expo-font step is done.
     * If added: 'Fraunces_600SemiBold' (or 'Lora_600SemiBold') registered via
     * useFonts() in App.tsx before SplashScreen.hideAsync().
     */
    display: undefined as string | undefined,
};

/** Weights are string literals so these objects drop straight into TextStyle. */
export interface TypeStyle {
    fontSize: number;
    fontWeight: '400' | '500' | '600' | '700';
    lineHeight: number;
}

export type TypeVariant = 'h1' | 'h2' | 'body' | 'label' | 'caption' | 'button';

export const type: Record<TypeVariant, TypeStyle> = {
    h1: { fontSize: 28, fontWeight: '700', lineHeight: 34 },   // screen titles
    h2: { fontSize: 17, fontWeight: '700', lineHeight: 22 },   // section titles (was 14/uppercase)
    body: { fontSize: 15, fontWeight: '400', lineHeight: 21 },
    label: { fontSize: 13, fontWeight: '600', lineHeight: 18 },
    caption: { fontSize: 12, fontWeight: '500', lineHeight: 17 },
    button: { fontSize: 16, fontWeight: '700', lineHeight: 20 },
};

// ── Elevation / shadow ──────────────────────────────────────────────────
//
// Cozy warmth reads better with a soft, warm-tinted shadow (never cool
// gray/blue) on cards and the primary button — like a paper cutout with a
// little lift. Same shadow shape both modes; only the alpha differs (the dark
// bg already has enough value contrast).

export const shadows = {
    card: {
        shadowColor: undefined as string | undefined, // set to theme.shadow at call site
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.10, // light mode; use shadowOpacityByScheme in dark
        shadowRadius: 8,
        elevation: 2, // Android
    },
    raised: {
        // primary button, device-frame bezel
        shadowColor: undefined as string | undefined,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.14, // light mode; see shadowOpacityByScheme
        shadowRadius: 12,
        elevation: 4,
    },
};

/**
 * Per-scheme shadow opacity, since a warm shadow needs more alpha on a dark
 * bg to read at all and less on a light bg to avoid muddying the paper.
 */
export const shadowOpacityByScheme: Record<ColorScheme, { card: number; raised: number }> = {
    light: { card: 0.10, raised: 0.14 },
    dark: { card: 0.35, raised: 0.42 },
};

// ── Soft status tints ───────────────────────────────────────────────────
//
// Banners/chips are a SOFT TINT of their status color, never a solid saturated
// fill: the disconnected banner must read as a warm strip, not an alarm wall.
// Alphas are picked so the full-strength status color still clears AA (4.5:1)
// as text ON its own tint — measured against each scheme's `bg`:
//
//   light success 0.13 -> tint #DEDDCA, success text 4.53:1  (0.14 measures
//     4.48:1, which misses AA by 0.02 — hence 0.13, not the sketch's 0.14)
//   light danger  0.12 -> tint #EBD9CA, danger  text 5.04:1
//   light accent  0.12 -> tint #EDDCCA, used for fills/borders (accent-on-tint
//     3.92:1 = icon/border only; put `text` 10.21:1 on it for copy)
//   dark  success 0.18 -> tint #363529, success text 5.87:1
//   dark  danger  0.16 -> tint #432824, danger  text 5.08:1
//   dark  accent  0.16 -> tint #41291D, accent  text 5.04:1
//
// (dark danger/accent alphas are extrapolated from the sketch's success pair,
// which already went 0.14 light -> 0.18 dark for the same "needs more alpha on
// a dark bg to read at all" reason.)
export const tintAlphaByScheme: Record<ColorScheme, { success: number; danger: number; accent: number }> = {
    light: { success: 0.13, danger: 0.12, accent: 0.12 },
    dark: { success: 0.18, danger: 0.16, accent: 0.16 },
};

// ── Device-frame bezel (DevicePreview chrome only) ───────────────────────
//
// A device bezel should look like an OBJECT, not like a card: always a deep
// warm brown, darker than the surrounding surface in BOTH schemes, evoking
// leather/wood rather than plastic-dark-navy. This is chrome AROUND the panel —
// the panel pixels themselves stay untouched true-e-ink (see the note above).
export const bezelByScheme: Record<ColorScheme, { bezel: string; bezelBorder: string }> = {
    light: { bezel: '#4A3A2E', bezelBorder: '#2E231A' },
    dark: { bezel: '#1A120D', bezelBorder: '#0B0705' },
};

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * `withAlpha('#A8552E', 0.12)` -> `'rgba(168,85,46,0.12)'`.
 *
 * Kept here (not in a util) because every soft-tint background in the app is
 * one of these, and they must all be derived from the palette rather than
 * hand-written rgba literals drifting out of sync with the tokens.
 * Accepts `#RGB`, `#RRGGBB`, and `#RRGGBBAA` (trailing alpha ignored).
 */
export function withAlpha(color: string, alpha: number): string {
    const hex = color.replace('#', '');
    const expand = hex.length === 3
        ? hex.split('').map((c) => c + c).join('')
        : hex.slice(0, 6);
    const n = parseInt(expand, 16);
    if (expand.length !== 6 || Number.isNaN(n)) return color;
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    const a = Math.max(0, Math.min(1, alpha));
    return `rgba(${r},${g},${b},${a})`;
}
