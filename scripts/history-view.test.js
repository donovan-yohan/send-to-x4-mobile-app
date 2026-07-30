/**
 * history_view — the strings a History row computes.
 *
 * The interesting cases are all DEGRADED input, because `message_history`
 * deliberately never drops a row over one bad field: it coerces an unreadable
 * `createdAt` to 0 and an unreadable kind/status to a definite member of the
 * union. That policy only holds up if the view layer renders those coerced
 * values as something a human can read, which is what this suite pins.
 *
 * `now` is passed in everywhere, so no test depends on the wall clock.
 *
 * Run:  node --import tsx --test scripts/history-view.test.js
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

import {
    UNKNOWN_TIME_LABEL,
    describeKind,
    describeStatus,
    formatRelativeTime,
} from '../src/services/history_view';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** An arbitrary fixed "now" — nothing here depends on its actual value. */
const NOW = Date.UTC(2026, 6, 28, 12, 0, 0);

test('ages below a minute read as "Just now"', () => {
    assert.equal(formatRelativeTime(NOW, NOW), 'Just now');
    assert.equal(formatRelativeTime(NOW - 1, NOW), 'Just now');
    assert.equal(formatRelativeTime(NOW - (MINUTE - 1), NOW), 'Just now');
});

test('each unit boundary steps exactly once', () => {
    // The first instant of each unit, and the last instant before the next.
    assert.equal(formatRelativeTime(NOW - MINUTE, NOW), '1m ago');
    assert.equal(formatRelativeTime(NOW - (HOUR - 1), NOW), '59m ago');
    assert.equal(formatRelativeTime(NOW - HOUR, NOW), '1h ago');
    assert.equal(formatRelativeTime(NOW - (DAY - 1), NOW), '23h ago');
    assert.equal(formatRelativeTime(NOW - DAY, NOW), '1d ago');
    assert.equal(formatRelativeTime(NOW - (7 * DAY - 1), NOW), '6d ago');
});

test('past a week the row shows an ISO calendar date', () => {
    // Locale-formatted dates render differently per device and per ICU build,
    // so this branch is deliberately locale-independent.
    assert.equal(formatRelativeTime(NOW - 7 * DAY, NOW), '2026-07-21');
    assert.equal(formatRelativeTime(NOW - 400 * DAY, NOW), '2025-06-23');
});

test('a future timestamp is clock skew, not a negative age', () => {
    // A device that resynced NTP or changed time zone between the send and the
    // read hands us this; "-3m ago" would be worse than rounding to now.
    assert.equal(formatRelativeTime(NOW + HOUR, NOW), 'Just now');
});

test('an unreadable createdAt renders as a label, never as 1970', () => {
    // message_history.asRecord coerces a missing/NaN createdAt to 0 rather than
    // dropping the row — this is what stops that showing as '1970-01-01'.
    for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
        assert.equal(formatRelativeTime(bad, NOW), UNKNOWN_TIME_LABEL, `for ${bad}`);
    }
});

test('every kind and status has a label', () => {
    assert.equal(describeKind('photo'), 'Photo');
    assert.equal(describeKind('text'), 'Text note');
    assert.equal(describeKind('doodle'), 'Doodle');

    assert.equal(describeStatus('sent'), 'Sent');
    assert.equal(describeStatus('failed'), 'Failed');
    assert.equal(describeStatus('draft'), 'Draft');
});

test('a mailbox note reads differently from one already on the panel', () => {
    // 'Sent' via the mailbox does NOT mean the reader is showing it — it means
    // the reader collects it at its next deep-sleep ENTRY and displays it at the
    // wake after that, possibly hours later. A row that cannot say which is a
    // row that cannot explain a reader showing nothing.
    assert.equal(describeStatus('sent', 'direct'), 'Sent');
    assert.equal(describeStatus('sent', 'mailbox'), 'In mailbox');
    // Rows written before the mailbox existed carry no path.
    assert.equal(describeStatus('sent'), 'Sent');
    assert.equal(describeStatus('sent', undefined), 'Sent');
    // The route never overrides a failure or a draft.
    assert.equal(describeStatus('failed', 'mailbox'), 'Failed');
    assert.equal(describeStatus('draft', 'mailbox'), 'Draft');
});

test('a note the reader cannot dismiss says so, and only when it is certain', () => {
    // idStaged: false is a DEGRADED success — the frame is on the panel but
    // /.love-notes/current.id is not, so the reader has nothing to mark shown and
    // re-displays this note on every wake. A plain 'Sent' here is the difference
    // between "the reader will dismiss this" and "the reader will re-show it
    // forever", and only a re-send fixes the second one.
    assert.equal(describeStatus('sent', 'direct', false), 'Sent · repeats');
    assert.equal(describeStatus('sent', undefined, false), 'Sent · repeats');

    // A staged id is the ordinary case and gets no decoration.
    assert.equal(describeStatus('sent', 'direct', true), 'Sent');
    // Unknown NEVER becomes a warning: every row written before this field
    // existed, and every mailbox row, reports undefined.
    assert.equal(describeStatus('sent', 'direct', undefined), 'Sent');
    // The mailbox publishes its dedup id WITH the note; there is no sidecar to
    // lose, so that wording wins even if a stale flag rode along.
    assert.equal(describeStatus('sent', 'mailbox', false), 'In mailbox');
    // And it never contradicts a failure or a draft.
    assert.equal(describeStatus('failed', 'direct', false), 'Failed');
    assert.equal(describeStatus('draft', 'direct', false), 'Draft');
});

test('an off-union value falls back rather than rendering blank', () => {
    // Cannot happen through message_history's coercion, but a row with an empty
    // heading would be indistinguishable from a broken render if it ever did.
    assert.equal(describeKind('sticker'), 'Photo');
    assert.equal(describeStatus('queued'), 'Failed');
});

test('a superseded note reads as replaced, never as failed or still coming', () => {
    // The reader holds ONE note (§1), so a newer one retires every older one that
    // has not landed. Such a row used to keep whatever the original attempt left
    // on it — most often 'In mailbox', which promises a delivery that can never
    // happen now, or 'Failed', which sends the user looking for a problem that
    // does not exist.
    assert.equal(describeStatus('superseded'), 'Replaced by a newer note');
    // The route is irrelevant once it is superseded: nothing about it is coming.
    assert.equal(describeStatus('superseded', 'mailbox'), 'Replaced by a newer note');
    // And the id-sidecar warning cannot decorate it — that warning is about a
    // note the reader is SHOWING, which this one never was.
    assert.equal(describeStatus('superseded', 'direct', false), 'Replaced by a newer note');
});
