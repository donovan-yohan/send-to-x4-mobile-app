/**
 * sync_session — the 'Sync with reader' session, as a state machine.
 *
 * ---------------------------------------------------------------------------
 * WHY A REDUCER AND NOT `useState` IN THE SCREEN
 * ---------------------------------------------------------------------------
 * This session is driven by four independent clocks the app does not control:
 * the platform's SSID matching, the user's approval dialog, the reader's own AP
 * window (~45 s, then it tears down whether or not anything happened), and the
 * reader's poll loop. The interesting states are therefore all RACES —
 * "the AP disappeared while the proxy was coming up", "the user stopped it
 * between `onAvailable` and `startProxy` resolving", "the native module is
 * missing so nothing will ever fire" — and every one of them is unreachable
 * from a screen test, because a screen is the one place in this repo no test can
 * reach.
 *
 * So: {@link reduceSyncSession} is pure (events in, state out, no timers, no
 * `Date.now()`), {@link createSyncSession} is the thin wiring that turns a
 * {@link ReaderLinkApi} into dispatches, and the reader-link seam is INJECTABLE
 * so `scripts/sync-session.test.js` drives the whole thing under node.
 *
 * ---------------------------------------------------------------------------
 * THE STATES, AND WHAT EACH ONE PROMISES
 * ---------------------------------------------------------------------------
 *   idle       nothing running; no radio held, no listener registered.
 *   searching  a `NetworkRequest` is outstanding. The reader's AP has NOT been
 *              associated with yet — this covers both "the SSID is not on the
 *              air" and "the system approval dialog is up".
 *   joining    associated: the peer `Network` exists and we know our address on
 *              it, but the forwarder is not accepting yet.
 *   proxying   the forwarder is bound to the peer interface. From here the
 *              reader can probe {@link PROXY_HEALTH_PATH} and pull.
 *   ended      the session finished for an ordinary reason (see
 *              {@link SyncSessionEndReason}) — including the reader taking its
 *              AP down, which is how a SUCCESSFUL session normally ends.
 *   error      it finished for a reason the user has to act on.
 *
 * `ended` vs `error` is decided per TRANSITION, not derived from the reason:
 * losing the link is the normal end mid-session and a failure before the proxy
 * ever came up, and one reason string covers both.
 *
 * ---------------------------------------------------------------------------
 * THE READER ACKS NOTHING — SO NEITHER DOES THIS
 * ---------------------------------------------------------------------------
 * There is no "delivered" signal anywhere in the mailbox contract. What this
 * session can honestly report is what it SERVED: how many requests the reader
 * made through the proxy and how many bytes went out. It never claims a book
 * landed, because only the reader's SD card knows that.
 *
 * ONE EXCEPTION, AND ONLY ONE: an item served from the phone's own OUTBOX. On
 * that path the phone owns both ends of the socket, so "the last byte of item X
 * left this process" is a fact rather than an inference — not proof the reader
 * staged it, but the strongest receipt this system can produce, and enough to
 * stop offering the same note forever. It arrives as an activity event carrying
 * `itemId` + `complete`, and it is the ONLY thing that marks an outbox item
 * delivered or flips a History row to "Delivered directly".
 *
 * ---------------------------------------------------------------------------
 * ONE MORE THING RIDES THIS LINK, AND IT IS NOT MAILBOX TRAFFIC
 * ---------------------------------------------------------------------------
 * The reader also needs a home network, and typing a WPA2 passphrase on e-ink is
 * the worst interaction in the product. So a credential staged in
 * `services/wifi_share` is handed down the same peer link on its own local-only
 * path. This session's whole part in that is three lines: pass the staged file's
 * PATH to `startProxy` (absent = the endpoint does not exist), record the
 * reader's ack, and wipe the staging on it. The credential itself never enters
 * this module — see `ReaderLinkWifiEvent`, which carries a state word and
 * nothing else.
 *
 * ---------------------------------------------------------------------------
 * SERVE MODE — WHERE THE BYTES ARE ACTUALLY COMING FROM
 * ---------------------------------------------------------------------------
 * The proxy started life as a pure forwarder, which meant the phone needed
 * cellular for the reader to get anything. It no longer does: the session passes
 * the outbox manifest down, and the native side answers the four contract
 * endpoints from local disk, from upstream, or from both merged. {@link
 * SyncSession.mode} is that fact, and the UI says it out loud because "no
 * internet needed" is the part users cannot guess.
 */

import {
    PROXY_DEFAULT_PORT,
    PROXY_SESSION_MAX_MS,
    READER_LINK_UNAVAILABLE,
    buildProxyOptions,
    isReaderLinkUnavailableError,
    readerLink,
    type ProxyServeMode,
    type ReaderLinkApi,
    type ReaderLinkEvent,
} from './reader_link';
import { markDelivered, prepareOutboxHandover, supersedeQueuedNotes } from './outbox';
import { markNoteDeliveredDirectly, markNoteSuperseded } from './message_history';
import {
    discardWifiShareHandover,
    markWifiShareDelivered,
    prepareWifiShareHandover,
} from './wifi_share';

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export type SyncSessionState = 'idle' | 'searching' | 'joining' | 'proxying' | 'ended' | 'error';

/**
 * Why a session is no longer running.
 *
 * Ordinary ends: `user-stop`, `ap-lost`, `proxy-stopped`, `reader-quiet`,
 * `session-cap`. Failures: everything else.
 */
export type SyncSessionEndReason =
    | 'user-stop'
    | 'ap-lost'
    | 'proxy-stopped'
    | 'reader-quiet'
    | 'session-cap'
    | 'link-timeout'
    | 'ap-not-found'
    | 'native-missing'
    | 'join-failed'
    | 'proxy-failed'
    | 'not-configured';

/**
 * {@link ProxyServeMode}, plus the state before anything has said.
 *
 * 'unknown' is NOT folded into 'upstream'. A dev client whose Kotlin predates
 * local serve never emits a mode at all, and rendering that as "forwarding to
 * the mailbox" would be a claim about the user's data plan that nothing checked.
 */
export type SyncSessionMode = ProxyServeMode | 'unknown';

