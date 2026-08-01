/**
 * deliverability — "can this phone get a note, a book or a sleep screen to the
 * reader, and by which road?", answered once, for every screen.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS: "NOT CONNECTED" WAS NEVER THE QUESTION
 * ---------------------------------------------------------------------------
 * The app grew up around ONE fact — `connectionStatus.connected`, i.e. "did the
 * reader answer an HTTP GET just now?" — and then spent that fact as though it
 * meant "can we deliver?". It does not. There are THREE roads to the reader and
 * only the first of them involves the reader answering anything:
 *
 *   DIRECT    the reader is awake on this LAN. The panel shows the note within
 *             seconds. Rare, because the reader sleeps with its radio off almost
 *             all of the time.
 *   MAILBOX   a URL + write token are configured, so the note is left in a box
 *             the reader ALREADY polls on its own schedule. Needs no reader, no
 *             proximity and no further taps.
 *   HANDOVER  the mailbox base is one this phone can SERVE over the reader's own
 *             access point, so the user can run Sync-with-reader whenever the two
 *             are in the same room and the phone hands the outbox over with no
 *             internet at all.
 *
 * ---------------------------------------------------------------------------
 * A ROAD IS A ROAD ONLY IF THIS BUILD CAN DRIVE IT
 * ---------------------------------------------------------------------------
 * The rule that keeps this module honest in BOTH directions: a route named here
 * must be one the user can actually take on the screen they are looking at. Not
 * "conceptually possible", not "the firmware supports it" — the affordance
 * exists and the code behind it will run.
 *
 * That is why handover is {@link isHandoverAvailable} and NOT "the reader's AP
 * passphrase is saved". The passphrase is not what gates Sync-with-reader:
 * `JoinOptions.passphrase` accepts '' (the shipping firmware's AP is open, and
 * '' is every install's default), while `sync_session.start` refuses before it
 * touches the radio unless `buildProxyOptions(mailboxUrl)` resolves — a phone
 * that joined the reader's AP with no upstream to forward to would drop off its
 * own WiFi and serve 502s. A model that promised "Next sync" on the strength of
 * a saved passphrase would point at a button that is not on the screen and park
 * bytes in an outbox whose only drain is that same session: stranded, forever,
 * which is a worse lie than the "Not connected" walls this module replaced.
 *
 * A screen that renders "Not connected — can't send" while a mailbox is
 * configured is stating something FALSE, and it is false in the most expensive
 * direction: it tells a user that a note they just wrote cannot be delivered
 * when the app is in fact about to deliver it. `ConnectionBanner` already
 * learned this the hard way and went silent whenever a mailbox covers the gap;
 * this module is that lesson, hoisted out of one component and made the shared
 * model, so Compose/History/Device/Wallpaper cannot each re-derive it and drift.
 *
 * ---------------------------------------------------------------------------
 * WHAT A "ROUTE" HERE PROMISES — THE FLOOR, NEVER THE CEILING
 * ---------------------------------------------------------------------------
 * {@link DeliverabilityRoute} is the road a send would take RIGHT NOW on the
 * evidence the app currently holds. Where the evidence is incomplete it names
 * the WORST road the send is guaranteed to find, never the best one it might:
 *
 *   reader reachability is stale + a mailbox exists  ->  'mailbox'
 *
 * even though the send's own fast skip (`reader_reachability`) may re-probe,
 * find the reader awake and upgrade itself to 'direct'. Under-promising is free
 * ("On its way" turning out to be "Delivered" costs a user nothing); over-
 * promising is the false-information bug this module exists to remove.
 *
 * The one place that rule inverts is when direct is the ONLY road: with no
 * mailbox and no evidence either way, the send WILL attempt the reader, so the
 * route is 'direct'. That mirrors rule 2 in `reader_reachability`'s header —
 * absence of information must never subtract a route — and it is why
 * {@link Deliverability.directNow} (evidence: the reader answered, recently) and
 * a `noteRoute` of 'direct' (behaviour: the send is going to try the reader) are
 * two different fields with two different meanings.
 *
 * ---------------------------------------------------------------------------
 * PURE, AND DELIBERATELY NOT TYPED TO `Settings`
 * ---------------------------------------------------------------------------
 * `services/settings.ts` imports AsyncStorage at module scope, so depending on
 * it here would make this module unloadable under node and every cell of the
 * truth table in `scripts/deliverability.test.js` unwritable. The input is a
 * plain structure the caller fills in one line — the same shape, and for the
 * same reason, as `love_note_sender`'s `LoveNoteDestination`. The React binding
 * lives next door in `services/useDeliverability.ts`.
 *
 * NO CLOCK OF ITS OWN BEYOND `Date.now()`: pass `now` and every answer here is
 * reproducible.
 */

