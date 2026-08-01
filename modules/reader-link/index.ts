/**
 * reader-link — typed JS binding for the Android native module that implements Appendix A3
 * (docs/xteink/mailbox-books-contract.md): the phone joins the reader's own AP as a peer and
 * hosts a read-only HTTP forwarder on that link, so the reader speaks the SAME mailbox contract
 * at the phone that it speaks at the internet.
 *
 * IMPORT PATH: this is a LOCAL Expo module, not an npm package. Import it by relative path —
 *   import { joinReaderAp } from '../../modules/reader-link';
 * (`package.json` `main` points at this file). Autolinking picks the native half up because
 * expo-modules-autolinking defaults `nativeModulesDir` to `./modules`; nothing needs adding to
 * app.config.ts. See android/build.gradle for the verification trail.
 *
 * WHAT THIS FILE IS FOR, AND WHAT IT IS NOT. It is a thin, honest mirror of the Kotlin surface —
 * including the parts the app does not use yet (`getStatus`, `onSessionEnd`). The APP does not go
 * through it: `src/services/reader_link.ts` resolves the native module BY NAME with
 * `requireOptionalNativeModule` so the JS half keeps typechecking, bundling and unit-testing under
 * node while the Kotlin half does not exist. It cannot import this file to get there, because the
 * `requireOptionalNativeModule` call below runs at module scope and drags `expo-modules-core` (and
 * therefore `react-native`) into a bundle node cannot parse.
 *
 * SO THIS FILE HOLDS NO CONSTANTS. It used to re-declare the firmware-facing ones —
 * the health path, the health BODY, the port, the session cap — a third time, next to
 * `ProxyContract.kt` and `src/services/reader_link.ts`, with nothing able to fail when the three
 * drifted. The health body in particular must match the firmware byte-for-byte or discovery fails
 * silently with both halves believing they are correct. The authorities are now:
 *   - `docs/xteink/mailbox-books-contract.md` A3 — the canonical wire block (path, body, port),
 *   - `android/.../ProxyContract.kt` — the native side of it,
 *   - `src/services/reader_link.ts` — the JS side of it,
 * and `scripts/reader-link-contract.test.js` fails when any two of those three disagree.
 *
 * ANDROID ONLY, AND ABSENT UNTIL THE NEXT NATIVE BUILD. `requireOptionalNativeModule` is
 * deliberate: the JS bundle must keep loading in a dev client that predates this module (and on
 * iOS), so callers check {@link isReaderLinkAvailable} first instead of crashing at import time.
 *
 * WHAT THE NATIVE SIDE WILL NEVER DO — relied on by callers, enforced in Kotlin:
 *   - forward anything but `GET`/`HEAD` on `/m/*`. Two paths are answered LOCALLY and are never
 *     forwarded, never fetched upstream and never reachable through any `allowedPathPrefix`: the
 *     `/cp-proxy` health answer, and the opt-in `/cp-wifi` handover (see
 *     {@link StartProxyOptions.wifiSharePath}), which is also the only path that accepts a method
 *     other than GET/HEAD — a `DELETE`, which is the reader's ack,
 *   - attach an `Authorization` header, or accept one from the peer link. The mailbox write token
 *     never crosses this boundary; there is no parameter here that could carry it,
 *   - read a file outside this app's own storage, or take a body over the bridge. See
 *     {@link StartProxyOptions.outboxManifestPath}.
 *
 * LOCAL SERVE (`outboxManifestPath`). The same four endpoints, answered from a queue the phone
 * already holds when the mailbox cannot be reached — a plane, a subway, a phone with no SIM. Local
 * items overlay remote ones rather than replacing them, and with neither available the answers are
 * section 2's honest empties (an empty `latest.txt`, an empty `books.txt`, a 404 for a body) so the
 * reader shows "nothing new" instead of a failed sync.
 */
import {
  NativeModule,
  requireOptionalNativeModule,
  type EventSubscription,
} from 'expo-modules-core';

