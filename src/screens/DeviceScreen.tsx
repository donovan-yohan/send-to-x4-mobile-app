/**
 * DeviceScreen — the LIBRARY tab. One list of every book the user has, wherever
 * it currently is, plus the raw file manager demoted underneath it.
 *
 * ---------------------------------------------------------------------------
 * WHY A MERGED LIST AND NOT TWO
 * ---------------------------------------------------------------------------
 * A book this app sent is in one of two places and the user does not care which:
 * on the reader's card (direct upload landed) or in the MAILBOX (the reader was
 * asleep, so `sendEpubsRouted` queued it and the reader collects it at a sync
 * window). Showing those as two lists made the same book look like two books
 * during the window where it is both, and made a queued book look lost.
 *
 * So the list is ONE list, merged by filename in `services/library.ts`, and each
 * row wears where it is: `On reader`, `In mailbox`, or both chips at once. All of
 * the merging, the case-insensitive dedupe, the sort and the AsyncStorage
 * snapshot live in that service — which is testable under node
 * (`scripts/library.test.js`) — because a screen is the one place in this repo
 * that no test can reach. Resist moving any of it up here.
 *
 * ---------------------------------------------------------------------------
 * THE READER BEING ASLEEP IS THE NORMAL CASE, NOT AN ERROR
 * ---------------------------------------------------------------------------
 * Its radio is off almost all of the time. This screen therefore NEVER shows an
 * error wall for an unreachable reader:
 *
 *   - `loadLibrary` falls back to the cached snapshot of the last live listing,
 *     and reports `readerFresh: false`. The rows still render; a quiet caption
 *     says the reader side is from an earlier connection.
 *   - the mailbox half is independent, so a configured mailbox still lists its
 *     queue with the reader completely absent.
 *   - Add books still works with no reader at all: the routed send falls back to
 *     the mailbox, which is why `canAddBooks` accepts "mailbox configured" as
 *     well as "connected".
 *
 * A mailbox row says it "will land on the reader next sync" REGARDLESS of whether
 * the firmware's BookSync has shipped, and that is deliberate: the reader acks
 * nothing, so the mailbox is the only thing either side can honestly report.
 *
 * ---------------------------------------------------------------------------
 * DELETES HAVE TWO DIFFERENT TARGETS
 * ---------------------------------------------------------------------------
 * Removing a book from the MAILBOX (`removeMailboxBook`) only un-queues it — a
 * reader that already collected it keeps its copy, because there is no reverse
 * channel and reader-side state is authoritative. Removing it from the READER
 * (`deleteCrossPointFile`) needs the reader awake. A row that is in both places
 * therefore asks WHICH copy, rather than picking one and being wrong half the
 * time.
 *
 * ---------------------------------------------------------------------------
 * THE RAW FILE MANAGER IS STILL HERE, UNDER 'All files'
 * ---------------------------------------------------------------------------
 * Collapsed, and scanned LAZILY — it is the only listing surface in the app for
 * /.love-notes and both sleep roots, and the only way to delete from them, so it
 * cannot be dropped (see the scan-roots note below for the two times an
 * unscanned root became content the user could neither find nor remove). It is
 * also the only place a NON-book file, a folder or a legacy-root book can be
 * removed. Demoted, not deleted.
 *
 * Its scan is deliberately NOT run alongside the library load: the firmware's
 * HTTP server handles one request at a time, and this screen already fans out
 * three section scans once the section is open.
 *
 * Every write here is gated on `isHost` as well as on connectivity even though
 * App.tsx only mounts this tab for a host: a client must never hold a path that
 * writes permanent state to the reader, and a second gate costs one boolean.
 *
 * ---------------------------------------------------------------------------
 * 'SYNC WITH READER' LIVES HERE BECAUSE THIS IS WHERE THE WAITING IS VISIBLE
 * ---------------------------------------------------------------------------
 * A queued book sits in the mailbox until the reader has internet, and this
 * screen is the one place that says so. The header action is the offline answer
 * to that caption (contract A3): the reader raises its own AP, the phone joins it
 * as a peer while keeping cellular, and a forwarder on that link lets the reader
 * pull from the mailbox through this phone's data.
 *
 * All of the policy is in `services/sync_session.ts`, a pure state machine over
 * an injectable `reader_link` seam, so the races that actually break this — the
 * AP vanishing mid-session, a stop between joining and listening, a build with no
 * native module at all — are covered by `scripts/sync-session.test.js` instead of
 * being unreachable inside a component. This screen owns exactly three things:
 * which settings to hand it, the 1 s tick that makes deadlines fire, and the line
 * that renders `describeSyncSession`.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    ScrollView,
    TouchableOpacity,
    Alert,
    ActivityIndicator,
    RefreshControl,
    Animated,
    Image,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import Swipeable from 'react-native-gesture-handler/Swipeable';

import { useConnection } from '../contexts/ConnectionProvider';
import { useProgress } from '../contexts/ProgressProvider';
import type { RemoteFile } from '../types';
import { getCurrentIp, getDeviceBaseUrl } from '../services/settings';
import { deleteCrossPointFile } from '../services/crosspoint_upload';
import { LOVE_NOTES_DIR } from '../services/love_note_sender';
import {
    DEFAULT_LIBRARY_FOLDER,
    MAILBOX_LANDING_CLAUSE,
    describeEpubBatch,
    pickEpubs,
    sendEpubsRouted,
    type EpubDestination,
} from '../services/epub_sender';
import {
    loadLibrary,
    removeMailboxBook,
    type LibraryBook,
    type LibrarySnapshot,
} from '../services/library';
import { formatRelativeTime } from '../services/history_view';
import {
    describeSyncMode,
    describeSyncSession,
    describeUpstreamProblem,
    getSyncSession,
    isSyncSessionActive,
    type SyncSession,
} from '../services/sync_session';
import {
    describeOutboxHandover,
    listOutbox,
    subscribeOutbox,
    summarizeOutbox,
    type OutboxItem,
} from '../services/outbox';
import { ensureNearbyWifiPermission } from '../services/android_permissions';
import { SEND_PHASE_LABEL } from '../services/reader_reachability';
import { getRole, isHost } from '../services/role';
import { SLEEP_SET_FOLDER } from '../services/wallpaper_sender';
import { getPreviewMapping, removePreviewMapping } from '../services/preview_cache';
import { ProcessingOverlay } from '../components/ProcessingOverlay';
import { RouteChip } from '../components/RouteChip';
import { READER_ASLEEP_CAPTION, useDirectConnectionRequired } from '../components/ConnectionBanner';
import { BinIcon, DeviceIcon } from '../components/icons';
import { summarizeRoute } from '../services/deliverability';
import { useDeliverability } from '../services/useDeliverability';
import { useTabBarInset, useTheme, type Theme } from '../theme';

/** Empty-state / gate-card mark. */
const EMPTY_ICON_SIZE = 40;
/** Row action glyph, matching HistoryScreen's action buttons. */
const ACTION_ICON_SIZE = 18;

// ── Scan roots ─────────────────────────────────────────────────────────────
// These were SETTINGS-DRIVEN (`articleFolder` / `noteFolder`, free-text fields
// in Settings) back when this fork shipped an article pipeline the user could
// point anywhere. Both the pipeline and the settings fields are gone; every
// destination the messenger actually writes is a fixed path its sender owns as
// a constant, so the roots are constants here too.
//
// EVERY SECTION THAT HAS MORE THAN ONE LIVE ROOT SCANS ALL OF THEM. The 'All
// files' section is the ONLY listing surface for these folders and the only way
// to delete from them, so a root it does not scan is content the user can
// neither see nor remove — the exact failure this section had twice:
//
//   BOOKS: the old settings default was `articleFolder = 'send-to-x4'`, and the
//   retarget to '/books' shipped with no migration. Anything an existing install
//   already has under /send-to-x4 was invisible here AND undeletable from here,
//   because the delete fallback resolves against BOOKS_ROOT too. The legacy root
//   is therefore still scanned, and labelled when it has anything in it.
//
//   SCREENSAVERS: BOTH sleep roots have live WRITERS —
//   `uploadScreensaverToCrossPoint` (crosspoint_upload.ts) writes '/sleep' and
//   `wallpaper_sender` writes '/.sleep' (the firmware's preferred path;
//   SleepActivity reads '/.sleep' first and falls back to '/sleep'). Scanning
//   only '/sleep' meant nothing sent from the Wallpaper tab ever appeared here
//   and none of it could be deleted from the app at all.
//
// `deepScanFolder` stamps every result with the folder it was found in and the
// delete handlers use `file.folder`, so merging roots needs nothing else: each
// file is deleted from wherever it actually lives.
//
// BOOKS_ROOT is imported, not declared: `epub_sender` WRITES this folder and
// therefore owns its name, exactly as `love_note_sender` owns '/.love-notes'. A
// local copy here could drift from the upload target, and the symptom of that
// drift is a book that uploads successfully and never appears in the list.
/** Root-relative form of `epub_sender.BOOKS_DIR` ('/books'). Upload target. */
const BOOKS_ROOT = DEFAULT_LIBRARY_FOLDER;
/**
 * Where books landed BEFORE '/books' — `settings.DEFAULTS.articleFolder`.
 *
 * Read-only as far as this screen is concerned: nothing writes here any more,
 * it exists so an older install's library is still listed and still deletable.
 * A literal rather than an import because the settings key it came from is
 * legacy with no live reader, and hard-coding the historical value is what keeps
 * it from tracking a default that may change again.
 */
const LEGACY_BOOKS_ROOT = 'send-to-x4';
/** Root-relative form of LOVE_NOTES_DIR ('/.love-notes'); the scan/delete
 *  helpers below build their own leading '/'. */
