import type { AudioAttachment } from "@tedix/voice/stt";
import type { AdaptiveLearningMode } from "./adaptive-learning";

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
	modelRefOverride?: string;
	/**
	 * Explicit thinking effort for this turn, already checked at the edge against
	 * the chosen model's declared reasoning capability. Absent leaves the effort
	 * to the surface/profile policy.
	 */
	reasoningEffortOverride?: "none" | "low" | "medium" | "high";
}

/** Report selected policy, not a claim that memory was retrieved or used. */
export function resolveChatContext(input: StreamChatTurnInput, runId: string) {
	// Embedded identities are canonical host-scoped sessions. A missing or stale
	// ingress field must never enable the broader organization memory corpus.
	const embedded = input.sessionKey.startsWith("embed:");
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