// ---------------------------------------------------------------------------------------------
// Types
//
// NO CONTRACT CONSTANTS LIVE HERE — see the file header. The wire values (SSID, `/cp-proxy`, its
// body, the port, the session cap) are stated once in A3 and mirrored in exactly two places that a
// test compares: `ProxyContract.kt` and `src/services/reader_link.ts`.
// ---------------------------------------------------------------------------------------------

/**
 * Exactly the five states the native side emits. The vocabulary is shared with
 * `src/services/reader_link.ts`, which DROPS an unrecognised state (a dropped state would leave
 * `sync_session` wedged in `joining`), so adding one here is a two-file change.
 */
export type ReaderLinkLinkState =
    | 'joining'
    | 'joined'
    | 'lost'
    | 'unavailable'
    | 'released';

export type ReaderLinkProxyState = 'stopped' | 'listening';

/**
 * How this session can answer the reader, reported on every proxy event and by `getStatus`.
 *
 * - `upstream` — nothing queued locally; the pure forwarder A3 describes.
 * - `local` — items queued and NO reachable upstream. The zero-internet case: the phone answers
 *   `latest.txt` / `current.frame` / `books.txt` / `books/{id}` from its own outbox, and the reader
 *   cannot tell the difference.
 * - `merged` — items queued AND a reachable upstream. Local overlays remote: local wins on an id or
 *   filename collision, remote extras are still listed.
 *
 * Recomputed per request, so a phone that regains data mid-session moves from `local` to `merged`
 * without restarting anything.
 */
export type ReaderLinkProxyMode = 'upstream' | 'local' | 'merged';

/** Which side answered one request. `merged` only ever appears for `books.txt`. */
export type ReaderLinkAnswerSource = 'local' | 'upstream' | 'merged';

/** What an outbox item is. Notes are one 52272-byte frame; books are epub bytes. */
export type ReaderLinkOutboxKind = 'note' | 'book';

/**
 * `getStatus()` can also report `idle` — the state before any join has been attempted. It is not
 * an EVENT state (nothing transitions *to* idle), which is why the two types differ.
 */
export type ReaderLinkLinkStatusState = ReaderLinkLinkState | 'idle';

export type ReaderLinkSessionEndReason = 'stopped' | 'timeout' | 'linkLost';

export type JoinReaderApOptions = {
    /** Defaults to `ProxyContract.READER_AP_SSID` ('CrossPoint-Reader'). */
    ssid?: string;
    /**
     * WPA2 PSK, 8..63 chars, or omitted/empty for the open AP the firmware ships today. A3
     * requires a PSK for the unattended variant; the app stores it per reader
     * (`Settings.readerApPsk`).
     */
    passphrase?: string | null;
    /**
     * 0 = keep the request outstanding indefinitely (the queued-delivery watcher shape — A3 is
     * explicit that polling `startScan()` can miss a 45 s AP window outright, so the platform's
     * own matching is the mechanism). Otherwise clamped to 5_000..300_000 in native.
     */
    timeoutMs?: number;
};

export type JoinReaderApResult = {
    ssid: string;
    /** null when DHCP has not finished yet; `startProxy` waits for it. */
    peerIp: string | null;
};

