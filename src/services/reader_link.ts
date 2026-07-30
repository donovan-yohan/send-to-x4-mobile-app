/**
 * reader_link — the typed JS face of the `reader-link` Kotlin Expo module.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE NATIVE SIDE DOES (contract, docs/xteink/mailbox-books-contract.md A3)
 * ---------------------------------------------------------------------------
 * The reader raises its OWN access point in 'Sync with app' mode and runs no web
 * server on it — it is a pure HTTP *client* on its own AP. The phone joins that
 * AP as a PEER (`WifiNetworkSpecifier` + `ConnectivityManager.requestNetwork`,
 * so cellular stays the default route) and hosts a tiny HTTP forwarder on the
 * peer interface. The reader then speaks the ordinary mailbox contract at the
 * phone instead of at the internet: same paths, same dedup, same staging, one
 * different base URL.
 *
 * Three rules from A3 that this module's shape exists to enforce, and that a
 * "simplification" here would silently break:
 *
 *   1. **`GET|HEAD` only, and only under one path prefix.** The reader never
 *      publishes (its downloader issues GET, nothing else), so the forwarder is
 *      strictly read-only. Every other method and every other path is refused.
 *      ONE EXCEPTION, and it is not a forward: the local-only `/cp-wifi`
 *      handover accepts a `DELETE` as the reader's ack. It is classified before
 *      the forward prefix is consulted, so nothing about it can reach the
 *      mailbox — see {@link StartProxyOptions.wifiSharePath}.
 *   2. **The write token is NEVER proxied.** Reads are protected by the
 *      unguessable `boxId` in the path; only publish/status/DELETE are bearer
 *      authenticated. {@link StartProxyOptions} therefore has NO token field —
 *      not an optional one, not a nullable one — because the peer interface is
 *      reachable by anything that associates with an open AP.
 *   3. **`Range` and the `206`/`Content-Range`/`416` answers pass through
 *      verbatim.** The reader compares the total in `Content-Range` against the
 *      manifest's `bytes` on every window and restarts the download when they
 *      disagree, so a proxy that normalises a `206` into a `200` breaks resume
 *      in a way that looks like a corrupt book.
 *
 * The reader discovers the proxy by probing `192.168.4.2` … `.5` with a fixed,
 * **boxId-free** health path ({@link PROXY_HEALTH_PATH}) — see A3's security
 * finding: probing with `/m/{boxId}/…` would hand the read capability for the
 * whole mailbox to whatever stranger happened to take `.2` on an open AP. The
 * proxy MUST answer that path, so it is passed to `startProxy` from here rather
 * than hardcoded twice.
 *
 * ---------------------------------------------------------------------------
 * WHY THE NATIVE MODULE IS RESOLVED BY NAME AND NOT IMPORTED
 * ---------------------------------------------------------------------------
 * `modules/reader-link/index.ts` is the local Expo module's own JS entry, and it
 * is the right place for anything that wants the raw surface. This file does NOT
 * import it. It asks `expo-modules-core` for the module registered under
 * {@link NATIVE_MODULE_NAME} instead, for two reasons that both bite in practice:
 *
 *   - **The JS half must compile and bundle before the native half exists.** A
 *     static `import … from '../../modules/reader-link'` makes `tsc` and Metro
 *     hard-fail the entire app when that directory is absent or mid-edit. This
 *     app is verified by a capped `tsc` + node suite that never runs Gradle, so
 *     "the app still typechecks without the native build" is a gate, not a nicety.
 *   - **The dev client in the user's hand does not have the module yet.** Even
 *     with the JS present, `requireNativeModule` THROWS on a build that predates
 *     the Kotlin. `requireOptionalNativeModule` returns null instead, which is
 *     the difference between a status line that says "rebuild the app" and a red
 *     screen on launch.
 *
 * Both `expo-modules-core` and the lazy `require` idiom are load-bearing:
 * `expo-modules-core` pulls in `react-native` at module scope, which node's
 * loader cannot parse, so the node tests must be able to reach this file without
 * it. Same trick as `services/library.ts`.
 *
 * Everything here is either a pure function or a thin async pass-through, so the
 * ORCHESTRATION lives in `services/sync_session.ts` (a pure state machine over
 * this seam) where node tests can drive it.
 */

import { describeMailboxUrlProblem, normalizeMailboxUrl } from './mailbox_client';

// ---------------------------------------------------------------------------
// Constants shared with the firmware and the Kotlin module
// ---------------------------------------------------------------------------

/**
 * `Name("ReaderLink")` on the Kotlin `Module` definition.
 *
 * This string is a large part of the coupling between the two halves — change it
 * on one side and the app degrades to "rebuild required" forever, with no compile
 * error anywhere to say so, because the native side is resolved by NAME at
 * runtime (see the file header).
 */
export const NATIVE_MODULE_NAME = 'ReaderLink';

/**
 * Names tried, in order, when resolving the native module.
 *
 * Two rather than one because the Kotlin half is built in a separate pass with no
 * shared compile step to catch a rename, and `Expo`-prefixing a module name is a
 * common convention. A short candidate list turns a naming disagreement into a
 * working feature instead of a permanent "rebuild required"; a MISS still reports
 * the same, honest message.
 */
const NATIVE_MODULE_CANDIDATES: ReadonlyArray<string> = [NATIVE_MODULE_NAME, 'ExpoReaderLink'];

/**
 * The boxId-free health path the READER probes to find the proxy (A3).
 *
 * The reader walks the AP's DHCP range (`192.168.4.2` … `.5`, since
 * `AP_MAX_CONNECTIONS = 4`) issuing one plain-HTTP `GET` of this path per
 * candidate and only sends a real `/m/{boxId}/…` request to whichever answered.
 * It must therefore contain NO secret and be answerable before any mailbox
 * round-trip.
 */
