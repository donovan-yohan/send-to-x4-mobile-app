/**
 * wifi_ssid — "what network is this phone on", and what the WiFi-share sheet
 * should show while it finds out.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE FILE AND NOT A METHOD ON `reader_link`
 * ---------------------------------------------------------------------------
 * `services/reader_link` resolves the native module ALL OR NOTHING: if any one
 * of `join`/`leave`/`startProxy`/`stopProxy` is missing it treats the whole
 * module as absent, so that a drift between the Kotlin and the JS fails as
 * "rebuild required" at the button instead of `undefined is not a function`
 * mid-session with the radio held. That is the right rule for the sync path and
 * exactly the wrong rule here: adding `getCurrentSsid` to that set would make
 * every dev client built before this change report the SYNC feature as missing,
 * because of a prefill. So this file does its own, independent, tolerant lookup:
 * the function is either there or the read degrades to "type it yourself".
 *
 * ---------------------------------------------------------------------------
 * THE PURE HALF IS THE TESTED HALF
 * ---------------------------------------------------------------------------
 * The Kotlin (modules/reader-link/.../CurrentSsid.kt) cannot be compiled in this
 * workflow, so {@link normalizeSsid} exists on both sides and the rules are
 * pinned by `scripts/wifi-ssid.test.js` here. Re-normalising a value the native
 * side already normalised is not redundancy for its own sake: it is the only
 * executable statement of what a network name is allowed to be, and it also
 * covers a native module that is one build behind this file.
 */

// TYPE-ONLY, AND THAT IS LOAD-BEARING. `services/android_permissions` imports
// `react-native`, which cannot be loaded under node (its index.js uses syntax
// esbuild rejects), so a value import here would make every pure function in
// this file untestable. `import type` is erased at compile time, so this file
// stays node-importable and `scripts/wifi-ssid.test.js` can pin the rules.
// Composing "ask, then read" is therefore the CARD's job, not this file's.
import type { FineLocationState } from './android_permissions';

// ---------------------------------------------------------------------------
// The native read
// ---------------------------------------------------------------------------

/**
 * Why the SSID is or is not known. Produced by the Kotlin, mirrored here.
 *
 * `permission`  — location permission is not held. A prompt can fix it.
 * `no-wifi`     — the phone is not on a WiFi network at all. A prompt cannot.
 * `unavailable` — the platform gave nothing usable despite the permission
 *                 (location services off device-wide is the realistic case), or
 *                 there is no native module in this build.
 */
export type SsidReadReason = 'ok' | 'permission' | 'unavailable' | 'no-wifi';

export interface SsidReadResult {
    ssid: string | null;
    reason: SsidReadReason;
}

const REASONS: ReadonlyArray<SsidReadReason> = ['ok', 'permission', 'unavailable', 'no-wifi'];

/**
 * The one native call this file makes. Shape mirrors `getCurrentSsid` in
 * `ReaderLinkModule.kt`, which never rejects.
 */
export interface CurrentSsidNative {
    getCurrentSsid(): Promise<unknown>;
}

// Metro collects `require('<literal>')` statically, so the lazy load below is an
// ordinary bundle dependency. Under node's ESM loader the identifier does not
// exist — `typeof` on an undeclared name is safe — and the module degrades to
// "unavailable". Same idiom as services/wifi_share.ts and services/outbox.ts.
declare const require: ((id: string) => unknown) | undefined;

const NATIVE_MODULE_CANDIDATES: ReadonlyArray<string> = ['ReaderLink', 'ExpoReaderLink'];

let native: CurrentSsidNative | null = null;
let nativeResolved = false;

/** Replace the native module. Pass `null` to restore lazy resolution. TEST SEAM. */
export function __setCurrentSsidNative(next: CurrentSsidNative | null): void {
    native = next;
    nativeResolved = next !== null;
}

function getNative(): CurrentSsidNative | null {
    if (!nativeResolved) {
        native = loadNative();
        nativeResolved = true;
    }
    return native;
}