export type StartProxyOptions = {
    /**
     * ORIGIN ONLY — `https://host[:port]`, no path. The reader supplies `/m/{boxId}/...` and the
     * proxy appends it verbatim, so pass the mailbox URL's origin, not the whole base.
     *
     * Native also accepts this under the name `mailboxOrigin` (that is what
     * `src/services/reader_link.ts` sends); passing both with DIFFERENT values is a startup error
     * rather than a silent pick.
     */
    upstreamOrigin: string;
    /**
     * The only path prefix the forwarder serves. Defaults to `/m/` (A3's literal rule). Pass the
     * full base path (`/m/{boxId}/`) for a mailbox mounted under a sub-path — that also pins the
     * box, which is strictly tighter. A bare `/` is refused.
     */
    allowedPathPrefix?: string;
    /**
     * Cross-check, not configuration: must equal `ProxyContract.HEALTH_PATH` ('/cp-proxy', A3).
     * Native refuses to start if the caller believes in a different discovery path than it answers.
     */
    healthPath?: string;
    /** Defaults to `ProxyContract.DEFAULT_PORT` (8080, A3). Must be >= 1024. */
    port?: number;
    /** Clamped to 60_000..1_800_000 in native. */
    sessionMaxMs?: number;
    /**
     * false (default) = forward over any internet-capable network, which is cellular whenever the
     * phone gave up its Wi-Fi association to join the peer AP, and home Wi-Fi under STA+STA.
     * true = pin TRANSPORT_CELLULAR. See UpstreamNetwork.kt for the full reasoning.
     */
    requireCellularUpstream?: boolean;
    /**
     * Absolute path (or `file://` URI) of the JS-owned outbox manifest —
     * `outboxManifestPath()` in `src/services/outbox.ts`. Omit it and the proxy is the pure
     * forwarder it was before.
     *
     * PATHS ONLY, NEVER BODIES. Native opens the manifest and every `bodyPath` it names itself and
     * re-reads them while the reader polls, so a 24 MiB epub never crosses the bridge. Every path
     * is canonicalised and refused unless it sits inside this app's own storage.
     *
     * PASSING THIS ALSO CHANGES WHEN `startProxy` FAILS: with at least one servable item queued, an
     * unreachable upstream is no longer fatal — the session starts in `local` mode instead of
     * rejecting with "no internet connection is available to forward to the mailbox". With nothing
     * queued the old behaviour is unchanged.
     */
    outboxManifestPath?: string;
    /**
     * Absolute path (or `file://` URI) of the two-line WiFi credential the phone is handing to the
     * reader — `prepareWifiShareHandover()` in `src/services/wifi_share.ts`. Omit it and the
     * local-only `/cp-wifi` endpoint does not exist for the session: every method on it 404s.
     *
     * OPT-IN, AND THAT IS THE SECURITY PROPERTY. This is the only endpoint in the module that
     * serves a secret, and the peer link is reachable by anything that associates with the
     * reader's AP, so a session that was not explicitly asked to share a network must not be
     * talkable into it.
     *
     * A PATH, NEVER THE VALUES, exactly like {@link outboxManifestPath}: native opens the file
     * itself, confines it to this app's own storage, and DELETES it when the reader acks with
     * `DELETE /cp-wifi`. A passphrase passed as an option field would sit in a record that a
     * validation message or an options dump could echo.
     */
    wifiSharePath?: string;
};

export type StartProxyResult = {
    state: 'listening';
    /** The phone's address on the peer link — the only address the listener is bound to. */
    ipv4: string;
    /** Same value as {@link ipv4}; both keys are emitted, see PeerApLink.linkBody's note. */
    address: string;
    port: number;
    healthPath: string;
    allowedPathPrefix: string;
    /** `http://{peerIp}:{port}` — the origin half of the base the reader must use. */
    readerBaseOrigin: string;
    upstreamTransport: string;
    upstreamMetered: boolean;
    sessionMaxMs: number;
    /** What this session can deliver. `local` means no internet is needed for it to work. */
    mode: ReaderLinkProxyMode;
    /** Servable outbox items at session start — the number the UI can promise to hand over. */
    localItems: number;
    /** Of those, the ones JS has not already marked delivered. */
    localPending: number;
    localNotes: number;
    localBooks: number;
    /**
     * Entries the manifest named that native REFUSED to serve: body missing, length disagreeing
     * with `bytes`, a note that is not exactly one frame, an unusable filename, or a path outside
     * the app's storage. Non-zero means a queued item will never leave, so it is worth showing.
     */
    localSkipped: number;
    /** Why the manifest could not be read at all, when it could not. */
    localError: string | null;
    /** True when the proxy started with no reachable upstream (it served locally anyway). */
    offline: boolean;
};