import type { Role } from '../types';
import { isMailboxConfigured } from './love_note_sender';
import { isReachabilityFresh } from './reader_reachability';
import { describeProxyTarget } from './reader_link';
import { asRole } from './role';

/**
 * The road a send takes, in the order the app prefers them.
 *
 * 'handover-only' is spelled with the qualifier ON PURPOSE. Handover is not a
 * road a send can drive by itself: nothing is delivered until the user runs
 * Sync-with-reader in the reader's physical presence. It means "the note is safe
 * on this phone and lands at the next sync", which is a genuinely different
 * promise from 'mailbox' ("lands on its own, at the reader's next poll").
 *
 * IT IS NOT DEAD, and the cell that produces it is worth naming because it looks
 * like an edge case and is not: a host whose mailbox URL is serveable but whose
 * WRITE TOKEN is missing or wrong. Publishing needs the token, so 'mailbox' is
 * off; the proxy deliberately never receives it (`buildProxyOptions` carries
 * nothing that could authenticate — see `sync_session.test.js`), so the reader
 * can still be handed the outbox over its own AP. Sends park, Sync delivers.
 *
 * 'none' means NO CONFIGURED ROAD — not "the note is lost". `sendLoveNote` /
 * `routeEpubSend` still park the bytes in the outbox on failure (the auto-arm),
 * so a send made in this state is recoverable the moment any road is set up.
 */
export type DeliverabilityRoute = 'direct' | 'mailbox' | 'handover-only' | 'none';

/**
 * The whole state, as ONE token a screen maps to a chip, a tint or a sentence.
 *
 * Small on purpose: it is a UI vocabulary, not a diagnosis. Anything finer
 * (which road, why not, what the transport said) is already on the
 * {@link Deliverability} object or in `connectionStatus.lastError`.
 */
export type DeliverabilitySummary =
    /** The reader is awake and on this network. Immediate. */
    | 'ready-direct'
    /** Delivery happens without the reader present. The common good state. */
    | 'ready-mailbox'
    /** Nothing leaves the phone until the next Sync-with-reader. */
    | 'ready-handover'
    /** No road is configured. The ONLY state that should ask the user for anything. */
    | 'setup-needed';

/**
 * The settings this derivation reads, as a plain structure.
 *
 * `role` is typed loosely and run through `asRole` for the same reason every
 * other read of it is: the settings blob is unversioned and hand-editable, so a
 * pre-role install can hand this anything at all.
 */
export interface DeliverabilitySettings {
    role?: Role | string | null;
    /**
     * Reader host for the direct road, ALREADY NORMALISED (`getCurrentIp`).
     *
     * Blank means there is nothing to talk to, which is not the same as "asleep":
     * a blank host removes the direct road entirely rather than leaving it as an
     * unknown the send would go on to attempt against `http:///api/files`.
     */
    ip?: string;
    /**
     * Mailbox base URL. Empty/absent means "no mailbox configured".
     *
     * Read TWICE and by two different validators, which is not a redundancy:
     * `isMailboxConfigured` decides whether the app can PUBLISH to it, and
     * {@link isHandoverAvailable} decides whether the phone can SERVE it over
     * the reader's AP. Neither implies the other — a root-mounted base
     * (`https://host`) publishes fine and cannot be proxied at all.
     */
    mailboxUrl?: string;
    /** Mailbox bearer token. NEVER part of mailboxUrl — see mailbox_client. */
    mailboxWriteToken?: string;
    // NO `readerApPsk`. It was an input here and it was the wrong one: see the
    // "a road is a road only if this build can drive it" note in the header.
    // `Settings.readerApPsk` is what the platform join request uses once
    // Sync-with-reader is already running; it gates nothing this module answers.
}

