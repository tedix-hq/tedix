import { useCallback, useRef } from "react";

/**
 * Marks a scroll container with `data-more-below` while content sits below
 * its visible end, so CSS can fade that edge instead of showing a hard cut.
 */
export function useMoreBelow<T extends HTMLElement>() {
	const cleanup = useRef<(() => void) | null>(null);
	return useCallback((node: T | null) => {
		cleanup.current?.();
		cleanup.current = null;
		if (!node) return;
		const update = () =>
			node.toggleAttribute(
				"data-more-below",
				node.scrollTop + node.clientHeight < node.scrollHeight - 1,
			);
		update();
		const observer = new ResizeObserver(update);
		observer.observe(node);
		for (const child of node.children) observer.observe(child);
		node.addEventListener("scroll", update, { passive: true });
		cleanup.current = () => {
			observer.disconnect();
			node.removeEventListener("scroll", update);
		};
	}, []);
}
