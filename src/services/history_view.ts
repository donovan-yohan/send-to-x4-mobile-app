/**
 * history_view — the display strings a History row shows.
 *
 * Screens cannot be node-tested, so anything a row COMPUTES rather than simply
 * renders lives here instead of in `HistoryScreen.tsx`. That is the same split
 * as image_geometry/image_converter: the pure half is covered by
 * `scripts/history-view.test.js`, the impure half is layout only.
 *
 * PURE TypeScript. The only import is a TYPE import from `message_history`,
 * which is erased at compile time, so this module pulls in nothing at runtime.
 */

import type { MessageKind, MessageRecord, MessageStatus } from './message_history';

/** Below this age a row reads as "Just now" rather than "0m ago". */
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Past this age the relative form stops being useful ("41d ago" tells nobody
 * anything) and the row shows a calendar date instead.
 */
const RELATIVE_LIMIT_MS = 7 * DAY_MS;

/** Shown for a record whose `createdAt` did not survive the store. */
export const UNKNOWN_TIME_LABEL = 'Unknown time';

/**
 * `createdAt` -> a short age, e.g. `Just now` / `7m ago` / `3h ago` / `2d ago`,
 * falling back to an ISO calendar date (`2026-07-28`) past a week.
 *
 * `now` is a parameter, not a `Date.now()` call inside, so the boundaries are
 * testable without faking the clock.
 *
 * DEFENSIVE about its input on purpose: `message_history.asRecord` coerces an
 * unreadable `createdAt` to 0 rather than dropping the row (losing the only
 * surviving trace of a note over one bad field would be worse), so this
 * function is the thing that has to render that 0 as something other than
 * "1970-01-01". A timestamp in the FUTURE is clock skew — a device that changed
 * time zone or resynced NTP between the send and the read — and reads as "Just
 * now" rather than as a negative age.
 */
export function formatRelativeTime(timestamp: number, now: number): string {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return UNKNOWN_TIME_LABEL;

    const age = now - timestamp;
    if (!Number.isFinite(age) || age < MINUTE_MS) return 'Just now';
    if (age < HOUR_MS) return `${Math.floor(age / MINUTE_MS)}m ago`;
    if (age < DAY_MS) return `${Math.floor(age / HOUR_MS)}h ago`;
    if (age < RELATIVE_LIMIT_MS) return `${Math.floor(age / DAY_MS)}d ago`;

    return formatCalendarDate(timestamp);
}

/**
 * ISO `YYYY-MM-DD`, not `toLocaleDateString`.
 *
 * The locale form is what the old `ScreensaverQueueList` used, but it renders
 * differently on every device and under every ICU build, which makes it
 * untestable — and this is the branch that runs for the OLDEST rows, the ones
 * nobody will ever look at again to notice it broke.
 */
function formatCalendarDate(timestamp: number): string {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return UNKNOWN_TIME_LABEL;
    return date.toISOString().slice(0, 10);
}

/** Row heading for the authoring surface a note came from. */
export function describeKind(kind: MessageKind): string {
    switch (kind) {
        case 'text':
            return 'Text note';
        case 'doodle':
            return 'Doodle';
        case 'photo':
        default:
            return 'Photo';
    }
}

/**
 * Delivery state, as the row's status pill reads it.
 *
 * `path` matters because a bare "Sent" means two different things. 'direct' put
 * the frame on the panel; 'mailbox' only left it somewhere the reader collects
 * at its NEXT deep-sleep entry and displays at the wake after that — possibly
 * hours later. Someone comparing this row against a reader that is showing
 * nothing needs to be able to tell those apart. Rows written before the mailbox
 * existed carry no `path` and keep the old wording.
 *
 * `idStaged: false` splits 'Sent' a THIRD way, and it is the one the user can
 * actually act on: the frame reached the reader but `/.love-notes/current.id`
 * did not, so the reader has no id to mark shown and re-displays this note on
 * EVERY wake until something replaces it. Only a re-send clears that, so the
 * pill has to say so — a row reading a plain 'Sent' is indistinguishable from
 * one the reader will dismiss normally. Only the DIRECT route can report it (the
 * mailbox publishes its dedup id with the note), and `undefined` — every row
 * written before this field, and every mailbox row — keeps the old wording
 * rather than guessing.
 */
export function describeStatus(
    status: MessageStatus,
    path?: MessageRecord['path'],
    idStaged?: MessageRecord['idStaged']
): string {
    switch (status) {
        case 'sent':
            if (path === 'mailbox') return 'In mailbox';
            // Handed straight to the reader over its own WiFi, with no mailbox
            // and no internet anywhere in the path. Distinct from 'direct'
            // ('Sent', over the LAN while the reader was awake) because it is the
            // answer to "why did this work on the train?" — and it is never
            // paired with the `idStaged` warning: that route stages no sidecar,
            // the reader reads the id from the manifest like any mailbox pull.
            if (path === 'handover') return 'Delivered directly';
            return idStaged === false ? 'Sent · repeats' : 'Sent';
        case 'draft':
            return 'Draft';
        // A newer note took this one's slot before it was ever shown. Its own
        // word rather than 'Failed', because nothing failed and there is nothing
        // to retry — the reader holds one note (§1), the user sent another, and
        // this one stopped being deliverable at that moment. 'Failed' would send
        // someone hunting for a problem, and 'In mailbox' (what these rows used
        // to keep saying, indefinitely) is an outright false promise.
        case 'superseded':
            return 'Replaced by a newer note';
        case 'failed':
        default:
            return 'Failed';
    }
}