/**
 * A reachability observation, in the shape `ConnectionStatus` publishes it.
 *
 * `reachable: null` and `checkedAt: null` both mean "never measured" — the
 * window between app launch and the first probe resolving, which is exactly when
 * a screen is most tempted to render the seeded `connected: false` as though it
 * were an answer.
 */
export interface DeliverabilityReachability {
    reachable: boolean | null;
    checkedAt: number | null;
}

export interface DeliverabilityInputs {
    settings: DeliverabilitySettings;
    reachability: DeliverabilityReachability;
    /** Injected clock. Defaults to `Date.now()`. */
    now?: number;
}

export interface Deliverability {
    /**
     * The reader ANSWERED, RECENTLY, and this phone has a direct road to it.
     *
     * Evidence, not intent: false covers "asleep", "never asked" and "asked too
     * long ago to still be true" alike, and a `noteRoute` of 'direct' can and
     * does occur while this is false (see the header). Freshness is
     * `reader_reachability`'s window — the reader sleeps on a tens-of-seconds
     * timescale, so an older observation is not evidence about now.
     */
    directNow: boolean;
    /**
     * A mailbox URL and write token are configured AND the URL is one both this
     * app and the reader firmware can use.
     *
     * Delegated to `love_note_sender.isMailboxConfigured` — the SAME predicate
     * the senders route on — so a screen can never claim a mailbox road that the
     * send would then refuse (or hide one it would happily take).
     */
    mailboxReady: boolean;
    /**
     * Sync-with-reader can be run: the button exists AND the session would start.
     *
     * {@link isHandoverAvailable}, verbatim — DeviceScreen gates the button on
     * THIS FIELD rather than on a second predicate of its own, so the model
     * cannot promise a sync the screen does not offer (or hide one it does).
     */
    apHandoverReady: boolean;
    /** True when SOMETHING can carry a send. Derived; `false` == both routes 'none'. */
    anyRoute: boolean;
    /** The road a note send would take right now. See the header on what it promises. */
    noteRoute: DeliverabilityRoute;
    /**
     * The road a book send would take right now.
     *
     * Identical to {@link noteRoute} today BY CONSTRUCTION, not by coincidence:
     * `epub_sender.routeEpubLegs` is a deliberate mirror of
     * `love_note_sender.routeLoveNote` (same role gate, same fast skip, same
     * mailbox fallback), and `scripts/deliverability.test.js` pins the two fields
     * equal across the whole truth table. The field is separate anyway so that
     * the day books diverge — a size cap the mailbox refuses, say — there is one
     * obvious place for it to diverge in, and a failing test pointing at it.
     */
    bookRoute: DeliverabilityRoute;
    /**
     * The road a WALLPAPER send would take right now.
     *
     * NEW, AND IT USED NOT TO EXIST BECAUSE THE ROAD DID NOT. A sleep screen was
     * direct-LAN only: `sendWallpaperBmp` PUTs a BMP at the reader's own API, so
     * WallpaperScreen greyed its buttons out whenever the reader was asleep —
     * which is almost always — and a client phone could never change a sleep
     * screen at all. `wallpaper_sender.routeWallpaperSend` now mirrors
     * `routeEpubLegs` (same role gate, same fast skip, same mailbox fallback,
     * same outbox auto-arm), so the derivation is identical to
     * {@link bookRoute}'s and `scripts/deliverability.test.js` pins all three
     * fields equal across the whole truth table.
     *
     * It is a SEPARATE FIELD anyway, for the reason `bookRoute` is: wallpapers
     * are the likeliest of the three to diverge (the mailbox cap is 4 MiB rather
     * than 24, and the rotation set has a device-side listing the other two do
     * not), and when they do there must be one obvious place for it to happen in
     * with a failing test pointing at it.
     */
    wallpaperRoute: DeliverabilityRoute;
    /** The token the UI maps to a chip/copy. Derived from {@link noteRoute}. */
    summary: DeliverabilitySummary;
}