const LOVE_NOTES_ROOT = LOVE_NOTES_DIR.replace(/^\/+/, '');
/**
 * Sleep roots, in the firmware's own preference order.
 *
 * `SLEEP_SET_FOLDER` is imported from the module that writes it, for the same
 * reason BOOKS_ROOT is; '/sleep' is the legacy-but-still-written sibling.
 */
const SCREENSAVER_ROOTS = [SLEEP_SET_FOLDER, 'sleep'] as const;

/**
 * Extensions the Books scan accepts.
 *
 * Wider than `.epub` on purpose: the reader also reads plain `.txt` and `.xtc`
 * out of the library folder, and a file this section cannot see is a file the
 * user cannot delete. The LIBRARY list above is epub-shaped (that is what the
 * mailbox carries), which is the other half of why the raw section stays.
 */
const BOOK_EXTENSIONS = ['.epub', '.txt', '.xtc'];

const getFileId = (file: RemoteFile) => file.folder ? `${file.folder}/${file.name}` : file.name;

/** Merge key for a library row — the same case-insensitive key the service uses. */
const getBookKey = (book: LibraryBook) => book.filename.toLowerCase();

function safeDecodeURIComponent(str: string): string {
    try {
        return decodeURIComponent(str);
    } catch {
        return str;
    }
}

function normalizeFolderPath(path: string): string {
    return path.replace(/^\/+/, '').replace(/\/+$/, '');
}

function decodeFolderPath(path: string): string {
    return normalizeFolderPath(path)
        .split('/')
        .map((segment) => safeDecodeURIComponent(segment))
        .join('/');
}

function joinFolderPath(parent: string, child: string): string {
    const p = normalizeFolderPath(parent);
    const c = normalizeFolderPath(child);
    if (!p) return c;
    if (!c) return p;
    return `${p}/${c}`;
}

function getExt(name: string): string {
    const idx = name.lastIndexOf('.');
    if (idx < 0) return '';
    return name.slice(idx).toLowerCase();
}

