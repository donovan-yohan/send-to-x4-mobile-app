/**
 * CanvasComposer — the reusable compose surface for love notes.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS
 * ---------------------------------------------------------------------------
 * A black-on-white canvas locked to the X3 compose aspect for the orientation
 * being composed (`composeDimsFor(orientation)` from `src/device/x3.ts` — 528 x
 * 792 held portrait, 792 x 528 held landscape) with two tool sets:
 *
 *   mode 'text'   tap the canvas to drop a text element, drag to move,
 *                 double-tap (or the ✎ handle) to edit, ✕ to delete,
 *                 A− / A+ to size it.
 *   mode 'doodle' freehand strokes, three stroke widths, an eraser and clear.
 *
 * Both layers ALWAYS render and are ALWAYS captured — `mode` only decides which
 * tools are live, so a note can be a doodle with text on top. The screen owns
 * the mode switch; this component owns the canvas.
 *
 * Harvested from the old (unregistered, since deleted) `SleepScreenTab`: the
 * PanResponder drawing loop, the draggable text element and the view-shot
 * capture. Deliberately NOT harvested: layer/lock controls, image elements,
 * invert, draft persistence, save-design and send flows — those belong to the
 * sleep-screen editor, not to a note composer.
 *
 * ---------------------------------------------------------------------------
 * COORDINATE SPACE
 * ---------------------------------------------------------------------------
 * Everything in state (text x/y/size, stroke points/width) is stored in COMPOSE
 * pixels — the space the device actually renders — never in screen pixels. The
 * canvas box measures itself (`onLayout`) and derives `scale = boxWidth /
 * canvasW`; touches divide by it, text multiplies by it, and the SVG layer just
 * takes a `viewBox` so strokes need no conversion at all. The upshot: the
 * composition is resolution independent, and a stroke width of 9 means 9 device
 * pixels on the panel whatever phone drew it.
 *
 * ---------------------------------------------------------------------------
 * WHAT AN ORIENTATION SWITCH DOES TO THE CONTENT
 * ---------------------------------------------------------------------------
 * Compose pixels are the SAME unit in both orientations, only the box around
 * them changes shape (528 x 792 <-> 792 x 528), so nothing is rescaled and
 * nothing is thrown away. What differs is what falls outside the new box:
 *
 *   text elements are CLAMPED back inside it. They are anchored objects the
 *       user grabs by hand; one parked at y = 700 would be both invisible and
 *       unreachable in a 528-tall canvas, which is a lost element, not a
 *       re-layout.
 *   strokes are LEFT EXACTLY WHERE THEY ARE. Clamping every point of a drawing
 *       squashes it against the edge and destroys its shape; the ink simply
 *       falls off the panel instead (the box clips it), and switching back
 *       restores the drawing untouched because the points never moved.
 *
 * Only what is inside the box at capture time reaches the frame either way, but
 * the two are NOT equally reversible, and the difference is worth knowing before
 * you switch:
 *
 *   strokes ARE the non-destructive case. Nothing writes to a point, so a
 *       portrait -> landscape -> portrait round trip restores the drawing
 *       exactly, however many times you do it.
 *   text is clamped ONE WAY. The clamp rewrites t.x/t.y in state, so an element
 *       pulled in by a switch stays where it was pulled to; it does not spring
 *       back when you switch again (y = 700 at size 44 becomes 484 on the way
 *       out, and is still 484 on the way back). That is the price of not losing
 *       the element entirely — round-tripping it would mean keeping the authored
 *       position alongside a derived display position rather than overwriting
 *       state, which is a bigger change than the problem has so far earned.
 *
 * ---------------------------------------------------------------------------
 * CAPTURE CONTRACT (read before wiring a send button)
 * ---------------------------------------------------------------------------
 * `onCaptureReady` hands the consumer a STABLE `capture()` — it is emitted once
 * on mount, so stashing it in a ref or in state is safe and will not loop.
 * `capture()` deselects, lets React settle, and resolves to a PNG *file URI*.
 *
 * It is NOT instantaneous and it is not bounded: while the fullscreen text
 * editor is open it WAITS for the user to close it rather than dismissing them
 * mid-word. A consumer that serialises encodes must therefore expect a capture
 * to sit in its queue for as long as someone is typing. It always settles —
 * unmounting the composer releases the wait, and the capture then rejects with
 * "canvas is not mounted".
 *
 * react-native-view-shot renders the view at its ON-SCREEN size in device
 * pixels: a 360dp-wide canvas on a 3x phone yields a 1080 x 1620 PNG, NOT
 * 528 x 792. The ASPECT is exact (the box is pinned to the compose dims for the
 * orientation being composed); the pixel count is whatever the phone is.
 * Getting exact compose pixels is the image front-end's job — and it must be
 * told the SAME orientation this canvas was drawn at, or a 792 x 528 capture
 * gets conformed into a 528 x 792 target:
 *
 *     const uri = await capture();
 *     const { frame } = await prepareLoveNoteFrame(uri, { mode: 'graphic', orientation });
 *     // sendLoveNoteFrame(ip, frame, onProgress?) — see love_note_sender.ts.
 *     // It validates 52272 B and NEVER throws: failures come back as
 *     // { success: false, error }.
 *     const result = await sendLoveNoteFrame(getCurrentIp(settings), frame, onProgress);
 *
 * `prepareLoveNoteFrame` resizes and conforms to exactly the compose rect for
 * that orientation, so no consumer needs to know the capture size. Use mode
 * 'graphic' (threshold, no dither) — text and line art dither into mush. Do NOT
 * pass width/height to captureRef to force the compose size: the native
 * downscale is worse than the manipulator pass inside prepareLoveNoteFrame, and
 * it would resample twice.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Alert,
    Animated,
    KeyboardAvoidingView,
    Modal,
    PanResponder,
    Platform,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
    type GestureResponderEvent,
    type LayoutChangeEvent,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { captureRef } from 'react-native-view-shot';

import {
    DEFAULT_NOTE_ORIENTATION,
    composeDimsFor,
    type NoteOrientation,
} from '../device/x3';
import { darkColors, lightColors, useTheme, type Theme } from '../theme';
import { isDoubleTap, isTapGesture, shouldGrantDrag } from './canvas_gestures';
import { BinIcon, EraserIcon } from './icons';

export type CanvasComposerMode = 'text' | 'doodle';

export interface CanvasComposerProps {
    /** Which tool set is live. Both layers render and capture regardless. */
    mode: CanvasComposerMode;
    /**
     * Called ONCE on mount with a stable `capture()` that resolves to a PNG
     * file URI of the canvas at the compose aspect for `orientation`. See the
     * capture contract at the top of this file for how to turn it into exact
     * pixels — and pass the SAME orientation to `prepareLoveNoteFrame`.
     */
    onCaptureReady: (capture: () => Promise<string>) => void;
    /**
     * Which way the reader is held: 'portrait' composes 528 x 792, 'landscape'
     * composes 792 x 528. Drives the canvas box, the coordinate space and the
     * capture aspect. See "WHAT AN ORIENTATION SWITCH DOES TO THE CONTENT".
     */
    orientation?: NoteOrientation;
    /** Canvas paper colour. Defaults to white; ink is always black. */
    backgroundColor?: string;
}

