/**
 * wifi_share — the one WiFi credential this phone is holding FOR the reader.
 *
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS: NOTHING IS EVER TYPED ON E-INK
 * ---------------------------------------------------------------------------
 * The reader needs a home network before it can reach the mailbox on its own,
 * and entering a WPA2 passphrase on an e-ink panel with a five-button chorded
 * keyboard is the single worst interaction in the product. The phone already
 * has a link to the reader — the A3 'Sync with app' peer link — so the
 * passphrase travels over that instead, typed ONCE, on a keyboard.
 *
 * ANDROID CANNOT READ THE CURRENT NETWORK'S PASSWORD, for any app, at any API
 * level, with any permission. There is no prefill to be had and no permission
 * worth asking for: this module stages what the user typed and nothing else.
 * (The SSID is not prefilled either — see {@link WIFI_SHARE_NO_PREFILL}.)
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE, AND WHY IT IS NOT THE OUTBOX
 * ---------------------------------------------------------------------------
 * `services/outbox` is a QUEUE of bodies the reader pulls through the mailbox
 * contract — notes and books, listed in `latest.txt` / `books.txt`, served under
 * `/m/{boxId}/…`. A WiFi credential is none of those things: it is one value,
 * it is a secret, it must never appear in a manifest the reader is allowed to
 * enumerate, and it is answered on its own local-only path (`/cp-wifi`) that is
 * never forwarded upstream. Putting it in the outbox would put a passphrase one
 * refactor away from a `books.txt` line.
 *
 * So it is a separate, deliberately tiny store:
 *   - ONE AsyncStorage key holds `{ ssid, password, status }`. There is no list
 *     and no history: a second staged network REPLACES the first, because the
 *     reader has one slot and the older value is by definition the stale one.
 *   - ONE file (`wifi-share/credentials.txt`) is the copy the NATIVE side reads,
 *     for the same reason the outbox manifest is a file: Kotlin cannot read
 *     AsyncStorage, and the module's rule is that it takes PATHS, never values
 *     (`ProxyOptions.wifiSharePath`, next to `outboxManifestPath`). A value
 *     passed as a start option would also ride inside any validation message the
 *     native side ever produced for it.
 *   - The file is written at HANDOVER TIME ({@link prepareWifiShareHandover}),
 *     not at stage time, and deleted the moment the reader acks — OR when the
 *     session ends without one ({@link discardWifiShareHandover}, called from
 *     `sync_session`'s `releaseNative`). Both halves are needed for the sentence
 *     "it exists for the length of a sync session rather than for the length of
 *     the staging" to be true: with only the ack, a reader that never came into
 *     range left cleartext in the sandbox indefinitely.
 *
 * ---------------------------------------------------------------------------
 * AND THE PHONE ITSELF IS NOT A BACKUP TARGET
 * ---------------------------------------------------------------------------
 * `app.json` sets `expo.android.allowBackup: false`. Both copies of the
 * passphrase — the AsyncStorage record below and the staged file above — would
 * otherwise be eligible for Android Auto Backup to the user's Google Drive,
 * `adb backup`, and device-to-device transfer, which turns a passphrase the user
 * expected to travel one hop over a local link into one that leaves the phone.
 * (The mailbox write token was already in that set; this closes both.) The cost
 * is that app data does not survive a device transfer, which for a note history
 * and a device pairing is the cheaper side of the trade.
 *
 * ---------------------------------------------------------------------------
 * THE WIRE FORMAT IS TWO LINES, AND `scripts/wifi-share.test.js` PINS IT
 * ---------------------------------------------------------------------------
 *     {ssid}\n{password}\n
 *
 * Empty second line = an OPEN network. The firmware trims a trailing CR, so a
 * CRLF-normalising intermediary cannot break it. Neither field can contain a
 * newline, because {@link describeWifiSsidProblem} and
 * {@link describeWifiPasswordProblem} refuse control characters outright — which
 * is what makes a line-oriented format safe here at all.
 *
 * ---------------------------------------------------------------------------
 * NODE-TESTABLE BY CONSTRUCTION
 * ---------------------------------------------------------------------------
 * Neither AsyncStorage nor expo-file-system can be imported under node, so both
 * are reached through injectable seams ({@link __setWifiShareStore},
 * {@link __setWifiShareFileSystem}) resolved by the same lazy-`require` idiom as
 * `services/outbox`. With neither present the module degrades to "nothing can be
 * staged here" rather than throwing at import.
 */