export const PROXY_HEALTH_PATH = '/cp-proxy';

/**
 * Fixed listening port on the peer interface.
 *
 * Fixed rather than ephemeral because the reader has no way to be told a port:
 * it composes `http://{peerIp}:{port}` + the path of its own configured base and
 * probes. 8080 is unprivileged (an app cannot bind < 1024) and does not collide
 * with the reader's own 80/81, which are not even listening in this mode.
 */
export const PROXY_DEFAULT_PORT = 8080;

/**
 * Absolute session cap, in ms — the ONE budget both halves use.
 *
 * The native module arms its own watchdog from the value passed to `startProxy`
 * and `DEFAULT_SYNC_TIMEOUTS.sessionMs` is this same constant, so the JS deadline
 * and the native backstop expire together. They were independent (15 min in JS,
 * `ProxyContract.DEFAULT_SESSION_MAX_MS` = 30 min in Kotlin) and could drift with
 * nothing to notice: the native one is the cap that actually fires when the
 * screen is unmounted and nothing is ticking the state machine.
 *
 * Must stay inside Kotlin's clamp (`MIN_SESSION_MAX_MS` 1 min ..
 * `MAX_SESSION_MAX_MS` 30 min) or native silently uses a different number —
 * pinned by `scripts/reader-link-contract.test.js`.
 */
export const PROXY_SESSION_MAX_MS = 15 * 60_000;

/**
 * Shown to the user when this build has no `reader-link` native module.
 *
 * Names the remedy, because the state is not recoverable from inside the app:
 * the dev client has to be rebuilt and reinstalled.
 */
export const READER_LINK_UNAVAILABLE =
    "This build can't join the reader's WiFi yet — the reader-link module isn't in it. " +
    'Rebuild and reinstall the app, then try again.';

// ---------------------------------------------------------------------------
// Event payloads (mirrored by the Kotlin `Events(...)` declaration)
// ---------------------------------------------------------------------------

/**
 * Link lifecycle, as the Kotlin `NetworkCallback` reports it.
 *
 *   - `joining`     — the `NetworkRequest` is registered; the platform is
 *                     looking for the SSID (this may be sitting behind the
 *                     system's join-approval dialog).
 *   - `joined`      — `onAvailable`: the peer `Network` exists and `ipv4` is the
 *                     address the reader will probe.
 *   - `lost`        — `onLost`: the reader took its AP down, or we drifted out
 *                     of range. Mid-session this is the NORMAL end.
 *   - `unavailable` — `onUnavailable`: the SSID never appeared inside the
 *                     platform's own timeout, or the user refused the dialog.
 *   - `released`    — our own `leave()` completed and the request is gone.
 */
export type ReaderLinkLinkState = 'joining' | 'joined' | 'lost' | 'unavailable' | 'released';

/** Proxy lifecycle: bound and accepting, deliberately stopped, or broken. */
export type ReaderLinkProxyState = 'listening' | 'stopped' | 'error';

/**
 * WHERE the four contract endpoints are being answered from.
 *
 *   - `upstream` — forwarding to the real mailbox, the original A3 behaviour.
 *   - `local`    — the phone has NO route out and is serving the outbox off its
 *                  own disk. This is the whole point of the local-serve work:
 *                  airplane mode, a subway, a SIM-less phone on café Wi-Fi.
 *   - `merged`   — both. Local items overlay remote ones (local wins on a
 *                  colliding id or filename); remote extras are still listed.
 *   - `none`     — no upstream AND nothing queued. NOT an error: the contract is
 *                  answered honestly (empty `latest.txt`, empty `books.txt`,
 *                  `404` for a body) so the reader says "nothing new" rather
 *                  than showing a failure it cannot act on.
 */
export type ProxyServeMode = 'upstream' | 'local' | 'merged' | 'none';

/** Where one served response came from. */
export type ProxyServeSource = 'upstream' | 'local';

export interface ReaderLinkLinkEvent {
    kind: 'link';
    state: ReaderLinkLinkState;
    /** SSID the request was made for, echoed back. */
    ssid?: string | null;
    /** The phone's address ON THE PEER LINK — what the reader talks to. */
    ipv4?: string | null;
    error?: string | null;
}

export interface ReaderLinkProxyEvent {
    kind: 'proxy';
    state: ReaderLinkProxyState;
    ipv4?: string | null;
    port?: number | null;
    error?: string | null;
    /** Items the native side found in the manifest at start. `listening` only. */
    localItems?: number | null;
    /**
     * Manifest entries native REFUSED to serve (missing body, size mismatch, a
     * filename a `books.txt` line cannot carry). `listening` only.
     *
     * Surfaced rather than swallowed: a queued item that will never leave the
     * phone is otherwise invisible everywhere — the user sees "3 ready to hand
     * over" and the reader is offered two, forever.
     */
    localSkipped?: number | null;
    /**
     * THE RECONCILE CHANNEL, on the `stopped` event.
     *
     * Delivery is reported per response while the session runs, but an event can
     * be missed: expo POSTS events to the JS thread, so a reload (or an app the
     * OS backgrounded) between the last byte and the callback loses it. The
     * native side also keeps the id set for the whole session and puts it on the
     * one event the JS session is guaranteed to see, so a missed per-response
     * event still ends in a prune.
     */
    localDeliveredIds?: string[] | null;
}

/**
 * One outbox item's body left this phone. THE DELIVERY RECEIPT.
 *
 * Its own kind rather than an activity event, because the two are emitted for
 * the SAME response: folding it into `activity` would count one request twice
 * and add the body's bytes to the session total a second time. The activity
 * event still carries the same fact (see {@link ReaderLinkActivityEvent.itemId})
 * for a native build that predates this channel; the reducer dedups by id, so
 * hearing it twice marks nothing twice.
 */
