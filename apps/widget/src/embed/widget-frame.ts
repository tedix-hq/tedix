/**
 * The boundary that decides what may be framed into a customer's page.
 *
 * This is the widget's sharpest security surface — everything past it runs in
 * an iframe with `allow-scripts` on a third party's site — and it had no test
 * at all, living inline in `embed.mjs` where only source-text assertions reach.
 *
 * Two properties are load-bearing and easy to break by accident:
 *
 * - The allowlist compares FULL ORIGINS for equality. A substring or
 *   `endsWith` check would accept `https://mcp-ui.tedix.dev.example.com`, and
 *   an origin comparison also pins the scheme, so `http://mcp-ui.tedix.dev`
 *   stays rejected.
 * - The sandbox omits `allow-same-origin`. With `allow-scripts` present,
 *   adding it would give framed content a real origin and let it reach out of
 *   the sandbox — including into the host page when the widget URL is
 *   same-origin. `WIDGET_FRAME_SANDBOX` has a test asserting its absence.
 */

/** The one origin that serves MCP app layouts. Used to build URLs and to admit them. */
export const MCP_APP_ORIGIN = "https://mcp-ui.tedix.dev";

/**
 * Deliberately without `allow-same-origin`: framed widget content must stay on
 * an opaque origin even when it was loaded from the host's own origin.
 */
export const WIDGET_FRAME_SANDBOX =
	"allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox";

/**
 * An opaque origin serializes to the literal string "null" — that is what
 * `javascript:` and `data:` URLs report.
 *
 * It is also what `location.origin` reports when the HOST page is itself
 * sandboxed without `allow-same-origin`. The previous inline check compared
 * `parsed.origin !== location.origin`, so in that context `"null" !== "null"`
 * was false and a `javascript:` widget URL was ADMITTED. Rejecting opaque
 * origins outright closes that, and costs nothing in a normal host.
 */
const OPAQUE_ORIGIN = "null";

export interface WidgetFrameContext {
	/** `location.href` of the host page — the base for relative widget URLs. */
	pageHref: string;
	/** `location.origin` of the host page. Same-origin widgets are admitted. */
	pageOrigin: string;
}

/**
 * Resolve a widget URL to a safe absolute `src`, or `null` to refuse it.
 *
 * Returning `null` rather than throwing keeps the caller's shape: a refused
 * widget is simply not appended, which is what the embed already did.
 */
export function resolveWidgetFrameSource(
	rawUrl: unknown,
	context: WidgetFrameContext,
): string | null {
	if (typeof rawUrl !== "string" || rawUrl.trim() === "") return null;

	let parsed: URL;
	try {
		parsed = new URL(rawUrl, context.pageHref);
	} catch {
		return null;
	}

	if (parsed.origin === OPAQUE_ORIGIN) return null;
	if (parsed.origin === MCP_APP_ORIGIN) return parsed.href;
	if (
		context.pageOrigin !== OPAQUE_ORIGIN &&
		parsed.origin === context.pageOrigin
	) {
		return parsed.href;
	}
	return null;
}