async function fetchDirectoryItems(
    baseUrl: string,
    folder: string
): Promise<any[] | null> {
    const normalized = decodeFolderPath(folder);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
        const response = await fetch(
            `${baseUrl}/api/files?path=${encodeURIComponent('/' + normalized)}`,
            { signal: controller.signal }
        );

        if (!response.ok) return null;
        const items = await response.json();
        return Array.isArray(items) ? items : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

async function deepScanFolder(
    baseUrl: string,
    rootFolder: string,
    allowedExtensions: string[]
): Promise<RemoteFile[]> {
    const root = normalizeFolderPath(rootFolder);
    if (!root) return [];

    const queue: string[] = [root];
    const visited = new Set<string>();
    const results: RemoteFile[] = [];
    const allowed = new Set(allowedExtensions.map(ext => ext.toLowerCase()));

    while (queue.length > 0) {
        const currentFolder = queue.shift()!;
        if (visited.has(currentFolder)) continue;
        visited.add(currentFolder);

        const items = await fetchDirectoryItems(baseUrl, currentFolder);
        if (!items) continue;

        for (const item of items) {
            const rawName = typeof item.name === 'string' ? item.name : '';
            if (!rawName) continue;

            const isDir = item.isDirectory === true || item.type === 'dir';

            if (isDir) {
                queue.push(joinFolderPath(currentFolder, safeDecodeURIComponent(rawName)));
                continue;
            }

            const decodedName = safeDecodeURIComponent(rawName).trim();
            if (!allowed.has(getExt(decodedName))) continue;

            results.push({
                name: decodedName,
                rawName,
                size: typeof item.size === 'number' ? item.size : undefined,
                timestamp: typeof item.lastModified === 'number' ? item.lastModified : undefined,
                folder: currentFolder,
            });
        }
    }

    results.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return results;
}

/**
 * Scan several roots into ONE newest-first list.
 *
 * SERIAL on purpose. The firmware's HTTP server handles one request at a time
 * and this screen already runs three section scans concurrently; fanning out per
 * root is how `/api/files` starts timing out (each `fetchDirectoryItems` gives up
 * after 10 s and returns null, which reads as an empty folder).
 *
 * Deduped on the row key so a root that turns out to be nested inside another
 * cannot list the same file twice, and re-sorted because concatenating two
 * individually-sorted lists does not produce a sorted one.
 */
async function scanRoots(
    baseUrl: string,
    roots: readonly string[],
    allowedExtensions: string[]
): Promise<RemoteFile[]> {
    const merged: RemoteFile[] = [];
    const seen = new Set<string>();
    for (const root of roots) {
        const found = await deepScanFolder(baseUrl, root, allowedExtensions);
        for (const file of found) {
            const id = getFileId(file);
            if (seen.has(id)) continue;
            seen.add(id);
            merged.push(file);
        }
    }
    merged.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return merged;
}

/** True when `file` was found under `root` (or a subfolder of it). */
function isUnderRoot(file: RemoteFile, root: string): boolean {
    const folder = normalizeFolderPath(file.folder || '');
    return folder === root || folder.startsWith(`${root}/`);
}

/**
 * The raw listing row for `filename`, case-insensitively, or null.
 *
 * The library snapshot carries a DISPLAY filename and no device path, because
 * the mailbox half has no path at all. A reader-side delete needs both the
 * folder the file actually lives in (which may be the legacy root) and the RAW,
 * still-encoded name `/api/files` reported — so the raw listing is the lookup
 * table for a delete, not a decoration.
 *
 * ROOT-AWARE, AND THAT IS THE WHOLE POINT. `files` is the merge of BOTH book
 * roots, deep-scanned and sorted by mtime — so a name-only match returned
 * whichever copy was written most recently, which on a reader that still has a
 * `/send-to-x4` library (a supported state, HANDOFF.md: retarget with no
 * migration) is routinely the LEGACY file. Library rows come exclusively from a
 * flat listing of `preferRoot`, so a bin tap resolved that way deleted a book
 * the user never pointed at, left the tapped row in place on refresh, and said
 * nothing. Precedence is therefore: the flat `preferRoot` copy, then anything
 * under it, and only then a copy from some other root.
 */
function findReaderFile(
    files: RemoteFile[],
    filename: string,
    preferRoot: string
): RemoteFile | null {
    const wanted = filename.toLowerCase();
    const matches = files.filter(file => file.name.toLowerCase() === wanted);
    if (matches.length === 0) return null;

    const root = normalizeFolderPath(preferRoot);
    const flat = matches.find(file => normalizeFolderPath(file.folder || '') === root);
    if (flat) return flat;
    const nested = matches.find(file => isUnderRoot(file, root));
    if (nested) return nested;
    return matches[0];
}

/**
 * One overlay line: what the route is doing, and which book it is doing it to.
 *
 * The PHASE wording is the sender's own (`SEND_PHASE_LABEL`) and is not reworded
 * here — Compose shows the identical sentence for the identical route. Only the
 * batch context is local, because only this screen sends more than one thing at
 * a time.
 */
function describeBatchPhase(
    phase: keyof typeof SEND_PHASE_LABEL,
    file: { index: number; total: number; name: string } | null
): string {
    const label = SEND_PHASE_LABEL[phase];
    if (!file || !file.name) return label;
    return file.total > 1
        ? `${label} (${file.index}/${file.total}: ${file.name})`
        : `${label} (${file.name})`;
}

/** KB under a megabyte, MB above it. Books run from ~200 KB to ~24 MB. */
function formatBookSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DeviceScreen() {
    const { settings, connectionStatus } = useConnection();
    // uploadText / progress are READ as well as written: the batch overlay below
    // is what makes "3 of 7" visible, and both values already live in the shared
    // provider, so there is no second copy of the upload state on this screen.
    const { uploadText, progress, startUpload, setProgress, finishUpload, failUpload } = useProgress();
    const theme = useTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);
    // The tab bar floats over this screen and reserves no layout space, so the
    // list has to end above it. See src/theme/tabBar.ts.
    const tabBarInset = useTabBarInset();

    /**
     * DIRECT ONLY, and only for the direct-only halves of this tab: the raw file
     * browser, the delete-from-reader path and the reader side of the merged
     * listing. Adding a book is NOT gated on this — see `canAddBooks`.
     */
    const { available: connected } = useDirectConnectionRequired();
    const host = isHost(settings);

    /**
     * The shared roads model. Books read `bookRoute`, not `summary` — see the
     * note on the chip in the header.
     */
    const deliverability = useDeliverability();
    const bookSummary = summarizeRoute(deliverability.bookRoute);

    /**
     * The four facts every route depends on, in one object.
     *
     * Shared by `sendEpubsRouted`, `loadLibrary` and `removeMailboxBook` so the
     * three cannot end up disagreeing about which mailbox this phone is talking
     * to — the failure that produces a list from one box and an upload into
     * another.
     */
    const destination = useMemo<EpubDestination>(
        () => ({
            role: getRole(settings),
            ip: getCurrentIp(settings),
            mailboxUrl: settings.mailboxUrl,
            mailboxWriteToken: settings.mailboxWriteToken,
        }),
        [settings]
    );

    // NOTE: this screen no longer keeps an `isMailboxConfigured(destination)` of
    // its own. Both things it fed now come from a shared answer instead — the Add
    // gate from `deliverability.bookRoute` and the Sync gate from
    // `deliverability.apHandoverReady` — because a screen-local copy of a routing
    // predicate is exactly how the two drifted apart in the first place. The
    // "is the mailbox usable" line under the title reads the SNAPSHOT's flag,
    // which is the loader's own answer about the box it actually talked to.

    /**
     * What the app already knows about whether the reader is answering.
     *
     * ConnectionProvider probes the SAME endpoint the routed send's fast skip
     * would, so an Add moments after a foreground check gets the answer for
     * free instead of paying a stacked-timeout stall PER BOOK. `checkedAt` is
     * what makes it safe to trust; `undefined` means "ask", not "reachable".
     */
    const reachability = useMemo(
        () =>
            typeof connectionStatus.checkedAt === 'number'
                ? { reachable: connectionStatus.connected, checkedAt: connectionStatus.checkedAt }
                : null,
        [connectionStatus.connected, connectionStatus.checkedAt]
    );

    // ── Library state ───────────────────────────────────────────────
    const [snapshot, setSnapshot] = useState<LibrarySnapshot | null>(null);
    const [libraryLoading, setLibraryLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [busyBook, setBusyBook] = useState<string | null>(null);
    const [addingBooks, setAddingBooks] = useState(false);
    /**
     * `now` is captured per load rather than read while rendering, so the
     * "list from 3h ago" caption cannot drift mid-scroll.
     */
    const [now, setNow] = useState(() => Date.now());

    // ── 'Sync with reader' (the A3 peer link) ───────────────────────
    // The controller is a MODULE SINGLETON, not per-screen state: it owns one
    // radio, one outstanding NetworkRequest and one listening port, and this tab
    // unmounts on every tab switch. Subscribing to it means a session survives
    // navigating away and is still reported when the user comes back.
    const [syncSession, setSyncSession] = useState<SyncSession>(() =>
        getSyncSession().getSession()
    );

    useEffect(() => {
        const controller = getSyncSession();
        // Re-read on mount: the session may have moved on while this tab was
        // unmounted, and the initial useState value is then already stale.
        setSyncSession(controller.getSession());
        return controller.subscribe(setSyncSession);
    }, []);

    const syncActive = isSyncSessionActive(syncSession.state);

    // The state machine has no timers of its own (that is what makes it
    // testable), so deadlines only fire when something ticks it. 1 s is fine: the
    // budgets it enforces are tens of seconds to minutes.
    useEffect(() => {
        if (!syncActive) return;
        const timer = setInterval(() => getSyncSession().tick(), 1000);
        return () => clearInterval(timer);
    }, [syncActive]);

    const handleSyncPress = useCallback(() => {
        const controller = getSyncSession();
        // Read the CONTROLLER's state, not the rendered copy: a tap that lands in
        // the same frame as a state change would otherwise start a second session
        // on top of a live one.
        if (isSyncSessionActive(controller.getSession().state)) {
            void controller.stop();
            return;
        }
        void (async () => {
            // ASKED BEFORE THE RADIO IS TOUCHED. On Android 13+ a
            // `WifiNetworkSpecifier` request without NEARBY_WIFI_DEVICES is
            // refused with a SecurityException, and the native side can only
            // report that as a failed join — which the session line renders as
            // advice about the reader's Sync mode that no amount of retrying will
            // fix. `ConnectionProvider` asks for the same permission on its own
            // probe path, so a user who has been on the Device tab usually has it;
            // "usually" is not a precondition worth relying on for the one action
            // that needs it most.
            const permission = await ensureNearbyWifiPermission();
            if (!permission.granted) {
                Alert.alert(
                    'Nearby devices permission needed',
                    `${permission.reason ?? 'Permission denied.'}\n\n` +
                        "Android needs it before the app can join the reader's own WiFi. " +
                        'Allow it in Settings → Apps → permissions, then tap Sync again.'
                );
                return;
            }
            // The dialog can outlive this tap — re-check rather than starting a
            // second session on top of one begun while it was up.
            if (isSyncSessionActive(controller.getSession().state)) return;
            await controller.start({
                ssid: settings.apSsid,
                // '' means the open AP the firmware ships today.
                passphrase: settings.readerApPsk ?? '',
                // The proxy forwards to this box and nothing else. The WRITE TOKEN
                // is deliberately NOT passed: the peer link is reachable by
                // anything that associates with the reader's AP, and the reader
                // only ever reads.
                mailboxUrl: settings.mailboxUrl ?? '',
            });
        })();
    }, [settings.apSsid, settings.readerApPsk, settings.mailboxUrl]);

    // Silent when idle: an unused feature should not narrate itself on every
    // visit. Every other state has something true to say.
    const syncLine = syncSession.state === 'idle' ? null : describeSyncSession(syncSession);
    // WHERE the bytes come from, when the native side has said. Null for the
    // ordinary forwarding session and for a dev client older than local serve —
    // see describeSyncMode.
    const syncModeLine = syncActive ? describeSyncMode(syncSession) : null;
    // WHY the mailbox is out of reach, in the native side's own words. Kept for
    // the ENDED session too, deliberately: this is the one sentence that says
    // whether to turn mobile data on or to fix the mailbox URL, and it is worth
    // nothing if it vanishes the moment the reader closes its WiFi — which is
    // exactly when the user looks up and wonders what happened.
    const syncUpstreamLine = describeUpstreamProblem(syncSession);

    // ── The handover queue ──────────────────────────────────────────
    // What this phone is holding FOR the reader. Shown OUTSIDE the session,
    // because its whole value is that it is true before anyone taps anything:
    // "3 items ready to hand over — no internet needed" is the sentence that
    // tells a user on a train that the feature they need already has their book.
    const [outboxItems, setOutboxItems] = useState<OutboxItem[]>([]);

    useEffect(() => {
        let alive = true;
        void listOutbox().then(items => {
            if (alive) setOutboxItems(items);
        });
        // Subscribed as well as read: a send that fails while this tab is mounted
        // queues its item, and the line has to update without a pull-to-refresh.
        const off = subscribeOutbox(items => setOutboxItems(items));
        return () => {
            alive = false;
            off();
        };
    }, []);

    const outboxLine = describeOutboxHandover(summarizeOutbox(outboxItems));

    // ── 'All files' state (the demoted raw file manager) ────────────
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const [articles, setArticles] = useState<RemoteFile[]>([]);
    const [notes, setNotes] = useState<RemoteFile[]>([]);
    const [screensavers, setScreensavers] = useState<RemoteFile[]>([]);
    const [filesLoading, setFilesLoading] = useState(false);
    const [filesLoadedOnce, setFilesLoadedOnce] = useState(false);
    const [deleteLoading, setDeleteLoading] = useState<string | null>(null);
    const [previewMap, setPreviewMap] = useState<Record<string, string>>({});

    // ── Library load ────────────────────────────────────────────────

    /**
     * Reload the merged list.
     *
     * `probeReader` IS THE INVERSE OF `connected`, and the polarity is
     * load-bearing rather than cosmetic (see `LoadLibraryOptions.probeReader`):
     * the probe is the CHEAP tie-breaker for "is the reader even there", so it is
     * wanted exactly when this screen does NOT already know. Connected means the
     * ConnectionProvider just answered that question, so the extra request is
     * skipped; disconnected means the listing path would otherwise burn a folder
     * check, a mkdir and a list — 25 s of certain timeouts — to arrive at the
     * same empty answer a 5 s probe gives, with the user watching a spinner.
     *
     * Never throws: the snapshot carries its own per-side failure flags, so there
     * is no error state to render here.
     */
    const refreshLibrary = useCallback(async () => {
        const next = await loadLibrary(destination, { probeReader: !connected });
        setSnapshot(next);
        setNow(Date.now());
        setLibraryLoading(false);
    }, [destination, connected]);

    useFocusEffect(
        useCallback(() => {
            void refreshLibrary();
        }, [refreshLibrary])
    );

    // ── 'All files' load ────────────────────────────────────────────

    const loadFiles = useCallback(async () => {
        if (!connected) return;

        setFilesLoading(true);
        const baseUrl = getDeviceBaseUrl(destination.ip);

        // Load independently to avoid one blocking the other
        const loadArticlesPromise = (async () => {
            try {
                // BOTH roots: '/books' is where new uploads go, '/send-to-x4' is
                // where an install older than the retarget already has its
                // library. See the scan-roots note above — an unscanned root is
                // content that cannot be seen OR deleted from here.
                const items = await scanRoots(
                    baseUrl,
                    [BOOKS_ROOT, LEGACY_BOOKS_ROOT],
                    BOOK_EXTENSIONS
                );
                setArticles(items);
            } catch (getError) {
                console.warn('Failed to load articles:', getError);
            }
        })();

        const loadNotesPromise = (async () => {
            try {
                // '.frame' is the only thing the firmware reads out of here
                // (current.frame, exactly 52272 B — see love_note_sender.ts).
                const items = await deepScanFolder(baseUrl, LOVE_NOTES_ROOT, ['.frame']);
                setNotes(items);
            } catch (getError) {
                console.warn('Failed to load notes:', getError);
            }
        })();

        const loadScreensaversPromise = (async () => {
            try {
                // BOTH sleep roots. '/.sleep' is what the Wallpaper tab writes and
                // what the firmware prefers; '/sleep' is what
                // uploadScreensaverToCrossPoint still writes. Scanning one of them
                // hid the other's uploads completely.
                const items = await scanRoots(baseUrl, SCREENSAVER_ROOTS, ['.bmp']);
                setScreensavers(items);
            } catch (getError) {
                console.warn('Failed to load screensavers:', getError);
            }
        })();

        const loadPreviewCachePromise = (async () => {
            try {
                const map = await getPreviewMapping();
                setPreviewMap(map);
            } catch (e) {
                console.warn('Failed to load preview map', e);
            }
        })();

        // Wait for all to finish before hiding loader
        await Promise.allSettled([
            loadArticlesPromise,
            loadNotesPromise,
            loadScreensaversPromise,
            loadPreviewCachePromise,
        ]);
        setFilesLoadedOnce(true);
        setFilesLoading(false);
    }, [connected, destination.ip]);

    /**
     * The raw scan is LAZY — first time the section is opened, and never
     * alongside the library load.
     *
     * Three deep scans plus the library's own probe against a firmware HTTP
     * server that answers one request at a time is how `/api/files` starts
     * timing out, and a timed-out scan reads as an EMPTY FOLDER rather than as a
     * failure. Cost of the laziness: a reader-side delete driven from a library
     * row may have no raw listing to resolve a path from, which
     * `resolveReaderFile` handles by scanning the two book roots on demand.
     */
    useEffect(() => {
        if (!advancedOpen || !connected || filesLoadedOnce || filesLoading) return;
        void loadFiles();
    }, [advancedOpen, connected, filesLoadedOnce, filesLoading, loadFiles]);

    // Dropping the reader drops the raw listing: those rows are device state, and
    // a stale folder tree with live delete buttons would delete by guesswork. The
    // LIBRARY list deliberately does the opposite (it keeps a cached snapshot),
    // because a book list is worth reading offline and a folder tree is not.
    useEffect(() => {
        if (connected) return;
        setArticles([]);
        setNotes([]);
        setScreensavers([]);
        setFilesLoadedOnce(false);
    }, [connected]);

    const handleRefresh = useCallback(() => {
        void (async () => {
            setRefreshing(true);
            try {
                await refreshLibrary();
                // Serial, and only for a section the user actually has open.
                if (advancedOpen && connected) await loadFiles();
            } finally {
                setRefreshing(false);
            }
        })();
    }, [refreshLibrary, advancedOpen, connected, loadFiles]);

    /** Re-read whatever this screen is currently showing, after a write. */
    const refreshAfterWrite = useCallback(async () => {
        await refreshLibrary();
        if (advancedOpen && connected) await loadFiles();
    }, [refreshLibrary, advancedOpen, connected, loadFiles]);

    // ── Add books ───────────────────────────────────────────────────

    /**
     * The one WRITE that creates rows. It needs a ROAD, not a reachable reader.
     *
     * NOT gated on the reader answering: `sendEpubsRouted` falls back to the
     * mailbox when it does not, and the reader is asleep most of the time. Was
     * `host && (connected || mailboxConfigured)`, which is the same road
     * ComposeScreen's send gate was missing: a host whose mailbox base is
     * serveable but whose write token is missing got NO Add button, while
     * `routeEpubSend` parks the epub in the outbox and the next Sync-with-reader
     * hands it over — the button hidden precisely when the feature it drives was
     * the only thing that would have worked.
     *
     * `bookRoute`, because this adds books. `host` is still checked here rather
     * than trusted from App.tsx's tab gate.
     */
    const canAddBooks = host && deliverability.bookRoute !== 'none';

    /**
     * Which file the batch is on, so a PHASE line can keep the "3/7: Dune.epub"
     * context `onFileStart` established.
     *
     * A ref, not state: it is read inside callbacks the sender drives and never
     * rendered on its own, so re-rendering the whole library list for it would be
     * pure cost.
     */
    const batchFileRef = useRef<{ index: number; total: number; name: string } | null>(null);

    const handleAddBooks = useCallback(async () => {
        if (!canAddBooks || addingBooks) return;

        // pickEpubs never throws and never re-prompts over a cancel; a rejected
        // mime filter is retried wide-open behind that call.
        const picked = await pickEpubs();
        if (picked.error) {
            Alert.alert('Could Not Open Files', picked.error);
            return;
        }
        if (picked.canceled) return;

        if (picked.picks.length === 0) {
            // Everything the user chose was filtered out — say WHICH and why,
            // through the same wording the success path uses.
            Alert.alert(
                'Nothing to Add',
                describeEpubBatch(
                    { folder: BOOKS_ROOT, succeeded: 0, outcomes: [], failed: [] },
                    picked.rejected
                )
            );
            return;
        }

        setAddingBooks(true);
        batchFileRef.current = null;
        startUpload(
            picked.picks.length === 1
                ? `Sending ${picked.picks[0].name}...`
                : `Sending ${picked.picks.length} books...`
        );

        try {
            // ROUTED, not direct-only. `sendEpubsRouted` runs `routeEpubSend` per
            // file: the reader first, the mailbox when it did not answer and one is
            // configured. The decision stays in the service — this screen only
            // supplies the four facts it depends on and shows what came back.
            const result = await sendEpubsRouted(destination, picked.picks, {
                targetFolder: BOOKS_ROOT,
                // Lets each file skip a reader already known to be asleep rather
                // than spending ~15-25 s of stacked timeouts per book discovering
                // it. The sender collapses the repeats — one probe per batch, not
                // one per file.
                reachability,
                // Re-labels the shared progress bar per file; setProgress then
                // fills it with that file's bytes. Same shape as the screensaver
                // queue's batch upload.
                onFileStart: (index, total, pick) => {
                    batchFileRef.current = { index, total, name: pick.name };
                    startUpload(total > 1
                        ? `Uploading ${index}/${total}: ${pick.name}...`
                        : `Uploading ${pick.name}...`);
                },
                // THE PHASE REPLACES THE LABEL, KEEPING THE FILE CONTEXT. On the
                // mailbox route there is no percent to show at all (`fetch` cannot
                // report upload bytes), so without this the overlay is a bare
                // spinner over a stale "Uploading …" for the whole send — which is
                // exactly what reads as a hang. `startUpload` also clears
                // `progress`, which is right: a new leg has reported nothing yet,
                // so the bar goes back to indeterminate instead of keeping the
                // previous leg's number.
                onPhase: phase => startUpload(describeBatchPhase(phase, batchFileRef.current)),
                // ONLY A REAL PERCENT MOVES THE BAR. `publishBook` emits a coarse 0
                // on entry because `fetch` exposes no upload progress; rendering
                // that as a determinate "0%" for the whole upload is false
                // precision that reads as stuck. The direct route's WS `PROGRESS:`
                // acks are > 0 and still drive a real bar.
                onProgress: percent => { if (percent > 0) setProgress(percent); },
            });

            if (result.failed.length > 0) {
                failUpload(`${result.failed.length} of ${result.outcomes.length} failed`);
            } else {
                finishUpload();
            }

            // Re-read rather than appending optimistically: the merged snapshot is
            // the only proof of WHERE each book actually ended up, and a mailbox
            // book has to come back wearing its mailbox id or it cannot be
            // un-queued afterwards.
            await refreshAfterWrite();

            const queued = result.outcomes.some(o => o.success && o.route === 'mailbox');
            const landed = result.outcomes.some(o => o.success && o.route !== 'mailbox');
            Alert.alert(
                result.succeeded === 0
                    ? 'Nothing Added'
                    : queued && !landed
                        ? 'On Their Way'
                        : 'Books Added',
                describeEpubBatch(result, picked.rejected)
            );
        } catch (error) {
            // sendEpubsRouted is documented never-throws; this keeps a broken
            // promise from leaving the button spinning forever anyway.
            const message = error instanceof Error ? error.message : 'Failed to add books.';
            failUpload(message);
            Alert.alert('Upload Failed', message);
        } finally {
            setAddingBooks(false);
        }
    }, [
        canAddBooks,
        addingBooks,
        destination,
        reachability,
        refreshAfterWrite,
        startUpload,
        setProgress,
        finishUpload,
        failUpload,
    ]);

    // ── Library deletes ─────────────────────────────────────────────

    /**
     * Find the device path for a library row, scanning the two book roots if the
     * raw listing has not been loaded.
     *
     * Needed because a library row carries a display filename and nothing else:
     * the file may live in the LEGACY root, and `/api/files` may have reported a
     * percent-encoded raw name that the delete has to echo back verbatim.
     * Guessing `/books/<display name>` is what silently fails on both.
     *
     * BOOKS_ROOT is passed as the PREFERRED root because that is the only folder
     * a library row can have come from — see `findReaderFile` on why a name-only
     * match deleted the wrong copy.
     */
    const resolveReaderFile = useCallback(
        async (filename: string): Promise<RemoteFile | null> => {
            const known = findReaderFile(articles, filename, BOOKS_ROOT);
            if (known) return known;
            if (!connected) return null;
            const scanned = await scanRoots(
                getDeviceBaseUrl(destination.ip),
                [BOOKS_ROOT, LEGACY_BOOKS_ROOT],
                BOOK_EXTENSIONS
            );
            // Warm the raw section with what the scan just cost, but leave
            // `filesLoadedOnce` alone: notes and screensavers were not scanned.
            setArticles(scanned);
            return findReaderFile(scanned, filename, BOOKS_ROOT);
        },
        [articles, connected, destination.ip]
    );

    const deleteFromReader = useCallback(
        async (book: LibraryBook) => {
            setBusyBook(getBookKey(book));
            try {
                const target = await resolveReaderFile(book.filename);
                if (!target) {
                    Alert.alert(
                        'Not on the reader',
                        `The reader is not listing "${book.filename}" any more. Pull down to refresh.`
                    );
                    await refreshLibrary();
                    return;
                }
                const ok = await deleteCrossPointFile(
                    destination.ip,
                    target.rawName || target.name,
                    target.folder || BOOKS_ROOT
                );
                if (ok) {
                    const id = getFileId(target);
                    setArticles(prev => prev.filter(f => getFileId(f) !== id));
                } else {
                    Alert.alert(
                        'Could Not Delete',
                        `The reader would not remove "${book.filename}". It may be open on the device — try again in a moment.`
                    );
                }
                await refreshLibrary();
            } finally {
                setBusyBook(null);
            }
        },
        [resolveReaderFile, destination.ip, refreshLibrary]
    );

    const deleteFromMailbox = useCallback(
        async (book: LibraryBook) => {
            if (!book.mailboxId) return;
            setBusyBook(getBookKey(book));
            try {
                // Thin over `deleteMailboxBook`; never throws, reports in `ok`.
                const result = await removeMailboxBook(destination, book.mailboxId);
                if (!result.ok) {
                    Alert.alert(
                        'Still in the Mailbox',
                        result.error || `Could not un-queue "${book.filename}".`
                    );
                }
                await refreshLibrary();
            } finally {
                setBusyBook(null);
            }
        },
        [destination, refreshLibrary]
    );

    /**
     * Ask what to delete, then confirm it.
     *
     * The two targets are NOT interchangeable — un-queueing a mailbox book does
     * nothing to a copy already on the card, and deleting from the card does
     * nothing to a queued copy — so a row that is in both places asks rather
     * than picking. Wording says what survives each choice, because that is the
     * part a user cannot undo.
     */
    const handleBookDelete = useCallback(
        (book: LibraryBook) => {
            // The SAME gate `canAddBooks` carries, for the same reason: a client
            // must never hold a path that writes permanent state — and both
            // targets here are shared, the reader's card and the household
            // mailbox. App.tsx only mounts this tab for a host, but that is one
            // unmount away from being the only protection, so the write checks it
            // itself. The bin is not rendered for a client either; this is the
            // second half of that pair, not a duplicate of it.
            if (!host) return;

            const onReader = book.location === 'reader' || book.location === 'both';
            const inMailbox = Boolean(book.mailboxId);

            if (inMailbox && onReader && connected) {
                Alert.alert(
                    'Remove Book',
                    `"${book.filename}" is on the reader and still queued in the mailbox. Which copy?`,
                    [
                        { text: 'Cancel', style: 'cancel' },
                        {
                            text: 'From the mailbox',
                            style: 'destructive',
                            onPress: () => void deleteFromMailbox(book),
                        },
                        {
                            text: 'From the reader',
                            style: 'destructive',
                            onPress: () => void deleteFromReader(book),
                        },
                    ]
                );
                return;
            }

            if (onReader && connected) {
                Alert.alert('Delete Book', `Delete "${book.filename}" from the reader?`, [
                    { text: 'Cancel', style: 'cancel' },
                    {
                        text: 'Delete',
                        style: 'destructive',
                        onPress: () => void deleteFromReader(book),
                    },
                ]);
                return;
            }

            if (inMailbox) {
                Alert.alert(
                    'Take Out of the Mailbox',
                    `Stop "${book.filename}" being delivered? If the reader has already collected it, its copy stays — you can remove that once you're on its WiFi.`,
                    [
                        { text: 'Cancel', style: 'cancel' },
                        {
                            text: 'Remove',
                            style: 'destructive',
                            onPress: () => void deleteFromMailbox(book),
                        },
                    ]
                );
                return;
            }

            // On the reader, no reader. Not an error — just not now. KEPT (the
            // user just tapped the bin), trimmed to the one fact the title does
            // not already carry.
            if (onReader) {
                Alert.alert('Reader asleep', 'This book can only be removed with the reader awake.');
                return;
            }

            // A mailbox row with no id cannot happen through `loadLibrary` (it
            // drops entries without one, because the id is the only delete
            // handle), so this is the "the list moved under you" case.
            Alert.alert(
                'Nothing to Remove',
                `"${book.filename}" is no longer on the reader or in the mailbox. Pull down to refresh.`
            );
        },
        [host, connected, deleteFromMailbox, deleteFromReader]
    );

    // ── 'All files' deletes (unchanged behaviour) ───────────────────

    const handleDeleteArticle = (file: RemoteFile) => {
        const fileId = getFileId(file);
        Alert.alert('Delete File', `Delete "${file.name}"?`, [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Delete', style: 'destructive',
                onPress: async () => {
                    setDeleteLoading(fileId);
                    const folder = file.folder || BOOKS_ROOT;
                    const filename = file.rawName || file.name;
                    const success = await deleteCrossPointFile(destination.ip, filename, folder);

                    if (success) {
                        setArticles(prev => prev.filter(f => getFileId(f) !== fileId));
                        // The same file may be a LIBRARY row; that list is derived
                        // from the device, so it has to be re-read rather than
                        // patched in two places.
                        await refreshLibrary();
                    } else {
                        Alert.alert('Error', 'Failed to delete file');
                    }
                    setDeleteLoading(null);
                },
            },
        ]);
    };

    const handleDeleteNote = (file: RemoteFile) => {
        const fileId = getFileId(file);
        Alert.alert('Delete File', `Delete "${file.name}"?`, [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Delete', style: 'destructive',
                onPress: async () => {
                    setDeleteLoading(fileId);
                    const folder = file.folder || LOVE_NOTES_ROOT;
                    const filename = file.rawName || file.name;
                    const success = await deleteCrossPointFile(destination.ip, filename, folder);

                    if (success) {
                        setNotes(prev => prev.filter(f => getFileId(f) !== fileId));
                    } else {
                        Alert.alert('Error', 'Failed to delete file');
                    }
                    setDeleteLoading(null);
                },
            },
        ]);
    };

    const handleDeleteScreensaver = (file: RemoteFile) => {
        const fileId = getFileId(file);
        Alert.alert('Delete File', `Delete "${file.name}"?`, [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Delete', style: 'destructive',
                onPress: async () => {
                    setDeleteLoading(fileId);
                    // deepScanFolder always stamps the folder it found the file
                    // in, so this fallback is unreachable in practice; it points
                    // at the firmware-preferred root rather than the legacy one
                    // so it cannot become wrong if that ever stops being true.
                    const folder = file.folder || SLEEP_SET_FOLDER;
                    const filename = file.rawName || file.name;
                    const success = await deleteCrossPointFile(destination.ip, filename, folder);

                    if (success) {
                        setScreensavers(prev => prev.filter(f => getFileId(f) !== fileId));
                        await removePreviewMapping(filename);
                    } else {
                        Alert.alert('Error', 'Failed to delete file');
                    }
                    setDeleteLoading(null);
                },
            },
        ]);
    };

    // ── Derived copy ────────────────────────────────────────────────

    const books = snapshot?.books ?? [];
    const readerFresh = snapshot?.readerFresh ?? false;
    const readerListedAt = snapshot?.readerListedAt ?? null;
    const mailboxOk = snapshot?.mailboxOk ?? false;

    /**
     * The reader-side caption. QUIET, and only when the reader is not live: an
     * asleep reader is the normal state of this device, so it gets a sentence,
     * never a banner and never a red tint.
     *
     * SILENT UNTIL THERE IS A SNAPSHOT. `readerFresh` defaults to false, and the
     * captions render ABOVE the loading card, so without this the screen asserted
     * "Reader asleep — nothing listed from it yet" for the whole first load — the
     * folder check plus the listing, seconds — on a reader that was connected the
     * entire time. Nothing is claimed about a side that has not answered yet.
     */
    const readerCaption = useMemo(() => {
        if (libraryLoading || !snapshot) return null;
        if (readerFresh) return null;
        if (readerListedAt) {
            // The TIMESTAMP is the information — it says how much to trust the
            // list below. The instruction that used to follow it is gone.
            return `${READER_ASLEEP_CAPTION} — card listed ${formatRelativeTime(readerListedAt, now)}.`;
        }
        return `${READER_ASLEEP_CAPTION} — nothing listed from the card yet.`;
    }, [libraryLoading, snapshot, readerFresh, readerListedAt, now]);

    /**
     * The mailbox-side caption.
     *
     * Silent when no mailbox is configured AND the reader is live — there is
     * nothing wrong in that case, and naming an unused feature on every visit is
     * nagging. When the reader is asleep it becomes the answer to "why can't I
     * see or add anything", so it is worth one line.
     *
     * SILENT UNTIL THERE IS A SNAPSHOT, for the same reason as the reader caption:
     * a first render used to say "No mailbox set up" while the load was still in
     * flight. That is why the flag is read off the SNAPSHOT only, with no
     * `mailboxConfigured` fallback — the fallback existed to cover exactly the
     * render this now skips.
     */
    const mailboxCaption = useMemo(() => {
        if (libraryLoading || !snapshot) return null;
        // `mailboxOk` is false both for "no mailbox" and for "the mailbox is
        // broken"; `mailboxConfigured` is the field that separates them, and only
        // the second is worth a line.
        if (!snapshot.mailboxConfigured) {
            if (readerFresh) return null;
            // The route chip beside the title already carries "Set up" and is
            // the one pointer at Settings on this screen, so this line no longer
            // repeats the instruction — it only names the missing half.
            return 'No mailbox set up.';
        }
        if (mailboxOk) return null;
        return `Mailbox unavailable — ${snapshot.mailboxError || 'could not read the queue.'}`;
    }, [libraryLoading, snapshot, mailboxOk, readerFresh]);

    const hasLegacyBooks = articles.some(file => isUnderRoot(file, LEGACY_BOOKS_ROOT));
    const rowsBusy = busyBook !== null || addingBooks || deleteLoading !== null;

    /**
     * Offered when there is a mailbox this phone can SERVE, and to a host only.
     *
     * `deliverability.apHandoverReady`, not a predicate of its own. It used to be
     * `host && mailboxConfigured`, which was wrong twice: too strict, because the
     * write token is deliberately never handed to the proxy, so a missing token
     * hid a sync that would have worked; and unshared, so the model went on
     * promising 'Next sync' from a saved AP passphrase while this button — the
     * only thing that can drain the outbox — was not on the screen at all.
     *
     * The real constraint is unchanged and now lives in `isHandoverAvailable`: a
     * proxy with no upstream would join the reader's AP, drop the phone off its
     * own WiFi and serve 502s, so the base must be one `describeProxyTarget`
     * accepts. `sync_session.start` enforces exactly that a moment later.
     *
     * NOT gated on the native module being present. A build without it is the
     * normal state until the next native rebuild, and the button's own status line
     * says exactly that — which is far more useful than a feature that silently
     * does not exist.
     */
    const canSyncWithReader = deliverability.apHandoverReady;

    return (
        <View style={styles.container}>
            <ScrollView
                style={styles.content}
                contentContainerStyle={[styles.contentContainer, { paddingBottom: tabBarInset }]}
                refreshControl={
                    <RefreshControl
                        refreshing={refreshing}
                        onRefresh={handleRefresh}
                        tintColor={theme.colors.accent}
                    />
                }
            >
                <View style={styles.titleRow}>
                    <Text style={styles.title} numberOfLines={1}>Library</Text>
                    {/* WHERE THE NEXT BOOK GOES, in a word. Replaces the
                        subtitle ("Every book you've sent — on the reader, or
                        waiting in the mailbox until it wakes"), which was
                        describing the same routing in prose AND asserting it
                        unconditionally, on a phone that might have neither road.
                        `bookRoute`, not `summary`: books are what this tab
                        sends. The two agree today and a test pins that, but
                        reading the field that belongs to this screen is what
                        makes the day they diverge a non-event. */}
                    <RouteChip summary={bookSummary} style={styles.titleChip} testID="library-route-chip" />
                </View>

                {canAddBooks ? (
                    <TouchableOpacity
                        style={[styles.primaryButton, rowsBusy && styles.primaryButtonDisabled]}
                        onPress={handleAddBooks}
                        disabled={addingBooks || rowsBusy}
                        accessibilityRole="button"
                        accessibilityLabel="Add books"
                    >
                        {addingBooks ? (
                            <ActivityIndicator size="small" color={theme.colors.accentText} />
                        ) : (
                            <Text style={styles.primaryButtonText}>+ Add books</Text>
                        )}
                    </TouchableOpacity>
                ) : null}

                {/* ── Sync with reader (A3 peer link) ─────────────────
                    Secondary to '+ Add books' on purpose: adding is the everyday
                    action, and this is what you do when the reader has no
                    internet to collect what you added. */}
                {canSyncWithReader ? (
                    <TouchableOpacity
                        style={[styles.syncButton, syncActive && styles.syncButtonActive]}
                        onPress={handleSyncPress}
                        accessibilityRole="button"
                        accessibilityLabel={
                            syncActive ? 'Stop syncing with the reader' : 'Sync with reader'
                        }
                    >
                        {syncActive ? (
                            <ActivityIndicator size="small" color={theme.colors.accent} />
                        ) : null}
                        <Text style={styles.syncButtonText}>
                            {syncActive ? 'Stop syncing' : 'Sync with reader'}
                        </Text>
                    </TouchableOpacity>
                ) : null}

                {/* Before the session line, because it is the reason to start one:
                    what the phone is already holding for the reader, deliverable
                    with no internet on either side. */}
                {outboxLine ? <Text style={styles.caption}>{outboxLine}</Text> : null}
                {syncLine ? <Text style={styles.caption}>{syncLine}</Text> : null}
                {syncModeLine ? <Text style={styles.caption}>{syncModeLine}</Text> : null}
                {syncUpstreamLine ? <Text style={styles.caption}>{syncUpstreamLine}</Text> : null}
                {/* A3's last honest constraint: joining the reader's 2.4 GHz AP
                    costs the phone its own WiFi association, so everything the
                    proxy forwards travels on cellular. A user on metered data
                    gets to know that BEFORE a 24 MiB book goes through. */}
                {/* SUPPRESSED IN LOCAL MODE, and that is a correctness fix, not a
                    tidy-up: when the proxy is answering from the outbox nothing
                    travels on cellular at all, and warning about metered data
                    would talk a user out of the one flow that works with no
                    signal. 'unknown' keeps the warning — a dev client older than
                    local serve really is forwarding everything. */}
                {/* SUPPRESSED WITH A DEAD UPSTREAM TOO, for the same reason one
                    step further on: nothing is travelling on cellular if nothing
                    can reach the mailbox, and "your phone is on mobile data"
                    sitting directly under "couldn't reach the mailbox" reads as
                    a contradiction the user has to resolve themselves. */}
                {syncActive &&
                syncSession.mode !== 'local' &&
                syncSession.mode !== 'none' &&
                syncSession.upstreamOk !== false ? (
                    <Text style={styles.caption}>
                        Your phone is on mobile data while this runs, and needs to stay near the
                        reader.
                    </Text>
                ) : null}

                {readerCaption ? <Text style={styles.caption}>{readerCaption}</Text> : null}
                {mailboxCaption ? <Text style={styles.caption}>{mailboxCaption}</Text> : null}

                {libraryLoading ? (
                    <View style={styles.loadingCard}>
                        <ActivityIndicator color={theme.colors.accent} />
                    </View>
                ) : books.length === 0 ? (
                    <EmptyLibrary
                        canAddBooks={canAddBooks}
                        // Neither side answered, so "No books yet" would be a
                        // claim nothing supports — see EmptyLibrary.
                        listed={readerFresh || mailboxOk}
                        onAddBooks={handleAddBooks}
                    />
                ) : (
                    <View style={styles.list}>
                        {books.map(book => (
                            <BookRow
                                key={getBookKey(book)}
                                book={book}
                                busy={busyBook === getBookKey(book)}
                                disabled={rowsBusy}
                                // A client reads the list; only a host removes
                                // from it. See `handleBookDelete`.
                                canDelete={host}
                                onDelete={handleBookDelete}
                            />
                        ))}
                    </View>
                )}

                {/* ── All files (advanced) ─────────────────────────────
                    The raw file manager, demoted. Host-only, exactly as the
                    whole tab is, and collapsed because the merged list above is
                    what a user wants nine visits out of ten. */}
                {host ? (
                    <View style={styles.advanced}>
                        <TouchableOpacity
                            style={styles.disclosure}
                            onPress={() => setAdvancedOpen(open => !open)}
                            accessibilityRole="button"
                            accessibilityState={{ expanded: advancedOpen }}
                        >
                            <Text style={styles.disclosureTitle}>All files</Text>
                            <Text style={styles.disclosureAction}>
                                {advancedOpen ? 'Hide' : 'Show'}
                            </Text>
                        </TouchableOpacity>

                        {advancedOpen ? (
                            !connected ? (
                                <Text style={styles.caption}>{READER_ASLEEP_CAPTION}</Text>
                            ) : (
                                <>
                                    {/* The hint that sat here ("Everything on the
                                        card, folder by folder — including the
                                        files the library above doesn't cover") is
                                        gone. The disclosure is labelled "All
                                        files" and what follows is the folders. */}

                                    {/* Books Section */}
                                    <View style={styles.section}>
                                        <View style={styles.sectionHeader}>
                                            <Text style={styles.sectionTitle}>
                                                Books ({articles.length})
                                            </Text>
                                        </View>
                                        <Text style={styles.sectionPath}>
                                            /{BOOKS_ROOT}/**
                                            {hasLegacyBooks ? `  +  /${LEGACY_BOOKS_ROOT}/** (older)` : ''}
                                        </Text>

                                        {filesLoading && articles.length === 0 ? (
                                            <ActivityIndicator size="small" color={theme.colors.accent} style={styles.loader} />
                                        ) : articles.length === 0 ? (
                                            // Names the destination, because the empty state is
                                            // what a user with content under the OLD root would
                                            // be staring at if the root merge ever regresses.
                                            <Text style={styles.emptyListText}>
                                                No books on device — new ones are added to /{BOOKS_ROOT}
                                            </Text>
                                        ) : (
                                            articles.map(file => (
                                                <FileRow
                                                    key={getFileId(file)}
                                                    file={file}
                                                    cachedPreviewUrl={previewMap[file.name]}
                                                    onDelete={() => handleDeleteArticle(file)}
                                                    deleting={deleteLoading === getFileId(file)}
                                                    disabled={deleteLoading !== null}
                                                />
                                            ))
                                        )}
                                    </View>

                                    {/* Notes Section */}
                                    <View style={styles.section}>
                                        <View style={styles.sectionHeader}>
                                            <Text style={styles.sectionTitle}>
                                                Notes ({notes.length})
                                            </Text>
                                        </View>
                                        <Text style={styles.sectionPath}>
                                            /{LOVE_NOTES_ROOT}/**
                                        </Text>

                                        {filesLoading && notes.length === 0 ? (
                                            <ActivityIndicator size="small" color={theme.colors.accent} style={styles.loader} />
                                        ) : notes.length === 0 ? (
                                            <Text style={styles.emptyListText}>No notes on device</Text>
                                        ) : (
                                            notes.map(file => (
                                                <FileRow
                                                    key={getFileId(file)}
                                                    file={file}
                                                    onDelete={() => handleDeleteNote(file)}
                                                    deleting={deleteLoading === getFileId(file)}
                                                    disabled={deleteLoading !== null}
                                                />
                                            ))
                                        )}
                                    </View>

                                    {/* Screensavers Section */}
                                    <View style={styles.section}>
                                        <View style={styles.sectionHeader}>
                                            <Text style={styles.sectionTitle}>
                                                Screensavers ({screensavers.length})
                                            </Text>
                                        </View>
                                        <Text style={styles.sectionPath}>
                                            {SCREENSAVER_ROOTS.map(root => `/${root}/**`).join('  +  ')}
                                        </Text>

                                        {filesLoading && screensavers.length === 0 ? (
                                            <ActivityIndicator size="small" color={theme.colors.accent} style={styles.loader} />
                                        ) : screensavers.length === 0 ? (
                                            <Text style={styles.emptyListText}>No screensavers on device</Text>
                                        ) : (
                                            screensavers.map(file => (
                                                <FileRow
                                                    key={getFileId(file)}
                                                    file={file}
                                                    cachedPreviewUrl={previewMap[file.name]}
                                                    onDelete={() => handleDeleteScreensaver(file)}
                                                    deleting={deleteLoading === getFileId(file)}
                                                    disabled={deleteLoading !== null}
                                                />
                                            ))
                                        )}
                                    </View>
                                </>
                            )
                        ) : null}
                    </View>
                ) : null}
            </ScrollView>

            {/* Batch progress, same overlay the screensaver queue uses. Text and
                percent both come from ProgressProvider, which the routed send
                drives per file. */}
            <ProcessingOverlay
                visible={addingBooks}
                message={
                    typeof progress === 'number'
                        ? `${uploadText} ${progress}%`
                        : uploadText || 'Sending books...'
                }
            />
        </View>
    );
}

