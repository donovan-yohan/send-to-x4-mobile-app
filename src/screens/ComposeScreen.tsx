/**
 * ComposeScreen — the messenger's write path.
 *
 * Three ways to author the same thing, a love-note frame:
 *
 *   photo   pick from the library (or receive one from the OS share sheet),
 *           choose cover/fit framing, dithered 'photo' halftone.
 *   text    the CanvasComposer in text mode, captured to PNG, 'graphic' threshold.
 *   doodle  the CanvasComposer in doodle mode, same capture -> encode path.
 *
 * All three converge on `prepareLoveNoteFrame` -> `sendLoveNote`, which is the
 * only thing the device contract cares about (exactly 52272 bytes — see
 * src/device/x3.ts).
 *
 * ---------------------------------------------------------------------------
 * WHERE A NOTE GOES
 * ---------------------------------------------------------------------------
 * This screen does NOT choose a route. It hands `sendLoveNote` one
 * `LoveNoteDestination` and that service decides: a host pushes straight at the
 * reader (`/.love-notes/current.frame`) and falls back to the mailbox when the
 * reader does not answer; a client has no LAN route at all and always uses the
 * mailbox. The route that won comes back as `result.path` and is put on both
 * the toast and the history row — "on the panel now" and "waiting for the
 * reader to wake" are different enough that a single "Sent ✓" is a lie in one
 * of the two cases.
 *
 * ---------------------------------------------------------------------------
 * ORIENTATION
 * ---------------------------------------------------------------------------
 * All three modes are composed in whichever way the reader will be HELD, and
 * the toggle is one piece of state that drives the whole screen:
 *
 *   'portrait'  compose 528x792, rotated CCW into the landscape panel buffer.
 *               How you hold a book. The default.
 *   'landscape' compose 792x528, no rotation — the compose canvas IS the panel
 *               buffer. Turn the reader sideways; the note is full width.
 *
 * `orientation` selects the compose rect (`composeDimsFor`) for the canvas, the
 * canvas host's height, and the target/rotation inside `prepareLoveNoteFrame`;
 * the DevicePreview takes it too, so the frame on screen is the panel's real
 * shape in either hold. The frame that leaves the phone is the same 52272 bytes
 * either way — only the mapping into it changes.
 *
 * ---------------------------------------------------------------------------
 * THE PREVIEW IS THE TRUTH
 * ---------------------------------------------------------------------------
 * What the screen shows is not a mock-up of the panel: it is `previewRgba`, the
 * post-dither buffer that `prepareLoveNoteFrame` produced alongside the very
 * bytes that get uploaded. There is no second rendering path that could drift
 * from the encoder — DevicePreview only puts a bezel round it at the panel's
 * exact aspect, so a cover crop or a fit letterbox bar is shown because the
 * ENCODER put it in the buffer, not because a style approximated one. That is
 * also why sending ALWAYS re-encodes from the live
 * source first (see handleSend): the canvas modes have no change signal to
 * invalidate a preview on, so re-encoding is the only way to keep "what you see
 * is what the reader shows" true at the moment of send rather than merely at
 * the moment of the last refresh.
 *
 * ---------------------------------------------------------------------------
 * SHARE INTENT
 * ---------------------------------------------------------------------------
 * This screen is the single owner of the OS share intent; App.tsx routes both
 * payload kinds here and this screen consumes them (a shared image becomes the
 * photo source, shared text opens the text canvas with the text kept to hand).
 *
 * A shared image's reported width/height are NOT trusted — see
 * PickedPhoto.trustedSize, which is a P0 crash, not a nicety.
 *
 * ---------------------------------------------------------------------------
 * ONE HISTORY ROW PER NOTE
 * ---------------------------------------------------------------------------
 * `message_history` is written from here and read by the History tab. A row is
 * a NOTE, not an attempt: the first send appends one and `recordIdRef` holds
 * its id, so "↻ Retry send" patches that row instead of appending another.
 * Anything that changes the SOURCE calls `startNewNote()` to start a fresh row.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ARITHMETIC LIVES ELSEWHERE
 * ---------------------------------------------------------------------------
 * UI cannot be node-tested, so nothing here computes pixels. Framing and
 * dithering are image_geometry/frame_encoder; PNG encoding and the history
 * thumbnail reduction are preview_png; the blank-note guard is frame_content.
 * This file is orchestration and layout only, and adds no arithmetic of its own.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Alert,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
    useWindowDimensions,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { copyAsync, deleteAsync, documentDirectory } from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import { useNavigation } from '@react-navigation/native';

import { ActionButton } from '../components/ActionButton';
import { CanvasComposer } from '../components/CanvasComposer';
import { DevicePreview } from '../components/DevicePreview';
import { RouteChip } from '../components/RouteChip';
import { SegmentedControl } from '../components/SegmentedControl';
import { useDeliverability } from '../services/useDeliverability';
import { useTabBarInset, useTheme, type Theme } from '../theme';
import { useConnection } from '../contexts/ConnectionProvider';
import { useProgress } from '../contexts/ProgressProvider';
import {
    DEFAULT_NOTE_ORIENTATION,
    NOTE_ORIENTATIONS,
    composeDimsFor,
    type NoteOrientation,
} from '../device/x3';
import {
    prepareLoveNoteFrame,
    type FitMode,
    type PrepareLoveNoteResult,
} from '../services/image_converter';
import { isBlankFrame } from '../services/frame_content';
// The SAME minter the mailbox publishes under, so a note that eventually travels
// both routes carries one id and the reader dedups it instead of showing it twice.
import { mintNoteId } from '../services/mailbox_client';
import {
    LOVE_NOTE_PATH_LABEL,
    MAILBOX_SETUP_HINT,
    sendLoveNote,
    type LoveNoteDestination,
} from '../services/love_note_sender';
import {
    addMessageRecord,
    updateMessageRecord,
    type MessageRecord,
} from '../services/message_history';
import {
    describeOutboxHandover,
    listOutbox,
    subscribeOutbox,
    summarizeOutbox,
    type OutboxItem,
} from '../services/outbox';
import { rgbaToPngDataUri, rgbaToThumbnailBase64 } from '../services/preview_png';
import { SEND_PHASE_LABEL } from '../services/reader_reachability';
import { getRole } from '../services/role';
import { getCurrentIp } from '../services/settings';
import type { SharedImage } from '../types';
import { createLock, type WithLock } from '../utils/lock';

/** The three authoring surfaces. Doubles as the history record's `kind`. */
export type ComposeMode = 'photo' | 'text' | 'doodle';

const MODE_LABELS: ReadonlyArray<{ value: ComposeMode; label: string }> = [
    { value: 'photo', label: 'Photo' },
    { value: 'text', label: 'Text' },
    { value: 'doodle', label: 'Doodle' },
];