/**
 * What is known about the direct road, as three answers plus "there is no such
 * road at all".
 *
 * Internal: it is the reasoning, and the two fields that survive it
 * (`directNow`, the routes) are the contract. 'unknown' and 'asleep' are kept
 * apart because they route DIFFERENTLY when nothing else is configured —
 * 'unknown' still attempts the reader, 'asleep' does not count as a road.
 */
type DirectKnowledge =
    /** Answered, within the freshness window. */
    | 'reachable'
    /** Did not answer, within the freshness window. */
    | 'asleep'
    /** Never measured, or measured too long ago to mean anything now. */
    | 'unknown'
    /** No direct road exists for this phone at all (a client, or a blank host). */
    | 'unavailable';

function readDirectKnowledge(
    role: Role,
    ip: string,
    reachability: DeliverabilityReachability | null | undefined,
    now: number
): DirectKnowledge {
    // A client has no LAN path to the reader BY DEFINITION — `routeLoveNote` and
    // `routeEpubLegs` both refuse to try one — so no observation can give it a
    // direct road, however fresh.
    if (role !== 'host') return 'unavailable';
    if (!ip.trim()) return 'unavailable';

    const reachable = reachability?.reachable;
    if (typeof reachable !== 'boolean') return 'unknown';
    // ONE freshness window for the whole app, imported rather than re-declared:
    // this is the same call `resolveReaderReachability` makes about the same
    // stamp, so a screen and the send it launches age an observation identically.
    if (!isReachabilityFresh(reachability?.checkedAt, now)) return 'unknown';
    return reachable ? 'reachable' : 'asleep';
}

/** The two facts a handover needs. A subset of {@link DeliverabilitySettings}. */
export interface HandoverInputs {
    role?: Role | string | null;
    mailboxUrl?: string;
}

/**
 * Can this phone run Sync-with-reader at all?
 *
 * THE ONE DEFINITION, exported because it had two and they disagreed:
 * DeviceScreen required a URL *and* a write token, this module required a saved
 * AP passphrase and ignored the URL, and nothing made them agree. Both now read
 * this function, so the button and the promise move together.
 *
 * The predicate is exactly what `sync_session.start` will do a moment later —
 * `buildProxyOptions` is `describeProxyTarget` plus defaults, and it fails
 * 'not-configured' before the radio is touched — plus the role gate, because
 * Sync-with-reader lives on the Device tab and App.tsx renders that tab for a
 * host only.
 *
 * DELIBERATELY LOOSER THAN `isMailboxConfigured` IN ONE DIRECTION: no write
 * token. The forwarder never gets one — the absence of anything that could
 * authenticate is the proxy's security property — so demanding a token here
 * would hide a working sync from a user whose token is merely missing. And
 * STRICTER in another: a base with no `/m/<box>` path publishes fine and cannot
 * be served, so it is not a handover road.
 */
export function isHandoverAvailable(inputs: HandoverInputs | null | undefined): boolean {
    if (asRole(inputs?.role) !== 'host') return false;
    const mailboxUrl = typeof inputs?.mailboxUrl === 'string' ? inputs.mailboxUrl : '';
    return describeProxyTarget(mailboxUrl).ok;
}

