/**
 * HistoryScreen — the outbox: one row per love note the user composed, newest
 * first, with the exact thumbnail it was sent as.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE ROWS ARE THE ONLY COPY
 * ---------------------------------------------------------------------------
 * A love note is TEMPORARY on the device: dismissing it returns the reader to
 * their book and the 52272-byte frame is gone, and nothing can render that blob
 * back into a picture anyway. `message_history` is therefore the ONLY surviving
 * trace of a note — which is also why ComposeScreen records a row for a send
 * that FAILED, and why this screen shows failures rather than hiding them.
 *
 * ---------------------------------------------------------------------------
 * THREE THINGS THAT LOOK LIKE BUGS AND ARE NOT
 * ---------------------------------------------------------------------------
 * 1. `thumbnailPngBase64` is stored BARE — no `data:` prefix. Dropping it
 *    straight into `<Image source={{ uri }}>` renders a blank box, silently.
 *    It goes through `pngBase64ToDataUri`, and an empty/unreadable thumbnail
 *    falls back to a glyph tile rather than to that same blank box.
 * 2. Rows reload on FOCUS, not on a subscription. ComposeScreen writes to
 *    AsyncStorage from another tab and there is no change feed to listen to;
 *    a note sent while this screen was mounted-but-blurred would otherwise
 *    never appear.
 * 3. Promote re-encodes from `record.sourceUri`, NOT from the thumbnail on the
 *    row. The stored thumbnail is 64 px wide (see THUMBNAIL_WIDTH) — promoting
 *    it would put a postage stamp on a 792x528 panel.
 *
 * A note is a ROW PER NOTE, not per attempt — ComposeScreen patches its own row
 * on a retry (see `recordIdRef` there), so four retries do not become four
 * rows.
 *
 * ---------------------------------------------------------------------------
 * PROMOTE TO WALLPAPER (host only)
 * ---------------------------------------------------------------------------
 * A promoted note is added to `/.sleep/<name>.bmp`, the rotating set the
 * firmware picks from at random — a favourite note becomes part of the cycling
 * lock screen. It is PERMANENT device state, which is exactly what the host
 * role owns and a client does not, so the action is gated on `isHost` (and on
 * `settingsLoaded`, or a client sees a host-only action for the frames before
 * the settings blob resolves — the same gate App.tsx puts on the host-only
 * tabs).
 *
 * The reader only shows those files when its sleep mode is set to CUSTOM, and
 * nothing can set that remotely today, so the header says so out loud. A
 * promotion that "did nothing" is otherwise indistinguishable from a bug.
 *
 * Row layout follows the old `ScreensaverQueueList` (thumbnail + status dot +
 * meta + action). Every string this file COMPUTES comes from
 * `history_view.ts`, which is node-tested; this file is layout only.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    FlatList,
    Image,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { deleteAsync, documentDirectory } from 'expo-file-system/legacy';

import { useConnection } from '../contexts/ConnectionProvider';
import {
    clearMessageRecords,
    deleteMessageRecord,
    listMessageRecords,
    type MessageRecord,
} from '../services/message_history';
import { describeKind, describeStatus, formatRelativeTime } from '../services/history_view';
import { pngBase64ToDataUri } from '../services/preview_png';
import { canPromoteRecord, promoteRecordToWallpaper } from '../services/promote';
import { isHost } from '../services/role';
import { getCurrentIp } from '../services/settings';
import { SLEEP_MODE_HINT, SLEEP_SET_DIR } from '../services/wallpaper_sender';
import { Icon, type IconName } from '../components/icons';
import { useDirectConnectionRequired } from '../components/ConnectionBanner';
import { useTabBarInset, useTheme, type Theme } from '../theme';
import { NOTE_SOURCE_FILE_PREFIX } from './ComposeScreen';

/**
 * Stand-in tile when a row has no usable thumbnail.
 *
 * The cozy icon set has no separate pencil glyph and §2 of the rebrand spec
 * forbids minting a sixth shape casually, so text and doodle share the Compose
 * pen — which is right anyway: both are "something you drew on the canvas".
 */
const KIND_ICONS: Record<MessageRecord['kind'], IconName> = {
    photo: 'wallpaper',
    text: 'compose',
    doodle: 'compose',
};

