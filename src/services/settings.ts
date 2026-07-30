import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Settings } from '../types';
import { asRole } from './role';

/**
 * Canonical default settings.
 *
 * EXPORTED ON PURPOSE: ConnectionProvider used to carry a hand-copied duplicate
 * of this literal to seed its useState, so a field added here but not there left
 * a window (every render before getSettings resolves) with the field undefined —
 * i.e. a client flashing the host-only Wallpaper/Device tabs. There is now
 * exactly one literal; import it, do not re-type it.
 */
export const DEFAULTS: Settings = {
    crossPointIp: 'crosspoint.local',

    // ── LEGACY, NO LONGER USER-FACING ──────────────────────────────────────
    // The article/notes pipeline and the wallpaper gallery these six keys
    // configured were deleted from this fork, and Settings no longer renders a
    // control for any of them. They stay HERE, and their coercions stay in
    // normalizeSettings, because of the PERSISTENCE CONTRACT (R8, see
    // src/types/index.ts): the blob is unversioned with no migration hook, so
    // an install that already wrote them keeps handing them back on every load.
    // A key and its coercion have to be removed in the SAME change, both
    // directions: drop the coercion alone and a hand-edited/older blob reaches
    // it as a non-string (the `.trim()` throw asTrimmedString exists to stop,
    // which getSettings swallows into a DEFAULTS fallback — the user's whole
    // configuration silently resets); drop the DEFAULTS entry alone and the
    // surviving `|| DEFAULTS.x` tail resolves to undefined, so the field is
    // persisted as undefined while its type still claims `string`.
    // Do not re-surface these in the UI. Delete them (both places, plus the
    // Settings interface and the last consumer, note_sender.ts) when the blob
    // is finally allowed a migration.
    articleFolder: 'send-to-x4',
    noteFolder: 'notes',
    useDateFolders: false,
    includeImagesInArticles: false,
    hideAiWallpapers: false,
    hideSensitiveWallpapers: false,
    // ───────────────────────────────────────────────────────────────────────

    role: 'host',
    pairingSecret: '',
    apSsid: 'CrossPoint-Reader',
    // '' = the OPEN access point the firmware ships today. See the field doc on
    // `Settings.readerApPsk`; the reader-link join path treats '' as "no PSK".
    readerApPsk: '',
    mailboxUrl: '',
    mailboxWriteToken: '',
};

const STORAGE_KEY = '@send-to-x4/settings';

/**
 * Coerce an arbitrary persisted value to a trimmed string.
 *
 * The stored blob is unversioned and hand-editable, so a field can legitimately
 * come back as a number, null, or missing entirely; `.trim()` on any of those
 * would throw inside getSettings and wipe the user's whole configuration.
 */
function asTrimmedString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * Normalize every field that has a coercion, in one place.
 *
 * Called on both the load and the save path so a value can never be persisted
 * in a shape that the load path would reject (and vice versa).
 *
 * Exported for `scripts/device-host.test.js`: this is the only place the
 * default-fallback ordering can be observed, and getting that ordering wrong is
 * silent (see the crossPointIp note below).
 */
