import { descopeFetch } from "./descope-fetch.ts";

export const DESCOPE_SESSION_COOKIE = "DS";
export const DESCOPE_REFRESH_COOKIE = "DSR";

export const DESCOPE_AUTH_HINT_MAX_AGE_SECONDS = 4 * 7 * 24 * 60 * 60;

export interface CookieOptions {
	domain?: string;
	httpOnly?: boolean;
	maxAge?: number;
	path?: string;
	sameSite?: "Lax" | "Strict" | "None";
	secure?: boolean;
}

export function getParentCookieDomain(
	hostname: string | null | undefined,
): string | undefined {
	if (!hostname) return undefined;
	const normalized = hostname.toLowerCase();
	if (
		normalized === "localhost" ||
		normalized === "127.0.0.1" ||
		normalized === "::1" ||
		normalized.endsWith(".localhost")
	) {
		return undefined;
	}

	const parts = normalized.split(".").filter(Boolean);
	if (parts.length < 2) return undefined;
	const parent =
		parts.length === 2 ? parts.join(".") : parts.slice(1).join(".");
	return `.${parent}`;
}

export function readCookieHeader(
	cookieHeader: string | null | undefined,
	name: string,
): string | null {
	if (!cookieHeader) return null;

	for (const part of cookieHeader.split(";")) {
		const [rawName, ...rawValue] = part.trim().split("=");
		if (rawName !== name) continue;
		const value = rawValue.join("=");
		try {
			return decodeURIComponent(value);
		} catch {
			return value;
		}
	}

	return null;
}

/**
 * Decode a JWT's claims WITHOUT verifying its signature. Routing and UX
 * hints only — every trust decision still verifies the token through
 * Descope or apps/api. Returns null for anything that is not a decodable
 * JWT object payload.
 */
