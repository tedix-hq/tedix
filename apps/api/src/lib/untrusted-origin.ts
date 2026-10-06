/**
 * The untrusted-content origin: where agent-authored bytes are served from.
 *
 * WHY THIS EXISTS
 * ---------------
 * `record_artifact` lets a tedi choose both the BYTES and the `mimeType` of a
 * deliverable, and skill runs do the same for media. Today those bytes stream
 * from `api.tedix.dev` (and, through the Tedix OS `/api/*` proxy, from
 * `{slug}.os.tedix.dev` — literally the same origin as the authenticated SPA).
 * `apps/api/src/lib/artifact-serve.ts` mitigates that with a deny-by-default
 * `Content-Security-Policy: sandbox`, which is a good mitigation and not a
 * boundary: it depends on one header being correct on every response forever.
 *
 * The boundary is an origin that does not share the authenticated cookie. The
 * Descope session cookies are site-scoped, not host-scoped —
 * `packages/auth/src/web.ts:getParentCookieDomain` walks `os.tedix.dev` up to
 * `.tedix.dev`, `DS` is NOT HttpOnly (readable by script on any `tedix.dev`
 * host) and `DSR` is HttpOnly but ambiently sent to every `tedix.dev` host for
 * 28 days. So no `*.tedix.dev` hostname can host untrusted bytes, no matter
 * how it is configured.
 *
 * CONFIGURATION
 * -------------
 * `UNTRUSTED_CONTENT_ORIGIN` (a `wrangler.jsonc` var, per environment). It is
 * deliberately EMPTY in every environment today because no domain Tedix owns
 * qualifies — see the three protected sites below. A human must register a
 * domain outside them (or expose a `*.workers.dev` origin, which is in the
 * Public Suffix List and therefore cannot share a cookie with anything) before
 * this can be turned on.
 *
 * THREE STATES, KEPT DISTINGUISHABLE
 * ----------------------------------
 *   unset      → not provisioned yet. Bytes keep serving from the shared
 *                origin under the `artifact-serve` sandbox CSP. This is the
 *                status quo and is honestly weaker; it is not isolation.
 *   configured → bytes serve ONLY from that origin. Trusted-origin byte
 *                routes redirect there; the untrusted origin serves nothing
 *                but the two signed byte routes.
 *   invalid    → configured to a value that shares a cookie jar with an
 *                authenticated surface (or is not a usable origin). This
 *                REFUSES. It must never silently degrade to `unset`, because
 *                a silent fallback is a config that claims a boundary it does
 *                not have.
 */

import { installationOrigins } from "./cors-origins";

/** The `wrangler.jsonc` var that names the origin. Empty/absent = unset. */
export const UNTRUSTED_CONTENT_ORIGIN_VAR = "UNTRUSTED_CONTENT_ORIGIN";

/**
 * Registrable domains carrying first-party authenticated Tedix surfaces.
 *
 * These first-party sites also receive credentialed CORS through
 * `./cors-origins.ts`; `installationOrigins` supplies configured origins. A cookie set at
 * any of these sites is sent to every host under it, so a hostname under one
 * is not an isolation boundary.
 */
export const PROTECTED_COOKIE_SITES = ["tedix.dev", "tedix.tech"] as const;

export type UntrustedContentOrigin =
	| { state: "unset" }
	| { state: "configured"; origin: string }
	| { state: "invalid"; reason: string };

export interface UntrustedOriginEnv {
	UNTRUSTED_CONTENT_ORIGIN?: string;
	API_URL?: string;
	OS_URL?: string;
	MCP_UI_URL?: string;
	MCP_URL?: string;
	TEDI_DEV_BASE_URL?: string;
	CORS_ALLOWED_ORIGINS?: string;
}

/**
 * The cookie site a hostname's credentials land on, mirroring
 * `packages/auth/src/web.ts:getParentCookieDomain` with the leading dot
 * stripped. Returns null for loopback names (which get host-only cookies).
 */
function parentCookieSite(hostname: string): string | null {
	const normalized = hostname.toLowerCase();
	if (
		normalized === "localhost" ||
		normalized === "127.0.0.1" ||
		normalized === "::1" ||
		normalized.endsWith(".localhost")
	) {
		return null;
	}
	const parts = normalized.split(".").filter(Boolean);
	if (parts.length < 2) return null;
	return parts.length === 2 ? parts.join(".") : parts.slice(1).join(".");
}

/**
 * Every suffix the untrusted origin must stay out of: the hardcoded
 * first-party sites, plus the exact hostname and derived cookie site of every
 * surface URL this installation configures. A self-hosted install puts its
 * OS on a domain the hardcoded list cannot know, and that domain's
 * cookies are just as fatal.
 *
 * The exact hostname is included on purpose: cookies ignore PORT, so
 * `http://localhost:8788` shares a jar with an API on `http://localhost:8787`.
 */
export function protectedCookieSuffixes(env: UntrustedOriginEnv): Set<string> {
	const suffixes = new Set<string>(PROTECTED_COOKIE_SITES);
	const surfaceOrigins = installationOrigins(env);
	if (env.API_URL) {
		try {
			surfaceOrigins.add(new URL(env.API_URL).origin);
		} catch {
			// A malformed API_URL is not this module's problem to report.
		}
	}
	for (const origin of surfaceOrigins) {
		const { hostname } = new URL(origin);
		suffixes.add(hostname.toLowerCase());
		const site = parentCookieSite(hostname);
		if (site) suffixes.add(site);
	}
	return suffixes;
}