export interface ReaderLinkDeliveryEvent {
    kind: 'delivery';
    /** Outbox item id — the note's dedup id, or the book's `books.txt` id. */
    itemId: string;
    /** True only when the LAST byte went out. See {@link ReaderLinkActivityEvent.complete}. */
    complete: boolean;
    /** Bytes of this item written in this response, when known. */
    bytes?: number | null;
    filename?: string | null;
    /** Always `local`: this event exists only on the outbox path. */
    source: 'local';
}

/**
 * One forwarded request, for the status line.
 *
 * Carries no body and no headers on purpose — the point is a live "something is
 * happening" signal, and the path already contains the box capability, so it is
 * never logged anywhere but on-screen.
 */
export interface ReaderLinkActivityEvent {
    kind: 'activity';
    method: string;
    path: string;
    /** Status the proxy relayed, or 0 when the upstream fetch never answered. */
    status: number;
    /** Body bytes forwarded, when known. */
    bytes?: number | null;
    /** The `Range` header as received, when the reader sent one. */
    range?: string | null;
    error?: string | null;
    /**
     * Which side answered this one request. Absent on a build whose native half
     * predates local-serve, which is why nothing branches on it being present.
     */
    source?: ProxyServeSource | null;
    /** Outbox item id, when the answer came from the phone's own queue. */
    itemId?: string | null;
    /**
     * True when the reader has now taken the WHOLE body of {@link itemId}.
     *
     * THE ONLY DELIVERY SIGNAL THAT EXISTS ANYWHERE. The mailbox contract has no
     * acks (§1) and the reader reports nothing, so "the last byte of this item
     * left the socket" is as close to a receipt as the system can get — and it is
     * only knowable on the LOCAL path, where the phone owns both ends. A book
     * crosses several `Range` windows, so this is false on every window but the
     * one that reaches the end.
     */
    complete?: boolean | null;
}

/**
 * A change in {@link ProxyServeMode}, on its own channel.
 *
 * Separate from {@link ReaderLinkProxyEvent} rather than a field on it, for a
 * reason that is easy to undo by accident: the proxy event's shape is asserted
 * key-for-key by `scripts/sync-session.test.js`, and the mode changes at moments
 * the proxy lifecycle does not — upstream dying mid-session flips `merged` to
 * `local` while the socket stays perfectly healthy.
 */
export interface ReaderLinkModeEvent {
    kind: 'mode';
    mode: ProxyServeMode;
    /** Items the native side found in the manifest and can serve. */
    localItems?: number | null;
    /** Whether the last upstream probe/forward succeeded. */
    upstreamOk?: boolean | null;
    /** Why upstream is unavailable, when it is. Advisory. */
    error?: string | null;
}

/**
 * The WiFi handover, as a state word AND NOTHING ELSE.
 *
 * WHY THERE IS NO SSID FIELD HERE. `/cp-wifi` is the one endpoint in the module
 * that serves a secret, so the native side gives it no telemetry at all: the
 * request produces no {@link ReaderLinkActivityEvent}, moves no request counter
 * and no byte counter, and this event's native emit takes a single string. There
 * is therefore no shape in which the credential could reach a status line, a
 * console log or a crash report — not even redacted, because "a credential was
 * asked for, and it was there" is itself the fact worth withholding.
 *
 * - `served` — the credential went out on a `GET`. The reader has the bytes and
 *   has NOT said it saved them, so the phone keeps holding the passphrase.
 * - `delivered` — the reader acked with `DELETE /cp-wifi`. Native removed the
 *   staged file before writing that ack, so by the time this arrives the file is
 *   already gone; this is the ONLY signal the JS staging is wiped on.
 */
export type ReaderLinkWifiState = 'served' | 'delivered';

export interface ReaderLinkWifiEvent {
    kind: 'wifi';
    state: ReaderLinkWifiState;
}

export type ReaderLinkEvent =
    | ReaderLinkLinkEvent
    | ReaderLinkProxyEvent
    | ReaderLinkActivityEvent
    | ReaderLinkModeEvent
    | ReaderLinkDeliveryEvent
    | ReaderLinkWifiEvent;

// ---------------------------------------------------------------------------
// Call shapes
// ---------------------------------------------------------------------------

export interface JoinOptions {
    /** `settings.apSsid` — 'CrossPoint-Reader' unless the user renamed it. */
    ssid: string;
    /**
     * WPA2 passphrase for the reader's AP, or '' / null for an open AP.
     *
     * The firmware's `AP_PASSWORD` is a compile-time `nullptr` today (open), and
     * A3 requires a PSK before the UNATTENDED variant ships. The app therefore
     * has to support both, and `settings.readerApPsk` starts empty.
     */
    passphrase?: string | null;
    /**
     * Absolute cap on the platform's search, in ms. Advisory: the platform has
     * its own timeout and `sync_session` runs the deadline that the UI believes.
     */
    timeoutMs?: number;
}

/**
 * Everything the forwarder needs — and, by construction, nothing else.
 *
 * NO TOKEN FIELD. See rule 2 in the file header: adding one here is how the
 * app's mailbox write credential would end up reachable from an open AP.
 */