export function normalizeSettings(input: Settings): Settings {
    const s = { ...input };
    // The fallback must sit OUTSIDE normalizeDeviceHost, not inside it. Inside,
    // it only catches input that is ALREADY blank — but normalizeDeviceHost
    // strips the scheme then takes split('/')[0], so '/', 'http://', 'https://'
    // and 'http:///' all normalize to '' and used to be persisted as an empty
    // host. getDeviceBaseUrl then returned 'http://' and every device call hit
    // 'http:///api/files'.
    s.crossPointIp = normalizeDeviceHost(asTrimmedString(s.crossPointIp)) || DEFAULTS.crossPointIp;
    // LEGACY (see DEFAULTS): no UI writes these any more, but old blobs still
    // hand them back on every load and they can legitimately come back as a
    // number/null/missing. The coercion is what keeps getSettings() from
    // throwing on those installs, so it outlives the UI that produced them.
    s.articleFolder = sanitizeFolderName(asTrimmedString(s.articleFolder)) || DEFAULTS.articleFolder;
    s.noteFolder = sanitizeFolderName(asTrimmedString(s.noteFolder)) || DEFAULTS.noteFolder;
    s.role = asRole(s.role);
    s.apSsid = asTrimmedString(s.apSsid) || DEFAULTS.apSsid;
    // pairingSecret / mailboxUrl / mailboxWriteToken are optional: an empty
    // string means "not set". Trim only — validating a mailbox URL belongs to
    // services/mailbox_client.ts (describeMailboxUrlProblem), which the Settings
    // form calls so the user sees WHY a URL was refused instead of it being
    // silently blanked here on save.
    s.pairingSecret = asTrimmedString(s.pairingSecret);
    s.mailboxUrl = asTrimmedString(s.mailboxUrl);
    // Trimmed, and NO default fallback: '' is a MEANINGFUL value here (the open
    // AP the firmware ships), so `|| DEFAULTS.readerApPsk` would be a no-op that
    // reads as though a blank were being corrected. Trimming a passphrase is a
    // deliberate narrowing — WPA2 permits leading/trailing spaces, but this value
    // is read off the reader's panel and typed or pasted by hand, so an invisible
    // trailing space would present as "the app cannot join my reader" with
    // nothing on either side to point at.
    s.readerApPsk = asTrimmedString(s.readerApPsk);
    // Trimming matters more than usual here: a token is pasted, and a trailing
    // newline from a clipboard would travel inside the Authorization header and
    // come back as an unexplainable 401.
    s.mailboxWriteToken = asTrimmedString(s.mailboxWriteToken);
    return s;
}

/**
 * Get current settings from storage
 */
export async function getSettings(): Promise<Settings> {
    try {
        const json = await AsyncStorage.getItem(STORAGE_KEY);
        if (json) {
            // Unknown keys from older installs (firmwareType, stockIp, …) ride
            // along untouched; missing keys fall back to DEFAULTS.
            const loaded: Settings = { ...DEFAULTS, ...JSON.parse(json) };
            return normalizeSettings(loaded);
        }
    } catch (error) {
        console.warn('Failed to load settings:', error);
    }
    // Copy, so a caller mutating the result cannot corrupt the shared defaults
    // that ConnectionProvider also seeds its state from.
    return { ...DEFAULTS };
}

/**
 * Save settings to storage
 */
export async function saveSettings(settings: Partial<Settings>): Promise<Settings> {
    try {
        const current = await getSettings();
        const updated = normalizeSettings({ ...current, ...settings });
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
        return updated;
    } catch (error) {
        console.warn('Failed to save settings:', error);
        throw error;
    }
}

/**
 * Get the current device host.
 *
 * Single-firmware (CrossPoint) since the stock upload path was deleted; kept as
 * a function so callers do not reach into the settings shape directly.
 */
export function getCurrentIp(settings: Settings): string {
    return getDeviceHostForRuntime(settings.crossPointIp);
}

/**
 * Get the default device host.
 */
export function getDefaultIp(): string {
    return DEFAULTS.crossPointIp;
}

/**
 * Normalize user-provided device target (IP or hostname).
 * Accepts bare hosts like "crosspoint.local" and strips accidental schemes/paths.
 */
