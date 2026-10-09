import type { AudioAttachment } from "@tedix/voice/stt";
import type { AdaptiveLearningMode } from "./adaptive-learning";
import type { InternalEmbeddedQuotaPayload } from "./embedded-turn-quota";
import type { SurfaceTrust, UntrustedTurnChannel } from "./turn-trust";

export type ChatContextPolicy = "conversation" | "session_only";

/** Context selection is independent of model selection and tool authority. */
export function chatContextPolicy(policy?: ChatContextPolicy) {
	return policy === "session_only"
		? {
				cognitiveAddenda: false,
				compactInstructions: true,
				maxOutputTokens: 1_500,
			}
		: {
				cognitiveAddenda: true,
				compactInstructions: false,
				maxOutputTokens: undefined,
			};
}

export interface InternalChatStreamPayload {
	session_key?: string;
	text?: string;
	client_request_id?: string;
	trace_id?: string;
	attachments?: AudioAttachment[];
	learning_mode?: AdaptiveLearningMode;
	tool_argument_constraints?: Record<string, string>;
	tool_namespace_prefix?: string;
	tool_allowed_callables?: string[];
	embedded_session_token?: string;
	model_ref?: string;
	/** Validated at the runtime edge against the tedi's model roster. */
	reasoning_effort?: string;
	context_policy?: ChatContextPolicy;
	/** Set by the runtime edge for embedded turns; see `embedded-turn-quota.ts`. */
	embedded_quota?: InternalEmbeddedQuotaPayload;
}

/** Embedded turn-quota scope and signed ceilings, as `streamChatTurn` carries them. */
export interface EmbeddedTurnQuota {
	origin?: string;
	visitorKey?: string;
	visitorTurnsPerHour?: number;
	originTurnsPerHour?: number;
}

export interface StreamChatTurnInput {
	contextPolicy?: ChatContextPolicy;
	sessionKey: string;
	text: string;
	clientRequestId: string;
	attachments?: AudioAttachment[];
	origin?: "chat" | "voice";
	learningMode?: AdaptiveLearningMode;
	toolArgumentConstraints?: Record<string, string>;
	toolNamespacePrefix?: string;
	toolAllowedCallables?: string[];
	embeddedSessionToken?: string;
	/**
	 * Per-visitor and per-origin hourly ceilings for an embedded turn, from the
	 * signed session claims via the edge. Absent on an embedded session key
	 * still counts the visitor at the platform default.
	 */
	embeddedQuota?: EmbeddedTurnQuota;
	/**
	 * Whether the turn's author is verified. Absent means trusted: the OS
	 * operator WebSocket and service-binding paths authenticate their caller.
	 * An untrusted turn names its channel so the tool allowlist and system
	 * addendum match the surface (`turn-trust.ts`).
	 */
	trust?: SurfaceTrust;
	trustChannel?: UntrustedTurnChannel;
	modelRefOverride?: string;
	/**
	 * Explicit thinking effort for this turn, already checked at the edge against
	 * the chosen model's declared reasoning capability. Absent leaves the effort
	 * to the surface/profile policy.
	 */
	reasoningEffortOverride?: "none" | "low" | "medium" | "high";
}

/** Embedded identities are canonical host-scoped `embed:` sessions. */
export function isEmbeddedSessionKey(sessionKey: string): boolean {
	return sessionKey.startsWith("embed:");
}

/**
 * Trust for a turn posted to `/__internal/chat/stream`. A website visitor is
 * never verified: the signed session proves the host minted it, not who is
 * typing, and no claim on it asserts host-side verification. Every other
 * caller of that route is a service binding and stays trusted.
 */
export function internalChatStreamTrust(
	payload: Pick<
		InternalChatStreamPayload,
		"session_key" | "tool_argument_constraints" | "embedded_session_token"
	>,
	sessionKey: string,
): Pick<StreamChatTurnInput, "trust" | "trustChannel"> {
	return isEmbeddedSessionKey(sessionKey) ||
		payload.tool_argument_constraints !== undefined ||
		payload.embedded_session_token !== undefined
		? { trust: "untrusted", trustChannel: "widget" }
		: {};
}

/** Report selected policy, not a claim that memory was retrieved or used. */
export function resolveChatContext(input: StreamChatTurnInput, runId: string) {
	// Embedded identities are canonical host-scoped sessions. A missing or stale
	// ingress field must never enable the broader organization memory corpus.
	const embedded = isEmbeddedSessionKey(input.sessionKey);
	const selectedPolicy = embedded
		? "session_only"
		: (input.contextPolicy ?? "conversation");
	const policy = chatContextPolicy(selectedPolicy);
	console.log({
		event: "tedi.context.policy",
		runId,
		policy: selectedPolicy,
		cognitiveAddendaEnabled: policy.cognitiveAddenda,
		skipReason: embedded
			? "embedded_session_boundary"
			: policy.cognitiveAddenda
				? null
				: "session_only_policy",
		toolScope: input.toolArgumentConstraints ? "constrained_mcp" : "runtime",
	});
	return policy;
}