// ── Tunables (all in COMPOSE pixels unless noted) ───────────────────

/** The panel is 1-bit; there is exactly one ink colour. */
const INK = '#000';

/**
 * ON-CANVAS CHROME IS NOT THEMED.
 *
 * The canvas is authored on WHITE in both schemes — it has to be, because the
 * panel is white paper and anything else would make the on-screen canvas
 * disagree with the preview (see `backgroundColor`'s doc above). So the marks
 * that sit ON that white surface — the empty-state hint, the selection dashes,
 * the drag handles and their glyphs — are pinned to the LIGHT palette's warm
 * hues, which is the pairing that actually holds contrast against white. The
 * dark palette's accent (`#E0894F`, an amber ember tuned for an espresso
 * background) measures 2.06:1 on white; using it here because the phone is in
 * dark mode would make the handles unreadable exactly when they are needed.
 *
 * Everything BELOW the canvas — the toolbar, the fullscreen text editor — is app
 * chrome and does follow the theme.
 */
const ON_CANVAS_ACCENT = lightColors.accent;
const ON_CANVAS_DANGER = lightColors.danger;
const ON_CANVAS_HANDLE_FILL = lightColors.surface;
const ON_CANVAS_HINT = 'rgba(0,0,0,0.28)';
const DEFAULT_TEXT_SIZE = 44;
const MIN_TEXT_SIZE = 16;
const MAX_TEXT_SIZE = 180;
const TEXT_SIZE_STEP = 6;
const STROKE_WIDTHS = [4, 9, 18];
/** Erase anything whose ink passes within this radius of the finger. */
const ERASER_RADIUS = 26;
/** Drop move samples closer than this — fewer points, same-looking curve. */
const MIN_SAMPLE_DELTA = 1.5;
/** Let React drop the selection chrome before view-shot reads the pixels. */
const CAPTURE_SETTLE_MS = 120;
/** Screen-px breathing room around a text element, so its handles have room. */
const ELEMENT_PADDING = 12;

interface Point {
    x: number;
    y: number;
}

interface Stroke {
    id: string;
    width: number;
    points: Point[];
}

interface TextItem {
    id: string;
    text: string;
    x: number;
    y: number;
    size: number;
}

