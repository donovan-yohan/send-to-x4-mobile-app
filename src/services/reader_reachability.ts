/**
 * reader_reachability — "is the reader answering RIGHT NOW?", answered cheaply,
 * plus the phase vocabulary the send screens narrate a route with.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS: 15-25 SECONDS OF SILENCE, LOG-VERIFIED
 * ---------------------------------------------------------------------------
 * A host send tries the reader DIRECT first (`sendLoveNote`, `routeEpubSend`),
 * and the reader is ASLEEP almost all of the time. Asleep does not mean
 * "refused" — it means nothing answers, so every leg of the direct attempt has
 * to burn its own timeout before it can conclude that:
 *
 *     mkdir over HTTP        -> 10 s abort   (crosspoint_upload.ts ensureFolder)
 *     WebSocket connect/upload -> up to 300 s cap, seconds in practice
 *     …and the note path does that TWICE (frame, then id sidecar)
 *
 * Stacked, that is the ~15-25 s of nothing a user sees before the MAILBOX
 * fallback fires and succeeds in under a second. The delivery was never at
 * risk; the wait was pure discovery cost, paid in the one place a user is
 * watching a spinner.
 *
 * ONE SHORT QUESTION, ASKED FIRST. `/api/files?path=/` is a plain HTTP GET the
 * firmware answers immediately when it is awake, so a {@link READER_PROBE_TIMEOUT_MS}
 * abort separates "awake" from "asleep" in a quarter of the time the cheapest
 * leg of the real upload would take to fail. When the answer is "asleep" the
 * send goes straight to the mailbox.
 *
 * THE FAST SKIP IS AN OPTIMISATION, NEVER A GATE. Two rules keep it from ever
 * costing a delivery:
 *
 *   1. Callers only consult it when a mailbox fallback actually exists. With no
 *      mailbox the direct attempt is the ONLY thing that can deliver, so a probe
 *      that is wrong (reader on its own AP, a slow first association, a
 *      captive-portal DNS hiccup) must not be allowed to turn "slow" into
 *      "impossible".
 *   2. NO ANSWER FROM THE PROBE ITSELF means "unknown", and unknown resolves to
 *      REACHABLE — i.e. try direct, exactly as before. That covers every runtime
 *      where the probe cannot even be loaded (node tests, the web preview), so
 *      absence of information can never change a route.
 *
 * ---------------------------------------------------------------------------
 * THREE SOURCES, IN ORDER OF COST
 * ---------------------------------------------------------------------------
 *   HINT   ConnectionProvider already probes this exact endpoint on mount, on
 *          foreground and after every settings save, and publishes the result in
 *          `connectionStatus`. A send moments after one of those has a free,
 *          correct answer in hand; re-asking would be a second round trip for
 *          information the app is already displaying.
 *   CACHE  Our own last probe, per ip, within the same freshness window. This is
 *          what stops a seven-book batch from probing seven times.
 *   PROBE  The HTTP GET above. Only when neither of the above is fresh.
 *
 * {@link READER_REACHABILITY_FRESH_MS} is the ONE window for both stored
 * sources. It is short on purpose: a reader drops off the network when it goes
 * back to sleep, which happens on a timescale of tens of seconds, so a minute-old
 * observation is not evidence about now.
 */

/**
 * How old a reachability observation may be and still be trusted.
 *
 * 30 s. The reader sleeps on a tens-of-seconds timescale, so this is about as
 * long as an observation stays true; past it, asking again is cheaper than being
 * wrong (being wrong costs either a needless mailbox round trip or the full
 * stacked-timeout stall this module exists to remove).
 */
export const READER_REACHABILITY_FRESH_MS = 30_000;

/**
 * Abort for the fast-skip probe.
 *
 * DELIBERATELY SHORTER than `checkCrossPointConnection`'s own 5 s default: this
 * probe runs while a user is watching a send, and its only job is to separate
 * "answers immediately" (awake, on the LAN) from "does not answer". A reader
 * that needs more than 2.5 s to answer a directory listing is not going to make
 * the direct upload feel instant either, and the mailbox route costs under a
 * second.
 */
export const READER_PROBE_TIMEOUT_MS = 2500;