/**
 * How the reader is held. Applies to ALL three modes — it is a property of the
 * note, not of a particular authoring tool.
 *
 * A Record, not a list: the ORDER and the MEMBERSHIP come from
 * `NOTE_ORIENTATIONS` (x3.ts exports it for exactly this), so this file only
 * supplies the display strings. Spelling the pairs out here instead would put
 * the UI order in two files, and adding a third orientation would type-check
 * while silently leaving the picker one button short. As a Record it cannot: a
 * new member of the union makes THIS line fail to compile.
 */
const ORIENTATION_LABELS: Record<NoteOrientation, string> = {
    portrait: 'Portrait',
    landscape: 'Landscape',
};

/** Same Record-over-list reasoning as ORIENTATION_LABELS, for the shared picker. */
const ORIENTATION_OPTIONS = NOTE_ORIENTATIONS.map(value => ({
    value,
    label: ORIENTATION_LABELS[value],
}));

/** Cover/Fit, for the shared picker. */
const FIT_OPTIONS: ReadonlyArray<{ value: FitMode; label: string }> = [
    { value: 'cover', label: 'Cover' },
    { value: 'fit', label: 'Fit' },
];

/**
 * Encoding a frame is ~100 ms of JS work (resize, decode, dither, pack), so a
 * fit toggle held down would otherwise queue one encode per tap. Long enough to
 * coalesce a burst, short enough that a deliberate change feels immediate.
 */
const PREVIEW_DEBOUNCE_MS = 250;

/** Auto-dismiss for the "sent" banner. */
const TOAST_MS = 4000;

/**
 * Filename prefix for the copy of a canvas capture that a history row points at.
 *
 * CanvasComposer captures with `result: 'tmpfile'`, i.e. into the OS CACHE
 * directory, which Android is free to evict at any moment. A history row that
 * held that URI would be promotable to wallpaper right up until the phone got
 * low on space, and then silently not — so the capture is copied into
 * documentDirectory before the row records it.
 *
 * Exported for HistoryScreen, which deletes the file when its row goes: this
 * prefix is what makes "a file this app minted for a note" identifiable, so a
 * delete can never reach anything else living in documentDirectory (the sleep
 * screen preview cache writes `thumb_*.jpg` there).
 */
export const NOTE_SOURCE_FILE_PREFIX = 'note-';

/**
 * The canvas is authored on white because the panel is white paper — drawing on
 * anything else would make the on-screen canvas disagree with the preview.
 */
const CANVAS_BACKGROUND = '#ffffff';

/**
 * CanvasComposer is `flex: 1` and letterboxes its own canvas (width 100%,
 * maxHeight 100%, aspect pinned to the compose dims for the current
 * orientation) above its own toolbar, so it needs a definite height from
 * whatever hosts it — inside a ScrollView there is none to inherit. The host
 * height is therefore recomputed per orientation, not per screen.
 *
 * These two numbers size that host so the canvas lands width-limited rather
 * than height-limited: INSET is the horizontal chrome between the window edge
 * and the canvas (screen padding 20*2, card padding 16*2, the composer's own
 * canvasArea padding 20*2), CHROME is the vertical chrome under it (toolbar
 * plus the composer's canvasArea padding). Both are estimates of another
 * component's internals ON PURPOSE — being a few pixels out only makes the
 * composer centre a slightly smaller canvas or leave a little extra space, and
 * it cannot clip or break anything, whereas reaching into CanvasComposer's
 * layout to get the exact figures would couple the two files.
 */
const CANVAS_HOST_INSET = 112;
const CANVAS_HOST_CHROME = 96;

interface PickedPhoto {
    uri: string;
    /** Filename or a short description — display only. */
    label: string;
    width?: number;
    height?: number;
    /**
     * Whether `width`/`height` describe the bitmap the DECODER will produce.
     *
     * Only expo-image-picker's asset can promise that: its exporters swap the
     * axes for an EXIF orientation before reporting a size. expo-share-intent
     * does not — it reports raw pre-EXIF BitmapFactory bounds, while
     * expo-image-manipulator decodes through Glide, which DOES apply EXIF. For
     * the single most common input there is (a portrait phone photo, stored
     * landscape with ROTATE_90) the two disagree by a transpose, and a crop
     * rect planned from the transposed ratio overruns the real bitmap: Android's
     * CropTransformer only checks `originX <= width`, never `originX + width <=
     * width`, so it sails past validation into an IllegalArgumentException out
     * of Bitmap.createBitmap.
     *
     * See buildFrame: untrusted sizes are simply not forwarded, which makes
     * `prepareLoveNoteFrame` probe with the same loader the real pass uses, so
     * the plan and the bitmap cannot disagree.
     */
    trustedSize: boolean;
}

interface BuiltPreview {
    /** data:image/png;base64,... of the whole post-dither compose buffer. */
    previewUri: string;
    /** Exactly 52272 bytes, ready for sendLoveNoteFrame. */
    frame: Uint8Array;
    /** Bare base64 (no data: prefix) of the downscaled thumbnail, for history. */
    thumbnailPngBase64: string;
}

interface ComposeScreenProps {
    sharedText?: string | null;
    onSharedTextConsumed?: () => void;
    sharedImage?: SharedImage | null;
    onSharedImageConsumed?: () => void;
}

