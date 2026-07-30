// src/components/icons/index.ts
//
// One import surface for the cozy icon set:
//
//   import { Icon, ComposeIcon } from '../components/icons';
//
// Do NOT add another glyph casually — if a screen truly needs one, match the
// style contract documented at the top of TabIcons.tsx exactly. The set is
// five tab glyphs plus `bin` and `eraser`, which exist because the emoji they
// replaced (🗑️, 🩹) carry font-baked colors that cannot be recontrasted
// against the danger fill they sit on.

export {
    ACTIVE_STROKE,
    BinIcon,
    COMPOSE_HEART_PATH,
    ComposeIcon,
    DEFAULT_ICON_SIZE,
    DEFAULT_STROKE,
    DeviceIcon,
    EraserIcon,
    HistoryIcon,
    ICONS,
    Icon,
    SETTINGS_PETAL_PATHS,
    SettingsIcon,
    WallpaperIcon,
    type IconName,
    type IconProps,
    type NamedIconProps,
} from './TabIcons';
