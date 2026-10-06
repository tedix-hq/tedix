/**
 * Create-vs-modify adjacency gate for skill authoring.
 *
 * WHY: `record_skills` and `improve_skills` are both available to every agent,
 * and choosing between them is left entirely to the model. The observed failure
 * is duplicate skills — an agent that means "fix step 3" calls `record_skills`
 * and the corpus grows a near-identical twin, which then splits retrieval
 * (`skill-retrieval.ts` ranks over the corpus, so two half-right copies each
 * rank lower than one right one) and makes `improve_skills` ambiguous.
 *
 * A comparable coding agent encodes this as an ordered taxonomy in its reflection prompt —
 * `update > extend > deprecate > split > create > none`, with the tie-break
 * "when unsure between create and a modify op, choose the modify op". Prompt
 * guidance is the right idea in the wrong layer: it only binds the one agent
 * that reads it. This makes the same rule MECHANICAL, so it binds every caller
 * — MCP tools, Code Mode, workflows, and future surfaces alike.
 *
 * Deliberately lexical, not vector-based: the adjacency check must work when
 * the vector index is unavailable, and a create-blocking gate must never depend on a subsystem that
 * can fail open.
 */

/** Tokens too generic to carry adjacency signal on their own. */
const STOP_WORDS = new Set(
	"a an and the to of for in on with how skill skills use used using when this that should be is are it its via from by at or".split(
		" ",
	),
);

export interface AdjacencyCandidate {
	id: string;
	slug: string | null;
	title: string;
	description?: string | null;
}

export interface AdjacencyMatch {
	candidate: AdjacencyCandidate;
	/** 0..1 similarity over normalized title+description tokens. */
	score: number;
	/** True when the titles normalize to the same token set. */
	titleEquivalent: boolean;
}

export interface AdjacencyVerdict {
	/** Highest-scoring candidate, or null when nothing was adjacent at all. */
	nearest: AdjacencyMatch | null;
	/** All candidates at or above the report floor, best first. */
	adjacent: AdjacencyMatch[];
	/** True when creation should be refused in favor of modifying `nearest`. */
	blocked: boolean;
}

/**
 * Block floor. Set high on purpose: a false block is worse than a false allow,
 * because it stops an agent from recording a genuinely new procedure and the
 * agent cannot always tell why. Near-duplicate titles are the reliable signal;
 * body overlap alone is not (two distinct skills over the same subsystem share
 * a lot of vocabulary).
 */
export const SKILL_ADJACENCY_BLOCK_SCORE = 0.82;

/** Report floor — surfaced as a warning so near-misses stay visible. */
export const SKILL_ADJACENCY_REPORT_SCORE = 0.55;

export function normalizeAdjacencyTokens(text: string): Set<string> {
	const tokens = new Set<string>();
	for (const raw of text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.split(/\s+/)) {
		const token = raw.trim();
		if (!token || token.length < 3 || STOP_WORDS.has(token)) continue;
		tokens.add(token);
	}
	return tokens;
}

/** Sørensen–Dice over token sets: 2|A∩B| / (|A|+|B|). */
export function diceSimilarity(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let shared = 0;
	for (const token of a) if (b.has(token)) shared++;
	return (2 * shared) / (a.size + b.size);
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size || a.size === 0) return false;
	for (const token of a) if (!b.has(token)) return false;
	return true;
}

export interface AdjacencyInput {
	title: string;
	description?: string | null;
}

/**
 * Score a proposed skill against existing candidates.
 *
 * Title carries most of the weight (0.7) because it is what an author writes to
 * name the procedure, and two procedures with the same name are the duplicate
 * case we actually see. Description contributes the rest.
 */
export function scoreSkillAdjacency(
	proposed: AdjacencyInput,
	candidates: readonly AdjacencyCandidate[],
): AdjacencyVerdict {
	const proposedTitle = normalizeAdjacencyTokens(proposed.title);
	const proposedDescription = normalizeAdjacencyTokens(
		proposed.description ?? "",
	);

	const scored: AdjacencyMatch[] = [];
	for (const candidate of candidates) {
		const candidateTitle = normalizeAdjacencyTokens(candidate.title);
		const candidateDescription = normalizeAdjacencyTokens(
			candidate.description ?? "",
		);
		const titleScore = diceSimilarity(proposedTitle, candidateTitle);
		const titleEquivalent = setsEqual(proposedTitle, candidateTitle);
		// With no description on either side, title similarity IS the score —
		// otherwise an untitled-description skill is penalized for being terse.
		const hasDescriptions =
			proposedDescription.size > 0 && candidateDescription.size > 0;
		const descriptionScore = hasDescriptions
			? diceSimilarity(proposedDescription, candidateDescription)
			: 0;
		const score = hasDescriptions
			? titleScore * 0.7 + descriptionScore * 0.3
			: titleScore;
		scored.push({ candidate, score, titleEquivalent });
	}

	scored.sort((a, b) => b.score - a.score);
	const nearest = scored[0] ?? null;
	const adjacent = scored.filter(
		(match) => match.score >= SKILL_ADJACENCY_REPORT_SCORE,
	);
	const blocked =
		nearest !== null &&
		(nearest.score >= SKILL_ADJACENCY_BLOCK_SCORE || nearest.titleEquivalent);

	return { nearest, adjacent, blocked };
}

/**
 * The refusal message. Names the twin, why creation was refused, and the exact
 * call that does what the author almost certainly meant — the "point at the
 * replacement" rule from a comparable platform's mods diagnostics doctrine, applied to data.
 */
export function formatAdjacencyRefusal(match: AdjacencyMatch): string {
	const ref = match.candidate.slug ?? match.candidate.id;
	const why = match.titleEquivalent
		? "an existing skill has an equivalent title"
		: `an existing skill is ${(match.score * 100).toFixed(0)}% similar`;
	return [
		`Refusing to create a near-duplicate skill: ${why} ("${match.candidate.title}", ${ref}).`,
		`Prefer modifying it: improve_skills({ id: "${match.candidate.id}", ... }).`,
		"If this really is a distinct procedure, retry with force: true and say why in revisionReasoning.",
	].join(" ");
}
