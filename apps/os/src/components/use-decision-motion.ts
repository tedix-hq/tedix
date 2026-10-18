import {
	useEffect,
	useRef,
	useState,
	type CSSProperties,
	type PointerEvent,
} from "react";

export function useDecisionMotion() {
	const surface = useRef<HTMLElement>(null);
	const departure = useRef<Animation | null>(null);
	useEffect(() => () => departure.current?.cancel(), []);
	const start = useRef<{ x: number; y: number; id: number } | null>(null);
	const [exiting, setExiting] = useState<string>();
	const [drag, setDrag] = useState(0);
	const reduced = () => {
		const preference = document.documentElement.dataset.motion;
		return (
			preference === "reduced" ||
			window.matchMedia("(prefers-reduced-motion: reduce)").matches
		);
	};
	const reset = () => {
		start.current = null;
		setDrag(0);
	};
	return {
		surface,
		style: {
			"--fd-drag": `${drag}px`,
			"--fd-rotation": `${drag === 0 || reduced() ? 0 : Math.max(-8, Math.min(8, drag / 40))}deg`,
			"--fd-tint-strength": Math.min(Math.abs(drag) / 120, 1),
		} as CSSProperties,
		exiting,
		dragging: drag !== 0,
		direction: drag > 0 ? "approve" : drag < 0 ? "reject" : "idle",
		start(event: PointerEvent<HTMLElement>) {
			if (
				!event.isPrimary ||
				event.button !== 0 ||
				(event.target as HTMLElement).closest(
					"input, textarea, button, a, summary, [contenteditable=true]",
				)
			)
				return;
			// Native text selection can turn the next swipe into a dragstart/pointercancel.
			event.preventDefault();
			event.currentTarget.focus({ preventScroll: true });
			start.current = {
				x: event.clientX,
				y: event.clientY,
				id: event.pointerId,
			};
		},
		move(event: PointerEvent<HTMLElement>) {
			const origin = start.current;
			if (!origin || origin.id !== event.pointerId) return;
			const dx = event.clientX - origin.x;
			if (
				Math.abs(event.clientY - origin.y) > Math.abs(dx) &&
				Math.abs(dx) < 12
			) {
				reset();
				return;
			}
			if (!reduced()) setDrag(dx);
		},
		end(event: PointerEvent<HTMLElement>) {
			const origin = start.current;
			reset();
			if (!origin || origin.id !== event.pointerId) return 0;
			const dx = event.clientX - origin.x;
			return Math.abs(dx) >= 90 &&
				Math.abs(dx) > Math.abs(event.clientY - origin.y) * 2
				? Math.sign(dx)
				: 0;
		},
		reset,
		pulse() {
			const element = surface.current;
			if (!element?.animate || reduced()) return;
			const duration =
				Number.parseFloat(
					getComputedStyle(element).getPropertyValue("--fd-press-duration"),
				) * 2;
			if (!Number.isFinite(duration)) return;
			element.animate(
				[
					{ transform: "scale(1)" },
					{ transform: "scale(0.985)" },
					{ transform: "scale(1)" },
				],
				{
					duration,
					easing: "ease-out",
				},
			);
		},
		cancelExit() {
			departure.current?.cancel();
			setExiting(undefined);
			const stack = surface.current?.closest<HTMLElement>(".fd-decision-stack");
			if (stack) delete stack.dataset.exiting;
		},
		async exit(direction?: string) {
			const element = surface.current;
			if (!element?.animate || reduced()) return;
			const duration = Number.parseFloat(
				getComputedStyle(element).getPropertyValue("--fd-exit-duration"),
			);
			if (!Number.isFinite(duration)) return;
			const sign = direction === "reject" ? -1 : 1;
			setExiting(direction === "reject" ? "reject" : "approve");
			const stack = element.closest<HTMLElement>(".fd-decision-stack");
			if (stack) stack.dataset.exiting = "true";
			departure.current = element.animate(
				[
					{ transform: getComputedStyle(element).transform, opacity: 1 },
					{
						transform: `translateX(${sign * 320}px) rotate(${sign * 6}deg)`,
						opacity: 0,
					},
				],
				{
					duration,
					easing: "ease-in",
					fill: "forwards",
				},
			);
			await departure.current.finished.catch(() => {});
		},
	};
}
