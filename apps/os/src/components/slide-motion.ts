import { type RefObject, useEffect, useRef } from "react";

/** How far a swipe travels before it counts as a page turn, in CSS pixels. */
const SWIPE_DISTANCE = 48;

function prefersReducedMotion() {
	return (
		typeof window !== "undefined" &&
		window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
	);
}

/**
 * Plays a short entrance on `ref` whenever the shown slide changes: the new
 * slide fades in from the side it comes from, so going forward and going back
 * read differently. The first render and reduced motion get no animation.
 * The Web Animations API keeps the element mounted, so an editing canvas keeps
 * its focus and drag state across the turn.
 */
export function useSlideEntrance(
	ref: RefObject<HTMLElement | null>,
	slideId: string | undefined,
	index: number,
) {
	const previous = useRef({ slideId, index });
	useEffect(() => {
		const before = previous.current;
		previous.current = { slideId, index };
		if (!slideId || !before.slideId || before.slideId === slideId) return;
		const node = ref.current;
		if (!node || typeof node.animate !== "function" || prefersReducedMotion())
			return;
		const from = index >= before.index ? 1 : -1;
		node.animate(
			[
				{ opacity: 0, transform: `translateX(${from * 20}px) scale(0.99)` },
				{ opacity: 1, transform: "none" },
			],
			{ duration: 220, easing: "cubic-bezier(0.2, 0, 0, 1)" },
		);
	}, [ref, slideId, index]);
}

/**
 * Horizontal swipe on touch and pen: left goes forward, right goes back. A
 * mostly vertical drag is a scroll and is left alone; a mouse never swipes,
 * so desktop text selection and element drags are unaffected.
 */
export function useSlideSwipe(onPrevious: () => void, onNext: () => void) {
	const start = useRef<{ x: number; y: number; id: number } | null>(null);
	return {
		onPointerDown: (event: React.PointerEvent) => {
			start.current =
				event.pointerType === "mouse"
					? null
					: { x: event.clientX, y: event.clientY, id: event.pointerId };
		},
		onPointerUp: (event: React.PointerEvent) => {
			const origin = start.current;
			start.current = null;
			if (!origin || origin.id !== event.pointerId) return;
			const dx = event.clientX - origin.x;
			const dy = event.clientY - origin.y;
			if (Math.abs(dx) < SWIPE_DISTANCE || Math.abs(dx) < Math.abs(dy) * 1.5)
				return;
			if (dx < 0) onNext();
			else onPrevious();
		},
		onPointerCancel: () => {
			start.current = null;
		},
	};
}