import { createLock } from '../utils/lock';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** AsyncStorage key for the staged credential. NEW — nothing else touches it. */
export const WIFI_SHARE_KEY = '@messenger/wifi-share';

/** Directory under `documentDirectory` holding the native-readable copy. */
export const WIFI_SHARE_DIR_NAME = 'wifi-share';

/** The file Kotlin reads. Passed to `startProxy` as `wifiSharePath`. */
export const WIFI_SHARE_FILENAME = 'credentials.txt';

/**
 * Why the SSID field starts EMPTY, stated once so nobody re-litigates it in a
 * screen.
 *
 * Reading the SSID of the network the phone is on is a location-grade operation
 * on Android 8.1+: `WifiInfo.getSSID()` (however it is reached — `WifiManager`,
 * or `NetworkCapabilities.getTransportInfo()` on a callback) returns
 * `<unknown ssid>` unless the caller holds ACCESS_FINE_LOCATION and location
 * services are on. `NEARBY_WIFI_DEVICES`, which this app DOES hold, is declared
 * for the peer-join path and does not unlock it — and on this app's own
 * declaration it is the `neverForLocation` shape, which exists precisely to
 * promise the OS that the app is not deriving location from WiFi.
 *
 * So the choice is: add a dangerous location permission and a runtime-request
 * flow to save one line of typing, or let the user type the SSID they can read
 * off their own phone's status bar. The field starts empty.
 */
export const WIFI_SHARE_NO_PREFILL =
    "Android only reveals the current network's name to apps that hold location permission, " +
    'which this app deliberately does not ask for. Type the network name as it appears in your ' +
    "phone's WiFi settings.";

/** WPA2 PSK bounds, mirrored by the native validator and by the firmware. */
export const WIFI_PSK_MIN_CHARS = 8;
export const WIFI_PSK_MAX_CHARS = 63;

/** 802.11 caps the SSID at 32 BYTES, not characters. */
export const WIFI_SSID_MAX_BYTES = 32;

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/**
 * `pending` — staged, not handed over yet.
 * `delivered` — the reader acked it. The PASSWORD IS GONE by then; only the
 * network name survives, so the card can say which network went across.
 */
export type WifiShareStatus = 'pending' | 'delivered';

export interface WifiShareRecord {
    ssid: string;
    /**
     * '' means an OPEN network when {@link status} is `pending`, and means
     * "wiped" when it is `delivered`. The two are never confusable because
     * nothing reads the password on a delivered record.
     */
    password: string;
    status: WifiShareStatus;
    stagedAt: number;
    deliveredAt: number | null;
}

export interface WifiCredential {
    ssid: string;
    password: string;
}

// ---------------------------------------------------------------------------
// Validation — the same rules the Kotlin side applies, stated in the language
// the user is typing in
// ---------------------------------------------------------------------------

/** UTF-8 byte length without allocating a Buffer (this runs in Hermes). */
function utf8Length(value: string): number {
    let bytes = 0;
    for (const char of value) {
        const code = char.codePointAt(0) ?? 0;
        if (code <= 0x7f) bytes += 1;
        else if (code <= 0x7ff) bytes += 2;
        else if (code <= 0xffff) bytes += 3;
        else bytes += 4;
    }
    return bytes;
}

function hasControlChar(value: string): boolean {
    for (const char of value) {
        const code = char.codePointAt(0) ?? 0;
        if (code < 0x20 || code === 0x7f) return true;
    }
    return false;
}

/**
 * Why this SSID cannot be handed over, or null.
 *
 * A control character is refused rather than stripped: the wire format is two
 * LINES, so a newline inside the SSID would silently reshape the credential the
 * reader parses into something else entirely.
 */
export function describeWifiSsidProblem(ssid: unknown): string | null {
    if (typeof ssid !== 'string') return 'Enter the network name.';
    if (ssid.length === 0) return 'Enter the network name.';
    if (hasControlChar(ssid)) return 'The network name cannot contain line breaks or control characters.';
    const bytes = utf8Length(ssid);
    if (bytes > WIFI_SSID_MAX_BYTES) {
        return `The network name is ${bytes} bytes; WiFi allows ${WIFI_SSID_MAX_BYTES}.`;
    }
    return null;
}

