/**
 * Slide elements name typefaces in `style.fontFamily` (a CSS font stack), but
 * the OS bundle ships only its own UI faces, so a deck written in, say, Space
 * Grotesk silently rendered in the browser's fallback sans. This loads the
 * stack's preferred family from Google Fonts, the only host it ever requests.
 *
 * Only the first family the browser cannot already provide is loaded; the rest
 * of the stack stays a fallback. Generic families, the OS UI faces and common
 * system faces are never requested, and a name that is not a plain family name
 * is ignored rather than put into a URL.
 */

const GOOGLE_FONTS_CSS = "https://fonts.googleapis.com/css2";

const NOT_LOADABLE = new Set([
	"serif",
	"sans-serif",
	"monospace",
	"cursive",
	"fantasy",
	"system-ui",
	"ui-sans-serif",
	"ui-serif",
	"ui-monospace",
	"ui-rounded",
	"emoji",
	"math",
	"fangsong",
	"inherit",
	"initial",
	"unset",
	"-apple-system",
	"blinkmacsystemfont",
	"segoe ui",
	"helvetica",
	"helvetica neue",
	"arial",
	"times",
	"times new roman",
	"georgia",
	"courier",
	"courier new",
	"verdana",
	"menlo",
	"monaco",
	"consolas",
	"sf mono",
	"ft kunst grotesk",
	"apercu mono pro",
	"comfortaa variable",
]);

const FAMILY_NAME = /^[A-Za-z][A-Za-z0-9 ]{0,59}$/;

/** The family in a CSS font stack that should be fetched, or null. */
export function loadableSlideFontFamily(
	fontFamily: string | undefined,
): string | null {
	if (!fontFamily) return null;
	for (const part of fontFamily.split(",")) {
		const name = part
			.trim()
			.replace(/^(['"])(.*)\1$/, "$2")
			.trim();
		if (!name) continue;
		if (NOT_LOADABLE.has(name.toLowerCase())) continue;
		return FAMILY_NAME.test(name) ? name : null;
	}
	return null;
}

/**
 * Stylesheet URL for one family. The weighted form covers the four weights the
 * slide schema can ask for; `withWeights: false` is the fallback for a
 * single-weight family, which Google rejects when asked for other weights.
 */
export function googleFontsStylesheetUrl(
	family: string,
	withWeights = true,
): string {
	const name = family.trim().replace(/ +/g, "+");
	const axis = withWeights ? ":wght@400;500;600;700" : "";
	return `${GOOGLE_FONTS_CSS}?family=${name}${axis}&display=swap`;
}

/** Add the family's stylesheet to the document once; later calls are no-ops. */
export function ensureSlideFontLoaded(
	fontFamily: string | undefined,
	doc: Document = document,
): void {
	const family = loadableSlideFontFamily(fontFamily);
	if (!family) return;
	const key = family.toLowerCase();
	const existing = doc.head.querySelectorAll("link[data-slide-font]");
	for (const link of existing) {
		if (link.getAttribute("data-slide-font") === key) return;
	}
	const link = doc.createElement("link");
	link.rel = "stylesheet";
	link.setAttribute("data-slide-font", key);
	link.href = googleFontsStylesheetUrl(family);
	// Some DOMs fire `error` synchronously inside the href setter, so the
	// retry is guarded by a flag rather than relying on `{ once: true }`.
	let retried = false;
	const retryWithoutWeights = () => {
		if (retried) return;
		retried = true;
		link.removeEventListener("error", retryWithoutWeights);
		link.href = googleFontsStylesheetUrl(family, false);
	};
	link.addEventListener("error", retryWithoutWeights);
	doc.head.append(link);
}