export type ReaderLinkStatus = {
    /** Recomputed on every call: an upstream that drops mid-session moves this to `local`. */
    mode: ReaderLinkProxyMode;
    local: {
        /** False when `startProxy` was called without `outboxManifestPath`. */
        enabled: boolean;
        manifestPath: string | null;
        items: number;
        pending: number;
        notes: number;
        books: number;
        /** Manifest entries native refused to serve. See `StartProxyResult.localSkipped`. */
        skipped: number;
        error: string | null;
        /**
         * Items whose LAST byte the reader has taken this session — the delivery confirmation.
         * Survives `stopProxy` until the next `startProxy`, so a JS layer that missed the events
         * can still reconcile after the session ended.
         */
        delivered: number;
        deliveredIds: string[];
        bytesServed: number;
        startedOffline: boolean;
    };
    /**
     * The WiFi handover's reconcile channel. TWO BOOLEANS ONLY — no SSID, no passphrase: a status
     * snapshot is exactly the sort of object that ends up pasted into a bug report.
     */
    wifi: {
        /** False when `startProxy` was called without `wifiSharePath`; `/cp-wifi` then 404s. */
        enabled: boolean;
        /** True once the reader acked. Survives `stopProxy` until the next `startProxy`. */
        delivered: boolean;
    };
    link: {
        state: ReaderLinkLinkStatusState;
        ssid: string | null;
        peerIp: string | null;
        joined: boolean;
    };
    proxy: {
        state: ReaderLinkProxyState;
        address: string | null;
        port: number;
        healthPath: string;
        sessionRemainingMs: number;
    };
    upstream: {
        transport: string;
        metered: boolean;
    };
    counters: {
        requests: number;
        bytes: number;
        lastStatus: number;
    };
    lastError: string | null;
};

export type LinkStateEvent = {
    state: ReaderLinkLinkState;
    ssid?: string | null;
    /** The phone's address on the peer link. Also present as `peerIp` (same value). */
    ipv4?: string | null;
    peerIp?: string | null;
    error?: string | null;
};

export type ProxyStateEvent = {
    state: ReaderLinkProxyState;
    ipv4?: string | null;
    address?: string | null;
    port?: number | null;
    healthPath?: string;
    allowedPathPrefix?: string;
    readerBaseOrigin?: string;
    upstreamTransport?: string;
    upstreamMetered?: boolean;
    sessionMaxMs?: number;
    /** `listening` only. See {@link ReaderLinkProxyMode}. */
    mode?: ReaderLinkProxyMode;
    localItems?: number;
    localPending?: number;
    localNotes?: number;
    localBooks?: number;
    localSkipped?: number;
    localError?: string | null;
    offline?: boolean;
    /**
     * `stopped` only — the session's final delivery tally, carried here because this is the last
     * event the JS session sees (see the note on `onSessionEnd` in src/services/reader_link.ts).
     * Every id listed had its LAST byte taken by the reader, so JS can mark it delivered and prune.
     */
    localDelivered?: number;
    localDeliveredIds?: string[];
    localBytesServed?: number;
    localEnabled?: boolean;
    error?: string | null;
};

export type ProxyActivityEvent = {
    method: string;
    /**
     * REDACTED: the boxId segment is replaced with a literal asterisk, so `/m/{boxId}/latest.txt`
     * arrives here with the capability stripped out. The boxId is the read capability for the
     * whole mailbox (§2), so it must never reach a status line, a console log or a crash report.
     */
    path: string;
    /** 0 when the request died before a response could be chosen. */
    status: number;
    bytes: number;
    durationMs: number;
    /** The `Range` header exactly as the reader sent it, when it sent one. */
    range?: string | null;
    note?: string | null;
    /** Same value as {@link note}. */
    error?: string | null;
    /** Which side produced this answer. Absent for the `/cp-proxy` health probe. */
    source?: ReaderLinkAnswerSource | null;
    mode?: ReaderLinkProxyMode | null;
    /**
     * The outbox item this request served, when it served one. Mirrors {@link LocalDeliveryEvent}
     * onto the stream the app already subscribes to, so a delivery is visible even to a JS build
     * that never learned `onLocalDelivery` — the two halves have no shared compile step.
     */
    localId?: string | null;
    /** True when this response carried the item's LAST byte. The delivery confirmation. */
    localComplete?: boolean;
};

