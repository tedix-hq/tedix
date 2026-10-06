/**
 * Authenticated transaction state for Tedix-owned outbound MCP OAuth.
 *
 * The PKCE verifier and tenant binding cross an untrusted browser redirect, so
 * the state value is encrypted and authenticated with a domain-separated key.
 * It is deliberately self-contained and short-lived: authorization codes are
 * single-use at the AS, while Tedix persists no pre-token secret in D1.
 */

import { base64UrlEncode } from "./utils";

export const OUTBOUND_MCP_OAUTH_STATE_VERSION = 1;
export const OUTBOUND_MCP_OAUTH_STATE_TTL_SECONDS = 10 * 60;

const KEY_CONTEXT = "tedix:outbound-mcp-oauth-state:v1";
const IV_LENGTH = 12;
const encoder = new TextEncoder();

export interface OutboundMcpOAuthState {
	v: typeof OUTBOUND_MCP_OAUTH_STATE_VERSION;
	appId: string;
	organizationId: string;
	tenantId: string;
	grantedBy: string;
	expectedIssuer: string;
	issSupported: boolean;
	tokenUrl: string;
	resource: string;
	redirectUrl: string;
	codeVerifier: string;
	scopes: string[];
	exp: number;
}

function base64UrlDecode(value: string): Uint8Array {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid OAuth state");
	const padded = value
		.replace(/-/g, "+")
		.replace(/_/g, "/")
		.padEnd(Math.ceil(value.length / 4) * 4, "=");
	try {
		const binary = atob(padded);
		return Uint8Array.from(binary, (character) => character.charCodeAt(0));
	} catch {
		throw new Error("Invalid OAuth state");
	}
}

async function deriveKey(secret: string): Promise<CryptoKey> {
	if (!secret) throw new Error("OAuth state secret is required");
	const material = await crypto.subtle.digest(
		"SHA-256",
		encoder.encode(`${KEY_CONTEXT}:${secret}`),
	);
	return crypto.subtle.importKey("raw", material, "AES-GCM", false, [
		"encrypt",
		"decrypt",
	]);
}

export function generatePkceVerifier(): string {
	return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

export async function derivePkceS256Challenge(
	verifier: string,
): Promise<string> {
	if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
		throw new Error("Invalid PKCE verifier");
	}
	return base64UrlEncode(
		new Uint8Array(
			await crypto.subtle.digest("SHA-256", encoder.encode(verifier)),
		),
	);
}

export async function buildCimdAuthorizationUrl(params: {
	authorizationUrl: string;
	clientId: string;
	redirectUri: string;
	state: string;
	codeVerifier: string;
	scopes: string[];
	additionalParams?: Array<{ key: string; value: string }>;
}): Promise<string> {
	const url = new URL(params.authorizationUrl);
	for (const entry of params.additionalParams ?? []) {
		url.searchParams.set(entry.key, entry.value);
	}
	url.searchParams.set("client_id", params.clientId);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("redirect_uri", params.redirectUri);
	url.searchParams.set("state", params.state);
	url.searchParams.set(
		"code_challenge",
		await derivePkceS256Challenge(params.codeVerifier),
	);
	url.searchParams.set("code_challenge_method", "S256");
	if (params.scopes.length > 0) {
		url.searchParams.set("scope", params.scopes.join(" "));
	}
	return url.toString();
}

export async function sealOutboundMcpOAuthState(
	state: Omit<OutboundMcpOAuthState, "v" | "exp">,
	secret: string,
	nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
	const key = await deriveKey(secret);
	const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
	const plaintext = encoder.encode(
		JSON.stringify({
			...state,
			v: OUTBOUND_MCP_OAUTH_STATE_VERSION,
			exp: nowSeconds + OUTBOUND_MCP_OAUTH_STATE_TTL_SECONDS,
		}),
	);
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		key,
		plaintext,
	);
	const combined = new Uint8Array(iv.length + ciphertext.byteLength);
	combined.set(iv);
	combined.set(new Uint8Array(ciphertext), iv.length);
	return base64UrlEncode(combined);
}

export async function openOutboundMcpOAuthState(
	encoded: string,
	secret: string,
	nowSeconds = Math.floor(Date.now() / 1000),
): Promise<OutboundMcpOAuthState> {
	try {
		const combined = base64UrlDecode(encoded);
		if (combined.length < IV_LENGTH + 16) throw new Error("short");
		const key = await deriveKey(secret);
		const plaintext = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: combined.slice(0, IV_LENGTH) },
			key,
			combined.slice(IV_LENGTH),
		);
		const state = JSON.parse(
			new TextDecoder().decode(plaintext),
		) as Partial<OutboundMcpOAuthState>;
		if (
			state.v !== OUTBOUND_MCP_OAUTH_STATE_VERSION ||
			typeof state.exp !== "number" ||
			state.exp <= nowSeconds ||
			typeof state.appId !== "string" ||
			typeof state.organizationId !== "string" ||
			typeof state.tenantId !== "string" ||
			typeof state.grantedBy !== "string" ||
			typeof state.expectedIssuer !== "string" ||
			typeof state.issSupported !== "boolean" ||
			typeof state.tokenUrl !== "string" ||
			typeof state.resource !== "string" ||
			typeof state.redirectUrl !== "string" ||
			typeof state.codeVerifier !== "string" ||
			!Array.isArray(state.scopes)
		) {
			throw new Error("claims");
		}
		return state as OutboundMcpOAuthState;
	} catch {
		throw new Error("Invalid or expired OAuth state");
	}
}