function sharesCookieJar(hostname: string, suffixes: Set<string>): boolean {
	const host = hostname.toLowerCase();
	for (const suffix of suffixes) {
		if (host === suffix || host.endsWith(`.${suffix}`)) return true;
	}
	return false;
}

/**
 * Resolve (and VALIDATE) the configured untrusted-content origin.
 *
 * Validation is the point of this function: a value that shares a cookie jar
 * with an authenticated surface is reported `invalid`, never silently ignored.
 */
export function resolveUntrustedContentOrigin(
	env: UntrustedOriginEnv,
): UntrustedContentOrigin {
	const raw = (env.UNTRUSTED_CONTENT_ORIGIN ?? "").trim();
	if (!raw) return { state: "unset" };

	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return {
			state: "invalid",
			reason: `${UNTRUSTED_CONTENT_ORIGIN_VAR} is not a URL`,
		};
	}
	const hostname = url.hostname.toLowerCase();
	const isLoopback =
		hostname === "localhost" ||
		hostname === "127.0.0.1" ||
		hostname === "[::1]" ||
		hostname === "::1";
	if (url.protocol !== "https:" && !isLoopback) {
		return {
			state: "invalid",
			reason: `${UNTRUSTED_CONTENT_ORIGIN_VAR} must be https (got ${url.protocol.replace(":", "")})`,
		};
	}
	if (url.pathname !== "/" || url.search || url.hash) {
		return {
			state: "invalid",
			reason: `${UNTRUSTED_CONTENT_ORIGIN_VAR} must be a bare origin with no path, query or fragment`,
		};
	}
	if (sharesCookieJar(hostname, protectedCookieSuffixes(env))) {
		return {
			state: "invalid",
			reason: `${UNTRUSTED_CONTENT_ORIGIN_VAR} (${url.origin}) shares a cookie jar with an authenticated Tedix surface, so it is not an isolation boundary`,
		};
	}
	return { state: "configured", origin: url.origin };
}

/**
 * The only paths the untrusted origin serves: the two SIGNED byte routes.
 *
 * Signed-only is load-bearing. Both routes are pure token gates — the URL IS
 * the capability, org-ownership was proven upstream at mint time — so the
 * untrusted origin never reads a session cookie, and the session-authed
 * variants (`GET /artifacts/:tediId/:artifactId`,
 * `GET /skill-runs/:runId/media/*`) stay off it entirely.
 */
export function isUntrustedContentPath(pathname: string): boolean {
	// Segment-shaped, not prefix-shaped. `/artifacts/s/<x>` is THREE segments and
	// matches the SESSION route `/artifacts/:tediId/:artifactId` with
	// tediId="s" — a prefix test would wave a cookie-reading handler onto this
	// origin. Require the exact signed shape and fail closed on anything else.
	const segments = pathname.split("/");
	if (segments[1] === "artifacts") {
		// ["", "artifacts", "s", tediId, artifactId, ...bundle subpath]
		return segments[2] === "s" && Boolean(segments[3]) && Boolean(segments[4]);
	}
	if (segments[1] === "skill-media") {
		// ["", "skill-media", runId, ...path]
		return Boolean(segments[2]) && Boolean(segments[3]);
	}
	return false;
}

/**
 * Every path on the TRUSTED origin that streams agent-authored bytes, i.e.
 * everything the switch moves. Both artifact lanes (signed + session), both
 * skill-media lanes (signed + session).
 *
 * `/os-exports/:outputId/:file` is deliberately absent: its filename regex
 * (`/^rev-(\d+)\.(pdf|png|xlsx|docx|pptx)$/`, worker-app.ts) constrains the
 * response to inert types the browser never renders as a document — the
 * Office three are additionally served `Content-Disposition: attachment` — and
 * `/os-shared/:token` returns JSON. Neither carries an agent-chosen content
 * type.
 */
export function isAgentAuthoredBytePath(pathname: string): boolean {
	return (
		pathname.startsWith("/artifacts/") ||
		pathname.startsWith("/skill-media/") ||
		/^\/skill-runs\/[^/]+\/media\//.test(pathname)
	);
}

/** True when THIS request arrived on the configured untrusted origin. */
export function isUntrustedContentRequest(
	env: UntrustedOriginEnv,
	requestUrl: string,
): boolean {
	const resolution = resolveUntrustedContentOrigin(env);
	if (resolution.state !== "configured") return false;
	try {
		return new URL(requestUrl).origin === resolution.origin;
	} catch {
		return false;
	}
}

/**
 * Base URL a freshly minted signed byte URL must point at.
 *
 * Throws on `invalid` — a mint that quietly hands back a shared-origin URL
 * would be the silent half-migration this whole module exists to prevent.
 */
export function untrustedContentBaseUrl(
	env: UntrustedOriginEnv,
	fallbackBaseUrl: string,
): string {
	const resolution = resolveUntrustedContentOrigin(env);
	if (resolution.state === "invalid") throw new Error(resolution.reason);
	return resolution.state === "configured"
		? resolution.origin
		: fallbackBaseUrl;
}