// ── Library row ──────────────────────────────────────────────────────

/**
 * One book, with a chip per place it currently exists.
 *
 * TWO CHIPS for a `both` row rather than a third combined label: the row is
 * making one claim per location, and the delete flow asks per location too, so a
 * merged "on reader + mailbox" string would be the only place those two facts
 * were fused back together.
 */
function BookRow({
    book,
    busy,
    disabled,
    canDelete,
    onDelete,
}: {
    book: LibraryBook;
    busy: boolean;
    disabled: boolean;
    /** Host-only. A client sees the row and no bin — see `handleBookDelete`. */
    canDelete: boolean;
    onDelete: (book: LibraryBook) => void;
}) {
    const theme = useTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);

    const onReader = book.location === 'reader' || book.location === 'both';
    const inMailbox = book.location === 'mailbox' || book.location === 'both';
    const size = formatBookSize(book.bytes);

    return (
        <View style={styles.bookRow}>
            <View style={styles.bookInfo}>
                <Text style={styles.bookName} numberOfLines={2}>
                    {book.filename}
                </Text>

                <View style={styles.chipRow}>
                    {onReader ? (
                        <View style={[styles.chip, styles.chipReader]}>
                            <Text style={styles.chipReaderText}>On reader</Text>
                        </View>
                    ) : null}
                    {inMailbox ? (
                        <View style={[styles.chip, styles.chipMailbox]}>
                            <Text style={styles.chipMailboxText}>In mailbox</Text>
                        </View>
                    ) : null}
                    {size ? <Text style={styles.bookSize}>{size}</Text> : null}
                </View>

                {/* The canonical clause, imported rather than re-worded: the batch
                    summary after an upload says the same thing about the same
                    book, and the two must not drift. Shown for a mailbox-only row
                    — once it is on the card too, the reader chip is the answer. */}
                {inMailbox && !onReader ? (
                    <Text style={styles.bookNote}>Waiting — {MAILBOX_LANDING_CLAUSE}.</Text>
                ) : null}
            </View>

            {canDelete ? (
                <TouchableOpacity
                    style={[styles.actionButton, disabled && !busy && styles.actionButtonDisabled]}
                    onPress={() => onDelete(book)}
                    disabled={disabled}
                    hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${book.filename}`}
                >
                    {busy ? (
                        <ActivityIndicator size="small" color={theme.colors.danger} />
                    ) : (
                        <BinIcon size={ACTION_ICON_SIZE} color={theme.colors.danger} />
                    )}
                </TouchableOpacity>
            ) : null}
        </View>
    );
}

/**
 * The empty library.
 *
 * A FIRST-CLASS STATE: a fresh pairing lands here, so it gets the brand mark and
 * a way out rather than a bare sentence. The ACTION still changes with what the
 * phone can do — offering "Add books" to a phone with no road at all would be
 * offering a button that cannot work — but the copy no longer branches on
 * `connected` or `mailboxConfigured` to explain where an added book would go.
 * The route chip beside the screen title says that, once, in a word, and those
 * two props left with the sentences that read them.
 *
 * `listed` IS NOT COSMETIC and stays. An empty list means one of two very
 * different things: both sides answered and there really are no books, or
 * NEITHER side could be read — a sleeping reader with no cached listing and no
 * mailbox. Saying "No books yet" in the second case is a claim about content
 * nothing has looked at, so that case says so instead.
 */
function EmptyLibrary({
    canAddBooks,
    listed,
    onAddBooks,
}: {
    canAddBooks: boolean;
    /** True when at least one side (reader or mailbox) actually answered. */
    listed: boolean;
    onAddBooks: () => void;
}) {
    const theme = useTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);

    // ONE WARM LINE PER STATE, down from a five-branch matrix of sentences.
    //
    // Deliberately does NOT diagnose which side failed, or say where an added
    // book would travel: the two captions above this card already carry the
    // per-side status, and the route chip beside the title carries the road. A
    // third opinion here could contradict either.
    //
    // The `listed` distinction SURVIVES the trim, because it is the one thing
    // this card knows that nothing else on screen does: "no books" and "nobody
    // answered" are different facts, and printing the first when the second is
    // true is a claim about content nothing has looked at.
    const message = listed ? 'No books yet.' : "Couldn't read the list.";

    return (
        <View style={styles.placeholderCard}>
            <DeviceIcon size={EMPTY_ICON_SIZE} color={theme.colors.textMuted} />
            <Text style={styles.placeholderText}>{message}</Text>
            {canAddBooks ? (
                <TouchableOpacity
                    style={styles.emptyAction}
                    onPress={onAddBooks}
                    accessibilityRole="button"
                >
                    <Text style={styles.linkText}>+ Add books</Text>
                </TouchableOpacity>
            ) : null}
        </View>
    );
}

// ── Raw file row (unchanged) ─────────────────────────────────────────

/** Reusable row for a single file */
function FileRow({
    file,
    cachedPreviewUrl,
    onDelete,
    deleting,
    disabled,
}: {
    file: RemoteFile;
    cachedPreviewUrl?: string;
    onDelete: () => void;
    deleting: boolean;
    disabled: boolean;
}) {
    const theme = useTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);
    const swipeableRef = React.useRef<Swipeable>(null);
    const [previewUri, setPreviewUri] = React.useState<string | null>(null);
    const [previewLoading, setPreviewLoading] = React.useState(false);

    const renderRightActions = (progress: Animated.AnimatedInterpolation<number>, dragX: Animated.AnimatedInterpolation<number>) => {
        const scale = dragX.interpolate({
            inputRange: [-60, -30, 0],
            outputRange: [1, 0.8, 0],
            extrapolate: 'clamp',
        });

        // The background that shows while dragging
        return (
            <View style={styles.deleteAction}>
                {/*
                  * Animated.View, not Animated.Text: the glyph is an SVG now, so
                  * the drag scale animates the wrapper. `accentText` is the only
                  * readable ink on the solid `danger` fill — see BinIcon's note
                  * on why an emoji could not be recolored to it.
                  */}
                <Animated.View style={{ transform: [{ scale }] }}>
                    <BinIcon size={22} color={theme.colors.accentText} />
                </Animated.View>
            </View>
        );
    };

    const handleSwipeOpen = () => {
        // Trigger the delete flow immediately
        onDelete();
        // Since `onDelete` pops an alert, we can close the row visually in the background
        swipeableRef.current?.close();
    };

    return (
        <Swipeable
            ref={swipeableRef}
            renderRightActions={renderRightActions}
            friction={1}
            rightThreshold={35}
            enabled={!disabled}
            onSwipeableOpen={handleSwipeOpen}
        >
            <View style={styles.fileItemContainer}>
                <View style={[styles.fileItem, previewUri ? styles.fileItemOpen : null]}>
                    {cachedPreviewUrl && (
                        <TouchableOpacity
                            style={styles.previewButton}
                            onPress={() => {
                                if (previewUri) {
                                    setPreviewUri(null);
                                } else {
                                    setPreviewLoading(true);
                                    setPreviewUri(cachedPreviewUrl);
                                }
                            }}
                            disabled={disabled}
                        >
                            <Image
                                source={{ uri: cachedPreviewUrl }}
                                style={[styles.rowThumbnail, previewUri && styles.rowThumbnailActive]}
                                resizeMode="cover"
                            />
                        </TouchableOpacity>
                    )}

                    <View style={styles.fileInfo}>
                        <Text style={styles.fileName}>{file.name}</Text>
                        <Text style={styles.fileMeta}>
                            {file.timestamp
                                ? new Date(file.timestamp).toLocaleDateString()
                                : 'Unknown date'}
                            {file.size ? ` · ${(file.size / 1024).toFixed(1)} KB` : ''}
                        </Text>
                    </View>

                    {/* Fallback standard bin icon if user prefers tapping without swiping */}
                    <TouchableOpacity
                        style={styles.deleteButton}
                        onPress={onDelete}
                        disabled={disabled}
                    >
                        {deleting ? (
                            <ActivityIndicator size="small" color={theme.colors.danger} />
                        ) : (
                            <BinIcon size={18} color={theme.colors.danger} />
                        )}
                    </TouchableOpacity>
                </View>

                {previewUri && (
                    <View style={styles.previewContainer}>
                        {previewLoading && (
                            <ActivityIndicator
                                style={styles.previewLoader}
                                size="small"
                                color={theme.colors.accent}
                            />
                        )}
                        <Image
                            source={{ uri: previewUri }}
                            style={styles.previewImage}
                            resizeMode="contain"
                            onLoadEnd={() => setPreviewLoading(false)}
                            onError={() => {
                                setPreviewLoading(false);
                                Alert.alert("Error", "Could not load preview. The file might be corrupted or the device may be busy.");
                                setPreviewUri(null);
                            }}
                        />
                    </View>
                )}
            </View>
        </Swipeable>
    );
}

function createStyles(theme: Theme) {
    return StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: theme.colors.bg,
    },
    content: {
        flex: 1,
    },
    contentContainer: {
        padding: theme.spacing.xl,
        // paddingBottom is supplied at the call site from useTabBarInset() —
        // it depends on the safe-area inset, which a static sheet can't see.
    },
    /**
     * Title and route chip on one baseline.
     *
     * `space-between` rather than a gap: the chip belongs to the far edge, where
     * a status reads as status. Next to the serif it reads as a subtitle, which
     * is the thing being deleted.
     */
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: theme.spacing.lg,
        gap: theme.spacing.sm,
    },
    /** Pairs with `title`'s `flexShrink: 1` — the chip keeps its one word. */
    titleChip: {
        flexShrink: 0,
    },
    title: {
        ...theme.type.h1,
        fontFamily: theme.fonts.display,
        color: theme.colors.text,
        // No marginBottom: `titleRow` owns the gap now that the subtitle under
        // it is gone.
        //
        // THE HEADING YIELDS, NOT THE CHIP. `space-between` on a row with no
        // wrap gives both children their natural width, and 'Next sync' is wide
        // enough that a large system font scale on a narrow device would push
        // the two into each other. Shrinking the serif h1 (which can ellipsize
        // 'Library' harmlessly) is strictly better than shrinking a chip whose
        // whole content is one word.
        flexShrink: 1,
    },
    /** Quiet status lines — an asleep reader gets a sentence, never a banner. */
    caption: {
        ...theme.type.caption,
        color: theme.colors.textMuted,
        marginBottom: theme.spacing.sm,
    },
    primaryButton: {
        backgroundColor: theme.colors.accent,
        borderRadius: theme.radii.lg,
        paddingVertical: theme.spacing.md,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: theme.spacing.md,
        ...theme.shadows.raised,
    },
    primaryButtonDisabled: {
        opacity: 0.5,
    },
    /**
     * 'Sync with reader' — outlined, not filled.
     *
     * The screen already has one accent-filled call to action ('+ Add books');
     * two would compete, and this one is the occasional, deliberate action rather
     * than the everyday one.
     */
    syncButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.spacing.sm,
        borderRadius: theme.radii.lg,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface,
        paddingVertical: theme.spacing.md,
        marginBottom: theme.spacing.md,
    },
    /** Running: the accent moves to the border so the row reads as live. */
    syncButtonActive: {
        borderColor: theme.colors.accent,
    },
    syncButtonText: {
        ...theme.type.button,
        // On `surface`, so the ordinary text colour — NOT accentText, which is
        // only legible on an accent fill.
        color: theme.colors.text,
    },
    primaryButtonText: {
        ...theme.type.button,
        // On a solid `accent` fill, so `accentText` — 4.94:1 light / 6.73:1 dark.
        color: theme.colors.accentText,
    },
    list: {
        marginTop: theme.spacing.xs,
    },
    loadingCard: {
        paddingVertical: theme.spacing.xxxl,
        alignItems: 'center',
    },
    placeholderCard: {
        alignItems: 'center',
        backgroundColor: theme.colors.surface,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: theme.radii.md,
        paddingVertical: theme.spacing.xxl,
        paddingHorizontal: theme.spacing.xl,
        ...theme.shadows.card,
    },
    placeholderText: {
        ...theme.type.body,
        color: theme.colors.textMuted,
        textAlign: 'center',
        marginTop: theme.spacing.md,
    },
    emptyAction: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.sm,
        marginTop: 14,
    },
    linkText: {
        ...theme.type.label,
        color: theme.colors.accent,
    },
    // ── Library rows ───────────────────────────────────────────
    bookRow: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.colors.surface,
        paddingVertical: theme.spacing.md,
        paddingHorizontal: 14,
        borderRadius: theme.radii.md,
        borderWidth: 1,
        borderColor: theme.colors.border,
        marginBottom: 6,
        ...theme.shadows.card,
    },
    bookInfo: {
        flex: 1,
        marginRight: 10,
    },
    bookName: {
        ...theme.type.label,
        fontWeight: '600',
        color: theme.colors.text,
    },
    chipRow: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: theme.spacing.sm,
        marginTop: 6,
    },
    chip: {
        paddingHorizontal: theme.spacing.sm,
        paddingVertical: 2,
        borderRadius: theme.radii.pill,
        borderWidth: 1,
    },
    chipReader: {
        backgroundColor: theme.tints.success,
        borderColor: theme.alpha(theme.colors.success, 0.3),
    },
    chipReaderText: {
        ...theme.type.caption,
        fontWeight: '600',
        // `success` on its own tint measures 4.53:1 light / 5.87:1 dark.
        color: theme.colors.success,
    },
    chipMailbox: {
        backgroundColor: theme.tints.accent,
        borderColor: theme.alpha(theme.colors.accent, 0.35),
    },
    chipMailboxText: {
        ...theme.type.caption,
        fontWeight: '600',
        // `text`, not `accent`: accent on its own tint is 3.92:1 in light mode
        // and this is 12px copy. See tokens.ts's AA GUARDRAIL.
        color: theme.colors.text,
    },
    bookSize: {
        ...theme.type.caption,
        color: theme.colors.textMuted,
    },
    bookNote: {
        fontSize: 11,
        lineHeight: 15,
        color: theme.colors.textMuted,
        marginTop: theme.spacing.xs,
        fontStyle: 'italic',
    },
    actionButton: {
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: theme.radii.pill,
        backgroundColor: theme.colors.surface2,
    },
    actionButtonDisabled: {
        opacity: 0.35,
    },
    // ── All files (advanced) ───────────────────────────────────
    advanced: {
        marginTop: theme.spacing.xxl,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        paddingTop: theme.spacing.md,
    },
    disclosure: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: theme.spacing.sm,
    },
    disclosureTitle: {
        ...theme.type.h2,
        color: theme.colors.text,
    },
    disclosureAction: {
        ...theme.type.label,
        color: theme.colors.accent,
    },
    // `advancedHint` went with the one sentence it styled.
    section: {
        marginBottom: 28,
    },
    sectionHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
    },
    sectionTitle: {
        // Emoji dropped from the three headers (§3, subtraction before addition):
        // "Books (12)" is unambiguous without a leading 📄.
        ...theme.type.h2,
        color: theme.colors.text,
    },
    sectionPath: {
        // DEVICE PATHS. Monospace and byte-exact — the user may have to compare
        // these against what is actually on the card.
        color: theme.colors.textMuted,
        fontSize: 12,
        fontFamily: 'monospace' as any,
        marginTop: theme.spacing.xs,
        marginBottom: theme.spacing.md,
    },
    loader: {
        marginTop: theme.spacing.xl,
    },
    emptyListText: {
        ...theme.type.body,
        color: theme.colors.textMuted,
        fontStyle: 'italic',
        textAlign: 'center',
        marginTop: theme.spacing.lg,
    },
    fileItemContainer: {
        marginBottom: theme.spacing.sm,
        borderRadius: theme.radii.md,
        backgroundColor: theme.colors.surface,
        borderWidth: 1,
        borderColor: theme.colors.border,
        overflow: 'hidden',
        ...theme.shadows.card,
    },
    fileItem: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: theme.spacing.md,
    },
    fileItemOpen: {
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
    },
    fileInfo: {
        flex: 1,
    },
    fileName: {
        ...theme.type.label,
        fontWeight: '400',
        color: theme.colors.text,
        marginBottom: theme.spacing.xs,
    },
    fileMeta: {
        ...theme.type.caption,
        color: theme.colors.textMuted,
    },
    deleteButton: {
        padding: 10,
    },
    deleteAction: {
        // Warm clay, not the old pure `#ff4444`.
        backgroundColor: theme.colors.danger,
        justifyContent: 'center',
        alignItems: 'flex-end',
        marginBottom: theme.spacing.sm,
        borderRadius: theme.radii.md,
        flex: 1, // Fill available space behind the row
        paddingHorizontal: theme.spacing.xl,
    },
    previewButton: {
        padding: theme.spacing.xs,
        marginRight: 10,
        marginLeft: -4,
    },
    rowThumbnail: {
        width: 24,
        height: 40,
        borderRadius: theme.radii.sm,
        opacity: 0.8,
        backgroundColor: theme.colors.surface2,
    },
    rowThumbnailActive: {
        opacity: 1,
        borderColor: theme.colors.accent,
        borderWidth: 1.5,
    },
    previewContainer: {
        // Chrome around a DEVICE image (a BMP already on the card), so it is
        // themed — the image's own pixels are untouched.
        width: '100%',
        backgroundColor: theme.colors.surface2,
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 150,
        padding: theme.spacing.md,
    },
    previewLoader: {
        position: 'absolute',
    },
    previewImage: {
        width: '100%',
        height: 200,
        borderRadius: theme.radii.sm,
    }
    });
}
