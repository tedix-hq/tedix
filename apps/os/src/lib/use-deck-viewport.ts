import { useLayoutEffect, useRef } from "react";

/**
 * Below this much room the deck stops fitting the window and takes its natural
 * height, so the page scrolls instead of the card collapsing onto its actions.
 */
const MIN_DECK_HEIGHT = 352;

/**
 * Fit an embedded deck below the shell, including mobile browser chrome.
 *
 * Sized from the layout viewport, never the visual viewport: an iOS software
 * keyboard shrinks only the visual viewport, and following it collapsed the
 * card to a sliver above a blank screen.
 */
export function useDeckViewport() {
	const ref = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const root = ref.current;
		if (!root) return;
		const fit = () => {
			const viewportBottom = document.documentElement.clientHeight;
			const page = root.closest('[data-slot="page"]');
			const scrolls =
				page &&
				page.parentElement &&
				["flex", "inline-flex", "grid", "inline-grid"].includes(
					getComputedStyle(page.parentElement).display,
				) &&
				["auto", "scroll"].includes(getComputedStyle(page).overflowY);
			const bottom = scrolls
				? Math.min(viewportBottom, page.getBoundingClientRect().bottom)
				: viewportBottom;
			const bottomPadding = page
				? parseFloat(getComputedStyle(page).paddingBottom)
				: 0;
			// Measured from the unscrolled position so scrolling never flips the mode.
			const available =
				bottom -
				(root.getBoundingClientRect().top + (page?.scrollTop ?? 0)) -
				bottomPadding -
				16;
			const height = available < MIN_DECK_HEIGHT ? "auto" : `${available}px`;
			if (root.style.getPropertyValue("--fd-available-height") !== height)
				root.style.setProperty("--fd-available-height", height);
		};
		fit();
		let frame = 0;
		const scheduleFit = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(fit);
		};
		const observer = new ResizeObserver(scheduleFit);
		if (root.parentElement) observer.observe(root.parentElement);
		window.addEventListener("resize", fit);
		return () => {
			observer.disconnect();
			cancelAnimationFrame(frame);
			window.removeEventListener("resize", fit);
		};
	}, []);
	return ref;
}
