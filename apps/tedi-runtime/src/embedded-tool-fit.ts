import type {
	DiscoveryRankingInput,
	DiscoveryRankingOutput,
} from "./brain/platform-client";
import { originalUserText } from "./embedded-transcript";

const CALLABLE = /^([a-z][a-z0-9_]{1,127})\.([a-z][a-z0-9_]{1,127})$/;
const MAX_CANDIDATES = 12;
const MIN_QUERY_CHARS = 10;
const MAX_QUERY_CHARS = 2000;

/** The input allowlist comes from the signed embeddedAssistantCallables projection. */
export function embeddedReadToolCandidates(
	readCallables: readonly string[],
): DiscoveryRankingInput["candidates"] {
	const seen = new Set<string>();
	const candidates: DiscoveryRankingInput["candidates"] = [];
	for (const callable of readCallables) {
		const match = CALLABLE.exec(callable);
		if (!match || seen.has(callable)) continue;
		seen.add(callable);
		candidates.push({
			id: callable,
			kind: "tool",
			// Names are signed and bounded; no page, argument, result, or credential
			// text is copied to the semantic discovery request.
			description: `${match[1]!.replaceAll("_", " ")} ${match[2]!.replaceAll("_", " ")}`,
		});
		if (candidates.length === MAX_CANDIDATES) break;
	}
	return candidates;
}

/**
 * Jev advises which already admitted read might answer the user's question.
 * Browser context follows the versioned first line in the turn text and is
 * deliberately never sent to the ranker. Model output never changes tools.
 */
export async function embeddedToolFitGuidance(input: {
	turnText: string;
	readCallables: readonly string[];
	runId: string;
	rank: (input: DiscoveryRankingInput) => Promise<DiscoveryRankingOutput>;
}): Promise<string> {
	const query = originalUserText(input.turnText)?.trim();
	if (
		!query ||
		query.length < MIN_QUERY_CHARS ||
		query.length > MAX_QUERY_CHARS
	)
		return "";
	const candidates = embeddedReadToolCandidates(input.readCallables);
	if (candidates.length < 2) return "";
	const normalized = query
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
	if (
		candidates.some(
			(candidate) =>
				candidate.id.replace(/[^a-z0-9]+/g, " ") === normalized ||
				candidate.description === normalized,
		)
	)
		return "";
	try {
		const response = await input.rank({
			query,
			candidates,
			runId: input.runId,
		});
		if (response.usagePersistence !== "persisted") return "";
		const ids = response.rankedIds;
		if (
			!ids ||
			ids.length !== candidates.length ||
			new Set(ids).size !== ids.length ||
			ids.some((id) => !candidates.some((candidate) => candidate.id === id))
		)
			return "";
		return `Likely matching admitted read tool: ${ids[0]}. Use it only if its exact parameter schema is available and its result is needed to answer the request. This hint grants no additional authority.`;
	} catch {
		return "";
	}
}
