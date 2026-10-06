import {
	assertSessionBrokerRedirectPath,
	assertSessionBrokerTargetOrigin,
	type SessionBrokerOperation,
	type SessionBrokerRpc,
	type SessionBrokerSurface,
} from "./session-broker";
import { base64UrlDecode, base64UrlEncode } from "./utils";

interface ProductSessionCorrelation {
	expiresAt: number;
	intentId: string;
	operation: SessionBrokerOperation;
	redirectPath: string;
	state: string;
	targetOrigin: string;
	tenantId: string | null;
	version: 1;
}

export interface ProductSessionBrokerOptions {
	broker: SessionBrokerRpc;
	correlationCookie: `__Host-${string}`;
	failureRedirectPath?: string;
	/** Exact OS origin from the installation manifest, when independently hosted. */
	installationOsOrigin?: string;
	productCookie: `__Host-${string}`;
	requireSameOriginStart?: boolean;
	surface: SessionBrokerSurface;
}

export interface StartProductSessionBrokerInput extends ProductSessionBrokerOptions {
	operation: SessionBrokerOperation;
	redirectPath: string;
	request: Request;
	tenantId: string | null;
}

export interface FinishProductSessionBrokerInput extends ProductSessionBrokerOptions {
	request: Request;
}

// Correlation must survive the broker's one bounded interactive login pause.
// It is host-only, HttpOnly, state-bound, and still expires with the intent.
const CORRELATION_MAX_AGE_SECONDS = 10 * 60;

function randomState(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return base64UrlEncode(bytes);
}

async function stateHash(state: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(state),
	);
	return `sha256-${base64UrlEncode(new Uint8Array(digest))}`;
}

function readCookieValues(cookieHeader: string | null, name: string): string[] {
	if (!cookieHeader) return [];
	const values = cookieHeader
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part.startsWith(`${name}=`))
		.map((part) => {
			const encoded = part.slice(name.length + 1);
			try {
				return decodeURIComponent(encoded);
			} catch {
				return encoded;
			}
		});
	return values;
}

/**
 * Resolve exactly one host-only product session. A missing, empty, or repeated
 * cookie fails closed; generic Descope cookies are never product credentials.
 */
export function resolveProductSession(
	cookieHeader: string | null,
	productCookie: string,
): string | null {
	const productSessions = readCookieValues(cookieHeader, productCookie);
	if (productSessions.length !== 1 || !productSessions[0]) return null;
	return productSessions[0];
}

/**
 * Translate the selected host-only product session into the canonical DS name
 * only inside a Worker request. Browser JavaScript never receives the token,
 * and client-supplied generic/product duplicates are removed before forwarding.
 */
export function canonicalizeProductSessionCookieHeader(
	cookieHeader: string | null,
	productCookie: string,
): string | null {
	const session = resolveProductSession(cookieHeader, productCookie);
	if (!session) return null;
	const retained = (cookieHeader ?? "")
		.split(";")
		.map((part) => part.trim())
		.filter(Boolean)
		.filter((part) => {
			const name = part.split("=", 1)[0];
			return name !== "DS" && name !== productCookie;
		});
	retained.push(`DS=${encodeURIComponent(session)}`);
	return retained.join("; ");
}

function serializeCorrelation(correlation: ProductSessionCorrelation): string {
	return base64UrlEncode(new TextEncoder().encode(JSON.stringify(correlation)));
}

function parseCorrelation(
	cookieHeader: string | null,
	name: string,
	now = Math.floor(Date.now() / 1000),
): ProductSessionCorrelation | null {
	const values = readCookieValues(cookieHeader, name);
	if (values.length !== 1) return null;
	const bytes = base64UrlDecode(values[0]!);
	if (!bytes) return null;
	try {
		const value = JSON.parse(
			new TextDecoder().decode(bytes),
		) as Partial<ProductSessionCorrelation>;
		if (
			value.version !== 1 ||
			typeof value.intentId !== "string" ||
			value.intentId.length < 22 ||
			typeof value.state !== "string" ||
			value.state.length < 22 ||
			(value.operation !== "issue_session" &&
				value.operation !== "resume_session" &&
				value.operation !== "logout") ||
			typeof value.redirectPath !== "string" ||
			typeof value.targetOrigin !== "string" ||
			(value.tenantId !== null && typeof value.tenantId !== "string") ||
			typeof value.expiresAt !== "number" ||
			!Number.isInteger(value.expiresAt) ||
			value.expiresAt <= now
		) {
			return null;
		}
		return value as ProductSessionCorrelation;
	} catch {
		return null;
	}
}