export function decodeUnverifiedJwtClaims(
	token: string | null | undefined,
): Record<string, unknown> | null {
	const payload = token?.split(".")[1];
	if (!payload) return null;
	try {
		const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
		const decoded = JSON.parse(
			atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")),
		) as unknown;
		return decoded !== null && typeof decoded === "object"
			? (decoded as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

export function serializeCookie(
	name: string,
	value: string,
	options: CookieOptions = {},
): string {
	const parts = [`${name}=${encodeURIComponent(value)}`];
	if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
	if (options.domain) parts.push(`Domain=${options.domain}`);
	if (options.path) parts.push(`Path=${options.path}`);
	if (options.httpOnly) parts.push("HttpOnly");
	if (options.secure) parts.push("Secure");
	if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
	return parts.join("; ");
}

export interface SelectDescopeTenantSessionParams {
	baseUrl: string;
	projectId: string;
	refreshToken: string;
	tenantId: string;
	fetch?: typeof fetch;
}

export interface DescopeRefreshSessionParams {
	baseUrl: string;
	projectId: string;
	refreshToken: string;
	fetch?: typeof fetch;
}

export type DescopeLogoutOutcome =
	| "revoked"
	| "already_invalid"
	| "unconfirmed";

export interface SelectedDescopeTenantSession {
	sessionJwt: string;
	refreshJwt?: string;
	/** Max-Age (seconds) Descope attached to its rotated refresh cookie, if any. */
	refreshCookieMaxAge?: number;
}

function descopeCookieRefreshHeaders(
	projectId: string,
	refreshToken: string,
): Record<string, string> {
	return {
		Authorization: `Bearer ${projectId}`,
		"Content-Type": "application/json",
		Cookie: `${DESCOPE_REFRESH_COOKIE}=${encodeURIComponent(refreshToken)}`,
		"x-descope-project-id": projectId,
		"x-descope-refresh-cookie-name": DESCOPE_REFRESH_COOKIE,
	};
}

async function logDescopeSessionRejection(
	operation: "refresh" | "select_tenant",
	response: Response,
): Promise<void> {
	const body = await response
		.clone()
		.json()
		.catch(() => null);
	const errorCode =
		body && typeof body === "object" && "errorCode" in body
			? String(body.errorCode)
			: undefined;
	console.warn(
		JSON.stringify({
			errorCode,
			event: "descope.session_request_rejected",
			operation,
			status: response.status,
		}),
	);
}

/**
 * Server-side Descope tenant selection from a refresh token — the backend
 * mirror of the web SDK's `selectTenant`. Cookie-managed Descope projects send
 * `Authorization: Bearer {projectId}` plus the `DSR` cookie; converting that
 * cookie into a response-body-style bearer is rejected. The selected session
 * JWT contains the requested tenant in `dct` (non-members fail closed).
 *
 * ROTATION: with refresh-token rotation enabled, selection consumes the
 * presented refresh token and issues a replacement. In cookie-managed
 * projects that replacement arrives as a `Set-Cookie: DSR=...` on THIS
 * response (not in the JSON body) — and since this call runs in the Worker,
 * the browser never sees it. The caller MUST forward `refreshJwt` to the
 * browser or the user's next refresh/switch 401s into a full login. We
 * therefore surface the rotated token from the body OR the Set-Cookie.
 *
 * Returns `null` on ANY failure (network, non-2xx, missing sessionJwt) so a
 * caller can fall back to the client-side login-page switch flow instead of
 * surfacing an error page mid-redirect.
 */
export async function selectDescopeTenantSession(
	params: SelectDescopeTenantSessionParams,
): Promise<SelectedDescopeTenantSession | null> {
	const url = `${params.baseUrl.replace(/\/+$/, "")}/v1/auth/tenant/select`;
	try {
		const response = await descopeFetch(
			url,
			{
				body: JSON.stringify({ tenant: params.tenantId }),
				headers: descopeCookieRefreshHeaders(
					params.projectId,
					params.refreshToken,
				),
				method: "POST",
			},
			{ fetch: params.fetch },
		);
		if (!response.ok) {
			await logDescopeSessionRejection("select_tenant", response);
			return null;
		}
		const body = (await response.json()) as {
			sessionJwt?: string;
			refreshJwt?: string;
		};
		if (!body.sessionJwt) return null;
		const rotatedCookie = readRefreshSetCookie(response.headers);
		return {
			refreshCookieMaxAge: rotatedCookie?.maxAge,
			refreshJwt: body.refreshJwt || rotatedCookie?.value || undefined,
			sessionJwt: body.sessionJwt,
		};
	} catch {
		return null;
	}
}

/**
 * Resume the tenant already selected by Descope without accepting tenant
 * authority from the caller. The returned JWT's `dct` is only a routing hint;
 * product/API authorization must still validate the JWT and membership.
 *
 * Like tenant selection, refresh-token rotation can return the successor only
 * through `Set-Cookie`, so callers must forward the surfaced `refreshJwt`.
 */
export async function resumeDescopeSession(
	params: DescopeRefreshSessionParams,
): Promise<SelectedDescopeTenantSession | null> {
	const url = `${params.baseUrl.replace(/\/+$/, "")}/v1/auth/refresh`;
	try {
		const response = await descopeFetch(
			url,
			{
				body: "{}",
				headers: descopeCookieRefreshHeaders(
					params.projectId,
					params.refreshToken,
				),
				method: "POST",
			},
			{ fetch: params.fetch },
		);
		if (!response.ok) {
			await logDescopeSessionRejection("refresh", response);
			return null;
		}
		const body = (await response.json()) as {
			sessionJwt?: string;
			refreshJwt?: string;
		};
		if (!body.sessionJwt) return null;
		const rotatedCookie = readRefreshSetCookie(response.headers);
		return {
			refreshCookieMaxAge: rotatedCookie?.maxAge,
			refreshJwt: body.refreshJwt || rotatedCookie?.value || undefined,
			sessionJwt: body.sessionJwt,
		};
	} catch {
		return null;
	}
}

/**
 * Revoke the current Descope refresh session. A rejected token is already
 * unusable and therefore satisfies logout; network/5xx ambiguity is reported
 * as `unconfirmed` so the broker can audit it while still clearing its local
 * credential chain and browser cookies.
 */
export async function logoutDescopeSession(
	params: DescopeRefreshSessionParams,
): Promise<DescopeLogoutOutcome> {
	const url = `${params.baseUrl.replace(/\/+$/, "")}/v1/auth/logout`;
	try {
		const response = await descopeFetch(
			url,
			{
				body: "{}",
				headers: descopeCookieRefreshHeaders(
					params.projectId,
					params.refreshToken,
				),
				method: "POST",
			},
			{ fetch: params.fetch },
		);
		if (response.ok) return "revoked";
		if (response.status === 401 || response.status === 403) {
			return "already_invalid";
		}
		return "unconfirmed";
	} catch {
		return "unconfirmed";
	}
}

/**
 * Extract the rotated `DSR` refresh token (and its Max-Age) from a Descope
 * response's `Set-Cookie` headers. Uses `Headers.getSetCookie()` where
 * available (workerd, Node 18.14+) and falls back to the joined header.
 */
function readRefreshSetCookie(
	headers: Headers,
): { value: string; maxAge?: number } | undefined {
	const setCookies =
		(headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ??
		(headers.get("set-cookie") ? [headers.get("set-cookie") as string] : []);
	for (const cookie of setCookies) {
		const match = cookie.match(
			new RegExp(`(?:^|,\\s*)${DESCOPE_REFRESH_COOKIE}=([^;,\\s]+)`),
		);
		if (!match?.[1]) continue;
		const value = decodeCookieValue(match[1]);
		if (!value) continue;
		const maxAgeMatch = cookie.match(/Max-Age=(\d+)/i);
		return {
			maxAge: maxAgeMatch ? Number(maxAgeMatch[1]) : undefined,
			value,
		};
	}
	return undefined;
}

function decodeCookieValue(raw: string): string {
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}
