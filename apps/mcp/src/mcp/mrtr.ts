/**
 * Synchronous MRTR (Multi-Round Tool Resolution) for AGENT callers.
 *
 * The 2026-07-28 `resultType: "input_required"` shape lets a server pause a
 * `tools/call`, hand the calling AGENT (kernel / another tedi) a structured
 * `inputRequests` entry plus an opaque `requestState`, and resume on the retry
 * once the agent fills the request and echoes the state back. Unlike
 * `elicitInput()` (a server→client request that the STATELESS transport cannot
 * deliver — `send()` drops standalone server requests), sync-MRTR rides the
 * normal request/response round-trip, so it works for agent-to-agent flows.
 *
 * This module owns:
 *  - integrity-tagging `requestState` via the SDK's `createRequestStateCodec`
 *    (HMAC-SHA256, versioned envelope, built-in expiry) so the resume cannot
 *    be forged or replayed across tools/orgs — the state gates the destructive
 *    approval, so it MUST be authenticated. Tool/org binding is checked here
 *    after decode, not via the codec's `bind` option;
 *  - the `_meta` marker (`tedix/inputRequired`) that the index.ts
 *    `resultTransform` rewrites into a protocol-native `resultType:
 *    "input_required"` result (mirroring the genericTask rewrite). transport.ts
 *    is intentionally not touched.
 */

import {
	createRequestStateCodec,
	type RequestStateCodec,
	type ServerContext as SdkServerContext,
} from "@modelcontextprotocol/server";

/** `_meta` marker a tool result sets to request a sync-MRTR input round. */
export const INPUT_REQUIRED_META_KEY = "tedix/inputRequired" as const;
/** `_meta` key the calling agent echoes its input responses + state under. */
export const INPUT_RESPONSES_META_KEY = "tedix/inputResponses" as const;

/** Max age a signed requestState stays resolvable (5 minutes). */
const REQUEST_STATE_TTL_SECONDS = 300;

/**
 * The HMAC key falls back to a stable per-process value when no platform secret
 * is wired (tests / local). Production always has PLATFORM_SERVICE_TOKEN. Must
 * stay >=32 bytes — the SDK codec rejects shorter keys at construction.
 */
const FALLBACK_SIGNING_KEY = "tedix-mrtr-unsigned-dev-fallback-key";

interface RequestStatePayload {
	/** Tool the approval gates — binds the state to one tool. */
	toolId: string;
	/** Org boundary the state is valid in. */
	org: string;
	/** Canonical human subject. Omitted for machine callers and legacy states. */
	user?: string;
}

/**
 * The codec requires >=32 key bytes. HMAC zero-pads short keys internally, so
 * NUL-padding a short PLATFORM_SERVICE_TOKEN to the floor is deterministic
 * across instances and MAC-equivalent — it only satisfies the length guard.
 */
function toKeyBytes(signingKey: string): Uint8Array {
	const bytes = new TextEncoder().encode(signingKey);
	if (bytes.byteLength >= 32) return bytes;
	const padded = new Uint8Array(32);
	padded.set(bytes);
	return padded;
}

const codecCache = new Map<string, RequestStateCodec<RequestStatePayload>>();

function codecFor(signingKey: string): RequestStateCodec<RequestStatePayload> {
	let codec = codecCache.get(signingKey);
	if (!codec) {
		codec = createRequestStateCodec<RequestStatePayload>({
			key: toKeyBytes(signingKey),
			ttlSeconds: REQUEST_STATE_TTL_SECONDS,
		});
		codecCache.set(signingKey, codec);
	}
	return codec;
}

/** SDK codec throw codes → the reason vocabulary governance audit events use. */
const CODEC_FAILURE_REASONS: Record<string, string> = {
	malformed: "malformed_request_state",
	mac: "signature_mismatch",
	expired: "expired",
	bind: "bind_mismatch",
};

/**
 * Resolve the HMAC signing key from env, with a dev/test fallback.
 *
 * Fails closed in production: the fallback is a source-committed constant, so
 * accepting it there would let any caller mint a valid destructive-approval
 * token. A missing secret must be a deploy-time error, never a silent
 * downgrade (env.production secrets.required lists PLATFORM_SERVICE_TOKEN).
 */
export function resolveRequestStateKey(
	env: { PLATFORM_SERVICE_TOKEN?: string; ENVIRONMENT?: string } | undefined,
): string {
	const token = env?.PLATFORM_SERVICE_TOKEN;
	if (typeof token === "string" && token.length > 0) return token;
	if (env?.ENVIRONMENT === "production") {
		throw new Error(
			"PLATFORM_SERVICE_TOKEN is required in production: refusing to sign destructive-approval requestState with the dev fallback key",
		);
	}
	return FALLBACK_SIGNING_KEY;
}

/**
 * Mint an opaque, integrity-tagged `requestState` for a destructive-approval
 * round. The agent must echo it verbatim on the retry.
 */
export async function signRequestState(input: {
	toolId: string;
	organizationId: string;
	subjectUserId?: string;
	signingKey: string;
}): Promise<string> {
	return codecFor(input.signingKey).mint({
		toolId: input.toolId,
		org: input.organizationId,
		...(input.subjectUserId ? { user: input.subjectUserId } : {}),
	});
}

export type VerifyRequestStateResult =
	| { ok: true; payload: RequestStatePayload }
	| { ok: false; reason: string };

/**
 * Verify a `requestState` echoed back on retry. Rejects forged signatures,
 * wrong tool/org bindings, malformed tokens, and expired states.
 */
export async function verifyRequestState(input: {
	requestState: unknown;
	toolId: string;
	organizationId: string;
	subjectUserId?: string;
	signingKey: string;
}): Promise<VerifyRequestStateResult> {
	if (typeof input.requestState !== "string" || !input.requestState) {
		return { ok: false, reason: "missing_request_state" };
	}
	let payload: RequestStatePayload;
	try {
		// ctx is only consulted by the codec's optional `bind`, which this
		// codec does not configure — tool/org binding is compared below.
		payload = await codecFor(input.signingKey).verify(
			input.requestState,
			undefined as unknown as SdkServerContext,
		);
	} catch (error) {
		const code = error instanceof Error ? error.message : "";
		return {
			ok: false,
			reason: CODEC_FAILURE_REASONS[code] ?? "verification_failed",
		};
	}
	if (payload === null || typeof payload !== "object") {
		return { ok: false, reason: "malformed_payload" };
	}
	if (payload.toolId !== input.toolId) {
		return { ok: false, reason: "tool_mismatch" };
	}
	if (payload.org !== input.organizationId) {
		return { ok: false, reason: "org_mismatch" };
	}
	if (payload.user !== undefined && payload.user !== input.subjectUserId) {
		return { ok: false, reason: "user_mismatch" };
	}
	return { ok: true, payload };
}

/**
 * The `elicitation/create`-shaped input request a destructive approval round
 * asks the calling agent to fulfil. Shared by the result marker and the
 * `input_required` rewrite.
 */
export function buildApprovalInputRequest(displayName: string): {
	method: "elicitation/create";
	params: Record<string, unknown>;
} {
	return {
		method: "elicitation/create",
		params: {
			mode: "form",
			message: `Approve the destructive action "${displayName}" by providing a reason, then retry the call with your input responses and the requestState.`,
			requestedSchema: {
				type: "object",
				properties: {
					reason: {
						type: "string",
						title: "Reason",
						description: "Why are you performing this action?",
					},
				},
				required: ["reason"],
			},
		},
	};
}