/**
 * Why this passphrase cannot be handed over, or null.
 *
 * BLANK IS VALID and means an open network — the same convention the reader-AP
 * passphrase field in Settings already uses. Anything non-blank has to satisfy
 * WPA2's own 8..63 bound, because a shorter one cannot be joined by the reader
 * and would present as "the app sent me a password that does not work".
 */
export function describeWifiPasswordProblem(password: unknown): string | null {
    if (typeof password !== 'string') return 'Enter the password, or leave it blank for an open network.';
    if (password.length === 0) return null;
    if (hasControlChar(password)) return 'The password cannot contain line breaks or control characters.';
    if (password.length < WIFI_PSK_MIN_CHARS || password.length > WIFI_PSK_MAX_CHARS) {
        return `A WiFi password is ${WIFI_PSK_MIN_CHARS}–${WIFI_PSK_MAX_CHARS} characters (this one is ${password.length}).`;
    }
    return null;
}

/**
 * THE WIRE FORMAT. `{ssid}\n{password}\n`, UTF-8.
 *
 * Exported and pinned byte-exact by `scripts/wifi-share.test.js` because the
 * firmware parses it in a separate repo with no shared compile step: the two
 * halves agree only because this string and `docs/xteink/mailbox-books-contract.md`
 * say the same thing.
 */
export function serializeWifiCredential(credential: WifiCredential): string {
    return `${credential.ssid}\n${credential.password}\n`;
}

/**
 * The inverse, for tests and for a file this process wrote earlier.
 *
 * Tolerant in exactly the ways the firmware is: a trailing CR is trimmed, a
 * missing second line means an open network, and anything after the second line
 * is ignored. Returns null when the result would not survive validation, so a
 * truncated or half-written file reads as "nothing staged" rather than as a
 * credential with an empty SSID.
 */
export function parseWifiCredential(text: unknown): WifiCredential | null {
    if (typeof text !== 'string') return null;
    const lines = text.split('\n').map(line => (line.endsWith('\r') ? line.slice(0, -1) : line));
    const ssid = lines[0] ?? '';
    const password = lines[1] ?? '';
    if (describeWifiSsidProblem(ssid) !== null) return null;
    if (describeWifiPasswordProblem(password) !== null) return null;
    return { ssid, password };
}

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/** The slice of AsyncStorage this module needs. Structural, not imported. */
export interface WifiShareStore {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
}

/**
 * The slice of `expo-file-system` this module needs.
 *
 * Text only, and small: the credential is at most ~100 bytes, so none of the
 * outbox's copy/stream machinery applies.
 */
export interface WifiShareFileSystem {
    /** `file:///…/` with a trailing slash, or null when there is no sandbox. */
    documentDirectory: string | null;
    makeDirectory(path: string): Promise<void>;
    writeText(path: string, text: string): Promise<void>;
    /** Idempotent: removing an absent file is not an error. */
    remove(path: string): Promise<void>;
}

// Metro collects `require('<literal>')` statically, so the lazy loads below are
// ordinary bundle dependencies. Under node's ESM loader the identifier does not
// exist — `typeof` on an undeclared name is safe — and the module degrades to
// "no storage / no filesystem". Same idiom as services/outbox.ts.
declare const require: ((id: string) => unknown) | undefined;

let store: WifiShareStore | null = null;
let storeResolved = false;

/** Replace the store. Pass `null` to restore AsyncStorage. TEST SEAM. */
export function __setWifiShareStore(next: WifiShareStore | null): void {
    store = next;
    storeResolved = next !== null;
}

function getStore(): WifiShareStore | null {
    if (!storeResolved) {
        store = loadAsyncStorage();
        storeResolved = true;
    }
    return store;
}

function isStore(value: unknown): value is WifiShareStore {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<WifiShareStore>;
    return (
        typeof candidate.getItem === 'function' &&
        typeof candidate.setItem === 'function' &&
        typeof candidate.removeItem === 'function'
    );
}