/**
 * Points -> SVG path data. A single point becomes a hairline segment so a tap
 * still leaves a round dot (butt-capped zero-length paths draw nothing).
 */
function toPathD(points: Point[]): string {
    if (points.length === 0) return '';
    if (points.length === 1) {
        const p = points[0];
        return `M ${p.x.toFixed(1)} ${p.y.toFixed(1)} L ${(p.x + 0.01).toFixed(2)} ${p.y.toFixed(1)}`;
    }
    return points
        .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
        .join(' ');
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

export function CanvasComposer({
    mode,
    onCaptureReady,
    orientation = DEFAULT_NOTE_ORIENTATION,
    backgroundColor = '#fff',
}: CanvasComposerProps) {
    const theme = useTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);
    const [texts, setTexts] = useState<TextItem[]>([]);
    const [strokes, setStrokes] = useState<Stroke[]>([]);
    const [livePoints, setLivePoints] = useState<Point[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [textSize, setTextSize] = useState(DEFAULT_TEXT_SIZE);
    const [strokeWidth, setStrokeWidth] = useState(STROKE_WIDTHS[1]);
    const [erasing, setErasing] = useState(false);
    const [boxWidth, setBoxWidth] = useState(0);

    const canvasRef = useRef<View>(null);
    const idRef = useRef(0);
    const nextId = (prefix: string) => `${prefix}${++idRef.current}`;

    /** The compose rect this canvas is authoring into, in device pixels. */
    const { width: canvasW, height: canvasH } = composeDimsFor(orientation);

    /** Screen px per compose px. 0 until the canvas has laid out. */
    const scale = boxWidth > 0 ? boxWidth / canvasW : 0;

    const editingItem = texts.find(t => t.id === editingId) ?? null;
    const isEmpty = texts.length === 0 && strokes.length === 0 && livePoints.length === 0;

    // Orientation switch: pull text elements back inside the new box, leave the
    // ink alone. Rationale in "WHAT AN ORIENTATION SWITCH DOES TO THE CONTENT".
    // This MUTATES x/y, so it is one-way: switching back does not undo it.
    // Keyed on the two NUMBERS, not on the dims object, so it fires exactly when
    // the box really changes shape; returning `prev` unchanged when nothing
    // moved keeps the first (mount) run from touching state at all.
    useEffect(() => {
        setTexts(prev => {
            let moved = false;
            const next = prev.map(t => {
                const x = clamp(t.x, 0, Math.max(0, canvasW - t.size));
                const y = clamp(t.y, 0, Math.max(0, canvasH - t.size));
                if (x === t.x && y === t.y) return t;
                moved = true;
                return { ...t, x, y };
            });
            return moved ? next : prev;
        });
    }, [canvasW, canvasH]);

    // ── Drawing ───────────────────────────────────────────────────
    // The PanResponder is built once, so it must not close over state. Live
    // tool settings arrive through this ref (harvested from the old SleepScreenTab);
    // the in-flight stroke lives in a ref too, and state only mirrors it for
    // rendering, so no updater ever has a side effect in it.

    const drawing = useRef({ active: false, erasing: false, width: strokeWidth, scale: 0 });
    useEffect(() => {
        drawing.current = { active: mode === 'doodle', erasing, width: strokeWidth, scale };
    }, [mode, erasing, strokeWidth, scale]);

    const liveRef = useRef<Point[]>([]);

    const eraseAt = (x: number, y: number) => {
        setStrokes(prev =>
            prev.filter(s => !s.points.some(p => Math.hypot(p.x - x, p.y - y) <= ERASER_RADIUS + s.width / 2))
        );
    };

    const beginStroke = (p: Point) => {
        liveRef.current = [p];
        setLivePoints(liveRef.current);
    };

    const extendStroke = (p: Point) => {
        const last = liveRef.current[liveRef.current.length - 1];
        if (last && Math.abs(last.x - p.x) < MIN_SAMPLE_DELTA && Math.abs(last.y - p.y) < MIN_SAMPLE_DELTA) {
            return;
        }
        liveRef.current = [...liveRef.current, p];
        setLivePoints(liveRef.current);
    };

    const endStroke = () => {
        const points = liveRef.current;
        liveRef.current = [];
        if (points.length === 0) return;
        setLivePoints([]);
        setStrokes(prev => [...prev, { id: nextId('s'), width: drawing.current.width, points }]);
    };

    const drawResponder = useRef(
        PanResponder.create({
            onStartShouldSetPanResponder: () => drawing.current.active,
            onMoveShouldSetPanResponder: () => drawing.current.active,
            onPanResponderGrant: evt => {
                const s = drawing.current.scale;
                if (!drawing.current.active || s <= 0) return;
                const p = { x: evt.nativeEvent.locationX / s, y: evt.nativeEvent.locationY / s };
                if (drawing.current.erasing) {
                    eraseAt(p.x, p.y);
                    return;
                }
                beginStroke(p);
            },
            onPanResponderMove: evt => {
                const s = drawing.current.scale;
                if (!drawing.current.active || s <= 0) return;
                const p = { x: evt.nativeEvent.locationX / s, y: evt.nativeEvent.locationY / s };
                if (drawing.current.erasing) {
                    eraseAt(p.x, p.y);
                    return;
                }
                extendStroke(p);
            },
            onPanResponderRelease: endStroke,
            onPanResponderTerminate: endStroke,
        })
    ).current;

    const handleClearStrokes = () => {
        if (strokes.length === 0 && livePoints.length === 0) return;
        Alert.alert('Clear drawing', 'Remove every stroke on the canvas?', [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Clear',
                style: 'destructive',
                onPress: () => {
                    liveRef.current = [];
                    setLivePoints([]);
                    setStrokes([]);
                },
            },
        ]);
    };

    // ── Text elements ─────────────────────────────────────────────

    const updateText = (id: string, updates: Partial<TextItem>) => {
        setTexts(prev => prev.map(t => (t.id === id ? { ...t, ...updates } : t)));
    };

    const removeText = (id: string) => {
        setTexts(prev => prev.filter(t => t.id !== id));
        setSelectedId(prev => (prev === id ? null : prev));
        setEditingId(prev => (prev === id ? null : prev));
    };

    const placeText = (localX: number, localY: number) => {
        if (scale <= 0) return;
        const id = nextId('t');
        setTexts(prev => [
            ...prev,
            {
                id,
                text: '',
                // Drop the caret roughly where the finger landed, kept on canvas.
                x: clamp(localX / scale - textSize, 0, Math.max(0, canvasW - textSize)),
                y: clamp(localY / scale - textSize / 2, 0, Math.max(0, canvasH - textSize)),
                size: textSize,
            },
        ]);
        setSelectedId(id);
        setEditingId(id);
    };

    /** Tap on bare canvas: first tap dismisses a selection, next one adds text. */
    const handleBackgroundTap = (evt: GestureResponderEvent) => {
        if (mode !== 'text') return;
        if (selectedId) {
            setSelectedId(null);
            return;
        }
        placeText(evt.nativeEvent.locationX, evt.nativeEvent.locationY);
    };

    /** A− / A+ resize the selection, and set the size for the next placement. */
    const nudgeTextSize = (delta: number) => {
        const base = texts.find(t => t.id === selectedId)?.size ?? textSize;
        const size = clamp(base + delta, MIN_TEXT_SIZE, MAX_TEXT_SIZE);
        setTextSize(size);
        if (selectedId) updateText(selectedId, { size });
    };

    /** Closing the editor drops a text element the user never typed into. */
    const closeEditor = () => {
        if (editingId) {
            const item = texts.find(t => t.id === editingId);
            if (item && item.text.trim() === '') removeText(editingId);
        }
        setEditingId(null);
    };

    // ── Capture ───────────────────────────────────────────────────

    /**
     * Captures that arrived while the fullscreen text editor was open.
     *
     * The consumer debounces its preview encode, so one can land 250 ms after a
     * mode change or a mount — exactly when the user has just tapped the canvas
     * and the auto-focused editor has opened. Clearing `editingId` from
     * `capture()` would tear the modal down mid-word AND bypass `closeEditor`'s
     * empty-element cleanup (which only runs on the close path), leaving an
     * invisible empty text element behind.
     */
    const editorWaitersRef = useRef<Array<() => void>>([]);
    const editingIdRef = useRef<string | null>(null);

    /**
     * Release every waiting capture.
     *
     * Called when the editor closes AND on unmount. The unmount case is not
     * theoretical: the consumer serialises encodes behind a lock, and switching
     * to a mode that unmounts this component while a capture waited would
     * otherwise leave that lock held forever. A released capture on a dead
     * component fails the mount check below, which the consumer already handles.
     */
    const releaseEditorWaiters = useCallback(() => {
        const waiters = editorWaitersRef.current;
        editorWaitersRef.current = [];
        for (const resolve of waiters) resolve();
    }, []);

    useEffect(() => {
        editingIdRef.current = editingId;
        if (editingId === null) releaseEditorWaiters();
    }, [editingId, releaseEditorWaiters]);

    useEffect(() => releaseEditorWaiters, [releaseEditorWaiters]);

    const capture = useCallback(async (): Promise<string> => {
        // Wait the editor out rather than dismissing it. Read through a ref so
        // `capture` stays the stable, emitted-once closure its contract promises.
        if (editingIdRef.current !== null) {
            await new Promise<void>(resolve => {
                editorWaitersRef.current.push(resolve);
            });
        }
        // Selection borders and handles live inside the captured subtree, so
        // they have to be gone (and rendered gone) before the snapshot.
        setSelectedId(null);
        setEditingId(null);
        await new Promise(resolve => setTimeout(resolve, CAPTURE_SETTLE_MS));
        if (!canvasRef.current) throw new Error('CanvasComposer: canvas is not mounted');
        return await captureRef(canvasRef, { format: 'png', quality: 1, result: 'tmpfile' });
    }, []);

    // Emit `capture` exactly once. Consumers routinely pass an inline arrow for
    // onCaptureReady; going through a ref keeps that from re-firing every
    // render (and from looping if the consumer stores the callback in state).
    const onCaptureReadyRef = useRef(onCaptureReady);
    useEffect(() => {
        onCaptureReadyRef.current = onCaptureReady;
    }, [onCaptureReady]);
    useEffect(() => {
        onCaptureReadyRef.current(capture);
    }, [capture]);

    // ── Render ────────────────────────────────────────────────────

    return (
        <View style={styles.root}>
            <View style={styles.canvasArea}>
                {/* Everything inside this View — and nothing outside it — is captured. */}
                <View
                    ref={canvasRef}
                    // Android view flattening would leave captureRef nothing to grab.
                    collapsable={false}
                    style={[styles.canvas, { aspectRatio: canvasW / canvasH, backgroundColor }]}
                    onLayout={(e: LayoutChangeEvent) => setBoxWidth(e.nativeEvent.layout.width)}
                >
                    {/* Bare-canvas tap target. Sits under the elements, so a tap on
                        a text element never reaches it. */}
                    <View
                        style={StyleSheet.absoluteFill}
                        onStartShouldSetResponder={() => mode === 'text'}
                        onResponderRelease={handleBackgroundTap}
                    />

                    {/* viewBox does the compose-px -> screen-px maths for the ink. */}
                    <Svg
                        style={StyleSheet.absoluteFill}
                        viewBox={`0 0 ${canvasW} ${canvasH}`}
                        pointerEvents="none"
                    >
                        {strokes.map(s => (
                            <Path
                                key={s.id}
                                d={toPathD(s.points)}
                                stroke={INK}
                                strokeWidth={s.width}
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                fill="none"
                            />
                        ))}
                        {livePoints.length > 0 ? (
                            <Path
                                d={toPathD(livePoints)}
                                stroke={INK}
                                strokeWidth={strokeWidth}
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                fill="none"
                            />
                        ) : null}
                    </Svg>

                    {scale > 0 &&
                        texts.map(item => (
                            <DraggableText
                                key={item.id}
                                item={item}
                                scale={scale}
                                canvasWidth={canvasW}
                                selected={selectedId === item.id}
                                interactive={mode === 'text'}
                                onSelect={() => setSelectedId(item.id)}
                                onEdit={() => setEditingId(item.id)}
                                onDelete={() => removeText(item.id)}
                                onMove={(x, y) => updateText(item.id, { x, y })}
                            />
                        ))}

                    {/* Drawing layer intercepts touches over everything when active. */}
                    {mode === 'doodle' && (
                        <View style={[StyleSheet.absoluteFill, styles.drawLayer]} {...drawResponder.panHandlers} />
                    )}
                </View>

                {/* Hint is a SIBLING of the captured view on purpose — it must
                    never be baked into the frame. */}
                {isEmpty && (
                    <View style={styles.hint} pointerEvents="none">
                        <Text style={styles.hintText}>
                            {mode === 'text' ? 'Tap anywhere to add text' : 'Draw with your finger'}
                        </Text>
                    </View>
                )}
            </View>

            <View style={styles.toolbar}>
                {mode === 'text' ? (
                    <>
                        <TouchableOpacity style={styles.toolBtn} onPress={() => nudgeTextSize(-TEXT_SIZE_STEP)}>
                            <Text style={styles.toolBtnTextSmall}>A−</Text>
                        </TouchableOpacity>
                        <View style={styles.toolReadout}>
                            <Text style={styles.toolReadoutText}>
                                {texts.find(t => t.id === selectedId)?.size ?? textSize} px
                            </Text>
                        </View>
                        <TouchableOpacity style={styles.toolBtn} onPress={() => nudgeTextSize(TEXT_SIZE_STEP)}>
                            <Text style={styles.toolBtnTextLarge}>A+</Text>
                        </TouchableOpacity>
                        <View style={styles.toolSpacer} />
                        <Text style={styles.toolHint} numberOfLines={1}>
                            {selectedId ? 'Drag to move · ✎ edits' : 'Tap the canvas'}
                        </Text>
                    </>
                ) : (
                    <>
                        {STROKE_WIDTHS.map(w => (
                            <TouchableOpacity
                                key={w}
                                style={[styles.toolBtn, !erasing && strokeWidth === w && styles.toolBtnActive]}
                                onPress={() => {
                                    setStrokeWidth(w);
                                    setErasing(false);
                                }}
                            >
                                <View
                                    style={{
                                        width: w + 4,
                                        height: w + 4,
                                        borderRadius: (w + 4) / 2,
                                        backgroundColor:
                                            !erasing && strokeWidth === w
                                                ? theme.colors.accentText
                                                : theme.colors.text,
                                    }}
                                />
                            </TouchableOpacity>
                        ))}
                        <View style={styles.toolSpacer} />
                        {/*
                          * The toolbar is BELOW the canvas, so it is app chrome and
                          * does follow the theme (unlike ON_CANVAS_*). `textMuted`
                          * on `surface2` is 5.03:1 light / 5.40:1 dark; the erase
                          * tool's active state fills with `accent`, where only
                          * `accentText` holds — textMuted there would not.
                          */}
                        <TouchableOpacity
                            style={[styles.toolBtn, erasing && styles.toolBtnActive]}
                            onPress={() => setErasing(prev => !prev)}
                        >
                            <EraserIcon
                                size={18}
                                color={erasing ? theme.colors.accentText : theme.colors.textMuted}
                            />
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.toolBtn} onPress={handleClearStrokes}>
                            <BinIcon size={18} color={theme.colors.textMuted} />
                        </TouchableOpacity>
                    </>
                )}
            </View>

            {/* Fullscreen text editor (harvested from the old SleepScreenTab). */}
            <Modal visible={!!editingId} animationType="fade" transparent onRequestClose={closeEditor}>
                <KeyboardAvoidingView
                    behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                    style={styles.modalOverlay}
                >
                    <TouchableOpacity style={styles.modalBg} activeOpacity={1} onPress={closeEditor} />
                    {editingItem && (
                        <View style={styles.modalContent}>
                            <TextInput
                                style={styles.modalInput}
                                value={editingItem.text}
                                onChangeText={value => updateText(editingItem.id, { text: value })}
                                autoFocus
                                multiline
                                placeholder="Type something..."
                                placeholderTextColor={darkColors.textMuted}
                            />
                            <TouchableOpacity style={styles.modalDoneBtn} onPress={closeEditor}>
                                <Text style={styles.modalDoneText}>Done</Text>
                            </TouchableOpacity>
                        </View>
                    )}
                </KeyboardAvoidingView>
            </Modal>
        </View>
    );
}