/**
 * One body served from the phone's own outbox.
 *
 * `complete` is the field that matters. There are no acks anywhere in this protocol, so the only
 * delivery confirmation available is "the reader has now taken the last byte" — which is what this
 * says. A book crosses several reader windows, so expect several of these per item with
 * `complete: false` and exactly one with `complete: true`.
 */
export type LocalDeliveryEvent = {
    id: string;
    kind: ReaderLinkOutboxKind;
    /** Books only. */
    filename?: string | null;
    /** The item's total size. */
    bytes: number;
    /** Bytes written in THIS response. */
    servedBytes: number;
    rangeStart: number;
    rangeEnd: number;
    /** True when the answer was a 206. */
    partial: boolean;
    complete: boolean;
};

export type SessionEndEvent = {
    reason: ReaderLinkSessionEndReason;
    message?: string | null;
};

/**
 * The WiFi handover, as a state word AND NOTHING ELSE.
 *
 * There is no ssid field and no passphrase field here, and that is not an omission: the native
 * emit takes a single `String`, so there is no shape in which a credential could ride this event.
 * `/cp-wifi` requests produce no {@link ProxyActivityEvent} either, so this is the only trace one
 * leaves anywhere.
 *
 * - `served` — the credential went out on a `GET`. The reader has the bytes; it has not said it
 *   saved them, so the phone must keep holding the passphrase.
 * - `delivered` — the reader acked with `DELETE /cp-wifi`. Native has already removed the staged
 *   file by the time this arrives; this is what the JS half wipes its own staging on.
 */
export type WifiShareState = 'served' | 'delivered';

export type WifiShareEvent = {
    state: WifiShareState;
};

export type ReaderLinkModuleEvents = {
    onLinkState: (event: LinkStateEvent) => void;
    onProxyState: (event: ProxyStateEvent) => void;
    onProxyActivity: (event: ProxyActivityEvent) => void;
    onSessionEnd: (event: SessionEndEvent) => void;
    onLocalDelivery: (event: LocalDeliveryEvent) => void;
    onWifiShare: (event: WifiShareEvent) => void;
};

/**
 * Why the phone's own network name is or is not known. Mirrors the reason codes
 * in `CurrentSsid.kt`; `src/services/wifi_ssid.ts` maps them to what the
 * WiFi-share card shows.
 */
export type CurrentSsidReason = 'ok' | 'permission' | 'unavailable' | 'no-wifi';

export type CurrentSsidResult = {
    /** The network name, quotes already stripped, or null. */
    ssid: string | null;
    reason: CurrentSsidReason;
};

declare class ReaderLinkNativeModule extends NativeModule<ReaderLinkModuleEvents> {
    joinReaderAp(options: JoinReaderApOptions): Promise<JoinReaderApResult>;
    leaveReaderAp(): Promise<{ ok: boolean }>;
    startProxy(options: StartProxyOptions): Promise<StartProxyResult>;
    stopProxy(): Promise<{ ok: boolean }>;
    getStatus(): Promise<ReaderLinkStatus>;
    /**
     * Name of the Wi-Fi network THIS PHONE is on. NEVER REJECTS, and touches no
     * session state: it is a plain read, valid whether or not a sync has ever
     * run. Needs ACCESS_FINE_LOCATION, which the app requests from exactly one
     * button (see `src/services/android_permissions.ts`).
     *
     * ABSENT FROM ANY DEV CLIENT BUILT BEFORE THIS FUNCTION LANDED, which is why
     * `src/services/wifi_ssid.ts` resolves it independently and tolerantly
     * instead of going through `src/services/reader_link.ts` — that file treats
     * a missing method as "the whole module is missing" so a drift fails loudly
     * mid-sync, and a prefill must not be able to trip that.
     */
    getCurrentSsid(): Promise<CurrentSsidResult>;
}