/**
 * The routing decision, shared by notes and books.
 *
 * ORDER IS THE WHOLE FUNCTION:
 *   1. A reader we KNOW is awake wins outright — it is immediate, and the send
 *      prefers it too.
 *   2. Otherwise a configured mailbox is the floor we can promise. This is what
 *      makes a stale observation say 'mailbox' rather than 'direct': the send may
 *      still upgrade itself, and an upgrade is not a lie.
 *   3. With no mailbox, an UNKNOWN reader is still attempted (rule 2 in
 *      `reader_reachability`: absence of information must not subtract a route),
 *      so the honest answer is 'direct' — that is what will actually happen.
 *   4. A serveable mailbox base with no usable write token: nothing can be
 *      published, but Sync-with-reader can still hand the outbox over, so the
 *      bytes wait on the phone for the next sync. A real delivery, just a manual
 *      one — and reachable ONLY here, since step 2 already claimed every cell
 *      where publishing works.
 *   5. Nothing configured.
 */
function deriveRoute(
    knowledge: DirectKnowledge,
    mailboxReady: boolean,
    apHandoverReady: boolean
): DeliverabilityRoute {
    if (knowledge === 'reachable') return 'direct';
    if (mailboxReady) return 'mailbox';
    if (knowledge === 'unknown') return 'direct';
    if (apHandoverReady) return 'handover-only';
    return 'none';
}

/**
 * The one mapping from road to UI token.
 *
 * EXPORTED so a screen that routes on {@link Deliverability.bookRoute} rather
 * than the note-derived {@link Deliverability.summary} — the Library tab does —
 * can reach the same chip vocabulary without re-deriving this switch. That is
 * the whole point of `bookRoute` being a separate field: the day books diverge
 * from notes, the Library must already be reading its own road, and it can only
 * do that if turning a road into a token is a shared function rather than a
 * private one.
 */
export function summarizeRoute(route: DeliverabilityRoute): DeliverabilitySummary {
    switch (route) {
        case 'direct':
            return 'ready-direct';
        case 'mailbox':
            return 'ready-mailbox';
        case 'handover-only':
            return 'ready-handover';
        case 'none':
            return 'setup-needed';
    }
}

/**
 * Answer "how does a send get through from here?" — purely, from a settings
 * snapshot and one reachability observation.
 *
 * NEVER THROWS and tolerates every degraded input the persistence contract can
 * produce (missing role, absent mailbox fields, an unstamped observation), for
 * the same reason `role.ts` does: this feeds a render, and a screen that throws
 * on a half-written settings blob is worse than one that shows the conservative
 * state.
 */
export function deriveDeliverability(inputs: DeliverabilityInputs): Deliverability {
    const settings = inputs?.settings ?? {};
    const now = typeof inputs?.now === 'number' ? inputs.now : Date.now();

    const role = asRole(settings.role);
    const ip = typeof settings.ip === 'string' ? settings.ip : '';

    const knowledge = readDirectKnowledge(role, ip, inputs?.reachability, now);

    // The senders' own predicate, on the senders' own shape. Not re-implemented.
    const mailboxReady = isMailboxConfigured({
        role,
        ip,
        mailboxUrl: settings.mailboxUrl,
        mailboxWriteToken: settings.mailboxWriteToken,
    });

    // The screen's own gate, not a second opinion about it. See DeviceScreen's
    // `canSyncWithReader`, which reads this very field back off the object.
    const apHandoverReady = isHandoverAvailable({ role, mailboxUrl: settings.mailboxUrl });

    const noteRoute = deriveRoute(knowledge, mailboxReady, apHandoverReady);
    const bookRoute = deriveRoute(knowledge, mailboxReady, apHandoverReady);
    const wallpaperRoute = deriveRoute(knowledge, mailboxReady, apHandoverReady);

    return {
        directNow: knowledge === 'reachable',
        mailboxReady,
        apHandoverReady,
        // Written as an OR over every road rather than off `noteRoute` alone, so
        // the field keeps meaning what its name says on the day they diverge.
        anyRoute: noteRoute !== 'none' || bookRoute !== 'none' || wallpaperRoute !== 'none',
        noteRoute,
        bookRoute,
        wallpaperRoute,
        // Notes are the app's primary action and Compose is its home screen, so
        // the one-token summary follows the note road. Books share it today; the
        // test suite is what keeps that true.
        summary: summarizeRoute(noteRoute),
    };
}
