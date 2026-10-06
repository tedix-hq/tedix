/**
 * URL-scheme allowlist for widget surfaces.
 *
 * ## Why this exists
 *
 * The json-render registry is a CLOSED component set: no `eval`, no
 * `new Function`, no `dangerouslySetInnerHTML` on model data. Arbitrary client
 * JS cannot reach the page. What CAN reach the page is a model-authored
 * *string* — a layout spec's `url`, `href`, `thumbnail`, or an `open_url`
 * action param — and a string is enough if it lands on a navigable attribute.
 * `href="javascript:…"` and `window.open("javascript:…")` both execute in the
 * widget's own document, which on `mcp-ui.tedix.dev` sits on an origin holding
 * a KV `SESSION` binding and is embedded by third-party hosts including
 * ChatGPT. So the risk here is DATA-driven, and the defense belongs on the
 * data boundary: every model-derived URL is validated before it becomes an
 * attribute.
 *
 * ## The rule
 *
 * Parse with the WHATWG URL parser, then check the parser's normalized
 * `protocol` against a fixed allowlist, and render the parser's normalized
 * `href` — never the raw input. Validating a normalized value and then
 * rendering a different (raw) one is how scheme filters get bypassed.
 *
 * Letting the parser normalize first is also what makes the obfuscation cases
 * fall out for free rather than needing a blocklist of tricks. The parser
 * strips leading/trailing C0 controls and spaces and removes ALL embedded tab,
 * LF, and CR before it reads the scheme, and it lowercases the scheme — which
 * is exactly what a browser does with an `href`, so we make the same
 * judgement the browser will. `" javascript:…"`, `"java\nscript:…"`,
 * `"JaVaScRiPt:…"`, and `"\u0001javascript:…"` all normalize to protocol
 * `javascript:` and are rejected. Inputs that are not valid URLs at all —
 * `"jav\u0000ascript:…"` (an internal NUL is NOT removed, so the scheme is
 * invalid), `"\u00A0javascript:…"` (U+00A0 is not C0 whitespace, so the scheme
 * cannot start there) — fail to parse and are rejected too.
 *
 * ## Relative URLs are out of scope, deliberately
 *
 * Every function here parses with NO base, so a relative URL (`/foo`,
 * `#anchor`, `//evil.example`) fails to parse and is rejected. That is
 * intentional for model-derived targets: widget HTML is fetched server-side by
 * `apps/mcp` and handed to the host as inline resource text, so the document
 * that finally renders it has the HOST's base URL, not ours. A relative target
 * resolves against `*.oaiusercontent.com` (or the Tedix OS sandbox), where it means
 * nothing we control. `apps/mcp`'s `rewriteRelativeUrls` absolutizes relative
 * URLs in the SSR'd markup, but it cannot see attributes React writes on the
 * client from a spec. A model-supplied link target must therefore be absolute.
 *
 * This module is NOT for the app's own static markup — `href="/favicon.ico"`
 * in an Astro layout is authored, not model-derived, and stays as it is.
 */

/**
 * Schemes allowed on a navigable target (`href`, `window.open`, host
 * `openExternal`).
 *
 * - `https:` — the only fetchable scheme. `http:` is excluded: the widget is
 *   always rendered inside an https document, so an http target is mixed
 *   content the browser blocks or upgrades anyway, and excluding it keeps the
 *   allowlist to schemes that actually work.
 * - `mailto:` / `tel:` — non-fetching, handed to an external handler, and both
 *   are real product affordances (merchant contact links).
 *
 * Everything else fails closed, including `javascript:`, `data:`, `vbscript:`,
 * `blob:`, `file:`, and `about:`.
 */
export const SAFE_LINK_SCHEMES: readonly string[] = [
	"https:",
	"mailto:",
	"tel:",
];

/**
 * Schemes allowed on a media subresource (`<img src>`).
 *
 * Narrower than {@link SAFE_LINK_SCHEMES}: an `<img>` never navigates, so
 * `mailto:`/`tel:` are meaningless there, and `data:` is excluded so a spec
 * cannot inline arbitrary bytes into the document.
 */
export const SAFE_MEDIA_SCHEMES: readonly string[] = ["https:"];

/**
 * Parse with no base and hand back the normalized URL, or `null`.
 *
 * No base is the load-bearing part — it is what rejects relative and
 * protocol-relative input rather than silently resolving it against whatever
 * document happens to be hosting us.
 */
function parseAbsolute(raw: unknown): URL | null {
	if (typeof raw !== "string") return null;
	if (raw.length === 0) return null;
	try {
		return new URL(raw);
	} catch {
		return null;
	}
}

function normalizeAgainst(
	raw: unknown,
	allowed: readonly string[],
): string | undefined {
	const url = parseAbsolute(raw);
	if (!url) return undefined;
	// `url.protocol` is already lowercased and includes the trailing colon.
	if (!allowed.includes(url.protocol)) return undefined;
	// Return the PARSED href, not `raw`: what was validated must be what is
	// rendered.
	return url.href;
}

/**
 * Normalize a model-derived URL for a navigable target.
 *
 * Returns the normalized absolute URL, or `undefined` when the value is not a
 * string, not an absolute URL, or not in {@link SAFE_LINK_SCHEMES}.
 *
 * `undefined` is the fail-closed value on purpose: React omits an attribute
 * whose value is `undefined`, so a rejected URL yields an anchor with no
 * `href` — inert, still readable, no navigation — instead of a link to a
 * placeholder the user might trust.
 */
export function safeLinkHref(raw: unknown): string | undefined {
	return normalizeAgainst(raw, SAFE_LINK_SCHEMES);
}

/**
 * Normalize a model-derived URL for an `<img src>`.
 *
 * Same contract as {@link safeLinkHref} against {@link SAFE_MEDIA_SCHEMES}. A
 * rejected value leaves the `src` unset, which renders the element's `alt`
 * text rather than a broken-image icon pointed at an attacker's origin.
 */
export function safeImageSrc(raw: unknown): string | undefined {
	return normalizeAgainst(raw, SAFE_MEDIA_SCHEMES);
}

/**
 * Predicate form, for call sites that branch on safety before building
 * anything (e.g. choosing between an `<a>` and a `<div>` wrapper).
 */
export function isSafeLinkHref(raw: unknown): boolean {
	return safeLinkHref(raw) !== undefined;
}

/**
 * `window.open` a model-derived URL, or do nothing.
 *
 * `window.open("javascript:…")` executes in the opened window against the
 * OPENER's origin, so this is a navigable target and gets the link allowlist.
 * Returns whether the navigation was attempted, so a caller can keep telemetry
 * honest about what it actually did.
 */
export function openSafeExternalUrl(
	raw: unknown,
	features = "noopener,noreferrer",
): boolean {
	const href = safeLinkHref(raw);
	if (!href) {
		console.warn(
			`[widget] blocked navigation to a disallowed URL scheme: ${typeof raw === "string" ? raw.slice(0, 120) : typeof raw}`,
		);
		return false;
	}
	if (typeof window === "undefined") return false;
	window.open(href, "_blank", features);
	return true;
}
