/**
 * WallpaperScreen — host-only manager for the reader's PERMANENT sleep screen.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SCREEN OWNS
 * ---------------------------------------------------------------------------
 * A picture picked here becomes an 8-bit grayscale BMP and lands in ONE of the
 * device's two sleep-screen slots:
 *
 *   PRIMARY   /sleep.bmp at the SD root. Single slot, highest priority — the
 *             firmware shows it and ignores the rotation set.
 *   ROTATION  /.sleep/<name>.bmp. The firmware picks one at random on sleep and
 *             avoids repeating the most recent ones.
 *
 * ---------------------------------------------------------------------------
 * THREE ROADS, AND WHY THE BUTTONS NO LONGER GO GREY
 * ---------------------------------------------------------------------------
 * This was the last direct-only screen in the app. Setting a sleep screen meant
 * PUTing a BMP at the reader's own HTTP API, so both destination buttons were
 * disabled whenever the reader was asleep — which is almost always, because it
 * sleeps with its radio off — and a client phone could not change one at all.
 * The screen said "Reader asleep" under two grey buttons, which was TRUE and
 * completely useless: it named a precondition the user cannot satisfy on demand.
 *
 * `wallpaper_sender.routeWallpaperSend` gave the payload the same three roads
 * notes and books already had (reader / mailbox / peer-link handover), so the
 * gate here is now `deliverability.wallpaperRoute !== 'none'`: if ANY road
 * exists the action runs and the screen says which road it took. Only a phone
 * with nothing configured anywhere still disables anything.
 *
 * TWO LISTS, DELIBERATELY. "Waiting to sync" is what the MAILBOX holds (what
 * the reader has not collected); "Rotation" is what is ON THE CARD, read back
 * from the reader. They cannot be merged, because nothing reports delivery back
 * — the contract has no acks — so an item leaves the first when the reader takes
 * it and appears in the second only once the user can reach the reader to look.
 *
 * Both go out through `wallpaper_sender`, which owns the paths; this file never
 * builds a device path of its own. The only string it contributes is the
 * rotation ENTRY NAME, and even that is only a readable STEM — the sender's own
 * `sanitizeSleepSetName` decides what is safe (see buildRotationName). Every
 * device-facing literal on screen (`/sleep.bmp`, `/.sleep`, the Custom-sleep-mode
 * hint) is imported from the sender for the same reason.
 *
 * This is NOT the love-note path. Love-notes are a temporary 1-bit overlay at
 * /.love-notes/current.frame owned by ComposeScreen; a wallpaper is permanent
 * state and survives a dismiss. Nothing in this file touches that contract.
 *
 * ---------------------------------------------------------------------------
 * THE PREVIEW IS THE TRUTH — AND THE TRUTH IS FOUR GRAYS ON A PORTRAIT SCREEN
 * ---------------------------------------------------------------------------
 * `prepareWallpaperBmp` hands back TWO previews and this screen defaults to the
 * honest one:
 *
 *   PANEL   `panelPreviewRgba` — `panel_render.ts` replaying the firmware's own
 *           chain (Atkinson dither -> 4 levels -> scatter onto the 528x792
 *           PORTRAIT sleep screen) over the very bytes inside the BMP. Shown at
 *           NATIVE resolution: downscaling it would average the dither back into
 *           the smooth gray it exists to stop showing.
 *   SOURCE  `filePreviewRgba` — the smooth 8-bit gray the FILE carries. Kept
 *           behind a toggle so the user can see what was sent versus what the
 *           panel makes of it, and never shown as "the preview".
 *
 * THE SLEEP SCREEN IS PORTRAIT. `SleepActivity.cpp:36` forces
 * `GfxRenderer::Orientation::Portrait`, so the logical screen is 528 wide by 792
 * tall — a tall book cover. This screen used to draw its preview box at
 * PANEL_W/PANEL_H (792x528, landscape) and to ask the encoder for a
 * landscape-framed BMP; both were wrong, and the device was letterboxing the
 * result. The box now comes from `DevicePreview orientation="portrait"`, which
 * asks `composeDimsFor` rather than hard-coding an aspect.
 *
 * It is encoded at `framing: 'panel'` on purpose: 'natural' framing
 * (the encoder's default) hands the whole picture to the firmware and lets IT
 * decide the crop, which makes a truthful preview impossible and the Cover/Fit
 * toggle meaningless. Framing to the sleep-screen box here means what the user
 * approves is what the panel shows.
 *
 * That box is the screen's OWN 528x792, not a 2x oversample of it, so the
 * firmware's geometry comes out scale = 1 / x = 0 / y = 0 — identical under
 * BOTH of the reader's sleep-cover modes. That is what makes this preview exact
 * instead of approximate, and it is why the screen does not have to ask the user
 * which cover mode their reader is set to (it cannot read it back). The cover
 * FILTER is still unknowable, hence the help text below.
 *
 * Uploading always RE-ENCODES from the live source first, so a preview that
 * silently went stale cannot ship different bytes than the ones on screen.
 *
 * WHY THE PANEL PREVIEW LOOKS ROUGHER THAN THE FILE: the firmware dithers at the
 * SOURCE resolution and only then subsamples by nearest-neighbour scatter with
 * per-plane OR, so ink wins wherever several source pixels land on one panel
 * pixel. That is real firmware behaviour (see panel_render.ts), not a defect in
 * the preview, and it is the whole reason the smooth preview was misleading.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO ARITHMETIC HERE
 * ---------------------------------------------------------------------------
 * UI cannot be node-tested. Framing, scaling and grayscale conversion live in
 * image_geometry / wallpaper_encoder; PNG encoding and the preview downscale
 * live in preview_png; filename and path safety live in wallpaper_sender (which
 * routes them through settings' `sanitizeDevicePath`). This file is
 * orchestration and layout only, and adds no arithmetic of its own.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Animated,
    RefreshControl,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';
import Swipeable from 'react-native-gesture-handler/Swipeable';

import { ActionButton } from '../components/ActionButton';
import { DevicePreview } from '../components/DevicePreview';
import { SegmentedControl } from '../components/SegmentedControl';
import { BinIcon, WallpaperIcon } from '../components/icons';
import { InfoTip } from '../components/InfoTip';
import { READER_ASLEEP_CAPTION, useDirectConnectionRequired } from '../components/ConnectionBanner';
import { useTabBarInset, useTheme, type Theme } from '../theme';
import { useConnection } from '../contexts/ConnectionProvider';
import { useProgress } from '../contexts/ProgressProvider';
// COMPOSE_H and PANEL_GRAY_LEVELS left with the preview explainers that quoted
// them ("W × H sleep screen", "only N shades of gray"). COMPOSE_W stays — it
// sizes the source preview render, which is geometry, not copy.
import { COMPOSE_W } from '../device/x3';
import {
    prepareWallpaperBmp,
    type FitMode,
    type PrepareWallpaperResult,
} from '../services/image_converter';
import {
    pngBase64ToDataUri,
    rgbaToPngDataUri,
    rgbaToThumbnailBase64,
} from '../services/preview_png';
import { getRole, isHost } from '../services/role';
import { getCurrentIp } from '../services/settings';
import { useDeliverability } from '../services/useDeliverability';
import {
    deleteMailboxWallpaper,
    listMailboxWallpapers,
    type MailboxWallpaper,
} from '../services/mailbox_client';
import {
    deleteSleepSetEntry,
    listSleepSet,
    routeWallpaperSend,
    sanitizeSleepSetName,
    verifyPrimaryWallpaper,
    SLEEP_MODE_HINT,
    SLEEP_ROOT_FILENAME,
    SLEEP_SET_DIR,
    WALLPAPER_HANDOVER_LANDING_CLAUSE,
    WALLPAPER_MAILBOX_LANDING_CLAUSE,
} from '../services/wallpaper_sender';
import { createLock, type WithLock } from '../utils/lock';

/**
 * One entry of the rotation set, taken FROM the sender's own return type rather
 * than re-declared here. wallpaper_sender owns the shape; a hand-copied
 * interface would be one more thing to keep in sync for no benefit.
 */
