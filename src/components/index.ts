// Re-export the components that survive the messenger reshape.
// NOTE: UrlInput / QueueList / HeadlessWebView are gone — they belonged to the
// article/EPUB flow, which has been removed. Do not re-add them.
// NOTE: ScreensaverQueueList is gone too — its only consumer was the
// unregistered ScreensaversScreen, deleted with the cozy pass (see below).
// NOTE: DumpButton and ScreensaverButton are gone as of the deliverability pass.
// No screen had imported either for some time, and both carried the negative
// wall this pass exists to delete ("Join the reader's WiFi to send queued
// items"). A barrel export is not free: it keeps a component one import away
// from being revived, and these two would have come back speaking for a
// connection model the app no longer holds. Delivery gating belongs to
// `useDeliverability`; a button that needs it reads the route, not the radio.
export { ActionButton } from './ActionButton';
export { CanvasComposer, type CanvasComposerMode, type CanvasComposerProps } from './CanvasComposer';
// `useDirectConnectionRequired` ships from here so the direct-only screens
// (Device, Wallpaper) can adopt one shared "is the reader reachable, and if not,
// why" instead of each re-deriving it — see the note in ConnectionBanner.tsx.
export {
    ConnectionBanner,
    useDirectConnectionRequired,
    READER_ASLEEP_CAPTION,
    type DirectConnectionRequirement,
} from './ConnectionBanner';
export { DevicePreview, type DevicePreviewProps } from './DevicePreview';
export {
    BinIcon,
    ComposeIcon,
    DeviceIcon,
    EraserIcon,
    HistoryIcon,
    Icon,
    SettingsIcon,
    WallpaperIcon,
    type IconName,
    type IconProps,
} from './icons';
// The copy pass's two replacements for permanent explanatory text: a tip you
// open when you want it, and a chip that says the delivery route in one word.
export { InfoTip, LabelWithTip, type InfoTipProps } from './InfoTip';
export { ProcessingOverlay } from './ProcessingOverlay';
export { RouteChip, type RouteChipProps } from './RouteChip';
export {
    SegmentedControl,
    type SegmentedControlProps,
    type SegmentedOption,
} from './SegmentedControl';
export { StatusIndicator } from './StatusIndicator';