export function ComposeScreen({
    sharedText,
    onSharedTextConsumed,
    sharedImage,
    onSharedImageConsumed,
}: ComposeScreenProps) {
    const { settings, connectionStatus } = useConnection();
    // Only for the route chip's one pressable state ('setup-needed' -> Settings).
    const navigation = useNavigation<any>();
    // `uploadText` is READ as well as written: it is the phase line under the
    // send button, and the only thing on screen during the stretch where the
    // route has no percent to report. One shared provider, no second copy of the
    // upload state on this screen.
    const { uploadText, progress, startUpload, setProgress, finishUpload, failUpload } =
        useProgress();
    const { width: windowWidth } = useWindowDimensions();
    const theme = useTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);
    // The tab bar floats over this screen and reserves no layout space, so the
    // content has to end above it. See src/theme/tabBar.ts.
    const tabBarInset = useTabBarInset();

    const [mode, setMode] = useState<ComposeMode>('photo');
    const [orientation, setOrientation] = useState<NoteOrientation>(DEFAULT_NOTE_ORIENTATION);
    const [photo, setPhoto] = useState<PickedPhoto | null>(null);
    const [fit, setFit] = useState<FitMode>('cover');

    const [preview, setPreview] = useState<BuiltPreview | null>(null);
    const [encoding, setEncoding] = useState(false);
    const [encodeError, setEncodeError] = useState<string | null>(null);

    const [captureReady, setCaptureReady] = useState(false);
    const [sending, setSending] = useState(false);
    const [sendError, setSendError] = useState<string | null>(null);

    /**
     * What this phone is holding for the reader, live.
     *
     * A failed send parks the note in the outbox (`sendLoveNote`'s auto-arm), and
     * this is how the screen finds out — `subscribeOutbox` fires on the enqueue,
     * so the error banner can say "it is not lost" in the same frame that it says
     * the send failed.
     */
    const [outboxItems, setOutboxItems] = useState<OutboxItem[]>([]);

    useEffect(() => {
        let alive = true;
        void listOutbox().then(items => {
            if (alive) setOutboxItems(items);
        });
        const off = subscribeOutbox(items => setOutboxItems(items));
        return () => {
            alive = false;
            off();
        };
    }, []);

    const outboxLine = describeOutboxHandover(summarizeOutbox(outboxItems));
    const [toast, setToast] = useState<string | null>(null);
    const [pendingSharedText, setPendingSharedText] = useState<string | null>(null);

    const captureRef = useRef<(() => Promise<string>) | null>(null);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    /**
     * Monotonic ticket for "the encode the UI currently wants". Any encode that
     * finishes holding a stale ticket drops its result instead of writing it —
     * a slow first encode must not overwrite the preview of a newer source.
     */
    const generationRef = useRef(0);

    /**
     * handleSend reads the last encode error synchronously, right after calling
     * regenerate(); the state setter has not been applied by then, so the
     * message is mirrored into a ref.
     */
    const encodeErrorRef = useRef<string | null>(null);

    /**
     * Serialises encodes. Two dithers of a 528x792 buffer running concurrently
     * on the JS thread just make both slower and stall touch handling; the
     * generation ticket already decides which result survives.
     */
    const encodeLockRef = useRef<WithLock | null>(null);
    if (encodeLockRef.current === null) encodeLockRef.current = createLock();
    const withEncodeLock = encodeLockRef.current;

    /**
     * The history row belonging to the note being composed right now, or null
     * if this note has not been sent yet.
     *
     * History is one row per NOTE, not per attempt: the first send appends,
     * every retry of the same note patches that same row. Without this, the
     * "↻ Retry send" link turns one note retried four times into five rows —
     * four 'failed' and one 'sent', all with the same thumbnail.
     */
    const recordIdRef = useRef<string | null>(null);

    /**
     * The handover-queue id for the note being composed right now.
     *
     * ONE ID PER NOTE, NOT PER ATTEMPT, for exactly the reason `recordIdRef`
     * exists. `sendLoveNote` parks a failed send in the outbox under
     * `options.noteId ?? result.noteId`, and on a TOTAL failure — a client with
     * no mailbox, or a publish that died before an id was minted — `result.noteId`
     * is undefined, so the queue mints a fresh one per attempt and `commitItem`'s
     * replace-on-same-id never fires. That is worst precisely where this feature
     * matters: in airplane mode every send fails, so every tap of "try again"
     * would cost another 52272-byte body and another slot against the 20-item
     * cap, evicting real books — and after the newest copy is handed over the
     * next session offers the previous duplicate, re-displaying the same note
     * once per session until the copies drain.
     */
    const handoverIdRef = useRef<string | null>(null);

    /**
     * Share-sheet text that belongs to the note being composed right now.
     *
     * `pendingSharedText` is a HANDOVER banner, not note content: it survives
     * mode switches and sends until the user dismisses it. Recording it
     * directly would staple a URL shared ten minutes ago onto an unrelated
     * doodle, and re-staple it on every send after that. The first send of a
     * note takes ownership of it here and clears the banner; retries of that
     * same note reuse what was captured, and the next note starts with none.
     */
    const noteTextRef = useRef<string | null>(null);

    /** The cache-directory PNG the last canvas encode captured, or null. */
    const captureUriRef = useRef<string | null>(null);

    /**
     * documentDirectory copy of that capture for the note being composed, or
     * null before the first send of this note.
     *
     * One file per NOTE, not per attempt: a retry re-captures the canvas (which
     * may have been edited since) and overwrites this same path, so the file a
     * history row points at always matches the thumbnail on that row.
     */
    const sourceUriRef = useRef<string | null>(null);

    /**
     * Start a new history row on the next send. Called whenever the SOURCE
     * changes — a different photo, a cleared photo, a mode switch — because
     * that is a different note, not another attempt at this one.
     */
    const startNewNote = useCallback(() => {
        recordIdRef.current = null;
        noteTextRef.current = null;
        // A different source is a different note, so it gets its own queue slot
        // rather than replacing the one the previous note is still waiting in.
        handoverIdRef.current = null;
        // Not deleted, only forgotten: the previous note's row still points at
        // that file, and HistoryScreen owns its lifetime from here on.
        sourceUriRef.current = null;
    }, []);

    const role = getRole(settings);

    /**
     * The two routes a note can take, as one value.
     *
     * Built here rather than inside handleSend so the SEND BUTTON and the SEND
     * ITSELF cannot disagree about whether delivery is possible: `canSend` asks
     * `isMailboxConfigured(destination)` and `sendLoveNote` picks its route from
     * the same object. Gating the button on `connectionStatus.connected` alone
     * was exactly wrong — an unreachable reader is the condition the mailbox
     * fallback exists FOR, so it disabled Send precisely when the fallback was
     * needed.
     */
    const destination = useMemo<LoveNoteDestination>(
        () => ({
            role,
            ip: getCurrentIp(settings),
            mailboxUrl: settings.mailboxUrl,
            mailboxWriteToken: settings.mailboxWriteToken,
        }),
        [role, settings]
    );

    /**
     * Which roads are open, from the app's ONE model of that question.
     *
     * Replaces this screen's local `isMailboxConfigured(destination)` — same
     * predicate underneath (the model delegates to it), but it also counts the
     * saved-AP-passphrase road that a mailbox-only test could not see.
     */
    const deliverability = useDeliverability();

    /**
     * What the app already knows about whether the reader is answering.
     *
     * ConnectionProvider probes the SAME endpoint the send's fast skip would, on
     * mount / foreground / settings save, so a send moments after one of those
     * gets the answer for free. `checkedAt` is what makes that safe — it is only
     * trusted inside `reader_reachability`'s freshness window, and `undefined`
     * (never probed, or the target ip just changed) means "ask", not "reachable".
     */
    const reachability = useMemo(
        () =>
            typeof connectionStatus.checkedAt === 'number'
                ? { reachable: connectionStatus.connected, checkedAt: connectionStatus.checkedAt }
                : null,
        [connectionStatus.connected, connectionStatus.checkedAt]
    );

    // ── Timers ──────────────────────────────────────────────────────
    useEffect(() => {
        return () => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
            if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        };
    }, []);

    const showToast = useCallback((message: string) => {
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        setToast(message);
        toastTimerRef.current = setTimeout(() => setToast(null), TOAST_MS);
    }, []);

    // ── Encode pipeline ─────────────────────────────────────────────

    /** Produce a frame from whichever source the current mode owns. */
    const buildFrame = useCallback(async (): Promise<PrepareLoveNoteResult | null> => {
        if (mode === 'photo') {
            if (!photo) return null;
            return prepareLoveNoteFrame(photo.uri, {
                mode: 'photo',
                fit,
                // Picks the compose rect AND the rotation into the panel buffer
                // (portrait -> ccw, landscape -> none). One switch, so the two
                // can never be set inconsistently from here.
                orientation,
                // Passing a size the picker already knows skips a probe pass —
                // but ONLY when it describes the same bitmap the decoder will
                // produce (see PickedPhoto.trustedSize). A wrong size is not
                // harmless here: the 'cover' plan turns it into a native crop
                // rect, and a rect that overruns the real bitmap throws inside
                // Android's CropTransformer. Withholding it costs one probe and
                // makes the plan self-consistent by construction.
                sourceWidth: photo.trustedSize ? photo.width ?? null : null,
                sourceHeight: photo.trustedSize ? photo.height ?? null : null,
            });
        }

        const capture = captureRef.current;
        if (!capture) return null;
        const capturedUri = await capture();
        // Kept so a send can persist the exact bitmap it encoded (see
        // persistCanvasSource). The capture itself is a cache tmpfile.
        captureUriRef.current = capturedUri;

        // 'graphic' (hard threshold) rather than 'photo' (dither): strokes and
        // type are already 1-bit intent, and dithering them only makes edges
        // fuzzy on an e-ink panel.
        //
        // 'fit' rather than 'cover': the canvas is authored at the compose
        // aspect for this orientation, but a few pixels of rounding difference
        // must never be allowed to crop a word or the end of a stroke.
        //
        // The SAME orientation the composer laid its canvas out at, or a
        // 792x528 capture would be conformed into a 528x792 target and the note
        // would come back letterboxed into a strip.
        return prepareLoveNoteFrame(capturedUri, { mode: 'graphic', fit: 'fit', orientation });
    }, [mode, photo, fit, orientation]);

    /**
     * Frame + previews. Both the on-screen preview and the history thumbnail are
     * derived from the SAME `previewRgba` the encoder just produced, so a history
     * row can never show something the panel did not display.
     */
    const toPreview = useCallback((result: PrepareLoveNoteResult): BuiltPreview => {
        return {
            previewUri: rgbaToPngDataUri(result.previewRgba, result.width, result.height),
            frame: result.frame,
            thumbnailPngBase64: rgbaToThumbnailBase64(
                result.previewRgba,
                result.width,
                result.height
            ),
        };
    }, []);

    const regenerate = useCallback(async (): Promise<BuiltPreview | null> => {
        const generation = ++generationRef.current;
        setEncoding(true);

        try {
            const built = await withEncodeLock(async () => {
                // Re-check under the lock: an encode that was superseded while it
                // waited its turn is pure waste, and its result is discarded below
                // regardless.
                if (generation !== generationRef.current) return null;
                const result = await buildFrame();
                return result ? toPreview(result) : null;
            });

            if (generation !== generationRef.current) return null;

            setPreview(built);
            encodeErrorRef.current = null;
            setEncodeError(null);
            return built;
        } catch (error) {
            if (generation !== generationRef.current) return null;
            const message = error instanceof Error ? error.message : String(error);
            console.warn('[ComposeScreen] Preview encode failed:', error);
            setPreview(null);
            encodeErrorRef.current = message;
            setEncodeError(message);
            return null;
        } finally {
            // Only the encode the UI is still waiting on owns the spinner.
            if (generation === generationRef.current) setEncoding(false);
        }
    }, [buildFrame, toPreview, withEncodeLock]);

    const cancelScheduledPreview = useCallback(() => {
        if (debounceRef.current) {
            clearTimeout(debounceRef.current);
            debounceRef.current = null;
        }
    }, []);

    const schedulePreview = useCallback(() => {
        cancelScheduledPreview();
        debounceRef.current = setTimeout(() => {
            void regenerate();
        }, PREVIEW_DEBOUNCE_MS);
    }, [regenerate, cancelScheduledPreview]);

    /** Drop any in-flight encode and clear the preview. */
    const invalidatePreview = useCallback(() => {
        cancelScheduledPreview();
        generationRef.current++;
        setPreview(null);
        setEncoding(false);
        encodeErrorRef.current = null;
        setEncodeError(null);
    }, [cancelScheduledPreview]);

    // Re-encode whenever the source or the framing changes. `captureRef` is not
    // reactive, so the canvas modes are (re)started by handleCaptureReady below
    // instead — this effect only has to avoid scheduling an encode with no source.
    useEffect(() => {
        const hasSource = mode === 'photo' ? photo !== null : captureRef.current !== null;
        if (!hasSource) {
            invalidatePreview();
            return;
        }
        schedulePreview();
    }, [mode, photo, fit, orientation, schedulePreview, invalidatePreview]);

    const handleCaptureReady = useCallback(
        (capture: () => Promise<string>) => {
            // Guard against a composer that hands back a fresh closure on every
            // render: without this, scheduling a preview here would re-render and
            // re-arm itself forever.
            if (captureRef.current === capture) return;
            captureRef.current = capture;
            setCaptureReady(true);
            schedulePreview();
        },
        [schedulePreview]
    );

    // ── Mode / source changes ───────────────────────────────────────

    const selectMode = useCallback(
        (next: ComposeMode) => {
            if (next === mode) return;
            // Only leaving for the photo tab unmounts the composer; text <-> doodle
            // keeps it (and its once-only capture closure) alive.
            if (next === 'photo') {
                captureRef.current = null;
                setCaptureReady(false);
            }
            setSendError(null);
            startNewNote();
            invalidatePreview();
            setMode(next);
        },
        [mode, invalidatePreview, startNewNote]
    );

    /**
     * Turn the reader. Same note, different shape — like the fit toggle and
     * unlike a mode switch, so it does NOT start a new history row: the source
     * is untouched, only the rect it is composed into changes.
     *
     * The preview is invalidated rather than left to be replaced: the old image
     * is the other aspect, and holding it inside a device frame that has already
     * turned would show it letterboxed for a debounce interval — a picture of a
     * crop that is not going to happen. Better a blank panel for 250 ms.
     * `invalidatePreview` also bumps the generation ticket, so an encode already
     * in flight for the previous orientation cannot land on top of the new one.
     */
    const selectOrientation = useCallback(
        (next: NoteOrientation) => {
            if (next === orientation) return;
            invalidatePreview();
            setOrientation(next);
        },
        [orientation, invalidatePreview]
    );

    const handlePickPhoto = useCallback(async () => {
        try {
            const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
            if (!permission.granted) {
                Alert.alert(
                    'Permission Needed',
                    'Let the app see your photos so you can pick one for the note.'
                );
                return;
            }

            const result = await ImagePicker.launchImageLibraryAsync({
                mediaTypes: ['images'],
                allowsEditing: false,
                quality: 1,
            });

            if (result.canceled || !result.assets || result.assets.length === 0) return;

            const asset = result.assets[0];
            setSendError(null);
            startNewNote();
            setPhoto({
                uri: asset.uri,
                label: asset.fileName || asset.uri.split('/').pop() || 'Selected photo',
                // expo-image-picker's exporters swap the axes for an EXIF
                // orientation before reporting, so this size describes the
                // bitmap the manipulator will decode. See PickedPhoto.
                width: asset.width,
                height: asset.height,
                trustedSize: true,
            });
        } catch (error) {
            console.warn('[ComposeScreen] Image picker error:', error);
            Alert.alert('Picker Failed', "Couldn't open your photos — try again in a second.");
        }
    }, [startNewNote]);

    const handleClearPhoto = useCallback(() => {
        setPhoto(null);
        setSendError(null);
        startNewNote();
    }, [startNewNote]);

    // ── Share intent ────────────────────────────────────────────────
    //
    // Consumed immediately so App.tsx can drop the payload; the callbacks are
    // deliberately out of the dependency list (matching the old NotesScreen) because they
    // are re-created on every App render and would otherwise re-fire this effect.

    useEffect(() => {
        if (!sharedImage) return;
        setMode('photo');
        captureRef.current = null;
        setCaptureReady(false);
        setSendError(null);
        startNewNote();
        setPhoto({
            uri: sharedImage.uri,
            label: sharedImage.filename,
            // Carried for reference only — expo-share-intent reports RAW
            // pre-EXIF bounds, so buildFrame must not plan a crop from them.
            // See PickedPhoto.trustedSize.
            width: sharedImage.width,
            height: sharedImage.height,
            trustedSize: false,
        });
        onSharedImageConsumed?.();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sharedImage]);

    useEffect(() => {
        if (!sharedText) return;
        // Shared text opens the text canvas and is kept to hand (copy button)
        // rather than injected: CanvasComposer's contract has no seed-text prop,
        // and silently dropping the payload would be worse than handing it over.
        setPendingSharedText(sharedText);
        // A fresh payload from the OS is a new note even if the text tab is
        // already open (selectMode is a no-op then, so it cannot do this).
        startNewNote();
        selectMode('text');
        onSharedTextConsumed?.();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sharedText]);

    const handleCopySharedText = useCallback(async () => {
        if (!pendingSharedText) return;
        try {
            await Clipboard.setStringAsync(pendingSharedText);
            showToast('Copied — long-press the canvas text box to paste.');
        } catch (error) {
            console.warn('[ComposeScreen] Clipboard write failed:', error);
        }
    }, [pendingSharedText, showToast]);

    // ── Send ────────────────────────────────────────────────────────

    /**
     * Copy the capture this send encoded into documentDirectory, and return the
     * URI the history row should point at.
     *
     * A photo note already has a durable-enough source (the picker's own file);
     * a canvas note's only source is a cache tmpfile that would be evicted out
     * from under the row, taking "promote this note to wallpaper" with it.
     *
     * Never throws and never fails the send: history — and promotion — are
     * nice-to-haves next to the note that already reached the reader.
     */
    const persistCanvasSource = useCallback(async (): Promise<string | undefined> => {
        const captured = captureUriRef.current;
        if (!captured || !documentDirectory) return undefined;

        const target =
            sourceUriRef.current ??
            `${documentDirectory}${NOTE_SOURCE_FILE_PREFIX}${Date.now().toString(36)}-${Math.random()
                .toString(36)
                .slice(2, 8)}.png`;

        try {
            // copyAsync onto an existing path fails silently on some platforms,
            // so a retry's overwrite deletes first (same order as
            // thumbnail_generator).
            await deleteAsync(target, { idempotent: true });
            await copyAsync({ from: captured, to: target });
            sourceUriRef.current = target;
            return target;
        } catch (error) {
            console.warn('[ComposeScreen] Could not persist canvas capture:', error);
            // The delete above may already have removed a previous attempt's
            // copy, so the remembered path can no longer be trusted to exist.
            sourceUriRef.current = null;
            return undefined;
        }
    }, []);

    /**
     * Write this attempt's outcome to history — appending a row the first time
     * this note is sent, patching that same row on every retry.
     *
     * THE PATCH CAN MISS, and the miss must not be silent. This screen keeps
     * `recordIdRef` for the whole life of a note, but the row it names is not
     * this screen's to keep: History's delete and clear-all remove rows while
     * Compose is still mounted with the same canvas, and a row also falls off
     * the end at MAX_MESSAGE_RECORDS. `updateMessageRecord` reports the miss
     * rather than no-oping, so a re-send after that lands as a NEW row instead
     * of vanishing — the note reached the reader, and the phone is the only
     * place any record of it can survive. (It also re-attaches the persisted
     * canvas capture to a live row; an orphaned one could never be cleaned up.)
     */
    const recordAttempt = useCallback(
        async (record: Omit<MessageRecord, 'id' | 'createdAt'>) => {
            // History is a nice-to-have; a storage failure must never turn a
            // delivered note into a reported failure.
            try {
                const id = recordIdRef.current;
                if (id !== null) {
                    const patched = await updateMessageRecord(id, {
                        ...record,
                        // Present-and-undefined CLEARS the field (see applyPatch
                        // in message_history). The spread alone would omit
                        // `error` entirely on a successful retry and leave the
                        // previous attempt's failure text sitting on a row that
                        // has since gone through.
                        error: record.error,
                    });
                    if (patched) return;
                    // The row is gone. Fall through and start a new one.
                }
                recordIdRef.current = (await addMessageRecord(record)).id;
            } catch (error) {
                console.warn('[ComposeScreen] Failed to record message history:', error);
            }
        },
        []
    );

    const handleSend = useCallback(async () => {
        // The ONLY hard precondition is that SOME road exists. A reader that is
        // not answering is normal (it is asleep with its radio off almost all of
        // the time) and is what the other two roads are for.
        //
        // ACTION-TRIGGERED, so it survives the copy pass: the user just tapped
        // Send. It should be unreachable — `canSend` gates on the same field —
        // and it stays as the guard for the tap that beats a settings change.
        if (!deliverability.anyRoute) {
            Alert.alert('Nowhere to send it yet', `${MAILBOX_SETUP_HINT}.`);
            return;
        }

        setSending(true);
        setSendError(null);
        setToast(null);
        startUpload('Rendering note...');

        // A debounced encode still on the clock would take a newer generation
        // ticket and make the send's own encode report itself as superseded.
        cancelScheduledPreview();

        // Re-encode from the live source. See "THE PREVIEW IS THE TRUTH" above.
        const built = await regenerate();
        if (!built) {
            const message =
                encodeErrorRef.current ??
                (mode === 'photo'
                    ? 'Pick a photo first.'
                    : 'Draw or write something on the canvas first.');
            failUpload(message);
            setSendError(message);
            setSending(false);
            return; // nothing left the phone, so there is nothing to log
        }

        // A canvas becomes a SOURCE the moment it mounts (it can capture) but
        // is not yet a NOTE, and a blank one encodes to a perfectly valid
        // all-white frame that no other guard can object to. Sending it raises
        // an empty overlay the reader has to physically dismiss to get back to
        // their book, so this is the last place it can be stopped.
        if (isBlankFrame(built.frame)) {
            const message =
                mode === 'photo'
                    ? 'That photo comes out blank on the reader — try a different one, or a bit more contrast.'
                    : "There's nothing on the page yet — write or draw a little something first.";
            failUpload(message);
            setSendError(message);
            setSending(false);
            return; // nothing left the phone, so there is nothing to log
        }

        // A placeholder for the few milliseconds before the route reports its
        // first phase. Everything after this is `onPhase` below, in the sender's
        // own words.
        startUpload('Sending love-note...');

        // First attempt at this note: take ownership of whatever the share
        // sheet handed over, and drop the banner so the NEXT note does not
        // inherit it. Retries reuse what was captured here.
        if (recordIdRef.current === null) {
            noteTextRef.current = mode === 'photo' ? null : pendingSharedText;
            if (noteTextRef.current !== null) setPendingSharedText(null);
        }

        // ROUTING LIVES IN THE SERVICE, NOT HERE. `sendLoveNote` picks direct vs
        // mailbox from the role and falls a host back to the mailbox when the
        // reader did not answer — so a note composed while the reader is asleep
        // is held rather than lost. Never throws; every failure, transport or
        // frame size, comes back as { success: false, error }.
        // Minted HERE, once, and reused by every retry of this note: it is the id
        // the outbox queues under, so a retry replaces the queued copy instead of
        // stacking a second one. See `handoverIdRef`.
        if (handoverIdRef.current === null) handoverIdRef.current = mintNoteId();

        const result = await sendLoveNote(
            destination,
            built.frame,
            // ONLY A REAL PERCENT MOVES THE BAR. `publishLoveNote` emits a coarse
            // 0 on entry because `fetch` cannot report upload bytes at all, and
            // rendering that as a determinate "0%" for the whole upload is what
            // reads as "stuck". Dropping it leaves `progress` undefined, which is
            // an indeterminate spinner plus the phase line — honest about the same
            // thing. The direct route's WS `PROGRESS:` acks are > 0 and still
            // drive a real bar.
            (percent) => { if (percent > 0) setProgress(percent); },
            {
                noteId: handoverIdRef.current,
                // Lets the send skip a reader that is already known to be asleep
                // instead of spending ~15-25 s of stacked timeouts discovering it.
                reachability,
                // `startUpload` also clears `progress`, which is exactly right on a
                // phase change: the new leg has reported nothing yet, so the bar
                // must go back to indeterminate rather than keep the last leg's
                // number.
                onPhase: (phase) => startUpload(SEND_PHASE_LABEL[phase]),
            }
        );

        // After the upload, never before it: persisting is I/O the reader is not
        // waiting on, and a canvas note is worth recording either way.
        const shared = {
            kind: mode,
            thumbnailPngBase64: built.thumbnailPngBase64,
            sourceUri: mode === 'photo' ? photo?.uri : await persistCanvasSource(),
            text: noteTextRef.current ?? undefined,
            // Present-and-undefined CLEARS on a retry (see recordAttempt): a
            // second attempt that took the other route must not leave the first
            // one's label on the row.
            path: result.path,
            noteId: result.noteId,
            // Recorded so History can tell the two kinds of 'sent' apart. Only
            // the direct route ever reports it; the mailbox publishes the dedup
            // id WITH the note, so there is no sidecar to lose.
            idStaged: result.idStaged,
        } as const;

        if (result.success) {
            finishUpload();
            // The route decides the wording, and it is not cosmetic: 'direct'
            // means the panel is showing it now, 'mailbox' means the reader
            // collects it at its next sleep and shows it at the wake after that.
            showToast(
                `${result.path ? LOVE_NOTE_PATH_LABEL[result.path] : 'Sent'} ✓${
                    result.path === 'mailbox'
                        ? " — they'll see it next time the reader wakes."
                        : ''
                }`
            );

            // A DEGRADED SUCCESS THE USER MUST BE TOLD ABOUT. The frame landed but
            // `/.love-notes/current.id` did not, so the reader has nothing to mark
            // shown and re-displays this note on EVERY wake until something
            // replaces it — the exact bug the sidecar exists to end. The realistic
            // trigger is the reader falling asleep in the gap between the 52 KB
            // frame and the 21-byte sidecar.
            //
            // An ALERT, not the toast above: the toast is already correct (the note
            // IS on the panel) and disappears in TOAST_MS, while the only fix is a
            // re-send the user would never think of unaided.
            if (result.idStaged === false) {
                Alert.alert(
                    'Sent — but it will keep coming back',
                    `${result.idError ?? 'The reader did not get the id this note is dismissed by.'}\n\n` +
                        'Send it again once the reader is awake and that stops.'
                );
            }

            await recordAttempt({ ...shared, status: 'sent' });
        } else {
            const message = result.error || 'Upload failed';
            failUpload(message);
            setSendError(message);
            await recordAttempt({ ...shared, status: 'failed', error: message });
        }

        setSending(false);
    }, [
        deliverability.anyRoute,
        reachability,
        destination,
        mode,
        photo,
        pendingSharedText,
        cancelScheduledPreview,
        regenerate,
        persistCanvasSource,
        recordAttempt,
        showToast,
        startUpload,
        setProgress,
        finishUpload,
        failUpload,
    ]);

    // ── Derived UI state ────────────────────────────────────────────

    const hasSource = mode === 'photo' ? photo !== null : captureReady;
    /**
     * Send is enabled when there is SOMEWHERE for the note to go.
     *
     * `anyRoute`, not `connected || mailboxReady`. The old pair asked about the
     * radio and about publishing and stopped there, so it missed the handover
     * road: a host whose mailbox base is serveable but whose write token is
     * missing had Send DISABLED, while `sendLoveNote` parks the note in the
     * outbox and the very next Sync-with-reader hands it over. The button said
     * "impossible" about something the sender does routinely — the exact class
     * of false statement this pass exists to remove.
     *
     * `anyRoute` is not a synonym for "some setting is filled in": it is only
     * ever true where `deliverability` can name a road the build can drive. A
     * saved AP passphrase, notably, is not one — see that module's header.
     */
    const canSend = hasSource && !sending && !encoding && deliverability.anyRoute;

    /** The compose rect this note is being authored into. */
    const compose = composeDimsFor(orientation);

    const canvasHostHeight = Math.max(
        280,
        Math.round(
            ((windowWidth - CANVAS_HOST_INSET) * compose.height) / compose.width +
            CANVAS_HOST_CHROME
        )
    );

    const emptyPreviewText = !hasSource
        ? mode === 'photo'
            ? "Pick a photo and we'll show you how it'll look on their reader."
            : 'Write or draw something, then tap Update preview to see it.'
        : encodeError
            ? 'Could not render this source.'
            : 'Rendering...';

    return (
        <View style={styles.container}>
            <ScrollView
                contentContainerStyle={[styles.content, { paddingBottom: tabBarInset }]}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
            >
                <Text style={styles.title}>Compose</Text>

                {/* Mode picker */}
                <SegmentedControl
                    options={MODE_LABELS}
                    value={mode}
                    onChange={selectMode}
                    disabled={sending}
                />

                {/* Orientation — a property of the NOTE, so it sits outside the
                    per-mode editors and applies to all three of them. */}
                <Text style={styles.fieldLabel}>Orientation</Text>
                <SegmentedControl
                    options={ORIENTATION_OPTIONS}
                    value={orientation}
                    onChange={selectOrientation}
                    disabled={sending}
                />
                {/* The explainer that sat here ("Portrait — held like a book",
                    plus the pixel dimensions) is gone: the DevicePreview below
                    literally turns, and the note is composed at whichever aspect
                    is showing. The picture says it, immediately, in the medium
                    the user cares about. */}

                {/* Shared text handover */}
                {pendingSharedText ? (
                    <View style={styles.shareCard}>
                        <Text style={styles.shareHeading}>Something came in from another app</Text>
                        <Text style={styles.shareValue} numberOfLines={6}>
                            {pendingSharedText}
                        </Text>
                        <View style={styles.shareActions}>
                            <TouchableOpacity onPress={handleCopySharedText}>
                                <Text style={styles.shareLink}>Copy text</Text>
                            </TouchableOpacity>
                            <TouchableOpacity onPress={() => setPendingSharedText(null)}>
                                <Text style={styles.shareLink}>✕ Dismiss</Text>
                            </TouchableOpacity>
                        </View>
                    </View>
                ) : null}

                {/* Source editor */}
                {mode === 'photo' ? (
                    <View style={styles.card}>
                        <ActionButton
                            title={photo ? 'Change photo' : 'Pick a photo'}
                            onPress={handlePickPhoto}
                            variant={photo ? 'secondary' : 'primary'}
                            disabled={sending}
                        />

                        {photo ? (
                            <>
                                <View style={styles.sourceRow}>
                                    <Text style={styles.sourceName} numberOfLines={1}>
                                        {photo.label}
                                    </Text>
                                    <TouchableOpacity onPress={handleClearPhoto} disabled={sending}>
                                        <Text style={styles.linkText}>✕ Clear</Text>
                                    </TouchableOpacity>
                                </View>

                                <Text style={styles.fieldLabel}>Framing</Text>
                                <SegmentedControl
                                    options={FIT_OPTIONS}
                                    value={fit}
                                    onChange={setFit}
                                    disabled={sending}
                                />
                                {/* No caption. Switching Cover/Fit re-encodes and
                                    the preview redraws with the crop or the white
                                    border actually in it — describing that in
                                    words alongside the picture of it was the
                                    definition of redundant. */}
                            </>
                        ) : null}
                    </View>
                ) : (
                    <View style={styles.card}>
                        <View style={[styles.canvasHost, { height: canvasHostHeight }]}>
                            {/* No `key={mode}`: the composer renders and captures BOTH
                                layers in either mode, so switching text <-> doodle is a
                                tool change, not a new document. Remounting would throw
                                away the doodle the user is about to caption. */}
                            <CanvasComposer
                                mode={mode}
                                orientation={orientation}
                                onCaptureReady={handleCaptureReady}
                                backgroundColor={CANVAS_BACKGROUND}
                            />
                        </View>
                        <TouchableOpacity
                            style={styles.refreshButton}
                            onPress={() => void regenerate()}
                            disabled={!captureReady || encoding || sending}
                        >
                            <Text
                                style={[
                                    styles.linkText,
                                    (!captureReady || encoding || sending) && styles.linkTextDisabled,
                                ]}
                            >
                                ↻ Update preview
                            </Text>
                        </TouchableOpacity>
                    </View>
                )}

                {/* E-ink preview — the encoder's own buffer, in a device frame
                    at the panel's exact aspect for this orientation. Crops and
                    letterbox bars are in the IMAGE, not in the styling. */}
                <Text style={styles.sectionTitle}>E-ink preview</Text>
                <DevicePreview
                    previewUri={preview?.previewUri ?? null}
                    orientation={orientation}
                    emptyText={emptyPreviewText}
                    busy={encoding}
                />
                {/* "This is exactly what shows up on their reader" is deleted.
                    DevicePreview draws a reader-shaped bezel around the encoder's
                    own buffer and captions it 'Xteink X3' — the frame IS the
                    claim, and the claim was never in doubt. */}

                {encodeError ? (
                    <View style={styles.errorBanner}>
                        {/* Stands alone (no lead line), so it carries the danger
                            colour itself rather than the muted detail treatment. */}
                        <Text style={styles.errorSolo}>{encodeError}</Text>
                    </View>
                ) : null}

                {toast ? (
                    <View style={styles.successBanner}>
                        <Text style={styles.successText}>{toast}</Text>
                    </View>
                ) : null}

                {/* A calm lead line, then the sender's own message VERBATIM
                    underneath in muted text — the raw string names the transport
                    and the URL, and it is the only diagnostic the user can pass on. */}
                {sendError ? (
                    <View style={styles.errorBanner}>
                        <Text style={styles.errorLead}>Couldn't send that.</Text>
                        <Text style={styles.errorText}>{sendError}</Text>
                        {/* The failure is only half the story once the note has
                            been parked: it is on this phone, and the next time the
                            reader raises its Sync WiFi it gets handed over with no
                            internet on either side and no further taps. Said HERE,
                            inside the error, because this is where someone decides
                            whether they have lost the note. */}
                        {outboxLine ? <Text style={styles.errorText}>{outboxLine}</Text> : null}
                        <TouchableOpacity onPress={() => void handleSend()} disabled={sending}>
                            <Text style={styles.retryText}>↻ Retry send</Text>
                        </TouchableOpacity>
                    </View>
                ) : null}

                {/* Send */}
                <View style={styles.sendContainer}>
                    <ActionButton
                        title="Send to reader"
                        onPress={() => void handleSend()}
                        loading={sending}
                        disabled={!canSend}
                        variant="primary"
                        progress={sending ? progress : undefined}
                    />
                    {/* WHAT THE SPINNER IS ACTUALLY DOING. The button alone can only
                        say "busy", and on the route this screen takes most often —
                        reader asleep, note to the mailbox — there is no percent to
                        show at all, so a bare spinner is indistinguishable from a
                        hang. The wording is the sender's own (`SEND_PHASE_LABEL`),
                        not reworded here, so Compose and Device narrate one route
                        the same way. */}
                    {sending && uploadText ? (
                        <Text style={styles.sendPhase}>{uploadText}</Text>
                    ) : null}

                    {/* WHERE THIS NOTE GOES, as a dot and a word.
                        This replaces a four-branch paragraph over role ×
                        mailbox × reachability that said the same thing four
                        long ways. The chip is the only place on this screen
                        that mentions delivery at all, and in the one state
                        that needs an action it IS the pointer at Settings —
                        pressable there, inert otherwise. */}
                    <RouteChip
                        summary={deliverability.summary}
                        onPress={
                            deliverability.summary === 'setup-needed'
                                ? () => navigation.navigate('Settings')
                                : undefined
                        }
                        style={styles.routeChip}
                        testID="compose-route-chip"
                    />
                </View>
            </ScrollView>
        </View>
    );
}