export interface SyncSession {
    state: SyncSessionState;
    /** SSID this session is for, kept after the end so the line still reads. */
    ssid: string | null;
    /** The phone's address on the peer link — what the reader probes. */
    peerIpv4: string | null;
    proxyPort: number | null;
    startedAt: number | null;
    endedAt: number | null;
    /**
     * Last time the session made observable progress: a state change, or a
     * request served. The `reader-quiet` deadline is measured from here, NOT from
     * `startedAt` — a long book download that is mid-flight keeps the session
     * alive precisely because activity keeps arriving.
     */
    lastProgressAt: number | null;
    reason: SyncSessionEndReason | null;
    /** A sentence for the user. Null unless there is something to explain. */
    error: string | null;
    /** Requests the reader made through the proxy. */
    requests: number;
    /** Body bytes forwarded, as far as the proxy could count them. */
    bytes: number;
    /** Path of the most recent request, for the live line. */
    lastPath: string | null;
    /** Where the answers are coming from. See {@link SyncSessionMode}. */
    mode: SyncSessionMode;
    /**
     * Whether the phone can reach the MAILBOX from where it is. `null` = no claim.
     *
     * Separate from {@link mode} because the two answer different questions and only one of them
     * was ever asked. `mode` says where the bytes the reader is getting came from; this says
     * whether the half that is NOT on this phone is available at all — and in `merged` mode they
     * come apart completely: local items keep flowing while every forward dies, which reads as a
     * perfectly healthy session on every other field in this object.
     *
     * Null on a dev client whose Kotlin predates the flag, which is why every branch below treats
     * it as a claim to be made only when it is explicitly `false`.
     */
    upstreamOk: boolean | null;
    /** Why {@link upstreamOk} is false, in the native side's own words. Shown verbatim. */
    upstreamError: string | null;
    /**
     * Items the phone offered from its own outbox when the proxy started.
     *
     * Set from the manifest this session handed down, so it is what the phone
     * BELIEVES it can serve — the native side may find fewer (a body deleted
     * from under it) and reports that separately as its own `localItems`.
     */
    localItems: number;
    /** Requests answered from the outbox rather than forwarded. */
    localServed: number;
    /**
     * Manifest entries the NATIVE side refused to serve.
     *
     * The JS queue and the Kotlin reader validate the same rules, so this should
     * be 0 — and when it is not, the item is one the user was told is "ready to
     * hand over" and which the reader will never be offered. Rendered, because
     * the alternative is a permanently undeliverable queue entry that is silent
     * on every surface.
     */
    localSkipped: number;
    /**
     * Outbox item ids the reader took WHOLE during this session, in order.
     *
     * The nearest thing to a receipt that exists (see the header). Drives the
     * outbox prune and the History row's "Delivered directly".
     */
    delivered: string[];
    /**
     * The staged WiFi credential was offered to the reader on this session.
     *
     * `served` only: the reader has the bytes. It is NOT a handover — see
     * {@link wifiHandedOver} — and nothing is deleted on it.
     */
    wifiOffered: boolean;
    /**
     * The reader ACKED the WiFi credential, so the passphrase has left this
     * phone.
     *
     * The only thing in this object that causes a secret to be deleted, and the
     * reason it is a separate field from {@link wifiOffered}: `served` says the
     * bytes went out of a socket, `delivered` says the reader asked us to stop
     * holding them. Only the second one is a receipt.
     */
    wifiHandedOver: boolean;
}

export type SyncSessionAction =
    | { type: 'start'; at: number; ssid: string }
    | { type: 'fail'; at: number; reason: SyncSessionEndReason; error: string }
    | { type: 'link'; at: number; event: Extract<ReaderLinkEvent, { kind: 'link' }> }
    | { type: 'proxy'; at: number; event: Extract<ReaderLinkEvent, { kind: 'proxy' }> }
    | { type: 'activity'; at: number; event: Extract<ReaderLinkEvent, { kind: 'activity' }> }
    | { type: 'mode'; at: number; event: Extract<ReaderLinkEvent, { kind: 'mode' }> }
    /**
     * A body left the phone. THE PRECISE DELIVERY CHANNEL.
     *
     * Separate from `activity` because native emits BOTH for one response: this
     * one carries only the receipt, so folding it in would count the request
     * twice and add the body's bytes to the session total a second time.
     */
    | { type: 'delivery'; at: number; event: Extract<ReaderLinkEvent, { kind: 'delivery' }> }
    /**
     * The WiFi credential was served, or acked. Carries no credential — the
     * native event has no field that could (see `ReaderLinkWifiEvent`).
     */
    | { type: 'wifi'; at: number; event: Extract<ReaderLinkEvent, { kind: 'wifi' }> }
    /**
     * What this session handed the native side from the outbox. NOT a mode: the
     * phone offering three items says nothing about whether upstream is also
     * reachable, and only the native side can answer that.
     */
    | { type: 'armed'; at: number; localItems: number }
    | { type: 'stop'; at: number }
    | { type: 'tick'; at: number };

export interface SyncSessionTimeouts {
    /**
     * From `start` until the proxy is listening.
     *
     * Generously longer than the reader's own ~45 s AP window: the user may be
     * walking to the reader, and the first join shows a system approval dialog
     * that they have to read. A too-short deadline here presents as "it never
     * finds my reader" on a link that would have come up.
     */
    linkMs: number;
    /**
     * Silence while `proxying` before the session gives up.
     *
     * The reader normally ends a session by taking its AP down, which arrives as
     * `link: lost`. This deadline only covers the case where that never happens
     * — reader crash, reader carried out of range with the AP still nominally up
     * — so it is long enough to sit through a book download's inter-request gaps.
     */
    idleMs: number;
    /**
     * Absolute cap. The phone is on cellular for the whole session (A3).
     *
     * ONE cap, not two: this value is also passed to the native `startProxy` as
     * `sessionMaxMs`, so the module's own watchdog and this deadline expire
     * together. They used to be independent (15 min here, 30 min in
     * `ProxyContract`), which meant the backstop that actually matters — the one
     * that fires when the screen is unmounted and nothing is ticking this machine
     * — ran on a budget nothing in the UI knew about.
     */
    sessionMs: number;
}

export const DEFAULT_SYNC_TIMEOUTS: SyncSessionTimeouts = {
    linkMs: 90_000,
    idleMs: 180_000,
    // Imported, not written again: `buildProxyOptions` defaults the native cap to
    // the same constant, so the two halves cannot drift apart silently.
    sessionMs: PROXY_SESSION_MAX_MS,
};

/**
 * Native `timeoutMs` = this much LESS than the JS link deadline.
 *
 * The two deadlines are racing to describe the same failure and the platform's
 * account is the better one: `onUnavailable` knows whether the SSID never
 * appeared or the user refused the dialog, where a JS tick can only say "gave up
 * waiting". Giving native the shorter budget makes it win, and the module adds
 * its own 2 s of grace on top of whatever it is given — which still lands inside
 * this margin.
 */
export const NATIVE_JOIN_MARGIN_MS = 5_000;

/** Mirrors `ProxyContract.MIN_JOIN_TIMEOUT_MS`; native clamps up to it anyway. */
const NATIVE_JOIN_FLOOR_MS = 5_000;

/**
 * The `timeoutMs` handed to the native join for a given JS link budget.
 *
 * 0 in, 0 out: that is the documented watcher mode (`JoinOptions.timeoutMs = 0`
 * keeps the request outstanding with no platform timeout, because A3 forbids
 * scanning), and shortening a budget that does not exist is meaningless.
 */
export function nativeJoinTimeoutMs(linkMs: number): number {
    if (!Number.isFinite(linkMs) || linkMs <= 0) return 0;
    return Math.max(NATIVE_JOIN_FLOOR_MS, Math.round(linkMs) - NATIVE_JOIN_MARGIN_MS);
}

const ACTIVE_STATES: ReadonlyArray<SyncSessionState> = ['searching', 'joining', 'proxying'];

/** True while the session holds the radio and a listener. */
export function isSyncSessionActive(state: SyncSessionState): boolean {
    return ACTIVE_STATES.includes(state);
}

export function initialSyncSession(): SyncSession {
    return {
        state: 'idle',
        ssid: null,
        peerIpv4: null,
        proxyPort: null,
        startedAt: null,
        endedAt: null,
        lastProgressAt: null,
        reason: null,
        error: null,
        requests: 0,
        bytes: 0,
        lastPath: null,
        mode: 'unknown',
        upstreamOk: null,
        upstreamError: null,
        localItems: 0,
        localServed: 0,
        localSkipped: 0,
        delivered: [],
        wifiOffered: false,
        wifiHandedOver: false,
    };
}