function loadAsyncStorage(): WifiShareStore | null {
    if (typeof require !== 'function') return null;
    try {
        const mod = require('@react-native-async-storage/async-storage') as { default?: unknown };
        for (const candidate of [mod?.default, mod]) {
            if (isStore(candidate)) return candidate;
        }
    } catch {
        // Not a React Native runtime (node test, web preview).
    }
    return null;
}

let fs: WifiShareFileSystem | null = null;
let fsResolved = false;

/** Replace the filesystem. Pass `null` to restore expo-file-system. TEST SEAM. */
export function __setWifiShareFileSystem(next: WifiShareFileSystem | null): void {
    fs = next;
    fsResolved = next !== null;
}

function getFs(): WifiShareFileSystem | null {
    if (!fsResolved) {
        fs = loadExpoFileSystem();
        fsResolved = true;
    }
    return fs;
}

function loadExpoFileSystem(): WifiShareFileSystem | null {
    if (typeof require !== 'function') return null;
    try {
        const mod = require('expo-file-system/legacy') as {
            documentDirectory?: string | null;
            makeDirectoryAsync?: (uri: string, o?: { intermediates?: boolean }) => Promise<void>;
            writeAsStringAsync?: (uri: string, c: string) => Promise<void>;
            deleteAsync?: (uri: string, o?: { idempotent?: boolean }) => Promise<void>;
        };
        if (
            !mod ||
            typeof mod.makeDirectoryAsync !== 'function' ||
            typeof mod.writeAsStringAsync !== 'function' ||
            typeof mod.deleteAsync !== 'function'
        ) {
            return null;
        }
        const mkdir = mod.makeDirectoryAsync;
        const write = mod.writeAsStringAsync;
        const del = mod.deleteAsync;
        return {
            documentDirectory: mod.documentDirectory ?? null,
            makeDirectory: uri => mkdir(uri, { intermediates: true }),
            writeText: (uri, text) => write(uri, text),
            remove: uri => del(uri, { idempotent: true }),
        };
    } catch {
        // Not a React Native runtime (node test, web preview).
    }
    return null;
}

// ---------------------------------------------------------------------------
// Change notification — the card shows the live status
// ---------------------------------------------------------------------------

type WifiShareListener = (record: WifiShareRecord | null) => void;

const listeners = new Set<WifiShareListener>();

/**
 * Subscribe to every mutation. Returns an unsubscribe function.
 *
 * This is how the delivery reaches the UI: the sync session wipes the staging
 * when the reader acks, and the card flips from "Will hand over next sync" to
 * "Handed over" without anything polling.
 */