function createStyles(theme: Theme) {
    return StyleSheet.create({
        container: {
            flex: 1,
            backgroundColor: theme.colors.bg,
        },
        content: {
            padding: theme.spacing.xl,
            // paddingBottom is supplied at the call site from useTabBarInset() —
            // it depends on the safe-area inset, which a static sheet can't see.
        },
        title: {
            ...theme.type.h1,
            fontFamily: theme.fonts.display,
            color: theme.colors.text,
            // Was 6, with the subtitle paragraph carrying the rest of the gap.
            // The paragraph is gone, so the title owns its own breathing room —
            // otherwise the mode picker rides up against the serif.
            marginBottom: theme.spacing.xl,
        },
        sectionTitle: {
            // Regular case, not the old uppercase + letter-spacing: that transform
            // was the single strongest "techy dashboard" signal in the UI.
            ...theme.type.h2,
            color: theme.colors.text,
            marginTop: theme.spacing.xxl,
            marginBottom: theme.spacing.md,
        },
        card: {
            marginTop: theme.spacing.lg,
            backgroundColor: theme.colors.surface,
            borderColor: theme.colors.border,
            borderWidth: 1,
            borderRadius: theme.radii.md,
            padding: theme.spacing.lg,
            ...theme.shadows.card,
        },
        fieldLabel: {
            ...theme.type.label,
            color: theme.colors.textMuted,
            marginTop: theme.spacing.lg,
            marginBottom: theme.spacing.sm,
        },
        // `helpText` is GONE, not merely unused: it was the style every deleted
        // explainer on this screen shared, and leaving it here is an invitation
        // to write another one. Captions that survive (the send phase line) have
        // their own named styles.
        sourceRow: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: theme.spacing.md,
            gap: theme.spacing.md,
        },
        sourceName: {
            flex: 1,
            ...theme.type.label,
            fontWeight: '400',
            color: theme.colors.text,
        },
        linkText: {
            // Only valid on `bg` (4.55:1) or `surface` (5.08:1). On the accent
            // TINT (shareCard) it drops to 3.92:1 — use `shareLink` there.
            ...theme.type.label,
            color: theme.colors.accent,
        },
        linkTextDisabled: {
            opacity: 0.35,
        },
        canvasHost: {
            // Width comes from the card; height is computed per window width so the
            // canvas lands width-limited — see CANVAS_HOST_INSET / CANVAS_HOST_CHROME.
            alignSelf: 'stretch',
        },
        refreshButton: {
            alignSelf: 'flex-end',
            marginTop: theme.spacing.md,
            paddingVertical: theme.spacing.xs,
        },
        // The e-ink preview's own styling (bezel, panel aspect, empty state,
        // spinner) belongs to DevicePreview — this screen only says WHICH
        // orientation and hands it the encoder's buffer.
        shareCard: {
            marginTop: theme.spacing.lg,
            backgroundColor: theme.tints.accent,
            borderColor: theme.colors.accent,
            borderWidth: 1,
            borderRadius: theme.radii.md,
            padding: theme.spacing.lg,
        },
        shareHeading: {
            ...theme.type.label,
            fontWeight: '700',
            // `text`, not `accent`: accent-on-accent-tint is 3.92:1 in light mode
            // (icons/borders only). See the AA GUARDRAIL note in tokens.ts.
            color: theme.colors.text,
            marginBottom: theme.spacing.sm,
        },
        shareValue: {
            ...theme.type.body,
            color: theme.colors.text,
        },
        shareActions: {
            flexDirection: 'row',
            gap: theme.spacing.xl,
            marginTop: 14,
        },
        shareLink: {
            // Inside `shareCard` ONLY. `accent` on the accent tint is 3.92:1 in
            // light mode — under the 4.5:1 floor for 13px/600 (not WCAG large
            // text). `text` on the same tint is 10.21:1; the underline carries
            // the link affordance the accent hue would otherwise have carried.
            ...theme.type.label,
            color: theme.colors.text,
            textDecorationLine: 'underline',
        },
        successBanner: {
            marginTop: theme.spacing.lg,
            paddingVertical: 10,
            paddingHorizontal: theme.spacing.lg,
            backgroundColor: theme.tints.success,
            borderRadius: theme.radii.md,
            borderWidth: 1,
            borderColor: theme.alpha(theme.colors.success, 0.3),
        },
        successText: {
            color: theme.colors.success,
            fontSize: 15,
            lineHeight: 21,
            fontWeight: '600',
            textAlign: 'center',
        },
        errorBanner: {
            marginTop: theme.spacing.lg,
            paddingVertical: 10,
            paddingHorizontal: theme.spacing.lg,
            backgroundColor: theme.tints.danger,
            borderRadius: theme.radii.md,
            borderWidth: 1,
            borderColor: theme.alpha(theme.colors.danger, 0.35),
        },
        errorLead: {
            ...theme.type.label,
            fontWeight: '700',
            color: theme.colors.danger,
            marginBottom: theme.spacing.xs,
        },
        errorText: {
            ...theme.type.label,
            fontWeight: '400',
            lineHeight: 19,
            color: theme.colors.textMuted,
        },
        errorSolo: {
            ...theme.type.label,
            fontWeight: '400',
            lineHeight: 19,
            color: theme.colors.danger,
        },
        retryText: {
            marginTop: 10,
            ...theme.type.label,
            fontWeight: '700',
            color: theme.colors.danger,
        },
        sendContainer: {
            marginTop: theme.spacing.xl,
        },
        sendPhase: {
            // Muted and centred under the button: it is a status line, not a
            // second call to action, and it appears and disappears on its own.
            ...theme.type.caption,
            color: theme.colors.textMuted,
            textAlign: 'center',
            marginTop: theme.spacing.sm,
        },
        routeChip: {
            // Centred under the button and given more air than the phase line:
            // the phase line is transient and belongs to the button, the chip is
            // permanent and belongs to the screen.
            alignSelf: 'center',
            marginTop: theme.spacing.md,
        },
    });
}