/** Fallback tile glyph size, and the row-action glyph size. */
const KIND_ICON_SIZE = 24;
const ACTION_ICON_SIZE = 16;
/** Empty-state mark. */
const EMPTY_ICON_SIZE = 40;

/** Auto-dismiss for the promote result banner. Matches ComposeScreen. */
const TOAST_MS = 5000;

interface Banner {
    kind: 'success' | 'error';
    message: string;
}

export function HistoryScreen() {
    const navigation = useNavigation<any>();
    const { settings, settingsLoaded } = useConnection();
    const theme = useTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);
    // The tab bar floats over this screen and reserves no layout space, so the
    // list has to end above it. See src/theme/tabBar.ts.
    const tabBarInset = useTabBarInset();

    const [records, setRecords] = useState<MessageRecord[]>([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [promotingId, setPromotingId] = useState<string | null>(null);
    const [promoteProgress, setPromoteProgress] = useState(0);
    const [banner, setBanner] = useState<Banner | null>(null);

    /**
     * `now` is captured per load rather than read inside the row renderer, so
     * every row on screen is aged against the same instant and a list cannot
     * show "1m ago" above "Just now" for two notes sent together.
     */
    const [now, setNow] = useState(() => Date.now());

    const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        return () => {
            if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
        };
    }, []);

    const showBanner = useCallback((next: Banner) => {
        if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
        setBanner(next);
        bannerTimerRef.current = setTimeout(() => setBanner(null), TOAST_MS);
    }, []);

    const load = useCallback(async () => {
        // listMessageRecords never throws — a corrupt or half-written blob
        // reads as an empty list — so there is no error state to render here.
        const rows = await listMessageRecords();
        setRecords(rows);
        setNow(Date.now());
        setLoading(false);
    }, []);

    useFocusEffect(
        useCallback(() => {
            void load();
        }, [load])
    );

    const handleRefresh = useCallback(() => {
        void (async () => {
            setRefreshing(true);
            try {
                await load();
            } finally {
                setRefreshing(false);
            }
        })();
    }, [load]);

    // ── Delete ──────────────────────────────────────────────────────

    const handleDelete = useCallback(
        (record: MessageRecord) => {
            Alert.alert(
                'Delete note',
                'Remove this note from the history? The reader is not affected.',
                [
                    { text: 'Cancel', style: 'cancel' },
                    {
                        text: 'Delete',
                        style: 'destructive',
                        onPress: () => {
                            void (async () => {
                                setBusyId(record.id);
                                try {
                                    await deleteMessageRecord(record.id);
                                    await removeOwnedSource(record);
                                    await load();
                                } finally {
                                    setBusyId(null);
                                }
                            })();
                        },
                    },
                ]
            );
        },
        [load]
    );

    const handleClearAll = useCallback(() => {
        Alert.alert('Clear history', 'Remove every note from the history?', [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Clear',
                style: 'destructive',
                onPress: () => {
                    void (async () => {
                        // Snapshot first: once the store is cleared there is
                        // nothing left to tell which files belonged to notes.
                        const doomed = await listMessageRecords();
                        await clearMessageRecords();
                        for (const record of doomed) await removeOwnedSource(record);
                        await load();
                    })();
                },
            },
        ]);
    }, [load]);

    // ── Promote ─────────────────────────────────────────────────────

    const canPromote = settingsLoaded && isHost(settings);
    /**
     * Promoting writes a BMP over the reader's HTTP API — direct-only, no
     * mailbox road, so this genuinely is the `connected` question and not the
     * deliverability one.
     *
     * Taken from the SHARED hook rather than off `connectionStatus` so this
     * screen ages the observation exactly as Device and Wallpaper do. See the
     * note on `useDirectConnectionRequired` for why that is the un-decayed
     * `connected` and not `directNow`.
     */
    const { available: connected } = useDirectConnectionRequired();

    const handlePromote = useCallback(
        (record: MessageRecord) => {
            void (async () => {
                setPromotingId(record.id);
                setPromoteProgress(0);
                setBanner(null);
                try {
                    // Never throws: an unreadable source picture and a dead
                    // socket both come back as { ok: false, error }.
                    const result = await promoteRecordToWallpaper(
                        getCurrentIp(settings),
                        record,
                        percent => setPromoteProgress(percent)
                    );
                    if (result.ok) {
                        showBanner({
                            kind: 'success',
                            // The bytes landing does NOT mean the picture will be
                            // seen, so the precondition rides along with the
                            // success — in wallpaper_sender's canonical wording,
                            // so this tab cannot drift from the Wallpaper tab.
                            message: `Added to ${SLEEP_SET_DIR} as ${result.name}. ${SLEEP_MODE_HINT}`,
                        });
                    } else {
                        showBanner({
                            kind: 'error',
                            message: result.error || 'Could not promote this note.',
                        });
                    }
                } finally {
                    setPromotingId(null);
                    setPromoteProgress(0);
                }
            })();
        },
        [settings, showBanner]
    );

    // ── Render ──────────────────────────────────────────────────────

    const busy = busyId !== null || promotingId !== null;

    const header = useMemo(
        () => (
            <View>
                <View style={styles.headerRow}>
                    <Text style={styles.title}>History</Text>
                    {records.length > 0 ? (
                        <TouchableOpacity onPress={handleClearAll} disabled={busy}>
                            <Text style={[styles.clearText, busy && styles.linkTextDisabled]}>
                                Clear all
                            </Text>
                        </TouchableOpacity>
                    ) : null}
                </View>

                {/* DELETED, both of them:
                      · the subtitle ("Everything you've sent, newest first…") —
                        the list is right there, newest first, and the title
                        already says History;
                      · the promote instructions, which branched on `connected`
                        into "Not connected — join the reader's WiFi to add a
                        note to the sleep rotation". That line was FALSE-adjacent
                        (it described a precondition as a failure) and it was
                        redundant besides: the picture icon on each row is
                        already disabled, which is the same statement without the
                        paragraph. The `SLEEP_MODE_HINT` half of it survives
                        where it can be acted on — inside the success banner
                        after a promote, and on the Wallpaper tab. */}

                {/* Upload progress lives HERE, not on the row. A promoted
                    wallpaper is ~700 KB streamed in 4 KB chunks, so the
                    percentage ticks constantly; holding it in the row renderer's
                    closure re-rendered every mounted row (each re-decoding its
                    base64 thumbnail) on the same JS thread that is feeding the
                    socket. One banner re-renders instead of the whole list. */}
                {promotingId !== null ? (
                    <View style={[styles.banner, styles.bannerProgress]}>
                        <Text style={styles.bannerProgressText}>
                            {`Adding to the reader's rotation… ${promoteProgress}%`}
                        </Text>
                    </View>
                ) : null}

                {banner ? (
                    <View
                        style={[
                            styles.banner,
                            banner.kind === 'success' ? styles.bannerSuccess : styles.bannerError,
                        ]}
                    >
                        <Text
                            style={
                                banner.kind === 'success'
                                    ? styles.bannerSuccessText
                                    : styles.bannerErrorText
                            }
                        >
                            {banner.message}
                        </Text>
                    </View>
                ) : null}
            </View>
        ),
        // `canPromote` and `connected` LEFT the list with the promote-instructions
        // paragraph that read them. Nothing in this header branches on either any
        // more, and keeping dead deps here is not free: every identity change in
        // this array re-renders the header during an upload.
        [records.length, handleClearAll, busy, banner, promotingId, promoteProgress]
    );

    // NOTHING THAT TICKS DURING AN UPLOAD MAY APPEAR IN THESE DEPS. Every
    // identity change here re-renders every mounted row; `promoteProgress` used
    // to be one, which turned a single ~700 KB promote into a full-list re-render
    // per 4 KB chunk. The remaining deps all change at most twice per action.
    const renderItem = useCallback(
        ({ item }: { item: MessageRecord }) => (
            <HistoryRow
                record={item}
                now={now}
                busy={busyId === item.id}
                promoting={promotingId === item.id}
                showPromote={canPromote}
                promoteEnabled={canPromote && connected && canPromoteRecord(item) && !busy}
                onDelete={handleDelete}
                onPromote={handlePromote}
            />
        ),
        [now, busyId, promotingId, canPromote, connected, busy, handleDelete, handlePromote]
    );

    // The empty slot carries the first-load spinner too, so the header (and its
    // banner) stays on screen through a reload instead of flashing away.
    const empty = loading ? (
        <View style={styles.loadingCard}>
            <ActivityIndicator color={theme.colors.accent} />
        </View>
    ) : (
        // A FIRST-CLASS STATE, not an edge case: a brand-new pairing lands here
        // before anything has ever been sent, so it gets the brand mark and a way
        // out rather than a bare sentence.
        <View style={styles.placeholderCard}>
            <Icon name="history" size={EMPTY_ICON_SIZE} color={theme.colors.textMuted} />
            {/* One warm line. The button underneath already says where to go,
                so the sentence no longer has to name Compose or explain that
                sent notes land here. */}
            <Text style={styles.placeholderText}>Nothing sent yet.</Text>
            <TouchableOpacity
                style={styles.emptyAction}
                onPress={() => navigation.navigate('Compose')}
            >
                <Icon name="compose" size={ACTION_ICON_SIZE} color={theme.colors.accent} />
                <Text style={styles.linkText}>Write a note</Text>
            </TouchableOpacity>
        </View>
    );

    return (
        <View style={styles.container}>
            <FlatList
                data={records}
                keyExtractor={record => record.id}
                renderItem={renderItem}
                contentContainerStyle={[styles.content, { paddingBottom: tabBarInset }]}
                ListHeaderComponent={header}
                ItemSeparatorComponent={Separator}
                ListEmptyComponent={empty}
                refreshing={refreshing}
                onRefresh={handleRefresh}
                showsVerticalScrollIndicator={false}
            />
        </View>
    );
}