/**
 * Union of what is already recorded delivered with what native just named.
 *
 * Order-preserving and deduped: `delivered` drives both the prune and the
 * History patch, and `confirmDelivery` diffs it by LENGTH, so an id that moved
 * position would be re-confirmed (harmless) while a duplicate would be
 * confirmed twice (also harmless, but it would make the count lie).
 */
function mergeDelivered(current: string[], incoming: string[] | null | undefined): string[] {
    if (!Array.isArray(incoming) || incoming.length === 0) return current;
    const seen = new Set(current);
    const merged = [...current];
    for (const id of incoming) {
        if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
        seen.add(id);
        merged.push(id);
    }
    return merged.length === current.length ? current : merged;
}

/**
 * Fold one observed answer-source into the mode already believed.
 *
 * Monotonic on purpose: seeing local AND upstream in one session means `merged`
 * and stays there, because a session that forwarded a book and then served a note
 * off disk did both, and downgrading on the next request would make the line
 * flicker between two true-but-partial stories.
 */
function mergeServeMode(current: SyncSessionMode, observed: 'local' | 'upstream'): SyncSessionMode {
    if (current === 'merged') return 'merged';
    if (current === 'unknown' || current === 'none') return observed;
    return current === observed ? current : 'merged';
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/** Close a session out, preserving everything already learned about it. */
function finish(
    session: SyncSession,
    at: number,
    state: 'ended' | 'error',
    reason: SyncSessionEndReason,
    error: string | null
): SyncSession {
    return { ...session, state, endedAt: at, lastProgressAt: at, reason, error };
}

/**
 * The whole state machine. Pure: no timers, no clock, no I/O.
 *
 * Two invariants worth stating because they are what stops the UI from lying:
 *
 *   1. **A finished session never restarts itself.** Every action except `start`
 *      is IGNORED unless the session is active. Native events arrive after
 *      teardown as a matter of course (`leave()` produces `link: released`, and
 *      a `lost` can race a `stop`), and the first end wins — otherwise a
 *      user-stop would be overwritten by `ap-lost` a moment later and the line
 *      would blame the reader for something the user did.
 *   2. **Deadlines are only evaluated on `tick`.** Nothing here reads a clock,
 *      so a test can jump time by choosing `at`.
 */
export function reduceSyncSession(session: SyncSession, action: SyncSessionAction): SyncSession {
    if (action.type === 'start') {
        return {
            ...initialSyncSession(),
            state: 'searching',
            ssid: action.ssid,
            startedAt: action.at,
            lastProgressAt: action.at,
        };
    }

    if (!isSyncSessionActive(session.state)) return session;

    switch (action.type) {
        case 'fail':
            // `fail` is only ever dispatched for something the user has to act
            // on, so it always lands in `error`. Ordinary ends arrive as `stop`,
            // as a link/proxy event, or as a deadline.
            return finish(session, action.at, 'error', action.reason, action.error);

        case 'stop':
            return finish(session, action.at, 'ended', 'user-stop', null);

        case 'link': {
            const { state, ipv4, error } = action.event;
            switch (state) {
                case 'joining':
                    // Informational: the request is registered / re-associating.
                    // Progress, but not a state change — 'searching' already says
                    // "outstanding request, not associated yet".
                    return { ...session, lastProgressAt: action.at };

                case 'joined':
                    return {
                        ...session,
                        // Already proxying means a re-association mid-session; do
                        // not walk the state backwards and restart the proxy.
                        state: session.state === 'proxying' ? 'proxying' : 'joining',
                        peerIpv4: ipv4 ?? session.peerIpv4,
                        lastProgressAt: action.at,
                    };

                case 'lost':
                case 'released':
                    // Mid-session this is the ORDINARY end: the reader finished
                    // and called softAPdisconnect. Before the proxy was up it is
                    // a failure — the link went away while we were still setting
                    // up, so nothing was served.
                    return session.state === 'proxying'
                        ? finish(session, action.at, 'ended', 'ap-lost', null)
                        : finish(
                              session,
                              action.at,
                              'error',
                              'ap-lost',
                              error ??
                                  "The reader's WiFi went away before the link was ready. Put it back into Sync mode and try again."
                          );

                case 'unavailable':
                    return finish(
                        session,
                        action.at,
                        'error',
                        'ap-not-found',
                        error ??
                            `Couldn't find ${session.ssid ?? "the reader's WiFi"}. Put the reader into Sync mode, keep it close, and try again.`
                    );

                default:
                    return session;
            }
        }

        case 'proxy': {
            const { state, ipv4, port, error, localItems, localSkipped, localDeliveredIds } =
                action.event;
            switch (state) {
                case 'listening':
                    return {
                        ...session,
                        state: 'proxying',
                        peerIpv4: ipv4 ?? session.peerIpv4,
                        proxyPort: port ?? session.proxyPort ?? PROXY_DEFAULT_PORT,
                        // The NATIVE side's count, which beats the one `armed`
                        // carried: JS counted what the manifest said, native
                        // counted what it could actually open and serve.
                        localItems: localItems ?? session.localItems,
                        localSkipped: localSkipped ?? session.localSkipped,
                        lastProgressAt: action.at,
                    };

                case 'stopped':
                    // Unsolicited (a solicited stop has already ended the session
                    // via 'stop'). Not an error the user can act on, and NOT
                    // labelled 'ap-lost': the socket closing and the AP going away
                    // are different facts, and the AP's own 'lost' event usually
                    // follows this one and is then correctly ignored.
                    //
                    // `error` IS KEPT even though this is an ordinary end. It is
                    // the ONLY channel for a reason only the native side knows —
                    // above all its own session cap, which is the backstop that
                    // fires when the screen is unmounted and nothing is ticking
                    // this machine. The native module dedicates an `onSessionEnd`
                    // event to those reasons, but it always arrives AFTER this
                    // one, so the first-end-wins rule would discard it (see the
                    // note on EVENT_KINDS in reader_link.ts). `describeSyncSession`
                    // prefers this sentence when it is present.
                    //
                    // AND IT IS THE RECONCILE POINT. Native keeps the id set for
                    // the whole session and puts it here, so a per-response
                    // delivery event lost to a reload (expo POSTS events to the
                    // JS thread) still ends in a prune and a "Delivered directly"
                    // row. Merged BEFORE `finish`, so the controller's diff of
                    // `delivered` sees it and confirms it.
                    return finish(
                        { ...session, delivered: mergeDelivered(session.delivered, localDeliveredIds) },
                        action.at,
                        'ended',
                        'proxy-stopped',
                        error ?? null
                    );

                case 'error':
                    return finish(
                        session,
                        action.at,
                        'error',
                        'proxy-failed',
                        error ?? "The proxy couldn't run on the reader's WiFi."
                    );

                default:
                    return session;
            }
        }

        case 'activity': {
            // Only counted while proxying: an activity event in any other state
            // would mean the native side is serving on a link this session does
            // not believe it has.
            if (session.state !== 'proxying') return session;
            const { path, bytes, source, itemId, complete } = action.event;
            // An item is recorded delivered ONLY on an explicit `complete: true`
            // for a LOCAL answer with an id. Every other combination — a 206 that
            // was not the last window, an upstream forward, a build that sends no
            // such field — leaves the queue exactly as it was, because the cost of
            // a false positive is a note deleted off the phone that the reader
            // never actually got.
            const isDelivery =
                complete === true &&
                source === 'local' &&
                typeof itemId === 'string' &&
                itemId.length > 0 &&
                !session.delivered.includes(itemId);
            return {
                ...session,
                requests: session.requests + 1,
                // `bytes` is what the proxy actually forwarded, so a partial
                // (206) response contributes its own slice and a resumed
                // download adds up across windows rather than being counted from
                // zero. Nothing branches on the method: the forwarder has already
                // refused everything but GET/HEAD before the event is emitted.
                bytes: session.bytes + (bytes ?? 0),
                lastPath: path || session.lastPath,
                localServed: source === 'local' ? session.localServed + 1 : session.localServed,
                mode:
                    source === 'local' || source === 'upstream'
                        ? mergeServeMode(session.mode, source)
                        : session.mode,
                delivered: isDelivery ? [...session.delivered, itemId] : session.delivered,
                lastProgressAt: action.at,
            };
        }

        case 'delivery': {
            // Same rule as the activity path's `isDelivery`, and deliberately no
            // looser: an explicit `complete: true` for a named item, once. A
            // partial window (a book crosses several) records nothing, because
            // the cost of a false positive is bytes deleted off the phone that
            // the reader never got.
            if (session.state !== 'proxying') return session;
            const { itemId, complete } = action.event;
            if (complete !== true || typeof itemId !== 'string' || itemId.length === 0) {
                return session;
            }
            if (session.delivered.includes(itemId)) return session;
            return {
                ...session,
                delivered: [...session.delivered, itemId],
                lastProgressAt: action.at,
            };
        }

        case 'wifi': {
            // Counted as PROGRESS, because it is: the reader asking for the
            // credential is the reader talking to this phone, and a handover on a
            // session that is otherwise quiet must not have the quiet deadline
            // fire underneath it.
            if (session.state !== 'proxying') return session;
            const { state } = action.event;
            if (state === 'delivered') {
                return {
                    ...session,
                    wifiOffered: true,
                    wifiHandedOver: true,
                    lastProgressAt: action.at,
                };
            }
            // `served` is NOT a handover. The reader has the bytes and has said
            // nothing about saving them, and the phone holds the only copy of a
            // passphrase the user typed, so nothing is deleted on this branch.
            return { ...session, wifiOffered: true, lastProgressAt: action.at };
        }

        case 'mode': {
            // The native side's own account, and it beats anything inferred from
            // per-request sources: it is the half that knows whether the upstream
            // probe failed, which is the difference between 'merged' and 'local'.
            const { mode, localItems, upstreamOk, error } = action.event;
            return {
                ...session,
                mode,
                // KEPT, and this is the fix. Both of these crossed the bridge
                // already and were destructured away here, so the one thing the
                // native side knew and the app did not — "the mailbox cannot be
                // reached from this phone" — died at this line every time.
                //
                // `??`, not `||`: an explicit `false` is the whole point, and a
                // build that sends nothing must not overwrite what a previous
                // event established.
                upstreamOk: upstreamOk ?? session.upstreamOk,
                // Cleared when the upstream comes back, because a stale reason on
                // a healthy session is worse than none.
                upstreamError: upstreamOk === true ? null : (error ?? session.upstreamError),
                localItems: localItems ?? session.localItems,
                lastProgressAt: action.at,
            };
        }

        case 'armed':
            // Bookkeeping only — no mode claim, no progress. This fires while the
            // proxy is still coming up, and letting it reset the quiet deadline
            // would hide a reader that never pulled anything.
            return { ...session, localItems: action.localItems };

        case 'tick':
            // Uses the DEFAULT budgets. The controller does not route through
            // here — it calls `tickSyncSession` with its own — so a test that
            // wants custom budgets must do the same.
            return tickSyncSession(session, action.at, DEFAULT_SYNC_TIMEOUTS);

        default:
            return session;
    }
}

/**
 * Deadline evaluation, split out so a caller can supply its own budgets.
 *
 * ORDER MATTERS. The absolute cap is checked FIRST so a session that is both
 * over the cap and mid-download reports `session-cap` rather than looking
 * healthy forever, and the link deadline is checked before the quiet deadline so
 * a join that never completed is never reported as "the reader went quiet".
 */
export function tickSyncSession(
    session: SyncSession,
    at: number,
    timeouts: SyncSessionTimeouts = DEFAULT_SYNC_TIMEOUTS
): SyncSession {
    if (!isSyncSessionActive(session.state)) return session;

    const startedAt = session.startedAt ?? at;
    if (at - startedAt >= timeouts.sessionMs) {
        return finish(session, at, 'ended', 'session-cap', null);
    }

    if (session.state !== 'proxying' && at - startedAt >= timeouts.linkMs) {
        return finish(
            session,
            at,
            'error',
            'link-timeout',
            `Gave up waiting for ${session.ssid ?? "the reader's WiFi"}. The reader's Sync window is short — start it on the reader, then tap Sync here.`
        );
    }

    const lastProgressAt = session.lastProgressAt ?? startedAt;
    if (session.state === 'proxying' && at - lastProgressAt >= timeouts.idleMs) {
        return finish(session, at, 'ended', 'reader-quiet', null);
    }

    return session;
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** How much the session served, or null when it served nothing. */
function describeServed(session: SyncSession): string | null {
    if (session.requests === 0) return null;
    const requests = `${session.requests} request${session.requests === 1 ? '' : 's'}`;
    return session.bytes > 0 ? `${requests}, ${formatBytes(session.bytes)}` : requests;
}

/**
 * What the reader took OFF THE PHONE, or null when nothing was handed over.
 *
 * Deliberately separate from {@link describeServed}: requests and bytes describe
 * traffic, this describes a delivery — the only claim in this whole feature that
 * is stronger than "something went out of the socket".
 */
function describeHandedOver(session: SyncSession): string | null {
    const count = session.delivered.length;
    if (count === 0) return null;
    return `Handed over ${count} item${count === 1 ? '' : 's'} straight from this phone`;
}

/**
 * Queued items the native side REFUSED, or null when there are none.
 *
 * The JS queue and the Kotlin reader apply the same rules, so a non-zero count
 * means an item the user was promised is "ready to hand over" and which the
 * reader is never offered — a body that vanished from under the manifest, a
 * length that no longer matches, or a filename `books.txt` cannot carry. It is
 * counted natively (`localSkipped`) and was previously rendered nowhere at all,
 * which made a permanently undeliverable queue entry completely silent.
 */
function describeUnservable(session: SyncSession): string | null {
    const skipped = session.localSkipped;
    if (!Number.isFinite(skipped) || skipped <= 0) return null;
    return skipped === 1
        ? "1 queued item can't be handed over"
        : `${skipped} queued items can't be handed over`;
}

/**
 * One line about WHERE the bytes come from, or null when there is no claim to
 * make.
 *
 * Null for 'upstream' and 'unknown' on purpose: forwarding to the mailbox is
 * what this feature has always done and needs no narration, and 'unknown' is a
 * dev client older than local serve, where any wording would be a guess.
 */
export function describeSyncMode(session: SyncSession): string | null {
    // THE LINE THAT DID NOT EXIST, and the reason this function was rewritten.
    //
    // A session can hold the reader's hand for two minutes, hand over everything
    // queued, and never once reach the mailbox — and until now every surface in
    // the app said only encouraging things while it happened. 'local' with a
    // configured mailbox is not "no internet needed", it is "no internet FOUND",
    // and the two differ in the only way the user cares about: whether the notes
    // and books sitting in the mailbox are coming or not.
    //
    // Claimed only on an explicit `false` from native. A dev client that predates
    // the flag says nothing new, because a guess here would tell someone their
    // mailbox is unreachable on the strength of a field that was never sent.
    const unreachable = session.upstreamOk === false;
    switch (session.mode) {
        case 'local':
            return unreachable
                ? 'No internet through the phone — delivering queued items only. Anything waiting in the mailbox will not arrive.'
                : 'Serving from this phone — no internet needed.';
        case 'merged':
            // The case that was 100% invisible: an upstream is HELD, so the mode
            // is merged and every other signal reads healthy, while each forward
            // dies before a byte reaches the wire and is quietly relabelled as a
            // local answer.
            return unreachable
                ? "Couldn't reach the mailbox — handing over queued items only."
                : 'Serving from this phone and the mailbox together.';
        case 'none':
            // Honest, and specifically NOT an error: the contract is answered
            // with an empty latest.txt / empty books.txt, so the reader says
            // "nothing new" and goes back to sleep. Telling the user the sync
            // failed would send them hunting for a problem that is not there.
            return "Nothing queued and no route to the mailbox — the reader will find nothing new.";
        case 'upstream':
            // Nothing queued here, so a dead mailbox means this session can
            // deliver nothing at all — worth saying, where a working one is the
            // ordinary case and needs no narration.
            return unreachable ? "Couldn't reach the mailbox, and nothing is queued on this phone." : null;
        case 'unknown':
        default:
            return null;
    }
}

/**
 * The native side's own words for why the mailbox is out of reach, or null.
 *
 * Rendered verbatim under {@link describeSyncMode} rather than folded into it,
 * because the two are different kinds of statement: that one is what it means
 * for this handover, this one is the diagnosis ("the mailbox address could not
 * be looked up on this phone's cellular connection") and is the only thing that
 * distinguishes mobile data being off from a mailbox URL that can never resolve
 * off the home network. It is the difference between a user turning data on and
 * a user editing a setting, and nothing else in the app can tell them which.
 */
export function describeUpstreamProblem(session: SyncSession): string | null {
    if (session.upstreamOk !== false) return null;
    const detail = session.upstreamError;
    if (typeof detail !== 'string' || detail.trim().length === 0) return null;
    return asSentence(detail);
}

/**
 * Native reasons are engineer-shaped fragments ("the 15 minute session cap
 * expired"); the status line is a sentence. Capitalise and punctuate rather than
 * rewrite, because the fragment is the only account of what happened that exists.
 */
function asSentence(text: string): string {
    const trimmed = text.trim();
    if (!trimmed) return '';
    const head = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
    return /[.!?…]$/.test(head) ? head : `${head}.`;
}

/**
 * The one-line status the Library header shows.
 *
 * Pure, and tested, because this line is the ENTIRE feedback channel for a
 * feature whose failures are otherwise invisible: no reader ack, no server log,
 * and a radio the user cannot see. Every branch says what is true right now and
 * nothing more — in particular a finished session never claims delivery, only
 * what went out.
 */
export function describeSyncSession(session: SyncSession): string {
    const ssid = session.ssid ?? "the reader's WiFi";
    switch (session.state) {
        case 'idle':
            return 'Not syncing.';

        case 'searching':
            return `Looking for ${ssid}… start Sync on the reader if you haven't.`;

        case 'joining':
            return `Joined ${ssid} — opening the mailbox link…`;

        case 'proxying': {
            const where =
                session.peerIpv4 && session.proxyPort
                    ? ` at ${session.peerIpv4}:${session.proxyPort}`
                    : '';
            const served = describeServed(session);
            // Appended to whichever branch runs: an item native cannot serve is
            // true while the session is healthy, and it is the ONLY place the
            // fact appears anywhere in the app.
            const unservable = describeUnservable(session);
            const tail = unservable ? ` ${unservable}.` : '';
            // The SOURCE leads once it is local: "serving the mailbox" is an
            // outright wrong story for a phone in airplane mode, and it is the
            // story the user most needs corrected — they are about to conclude the
            // feature cannot work without a signal.
            const what = session.mode === 'local' ? 'Serving what you queued' : 'Serving the mailbox';
            if (served) return `${what} to the reader${where} · ${served}.${tail}`;
            const waiting = `Ready${where} — waiting for the reader to pull`;
            return session.mode === 'local' || session.mode === 'merged'
                ? `${waiting}. ${session.localItems > 0 ? `${session.localItems} queued here, no internet needed.` : 'No internet needed.'}${tail}`
                : `${waiting}.${tail}`;
        }

        case 'ended': {
            const served = describeServed(session);
            const handed = describeHandedOver(session);
            // A handover is the strongest true statement available, so it leads
            // the line whenever one happened — including over a native reason
            // string, which describes why the LINK ended, not what got through.
            if (handed) return served ? `${handed} · ${served}.` : `${handed}.`;
            // A native-initiated end (its own session cap, a link loss it noticed
            // first) carries the only account of WHY that exists anywhere. Prefer
            // it over this file's generic copy: "Reader finished and closed its
            // WiFi" would be an outright wrong story for a cap expiry.
            if (session.error) {
                const sentence = asSentence(session.error);
                return served ? `${sentence} Served ${served}.` : sentence;
            }
            switch (session.reason) {
                case 'user-stop':
                    return served ? `Stopped. Served ${served}.` : 'Stopped.';
                case 'ap-lost':
                case 'proxy-stopped':
                    return served
                        ? `Reader finished and closed its WiFi. Served ${served}.`
                        : "Reader closed its WiFi before it pulled anything. It may have run out of time — try again.";
                case 'reader-quiet':
                    return served
                        ? `Reader went quiet, so the link was closed. Served ${served}.`
                        : 'Reader never pulled anything, so the link was closed.';
                case 'session-cap':
                    return served
                        ? `Link closed after a long session. Served ${served}.`
                        : 'Link closed after a long session with nothing pulled.';
                default:
                    return served ? `Finished. Served ${served}.` : 'Finished.';
            }
        }

        case 'error':
            return session.error ?? "Couldn't sync with the reader.";

        default:
            return 'Not syncing.';
    }
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export interface SyncSessionStartOptions {
    /** `settings.apSsid`. */
    ssid: string;
    /** `settings.readerApPsk` — '' for the open AP the firmware ships today. */
    passphrase?: string;
    /** `settings.mailboxUrl` — the box the proxy forwards to. */
    mailboxUrl: string;
    /** Listening port on the peer link. Defaults to {@link PROXY_DEFAULT_PORT}. */
    port?: number;
}

export interface SyncSessionController {
    getSession(): SyncSession;
    /** Subscribe to session changes. Returns an unsubscribe function. */
    subscribe(listener: (session: SyncSession) => void): () => void;
    /** Begin a session. Resolves once the request is in flight, not once joined. */
    start(options: SyncSessionStartOptions): Promise<void>;
    /** End a session at the user's request. Safe to call when idle. */
    stop(): Promise<void>;
    /** Evaluate deadlines. The screen drives this on a 1 s interval. */
    tick(at?: number): void;
    /** Release the link and drop listeners, e.g. on teardown. */
    dispose(): Promise<void>;
}

/**
 * The outbox, as this session uses it.
 *
 * A PORT, not a direct import at the call sites, for the same reason the link is
 * one: the whole local-serve path — arm the manifest, serve it, mark what landed
 * — has to be drivable from a node test, and `services/outbox` touches both
 * AsyncStorage and expo-file-system.
 */
export interface SyncOutboxPort {
    /**
     * Re-export the manifest and report what is in it. MUST NOT THROW: this runs
     * on the critical path of a session the user is standing in front of, and a
     * queue that cannot be read is a forward-only session, not a failed one.
     */
    prepare(): Promise<{ manifestPath: string; pending: number }>;
    markDelivered(ids: string[]): Promise<void>;
}

/** The History patch a confirmed handover produces. */
export interface SyncHistoryPort {
    markDeliveredDirectly(noteId: string): Promise<boolean>;
}

/**
 * The WiFi credential staging, as this session uses it.
 *
 * A PORT for the same reason the outbox is one — `services/wifi_share` touches
 * AsyncStorage and expo-file-system — and a separate port rather than a field on
 * {@link SyncOutboxPort} because the two stores have deliberately nothing to do
 * with each other: one holds bodies the reader enumerates through the mailbox
 * contract, the other holds a passphrase that must never appear in a manifest.
 */
export interface SyncWifiSharePort {
    /**
     * Write the native-readable credential and report whether there is one. MUST
     * NOT THROW: a credential that cannot be staged is a sync without the WiFi
     * handover, never a failed sync.
     */
    prepare(): Promise<{ path: string; pending: boolean }>;
    /** THE WIPE. Called once, on the reader's ack, and never on `served`. */
    markDelivered(): Promise<void>;
    /**
     * DROP THE EXPORTED COPY, keeping the staging. Called on EVERY session exit,
     * acked or not, so the plaintext file `prepare()` wrote does not outlive the
     * session that asked for it. MUST NOT THROW.
     */
    discard(): Promise<void>;
}

const defaultOutboxPort: SyncOutboxPort = {
    async prepare() {
        // COLLAPSE THE NOTE QUEUE FIRST — the reader has exactly one note slot.
        //
        // `latest.txt` names ONE id and `current.frame` serves ONE body, so of N
        // queued notes only the newest is deliverable, ever. The older ones were
        // still counted in "N items ready to hand over", still exported in the
        // manifest, and still sitting in the queue after every session that
        // "succeeded" — a promise the system is structurally unable to keep, kept
        // forever. Doing it HERE means it happens before every handover no matter
        // which path queued them.
        //
        // Best-effort, always: a queue that cannot be collapsed is a queue that
        // gets handed over as it is, which is what happened before this existed.
        try {
            for (const noteId of await supersedeQueuedNotes()) {
                try {
                    await markNoteSuperseded(noteId);
                } catch (error) {
                    console.warn('[SyncSession] Could not mark', noteId, 'superseded:', error);
                }
            }
        } catch (error) {
            console.warn('[SyncSession] Could not collapse the queued notes:', error);
        }
        const { manifestPath, summary } = await prepareOutboxHandover();
        return { manifestPath, pending: summary.pending };
    },
    markDelivered,
};

const defaultHistoryPort: SyncHistoryPort = {
    markDeliveredDirectly: markNoteDeliveredDirectly,
};

const defaultWifiSharePort: SyncWifiSharePort = {
    async prepare() {
        const { path, pending } = await prepareWifiShareHandover();
        return { path, pending };
    },
    async markDelivered() {
        await markWifiShareDelivered();
    },
    discard: discardWifiShareHandover,
};

export interface SyncSessionDeps {
    /** Injected in tests; the app uses the real {@link readerLink}. */
    link?: ReaderLinkApi;
    now?: () => number;
    timeouts?: Partial<SyncSessionTimeouts>;
    /** Injected in tests; the app uses `services/outbox`. */
    outbox?: SyncOutboxPort;
    /** Injected in tests; the app uses `services/message_history`. */
    history?: SyncHistoryPort;
    /** Injected in tests; the app uses `services/wifi_share`. */
    wifiShare?: SyncWifiSharePort;
}

export function createSyncSession(deps: SyncSessionDeps = {}): SyncSessionController {
    const link = deps.link ?? readerLink;
    const now = deps.now ?? (() => Date.now());
    const timeouts: SyncSessionTimeouts = { ...DEFAULT_SYNC_TIMEOUTS, ...deps.timeouts };
    const outbox = deps.outbox ?? defaultOutboxPort;
    const history = deps.history ?? defaultHistoryPort;
    const wifiShare = deps.wifiShare ?? defaultWifiSharePort;

    let session = initialSyncSession();
    const listeners = new Set<(session: SyncSession) => void>();
    let unsubscribeLink: (() => void) | null = null;

    /**
     * Monotonic session token.
     *
     * Every async step re-checks it before dispatching. Without it, a
     * `startProxy` rejection belonging to session #1 lands on session #2 and
     * reports a failure the user is not having — the exact race a user creates by
     * tapping Stop and then Sync again.
     */
    let epoch = 0;

    /** The options of the session currently being brought up, or null. */
    let pending: { options: SyncSessionStartOptions; epoch: number } | null = null;

    /**
     * `proxying` is entered at most once per session.
     *
     * A re-association mid-session re-emits `joined`, and a second forwarder on
     * the same port would fail to bind and kill a healthy session.
     */
    let proxyStarted = false;

    /** In-flight native teardown, so `stop()` can await one that it did not start. */
    let releasing: Promise<void> | null = null;

    /**
     * True once this session has actually asked for the network.
     *
     * The pre-flight refusals — no native module, no usable mailbox URL — end the
     * session before `join()` is called, and a teardown there would be two native
     * calls against a request that was never registered. Everything past `attach()`
     * must release; nothing before it should.
     */
    let acquired = false;

    const emit = () => {
        // Copied: a listener is allowed to unsubscribe itself from inside the
        // callback (the screen does exactly that on unmount).
        for (const listener of [...listeners]) listener(session);
    };

    const detach = () => {
        if (!unsubscribeLink) return;
        const off = unsubscribeLink;
        unsubscribeLink = null;
        off();
    };

    /**
     * Give the radio back.
     *
     * BOTH calls always run, even if the first throws: a `NetworkRequest` left
     * registered is the failure that keeps the phone off its own Wi-Fi
     * indefinitely, long after this feature is out of sight.
     *
     * BOTH ARE ALSO *KICKED OFF* BEFORE EITHER IS AWAITED, and that is not a
     * micro-optimisation — awaiting `stopProxy()` first DEADLOCKS behind an
     * in-flight join. The native module serialises every entry point onto one
     * `reader-link-ops` thread, and a join parks that thread in a polling wait
     * loop; the only thing that breaks the loop is the cancel flag, which
     * `leaveReaderAp` sets on expo's own queue (NOT on `ops`) before its work is
     * queued. So a sequential release never reaches `leave()`: `stopProxy` sits
     * behind the join, the join sits waiting to be cancelled, and the peer
     * request is held for the whole join budget — indefinitely in the watcher
     * mode where `timeoutMs` is 0. Concretely: Sync with the reader not in Sync
     * mode → Stop → Sync again used to sit in `searching` for ~92 s and then die
     * with a bogus `link-timeout`.
     *
     * The native side also flips the cancel flag in `stopProxy` now, so no
     * caller ordering can reproduce it; this shape is the JS half of that fix.
     *
     * THE STAGED WIFI FILE GOES HERE TOO, and for the same "no exit path may
     * forget it" reason the two native calls are here. `wifiShare.prepare()`
     * writes the passphrase to a plain file in the app sandbox so the native
     * side can read it; before this, ONLY the reader's ack removed it, so every
     * session that ended without one — reader out of range, user taps Stop, the
     * watchdog fires — left cleartext on disk until the next stage or the next
     * successful handover. This is the single place every one of those exits
     * passes through. It removes the FILE only: the staging stays `pending` so
     * the next session re-offers the network the user asked for.
     */
    const releaseNative = (): Promise<void> => {
        // A native call that throws SYNCHRONOUSLY (a missing method, a fake in a
        // test) must not take the release down with it: this promise is awaited by
        // `stop()`, which is the panic button.
        const kick = (call: () => Promise<void>): Promise<void> => {
            try {
                return call();
            } catch {
                return Promise.resolve();
            }
        };
        const stopping = kick(() => link.stopProxy());
        const leaving = kick(() => link.leave());
        // Not ordered against the two above: it touches the app's own sandbox,
        // not the radio, and `kick` covers a port (a test fake, an older build)
        // that has no `discard` at all.
        const discarding = kick(() => wifiShare.discard());
        // `allSettled`, not `all`: "already closed", "the module is gone" and "the
        // request was never registered" are all non-events here. The session is
        // over either way, and a socket the OS will reclaim is not the user's
        // problem.
        const run = Promise.allSettled([stopping, leaving, discarding]).then(() => undefined);
        releasing = run;
        return run;
    };

    /**
     * Adopt a new state, and run everything that a state CHANGE implies.
     *
     * The single place where "the session is over" turns into "the radio is
     * released", so no exit path — user stop, AP lost, a deadline, a proxy error
     * — can forget it.
     */
    const commit = (next: SyncSession) => {
        if (next === session) return;
        const wasActive = isSyncSessionActive(session.state);
        session = next;
        if (wasActive && !isSyncSessionActive(session.state)) {
            // Drop the native listener FIRST, so a late event from a torn-down
            // link cannot be attributed to this session or to the next one.
            detach();
            pending = null;
            proxyStarted = false;
            if (acquired) {
                acquired = false;
                void releaseNative();
            }
        }
        emit();
        maybeStartProxy();
    };

    const dispatch = (action: SyncSessionAction) => {
        commit(reduceSyncSession(session, action));
    };

    /**
     * Persist what the reader actually took.
     *
     * Fire-and-forget, and deliberately AFTER the reducer has already recorded it:
     * the session's own count is what the UI renders, and it must not wait on
     * AsyncStorage or on a file delete. Every step swallows its own failure — a
     * queue entry that outlives its delivery is one redundant re-serve next
     * session, which is strictly better than an exception on the event path
     * tearing down a live link.
     */
    const confirmDelivery = async (ids: string[]): Promise<void> => {
        try {
            await outbox.markDelivered(ids);
        } catch (error) {
            console.warn('[SyncSession] Could not mark outbox items delivered:', error);
        }
        for (const id of ids) {
            try {
                // Book ids simply match no History row and return false; History
                // is the note store, and the Library is where books are accounted
                // for. A miss is not worth a warning.
                await history.markDeliveredDirectly(id);
            } catch (error) {
                console.warn('[SyncSession] Could not update history for', id, error);
            }
        }
    };

    /**
     * Wipe the staged WiFi credential, once the READER HAS ASKED US TO.
     *
     * Fire-and-forget and after the reducer, exactly like {@link confirmDelivery}:
     * this must not hold up the event path of a live link. Swallows its own
     * failure — a credential that survives its own handover is one redundant
     * re-offer next session, which is strictly better than an exception on the
     * event path tearing the link down.
     *
     * Guarded by the reducer's `wifiHandedOver` transition rather than by the raw
     * event, so a `served` (or a second `delivered`) can never reach it.
     */
    const confirmWifiHandover = async (): Promise<void> => {
        try {
            await wifiShare.markDelivered();
        } catch (error) {
            console.warn('[SyncSession] Could not clear the staged WiFi credential:', error);
        }
    };

    const attach = () => {
        detach();
        unsubscribeLink = link.subscribe(event => {
            const at = now();
            // The reducer decides what counts as a delivery (the `isDelivery`
            // guard, the `delivery` case, and the `stopped` reconcile). Diffing
            // its output rather than re-deriving the rule here is what stops the
            // two from drifting into double-marking or silently marking nothing
            // — and the diff wraps EVERY kind, because three different native
            // events can add an id: the mirrored fields on `activity`, the
            // precise `onLocalDelivery`, and the id set carried on the `stopped`
            // event that closes the session.
            const before = session.delivered.length;
            // Same discipline for the WiFi credential: the REDUCER decides that a
            // handover happened (only an explicit `delivered`, only while
            // proxying, only once), and this diffs its output. Re-deriving the
            // rule here is how the two would drift into wiping a passphrase the
            // reader never acked.
            const wifiBefore = session.wifiHandedOver;
            if (event.kind === 'link') dispatch({ type: 'link', at, event });
            else if (event.kind === 'proxy') dispatch({ type: 'proxy', at, event });
            else if (event.kind === 'mode') dispatch({ type: 'mode', at, event });
            else if (event.kind === 'delivery') dispatch({ type: 'delivery', at, event });
            else if (event.kind === 'wifi') dispatch({ type: 'wifi', at, event });
            else dispatch({ type: 'activity', at, event });
            const fresh = session.delivered.slice(before);
            if (fresh.length > 0) void confirmDelivery(fresh);
            if (!wifiBefore && session.wifiHandedOver) void confirmWifiHandover();
        });
    };

    /**
     * Bring the forwarder up once the peer link exists.
     *
     * Sequenced from JS rather than folded into the native `join` because the two
     * halves fail differently and the user has to be told which one broke: no AP
     * is "start Sync on the reader", a proxy that cannot bind is "something else
     * is on the port".
     */
    const maybeStartProxy = () => {
        if (proxyStarted || !pending) return;
        if (session.state !== 'joining') return;
        const { options, epoch: mine } = pending;
        if (mine !== epoch) return;
        proxyStarted = true;
        void (async () => {
            // ARM THE LOCAL SOURCE FIRST, and never let it fail the session.
            //
            // The manifest is re-exported here rather than at enqueue time only,
            // because the file is what the native side reads and the phone may
            // have been through an app restart, a cache clear or an OS file
            // eviction since anything was queued. A queue that cannot be read
            // leaves `manifestPath` empty, `buildProxyOptions` omits the key, and
            // the session is exactly the forward-only one that shipped before —
            // which is the correct degradation, not an error to show.
            let manifestPath = '';
            try {
                const prepared = await outbox.prepare();
                manifestPath = prepared.manifestPath;
                if (mine !== epoch) return;
                if (prepared.pending > 0) {
                    dispatch({ type: 'armed', at: now(), localItems: prepared.pending });
                }
            } catch (error) {
                console.warn('[SyncSession] Could not arm the handover queue:', error);
            }
            if (mine !== epoch) return;

            // ARM THE WIFI CREDENTIAL, on the same terms and with the same
            // degradation. Nothing staged (or no filesystem) leaves the path
            // empty, `buildProxyOptions` omits the key, and the native `/cp-wifi`
            // endpoint does not exist for this session — which is the correct
            // shape for a user who has never asked to share a network, not an
            // error to show. It is deliberately NOT dispatched anywhere: the
            // session says nothing about a credential until the reader has
            // actually asked for it.
            let wifiSharePath = '';
            try {
                const staged = await wifiShare.prepare();
                if (mine !== epoch) return;
                if (staged.pending) wifiSharePath = staged.path;
            } catch (error) {
                console.warn('[SyncSession] Could not arm the WiFi handover:', error);
            }
            if (mine !== epoch) return;

            const built = buildProxyOptions(
                options.mailboxUrl,
                options.port ?? PROXY_DEFAULT_PORT,
                timeouts.sessionMs,
                manifestPath,
                wifiSharePath
            );
            if (!built.ok) {
                // Unreachable: `start` validated the same string before joining.
                // Kept so a future change to that ordering fails loudly here
                // instead of handing native code an undefined origin.
                dispatch({ type: 'fail', at: now(), reason: 'not-configured', error: built.error });
                return;
            }
            try {
                const endpoint = await link.startProxy(built.options);
                if (mine !== epoch) return;
                // Synthesised rather than waited for. The native side also emits
                // `onProxyState: listening`; whichever arrives first wins, and
                // reducing the same fact twice is idempotent.
                dispatch({
                    type: 'proxy',
                    at: now(),
                    event: {
                        kind: 'proxy',
                        state: 'listening',
                        ipv4: endpoint.ipv4,
                        port: endpoint.port,
                    },
                });
            } catch (error) {
                if (mine !== epoch) return;
                dispatch({
                    type: 'fail',
                    at: now(),
                    reason: 'proxy-failed',
                    error: describeError(
                        error,
                        "Couldn't open the mailbox link on the reader's WiFi."
                    ),
                });
            }
        })();
    };

    const stop = async (): Promise<void> => {
        epoch += 1;
        if (isSyncSessionActive(session.state)) {
            // `commit` detaches and releases as part of the transition.
            dispatch({ type: 'stop', at: now() });
        } else {
            // Already finished (or never started). Release anyway — this is the
            // panic button, and "the state says idle but the request is still
            // registered" is precisely what it has to be able to fix.
            detach();
            pending = null;
            proxyStarted = false;
            acquired = false;
            void releaseNative();
        }
        await (releasing ?? Promise.resolve());
    };

    const start = async (options: SyncSessionStartOptions): Promise<void> => {
        // Tear down anything already running FIRST: two outstanding specifier
        // requests for one SSID is a platform state with no defined winner, and
        // the second forwarder could not bind the port anyway.
        if (isSyncSessionActive(session.state)) await stop();

        epoch += 1;
        const mine = epoch;
        pending = null;
        proxyStarted = false;

        dispatch({ type: 'start', at: now(), ssid: options.ssid });

        if (!link.isAvailable()) {
            dispatch({
                type: 'fail',
                at: now(),
                reason: 'native-missing',
                error: READER_LINK_UNAVAILABLE,
            });
            return;
        }

        // Validated BEFORE the radio is touched: joining the AP only to discover
        // there is no mailbox to forward to costs the user a system dialog and
        // their Wi-Fi association for nothing.
        const built = buildProxyOptions(
            options.mailboxUrl,
            options.port ?? PROXY_DEFAULT_PORT,
            timeouts.sessionMs
        );
        if (!built.ok) {
            dispatch({ type: 'fail', at: now(), reason: 'not-configured', error: built.error });
            return;
        }

        // WAIT OUT ANY TEARDOWN STILL IN FLIGHT.
        //
        // A session that ended on its own (the reader closed its AP) starts
        // `releaseNative()` and does not await it — the state is already correct
        // and nothing in the UI depends on the release. But that release ends in
        // `leave()`, and a user who taps Sync immediately afterwards would have
        // their brand-new `NetworkRequest` unregistered by the OLD session's
        // teardown. Failure mode: the join silently never happens and the session
        // sits in `searching` until the link deadline.
        if (releasing) {
            const pendingRelease = releasing;
            releasing = null;
            try {
                await pendingRelease;
            } catch {
                // releaseNative already swallows everything; this is belt-and-braces.
            }
            if (mine !== epoch) return;
        }

        pending = { options, epoch: mine };
        // From here on the session owns native state and every exit path has to
        // release it. Set before `attach()`, not after `join()`, because a join
        // that REJECTS may still have registered the request.
        acquired = true;
        // Subscribed BEFORE join() so an immediate `onAvailable` cannot be missed.
        attach();

        try {
            await link.join({
                ssid: options.ssid,
                passphrase: options.passphrase ?? null,
                // Deliberately SHORTER than this session's own link deadline, so
                // the platform's `onUnavailable` — which knows whether the SSID
                // was absent or the dialog was refused — wins the race against a
                // generic `link-timeout` tick. See {@link nativeJoinTimeoutMs}.
                timeoutMs: nativeJoinTimeoutMs(timeouts.linkMs),
            });
        } catch (error) {
            if (mine !== epoch) return;
            dispatch({
                type: 'fail',
                at: now(),
                // `isAvailable()` said yes a moment ago, so a "no native module"
                // rejection here means the module resolved but its surface did
                // not — a Kotlin/JS naming drift. That is a REBUILD, not a join
                // failure, and telling the user to "move closer to the reader"
                // would be advice they can never act on.
                reason: isReaderLinkUnavailableError(error) ? 'native-missing' : 'join-failed',
                error: describeError(error, `Couldn't ask to join ${options.ssid}.`),
            });
            return;
        }
        if (mine !== epoch) return;
        // The link can already be up here: on a re-join of an already-approved
        // specifier, `onAvailable` fires before `join()` resolves, and that
        // `joined` was reduced while `pending` was not yet set.
        maybeStartProxy();
    };

    return {
        getSession: () => session,

        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },

        start,
        stop,

        tick(at?: number): void {
            commit(tickSyncSession(session, at ?? now(), timeouts));
        },

        async dispose(): Promise<void> {
            await stop();
            listeners.clear();
        },
    };
}

function describeError(error: unknown, fallback: string): string {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === 'string' && error) return error;
    return fallback;
}

// ---------------------------------------------------------------------------
// The app's single session
// ---------------------------------------------------------------------------

let shared: SyncSessionController | null = null;

/**
 * The one session the UI talks to.
 *
 * A singleton because the thing it owns is a singleton: there is one radio, one
 * `NetworkRequest` and one listening port. A per-screen controller would let a
 * tab switch (which unmounts the Library screen) silently start a second one, or
 * lose the running session's state on the way back.
 */
export function getSyncSession(): SyncSessionController {
    if (!shared) shared = createSyncSession();
    return shared;
}

/**
 * Replace the shared session. Pass `null` to drop it.
 *
 * TEST SEAM — the app never calls this.
 */
export function __setSyncSession(next: SyncSessionController | null): void {
    shared = next;
}
