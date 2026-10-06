/** Path prefixes that must never be cached at the edge: admin UI, auth, media
 * uploads, internal APIs, and anything else that is per-session or mutates
 * state. `/_astro/` and `/_tedix/` (hot theme) never reach this function —
 * both return earlier in fetch() — but are excluded here too as a second
 * line of defense against future call-site changes. */
export const EDGE_CACHE_EXCLUDED_PREFIXES = [
	"/_emdash/",
	"/_tedix/",
	"/_astro/",
	"/api/",
];

/**
 * Public tenant response caching is deliberately disabled.
 *
 * This parent Worker serves every CMS hostname. Production proved that
 * Workers Cache entries could cross those hostname boundaries even when the
 * response carried `Vary: Host`, including redirects and tenant-provided
 * `robots.txt` policies. Until the runtime has an explicit, request-derived
 * tenant cache key with adversarial live proof, every public GET/HEAD response
 * must override upstream cache policy with `private, no-store`.
 *
 * `Vary: Host` remains defense in depth, but is not an isolation boundary.
 */
const DISABLED_CACHE_CONTROL = "private, no-store";

/**
 * Content-Signal tells AI crawlers what they may do with a page before they
 * parse the body — the HTTP-header counterpart to the `<meta name="content-signal">`
 * tag. apps/landing already sets this on every HTML response; tenant CMS pages
 * were the gap, so blog.tedix.dev was served to GPTBot/ClaudeBot/PerplexityBot
 * with no signal at all.
 *
 * Same value as the landing worker: content may be surfaced and cited in AI
 * search and used as model input, but not used for training.
 *
 * @see https://contentsignals.org — Content Signals framework
 */
const CONTENT_SIGNAL = "ai-train=no, search=yes, ai-input=yes";
const CONTENT_SIGNAL_TYPES = [
	"text/html",
	"text/markdown",
	"application/xml",
	"text/xml",
];

export function applyContentSignal(response: Response): Response {
	if (response.headers.has("Content-Signal")) return response;
	const contentType = response.headers.get("content-type") ?? "";
	if (!CONTENT_SIGNAL_TYPES.some((type) => contentType.includes(type))) {
		return response;
	}
	const headers = new Headers(response.headers);
	headers.set("Content-Signal", CONTENT_SIGNAL);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

export function applyEdgeCacheHeaders(
	response: Response,
	method: string,
	pathname: string,
): Response {
	if (method !== "GET" && method !== "HEAD") return response;
	if (
		EDGE_CACHE_EXCLUDED_PREFIXES.some((prefix) => pathname.startsWith(prefix))
	)
		return response;

	const headers = new Headers(response.headers);
	headers.set("Cache-Control", DISABLED_CACHE_CONTROL);
	const existingVary = headers.get("Vary");
	const varyFields = existingVary
		? existingVary.split(",").map((field) => field.trim())
		: [];
	if (!varyFields.some((field) => field.toLowerCase() === "host")) {
		varyFields.push("Host");
	}
	headers.set("Vary", varyFields.join(", "));

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
