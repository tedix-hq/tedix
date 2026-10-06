const SERVICE_BINDING_HEADER = "X-Service-Binding";

/**
 * Detect a trusted Worker-to-Worker service-binding call.
 *
 * Trust comes from the transport, not from the header alone. Every receiver
 * exports a named `InternalEntrypoint` that only service bindings can reach
 * (callers bind with `"entrypoint": "InternalEntrypoint"`), and its public
 * `fetch` removes this marker with `stripServiceBindingMarker()` before any
 * handler reads it. The caller still stamps the marker per call, so public
 * traffic a proxy forwards over the same binding stays untrusted.
 */
export function isServiceBinding(headers: Headers): boolean {
	return headers.get(SERVICE_BINDING_HEADER) === "true";
}

/**
 * Public ingress: drop the service-binding marker so no internet caller can
 * claim binding trust. Every Worker's default `fetch` must run this.
 */
export function stripServiceBindingMarker(request: Request): Request {
	if (!request.headers.has(SERVICE_BINDING_HEADER)) return request;
	const headers = new Headers(request.headers);
	headers.delete(SERVICE_BINDING_HEADER);
	return new Request(request, { headers });
}

/** Gateway-attested operator consent on internal tedi dispatches. */
export const OPERATOR_CONSENT_HEADER = "X-Tedix-Operator-Consent";
/** Platform-only caller marker, stamped exclusively by the tedi edge. */
export const PLATFORM_CALLER_HEADER = "X-Tedix-Platform-Caller";
/** The one marker value the tedi edge stamps. */
export const PLATFORM_CALLER_TEDI_EDGE = "tedi-edge";

/**
 * Remove untrusted inbound consent markers before forwarding a tedi request.
 * Only an internal service-binding request with consent receives the edge mark.
 */
export function applyOperatorConsentHeaderHygiene(
	headers: Headers,
	isServiceBindingRequest: boolean,
): void {
	headers.delete(PLATFORM_CALLER_HEADER);
	if (!isServiceBindingRequest) {
		headers.delete(OPERATOR_CONSENT_HEADER);
		return;
	}
	if (headers.has(OPERATOR_CONSENT_HEADER)) {
		headers.set(PLATFORM_CALLER_HEADER, PLATFORM_CALLER_TEDI_EDGE);
	}
}

/**
 * Internal-trust markers: headers a trusted downstream (`apps/api` `withAuth`,
 * `apps/tedi-runtime`, `apps/mcp`) reads as caller IDENTITY, AUTHORITY, TENANCY,
 * PROVENANCE, or ROUTING. Every one is legitimately stamped ONLY by trusted
 * internal code on a Worker-to-Worker service-binding hop; no browser or public
 * client ever supplies one.
 *
 * A public-facing proxy that copies inbound headers verbatim must delete every
 * one of these before forwarding to a trusted downstream: a proxy that holds an
 * internal binding would otherwise relay a browser-supplied identity header to
 * a receiver that trusts it. This is the same class of defect as the fixed
 * `X-Tedix-Tenant-Id` cross-tenant override.
 *
 * Header names match case-insensitively (Web `Headers`), so each entry also
 * removes its lowercase form. Client-legit `X-Tedix-*` headers (theme, debug,
 * browser-bridge, trace, and the `X-Tedix-Webmcp-Invocation` telemetry
 * correlation id — metadata that grants nothing and must survive the strip)
 * are deliberately NOT listed.
 */
export const INTERNAL_TRUST_HEADERS: readonly string[] = [
	// Master transport-trust flag: the switch that turns the whole set into authority.
	SERVICE_BINDING_HEADER,
	OPERATOR_CONSENT_HEADER,
	PLATFORM_CALLER_HEADER,
	// Tenancy / organization selection.
	"X-Tedix-Tenant-Id",
	"X-Tedix-Org-Id",
	"X-Tedix-Organization-Id",
	// Caller identity / authority — read by apps/api `withAuth` as an authority grant.
	"X-Tedix-Caller",
	"X-Tedix-Caller-Type",
	"X-Tedix-Tedi-Id",
	"X-Tedix-Tedi-Scopes",
	"X-Tedix-Acting-User",
	"X-Tedix-End-User-Id",
	"X-Tedix-Actor-Id",
	"X-Tedix-Actor-Type",
	"X-Tedix-Kernel",
	"X-Tedix-Delegated-Scope",
	"X-Tedix-Agent-Session-Id",
	// Connection / credential selection.
	"X-Tedix-Connection-Label",
	// Routing trust (only ever honored on the internal binding).
	"X-Tedix-Host",
	"X-Tedix-Public-Host",
	// Runtime / edge authority.
	"X-Tedix-Can-Manage-Durable-Code",
	"X-Tedix-Admin-Token",
	"X-Tedix-CMS-Internal-Auth",
];

