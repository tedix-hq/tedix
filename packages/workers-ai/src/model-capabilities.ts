export type Claude55Family = "opus" | "sonnet" | "haiku";

export interface Claude55RequestCapabilities {
	family: Claude55Family | null;
	dropSampling: boolean;
	dropThinking: boolean;
	dropManualThinkingBudget: boolean;
	replayThinking: false;
	rewriteForcedToolChoice: boolean;
	strictTools: boolean;
}

/**
 * Claude 5.5 request compatibility. Auto Router uses the strictest profile
 * because its concrete target is unknown until after dispatch.
 */
export function claude55RequestCapabilities(
	modelRef: string,
): Claude55RequestCapabilities | null {
	const normalized = modelRef.trim().toLowerCase().replaceAll(".", "-");
	if (normalized === "cloudflare/auto")
		return {
			family: null,
			dropSampling: true,
			dropThinking: true,
			dropManualThinkingBudget: true,
			replayThinking: false,
			rewriteForcedToolChoice: true,
			strictTools: true,
		};
	const family =
		normalized.match(/claude-(opus|sonnet|haiku)-5-5(?:-|$)/)?.[1] ??
		normalized.match(/claude-5-5-(opus|sonnet|haiku)(?:-|$)/)?.[1];
	if (family !== "opus" && family !== "sonnet" && family !== "haiku")
		return null;
	return {
		family,
		dropSampling: family === "haiku",
		dropThinking: family === "opus",
		dropManualThinkingBudget: family === "haiku",
		replayThinking: false,
		rewriteForcedToolChoice: family !== "haiku",
		strictTools: family !== "haiku",
	};
}