function loadNative(): CurrentSsidNative | null {
    if (typeof require !== 'function') return null;
    try {
        const core = require('expo-modules-core') as {
            requireOptionalNativeModule?: (name: string) => unknown;
        };
        if (typeof core?.requireOptionalNativeModule !== 'function') return null;
        for (const name of NATIVE_MODULE_CANDIDATES) {
            const mod = core.requireOptionalNativeModule(name) as Record<string, unknown> | null;
            const fn = mod && typeof mod === 'object' ? mod.getCurrentSsid : undefined;
            if (typeof fn === 'function') {
                // Bound to the module: expo's JSI host objects are not safe to
                // call detached from their receiver.
                const bound = (fn as () => Promise<unknown>).bind(mod);
                return { getCurrentSsid: () => bound() };
            }
        }
    } catch {
        // Not a React Native runtime, or a build that predates the function.
    }
    return null;
}

/**
 * Turn whatever came across the bridge into a {@link SsidReadResult}.
 *
 * Total, and pure. An untyped payload is the one thing a native module can hand
 * back after any refactor, and the failure of trusting it here is a crash inside
 * a settings sheet.
 */
export function coerceSsidRead(payload: unknown): SsidReadResult {
    if (!payload || typeof payload !== 'object') return { ssid: null, reason: 'unavailable' };
    const raw = payload as Record<string, unknown>;

    const ssid = normalizeSsid(typeof raw.ssid === 'string' ? raw.ssid : null);
    const declared = typeof raw.reason === 'string' ? (raw.reason as SsidReadReason) : null;
    const reason = declared && REASONS.includes(declared) ? declared : null;

    // The SSID is the fact; the reason is the label. A payload that carries a
    // usable name but a stale label is reported as `ok`, and one that claims
    // `ok` with nothing readable is not.
    if (ssid !== null) return { ssid, reason: 'ok' };
    if (reason === null || reason === 'ok') return { ssid: null, reason: 'unavailable' };
    return { ssid: null, reason };
}

/**
 * Read the current network name. NEVER REJECTS, NEVER PROMPTS.
 *
 * Prompting is the caller's decision and happens one layer up, in the card, so
 * that this can be called speculatively (the permission may already be held from
 * a previous visit) without a dialog appearing on a screen the user only opened
 * to change a password.
 */
export async function readCurrentSsid(): Promise<SsidReadResult> {
    const mod = getNative();
    if (!mod) return { ssid: null, reason: 'unavailable' };
    try {
        return coerceSsidRead(await mod.getCurrentSsid());
    } catch {
        return { ssid: null, reason: 'unavailable' };
    }
}

// ---------------------------------------------------------------------------
// normalizeSsid — pure, and mirrored byte for byte in CurrentSsid.kt
// ---------------------------------------------------------------------------

/** WifiManager.UNKNOWN_SSID. Compared case-insensitively; it is a platform string. */
const UNKNOWN_SSID = '<unknown ssid>';

/**
 * Turn whatever `WifiInfo.getSSID()` returned into a displayable network name,
 * or null.
 *
 * THE QUOTES ARE THE SIGNAL, not noise to strip and forget. Android documents
 * that a name it could decode as UTF-8 comes back SURROUNDED BY DOUBLE QUOTES,
 * and that anything else comes back as a bare string of hex digits or as the
 * literal `<unknown ssid>`. So a quoted value is by construction a real name and
 * the sentinel checks must not be applied to it — which is what keeps a network
 * genuinely called `0xCoffee` from being thrown away for looking like a hex dump.
 *
 * NOTHING INSIDE THE QUOTES IS TRIMMED. An SSID may legitimately begin or end
 * with a space, and this value is on its way to a reader that has to match it
 * byte for byte to join. Only a value that is blank all the way through is
 * rejected, because that is unusable as a prefill whatever it is.
 */
export function normalizeSsid(raw: string | null | undefined): string | null {
    if (typeof raw !== 'string') return null;
    const outer = raw.trim();
    if (outer.length === 0) return null;

    const quoted = outer.length >= 2 && outer.startsWith('"') && outer.endsWith('"');
    if (quoted) {
        const inner = outer.slice(1, -1);
        return inner.trim().length === 0 ? null : inner;
    }

    if (outer.toLowerCase() === UNKNOWN_SSID) return null;
    if (outer.slice(0, 2).toLowerCase() === '0x') return null;
    return outer;
}

// ---------------------------------------------------------------------------
// Permission state + read reason -> what the card renders
// ---------------------------------------------------------------------------