export function normalizeDeviceHost(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return '';

    let host = trimmed.replace(/^https?:\/\//i, '');
    host = host.split('/')[0];
    return host;
}

/**
 * Resolve host to runtime-safe target.
 */
export function getDeviceHostForRuntime(value: string): string {
    return normalizeDeviceHost(value);
}

/**
 * Build the base URL for device API calls.
 */
export function getDeviceBaseUrl(value: string): string {
    return `http://${getDeviceHostForRuntime(value)}`;
}

/**
 * Sanitize a USER-TYPED folder name: strip slashes, special chars, collapse
 * whitespace → dashes.
 *
 * Scope: the two LEGACY folder keys (articleFolder, noteFolder). Settings no
 * longer renders a field for either, so this now only re-sanitizes values that
 * older installs already persisted — it is a load-compat coercion, not live
 * input handling. It flattens a path to a single segment on purpose — a user
 * who typed "my/folder" got "myfolder", not a nested path.
 *
 * It DOES preserve a leading dot (".inbox" → ".inbox"; only a bare "." or ".."
 * is rejected), so it happens to be safe for the messenger's dot-folders today.
 * Do NOT rely on that: this function exists to serve user input and is free to
 * get stricter. Device-reserved paths must go through `sanitizeDevicePath`,
 * which is pinned by tests to keep dot-folders intact.
 */
export function sanitizeFolderName(value: string): string {
    return value
        .trim()
        .replace(/[\/\\]/g, '')
        .replace(/[^a-zA-Z0-9\s._-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .replace(/^\.{1,2}$/, '')   // block bare "." or ".."
        .substring(0, 60);
}

/**
 * Sanitize a DEVICE-RESERVED path (the messenger's own folders on the reader's
 * SD card, e.g. ".love-notes", ".sleep", "books/inbox").
 *
 * Differs from sanitizeFolderName in the two ways the firmware cares about:
 *   1. A LEADING DOT SURVIVES. `.love-notes` and `.sleep` are the literal names
 *      the firmware looks for; a sanitizer that strips the dot silently writes
 *      to the wrong folder and the reader shows nothing (R7).
 *   2. Nesting survives. Segments are kept and re-joined with '/', so
 *      ".sleep/rotation" stays two levels deep instead of collapsing.
 *
 * Traversal is still blocked: '.' and '..' segments are dropped, and leading /
 * trailing separators are normalized away (uploadToCrossPoint builds the
 * '/${folder}' prefix itself, so the returned value must be root-relative).
 *
 * Returns '' for input that reduces to nothing — which is a MEANINGFUL value
 * here, not a failure: uploadToCrossPoint treats '' as the SD root, the correct
 * destination for the permanent wallpaper at /sleep.bmp.
 */
export function sanitizeDevicePath(value: string): string {
    return value
        .split(/[\/\\]+/)
        .map(segment => segment.trim())
        .filter(segment => segment.length > 0 && segment !== '.' && segment !== '..')
        .map(segment =>
            segment
                .replace(/[^a-zA-Z0-9._-]/g, '-')
                .replace(/-+/g, '-')
                .substring(0, 60)
        )
        .filter(segment => segment.length > 0 && segment !== '.' && segment !== '..')
        .join('/');
}

/**
 * Get the note folder name from settings — LEGACY.
 *
 * The last consumer is `services/note_sender.ts`, whose own only caller was
 * `screens/NotesScreen.tsx` — never registered as a route by App.tsx, and now
 * deleted: the plain-text note pipeline is orphaned code kept compiling, not a
 * live path.
 * Every SHIPPING destination on the reader is a fixed, firmware-defined path
 * (`/.love-notes/current.frame`, `/sleep.bmp`, `/.sleep/*.bmp`) that the
 * senders own as their own constants — nothing user-configurable.
 *
 * `getArticleFolder` and `getDefaultFolder` used to sit alongside this; both
 * lost their last caller in the legacy-settings cleanup (DeviceScreen's scan
 * roots and the Settings reset buttons respectively) and were deleted. Delete
 * this one, and `resolveTargetFolder` below, together with note_sender.ts.
 */
export function getNoteFolder(settings: Settings): string {
    return settings.noteFolder || DEFAULTS.noteFolder;
}

/**
 * Resolve the actual target folder path — LEGACY, see getNoteFolder.
 * When useDateFolders is true, appends today's date as a subfolder (e.g. send-to-x4/2026-02-20).
 * Nothing surfaces `useDateFolders` any more; the flag only ever arrives from an
 * old persisted blob.
 */
export function resolveTargetFolder(baseFolder: string, useDateFolders: boolean): string {
    if (!useDateFolders) return baseFolder;
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return `${baseFolder}/${yyyy}-${mm}-${dd}`;
}