/**
 * What a send is doing, right now, in terms a user can act on.
 *
 * These exist because a phone CANNOT report upload bytes on the mailbox route —
 * `fetch` exposes no upload progress, so `publishLoveNote`/`publishBook` emit a
 * coarse 0 on entry and 100 on success. Rendering that 0 as a determinate "0%"
 * for the whole upload is the UI reading as "stuck". A phase line plus an
 * indeterminate spinner says the same amount of truth without the false
 * precision, and the direct route's real WS `PROGRESS:` acks still drive a real
 * bar on top of it.
 */
export type SendPhase = 'looking' | 'direct' | 'mailbox';

/**
 * The ONE wording per phase, so Compose and Device cannot narrate the same route
 * differently.
 *
 * 'looking' is named for what it is — discovery, not sending — because that is
 * the second the user is currently staring at an unexplained spinner through.
 */
export const SEND_PHASE_LABEL: Record<SendPhase, string> = {
    looking: 'Looking for the reader…',
    direct: 'Sending to their reader…',
    mailbox: 'Sending to the mailbox…',
};

/**
 * A reachability observation somebody else already made — in practice
 * ConnectionProvider's `connectionStatus`.
 *
 * `checkedAt` is `Date.now()` AT THE MOMENT THE PROBE RESOLVED, not when the
 * screen rendered. Without it there is no way to tell a result from one second
 * ago from one that has been sitting in a context since the app launched, and
 * trusting the latter is exactly the mistake that sends a note to the mailbox
 * while the reader sits awake on the desk.
 */
export interface ReaderReachabilityHint {
    reachable: boolean;
    checkedAt: number;
}

/** Where an answer came from. Carried so a test — and a log — can tell. */
export type ReaderReachabilitySource =
    /** A fresh {@link ReaderReachabilityHint} from the caller. */
    | 'hint'
    /** Our own probe, within {@link READER_REACHABILITY_FRESH_MS}. */
    | 'cache'
    /** A probe we just ran. */
    | 'probe'
    /** No probe in this runtime. Resolves to reachable — see the header, rule 2. */
    | 'unknown';

export interface ReaderReachability {
    reachable: boolean;
    source: ReaderReachabilitySource;
    /** Why the probe said no. Only ever set alongside `reachable: false`. */
    error?: string;
}

/**
 * The slice of `crosspoint_upload` this module needs.
 *
 * Declared structurally, and reached through the lazy-`require` seam the other
 * senders use, because `crosspoint_upload.ts` statically imports
 * `expo-file-system/legacy` -> `react-native`, which tsx/esbuild cannot parse. A
 * top-level import here would make every routing test that consults this module
 * impossible to write.
 */
export interface ReaderProbe {
    (
        ip: string,
        options?: { timeoutMs?: number; diagnostics?: boolean }
    ): Promise<{ success: boolean; error?: string }>;
}

// Metro defines `require` in every module and collects `require('<literal>')`
// statically, so the lazy load below is a normal bundle dependency. Under node's
// ESM loader the identifier does not exist — `typeof` on an undeclared name is
// safe, and the module degrades to "no probe" (source 'unknown'), which by rule
// 2 in the header leaves routing exactly as it was.
declare const require: ((id: string) => unknown) | undefined;

let probe: ReaderProbe | null = null;
let probeResolved = false;

/**
 * Replace the probe. Pass `null` to restore `checkCrossPointConnection`.
 *
 * TEST SEAM — the app never calls this.
 */
export function __setReaderProbe(next: ReaderProbe | null): void {
    probe = next;
    probeResolved = next !== null;
}

function getProbe(): ReaderProbe | null {
    if (!probeResolved) {
        probe = loadCrossPointProbe();
        probeResolved = true;
    }
    return probe;
}

function loadCrossPointProbe(): ReaderProbe | null {
    if (typeof require !== 'function') return null;
    try {
        const mod = require('./crosspoint_upload') as { checkCrossPointConnection?: unknown };
        if (mod && typeof mod.checkCrossPointConnection === 'function') {
            return mod.checkCrossPointConnection as ReaderProbe;
        }
    } catch {
        // Not a React Native runtime (node test, web preview). Handled by rule 2.
    }
    return null;
}

/**
 * The last answer OUR OWN probe produced, per reader host.
 *
 * PROBE RESULTS ONLY. Nothing else writes an entry here — in particular a failed
 * direct upload does not create one — so a runtime with no probe (every node
 * test) never populates this at all and can never carry state between sends.
 * {@link noteReaderUnreachable} refines an entry that already exists; it never
 * invents one, for the same reason.
 */
let cache: { ip: string; reachable: boolean; at: number; error?: string } | null = null;