// ── Draggable text element ──────────────────────────────────────────

interface DraggableTextProps {
    item: TextItem;
    /** Screen px per compose px. */
    scale: number;
    /** Compose-space canvas width, for the wrap box. Orientation dependent. */
    canvasWidth: number;
    selected: boolean;
    /** False in doodle mode: the element renders but ignores touches. */
    interactive: boolean;
    onSelect: () => void;
    onEdit: () => void;
    onDelete: () => void;
    /** Reports the new position in COMPOSE pixels. */
    onMove: (x: number, y: number) => void;
}

function DraggableText({
    item,
    scale,
    canvasWidth,
    selected,
    interactive,
    onSelect,
    onEdit,
    onDelete,
    onMove,
}: DraggableTextProps) {
    const theme = useTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);
    const pan = useRef(new Animated.ValueXY({ x: item.x * scale, y: item.y * scale })).current;
    const panState = useRef({ x: item.x * scale, y: item.y * scale });
    const lastTap = useRef(0);

    // Keep the once-built responder reading current props.
    const latest = useRef({ interactive, scale, onSelect, onEdit, onMove });
    useEffect(() => {
        latest.current = { interactive, scale, onSelect, onEdit, onMove };
    });

    useEffect(() => {
        const id = pan.addListener(value => {
            panState.current = value;
        });
        return () => pan.removeListener(id);
    }, [pan]);

    // Follow external position changes, and re-derive screen px if the canvas
    // is measured again (rotation, keyboard, split screen).
    useEffect(() => {
        const next = { x: item.x * scale, y: item.y * scale };
        pan.setValue(next);
        panState.current = next;
    }, [item.x, item.y, scale, pan]);

    /**
     * End a drag: fold the offset back into the value and report where the
     * element landed, in compose px.
     *
     * Reads nothing that changes identity between renders (`pan`, `panState`
     * and `latest` are all refs), so the once-built responder closing over the
     * first render's copy of this function is safe.
     */
    const settleDrag = () => {
        pan.flattenOffset();
        const s = latest.current.scale || 1;
        latest.current.onMove(panState.current.x / s, panState.current.y / s);
    };

    const responder = useRef(
        PanResponder.create({
            // Start: the element takes a touch that lands on ITSELF. The corner
            // handles are descendants, so the responder system offers them the
            // touch first (bubble phase runs deepest-first) and they win a press
            // that starts on them — this line never fights them.
            onStartShouldSetPanResponder: () => latest.current.interactive,
            // Move: this is the one that USED TO KILL THE HANDLES. While a
            // handle holds the responder, every touch move re-offers it to this
            // ancestor; an unconditional `true` here took it back on the first
            // pixel of finger jitter, terminated the press (Pressability grants
            // termination by default) and spent the gesture as a zero-distance
            // drag. Net effect on device: ✕ and ✎ did nothing, forever, while
            // dragging and double-tap-to-edit still worked.
            //
            // Gating on the slop means a press has to actually TRAVEL before it
            // is reinterpreted as a drag. Note that `gestureState.dx/dy`
            // accumulate from touch-down whether or not this responder ever
            // granted — PanResponder updates them from its capture handler,
            // which fires on ancestors too — so the threshold measures the whole
            // gesture, not the part after the steal.
            onMoveShouldSetPanResponder: (_evt, gesture) =>
                latest.current.interactive && shouldGrantDrag(gesture.dx, gesture.dy),
            onPanResponderGrant: () => {
                latest.current.onSelect();
                // @ts-ignore reading the private _value is the only synchronous
                // way to seed the drag offset; same trick as the salvage source.
                pan.setOffset({ x: pan.x._value, y: pan.y._value });
                pan.setValue({ x: 0, y: 0 });
            },
            // A grant that is REFUSED still ran `onPanResponderGrant`: the
            // responder system dispatches the grant to the candidate before it
            // asks the incumbent to hand over, and the corner handles below
            // refuse to hand over. Undo the offset seeding, or `pan` is left
            // holding offset = position / value = 0 and the NEXT drag seeds its
            // offset from that 0 and teleports the element to the canvas origin.
            onPanResponderReject: () => {
                pan.flattenOffset();
            },
            onPanResponderMove: Animated.event([null, { dx: pan.x, dy: pan.y }], { useNativeDriver: false }),
            // The host ScrollView can take a drag away natively mid-gesture
            // (native takeover cancels the touch outright — it does not ask).
            // Settle where the finger left it instead of dropping the offset.
            onPanResponderTerminate: settleDrag,
            onPanResponderRelease: (_evt, gesture) => {
                settleDrag();
                // A drag that never moved is a tap; two of them is an edit. Same
                // threshold as the grant above, so "did not become a drag" and
                // "counts as a tap" cannot disagree about a borderline gesture.
                if (isTapGesture(gesture.dx, gesture.dy)) {
                    const now = Date.now();
                    if (isDoubleTap(now, lastTap.current)) latest.current.onEdit();
                    lastTap.current = now;
                }
            },
        })
    ).current;

    const fontSize = item.size * scale;
    const handlers = interactive ? responder.panHandlers : {};

    return (
        <Animated.View
            {...handlers}
            style={[styles.element, { transform: [{ translateX: pan.x }, { translateY: pan.y }] }]}
        >
            <View
                style={[
                    styles.elementBox,
                    selected && styles.elementBoxSelected,
                    // Wrap inside the canvas instead of running off the right edge
                    // (ELEMENT_PADDING is spent on either side of the box).
                    { maxWidth: Math.max(fontSize * 2, (canvasWidth - item.x) * scale - ELEMENT_PADDING * 2) },
                ]}
            >
                <Text style={[styles.elementText, { fontSize, lineHeight: fontSize * 1.25 }]}>
                    {item.text || ' '}
                </Text>
            </View>

            {/*
              * Corner handles. `rejectResponderTermination` is the second half
              * of the fix described on `onMoveShouldSetPanResponder` above, and
              * it is load-bearing: it makes these presses UNTERMINABLE by the
              * drag responder wrapping them, so even a press that drifts past
              * the drag slop still resolves as a button press rather than
              * silently becoming a drag. The slop keeps the element draggable
              * from its body; this keeps the buttons pressable. Removing either
              * one brings the dead-button bug back.
              *
              * They sit INSIDE the parent's bounds by construction (30 px boxes
              * pinned to the corners of a box that is `ELEMENT_PADDING`-padded
              * on every side, with no negative offsets), which matters on
              * Android: a child hanging outside its parent still DRAWS but
              * never hit-tests. Do not "float" them out with negative insets.
              */}
            {selected && interactive && (
                <>
                    <TouchableOpacity
                        style={[styles.handle, styles.handleTopRight]}
                        onPress={onDelete}
                        delayPressIn={0}
                        rejectResponderTermination
                        hitSlop={{ top: 10, left: 10, right: 10, bottom: 10 }}
                    >
                        <Text style={styles.handleDeleteText}>✕</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                        style={[styles.handle, styles.handleBottomLeft]}
                        onPress={onEdit}
                        delayPressIn={0}
                        rejectResponderTermination
                        hitSlop={{ top: 10, left: 10, right: 10, bottom: 10 }}
                    >
                        <Text style={styles.handleEditText}>✎</Text>
                    </TouchableOpacity>
                </>
            )}
        </Animated.View>
    );
}