type SleepSetEntry = Awaited<ReturnType<typeof listSleepSet>>[number];

/**
 * Stable identity for one rotation row.
 *
 * `rawName` is what the DEVICE calls the file, so it is unique on the card;
 * `name` is the decoded form, and two entries can decode to the same string
 * ('a b.bmp' next to 'a%20b.bmp'), which as a React key silently drops a row.
 * The index fallback only covers a firmware that reports no raw name at all.
 */
function entryKey(entry: SleepSetEntry, index: number): string {
    return entry.rawName || `${entry.name}:${index}`;
}

/** Which device slot an upload is aimed at. */
type UploadTarget = 'primary' | 'set';

/**
 * Encoding a wallpaper is a resize + decode + grayscale pass plus a full
 * Atkinson dither over ~418k pixels, so a fit toggle held down would otherwise
 * queue one encode per tap. Same reasoning (and same value) as ComposeScreen's
 * debounce.
 */
const PREVIEW_DEBOUNCE_MS = 250;

/** Auto-dismiss for the success banner. */
const TOAST_MS = 4000;

/**
 * Width the SOURCE (smooth-gray) preview PNG is encoded at.
 *
 * `framing: 'panel'` already hands the BMP back at the sleep screen's own
 * 528x792, so this is a CEILING that currently costs nothing:
 * `rgbaToThumbnailBase64` never upscales, so at an equal width it is the
 * identity and the two previews swap without the box moving. It still earns its
 * place — a caller that ever passes an explicit `longSide` would otherwise
 * encode a 1056 px base64 string for pixels no phone can show — and keeping the
 * arithmetic in preview_png keeps it under CI.
 *
 * The PANEL preview gets NO such treatment — see PANEL_PREVIEW_IS_NATIVE below.
 */
const SOURCE_PREVIEW_WIDTH_PX = COMPOSE_W;

/**
 * Which preview the panel box is showing.
 *
 *   'panel'  what the reader will actually display (default).
 *   'source' the smooth grayscale the BMP carries.
 */
type PreviewMode = 'panel' | 'source';

/** Cover/Fit, for the shared segmented picker. */
const FIT_OPTIONS: ReadonlyArray<{ value: FitMode; label: string }> = [
    { value: 'cover', label: 'Cover' },
    { value: 'fit', label: 'Fit' },
];

/** Panel/File, for the shared segmented picker. */
const PREVIEW_MODE_OPTIONS: ReadonlyArray<{ value: PreviewMode; label: string }> = [
    { value: 'panel', label: 'Panel' },
    { value: 'source', label: 'File' },
];

/** Host-gate glyph size — the framed-picture icon standing in for the old 🖼️ emoji. */
const GATE_ICON_SIZE = 40;

/** The picker button's inline glyph. */
const BUTTON_ICON_SIZE = 18;

/**
 * Longest slice of a source filename kept in a rotation entry name.
 *
 * `sanitizeSleepSetName` caps the whole stem at 60 chars; leaving room for the
 * 15-char timestamp suffix means the SUFFIX survives truncation rather than the
 * filename losing the only part that makes it unique.
 */
const ROTATION_NAME_STEM_MAX = 32;

interface PickedImage {
    uri: string;
    /** Filename or short description — display only. */
    label: string;
    width?: number;
    height?: number;
    /**
     * Whether `width`/`height` describe the bitmap the DECODER will produce.
     *
     * Only expo-image-picker can promise that (its exporters apply EXIF before
     * reporting), which is why this screen has no share-intent path: a wrong
     * size turns the 'cover' plan into a native crop rect that overruns the
     * real bitmap and throws inside Android's CropTransformer. See the same
     * note on ComposeScreen's PickedPhoto.
     */
    trustedSize: boolean;
}

interface BuiltWallpaper {
    /**
     * data:image/png;base64,... of the PANEL-TRUE render — four grays,
     * Atkinson-dithered, at the sleep screen's native 528x792. Null only if the
     * encoder was asked to skip it, which this screen never does.
     */
    panelPreviewUri: string | null;
    /** data:image/png;base64,... of the smooth grayscale the BMP carries. */
    sourcePreviewUri: string;
    /** The complete 8-bit grayscale BMP, ready for sendWallpaperBmp. */
    bmp: Uint8Array;
    /** Pixel size of the BMP (not of either preview). */
    width: number;
    height: number;
}

/** Two-digit zero pad for the timestamp suffix. */
function pad2(value: number): string {
    return String(value).padStart(2, '0');
}

/**
 * Build the filename for a rotation entry.
 *
 * SAFETY IS NOT DECIDED HERE. `sanitizeSleepSetName` (wallpaper_sender) owns the
 * charset rules, the length cap, the dot-path handling and the `.bmp` suffix,
 * and its suite pins them; this function only chooses a READABLE stem and hands
 * it over. Re-implementing the rules in a screen is how the two drift apart.
 *
 * A timestamp suffix is always appended: the rotation set is a bag of files, and
 * two photos both exported as IMG_0001.jpg would otherwise silently overwrite
 * each other — losing a wallpaper the user thinks they just added.
 */