export interface StartProxyOptions {
    /**
     * Scheme + authority of the real mailbox, e.g. `https://mail.example.net`.
     * The forwarder appends the request path VERBATIM.
     */
    mailboxOrigin: string;
    /**
     * The only path prefix the forwarder will serve. `/m/` for a mailbox at the
     * origin root; the full base path for a sub-path deployment. See
     * {@link describeProxyTarget}.
     */
    allowedPathPrefix: string;
    /** Health path the reader probes. Passed so it is defined in ONE place. */
    healthPath: string;
    port?: number;
    /**
     * Absolute cap on the native session, in ms. Passed so the module's watchdog
     * and the JS deadline are the same number rather than two that can drift; see
     * {@link PROXY_SESSION_MAX_MS}.
     */
    sessionMaxMs?: number;
    /**
     * Absolute path of `outbox/manifest.json` — the phone's LOCAL source.
     *
     * A PATH, NOT THE ITEMS, and that is the entire design of the local-serve
     * half. The native side opens the manifest, reads it at session start and on
     * demand, and streams each body straight off disk into the socket. Passing
     * bodies through the JS bridge would materialise a 24 MiB book as a base64
     * string plus a byte array — the OOM shape HANDOFF.md records against
     * `MAX_EPUB_BYTES` — at the exact moment the user is standing next to the
     * reader.
     *
     * OMITTED when the queue is empty or the runtime has no document directory
     * (node, web). The native side then behaves exactly as it did before local
     * serve existed: forward-only. An absent or unparseable manifest must be read
     * as "no local items" and never as an error — A3's zero-internet mode has to
     * answer the contract honestly rather than 5xx.
     *
     * Carries no secret: it is a path inside the app's own sandbox, and the
     * manifest holds ids the reader is about to be given anyway.
     */
    outboxManifestPath?: string;
    /**
     * Absolute path of the staged WiFi credential — `prepareWifiShareHandover()`
     * in `services/wifi_share.ts`. OMITTED when nothing is staged, and its
     * absence is what makes the feature opt-in: with no path the native
     * `/cp-wifi` endpoint does not exist for the session and 404s every method.
     *
     * A PATH, NOT THE VALUES, and unlike every other field on this object it
     * points at something that IS a secret. That is why it is a path: native
     * opens the file itself, confines it to this app's own storage, deletes it
     * the moment the reader acks, and never emits it — where an `ssid` /
     * `password` pair here would sit in a record that any native validation
     * message, and anything that ever dumps these options, could echo.
     *
     * This is also the one credential the app deliberately hands DOWN the peer
     * link, and the reason it is safe to: the link is the user's own reader on
     * an AP they can see, the value is the network the reader is being asked to
     * join, and the alternative is typing a WPA2 passphrase on e-ink. The
     * MAILBOX write token still has no field here and never will (rule 2).
     */
    wifiSharePath?: string;
}

export interface ProxyEndpoint {
    /** Address on the peer link. This is what the reader's probe will find. */
    ipv4: string;
    port: number;
}

/**
 * The Kotlin module's surface, as this file uses it.
 *
 * `addListener` is inherited from `expo-modules-core`'s `NativeModule` (which
 * extends `EventEmitter`), so the Kotlin side only declares its `Events(...)`
 * names — {@link EVENT_KINDS} — and its functions.
 */
export interface ReaderLinkNativeModule {
    join(options: JoinOptions): Promise<void>;
    leave(): Promise<void>;
    startProxy(options: StartProxyOptions): Promise<ProxyEndpoint>;
    stopProxy(): Promise<void>;
    addListener(eventName: string, listener: (payload: unknown) => void): { remove(): void };
}

/**
 * What `sync_session` (and the tests standing in for it) talk to.
 *
 * Normalised away from the native shape in two ways: the three native events
 * collapse into one discriminated `ReaderLinkEvent` stream, and every call
 * either resolves or rejects with a sentence a user could read.
 */
export interface ReaderLinkApi {
    /** False when the native module is missing — i.e. "rebuild required". */
    isAvailable(): boolean;
    join(options: JoinOptions): Promise<void>;
    leave(): Promise<void>;
    startProxy(options: StartProxyOptions): Promise<ProxyEndpoint>;
    stopProxy(): Promise<void>;
    /** Subscribe to the merged event stream. Returns an unsubscribe function. */
    subscribe(listener: (event: ReaderLinkEvent) => void): () => void;
}

// ---------------------------------------------------------------------------
// Proxy target — pure, and the only place the mailbox URL is taken apart
// ---------------------------------------------------------------------------

export interface ProxyTarget {
    ok: true;
    /** `scheme://authority`, no trailing slash. */
    origin: string;
    /** Path portion of the configured base ('' when the mailbox is at the root). */
    basePath: string;
    /** Value for {@link StartProxyOptions.allowedPathPrefix}. */
    allowedPathPrefix: string;
    /**
     * The base the READER should end up using, for display only.
     *
     * The reader composes this itself (peer origin + the path of its own stored
     * base); showing it is how a user can tell that the two halves agree about
     * which box they are talking about.
     */
    readerBase: string;
}

export interface ProxyTargetProblem {
    ok: false;
    error: string;
}

export type ProxyTargetResult = ProxyTarget | ProxyTargetProblem;

/**
 * Split the configured mailbox base into what the forwarder needs.
 *
 * The reader forwards through the proxy by keeping THE PATH OF ITS OWN BASE and
 * swapping only the origin, so the app's job is to hand the native side (a) the
 * origin to forward to and (b) the one prefix it is allowed to serve.
 *
 * The prefix is `/m/` for the ordinary deployment — A3's literal rule — but a
 * mailbox mounted under a sub-path (`https://host/mailbox/m/{boxId}`) would then
 * be refused by its own proxy, so in that case the whole base path becomes the
 * prefix. That is strictly TIGHTER than `/m/*` (it pins the box as well), and it
 * is why the prefix is computed here rather than hardcoded in Kotlin.
 *
 * Validation is delegated to `mailbox_client` so there is exactly one opinion in
 * the app about what a usable mailbox base is — including the rejections that
 * matter here: a query string or fragment would land in the middle of a
 * forwarded path, and embedded credentials would be handed to the reader.
 */