/**
 * Forget the cached probe result.
 *
 * TEST SEAM, and the reason every test that drives a probe can start from a
 * known state. The app has no reason to call it: the freshness window already
 * expires the entry.
 */
export function __resetReaderReachability(): void {
    cache = null;
}

/** True when an observation made at `at` is still worth trusting at `now`. */
export function isReachabilityFresh(
    at: number | undefined | null,
    now: number = Date.now(),
    freshMs: number = READER_REACHABILITY_FRESH_MS
): boolean {
    if (typeof at !== 'number' || !Number.isFinite(at)) return false;
    const age = now - at;
    // A NEGATIVE age (a clock that jumped backwards, a caller stamping the
    // future) is not "extra fresh" — it is an observation this process cannot
    // reason about, so it is treated as stale and re-probed.
    return age >= 0 && age <= freshMs;
}

/**
 * Record that a direct attempt to `ip` found nobody home.
 *
 * A dead upload is a STRONGER observation than the probe that preceded it, and
 * the case it exists for is a multi-file batch: without this, book 2 of 7 would
 * re-run the whole stacked-timeout stall that book 1 already proved pointless.
 *
 * ONLY REFINES AN EXISTING ENTRY. It never creates one, so a runtime that never
 * probes (node tests, the web preview) still never has a cache to leak between
 * sends, and a single unreachable error can never start fast-skipping on a phone
 * that has not actually probed anything.
 */
export function noteReaderUnreachable(ip: string, error?: string): void {
    if (!cache || cache.ip !== ip) return;
    if (!isReachabilityFresh(cache.at)) return;
    cache = { ip, reachable: false, at: Date.now(), error: error || cache.error };
}

export interface ResolveReachabilityOptions {
    /** Freshness window override. Defaults to {@link READER_REACHABILITY_FRESH_MS}. */
    freshMs?: number;
    /** Probe abort override. Defaults to {@link READER_PROBE_TIMEOUT_MS}. */
    timeoutMs?: number;
    /** Injected clock, so freshness can be tested without waiting. */
    now?: number;
}

/**
 * Answer "is the reader answering?" as cheaply as this call can.
 *
 * Order is hint -> cache -> probe (see the header). NEVER THROWS: a probe that
 * rejects is reported as unreachable with its message, matching the return-not-
 * throw contract of every sender in this repo.
 *
 * A missing/blank ip resolves to 'unknown' rather than probing an empty host —
 * there is nothing to ask, and rule 2 says unknown must not change a route.
 */
export async function resolveReaderReachability(
    ip: string,
    hint?: ReaderReachabilityHint | null,
    options?: ResolveReachabilityOptions
): Promise<ReaderReachability> {
    const now = options?.now ?? Date.now();
    const freshMs = options?.freshMs ?? READER_REACHABILITY_FRESH_MS;

    if (
        hint &&
        typeof hint.reachable === 'boolean' &&
        isReachabilityFresh(hint.checkedAt, now, freshMs)
    ) {
        return { reachable: hint.reachable, source: 'hint' };
    }

    if (typeof ip !== 'string' || !ip.trim()) {
        return { reachable: true, source: 'unknown' };
    }

    if (cache && cache.ip === ip && isReachabilityFresh(cache.at, now, freshMs)) {
        return cache.reachable
            ? { reachable: true, source: 'cache' }
            : { reachable: false, source: 'cache', error: cache.error };
    }

    const p = getProbe();
    if (!p) return { reachable: true, source: 'unknown' };

    let answer: { success: boolean; error?: string };
    try {
        answer = await p(ip, {
            timeoutMs: options?.timeoutMs ?? READER_PROBE_TIMEOUT_MS,
            // The 3 s root-URL retry `checkCrossPointConnection` adds to enrich a
            // failure message is exactly the cost this probe exists to avoid: it
            // would more than double the worst case of a check whose whole point
            // is to be quick. The richer diagnostic still gets produced by
            // ConnectionProvider's own (unbounded-by-a-user-tap) check.
            diagnostics: false,
        });
    } catch (error) {
        // checkCrossPointConnection resolves rather than rejects today; this keeps
        // the never-throws contract independent of that staying true.
        answer = { success: false, error: String(error) };
    }

    cache = { ip, reachable: answer.success, at: Date.now(), error: answer.error };

    return answer.success
        ? { reachable: true, source: 'probe' }
        : { reachable: false, source: 'probe', error: answer.error };
}