function buildRotationName(label: string | undefined, now: Date = new Date()): string {
    const stamp =
        `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}` +
        `-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;

    const stem = (label ?? '')
        // Drop the SOURCE extension ('.jpg'); the sender appends '.bmp' itself.
        .replace(/\.[a-zA-Z0-9]+$/, '')
        // sanitizeSleepSetName REJECTS a name containing a separator rather than
        // flattening it (flattening would quietly rename one file to another's
        // name), so flatten here, where the value is still just a label.
        .replace(/[\\/]+/g, '-')
        // Cosmetics, not safety: a leading dot would mint a hidden file inside
        // the already-hidden folder, and leading dashes/space read as noise.
        .replace(/^[.\-\s]+/, '')
        .trim()
        .slice(0, ROTATION_NAME_STEM_MAX)
        .trim();

    const base = stem.length > 0 ? `${stem}-${stamp}` : `wallpaper-${stamp}`;

    // The fallback covers a stem that sanitizes away to nothing (a filename that
    // was entirely emoji, say) — never return '', which the sender would have to
    // reject as an unusable name.
    return sanitizeSleepSetName(base) || sanitizeSleepSetName(`wallpaper-${stamp}`);
}

/** Human-readable size for a list row. */
function formatSize(bytes: number | undefined): string {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return 'Unknown size';
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(1)} KB`;
}

