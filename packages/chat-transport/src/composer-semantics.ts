/**
 * Composer rules both chat surfaces have to agree on, in one place.
 *
 * These are small, but they had drifted in the way small shared rules do: OS
 * chat owned a tested `isImeComposing` while the embedded widget open-coded a
 * weaker check inline, and OS owned a documented 64px sticky-scroll threshold
 * while the widget open-coded 96px with nothing asserting it. Neither
 * divergence was a decision — the widget simply never got the second half of
 * the rule.
 *
 * Framework-neutral on purpose: OS passes React synthetic events, the widget
 * passes raw DOM events, so the contract is the *signal* each carries rather
 * than either event type.
 */

/** The composition-relevant slice of a keyboard event, from either surface. */
export interface CompositionKeySignal {
	isComposing?: boolean;
	keyCode?: number;
}

/**
 * True while an input method editor owns the keystroke, so commit-on-Enter
 * stays inert until the candidate is chosen.
 *
 * `keyCode === 229` is not redundant with `isComposing`: it is the only signal
 * some browsers give during composition (older Safari and several Android
 * IMEs never set `isComposing`). Dropping it is what lets Enter send a
 * half-composed word — the exact defect this consolidates away, since the
 * widget checked only `isComposing`.
 */
export function isImeComposingKey(signal: CompositionKeySignal): boolean {
	return signal.isComposing === true || signal.keyCode === 229;
}

/**
 * Near-bottom threshold for sticky autoscroll. Generous on purpose: a tight
 * threshold detaches follow-mode on sub-pixel rounding while text streams
 * (classic streaming-chat jitter). Anything within 64px of the bottom still
 * counts as pinned; a real upward scroll detaches following.
 */
export const STICKY_SCROLL_THRESHOLD_PX = 64;

/** The scroll geometry the near-bottom test needs, from any scroll container. */
export interface ScrollMetrics {
	scrollHeight: number;
	scrollTop: number;
	clientHeight: number;
}

export function isNearBottom(
	metrics: ScrollMetrics,
	threshold: number = STICKY_SCROLL_THRESHOLD_PX,
): boolean {
	return (
		metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold
	);
}

/**
 * Reflow changes transcript geometry without changing its messages. Preserve
 * the reader's existing follow intent rather than deriving it from the newly
 * resized viewport (which may already be hundreds of pixels from the tail).
 */
export function observeScrollResize(
	element: HTMLElement,
	shouldFollow: () => boolean,
): () => void {
	if (typeof ResizeObserver === "undefined") return () => {};
	let disposed = false;
	const observer = new ResizeObserver(() => {
		if (!disposed && shouldFollow()) element.scrollTop = element.scrollHeight;
	});
	observer.observe(element);
	return () => {
		disposed = true;
		observer.disconnect();
	};
}
