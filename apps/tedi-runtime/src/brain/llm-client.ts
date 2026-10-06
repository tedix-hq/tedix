/**
 * Injected LLM contract for reflection and compilation. The Agent runtime owns
 * transport, inference authorization, and provider configuration.
 */

export interface LlmChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface LlmChatParams {
	model: string;
	messages: LlmChatMessage[];
	temperature?: number;
	maxCompletionTokens?: number;
	/** Hint that we want a JSON object back. Implementations may ignore this. */
	responseFormatJson?: boolean;
	/** Abort signal forwarded to the underlying transport. */
	signal?: AbortSignal;
}

export interface LlmChatResponse {
	/** The content string of the first choice, or null when the model returned no content. */
	content: string | null;
}

export interface LlmClient {
	chat(params: LlmChatParams): Promise<LlmChatResponse>;
}
