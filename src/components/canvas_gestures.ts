/**
 * canvas_gestures — the pure arithmetic behind CanvasComposer's touch handling.
 *
 * Split out of `CanvasComposer.tsx` for ONE reason: it is the part of the
 * gesture logic that can be tested without a device, a renderer or a native
 * responder system. Everything here is a total function of numbers, so
 * `scripts/canvas-gestures.test.js` can pin it directly.
 *
 * ---------------------------------------------------------------------------
 * WHY A DRAG SLOP EXISTS AT ALL (do not remove it)
 * ---------------------------------------------------------------------------
 * A selected text element carries two hovering corner buttons (✕ delete, ✎
 * edit) INSIDE the same view that owns the element's drag PanResponder. React
 * Native's responder negotiation lets an ancestor take the responder away from
 * a descendant mid-gesture: on every touch move the ancestor's
 * `onMoveShouldSetResponder` is consulted, and if it says yes the current
 * responder is asked to terminate (Pressability says yes by default), which
 * CANCELS the in-flight press.
 *
 * So a drag responder that grants on ANY movement eats every button press: a
 * real finger on a real panel jitters a pixel or two between touch-down and
 * lift, the ancestor steals, the button never sees `onPress`, and the whole
 * gesture is spent as a zero-distance drag that moves the element back to
 * exactly where it was. From the outside the buttons look dead while dragging
 * and double-tap keep working — which is precisely the bug this file exists to
 * prevent.
 *
 * The fix is a threshold: the element claims the drag only once the finger has
 * travelled far enough that the user's intent is unambiguously "move this",
 * not "press that". Below the threshold the press keeps the responder and
 * fires.
 */

/**
 * How far (in SCREEN px, the units gesture state reports) a finger must travel
 * before a text element takes the drag off whatever child is being pressed.
 *
 * Sized to clear finger jitter and the contact-patch drift Android reports
 * while a press settles, while staying well under the distance a deliberate
 * drag covers in its first few frames.
 */
export const DRAG_SLOP = 6;

/** How close two taps must be, in ms, to count as a double tap. */
export const DOUBLE_TAP_MS = 300;

/**
 * Has this gesture moved far enough to become a drag?
 *
 * Per-axis rather than euclidean on purpose: it matches how the gesture reads
 * to a user (a 6 px horizontal slide is a drag whatever the vertical is) and
 * it is the cheaper test on the hot move path.
 *
 * Non-finite input (never observed, but gesture state is native-sourced) is
 * treated as "no drag": refusing to grant leaves the press working, which is
 * the safer failure.
 */
export function shouldGrantDrag(dx: number, dy: number, slop: number = DRAG_SLOP): boolean {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
    return Math.abs(dx) > slop || Math.abs(dy) > slop;
}

/**
 * Was this gesture a tap rather than a drag?
 *
 * The exact complement of `shouldGrantDrag` BY CONSTRUCTION, and it has to
 * stay that way: a gesture that never travelled far enough to claim the drag
 * is the same gesture that should count as a tap. Two independently tuned
 * thresholds would leave a dead band where a gesture is neither.
 */
export function isTapGesture(dx: number, dy: number, slop: number = DRAG_SLOP): boolean {
    return !shouldGrantDrag(dx, dy, slop);
}

/**
 * Is a tap at `now` the second half of a double tap that started at
 * `lastTapAt`?
 *
 * `lastTapAt === 0` means "no previous tap" (the initial value of the caller's
 * ref), and a clock that went backwards cannot make a pair — both return
 * false, so a fresh element never opens the editor on its first tap.
 */
export function isDoubleTap(
    now: number,
    lastTapAt: number,
    windowMs: number = DOUBLE_TAP_MS
): boolean {
    if (lastTapAt <= 0) return false;
    const gap = now - lastTapAt;
    return gap >= 0 && gap < windowMs;
}