/**
 * Whole header FAMILIES that are internal-only derived-trust channels. Any
 * header under one of these prefixes is stripped, so a new marker added to the
 * channel later is covered without editing the list above.
 */
const INTERNAL_TRUST_HEADER_PREFIXES: readonly string[] = [
	// apps/mcp derived auth context (x-tedix-auth-type/-user-id/-scopes/…).
	"x-tedix-auth-",
	// External-agent session identity (…-principal-id/-session-id/-client-record-id).
	"x-tedix-external-agent-",
];

/**
 * Remove every client-suppliable internal-trust marker before forwarding a
 * public/external request to a trusted downstream. Generalizes
 * `applyOperatorConsentHeaderHygiene` to the full deny-list.
 *
 * Runs the strip ONLY on external ingress. Trusted internal code stamps these
 * markers on its own outbound service-binding hops AFTER the inbound strip, so a
 * genuine service-binding request (`isServiceBindingRequest === true`) is left
 * untouched — stripping there would erase legitimate identity. The strip must
 * therefore happen on the INBOUND external request, never on the
 * internally-stamped outbound one.
 */
export function applyInboundTrustHeaderHygiene(
	headers: Headers,
	isServiceBindingRequest: boolean,
): void {
	if (isServiceBindingRequest) return;
	for (const name of INTERNAL_TRUST_HEADERS) headers.delete(name);
	// Snapshot names before mutating: deleting during iteration is unsafe.
	for (const name of [...headers.keys()]) {
		const lower = name.toLowerCase();
		if (
			INTERNAL_TRUST_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))
		) {
			headers.delete(name);
		}
	}
}

/** Parse a case-insensitive `Bearer` Authorization value. */
export function extractBearerToken(
	header: string | null | undefined,
): string | null {
	if (!header) return null;
	// `\s+` then `\S` gives one unambiguous split, keeping the match linear.
	const match = /^Bearer\s+(\S.*)$/i.exec(header);
	return match?.[1]?.trim() || null;
}

function subprotocolParts(header: string | null | undefined): string[] {
	return (header ?? "")
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
}

/**
 * Read a bearer token from `Sec-WebSocket-Protocol`. Browsers offer a single
 * `bearer-<token>` protocol; curl/ACP callers send the `bearer, <token>` pair.
 */
export function extractWebSocketBearerToken(
	header: string | null | undefined,
): string | null {
	const parts = subprotocolParts(header);
	const bearerProtocol = parts.find((part) => part.startsWith("bearer-"));
	if (bearerProtocol) return bearerProtocol.slice("bearer-".length);
	const bearerIdx = parts.indexOf("bearer");
	return (bearerIdx >= 0 ? parts[bearerIdx + 1] : undefined) ?? null;
}

/**
 * The single subprotocol to echo on the 101 upgrade. A browser closes the
 * socket unless the server echoes exactly one offered protocol verbatim: the
 * `bearer-<token>` string itself, or the literal `bearer` marker for the pair
 * shape. Null when no bearer protocol was offered.
 */
export function pickEchoableSubprotocol(
	header: string | null | undefined,
): string | null {
	const parts = subprotocolParts(header);
	const bearerProtocol = parts.find((part) => part.startsWith("bearer-"));
	if (bearerProtocol) return bearerProtocol;
	return parts.includes("bearer") ? "bearer" : null;
}

/**
 * Compare non-empty secrets without leaking their length or matching prefix.
 * Both values are first reduced to fixed-size SHA-256 digests, then compared
 * with Cloudflare Workers' timing-safe Web Crypto extension.
 */
export async function secureEqual(
	provided: string | null | undefined,
	expected: string | null | undefined,
): Promise<boolean> {
	if (!provided || !expected) return false;
	const encoder = new TextEncoder();
	const [providedHash, expectedHash] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(provided)),
		crypto.subtle.digest("SHA-256", encoder.encode(expected)),
	]);
	const subtle = crypto.subtle as SubtleCrypto & {
		timingSafeEqual?(left: BufferSource, right: BufferSource): boolean;
	};
	if (typeof subtle.timingSafeEqual === "function") {
		return subtle.timingSafeEqual(providedHash, expectedHash);
	}

	// Node's Web Crypto does not implement the Workers extension. The values are
	// fixed-size digests, so keep tests and non-Worker tooling fail-closed with a
	// full-buffer comparison rather than falling back to string equality.
	const left = new Uint8Array(providedHash);
	const right = new Uint8Array(expectedHash);
	let mismatch = 0;
	for (let index = 0; index < left.length; index++) {
		mismatch |= left[index]! ^ right[index]!;
	}
	return mismatch === 0;
}
