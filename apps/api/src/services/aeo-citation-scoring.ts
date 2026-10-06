/**
 * AEO citation-detection and scoring.
 *
 * Pure, provider-agnostic grading of an LLM response's raw text against a
 * target brand (and optional competitor brands). Deliberately exact-text
 * matching (case-insensitive substring), not model self-report — the same
 * grading principle Cloudflare's AEO measurement post describes
 * (blog.cloudflare.com/aeo/): grade what the model actually
 * wrote, not what it claims it would say.
 *
 * Kept dependency-free and side-effect-free so it is unit-testable without a
 * live model call.
 */

export interface BrandMentionResult {
	name: string;
	mentioned: boolean;
	/** Character offset of the first exact-text mention, or null when not mentioned. */
	position: number | null;
	/**
	 * 0..1, where 1 means the mention occurred at the very start of the
	 * response and 0 means it occurred at the very end. Null when not
	 * mentioned. A response mentioning the brand early scores more
	 * "prominent" than one mentioning it in passing near the end.
	 */
	prominence: number | null;
}

/** Find the first exact-text (case-insensitive) mention of `brand` in `responseText`. */
export function detectBrandMention(
	responseText: string,
	brand: string,
): BrandMentionResult {
	const name = brand.trim();
	if (!name || !responseText) {
		return { name, mentioned: false, position: null, prominence: null };
	}
	const position = responseText.toLowerCase().indexOf(name.toLowerCase());
	if (position === -1) {
		return { name, mentioned: false, position: null, prominence: null };
	}
	const prominence =
		responseText.length > 0
			? Math.max(0, Math.min(1, 1 - position / responseText.length))
			: null;
	return { name, mentioned: true, position, prominence };
}

export interface AeoQueryScore {
	query: string;
	responseText: string;
	target: BrandMentionResult;
	competitors: BrandMentionResult[];
}

/** Grade a single query/response pair against the target brand and any competitor brands. */
export function scoreAeoQuery(
	query: string,
	responseText: string,
	targetBrand: string,
	competitorBrands: readonly string[] = [],
): AeoQueryScore {
	return {
		query,
		responseText,
		target: detectBrandMention(responseText, targetBrand),
		competitors: competitorBrands.map((brand) =>
			detectBrandMention(responseText, brand),
		),
	};
}

export interface AeoSummary {
	totalQueries: number;
	/** Fraction of queries whose response exact-text-mentioned the target brand. */
	citationRate: number;
	/** Mean prominence across queries where the target brand was mentioned; null when never mentioned. */
	averageProminence: number | null;
	/**
	 * Mean, across queries with at least one brand mention (target or
	 * competitor), of target mentions / (target + competitor mentions).
	 * Null when no query had any mention at all.
	 */
	shareOfVoice: number | null;
}

function mean(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Aggregate per-query scores into citation-rate / prominence / share-of-voice summary metrics. */
export function summarizeAeoResults(
	results: readonly AeoQueryScore[],
): AeoSummary {
	const totalQueries = results.length;
	const mentionedCount = results.filter((r) => r.target.mentioned).length;
	const citationRate = totalQueries > 0 ? mentionedCount / totalQueries : 0;

	const prominences = results
		.map((r) => r.target.prominence)
		.filter((p): p is number => p !== null);
	const averageProminence = mean(prominences);

	const shareOfVoicePerQuery = results
		.map((r) => {
			const targetMentions = r.target.mentioned ? 1 : 0;
			const competitorMentions = r.competitors.filter(
				(c) => c.mentioned,
			).length;
			const denominator = targetMentions + competitorMentions;
			return denominator > 0 ? targetMentions / denominator : null;
		})
		.filter((v): v is number => v !== null);
	const shareOfVoice = mean(shareOfVoicePerQuery);

	return { totalQueries, citationRate, averageProminence, shareOfVoice };
}

/** Small, fixed set of Tedix-category queries used when the caller supplies none. */
export const DEFAULT_AEO_QUERIES: readonly string[] = [
	"What is the best platform for autonomous AI workers?",
	"What is a good MCP app platform for agents?",
	"What products offer a tenant cognitive operating system for AI agents?",
];