// ---------------------------------------------------------------------------------------------
// Binding
// ---------------------------------------------------------------------------------------------

const nativeModule = requireOptionalNativeModule<ReaderLinkNativeModule>('ReaderLink');

const UNAVAILABLE =
    'The reader-link native module is not present in this build. It is Android-only and needs a ' +
    'native rebuild (expo run:android / a fresh dev-client APK) after modules/reader-link was added.';

export function isReaderLinkAvailable(): boolean {
    return nativeModule != null;
}

function requireModule(): ReaderLinkNativeModule {
    if (!nativeModule) throw new Error(UNAVAILABLE);
    return nativeModule;
}

export function joinReaderAp(
    options: JoinReaderApOptions = {}
): Promise<JoinReaderApResult> {
    return requireModule().joinReaderAp(options);
}

export function leaveReaderAp(): Promise<{ ok: boolean }> {
    return requireModule().leaveReaderAp();
}

export function startProxy(options: StartProxyOptions): Promise<StartProxyResult> {
    return requireModule().startProxy(options);
}

export function stopProxy(): Promise<{ ok: boolean }> {
    return requireModule().stopProxy();
}

export function getStatus(): Promise<ReaderLinkStatus> {
    return requireModule().getStatus();
}

/**
 * Current network name, or a reason there is none.
 *
 * DEGRADES instead of throwing, unlike every other wrapper in this file: a build
 * without the module (or an older one without this function) reports
 * `unavailable`, because the caller is a settings card whose fallback is a field
 * the user types into, not a session that must fail loudly.
 */
export function getCurrentSsid(): Promise<CurrentSsidResult> {
    if (!nativeModule || typeof nativeModule.getCurrentSsid !== 'function') {
        return Promise.resolve({ ssid: null, reason: 'unavailable' });
    }
    return nativeModule.getCurrentSsid();
}

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

/** A subscription that removes nothing — returned when the native module is absent. */
const NOOP_SUBSCRIPTION: EventSubscription = { remove() {} };

function subscribe<K extends keyof ReaderLinkModuleEvents>(
    event: K,
    listener: ReaderLinkModuleEvents[K]
): EventSubscription {
    if (!nativeModule) return NOOP_SUBSCRIPTION;
    return nativeModule.addListener(event, listener);
}

export function addLinkStateListener(
    listener: (event: LinkStateEvent) => void
): EventSubscription {
    return subscribe('onLinkState', listener);
}

export function addProxyStateListener(
    listener: (event: ProxyStateEvent) => void
): EventSubscription {
    return subscribe('onProxyState', listener);
}

export function addProxyActivityListener(
    listener: (event: ProxyActivityEvent) => void
): EventSubscription {
    return subscribe('onProxyActivity', listener);
}

export function addSessionEndListener(
    listener: (event: SessionEndEvent) => void
): EventSubscription {
    return subscribe('onSessionEnd', listener);
}

/**
 * Fires once per response that carried outbox bytes. Mark the item delivered (and prune) on
 * `complete`; the same fact also rides `onProxyActivity` as `localId` + `localComplete`, and the
 * session's whole tally is on the `stopped` proxy event and in `getStatus().local.deliveredIds`.
 */
export function addLocalDeliveryListener(
    listener: (event: LocalDeliveryEvent) => void
): EventSubscription {
    return subscribe('onLocalDelivery', listener);
}

/**
 * Fires on `served` and again on the reader's `delivered` ack. Wipe the staged credential on
 * `delivered` and NOT on `served`: the reader having the bytes is not the reader having saved
 * them, and the phone is the only copy left.
 */
export function addWifiShareListener(
    listener: (event: WifiShareEvent) => void
): EventSubscription {
    return subscribe('onWifiShare', listener);
}

/** Escape hatch for anything this wrapper has not typed yet. Null when unavailable. */
export default nativeModule;
