import { useLayoutEffect, useRef } from "react";

/** Fit an embedded deck below the shell, including mobile browser chrome. */
export function useDeckViewport() {
	const ref = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const root = ref.current;
		if (!root) return;
		const fit = () => {
			const viewport = window.visualViewport;
			const viewportBottom =
				(viewport?.height ?? window.innerHeight) + (viewport?.offsetTop ?? 0);
			const page = root.closest('[data-slot="page"]');
			const scrolls =
				page && ["auto", "scroll"].includes(getComputedStyle(page).overflowY);
			const bottom = scrolls
				? Math.min(viewportBottom, page.getBoundingClientRect().bottom)
				: viewportBottom;
			const bottomPadding = page
				? parseFloat(getComputedStyle(page).paddingBottom)
				: 0;
			root.style.setProperty(
				"--fd-available-height",
				`${Math.max(0, bottom - root.getBoundingClientRect().top - bottomPadding - 16)}px`,
			);
		};
		fit();
		const observer = new ResizeObserver(fit);
		if (root.parentElement) observer.observe(root.parentElement);
		window.addEventListener("resize", fit);
		window.visualViewport?.addEventListener("resize", fit);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", fit);
			window.visualViewport?.removeEventListener("resize", fit);
		};
	}, []);
	return ref;
}