function Separator() {
    return <View style={{ height: 6 }} />;
}

// ── Row ─────────────────────────────────────────────────────────────

interface HistoryRowProps {
    record: MessageRecord;
    /** Shared "now" for the whole list — see the state comment above. */
    now: number;
    busy: boolean;
    /**
     * Whether THIS row is the one being promoted. A flag, not a percentage:
     * the percentage ticks per 4 KB chunk and belongs in the header banner, or
     * every row on screen re-renders for the length of the upload.
     */
    promoting: boolean;
    /** Host-only action: hidden outright for a client. */
    showPromote: boolean;
    promoteEnabled: boolean;
    /**
     * Take the record, rather than closing over it in the list renderer. An
     * inline `() => handleDelete(item)` is a new function on every render and
     * would defeat the memo below for exactly the case it exists to cover.
     */
    onDelete: (record: MessageRecord) => void;
    onPromote: (record: MessageRecord) => void;
}

/**
 * Memoized so the header's own re-renders (banner, progress percentage) stop at
 * the list boundary instead of re-decoding every row's base64 thumbnail.
 */
const HistoryRow = React.memo(function HistoryRow({
    record,
    now,
    busy,
    promoting,
    showPromote,
    promoteEnabled,
    onDelete,
    onPromote,
}: HistoryRowProps) {
    const theme = useTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);
    const sent = record.status === 'sent';
    const failed = record.status === 'failed';
    // Worth saying on the row itself, because it is a property of THIS note and
    // no amount of connecting or re-trying will change it. "Not connected" is
    // not: it is the same for every row, and the header carries it once.
    const missingSource = showPromote && !canPromoteRecord(record);

    return (
        <View style={[styles.row, failed && styles.rowFailed, sent && styles.rowSent]}>
            {record.thumbnailPngBase64 ? (
                <Image
                    // Stored BARE, so the prefix has to be put back on. See the
                    // header note — a raw drop into `uri` renders nothing.
                    source={{ uri: pngBase64ToDataUri(record.thumbnailPngBase64) }}
                    style={styles.thumbnail}
                    resizeMode="contain"
                    fadeDuration={0}
                />
            ) : (
                <View style={[styles.thumbnail, styles.thumbnailFallback]}>
                    <Icon
                        name={KIND_ICONS[record.kind]}
                        size={KIND_ICON_SIZE}
                        color={theme.colors.textMuted}
                    />
                </View>
            )}

            <View style={styles.rowContent}>
                <View style={styles.rowHeader}>
                    <View
                        style={[
                            styles.statusDot,
                            sent && styles.statusSent,
                            failed && styles.statusFailed,
                            record.status === 'draft' && styles.statusDraft,
                        ]}
                    />
                    <Text style={styles.rowTitle} numberOfLines={1}>
                        {describeKind(record.kind)}
                    </Text>
                    <Text style={styles.rowStatus}>
                        {describeStatus(record.status, record.path, record.idStaged)}
                    </Text>
                </View>

                {record.text ? (
                    <Text style={styles.rowText} numberOfLines={2}>
                        {record.text}
                    </Text>
                ) : null}

                {/* Raw sender text, unchanged — it is the only diagnostic a failed
                    row carries. */}
                {failed && record.error ? (
                    <Text style={styles.rowError} numberOfLines={2}>
                        {record.error}
                    </Text>
                ) : null}

                <Text style={styles.rowDate}>{formatRelativeTime(record.createdAt, now)}</Text>

                {missingSource ? (
                    <Text style={styles.rowNote}>
                        No saved picture — this note cannot become wallpaper.
                    </Text>
                ) : null}
            </View>

            <View style={styles.rowActions}>
                {showPromote ? (
                    promoting ? (
                        // Spinner only — the percentage is in the header banner.
                        <View style={styles.actionButton}>
                            <ActivityIndicator size="small" color={theme.colors.accent} />
                        </View>
                    ) : (
                        <TouchableOpacity
                            style={[
                                styles.actionButton,
                                !promoteEnabled && styles.actionButtonDisabled,
                            ]}
                            onPress={() => onPromote(record)}
                            disabled={!promoteEnabled}
                            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                            accessibilityRole="button"
                            accessibilityLabel="Add to the sleep rotation"
                        >
                            <Icon
                                name="wallpaper"
                                size={ACTION_ICON_SIZE}
                                color={theme.colors.accent}
                            />
                        </TouchableOpacity>
                    )
                ) : null}

                <TouchableOpacity
                    style={[
                        styles.actionButton,
                        (busy || promoting) && styles.actionButtonDisabled,
                    ]}
                    onPress={() => onDelete(record)}
                    disabled={busy || promoting}
                    hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                    accessibilityRole="button"
                    accessibilityLabel="Delete this note from the history"
                >
                    <Text style={styles.removeIcon}>✕</Text>
                </TouchableOpacity>
            </View>
        </View>
    );
});