function secureCookie(name: string, value: string, maxAge: number): string {
	return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${Math.max(0, Math.floor(maxAge))}; Secure; HttpOnly; SameSite=Lax`;
}

function expireCookie(name: string): string {
	return `${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=Lax`;
}

function redirectResponse(location: string, headers = new Headers()): Response {
	headers.set("Location", location);
	headers.set("Cache-Control", "no-store");
	headers.set("Referrer-Policy", "no-referrer");
	headers.set("X-Content-Type-Options", "nosniff");
	return new Response(null, { status: 302, headers });
}

function headerHasOrigin(
	value: string | null,
	expectedOrigin: string,
): boolean {
	if (!value) return false;
	try {
		return new URL(value).origin === expectedOrigin;
	} catch {
		return false;
	}
}

export async function startProductSessionBroker(
	input: StartProductSessionBrokerInput,
): Promise<Response> {
	if (
		input.request.method !== "GET" &&
		input.request.method !== "HEAD" &&
		input.request.method !== "POST"
	) {
		return new Response("Method Not Allowed\n", {
			status: 405,
			headers: { Allow: "GET, HEAD, POST", "Cache-Control": "no-store" },
		});
	}
	if (input.requireSameOriginStart) {
		const requestOrigin = new URL(input.request.url).origin;
		const fetchSite = input.request.headers.get("Sec-Fetch-Site");
		const origin = input.request.headers.get("Origin");
		const referer = input.request.headers.get("Referer");
		const originValid = origin === null || origin === requestOrigin;
		const refererValid =
			referer === null || headerHasOrigin(referer, requestOrigin);
		const sameOriginProvenance =
			fetchSite === "same-origin" ||
			fetchSite === "none" ||
			origin === requestOrigin ||
			headerHasOrigin(referer, requestOrigin);
		if (!originValid || !refererValid || !sameOriginProvenance) {
			return new Response("Forbidden\n", {
				status: 403,
				headers: { "Cache-Control": "no-store" },
			});
		}
	}
	const targetOrigin = assertSessionBrokerTargetOrigin(
		input.surface,
		new URL(input.request.url).origin,
		input.installationOsOrigin,
	);
	const redirectPath = assertSessionBrokerRedirectPath(
		input.redirectPath,
		targetOrigin,
	);
	const state = randomState();
	const result = await input.broker.createIntent({
		operation: input.operation,
		redirectPath,
		stateHash: await stateHash(state),
		targetOrigin,
		tenantId: input.tenantId,
	});
	const correlation: ProductSessionCorrelation = {
		expiresAt: result.expiresAt,
		intentId: result.intentId,
		operation: input.operation,
		redirectPath,
		state,
		targetOrigin,
		tenantId: input.tenantId,
		version: 1,
	};
	const headers = new Headers();
	headers.append(
		"Set-Cookie",
		secureCookie(
			input.correlationCookie,
			serializeCorrelation(correlation),
			Math.min(
				CORRELATION_MAX_AGE_SECONDS,
				Math.max(1, result.expiresAt - Math.floor(Date.now() / 1000)),
			),
		),
	);
	if (input.operation === "logout") {
		headers.append("Set-Cookie", expireCookie(input.productCookie));
	}
	const response = redirectResponse(result.authorizeUrl, headers);
	// A freshly authenticated product sends its Descope token pair in a
	// same-origin form POST. Preserve that body only across the fixed broker
	// redirect so the configured broker auth host can adopt the new refresh family without a
	// second login or a rotation attempt against an already-consumed DSR.
	if (input.request.method === "POST") {
		return new Response(null, { status: 307, headers: response.headers });
	}
	return response;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

/**
 * Same-origin bounce document in front of the start verb.
 *
 * `startProductSessionBroker` accepts only same-origin provenance. A signed-out
 * human arriving from another site (Slack, email, a search result) carries
 * cross-site `Sec-Fetch-Site` and a foreign `Referer`, and a 302 from the
 * product Worker preserves both — so redirecting that navigation straight to
 * `start` ends in a bare 403. This document is the fix that keeps the gate
 * intact: it is served on the product origin and immediately navigates itself
 * to `start`, so the request the broker sees was issued BY a same-origin
 * document and its provenance headers are real evidence, not an exemption.
 *
 * It carries only an already-validated relative `redirect_to`. It never relays
 * `operation`, a tenant selection, or a POST body — the inputs the same-origin
 * gate exists to protect — so a cross-site link to this document can do no
 * more than a cross-site link to any product page already could: ask the
 * visitor's own auth-host session for that page. No script is required; meta
 * refresh is a document-initiated navigation and needs no CSP allowance.
 */
export function continueProductSessionBroker(input: {
	installationOsOrigin?: string;
	redirectPath: string;
	request: Request;
	startPath: string;
	surface: SessionBrokerSurface;
}): Response {
	if (input.request.method !== "GET" && input.request.method !== "HEAD") {
		return new Response("Method Not Allowed\n", {
			status: 405,
			headers: { Allow: "GET, HEAD", "Cache-Control": "no-store" },
		});
	}
	const targetOrigin = assertSessionBrokerTargetOrigin(
		input.surface,
		new URL(input.request.url).origin,
		input.installationOsOrigin,
	);
	const redirectPath = assertSessionBrokerRedirectPath(
		input.redirectPath,
		targetOrigin,
	);
	const start = new URL(input.startPath, targetOrigin);
	start.searchParams.set("redirect_to", redirectPath);
	const href = escapeHtml(`${start.pathname}${start.search}`);
	const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta http-equiv="refresh" content="0; url=${href}">
<title>Signing in to Tedix</title>
</head>
<body>
<p>Signing in&hellip; <a href="${href}">Continue</a> if you are not redirected.</p>
</body>
</html>
`;
	return new Response(input.request.method === "HEAD" ? null : body, {
		status: 200,
		headers: {
			"Cache-Control": "no-store",
			"Content-Type": "text/html; charset=utf-8",
			"Referrer-Policy": "same-origin",
		},
	});
}

function callbackFailure(
	correlationCookie: string,
	productCookie: string,
	correlation: ProductSessionCorrelation | null,
	error: string,
	failureRedirectPath: string | undefined,
	requestOrigin: string,
): Response {
	// Failed exchanges return to the fixed product recovery surface rather than
	// a deep link that could immediately trigger another broker resume.
	const location = new URL(
		failureRedirectPath ?? "/login",
		correlation?.targetOrigin ?? requestOrigin,
	);
	location.searchParams.set("error", error);
	const headers = new Headers();
	headers.append("Set-Cookie", expireCookie(correlationCookie));
	// Any failed exchange leaves the browser's prior product session suspect.
	// Clear it so reload/login recovery cannot loop on a stale credential.
	headers.append("Set-Cookie", expireCookie(productCookie));
	return redirectResponse(`${location.pathname}${location.search}`, headers);
}

export async function finishProductSessionBroker(
	input: FinishProductSessionBrokerInput,
): Promise<Response> {
	if (input.request.method !== "GET" && input.request.method !== "HEAD") {
		return new Response("Method Not Allowed\n", {
			status: 405,
			headers: { Allow: "GET, HEAD", "Cache-Control": "no-store" },
		});
	}
	const url = new URL(input.request.url);
	const correlation = parseCorrelation(
		input.request.headers.get("Cookie"),
		input.correlationCookie,
	);
	if (!correlation || correlation.targetOrigin !== url.origin) {
		return callbackFailure(
			input.correlationCookie,
			input.productCookie,
			correlation,
			"invalid_request",
			input.failureRedirectPath,
			url.origin,
		);
	}
	try {
		assertSessionBrokerTargetOrigin(
			input.surface,
			correlation.targetOrigin,
			input.installationOsOrigin,
		);
		assertSessionBrokerRedirectPath(
			correlation.redirectPath,
			correlation.targetOrigin,
		);
	} catch {
		return callbackFailure(
			input.correlationCookie,
			input.productCookie,
			null,
			"invalid_request",
			input.failureRedirectPath,
			url.origin,
		);
	}
	const brokerError = url.searchParams.get("error");
	if (brokerError) {
		return callbackFailure(
			input.correlationCookie,
			input.productCookie,
			correlation,
			brokerError,
			input.failureRedirectPath,
			url.origin,
		);
	}
	const intentId = url.searchParams.get("intent");
	const code = url.searchParams.get("code");
	if (!intentId || !code || intentId !== correlation.intentId) {
		return callbackFailure(
			input.correlationCookie,
			input.productCookie,
			correlation,
			"invalid_request",
			input.failureRedirectPath,
			url.origin,
		);
	}
	try {
		const result = await input.broker.exchangeCode({
			code,
			intentId,
			stateHash: await stateHash(correlation.state),
			targetOrigin: correlation.targetOrigin,
			tenantId: correlation.tenantId,
		});
		const headers = new Headers();
		headers.append("Set-Cookie", expireCookie(input.correlationCookie));
		if (correlation.operation === "logout") {
			if (result.kind !== "logout")
				throw new Error("Unexpected session result");
			headers.append("Set-Cookie", expireCookie(input.productCookie));
		} else {
			if (result.kind !== "session")
				throw new Error("Unexpected logout result");
			if (
				correlation.operation === "issue_session" &&
				result.tenantId !== correlation.tenantId
			) {
				throw new Error("Broker tenant mismatch");
			}
			headers.append(
				"Set-Cookie",
				secureCookie(
					input.productCookie,
					result.sessionJwt,
					Math.max(1, result.expiresAt - Math.floor(Date.now() / 1000)),
				),
			);
		}
		return redirectResponse(correlation.redirectPath, headers);
	} catch {
		return callbackFailure(
			input.correlationCookie,
			input.productCookie,
			correlation,
			"session_unavailable",
			input.failureRedirectPath,
			url.origin,
		);
	}
}