// ── Styles ──────────────────────────────────────────────────────────

function createStyles(theme: Theme) {
    return StyleSheet.create({
    root: {
        flex: 1,
    },
    canvasArea: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: theme.spacing.xl,
        paddingVertical: 10,
    },
    canvas: {
        // The FILL comes from the `backgroundColor` prop (white — the panel is
        // white paper). Only the hairline round it is app chrome.
        width: '100%',
        maxHeight: '100%',
        borderRadius: theme.radii.sm,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: theme.colors.border,
    },
    drawLayer: {
        zIndex: 999,
    },
    hint: {
        ...StyleSheet.absoluteFillObject,
        alignItems: 'center',
        justifyContent: 'center',
    },
    hintText: {
        // On the white canvas — see ON_CANVAS_* above.
        color: ON_CANVAS_HINT,
        fontSize: 14,
        fontWeight: '600',
    },
    toolbar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.sm,
        paddingHorizontal: theme.spacing.xl,
        paddingVertical: 10,
    },
    toolBtn: {
        backgroundColor: theme.colors.surface2,
        width: 40,
        height: 36,
        justifyContent: 'center',
        alignItems: 'center',
        borderRadius: theme.radii.sm,
    },
    toolBtnActive: {
        backgroundColor: theme.colors.accent,
    },
    toolBtnTextSmall: {
        color: theme.colors.text,
        fontSize: 13,
        fontWeight: '700',
    },
    toolBtnTextLarge: {
        color: theme.colors.text,
        fontSize: 17,
        fontWeight: '700',
    },
    toolReadout: {
        minWidth: 56,
        alignItems: 'center',
    },
    toolReadoutText: {
        ...theme.type.label,
        color: theme.colors.textMuted,
    },
    toolSpacer: {
        flex: 1,
    },
    toolHint: {
        ...theme.type.caption,
        color: theme.colors.textMuted,
        flexShrink: 1,
    },
    element: {
        position: 'absolute',
        top: 0,
        left: 0,
        padding: ELEMENT_PADDING,
    },
    elementBox: {
        borderWidth: 1,
        borderColor: 'transparent',
    },
    elementBoxSelected: {
        borderColor: ON_CANVAS_ACCENT,
        borderStyle: 'dashed',
    },
    elementText: {
        color: INK,
        fontFamily: 'monospace',
        fontWeight: '700',
    },
    handle: {
        position: 'absolute',
        width: 30,
        height: 30,
        borderRadius: 15,
        backgroundColor: ON_CANVAS_HANDLE_FILL,
        borderWidth: 1,
        borderColor: ON_CANVAS_ACCENT,
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 100,
        elevation: 5,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.3,
        shadowRadius: 2,
    },
    handleTopRight: {
        top: 0,
        right: 0,
    },
    handleBottomLeft: {
        bottom: 0,
        left: 0,
    },
    handleDeleteText: {
        color: ON_CANVAS_DANGER,
        fontWeight: 'bold',
        fontSize: 16,
        lineHeight: 18,
    },
    handleEditText: {
        color: ON_CANVAS_ACCENT,
        fontSize: 18,
        lineHeight: 22,
    },
    modalOverlay: {
        flex: 1,
        justifyContent: 'flex-end',
    },
    modalBg: {
        // The fullscreen text editor is a DARK sheet in both schemes (that is what
        // makes 24px type over an arbitrary canvas legible), so its contents use
        // the dark palette regardless of the active theme — warm espresso rather
        // than the old neutral black.
        ...StyleSheet.absoluteFillObject,
        backgroundColor: theme.alpha(darkColors.bg, 0.92),
    },
    modalContent: {
        width: '100%',
        padding: theme.spacing.xl,
        paddingBottom: 40,
        alignItems: 'center',
    },
    modalInput: {
        width: '100%',
        color: darkColors.text,
        fontSize: 24,
        fontFamily: 'monospace',
        textAlign: 'center',
        minHeight: 100,
    },
    modalDoneBtn: {
        marginTop: theme.spacing.xl,
        backgroundColor: darkColors.accent,
        paddingHorizontal: theme.spacing.xxl,
        paddingVertical: 10,
        borderRadius: theme.radii.lg,
    },
    modalDoneText: {
        color: darkColors.accentText,
        fontWeight: '700',
        fontSize: 16,
    },
    });
}
