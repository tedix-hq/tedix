/*
 * Visual-viewport geometry, published as document-level custom properties.
 *
 * `100dvh` is the LARGEST viewport unit: it deliberately does not shrink when
 * a software keyboard opens, so a shell sized in `dvh` pushes its bottom-most
 * chrome (the chat composer) underneath the iOS keyboard. `window.visualViewport`
 * is the only surface that reports the actually-visible rectangle, so the shell
 * is sized from these tokens instead and `100dvh` survives only as their
 * pre-JS default in `styles.css`.
 *
 * Installed once per document from `index.html`, not from a React effect: the
 * listener is document-scoped, must outlive every route, and must not be torn
 * down and re-installed by StrictMode's double-invoked effects.
 */

const HEIGHT_PROPERTY = "--viewport-tedix-height";
const TOP_PROPERTY = "--viewport-tedix-top";
const BOTTOM_PROPERTY = "--viewport-tedix-bottom";

/**
 * Publishes `--viewport-tedix-{height,top,bottom}` on `<html>` and keeps them
 * current while the visual viewport moves. Returns a teardown that removes the
 * listeners and the properties.
 *
 * A no-op where `visualViewport` is unavailable — the CSS defaults already
 * describe a browser with no software keyboard to account for.
 */
export function installViewportMetrics(): () => void {
	const viewport = globalThis.window?.visualViewport;
	if (!viewport) return () => {};

	const root = document.documentElement;
	let frame = 0;

	const publish = () => {
		frame = 0;
		const { height, offsetTop } = viewport;
		root.style.setProperty(HEIGHT_PROPERTY, `${height}px`);
		root.style.setProperty(TOP_PROPERTY, `${offsetTop}px`);
		// What the keyboard (or any other inset widget) covers at the bottom
		// edge: the layout viewport minus the visible rectangle above it.
		root.style.setProperty(
			BOTTOM_PROPERTY,
			`${Math.max(0, window.innerHeight - offsetTop - height)}px`,
		);
	};

	/*
	 * `resize` and `scroll` both fire once per animation frame while a keyboard
	 * animates in. Coalescing into a single rAF write keeps this off the
	 * synchronous layout path — style writes are the whole job, so there is
	 * nothing to gain from running three of them per frame.
	 */
	const schedule = () => {
		if (frame) return;
		frame = requestAnimationFrame(publish);
	};

	publish();
	viewport.addEventListener("resize", schedule);
	viewport.addEventListener("scroll", schedule);

	return () => {
		if (frame) cancelAnimationFrame(frame);
		viewport.removeEventListener("resize", schedule);
		viewport.removeEventListener("scroll", schedule);
		root.style.removeProperty(HEIGHT_PROPERTY);
		root.style.removeProperty(TOP_PROPERTY);
		root.style.removeProperty(BOTTOM_PROPERTY);
	};
}