// ── Owned files ─────────────────────────────────────────────────────

/**
 * Delete the documentDirectory copy of a canvas capture that this row owned.
 *
 * Only files this app minted for a note qualify: the URI must sit directly in
 * documentDirectory AND carry ComposeScreen's prefix. A photo note points at
 * the picker's own file (someone else's), and documentDirectory also holds the
 * sleep screen preview cache — neither may be touched.
 *
 * Best-effort: a delete that fails leaves a file behind, which is a wasted
 * megabyte, not a broken history.
 */
async function removeOwnedSource(record: MessageRecord): Promise<void> {
    const uri = record.sourceUri;
    if (!uri || !documentDirectory) return;
    if (!uri.startsWith(`${documentDirectory}${NOTE_SOURCE_FILE_PREFIX}`)) return;
    try {
        await deleteAsync(uri, { idempotent: true });
    } catch (error) {
        console.warn('[HistoryScreen] Could not delete note source:', error);
    }
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
    headerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        // Was 6, when the subtitle underneath supplied the rest of the gap
        // before the first row. It no longer exists.
        marginBottom: theme.spacing.lg,
    },
    title: {
        ...theme.type.h1,
        fontFamily: theme.fonts.display,
        color: theme.colors.text,
    },
    // `subtitle` and `helpText` are deleted along with the two paragraphs that
    // used them. Removed rather than left dormant: they are the styles a future
    // explainer would reach for by name.
    banner: {
        borderRadius: theme.radii.md,
        borderWidth: 1,
        padding: theme.spacing.md,
        marginBottom: theme.spacing.md,
    },
    bannerSuccess: {
        backgroundColor: theme.tints.success,
        borderColor: theme.alpha(theme.colors.success, 0.3),
    },
    bannerError: {
        backgroundColor: theme.tints.danger,
        borderColor: theme.alpha(theme.colors.danger, 0.3),
    },
    bannerProgress: {
        backgroundColor: theme.tints.accent,
        borderColor: theme.alpha(theme.colors.accent, 0.35),
    },
    bannerProgressText: {
        ...theme.type.label,
        fontWeight: '400',
        lineHeight: 18,
        // `text`, not `accent`: accent on its own tint is 3.92:1 in light mode.
        color: theme.colors.text,
    },
    bannerSuccessText: {
        ...theme.type.label,
        fontWeight: '400',
        lineHeight: 18,
        color: theme.colors.success,
    },
    bannerErrorText: {
        ...theme.type.label,
        fontWeight: '400',
        lineHeight: 18,
        color: theme.colors.danger,
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
    loadingCard: {
        paddingVertical: theme.spacing.xxxl,
        alignItems: 'center',
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.colors.surface,
        paddingVertical: theme.spacing.md,
        paddingHorizontal: 14,
        borderRadius: theme.radii.md,
        borderWidth: 1,
        borderColor: theme.colors.border,
        ...theme.shadows.card,
    },
    rowFailed: {
        backgroundColor: theme.tints.danger,
        borderColor: theme.alpha(theme.colors.danger, 0.2),
    },
    rowSent: {
        backgroundColor: theme.tints.success,
        borderColor: theme.alpha(theme.colors.success, 0.2),
    },
    thumbnail: {
        // SQUARE, because the note's shape is not fixed: the compose canvas is
        // orientation-dependent (528x792 held portrait, 792x528 held landscape —
        // see composeDimsFor in src/device/x3.ts) and a row does not record which
        // one it was. A tile shaped for either would leave the other rendering as
        // a small strip in a mostly empty box; a square gives both aspects the
        // same area, and `resizeMode="contain"` centres each inside it without
        // distorting anything.
        width: 56,
        height: 56,
        borderRadius: theme.radii.sm,
        // THE THUMBNAIL IS PANEL OUTPUT. Its backing stays white so a 1-bit note's
        // white pixels read as paper, not as a warm brand tint bleeding through.
        backgroundColor: '#fff',
        marginRight: theme.spacing.md,
    },
    thumbnailFallback: {
        // No panel bytes to show, so this tile IS chrome and does get themed.
        backgroundColor: theme.colors.surface2,
        alignItems: 'center',
        justifyContent: 'center',
    },
    rowContent: {
        flex: 1,
        marginRight: 10,
    },
    rowHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 3,
    },
    statusDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
        marginRight: theme.spacing.sm,
        backgroundColor: theme.colors.accent,
    },
    statusSent: {
        backgroundColor: theme.colors.success,
    },
    statusFailed: {
        backgroundColor: theme.colors.danger,
    },
    statusDraft: {
        backgroundColor: theme.colors.accent,
    },
    rowTitle: {
        ...theme.type.label,
        color: theme.colors.text,
        flex: 1,
    },
    rowStatus: {
        ...theme.type.caption,
        fontWeight: '600',
        color: theme.colors.textMuted,
        marginLeft: theme.spacing.sm,
    },
    rowText: {
        ...theme.type.label,
        fontWeight: '400',
        lineHeight: 18,
        color: theme.colors.text,
        marginLeft: theme.spacing.lg,
    },
    rowError: {
        ...theme.type.caption,
        fontWeight: '400',
        color: theme.colors.danger,
        marginTop: theme.spacing.xs,
        marginLeft: theme.spacing.lg,
    },
    rowDate: {
        fontSize: 11,
        lineHeight: 15,
        color: theme.colors.textMuted,
        marginTop: theme.spacing.xs,
        marginLeft: theme.spacing.lg,
    },
    rowNote: {
        fontSize: 11,
        lineHeight: 15,
        color: theme.colors.textMuted,
        marginTop: theme.spacing.xs,
        marginLeft: theme.spacing.lg,
        fontStyle: 'italic',
    },
    rowActions: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    actionButton: {
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: theme.radii.pill,
        backgroundColor: theme.colors.surface2,
        marginVertical: 3,
    },
    actionButtonDisabled: {
        opacity: 0.35,
    },
    removeIcon: {
        color: theme.colors.danger,
        fontSize: 14,
        fontWeight: '700',
    },
    linkText: {
        ...theme.type.label,
        color: theme.colors.accent,
    },
    linkTextDisabled: {
        opacity: 0.4,
    },
    clearText: {
        ...theme.type.label,
        color: theme.colors.danger,
    },
    });
}