export function subscribeWifiShare(listener: WifiShareListener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

function notify(record: WifiShareRecord | null): void {
    // Copied: a listener may unsubscribe itself from inside the callback.
    for (const listener of [...listeners]) {
        try {
            listener(record);
        } catch (e) {
            console.warn('[WifiShare] listener threw:', e);
        }
    }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const withLock = createLock();

function credentialsPath(system: WifiShareFileSystem): string | null {
    const root = system.documentDirectory;
    if (!root) return null;
    const base = root.endsWith('/') ? root : `${root}/`;
    return `${base}${WIFI_SHARE_DIR_NAME}/${WIFI_SHARE_FILENAME}`;
}

/**
 * Coerce whatever came back out of an unversioned, hand-editable blob.
 *
 * Anything that does not round-trip to a usable record is treated as NOTHING
 * STAGED. A half-parsed credential is worse than none: the user would be told a
 * network is queued and the reader would be offered a passphrase that cannot
 * join it.
 */
function asRecord(raw: unknown): WifiShareRecord | null {
    if (!raw || typeof raw !== 'object') return null;
    const value = raw as Partial<WifiShareRecord>;
    const ssid = typeof value.ssid === 'string' ? value.ssid : '';
    if (describeWifiSsidProblem(ssid) !== null) return null;
    const status: WifiShareStatus = value.status === 'delivered' ? 'delivered' : 'pending';
    const password = typeof value.password === 'string' ? value.password : '';
    // A delivered record is not allowed to carry a password even if one somehow
    // survived a write: the wipe is the whole point of the state.
    if (status === 'pending' && describeWifiPasswordProblem(password) !== null) return null;
    return {
        ssid,
        password: status === 'delivered' ? '' : password,
        status,
        stagedAt: typeof value.stagedAt === 'number' && Number.isFinite(value.stagedAt)
            ? value.stagedAt
            : 0,
        deliveredAt:
            typeof value.deliveredAt === 'number' && Number.isFinite(value.deliveredAt)
                ? value.deliveredAt
                : null,
    };
}

async function readRecord(): Promise<WifiShareRecord | null> {
    const backing = getStore();
    if (!backing) return null;
    try {
        const json = await backing.getItem(WIFI_SHARE_KEY);
        if (!json) return null;
        return asRecord(JSON.parse(json));
    } catch (e) {
        console.warn('[WifiShare] Could not read the staged network:', e);
        return null;
    }
}

async function writeRecord(record: WifiShareRecord | null): Promise<void> {
    const backing = getStore();
    if (!backing) return;
    if (record === null) {
        await backing.removeItem(WIFI_SHARE_KEY);
        return;
    }
    await backing.setItem(WIFI_SHARE_KEY, JSON.stringify(record));
}

/**
 * Remove the native-readable copy. Best effort, always.
 *
 * A file that outlives its staging is the one failure this module must not have
 * — it would re-offer a passphrase the user has since removed — so every path
 * that clears the record calls this, and native deletes the same file itself on
 * the ack. Two independent deletes for one secret is deliberate.
 */
async function removeCredentialsFile(): Promise<void> {
    const system = getFs();
    if (!system) return;
    const path = credentialsPath(system);
    if (!path) return;
    try {
        await system.remove(path);
    } catch (e) {
        console.warn('[WifiShare] Could not remove the staged credential file:', e);
    }
}

// ---------------------------------------------------------------------------
// The API
// ---------------------------------------------------------------------------

export interface WifiShareResult {
    ok: boolean;
    /** Why the credential was refused. Null on success. */
    error: string | null;
    record: WifiShareRecord | null;
}

/** What is staged right now, or null. */
export async function getWifiShare(): Promise<WifiShareRecord | null> {
    return withLock(readRecord);
}

/**
 * Stage one network for the next sync.
 *
 * REPLACES whatever was there. The reader has one WiFi slot and the phone has
 * one user; a second staged network means the first was wrong, so keeping both
 * would only create a question nothing can answer.
 */
export async function stageWifiShare(credential: WifiCredential): Promise<WifiShareResult> {
    const ssidProblem = describeWifiSsidProblem(credential?.ssid);
    if (ssidProblem) return { ok: false, error: ssidProblem, record: null };
    const passwordProblem = describeWifiPasswordProblem(credential?.password ?? '');
    if (passwordProblem) return { ok: false, error: passwordProblem, record: null };

    const record: WifiShareRecord = {
        ssid: credential.ssid,
        password: credential.password ?? '',
        status: 'pending',
        stagedAt: Date.now(),
        deliveredAt: null,
    };
    return withLock(async () => {
        try {
            await writeRecord(record);
        } catch (e) {
            console.warn('[WifiShare] Could not stage the network:', e);
            return {
                ok: false,
                error: "This phone couldn't save the network. Try again.",
                record: null,
            };
        }
        // The old file names the OLD network. Removed before anything can read
        // it again; the next handover writes the new one.
        await removeCredentialsFile();
        notify(record);
        return { ok: true, error: null, record };
    });
}

/**
 * Forget everything staged, delivered or not. The user's "remove" button.
 */
export async function clearWifiShare(): Promise<void> {
    return withLock(async () => {
        try {
            await writeRecord(null);
        } catch (e) {
            console.warn('[WifiShare] Could not clear the staged network:', e);
        }
        await removeCredentialsFile();
        notify(null);
    });
}

export interface WifiShareHandover {
    /**
     * Absolute `file://` path of the two-line credential file, or '' when there
     * is nothing to hand over (or no filesystem). '' means the session omits
     * `wifiSharePath` entirely and the native `/cp-wifi` endpoint does not exist
     * for it.
     */
    path: string;
    /** True when a credential is staged and not yet delivered. */
    pending: boolean;
    /** The network name, for the status line. Null when nothing is staged. */
    ssid: string | null;
}

/**
 * Write the native-readable copy and report what it holds.
 *
 * Called on the critical path of a session the user is standing in front of, so
 * it MUST NOT THROW: a credential that cannot be written is a sync without the
 * WiFi handover, not a failed sync.
 *
 * WRITTEN HERE RATHER THAN AT STAGE TIME on purpose. The passphrase then lives
 * in a plain file only for as long as a handover is actually being attempted,
 * instead of from the moment it was typed until whenever the reader is next
 * seen.
 */
export async function prepareWifiShareHandover(): Promise<WifiShareHandover> {
    return withLock(async () => {
        const record = await readRecord();
        if (!record || record.status !== 'pending') {
            // Nothing to offer. Clean up any file a previous session left behind
            // so a stale copy can never be served on its own.
            await removeCredentialsFile();
            return { path: '', pending: false, ssid: record?.ssid ?? null };
        }
        const system = getFs();
        const path = system ? credentialsPath(system) : null;
        if (!system || !path) {
            return { path: '', pending: true, ssid: record.ssid };
        }
        try {
            await system.makeDirectory(`${path.slice(0, path.lastIndexOf('/') + 1)}`);
        } catch {
            // Already exists is the common case and expo does not distinguish it.
        }
        try {
            await system.writeText(
                path,
                serializeWifiCredential({ ssid: record.ssid, password: record.password })
            );
        } catch (e) {
            console.warn('[WifiShare] Could not export the credential for handover:', e);
            return { path: '', pending: true, ssid: record.ssid };
        }
        return { path, pending: true, ssid: record.ssid };
    });
}

/**
 * UN-EXPORT the credential, WITHOUT un-staging it.
 *
 * The counterpart to {@link prepareWifiShareHandover}, and the thing that makes
 * its own docstring true. `prepare()` writes the passphrase to a plain file so
 * the native side can read it, and justifies that on the grounds that the file
 * "exists for the length of a sync session rather than for the length of the
 * staging" — but only the reader's ack removed it. A session that ends any other
 * way (the reader never came into range, the user tapped Stop, the watchdog
 * fired) left the passphrase in `documentDirectory` in cleartext indefinitely,
 * which is exactly the window an `allowBackup` or a filesystem read is measured
 * against. So the SESSION removes it too, on every exit path.
 *
 * ONLY THE FILE. The AsyncStorage record stays `pending` on purpose: the user
 * staged a network and the reader has not taken it, so the next session must
 * re-export and re-offer it. Un-staging here would silently drop a handover
 * because the reader was out of range once.
 *
 * Best effort and never throws, like every other remover in this module.
 */
export async function discardWifiShareHandover(): Promise<void> {
    return withLock(removeCredentialsFile);
}

/**
 * THE WIPE. The reader acked the credential, so the passphrase leaves this phone.
 *
 * The record survives with its password blanked rather than being deleted, so
 * the card can say WHICH network went across — the network name is not a secret,
 * and "handed over" with no name is a strictly worse answer than the truth.
 * {@link clearWifiShare} is the button that removes even that.
 *
 * Idempotent: a second ack (or a reconcile after a missed event) is a no-op.
 */
export async function markWifiShareDelivered(): Promise<WifiShareRecord | null> {
    return withLock(async () => {
        const record = await readRecord();
        // The file goes FIRST and unconditionally. Native deletes it too, on the
        // ack; if either side is the only one that ran, the secret is still gone.
        await removeCredentialsFile();
        if (!record) return null;
        if (record.status === 'delivered') return record;
        const delivered: WifiShareRecord = {
            ...record,
            password: '',
            status: 'delivered',
            deliveredAt: Date.now(),
        };
        try {
            await writeRecord(delivered);
        } catch (e) {
            console.warn('[WifiShare] Could not record the handover:', e);
        }
        notify(delivered);
        return delivered;
    });
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/**
 * The one line the card shows under the network name, or null when nothing is
 * staged.
 *
 * Pure, and tested, for the same reason `describeSyncSession` is: this sentence
 * is the entire feedback channel for a handover the user cannot otherwise
 * observe — the reader acks nothing visibly, and the passphrase is invisible by
 * design.
 */
export function describeWifiShare(record: WifiShareRecord | null): string | null {
    if (!record) return null;
    if (record.status === 'delivered') {
        return `Handed over to the reader — ${record.ssid} is saved on it.`;
    }
    return record.password.length === 0
        ? `Will hand over ${record.ssid} (open network) on the next sync.`
        : `Will hand over ${record.ssid} on the next sync.`;
}