export function describeProxyTarget(mailboxUrl: string): ProxyTargetResult {
    const problem = describeMailboxUrlProblem(mailboxUrl);
    if (problem) return { ok: false, error: problem };

    // Non-empty and defect-free by the check above: scheme, host, no whitespace,
    // no query, no fragment, no credentials, trailing slashes already stripped.
    const base = normalizeMailboxUrl(mailboxUrl);
    const split = /^(https?:\/\/[^/]+)(\/.*)?$/i.exec(base);
    if (!split) {
        // Unreachable via describeMailboxUrlProblem; kept so a future relaxation
        // there cannot turn into an undefined origin passed to native code.
        return { ok: false, error: `Mailbox URL is not usable as a proxy target: ${base}` };
    }

    // THE SCHEME IS LOWERCASED, AND ONLY THE SCHEME.
    //
    // `checkMailboxBaseUrl` matches `^(https?)://` case-INSENSITIVELY and returns
    // the string as typed, so `HTTPS://mail.example.net/m/BOX` is a valid mailbox
    // base everywhere else in the app — publishing, notes and books all work with
    // it. Kotlin's `ORIGIN_PATTERN` is the stricter of the two validators, and an
    // origin it refuses makes `startProxy` throw and the session end as
    // `proxy-failed` while nothing else in the app looks broken. Per RFC 3986 the
    // scheme is case-insensitive, so folding it is not a change of meaning.
    //
    // The path is NOT touched: it carries the boxId capability, and "helpfully"
    // recasing it would ask the mailbox for a different, wrong box.
    const origin = split[1].replace(/^https?:\/\//i, match => match.toLowerCase());
    const basePath = split[2] ?? '';

    // A base with NO path is refused rather than served.
    //
    // The contract's base is `{origin}/m/{boxId}` (§2), and the whole read-side
    // security model is that the boxId in the path is the unguessable capability.
    // A root-mounted mailbox would leave nothing to gate on but `/`, which turns
    // the forwarder into an unrestricted GET relay to that origin for anything
    // that associates with an open AP. Refusing here — where the user can read
    // why — beats a proxy that runs and 403s every request the reader makes.
    if (!basePath) {
        return {
            ok: false,
            error:
                `Mailbox URL has no /m/<box-id> path ("${base}"), so it can't be served over the ` +
                "reader's WiFi. Use the full mailbox URL, the same one the reader stores.",
        };
    }

    const allowedPathPrefix = basePath.startsWith('/m/') ? '/m/' : `${basePath}/`;

    return {
        ok: true,
        origin,
        basePath,
        allowedPathPrefix,
        readerBase: `http://{phone}:${PROXY_DEFAULT_PORT}${basePath}`,
    };
}

/**
 * Build {@link StartProxyOptions} from a mailbox base, or explain why not.
 *
 * Exists so no caller assembles that object by hand: the object's *absences*
 * (no `Authorization`, no token, no method list) are the security property, and
 * an inline literal at a call site is where an extra field gets added.
 */
export function buildProxyOptions(
    mailboxUrl: string,
    port: number = PROXY_DEFAULT_PORT,
    sessionMaxMs: number = PROXY_SESSION_MAX_MS,
    outboxManifestPath?: string | null,
    wifiSharePath?: string | null
): { ok: true; options: StartProxyOptions } | ProxyTargetProblem {
    const target = describeProxyTarget(mailboxUrl);
    if (!target.ok) return target;
    const options: StartProxyOptions = {
        mailboxOrigin: target.origin,
        allowedPathPrefix: target.allowedPathPrefix,
        healthPath: PROXY_HEALTH_PATH,
        port,
        sessionMaxMs,
    };
    // ADDED ONLY WHEN THERE IS ONE. The key set of this object is asserted as a
    // set by `scripts/sync-session.test.js` precisely because its ABSENCES are
    // the security property, and "always present, sometimes empty" would make a
    // forward-only session indistinguishable from a mis-wired local one on the
    // native side.
    if (typeof outboxManifestPath === 'string' && outboxManifestPath.length > 0) {
        options.outboxManifestPath = outboxManifestPath;
    }
    // SAME RULE, AND IT MATTERS MORE HERE. An always-present key would make a
    // session that has nothing to share indistinguishable from one that does,
    // and the native side would then have to decide what an empty path means
    // for an endpoint whose whole safety property is that it does not exist
    // unless it was asked for.
    if (typeof wifiSharePath === 'string' && wifiSharePath.length > 0) {
        options.wifiSharePath = wifiSharePath;
    }
    return { ok: true, options };
}

// ---------------------------------------------------------------------------
// Native module resolution
// ---------------------------------------------------------------------------

// Metro defines `require` in every module and collects `require('<literal>')`
// statically, so the lazy load below is an ordinary bundle dependency. Under
// node's ESM loader the identifier does not exist — `typeof` on an undeclared
// name is safe — and the module degrades to "unavailable", which is exactly the
// state the tests want to drive. Same idiom as services/library.ts.
declare const require: ((id: string) => unknown) | undefined;

/**
 * Native function names to try for each call this file makes, in order.
 *
 * A single hardcoded name would be fine if the two halves shared a compile step.
 * They do not: the Kotlin is built in a separate pass, so a rename on either side
 * produces no error anywhere — just a feature that reports "rebuild required"
 * forever on a build that HAS the module. Two candidates each is enough to absorb
 * the one naming disagreement that actually shows up (bare verb vs.
 * `…ReaderAp` / `…MailboxProxy`), and a genuine miss still fails loudly with the
 * names it tried.
 */
const NATIVE_METHODS = {
    join: ['join', 'joinReaderAp'],
    leave: ['leave', 'leaveReaderAp'],
    startProxy: ['startProxy', 'startMailboxProxy'],
    stopProxy: ['stopProxy', 'stopMailboxProxy'],
} as const;

type NativeCall = keyof typeof NATIVE_METHODS;

/** A native module with every call this file needs already bound. */
interface ResolvedNative {
    join(options: unknown): Promise<unknown>;
    leave(): Promise<unknown>;
    startProxy(options: unknown): Promise<unknown>;
    stopProxy(): Promise<unknown>;
    addListener(eventName: string, listener: (payload: unknown) => void): { remove(): void };
}

let native: ResolvedNative | null = null;
let nativeResolved = false;

/**
 * Replace the native module. Pass `null` to restore lazy resolution.
 *
 * TEST SEAM — the app never calls this. Takes the RAW shape (whatever
 * `requireOptionalNativeModule` would have returned) so a test can exercise
 * either naming convention through the same resolver the app uses.
 */
export function __setReaderLinkNative(next: Partial<ReaderLinkNativeModule> | null): void {
    native = next ? resolveNative(next) : null;
    nativeResolved = next !== null;
}

function getNative(): ResolvedNative | null {
    if (!nativeResolved) {
        native = loadNative();
        nativeResolved = true;
    }
    return native;
}

function loadNative(): ResolvedNative | null {
    if (typeof require !== 'function') return null;
    try {
        const core = require('expo-modules-core') as {
            requireOptionalNativeModule?: (name: string) => unknown;
        };
        if (typeof core?.requireOptionalNativeModule !== 'function') return null;
        for (const name of NATIVE_MODULE_CANDIDATES) {
            const resolved = resolveNative(core.requireOptionalNativeModule(name));
            if (resolved) return resolved;
        }
    } catch {
        // Not a React Native runtime (node test, web). Callers see "unavailable".
    }
    return null;
}

/**
 * Bind every call, or reject the module.
 *
 * All-or-nothing on purpose. A partially-resolved module is the likely shape of a
 * drift between the Kotlin and this file, and it fails far more clearly as
 * "rebuild required" at the button than as `undefined is not a function` three
 * awaits deep, mid-session, with the radio already held.
 */
function resolveNative(value: unknown): ResolvedNative | null {
    if (!value || typeof value !== 'object') return null;
    const raw = value as Record<string, unknown>;
    if (typeof raw.addListener !== 'function') return null;

    const bound: Partial<Record<NativeCall, (...args: unknown[]) => Promise<unknown>>> = {};
    for (const call of Object.keys(NATIVE_METHODS) as NativeCall[]) {
        let found: ((...args: unknown[]) => Promise<unknown>) | null = null;
        for (const name of NATIVE_METHODS[call]) {
            const candidate = raw[name];
            if (typeof candidate === 'function') {
                // Bound to the module: expo's JSI host objects are not safe to
                // call detached from their receiver.
                found = (candidate as (...args: unknown[]) => Promise<unknown>).bind(raw);
                break;
            }
        }
        if (!found) return null;
        bound[call] = found;
    }

    const addListener = (raw.addListener as ResolvedNative['addListener']).bind(raw);
    return {
        join: options => bound.join!(options),
        leave: () => bound.leave!(),
        startProxy: options => bound.startProxy!(options),
        stopProxy: () => bound.stopProxy!(),
        addListener,
    };
}

/**
 * Native event name → the discriminant this module exposes.
 *
 * `onSessionEnd` IS DELIBERATELY NOT HERE, and it is worth saying why rather than
 * leaving it looking like an oversight. The Kotlin `endSession` tears the proxy
 * down BEFORE it emits that event, so `onProxyState: stopped` always arrives
 * first — and `sync_session`'s first-end-wins rule (which is what stops a
 * user-stop from being relabelled by a late `ap-lost`) would then discard the
 * later, better-informed one. So the native reason travels as the `error` string
 * on the `stopped` event instead, which the reducer keeps and the status line
 * prefers. Subscribing here as well would add a second end for the same fact.
 */
const EVENT_KINDS: ReadonlyArray<{ name: string; kind: ReaderLinkEvent['kind'] }> = [
    { name: 'onLinkState', kind: 'link' },
    { name: 'onProxyState', kind: 'proxy' },
    { name: 'onProxyActivity', kind: 'activity' },
    // Local-serve. A dev client whose Kotlin predates them simply never emits
    // these, and `subscribe` tolerates the name being undeclared — the session
    // then reports mode 'unknown', which every surface already renders as
    // silence.
    //
    // EVERY NAME HERE MUST APPEAR IN Kotlin's `Events(...)`, and every field the
    // coercions below read must appear in the map Kotlin sends. Neither is a
    // compile error on either side: an undeclared name makes `addListener` throw
    // (swallowed one loop iteration later) and a renamed field coerces to null,
    // so the feature reports nothing while every test stays green.
    // `scripts/reader-link-contract.test.js` greps both halves and fails on the
    // disagreement, which is the only thing that can.
    { name: 'onProxyMode', kind: 'mode' },
    { name: 'onLocalDelivery', kind: 'delivery' },
    // The WiFi handover. Contentless by construction (see ReaderLinkWifiEvent),
    // and the ONLY channel a `/cp-wifi` request has: native emits no activity
    // event for that target at all, so a build whose Kotlin predates this name
    // reports the handover nowhere rather than reporting it badly.
    { name: 'onWifiShare', kind: 'wifi' },
];

// ---------------------------------------------------------------------------
// Coercions — the JSI boundary is untyped, so nothing is trusted
// ---------------------------------------------------------------------------

function asOptionalString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function asOptionalNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

const LINK_STATES: ReadonlyArray<ReaderLinkLinkState> = [
    'joining',
    'joined',
    'lost',
    'unavailable',
    'released',
];

const PROXY_STATES: ReadonlyArray<ReaderLinkProxyState> = ['listening', 'stopped', 'error'];

const SERVE_MODES: ReadonlyArray<ProxyServeMode> = ['upstream', 'local', 'merged', 'none'];

const SERVE_SOURCES: ReadonlyArray<ProxyServeSource> = ['upstream', 'local'];

function asServeSource(value: unknown): ProxyServeSource | null {
    return typeof value === 'string' && SERVE_SOURCES.includes(value as ProxyServeSource)
        ? (value as ProxyServeSource)
        : null;
}

/**
 * A native list of ids, or null when the field is absent/unusable.
 *
 * Null and `[]` are DIFFERENT: an empty array means "the session handed nothing
 * over", which is a fact worth carrying, while null means "this build said
 * nothing", which must leave the key off the event entirely.
 */
function asIdList(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;
    return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function asOptionalBoolean(value: unknown): boolean | null {
    // Deliberately not truthiness: `complete` decides whether an item is marked
    // delivered and PRUNED off the phone, so a stray 0/''/'false' out of an
    // untyped bridge has to mean "no claim", not a confident answer either way.
    return typeof value === 'boolean' ? value : null;
}

/**
 * Turn one native payload into a `ReaderLinkEvent`, or null to drop it.
 *
 * Exported for the tests: an event whose `state` the JS does not recognise must
 * be DROPPED rather than forwarded, because `sync_session` reduces on the state
 * string and an unknown one would otherwise fall through every branch and leave
 * the session wedged in `joining` with no timeout having elapsed.
 */
export function coerceReaderLinkEvent(
    kind: ReaderLinkEvent['kind'],
    payload: unknown
): ReaderLinkEvent | null {
    const raw = asRecord(payload);
    if (kind === 'link') {
        const state = raw.state;
        if (typeof state !== 'string' || !LINK_STATES.includes(state as ReaderLinkLinkState)) {
            return null;
        }
        return {
            kind: 'link',
            state: state as ReaderLinkLinkState,
            ssid: asOptionalString(raw.ssid),
            ipv4: asOptionalString(raw.ipv4),
            error: asOptionalString(raw.error),
        };
    }
    if (kind === 'proxy') {
        const state = raw.state;
        if (typeof state !== 'string' || !PROXY_STATES.includes(state as ReaderLinkProxyState)) {
            return null;
        }
        const proxy: ReaderLinkProxyEvent = {
            kind: 'proxy',
            state: state as ReaderLinkProxyState,
            ipv4: asOptionalString(raw.ipv4),
            port: asOptionalNumber(raw.port),
            error: asOptionalString(raw.error),
        };
        // Local-serve extras, added ONLY when the native side sent them, so a
        // build that predates local serve produces exactly the object it always
        // did — the shape is asserted key-for-key by `scripts/sync-session.test.js`.
        const localItems = asOptionalNumber(raw.localItems);
        if (localItems !== null) proxy.localItems = localItems;
        const localSkipped = asOptionalNumber(raw.localSkipped);
        if (localSkipped !== null) proxy.localSkipped = localSkipped;
        const deliveredIds = asIdList(raw.localDeliveredIds);
        if (deliveredIds !== null) proxy.localDeliveredIds = deliveredIds;
        return proxy;
    }
    if (kind === 'delivery') {
        // An id is the whole point: without one there is nothing to mark
        // delivered, and a delivery event that names nothing must not be
        // forwarded as a fact about some unnamed item.
        const itemId = asOptionalString(raw.id) ?? asOptionalString(raw.itemId);
        if (itemId === null) return null;
        const delivery: ReaderLinkDeliveryEvent = {
            kind: 'delivery',
            itemId,
            // Anything but an explicit `true` means "no claim". Marking delivered
            // deletes bytes off the phone, so a coercion is never allowed to
            // invent the confirmation.
            complete: asOptionalBoolean(raw.complete) === true,
            source: 'local',
        };
        const bytes = asOptionalNumber(raw.servedBytes) ?? asOptionalNumber(raw.bytes);
        if (bytes !== null) delivery.bytes = bytes;
        const filename = asOptionalString(raw.filename);
        if (filename !== null) delivery.filename = filename;
        return delivery;
    }
    if (kind === 'wifi') {
        // ONE FIELD, AND IT IS AN ALLOWLIST. `delivered` makes the app delete a
        // passphrase the user typed, so an unrecognised state is dropped rather
        // than defaulted — and nothing else on the payload is read, so a native
        // build that ever grew a field here could not smuggle it into JS.
        const state = raw.state;
        if (state !== 'served' && state !== 'delivered') return null;
        return { kind: 'wifi', state };
    }
    if (kind === 'mode') {
        const mode = raw.mode;
        if (typeof mode !== 'string' || !SERVE_MODES.includes(mode as ProxyServeMode)) {
            // Dropped rather than defaulted: `sync_session` shows the mode to the
            // user as a claim about where the bytes are coming from, and a guess
            // there would tell someone in airplane mode that they are on the
            // internet (or the reverse).
            return null;
        }
        return {
            kind: 'mode',
            mode: mode as ProxyServeMode,
            localItems: asOptionalNumber(raw.localItems),
            upstreamOk: asOptionalBoolean(raw.upstreamOk),
            error: asOptionalString(raw.error),
        };
    }
    // Activity is advisory, so it is accepted with holes: a missing method or a
    // missing status still means "the reader asked for something", which is the
    // only thing the status line claims.
    const activity: ReaderLinkActivityEvent = {
        kind: 'activity',
        method: asOptionalString(raw.method) ?? '?',
        path: asOptionalString(raw.path) ?? '',
        status: asOptionalNumber(raw.status) ?? 0,
        bytes: asOptionalNumber(raw.bytes),
        range: asOptionalString(raw.range),
        error: asOptionalString(raw.error),
    };
    // The local-serve fields are added ONLY when the native side sent them, so a
    // build that predates local serve produces exactly the object it always did.
    //
    // BOTH SPELLINGS OF THE DELIVERY FIELDS, deliberately, and this is the
    // failure that made it necessary: MailboxProxyServer mirrors the delivery
    // fact onto the activity map as `localId` / `localComplete` (its own names,
    // chosen so the two local fields cannot be confused with the forwarded
    // request's own `bytes`), while this file was reading `itemId` / `complete`.
    // Both coerced to null, so `sync_session`'s delivery guard was false on
    // every request forever and NOTHING was ever marked delivered — with no
    // compile error and no failing test anywhere, because the two halves share
    // no compile step. Reading both names costs one `??` each.
    const source = asServeSource(raw.source);
    if (source !== null) activity.source = source;
    const itemId = asOptionalString(raw.itemId) ?? asOptionalString(raw.localId);
    if (itemId !== null) activity.itemId = itemId;
    const complete = asOptionalBoolean(raw.complete) ?? asOptionalBoolean(raw.localComplete);
    if (complete !== null) activity.complete = complete;
    return activity;
}

// ---------------------------------------------------------------------------
// The API
// ---------------------------------------------------------------------------

class ReaderLinkUnavailableError extends Error {
    constructor(detail?: string) {
        super(detail ? `${READER_LINK_UNAVAILABLE} (${detail})` : READER_LINK_UNAVAILABLE);
        this.name = 'ReaderLinkUnavailableError';
    }
}

/** True when `error` is the "this build has no native module" case. */
export function isReaderLinkUnavailableError(error: unknown): boolean {
    return error instanceof Error && error.name === 'ReaderLinkUnavailableError';
}

function requireNative(): ResolvedNative {
    const mod = getNative();
    if (!mod) throw new ReaderLinkUnavailableError();
    return mod;
}

/**
 * The default, real implementation.
 *
 * Every method is a pass-through: no retries, no state, no timers. Session
 * policy — deadlines, what counts as a normal end, what the user is told — is
 * `sync_session`'s, so that all of it is reachable from a node test.
 */
export const readerLink: ReaderLinkApi = {
    isAvailable(): boolean {
        return getNative() !== null;
    },

    async join(options: JoinOptions): Promise<void> {
        const mod = requireNative();
        // Normalised here so the native side never has to decide what an empty
        // passphrase means: '' and undefined both become null = OPEN network,
        // which is what the firmware ships today (`AP_PASSWORD = nullptr`).
        const passphrase =
            typeof options.passphrase === 'string' && options.passphrase.length > 0
                ? options.passphrase
                : null;
        await mod.join({
            ssid: options.ssid,
            passphrase,
            ...(options.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
        });
    },

    async leave(): Promise<void> {
        // Deliberately NOT `requireNative`: leave() is the teardown path, and a
        // teardown that throws because the module vanished would strand the
        // session's own cleanup. Nothing to release if there is no module.
        const mod = getNative();
        if (!mod) return;
        await mod.leave();
    },

    async startProxy(options: StartProxyOptions): Promise<ProxyEndpoint> {
        const mod = requireNative();
        // BOTH SPELLINGS OF THE ORIGIN KEY, deliberately.
        //
        // Expo's `Record` converter reads only the fields it declares and ignores
        // the rest, so sending `mailboxOrigin` and `upstreamOrigin` together costs
        // one string and makes this call work against either naming on the Kotlin
        // side. The two halves have no shared compile step, and the failure of
        // getting this wrong is a proxy that starts with an EMPTY upstream and
        // 502s every request the reader makes — which looks exactly like a dead
        // mailbox.
        const endpoint = await mod.startProxy({
            ...options,
            upstreamOrigin: options.mailboxOrigin,
        });
        const raw = asRecord(endpoint);
        // Same tolerance as the call: `ipv4` is the name this file asks for, `ip`
        // and `address` are what a native side written independently is likely to
        // have used. The value is only ever DISPLAYED (it is the address the reader
        // probes), so accepting an alias cannot mask a functional problem.
        const ipv4 =
            asOptionalString(raw.ipv4) ?? asOptionalString(raw.ip) ?? asOptionalString(raw.address);
        const port = asOptionalNumber(raw.port);
        if (!ipv4 || port == null) {
            throw new Error('The reader-link proxy started but reported no address to listen on.');
        }
        return { ipv4, port };
    },

    async stopProxy(): Promise<void> {
        const mod = getNative();
        if (!mod) return;
        await mod.stopProxy();
    },

    subscribe(listener: (event: ReaderLinkEvent) => void): () => void {
        const mod = getNative();
        if (!mod) return () => {};
        const subs: Array<{ remove(): void }> = [];
        for (const { name, kind } of EVENT_KINDS) {
            try {
                subs.push(
                    mod.addListener(name, payload => {
                        const event = coerceReaderLinkEvent(kind, payload);
                        if (event) listener(event);
                    })
                );
            } catch {
                // An event name this build's Kotlin does not declare. That is the
                // NORMAL state of every dev client older than the feature that
                // added it, and it must cost the OTHER subscriptions nothing —
                // losing `onLinkState` because `onProxyMode` is new would take the
                // whole session down instead of one optional signal.
            }
        }
        return () => {
            for (const sub of subs) {
                try {
                    sub.remove();
                } catch {
                    // A subscription can only fail to remove if the module is
                    // already gone, which is the state we were heading for.
                }
            }
        };
    },
};
