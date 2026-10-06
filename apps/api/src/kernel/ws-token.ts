/**
 * Scoped, short-lived credentials for authenticated kernel voice clients.
 * The OS session stays behind its same-origin Worker proxy; the browser receives
 * a `kernel:ws` token bound to one organization and user for ten minutes.
 *
 * Format (compact, JWT-adjacent but deliberately 2-segment so it can never be
 * mistaken for a JWT by other validators, and a JWT never parses as one):
 *
 *   base64url(JSON payload) "." base64url(HMAC-SHA256(base64url(payload)))
 *
 * Payload: `{ v: 1, scope: "kernel:ws", organizationId, descopeUserId, exp }`
 * (exp = unix seconds, mint + 10 min).
 *
 * Key derivation — `SHA-256("kernel-ws-token:v1:" + PLATFORM_SERVICE_TOKEN)`.
 * This reuses the platform service token instead of adding a dedicated kernel
 * token secret. Two reasons:
 *   1. `PLATFORM_SERVICE_TOKEN` is already the internal service-auth secret and
 *      is declared in `secrets.required`, so wrangler binds it locally and
 *      deploy validation fails before the Tedix OS voice authentication degrades.
 *   2. The domain-separation prefix isolates usage: possession of a derived
 *      HMAC key (or a signed token) reveals nothing about the raw
 *      PLATFORM_SERVICE_TOKEN, and the raw token can never be replayed as a
 *      kernel WS token (different alphabet entirely — it is never signed).
 *
 * Pure module: no `cloudflare:workers` imports, Web Crypto only — unit-
 * testable under plain vitest. Verification uses `crypto.subtle.verify` with
 * an imported HMAC key (the canonical constant-time comparison in Workers).
 */

import { base64UrlDecode, base64UrlEncode } from "@tedix/auth/utils";

export const KERNEL_WS_TOKEN_VERSION = 1;
export const KERNEL_WS_TOKEN_SCOPE = "kernel:ws";
export const KERNEL_WS_TOKEN_TTL_SECONDS = 10 * 60;

const KEY_DERIVATION_PREFIX = "kernel-ws-token:v1:";

export interface KernelWsTokenPayload {
	v: typeof KERNEL_WS_TOKEN_VERSION;
	scope: typeof KERNEL_WS_TOKEN_SCOPE;
	organizationId: string;
	descopeUserId: string;
	/** Unix seconds. */
	exp: number;
}

const encoder = new TextEncoder();

/**
 * Derive the HMAC key from the platform service token (see module doc for why
 * derivation instead of a dedicated secret). SHA-256 of the domain-prefixed
 * secret → raw HMAC-SHA256 key.
 */
async function deriveHmacKey(
	platformServiceToken: string,
	usages: ("sign" | "verify")[],
): Promise<CryptoKey> {
	if (!platformServiceToken) {
		throw new Error("kernel ws token: signing secret is required");
	}
	const keyMaterial = await crypto.subtle.digest(
		"SHA-256",
		encoder.encode(KEY_DERIVATION_PREFIX + platformServiceToken),
	);
	return crypto.subtle.importKey(
		"raw",
		keyMaterial,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		usages,
	);
}

/**
 * Low-level signer over an arbitrary payload object — exposed so tests can
 * craft validly-signed-but-semantically-wrong tokens (wrong scope/version)
 * and prove `verifyKernelWsToken` rejects them on claims, not just on the
 * signature.
 */
export async function signKernelWsTokenPayload(
	payload: Record<string, unknown>,
	platformServiceToken: string,
): Promise<string> {
	const payloadSegment = base64UrlEncode(
		encoder.encode(JSON.stringify(payload)),
	);
	const key = await deriveHmacKey(platformServiceToken, ["sign"]);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		encoder.encode(payloadSegment),
	);
	return `${payloadSegment}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export interface MintedKernelWsToken {
	token: string;
	/** Unix milliseconds — `Date`-ready for callers. */
	expiresAt: number;
	payload: KernelWsTokenPayload;
}

export async function mintKernelWsToken(input: {
	organizationId: string;
	descopeUserId: string;
	platformServiceToken: string;
	/** Unix milliseconds; defaults to `Date.now()` (injectable for tests). */
	now?: number;
}): Promise<MintedKernelWsToken> {
	const nowMs = input.now ?? Date.now();
	const exp = Math.floor(nowMs / 1000) + KERNEL_WS_TOKEN_TTL_SECONDS;
	const payload: KernelWsTokenPayload = {
		v: KERNEL_WS_TOKEN_VERSION,
		scope: KERNEL_WS_TOKEN_SCOPE,
		organizationId: input.organizationId,
		descopeUserId: input.descopeUserId,
		exp,
	};
	const token = await signKernelWsTokenPayload(
		payload as unknown as Record<string, unknown>,
		input.platformServiceToken,
	);
	return { token, expiresAt: exp * 1000, payload };
}

/**
 * Verify a kernel WS token. Returns the trusted payload, or `null` on ANY
 * failure (malformed shape, bad signature, wrong scope/version, expired) —
 * callers treat `null` as "not a kernel WS token" and fall through to the
 * Descope session JWT path. Never throws on untrusted input.
 *
 * Signature check runs FIRST (constant-time inside `crypto.subtle.verify`),
 * so claim contents are only interpreted once authenticity is established.
 */
export async function verifyKernelWsToken(
	token: string,
	platformServiceToken: string,
	now: number = Date.now(),
): Promise<KernelWsTokenPayload | null> {
	if (!platformServiceToken) return null;
	const segments = token.split(".");
	if (segments.length !== 2) return null;
	const [payloadSegment, signatureSegment] = segments;
	if (!payloadSegment || !signatureSegment) return null;
	const signature = base64UrlDecode(signatureSegment);
	if (!signature) return null;

	let verified = false;
	try {
		const key = await deriveHmacKey(platformServiceToken, ["verify"]);
		verified = await crypto.subtle.verify(
			"HMAC",
			key,
			signature as unknown as BufferSource,
			encoder.encode(payloadSegment),
		);
	} catch {
		return null;
	}
	if (!verified) return null;

	const payloadBytes = base64UrlDecode(payloadSegment);
	if (!payloadBytes) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(payloadBytes));
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const candidate = parsed as Record<string, unknown>;
	if (candidate.v !== KERNEL_WS_TOKEN_VERSION) return null;
	if (candidate.scope !== KERNEL_WS_TOKEN_SCOPE) return null;
	if (
		typeof candidate.organizationId !== "string" ||
		!candidate.organizationId
	) {
		return null;
	}
	if (typeof candidate.descopeUserId !== "string" || !candidate.descopeUserId) {
		return null;
	}
	if (typeof candidate.exp !== "number") return null;
	if (candidate.exp * 1000 <= now) return null;

	return {
		v: KERNEL_WS_TOKEN_VERSION,
		scope: KERNEL_WS_TOKEN_SCOPE,
		organizationId: candidate.organizationId,
		descopeUserId: candidate.descopeUserId,
		exp: candidate.exp,
	};
}
