/** Allowlisted wire facts only. Never retain prompts, tools, credentials or raw bodies. */
export function modelRequestTelemetry(url: string, body: unknown) {
	try {
		if (typeof body !== "string") return null;
		const value = JSON.parse(body);
		const api = new URL(url).pathname.endsWith("/chat/completions")
			? "chat"
			: new URL(url).pathname.endsWith("/responses")
				? "responses"
				: null;
		if (!api || !value || typeof value !== "object") return null;
		const effort =
			api === "chat" ? value.reasoning_effort : value.reasoning?.effort;
		const max =
			api === "chat"
				? (value.max_completion_tokens ?? value.max_tokens)
				: value.max_output_tokens;
		const promptCacheBreakpointCount = countInstructionBreakpoints(value.input);
		return {
			api,
			reasoningEffort: [
				"none",
				"minimal",
				"low",
				"medium",
				"high",
				"xhigh",
				"max",
			].includes(effort)
				? (effort as string)
				: null,
			maxOutputTokens:
				typeof max === "number" && Number.isSafeInteger(max) && max > 0
					? max
					: null,
			store: typeof value.store === "boolean" ? value.store : null,
			encryptedReasoningIncluded:
				Array.isArray(value.include) &&
				value.include.includes("reasoning.encrypted_content"),
			chatStreamOptionsPresent: Object.hasOwn(value, "stream_options"),
			promptCacheKeyPresent:
				typeof value.prompt_cache_key === "string" &&
				value.prompt_cache_key.length > 0,
			promptCacheMode:
				value.prompt_cache_options?.mode === "explicit"
					? ("explicit" as const)
					: value.prompt_cache_options?.mode === "implicit"
						? ("implicit" as const)
						: null,
			promptCacheBreakpointCount,
			// Wire observation does not establish the provider's applied defaults.
			providerAppliedDefaults: "unobserved" as const,
		};
	} catch {
		return null;
	}
}

/** Count only real provider instruction blocks. Tool schemas and tool results
 * are tenant-controlled and must never satisfy the cache-boundary assertion. */
function countInstructionBreakpoints(input: unknown): number {
	if (!Array.isArray(input)) return 0;
	let count = 0;
	for (const item of input) {
		if (!item || typeof item !== "object") continue;
		if (item.role !== "system" && item.role !== "developer") continue;
		if (!Array.isArray(item.content)) continue;
		for (const part of item.content) {
			const breakpoint =
				part && typeof part === "object" ? part.prompt_cache_breakpoint : null;
			if (
				breakpoint &&
				typeof breakpoint === "object" &&
				breakpoint.mode === "explicit"
			)
				count += 1;
		}
	}
	return count;
}

export type ModelRequestTelemetry = ReturnType<typeof modelRequestTelemetry>;

/** Stateless Responses must remain replayable without provider-side storage. */
export function assertResponsesRequest(wire: ModelRequestTelemetry): void {
	if (
		!wire ||
		wire.api !== "responses" ||
		wire.store !== false ||
		!wire.encryptedReasoningIncluded ||
		wire.chatStreamOptionsPresent
	)
		throw new Error(
			"Model SDK did not serialize the required stateless Responses protocol",
		);
}

/** Reject SDK option loss before billing admission and provider execution. */
export function assertModelRequestSettings(
	wire: ModelRequestTelemetry,
	expected: {
		maxOutputTokens: number;
		reasoningEffort: string | null;
		promptCache?: boolean;
	},
): void {
	assertResponsesRequest(wire);
	if (
		!wire ||
		wire.maxOutputTokens !== expected.maxOutputTokens ||
		wire.reasoningEffort !== expected.reasoningEffort
	) {
		throw new Error(
			"Model SDK did not serialize the selected generation settings",
		);
	}
	if (
		expected.promptCache === true &&
		(!wire.promptCacheKeyPresent ||
			wire.promptCacheMode !== "explicit" ||
			wire.promptCacheBreakpointCount < 1)
	)
		throw new Error(
			"Model SDK did not serialize the tenant-scoped prompt cache boundary",
		);
}