/**
 * The card's prefill affordance, as one value.
 *
 * `unsupported` — not Android. No button, no note, no explanation owed.
 * `offer`       — location is not held and can still be asked for. Explainer +
 *                 "Use current network".
 * `ready`       — location IS held and nothing has been read yet. Same button,
 *                 no explainer: there is nothing left to justify.
 * `filled`      — a name was read. The field has it, and it is still editable.
 * `no-wifi`     — the phone is not on WiFi. A one-line note; NO button, because
 *                 no permission grant would change the answer.
 * `denied`      — the user said no THIS TIME. A one-line note, and the button
 *                 stays: Android shows the dialog again on the second ask, and a
 *                 disappearing control would read as a punishment for declining.
 * `blocked`     — permanently denied. A one-line note and no button, because
 *                 `PermissionsAndroid.request` would resolve without showing
 *                 anything and the button would visibly do nothing.
 * `unavailable` — permission held (or irrelevant) and Android still said
 *                 nothing: location services off, or a build with no native
 *                 module. One-line note, no button.
 */
export type WifiPrefillState =
    | 'unsupported'
    | 'offer'
    | 'ready'
    | 'filled'
    | 'no-wifi'
    | 'denied'
    | 'blocked'
    | 'unavailable';

/**
 * The mapping, kept pure so `scripts/wifi-ssid.test.js` can pin every cell of it
 * without a renderer.
 *
 * ORDER IS THE DESIGN. The read outranks the permission wherever it is more
 * specific: a name we already have makes the permission moot (`filled` even if
 * the state says `unasked`, which is what an OEM that answers without location
 * looks like), and "you are not on WiFi" is a better thing to tell someone than
 * "you denied a permission", since it is the fact that actually blocks them.
 *
 * @param permission the last known {@link FineLocationState}
 * @param read the reason from the last {@link readCurrentSsid}, or null if the
 *   read has not been attempted yet
 */
export function describeWifiPrefill(
    permission: FineLocationState,
    read: SsidReadReason | null
): WifiPrefillState {
    if (permission === 'unsupported') return 'unsupported';
    if (read === 'ok') return 'filled';
    if (read === 'no-wifi') return 'no-wifi';
    if (permission === 'blocked') return 'blocked';
    if (permission === 'denied') return 'denied';
    if (permission !== 'granted') return 'offer';
    // Granted, and the platform still would not say. `permission` cannot
    // legitimately arrive here (the native side reports `unavailable` once the
    // grant is in place) but a native module one build behind could send it, and
    // it must not turn into a button that re-asks for something already held.
    if (read === 'unavailable' || read === 'permission') return 'unavailable';
    return 'ready';
}

/** Does {@link describeWifiPrefill}'s result put a button on the screen? */
export function wifiPrefillHasButton(state: WifiPrefillState): boolean {
    return state === 'offer' || state === 'ready' || state === 'denied';
}

/**
 * Does pressing that button REQUEST A PERMISSION, or just read?
 *
 * The only reason this is separate: `ready` means the grant is already in place,
 * and the app must not be able to fire a system dialog it does not need.
 */
export function wifiPrefillButtonRequests(state: WifiPrefillState): boolean {
    return state === 'offer' || state === 'denied';
}

/**
 * The one line shown under the network-name field for each state, or null when
 * the state has nothing worth saying.
 *
 * Every one of these is written to be readable by someone who does not know what
 * a permission is, and NONE of them tells the user they are stuck: the field is
 * editable in all seven states, and the copy says so wherever the automatic path
 * is closed.
 */
export const WIFI_PREFILL_NOTE: Readonly<Record<WifiPrefillState, string | null>> = {
    unsupported: null,
    offer:
        'Android only tells an app which network you are on if the app has location ' +
        'permission. Tap below to fill the name in, or just type it.',
    ready: null,
    filled: 'Filled in from the network this phone is on. Edit it if that is not the one.',
    'no-wifi': 'This phone is not on WiFi right now, so there is nothing to fill in. Type the network name.',
    denied: 'No problem — type the network name instead, or tap below to let Android fill it in.',
    blocked:
        'Location permission is turned off for this app, so Android will not share the ' +
        'network name. Type it as it appears in your WiFi settings.',
    unavailable:
        "Android did not return the network name — location services may be off. Type it as it " +
        "appears in your WiFi settings.",
};