export function WallpaperScreen() {
    const { settings, settingsLoaded } = useConnection();
    const { progress, startUpload, setProgress, finishUpload, failUpload } = useProgress();
    const theme = useTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);
    // The tab bar floats over this screen and reserves no layout space, so the
    // content has to end above it. See src/theme/tabBar.ts.
    const tabBarInset = useTabBarInset();

    const [picked, setPicked] = useState<PickedImage | null>(null);
    const [fit, setFit] = useState<FitMode>('cover');

    const [preview, setPreview] = useState<BuiltWallpaper | null>(null);
    /**
     * Panel-true by default. The toggle is a comparison aid, not a setting: it
     * changes NOTHING about the bytes, and the encode is not re-run when it
     * flips (both previews came back from the same `prepareWallpaperBmp` call).
     */
    const [previewMode, setPreviewMode] = useState<PreviewMode>('panel');
    const [encoding, setEncoding] = useState(false);
    const [encodeError, setEncodeError] = useState<string | null>(null);

    const [uploading, setUploading] = useState<UploadTarget | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [toast, setToast] = useState<string | null>(null);

    const [entries, setEntries] = useState<SleepSetEntry[]>([]);
    const [listLoading, setListLoading] = useState(false);
    /**
     * Pull-to-refresh only, kept apart from `listLoading` on purpose: the focus
     * effect below also loads the set, and a shared flag makes the spinner
     * appear unprompted every time the user switches to this tab.
     */
    const [refreshing, setRefreshing] = useState(false);
    /** Identified by `rawName` — the name that is unique on the device. */
    const [deletingKey, setDeletingKey] = useState<string | null>(null);

    /**
     * What the MAILBOX is holding, i.e. what the reader has not collected yet.
     *
     * A SECOND LIST, and it has to be: the rotation list below is what is ON THE
     * CARD, read from the reader, and this is what is ON ITS WAY. Nothing
     * reports delivery back (the contract has no acks anywhere), so the two
     * cannot be merged into one honest list — an item leaves this one when the
     * reader takes it and appears in that one only after the user can reach the
     * reader to look.
     */
    const [queued, setQueued] = useState<MailboxWallpaper[]>([]);
    const [queueLoading, setQueueLoading] = useState(false);
    /** Identified by mailbox id, which is unique across the whole box. */
    const [cancellingId, setCancellingId] = useState<string | null>(null);

    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    /**
     * Monotonic ticket for "the encode the UI currently wants". An encode that
     * finishes holding a stale ticket drops its result — a slow first encode
     * must not overwrite the preview of a newer source or framing.
     */
    const generationRef = useRef(0);

    /**
     * handleUpload reads the last encode error synchronously right after
     * awaiting regenerate(); the state setter has not been applied by then, so
     * the message is mirrored into a ref.
     */
    const encodeErrorRef = useRef<string | null>(null);

    /**
     * Serialises encodes. Two grayscale-plus-dither passes over a 528x792 buffer
     * running concurrently on the JS thread only make both slower and stall
     * touch handling; the generation ticket already decides which result
     * survives.
     */
    const encodeLockRef = useRef<WithLock | null>(null);
    if (encodeLockRef.current === null) encodeLockRef.current = createLock();
    const withEncodeLock = encodeLockRef.current;

    /** Ticket for the rotation listing, same staleness rule as the encode. */
    const listRequestRef = useRef(0);

    /** Ticket for the mailbox listing. Separate: the two races are independent. */
    const queueRequestRef = useRef(0);

    const host = settingsLoaded && isHost(settings);
    /**
     * THE READER-IS-AWAKE QUESTION, and it now gates ONLY the two things that
     * genuinely need an awake reader: LISTING `/.sleep` and DELETING from it.
     *
     * Both are reads/writes against the reader's own file API with no second
     * road — there is no "list the rotation through the mailbox", because the
     * mailbox holds what is WAITING and the card holds what ARRIVED, and nothing
     * reports the latter back. So this stays, and it stays quiet.
     *
     * IT NO LONGER GATES THE SEND. See `wallpaperRoute` below.
     */
    const { available: connected } = useDirectConnectionRequired();

    /**
     * THE FIX THIS SCREEN EXISTED TO NEED.
     *
     * Setting a sleep screen used to be direct-LAN only, so both destination
     * buttons were greyed out whenever the reader was asleep — which is almost
     * always, because it sleeps with its radio off. The reader has not changed;
     * the ROADS have: `routeWallpaperSend` publishes to the mailbox the reader
     * already polls, and parks a copy in the outbox for a peer-link handover.
     *
     * So the gate is now "is there ANY road?" rather than "is the reader awake
     * right now?", and the difference is the whole point: a button that enqueues
     * and says so is strictly better than a grey one that says the reader is
     * asleep, which the user already knew and cannot change.
     *
     * `mailboxReady` is read only to WORD the caption — the routing decision
     * itself belongs to `wallpaperRoute`, which is derived by the same module
     * the send routes on, so the screen cannot promise a road the send refuses.
     */
    const { wallpaperRoute, mailboxReady } = useDeliverability();

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

    const buildBmp = useCallback(async (): Promise<PrepareWallpaperResult | null> => {
        if (!picked) return null;
        return prepareWallpaperBmp(picked.uri, {
            // See "THE PREVIEW IS THE TRUTH" — the app decides the crop so the
            // preview can be honest and Cover/Fit can mean something.
            framing: 'panel',
            fit,
            // Withholding an untrusted size costs one probe pass and makes the
            // crop plan self-consistent with the bitmap. See PickedImage.
            sourceWidth: picked.trustedSize ? picked.width ?? null : null,
            sourceHeight: picked.trustedSize ? picked.height ?? null : null,
        });
    }, [picked, fit]);

    const toPreview = useCallback((result: PrepareWallpaperResult): BuiltWallpaper => {
        return {
            // PANEL_PREVIEW_IS_NATIVE: encoded at result.panelWidth x
            // result.panelHeight (528x792) with NO downscale. The whole content
            // of this buffer is a per-pixel dither pattern; resampling it — even
            // to a "close enough" size — averages neighbouring levels back into
            // intermediate grays the panel cannot produce, which is precisely
            // the lie the smooth preview used to tell.
            panelPreviewUri: result.panelPreviewRgba
                ? rgbaToPngDataUri(
                      result.panelPreviewRgba,
                      result.panelWidth,
                      result.panelHeight
                  )
                : null,
            sourcePreviewUri: pngBase64ToDataUri(
                rgbaToThumbnailBase64(
                    result.filePreviewRgba,
                    result.width,
                    result.height,
                    SOURCE_PREVIEW_WIDTH_PX
                )
            ),
            bmp: result.bmp,
            width: result.width,
            height: result.height,
        };
    }, []);

    const regenerate = useCallback(async (): Promise<BuiltWallpaper | null> => {
        const generation = ++generationRef.current;
        setEncoding(true);

        try {
            const built = await withEncodeLock(async () => {
                // Re-check under the lock: an encode superseded while it waited
                // its turn is pure waste, and its result is dropped below anyway.
                if (generation !== generationRef.current) return null;
                const result = await buildBmp();
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
            console.warn('[WallpaperScreen] Wallpaper encode failed:', error);
            setPreview(null);
            encodeErrorRef.current = message;
            setEncodeError(message);
            return null;
        } finally {
            if (generation === generationRef.current) setEncoding(false);
        }
    }, [buildBmp, toPreview, withEncodeLock]);

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

    useEffect(() => {
        if (!picked) {
            invalidatePreview();
            return;
        }
        schedulePreview();
    }, [picked, fit, schedulePreview, invalidatePreview]);

    // ── Source ──────────────────────────────────────────────────────

    const handlePickImage = useCallback(async () => {
        try {
            const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
            if (!permission.granted) {
                Alert.alert(
                    'Permission Needed',
                    'Let the app see your photos so you can pick a sleep-screen image.'
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
            setActionError(null);
            setPicked({
                uri: asset.uri,
                label: asset.fileName || asset.uri.split('/').pop() || 'Selected image',
                width: asset.width,
                height: asset.height,
                trustedSize: true,
            });
        } catch (error) {
            console.warn('[WallpaperScreen] Image picker error:', error);
            Alert.alert('Picker Failed', "Couldn't open your photos — try again in a second.");
        }
    }, []);

    const handleClearImage = useCallback(() => {
        setPicked(null);
        setActionError(null);
    }, []);

    // ── Rotation set ────────────────────────────────────────────────

    const loadSet = useCallback(async () => {
        const requestId = ++listRequestRef.current;

        if (!connected) {
            setEntries([]);
            setListLoading(false);
            return;
        }

        setListLoading(true);
        try {
            const items = await listSleepSet(getCurrentIp(settings));
            if (requestId !== listRequestRef.current) return;
            setEntries(items);
        } catch (error) {
            // Listing is informational; a dead socket must not blank the screen
            // with an error banner the user cannot act on.
            if (requestId !== listRequestRef.current) return;
            console.warn('[WallpaperScreen] Failed to list the rotation set:', error);
            setEntries([]);
        } finally {
            if (requestId === listRequestRef.current) setListLoading(false);
        }
    }, [connected, settings]);

    // ── Mailbox queue ───────────────────────────────────────────────

    /**
     * What is waiting in the mailbox for the reader to collect.
     *
     * Reads `/status` through `listMailboxWallpapers`, which is authenticated —
     * so "can I see it" and "can I write it" fail together, rather than showing
     * a healthy queue on a box this phone cannot publish to.
     *
     * A FAILURE IS AN EMPTY LIST, not an error banner. This section is
     * informational, the send it describes has already been reported, and a
     * second red box for a listing the user did not ask for would be noise.
     */
    const loadMailboxQueue = useCallback(async () => {
        const requestId = ++queueRequestRef.current;

        if (!mailboxReady) {
            setQueued([]);
            setQueueLoading(false);
            return;
        }

        setQueueLoading(true);
        try {
            const result = await listMailboxWallpapers(
                settings.mailboxUrl ?? '',
                settings.mailboxWriteToken ?? ''
            );
            if (requestId !== queueRequestRef.current) return;
            // NEWEST FIRST for a HUMAN, which is what `/status` already gives us.
            //
            // THIS USED TO `.reverse()` AND THAT WAS BACKWARDS. The reasoning was
            // "wallpaper.txt is newest last, so flip it" — but this list does not
            // come from wallpaper.txt. `listMailboxWallpapers` reads `/status`,
            // which serves the STORED index, and core.js stores newest first
            // (publish does `[entry, ...kept]`); only `renderWallpaperManifest`
            // reverses, and only for the firmware's wire. Flipping here put the
            // OLDEST queued picture at the top of a list whose whole purpose is
            // showing the user the thing they just did.
            setQueued(result.success ? result.wallpapers : []);
        } catch (error) {
            if (requestId !== queueRequestRef.current) return;
            console.warn('[WallpaperScreen] Failed to list the mailbox queue:', error);
            setQueued([]);
        } finally {
            if (requestId === queueRequestRef.current) setQueueLoading(false);
        }
    }, [mailboxReady, settings.mailboxUrl, settings.mailboxWriteToken]);

    const handleCancelQueued = useCallback(
        (item: MailboxWallpaper) => {
            const label =
                item.target === 'primary' ? 'the queued sleep screen' : `"${item.filename}"`;
            Alert.alert(
                'Cancel delivery',
                // Says what it CANNOT do, because the alternative is a promise
                // this contract cannot keep: there is no reverse channel, so a
                // reader that already collected it keeps its copy.
                `Stop ${label} from reaching the reader? A reader that already collected it keeps it.`,
                [
                    { text: 'Keep', style: 'cancel' },
                    {
                        text: 'Cancel delivery',
                        style: 'destructive',
                        onPress: async () => {
                            setCancellingId(item.id);
                            try {
                                const result = await deleteMailboxWallpaper(
                                    settings.mailboxUrl ?? '',
                                    settings.mailboxWriteToken ?? '',
                                    item.id
                                );
                                if (result.success) {
                                    setQueued(prev => prev.filter(row => row.id !== item.id));
                                } else {
                                    Alert.alert('Error', result.error ?? 'Could not cancel it.');
                                }
                            } finally {
                                setCancellingId(null);
                            }
                        },
                    },
                ]
            );
        },
        [settings.mailboxUrl, settings.mailboxWriteToken]
    );

    useFocusEffect(
        useCallback(() => {
            void loadSet();
            void loadMailboxQueue();
        }, [loadSet, loadMailboxQueue])
    );

    /** Pull-to-refresh. Separate from the focus load — see `refreshing`. */
    const handlePullToRefresh = useCallback(() => {
        void (async () => {
            setRefreshing(true);
            try {
                await Promise.all([loadSet(), loadMailboxQueue()]);
            } finally {
                setRefreshing(false);
            }
        })();
    }, [loadSet, loadMailboxQueue]);

    const handleDeleteEntry = useCallback(
        (entry: SleepSetEntry) => {
            Alert.alert(
                'Remove Wallpaper',
                `Delete "${entry.name}" from the rotation set on the reader?`,
                [
                    { text: 'Cancel', style: 'cancel' },
                    {
                        text: 'Delete',
                        style: 'destructive',
                        onPress: async () => {
                            const key = entry.rawName || entry.name;
                            setDeletingKey(key);
                            try {
                                // Both names: the sender prefers the RAW one,
                                // because a percent-encoded entry names no file
                                // on the card once decoded, and the device
                                // reports a delete of nothing as a success.
                                const ok = await deleteSleepSetEntry(
                                    getCurrentIp(settings),
                                    entry.name,
                                    entry.rawName
                                );
                                if (ok) {
                                    setEntries(prev =>
                                        prev.filter(e => (e.rawName || e.name) !== key)
                                    );
                                } else {
                                    Alert.alert('Error', 'Failed to delete that wallpaper.');
                                }
                            } catch (error) {
                                console.warn('[WallpaperScreen] Delete failed:', error);
                                Alert.alert('Error', 'Failed to delete that wallpaper.');
                            } finally {
                                setDeletingKey(null);
                            }
                        },
                    },
                ]
            );
        },
        [settings]
    );

    // ── Upload ──────────────────────────────────────────────────────

    const handleUpload = useCallback(
        async (target: UploadTarget) => {
            // THE ONLY REMAINING HARD REFUSAL, and it is about SETUP, not about
            // the reader. 'none' means no road exists at all — no awake reader,
            // no mailbox, and no serveable base to hand over. Every other state
            // enqueues, so this alert is the one case where the tap genuinely
            // cannot start anything.
            if (wallpaperRoute === 'none') {
                Alert.alert(
                    'No way to deliver this yet',
                    'Add a mailbox URL in Settings, or wake the reader and join its Wi-Fi.'
                );
                return;
            }

            setUploading(target);
            setActionError(null);
            setToast(null);
            startUpload('Rendering wallpaper...');

            // A debounced encode still on the clock would take a newer
            // generation ticket and make this encode report itself superseded.
            cancelScheduledPreview();

            // Re-encode from the live source. See "THE PREVIEW IS THE TRUTH".
            const built = await regenerate();
            if (!built) {
                const message = encodeErrorRef.current ?? 'Pick an image first.';
                failUpload(message);
                setActionError(message);
                setUploading(null);
                return; // nothing left the phone, so there is nothing to report
            }

            // Named up here so the success banner can report the filename the
            // reader now holds, rather than re-deriving it (and getting a
            // different timestamp).
            const rotationName = buildRotationName(picked?.label);
            const spec =
                target === 'primary'
                    ? ({ kind: 'primary' } as const)
                    : ({ kind: 'set', name: rotationName } as const);

            startUpload(
                target === 'primary' ? 'Setting sleep screen...' : 'Adding to rotation...'
            );

            // routeWallpaperSend follows the repo sender convention: it never
            // throws, every failure comes back as { success: false, error }. It
            // tries the reader first when there is any point, falls back to the
            // mailbox, and parks a copy in the outbox when neither worked.
            const result = await routeWallpaperSend(
                {
                    role: getRole(settings),
                    ip: getCurrentIp(settings),
                    mailboxUrl: settings.mailboxUrl,
                    mailboxWriteToken: settings.mailboxWriteToken,
                },
                built.bmp,
                spec,
                percent => setProgress(percent)
            );

            if (result.success && result.route === 'mailbox') {
                // NOT "updated". The picture is in a box the reader collects on
                // its own schedule, so the panel does not change until it next
                // syncs — which can be hours. Saying otherwise here is the lie
                // the whole progressive model exists to stop telling.
                finishUpload();
                showToast(
                    target === 'primary'
                        ? `Sleep screen queued — ${WALLPAPER_MAILBOX_LANDING_CLAUSE} ✓`
                        : `${rotationName} queued — ${WALLPAPER_MAILBOX_LANDING_CLAUSE} ✓`
                );
                void loadMailboxQueue();
            } else if (result.success) {
                finishUpload();

                if (target === 'set') {
                    showToast(`Added to the rotation as ${rotationName} ✓`);
                    // Only the rotation set has a listing to refresh; /sleep.bmp
                    // lives at the SD root and is not part of it.
                    void loadSet();
                } else {
                    // READ THE ROOT BACK before claiming anything. The primary
                    // slot is the only upload whose destination the FIRMWARE
                    // joins from an EMPTY folder (see SD_ROOT_FOLDER in
                    // wallpaper_sender), and a wrong join still reports success
                    // while the panel keeps its old image. 'unknown' means the
                    // listing itself could not be read, which is not evidence of
                    // anything — the bytes did leave the phone, so it reads as
                    // success rather than crying wolf on a flaky link.
                    const landed = await verifyPrimaryWallpaper(getCurrentIp(settings));
                    if (landed === 'missing') {
                        setActionError(
                            `The upload succeeded, but /${SLEEP_ROOT_FILENAME} is not at the root ` +
                            'of the SD card, so the reader will keep showing its old sleep ' +
                            `screen. Try Add to rotation (${SLEEP_SET_DIR}) instead.`
                        );
                    } else {
                        showToast('Sleep screen updated ✓');
                    }
                }
            } else if (result.queuedId) {
                // NOTHING DELIVERED, AND THE PICTURE IS NOT LOST. The auto-arm
                // put a copy on this phone's disk; the next Sync-with-reader
                // hands it over with no internet on either side. Reported as a
                // SUCCESS banner rather than an error, because from the user's
                // side something did happen and there is nothing to retry — the
                // transport's own message would be noise about a road that is no
                // longer the one being taken.
                finishUpload();
                showToast(
                    target === 'primary'
                        ? `Sleep screen ${WALLPAPER_HANDOVER_LANDING_CLAUSE} ✓`
                        : `${rotationName} ${WALLPAPER_HANDOVER_LANDING_CLAUSE} ✓`
                );
            } else {
                const message = result.error || 'Upload failed';
                failUpload(message);
                setActionError(message);
            }

            setUploading(null);
        },
        [
            wallpaperRoute,
            settings,
            picked,
            cancelScheduledPreview,
            regenerate,
            loadSet,
            loadMailboxQueue,
            showToast,
            startUpload,
            setProgress,
            finishUpload,
            failUpload,
        ]
    );

    // ── Render ──────────────────────────────────────────────────────

    // settingsLoaded is half the role gate: `settings` is seeded from DEFAULTS
    // (role 'host'), so isHost() alone renders host-only UI for a client until
    // getSettings() resolves.
    if (!settingsLoaded) {
        return (
            <View style={styles.emptyContainer}>
                <ActivityIndicator size="large" color={theme.colors.accent} />
            </View>
        );
    }

    // App.tsx only mounts this tab for a host, so this is a belt-and-braces
    // empty state rather than a reachable screen — but a nav change (or a role
    // switch while the tab is open) must not be able to hand a client the
    // permanent-state controls.
    if (!host) {
        // A ROLE GATE, NOT AN ERROR. Informational surface2 card, muted text, no
        // danger tint anywhere: nothing has gone wrong, this phone simply is not
        // the half of the pairing that owns the reader's permanent state.
        return (
            <View style={styles.emptyContainer}>
                <View style={styles.gateCard}>
                    <WallpaperIcon size={GATE_ICON_SIZE} color={theme.colors.textMuted} />
                    <Text style={styles.emptyTitle}>Host only</Text>
                    {/* One line. The heading already carries the rule; this says
                        the part it doesn't — that Compose still works. */}
                    <Text style={styles.emptyText}>Compose still works from here.</Text>
                </View>
            </View>
        );
    }

    const busy = uploading !== null;
    /**
     * PROGRESSIVE, NOT BINARY. The only things that can still disable a
     * destination button are things the user can act on right now — no picture
     * yet, a render in flight, a send already running — plus the one genuine
     * dead end, `wallpaperRoute === 'none'` (nothing configured anywhere).
     *
     * `connected` is deliberately NOT in this expression. That is the whole
     * change: an asleep reader used to grey both buttons out, and an asleep
     * reader is the normal state of this product.
     */
    const canUpload = preview !== null && wallpaperRoute !== 'none' && !busy && !encoding;

    /**
     * What the buttons are about to do, in one line, or null when the outcome is
     * the obvious one (the reader is awake and will show it in seconds).
     *
     * Said BEFORE the tap, not after: "it will wait in the mailbox" is exactly
     * the information that makes an enabled button honest rather than a
     * surprise, and it is the sentence the greyed-out button never got to say.
     */
    const routeNote =
        wallpaperRoute === 'mailbox'
            ? `Reader asleep — this ${WALLPAPER_MAILBOX_LANDING_CLAUSE}.`
            : wallpaperRoute === 'handover-only'
                ? `Reader asleep — this ${WALLPAPER_HANDOVER_LANDING_CLAUSE}.`
                : wallpaperRoute === 'none'
                    ? 'No mailbox set up, and the reader is not answering. Add a mailbox URL in Settings.'
                    : null;

    const emptyPreviewText = !picked
        ? 'Pick an image to see how it lands on the panel.'
        : encodeError
            ? 'Could not render this image.'
            : 'Rendering...';

    // A missing panel render would mean the encoder was asked to skip it, which
    // this screen never does — but falling back beats a blank frame.
    const shownPreviewUri = preview
        ? previewMode === 'panel'
            ? preview.panelPreviewUri ?? preview.sourcePreviewUri
            : preview.sourcePreviewUri
        : null;

    return (
        <View style={styles.container}>
            <ScrollView
                contentContainerStyle={[styles.content, { paddingBottom: tabBarInset }]}
                showsVerticalScrollIndicator={false}
                refreshControl={
                    <RefreshControl
                        refreshing={refreshing}
                        onRefresh={handlePullToRefresh}
                        tintColor={theme.colors.accent}
                    />
                }
            >
                <Text style={styles.title}>Wallpaper</Text>

                {/* Source */}
                <View style={styles.card}>
                    <ActionButton
                        title={picked ? 'Change image' : 'Pick an image'}
                        icon={
                            <WallpaperIcon
                                size={BUTTON_ICON_SIZE}
                                color={picked ? theme.colors.textMuted : theme.colors.accentText}
                            />
                        }
                        onPress={() => void handlePickImage()}
                        variant={picked ? 'secondary' : 'primary'}
                        disabled={busy}
                    />

                    {picked ? (
                        <>
                            <View style={styles.sourceRow}>
                                <Text style={styles.sourceName} numberOfLines={1}>
                                    {picked.label}
                                </Text>
                                <TouchableOpacity onPress={handleClearImage} disabled={busy}>
                                    <Text style={[styles.linkText, busy && styles.linkTextDisabled]}>
                                        ✕ Clear
                                    </Text>
                                </TouchableOpacity>
                            </View>

                            <Text style={styles.fieldLabel}>Framing</Text>
                            <SegmentedControl
                                options={FIT_OPTIONS}
                                value={fit}
                                onChange={setFit}
                                disabled={busy}
                            />
                            {/* Caption deleted — the preview below re-encodes on
                                the switch and shows the crop or the border. */}
                        </>
                    ) : null}
                </View>

                {/* E-ink preview. DevicePreview owns the box, and it takes the
                    aspect from composeDimsFor('portrait') rather than a literal
                    — which is what stops this screen drawing a landscape frame
                    for a portrait sleep screen ever again. */}
                <View style={styles.sectionTitleRow}>
                    <Text style={styles.sectionTitle}>E-ink preview</Text>
                    {/* THE ONE THING THIS SCREEN CANNOT SHOW. The reader's own
                        sleep-cover filter lives on the device and no API reads it
                        back, so the preview is accurate only under the default —
                        a genuinely invisible consequence, which is the entire
                        bar for a tip. Everything else that used to be written
                        here (gray levels, byte count, pixel dimensions, the
                        fit/crop caveat) is either visible in the picture or of
                        no use to anyone choosing a photo. */}
                    <InfoTip
                        title="E-ink preview"
                        text="Accurate if the reader is on its default sleep-cover filter; a black-and-white or inverted filter set on the device will look different."
                        accessibilityLabel="About the e-ink preview"
                    />
                </View>
                <SegmentedControl
                    options={PREVIEW_MODE_OPTIONS}
                    value={previewMode}
                    onChange={setPreviewMode}
                    disabled={busy}
                />
                <DevicePreview
                    previewUri={shownPreviewUri}
                    orientation="portrait"
                    emptyText={emptyPreviewText}
                    busy={encoding}
                    caption={
                        previewMode === 'panel'
                            ? 'As the panel renders it'
                            : 'The file, not the panel'
                    }
                    style={styles.devicePreview}
                    testID="wallpaper-device-preview"
                />
                {/* THREE PARAGRAPHS DELETED HERE. The gray-levels explainer, the
                    "8-bit grayscale, W × H — N KB BMP" line and the sleep-cover
                    caveat all sat stacked under the preview.
                      · The first described what the picture directly above it
                        was already showing — and DevicePreview's own caption
                        ('As the panel renders it' / 'The file, not the panel')
                        says which of the two you are looking at.
                      · The second was file metadata. Nobody choosing a photo for
                        their partner's reader is deciding on byte count.
                      · The third is the only one with information the screen
                        cannot show, so it moved into the ⓘ on the heading. */}

                {encodeError ? (
                    <View style={styles.errorBanner}>
                        <Text style={styles.errorSolo}>{encodeError}</Text>
                    </View>
                ) : null}

                {toast ? (
                    <View style={styles.successBanner}>
                        <Text style={styles.successText}>{toast}</Text>
                    </View>
                ) : null}

                {/* Calm lead line, then the sender's own message VERBATIM in muted
                    text underneath — see ComposeScreen's send-error banner. */}
                {actionError ? (
                    <View style={styles.errorBanner}>
                        <Text style={styles.errorLead}>That didn't go through.</Text>
                        <Text style={styles.errorText}>{actionError}</Text>
                    </View>
                ) : null}

                {/* Destinations.
                    The two captions under these buttons are gone, and so is the
                    ⓘ that briefly replaced the first one. "Add to rotation" is
                    answered by the Rotation (n) list further down — the file
                    appears in it — and the PRECEDENCE between the two is
                    readable from the layout: the destinations are adjacent, the
                    primary/secondary weighting already ranks them, and the
                    rotation list sits directly below its own button. A tip is
                    for a consequence the screen cannot show, not for one it
                    shows less emphatically than prose would. */}
                <View style={styles.sendContainer}>
                    <ActionButton
                        title="Set as sleep screen"
                        onPress={() => void handleUpload('primary')}
                        loading={uploading === 'primary'}
                        disabled={!canUpload}
                        variant="primary"
                        progress={uploading === 'primary' ? progress : undefined}
                    />
                </View>

                <View style={styles.sendContainer}>
                    <ActionButton
                        title="Add to rotation"
                        onPress={() => void handleUpload('set')}
                        loading={uploading === 'set'}
                        disabled={!canUpload}
                        variant="secondary"
                        progress={uploading === 'set' ? progress : undefined}
                    />
                </View>

                {/* WAS: `READER_ASLEEP_CAPTION` under two greyed-out buttons.
                    Both of those are gone. The buttons are LIVE whenever any
                    road exists, and this line says which road the tap will take
                    — which is the thing the old caption could not say, because
                    when it was written there was only one road and it was
                    closed. Still one line, still no colour. */}
                {routeNote ? <Text style={styles.quietNote}>{routeNote}</Text> : null}

                {/* Device-side prerequisite. Not settable over the wire today, so
                    the wording is the sender's single literal (SLEEP_MODE_HINT)
                    rather than a copy that can drift from the other screens.
                    The subtext under it ("Until it is switched on the device,
                    uploads land on the SD card but the panel keeps showing the
                    stock sleep image") is deleted: it restated the hint as a
                    consequence, and the hint is already an instruction. */}
                <View style={styles.noticeCard}>
                    <Text style={styles.noticeHeading}>On the reader</Text>
                    <Text style={styles.noticeText}>{SLEEP_MODE_HINT}</Text>
                </View>

                {/* WAITING IN THE MAILBOX — what the reader has not collected yet.
                    Rendered ONLY when there is something in it: a permanently
                    visible "0 waiting" row would be a section about nothing on
                    the overwhelmingly common path (the reader was awake, or
                    there is no mailbox at all). */}
                {queued.length > 0 ? (
                    <View style={styles.section}>
                        <View style={styles.sectionHeader}>
                            <Text style={styles.listTitle}>Waiting to sync ({queued.length})</Text>
                            <TouchableOpacity
                                onPress={() => void loadMailboxQueue()}
                                disabled={queueLoading}
                            >
                                <Text
                                    style={[
                                        styles.linkText,
                                        queueLoading && styles.linkTextDisabled,
                                    ]}
                                >
                                    ↻ Refresh
                                </Text>
                            </TouchableOpacity>
                        </View>
                        {queued.map(item => (
                            <View key={item.id} style={styles.fileItemContainer}>
                                <View style={styles.fileItem}>
                                    <View style={styles.fileInfo}>
                                        <Text style={styles.fileName} numberOfLines={1}>
                                            {item.target === 'primary'
                                                ? `Sleep screen (/${SLEEP_ROOT_FILENAME})`
                                                : item.filename}
                                        </Text>
                                        <Text style={styles.fileMeta}>
                                            {item.target === 'primary'
                                                ? `Pinned · ${formatSize(item.bytes)}`
                                                : `Rotation · ${formatSize(item.bytes)}`}
                                        </Text>
                                    </View>
                                    <TouchableOpacity
                                        style={styles.deleteButton}
                                        onPress={() => handleCancelQueued(item)}
                                        disabled={cancellingId !== null}
                                        accessibilityLabel="Cancel this delivery"
                                    >
                                        {cancellingId === item.id ? (
                                            <ActivityIndicator
                                                size="small"
                                                color={theme.colors.danger}
                                            />
                                        ) : (
                                            <BinIcon size={18} color={theme.colors.danger} />
                                        )}
                                    </TouchableOpacity>
                                </View>
                            </View>
                        ))}
                    </View>
                ) : null}

                {/* Rotation manager */}
                <View style={styles.section}>
                    <View style={styles.sectionHeader}>
                        <Text style={styles.listTitle}>Rotation ({entries.length})</Text>
                        <TouchableOpacity
                            onPress={() => void loadSet()}
                            disabled={!connected || listLoading}
                        >
                            <Text
                                style={[
                                    styles.linkText,
                                    (!connected || listLoading) && styles.linkTextDisabled,
                                ]}
                            >
                                ↻ Refresh
                            </Text>
                        </TouchableOpacity>
                    </View>
                    <Text style={styles.sectionPath}>{SLEEP_SET_DIR}/*.bmp</Text>

                    {!connected ? (
                        <Text style={styles.emptyListText}>{READER_ASLEEP_CAPTION}</Text>
                    ) : listLoading && entries.length === 0 ? (
                        <ActivityIndicator
                            size="small"
                            color={theme.colors.accent}
                            style={styles.loader}
                        />
                    ) : entries.length === 0 ? (
                        <Text style={styles.emptyListText}>
                            No wallpapers in the rotation set
                        </Text>
                    ) : (
                        entries.map((entry, index) => (
                            <SleepEntryRow
                                key={entryKey(entry, index)}
                                entry={entry}
                                onDelete={() => handleDeleteEntry(entry)}
                                deleting={deletingKey === (entry.rawName || entry.name)}
                                disabled={deletingKey !== null || busy}
                            />
                        ))
                    )}
                    {/* "Swipe left, or tap the bin, to remove it from the
                        reader." — the bin is drawn on every row. */}
                </View>
            </ScrollView>
        </View>
    );
}

/** One rotation entry. Swipe-left or tap-the-bin, both confirm before deleting. */
function SleepEntryRow({
    entry,
    onDelete,
    deleting,
    disabled,
}: {
    entry: SleepSetEntry;
    onDelete: () => void;
    deleting: boolean;
    disabled: boolean;
}) {
    const theme = useTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);
    const swipeableRef = useRef<Swipeable>(null);

    const renderRightActions = (
        _progress: Animated.AnimatedInterpolation<number>,
        dragX: Animated.AnimatedInterpolation<number>
    ) => {
        const scale = dragX.interpolate({
            inputRange: [-60, -30, 0],
            outputRange: [1, 0.8, 0],
            extrapolate: 'clamp',
        });

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
        // onDelete raises the confirm alert, so the row can close behind it.
        onDelete();
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
                <View style={styles.fileItem}>
                    <View style={styles.fileInfo}>
                        <Text style={styles.fileName} numberOfLines={1}>
                            {entry.name}
                        </Text>
                        <Text style={styles.fileMeta}>{formatSize(entry.size)}</Text>
                    </View>

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
            padding: theme.spacing.xl,
            // paddingBottom is supplied at the call site from useTabBarInset() —
            // it depends on the safe-area inset, which a static sheet can't see.
        },
        title: {
            ...theme.type.h1,
            fontFamily: theme.fonts.display,
            color: theme.colors.text,
            // Was 6 + a subtitle paragraph; the paragraph is gone.
            marginBottom: theme.spacing.xl,
        },
        sectionTitle: {
            ...theme.type.h2,
            color: theme.colors.text,
            marginTop: theme.spacing.xxl,
            marginBottom: theme.spacing.md,
        },
        /**
         * A section heading with its ⓘ on the same line.
         *
         * The heading keeps its own marginTop/Bottom, so the row must NOT add
         * any — otherwise the E-ink preview heading sits at double the spacing
         * of every other heading on the screen.
         */
        sectionTitleRow: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.sm,
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
        // `helpText` (six paragraphs on this screen alone), `subtitle` and
        // `buttonNote` (which centred a ⓘ under the sleep-screen button, since
        // dropped) are deleted, not left dormant — see the same note in
        // ComposeScreen. A style with no consumer is an invitation to find one.
        /**
         * The two-word "Reader asleep" note. Muted, centred, and deliberately
         * NOT `danger`: nothing has failed, the reader is simply doing what it
         * does the overwhelming majority of the time.
         */
        quietNote: {
            ...theme.type.caption,
            color: theme.colors.textMuted,
            textAlign: 'center',
            marginTop: theme.spacing.md,
        },
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
            ...theme.type.label,
            color: theme.colors.accent,
        },
        linkTextDisabled: {
            opacity: 0.35,
        },
        /**
         * Breathing room around the device frame. The WIDTH cap stays DevicePreview's
         * own (MAX_DEVICE_WIDTH) — the portrait box is 1.5x as tall as it is wide, and
         * widening it here would push the upload buttons off screen.
         */
        devicePreview: {
            marginTop: theme.spacing.md,
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
        sendContainer: {
            marginTop: theme.spacing.xl,
        },
        noticeCard: {
            marginTop: theme.spacing.xxl,
            backgroundColor: theme.tints.accent,
            borderColor: theme.colors.accent,
            borderWidth: 1,
            borderRadius: theme.radii.md,
            padding: theme.spacing.lg,
        },
        noticeHeading: {
            ...theme.type.label,
            fontWeight: '700',
            // `text`, not `accent`: see tokens.ts's AA GUARDRAIL — accent on its own
            // tint is icon/border weight only in light mode.
            color: theme.colors.text,
            marginBottom: theme.spacing.sm,
        },
        noticeText: {
            ...theme.type.label,
            fontWeight: '400',
            lineHeight: 19,
            color: theme.colors.text,
        },
        // `noticeSubText` went with the sentence it styled.
        section: {
            marginTop: theme.spacing.xxxl,
        },
        sectionHeader: {
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
        },
        listTitle: {
            ...theme.type.h2,
            color: theme.colors.text,
        },
        sectionPath: {
            // A DEVICE PATH. Monospace and byte-exact on purpose — this is a string
            // the user may have to type or compare, not flavour text.
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
            flex: 1,
            paddingHorizontal: theme.spacing.xl,
        },
        emptyContainer: {
            flex: 1,
            backgroundColor: theme.colors.bg,
            justifyContent: 'center',
            alignItems: 'center',
            padding: 40,
        },
        /** The role gate's calm/informational card — surface2, never a danger tint. */
        gateCard: {
            alignItems: 'center',
            backgroundColor: theme.colors.surface2,
            borderRadius: theme.radii.md,
            paddingVertical: theme.spacing.xxl,
            paddingHorizontal: theme.spacing.xl,
        },
        emptyTitle: {
            ...theme.type.h2,
            fontSize: 18,
            lineHeight: 24,
            color: theme.colors.text,
            marginTop: theme.spacing.md,
            marginBottom: theme.spacing.sm,
        },
        emptyText: {
            ...theme.type.body,
            color: theme.colors.textMuted,
            textAlign: 'center',
        },
    });
}
