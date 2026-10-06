/**
 * Act-time skill retrieval — the AWM/Memp "retrieve" leg.
 *
 * Agent Workflow Memory (Wang et al. 2024), Memp, and Trace2Skill all locate
 * the +24–51% gains in the same wire: induced workflows must be injected into
 * the ACTING context when the agent faces a similar task, not merely stored in
 * a library. Tedix ships the "build" leg (trajectory mining) and the "update"
 * leg (execute-to-promote lifecycle); this module is the retrieve leg's pure
 * core: deterministic ranking + compact serialization of the top-K relevant
 * proven skills for one turn's task text.
 *
 * Design constraints (Memp's warning: excessive retrieval degrades
 * performance):
 *  - K is SMALL (default {@link SKILL_RETRIEVAL_DEFAULT_TOP_K}) and injection
 *    happens only above a relevance floor ({@link
 *    SKILL_RETRIEVAL_DEFAULT_MIN_OVERLAP} significant-word overlap).
 *  - Draft skills are NEVER retrieved — only lifecycle states that passed the
 *    execute-to-promote gate ({@link SKILL_RETRIEVAL_LIFECYCLE_PRIORITY}).
 *  - Everything is cheap and deterministic: keyword/tag/toolIds overlap via
 *    text-utils' `significantWords` (NOT the directive matcher's tokenizer —
 *    that preset in compiler.ts splits on whitespace only and skips stop-word
 *    filtering; both are presets of the shared `tokenizeWords` core) plus
 *    ledger-derived success/recency stats. No LLM, no embeddings, no network.
 *
 * Ranking is lexicographic:
 *   1. relevance — unique significant-word overlap between the task text and
 *      the skill's matchable text (title + summary + description + tags +
 *      toolIds; mined skills carry their tool sequence in `toolIds`, so
 *      tool-sequence similarity participates when derivable);
 *   2. lifecycle priority — crystallized > proven > active (never draft);
 *   3. recency-weighted success rate — success ratio from the
 *      skill_usage_events-rolled counters, decayed by half-life
 *      {@link SKILL_RETRIEVAL_RECENCY_HALF_LIFE_DAYS} days since last use.
 *
 * Consumed by the Agent runtime's cognitive addenda
 * (`apps/tedi-runtime/src/do.ts` → `retrievedSkillsAddendum`), which caches
 * the org-readable corpus in DO SQLite on the 4-hour skill-guidance refresh
 * and runs this selection per turn against the user text.
 */

import { significantWords } from "./text-utils.js";
import { countTokens } from "./tokens.js";

/**
 * Compact projection of a `skill_entries` row sufficient for retrieval and
 * injection. `successCount`/`failureCount`/`lastUsedAt` are the ledger-rolled
 * rollups maintained by `recordSkillUsageEvent()` (packages/db/src/queries/
 * skill-usage.ts) — ledger-derived without a per-turn ledger read.
 */
export interface RetrievableSkill {
	id: string;
	slug?: string | null;
	title: string;
	summary?: string | null;
	description?: string | null;
	tags?: string[] | null;
	toolIds?: string[] | null;
	lifecycleState?: string | null;
	successCount?: number | null;
	failureCount?: number | null;
	lastUsedAt?: string | null;
	/** SKILL.md body (or a pre-trimmed excerpt) for the injected procedure excerpt. */
	content?: string | null;
	preconditions?: { notWhen?: string[] } | null;
}

/** Default top-K skills injected per turn. Memp: keep K small. */
export const SKILL_RETRIEVAL_DEFAULT_TOP_K = 2;
/** Hard ceiling on configurable K — more than this measurably degrades turns. */
export const SKILL_RETRIEVAL_MAX_TOP_K = 5;
/** Relevance floor: minimum unique significant-word overlap to inject at all. */
export const SKILL_RETRIEVAL_DEFAULT_MIN_OVERLAP = 2;
/** Minimum query length (chars) before selection runs (mirrors directives). */
export const SKILL_RETRIEVAL_MIN_QUERY_LEN = 10;
/** Half-life (days) for the recency weight on the success-rate signal. */
export const SKILL_RETRIEVAL_RECENCY_HALF_LIFE_DAYS = 14;
/** Per-skill token cap for the injected procedure excerpt. */
export const SKILL_RETRIEVAL_MAX_SKILL_TOKENS = 320;
/** Whole-block token cap — trailing matches are dropped past this budget. */
export const SKILL_RETRIEVAL_MAX_BLOCK_TOKENS = 800;

/**
 * Lifecycle states eligible for act-time injection, by rank. Anything absent
 * (draft, stale, archived, unknown/null) is NEVER retrieved: only states that
 * passed the execute-to-promote gate carry enough evidence to steer a turn.
 */
export const SKILL_RETRIEVAL_LIFECYCLE_PRIORITY: Readonly<
	Record<string, number>
> = {
	crystallized: 3,
	proven: 2,
	active: 1,
};

export interface RetrievedSkillMatch {
	skill: RetrievableSkill;
	/** Unique significant-word overlap between the query and the skill. */
	overlap: number;
	/** Rank from {@link SKILL_RETRIEVAL_LIFECYCLE_PRIORITY}. */
	lifecyclePriority: number;
	/** Ledger success rate decayed by recency — see {@link recencyWeightedSuccessRate}. */
	recencyWeightedSuccess: number;
	/**
	 * The operator named this skill outright (a composer `/skill <slug>`
	 * reference) rather than it being ranked in by relevance. Absent/false on
	 * every relevance match, so existing consumers are unaffected.
	 */
	referenced?: boolean;
}

/**
 * Success rate from the ledger-rolled counters, exponentially decayed by days
 * since `lastUsedAt` (half-life {@link SKILL_RETRIEVAL_RECENCY_HALF_LIFE_DAYS}).
 * A skill with no recorded usage — or no parseable last-use timestamp —
 * contributes 0: it has no execution evidence to rank on.
 */
export function recencyWeightedSuccessRate(
	skill: Pick<RetrievableSkill, "successCount" | "failureCount" | "lastUsedAt">,
	now: Date = new Date(),
): number {
	const successes = skill.successCount ?? 0;
	const failures = skill.failureCount ?? 0;
	const total = successes + failures;
	if (total <= 0) return 0;
	if (!skill.lastUsedAt) return 0;
	const lastUsed = Date.parse(skill.lastUsedAt);
	if (Number.isNaN(lastUsed)) return 0;
	const ageDays = Math.max(now.getTime() - lastUsed, 0) / 86_400_000;
	return (
		(successes / total) *
		2 ** (-ageDays / SKILL_RETRIEVAL_RECENCY_HALF_LIFE_DAYS)
	);
}

/** The text a skill is matched on: title + when-to-use + tags + tool sequence. */
function matchableText(skill: RetrievableSkill): string {
	return [
		skill.title,
		skill.summary ?? "",
		skill.description ?? "",
		...(skill.tags ?? []),
		...(skill.toolIds ?? []),
	].join(" ");
}

/** Unique significant-word overlap between two texts. */
function uniqueOverlap(queryWords: ReadonlySet<string>, text: string): number {
	let overlap = 0;
	for (const word of new Set(significantWords(text))) {
		if (queryWords.has(word)) overlap++;
	}
	return overlap;
}

export interface SelectRetrievedSkillsOptions {
	/** Top-K to return; clamped to [0, {@link SKILL_RETRIEVAL_MAX_TOP_K}]. 0 disables. */
	topK?: number;
	/** Relevance floor; clamped to ≥ 1. */
	minOverlap?: number;
	/** Injectable "now" for deterministic recency weighting. */
	now?: Date;
}

/**
 * Deterministically select the top-K retrievable skills for one task text.
 * Pure — no mutation, no I/O. Returns `[]` for short queries, empty corpora,
 * or when nothing clears the relevance floor.
 */
export function selectRetrievedSkillCandidates(
	skills: readonly RetrievableSkill[],
	query: string,
	options?: SelectRetrievedSkillsOptions,
): RetrievedSkillMatch[] {
	const topK = Math.min(Math.max(Math.floor(options?.topK ?? 40), 0), 40);
	if (topK === 0) return [];
	if (!query || query.length < SKILL_RETRIEVAL_MIN_QUERY_LEN) return [];
	if (skills.length === 0) return [];
	const minOverlap = Math.max(
		Math.floor(options?.minOverlap ?? SKILL_RETRIEVAL_DEFAULT_MIN_OVERLAP),
		1,
	);
	const now = options?.now ?? new Date();

	const queryWords = new Set(significantWords(query));
	if (queryWords.size === 0) return [];

	const matches: RetrievedSkillMatch[] = [];
	for (const skill of skills) {
		const lifecyclePriority =
			SKILL_RETRIEVAL_LIFECYCLE_PRIORITY[skill.lifecycleState ?? ""];
		if (lifecyclePriority === undefined) continue; // never drafts/stale/archived
		const overlap = uniqueOverlap(queryWords, matchableText(skill));
		if (overlap < minOverlap) continue; // relevance floor
		matches.push({
			skill,
			overlap,
			lifecyclePriority,
			recencyWeightedSuccess: recencyWeightedSuccessRate(skill, now),
		});
	}

	matches.sort(
		(a, b) =>
			b.overlap - a.overlap ||
			b.lifecyclePriority - a.lifecyclePriority ||
			b.recencyWeightedSuccess - a.recencyWeightedSuccess ||
			(a.skill.slug ?? a.skill.id).localeCompare(b.skill.slug ?? b.skill.id),
	);
	return matches.slice(0, topK);
}

/** Original public top-K contract; candidate expansion never raises the prompt cap. */
export function selectRetrievedSkills(
	skills: readonly RetrievableSkill[],
	query: string,
	options?: SelectRetrievedSkillsOptions,
): RetrievedSkillMatch[] {
	const topK = Math.min(
		Math.max(Math.floor(options?.topK ?? SKILL_RETRIEVAL_DEFAULT_TOP_K), 0),
		SKILL_RETRIEVAL_MAX_TOP_K,
	);
	return selectRetrievedSkillCandidates(skills, query, { ...options, topK });
}

export interface SelectSkillsForTurnOptions extends SelectRetrievedSkillsOptions {
	/**
	 * Slugs (or ids) the operator referenced outright in this turn's text.
	 * An explicit reference is a STRONGER signal than relevance ranking, so
	 * these are selected first and are exempt from the relevance floor and the
	 * minimum-query-length gate — the operator already did the retrieving.
	 */
	referencedSlugs?: readonly string[];
}

export interface SkillsForTurnSelection {
	/** Referenced skills first (in the order named), then relevance matches. */
	matches: RetrievedSkillMatch[];
	/**
	 * Referenced slugs with no injectable skill in the corpus — absent, or
	 * present but not eligible for act-time injection (draft/stale/archived).
	 * The caller MUST surface these: an operator who named a skill and silently
	 * got an ordinary turn learns nothing.
	 */
	unresolvedReferences: string[];
}

/**
 * One turn's skill selection: explicit operator references first, relevance
 * ranking for whatever K remains.
 *
 * This is the same retrieve leg, given a stronger signal — not a second
 * injection path. A reference bypasses the relevance floor because the
 * operator's naming IS the relevance judgement, but it does NOT bypass the
 * lifecycle gate: a draft or archived skill has not passed the
 * execute-to-promote gate and still carries no evidence to steer a turn, so it
 * is reported unresolved rather than injected.
 *
 * Referenced skills count against the SAME K and the same block budget, so a
 * reference cannot pin a catalog wall into the prompt.
 */
export function selectSkillsForTurn(
	skills: readonly RetrievableSkill[],
	query: string,
	options?: SelectSkillsForTurnOptions,
): SkillsForTurnSelection {
	const topK = Math.min(
		Math.max(Math.floor(options?.topK ?? SKILL_RETRIEVAL_DEFAULT_TOP_K), 0),
		SKILL_RETRIEVAL_MAX_TOP_K,
	);
	const referencedSlugs = options?.referencedSlugs ?? [];
	if (referencedSlugs.length === 0) {
		return {
			matches: selectRetrievedSkills(skills, query, options),
			unresolvedReferences: [],
		};
	}
	const now = options?.now ?? new Date();
	const queryWords = new Set(significantWords(query));

	const matches: RetrievedSkillMatch[] = [];
	const unresolvedReferences: string[] = [];
	const taken = new Set<string>();
	for (const slug of referencedSlugs) {
		const skill = skills.find((row) => row.slug === slug || row.id === slug);
		const lifecyclePriority =
			skill === undefined
				? undefined
				: SKILL_RETRIEVAL_LIFECYCLE_PRIORITY[skill.lifecycleState ?? ""];
		if (skill === undefined || lifecyclePriority === undefined) {
			if (!unresolvedReferences.includes(slug)) unresolvedReferences.push(slug);
			continue;
		}
		if (taken.has(skill.id)) continue;
		taken.add(skill.id);
		// Past K the reference cannot be injected either — say so rather than
		// dropping it, so "I named six skills and got two" is never silent.
		if (matches.length >= topK) {
			if (!unresolvedReferences.includes(slug)) unresolvedReferences.push(slug);
			continue;
		}
		matches.push({
			skill,
			overlap: uniqueOverlap(queryWords, matchableText(skill)),
			lifecyclePriority,
			recencyWeightedSuccess: recencyWeightedSuccessRate(skill, now),
			referenced: true,
		});
	}

	// Relevance fills whatever K the references left, over the rest of the corpus.
	const remaining = topK - matches.length;
	if (remaining > 0) {
		for (const match of selectRetrievedSkills(
			skills.filter((skill) => !taken.has(skill.id)),
			query,
			{ ...options, topK: remaining },
		)) {
			matches.push(match);
		}
	}
	return { matches, unresolvedReferences };
}

/** Strip a leading YAML frontmatter block from a SKILL.md body. */
function stripFrontmatter(content: string): string {
	if (!content.startsWith("---")) return content;
	const end = content.indexOf("\n---", 3);
	if (end === -1) return content;
	return content.slice(end + 4).replace(/^\s+/, "");
}

/** Cap text at a token budget, cutting at a line boundary where possible. */
function capExcerpt(
	text: string,
	maxTokens: number,
): { text: string; truncated: boolean } {
	if (countTokens(text) <= maxTokens) return { text, truncated: false };
	const budgetChars = maxTokens * 4;
	const hard = text.slice(0, budgetChars);
	const lastNewline = hard.lastIndexOf("\n");
	const cut = lastNewline > budgetChars / 2 ? hard.slice(0, lastNewline) : hard;
	return { text: cut.trimEnd(), truncated: true };
}

export interface SerializeRetrievedSkillsOptions {
	maxSkillTokens?: number;
	maxBlockTokens?: number;
	/**
	 * Referenced slugs that resolved to nothing injectable
	 * ({@link SkillsForTurnSelection.unresolvedReferences}). Rendered as an
	 * explicit instruction to tell the operator, so a named skill that did not
	 * load degrades legibly instead of producing a silently ordinary turn.
	 */
	unresolvedReferences?: readonly string[];
}

/**
 * Serialize selected matches into the compact "Retrieved Skills" system-prompt
 * block: title + when-to-use + a token-capped procedure excerpt per skill,
 * bounded by a whole-block budget (the first match is always included — its
 * per-skill cap keeps it bounded). Returns "" when nothing matched, so the
 * prompt is unchanged.
 */
export function serializeRetrievedSkills(
	matches: readonly RetrievedSkillMatch[],
	options?: SerializeRetrievedSkillsOptions,
): string {
	const unresolved = options?.unresolvedReferences ?? [];
	if (matches.length === 0 && unresolved.length === 0) return "";
	const maxSkillTokens =
		options?.maxSkillTokens ?? SKILL_RETRIEVAL_MAX_SKILL_TOKENS;
	const maxBlockTokens =
		options?.maxBlockTokens ?? SKILL_RETRIEVAL_MAX_BLOCK_TOKENS;

	const referencedCount = matches.filter((match) => match.referenced).length;
	const header =
		`## Retrieved Skills (act-time match: ${matches.length})\n\n` +
		"Proven procedures from your skill library matched to this task. Prefer " +
		"following an applicable skill over improvising; call `read_skill` with " +
		"the slug for the full procedure." +
		(referencedCount > 0
			? `\n\nThe operator explicitly named ${referencedCount === 1 ? "the skill marked [operator-referenced]" : `the ${referencedCount} skills marked [operator-referenced]`}. Follow ${referencedCount === 1 ? "it" : "them"} unless doing so would be wrong for this request, and say so if you depart from ${referencedCount === 1 ? "it" : "them"}.`
			: "");

	const sections: string[] = [];
	// A reference the block budget pushed out is still a reference that did not
	// reach the turn, so it joins the unresolved notice rather than vanishing.
	const dropped: string[] = [];
	let budget = maxBlockTokens - countTokens(header);
	for (const match of matches) {
		const { skill } = match;
		const slug = skill.slug ?? skill.id;
		const successes = skill.successCount ?? 0;
		const failures = skill.failureCount ?? 0;
		const lines: string[] = [
			`### ${skill.title} — skill ${slug} [${skill.lifecycleState}, ${successes}ok/${failures}fail]${
				match.referenced ? " [operator-referenced]" : ""
			}`,
		];
		const whenToUse = skill.summary ?? skill.description;
		if (whenToUse) lines.push(`When to use: ${whenToUse}`);
		const notWhen = skill.preconditions?.notWhen?.filter(Boolean) ?? [];
		if (notWhen.length > 0) lines.push(`Not when: ${notWhen.join("; ")}`);
		const body = stripFrontmatter(skill.content ?? "").trim();
		if (body) {
			const { text, truncated } = capExcerpt(body, maxSkillTokens);
			lines.push("Procedure:", text);
			if (truncated) {
				lines.push(
					`… (truncated — call \`read_skill\` with slug \`${slug}\` for the full procedure)`,
				);
			}
		}
		const section = lines.join("\n");
		const cost = countTokens(section);
		// Whole-block budget: always keep the FIRST match (its per-skill cap
		// bounds it); drop trailing matches that would blow the block budget.
		if (sections.length > 0 && cost > budget) {
			if (match.referenced) dropped.push(slug);
			continue;
		}
		sections.push(section);
		budget -= cost;
	}

	// Legible degradation. The operator named a skill and it did not load; an
	// unmodified turn would teach them nothing, so the model is told to say it
	// outright. This is the one case that overrides the system prompt's
	// "never mention unseen slugs" rule, because the operator typed the slug.
	const unloaded = [...unresolved, ...dropped];
	const notice =
		unloaded.length > 0
			? `## Unresolved Skill References\n\nThe operator referenced ${unloaded
					.map((slug) => `\`${slug}\``)
					.join(
						", ",
					)}, which did not load: no such skill is readable here, it is not in an injectable lifecycle state (draft, stale, or archived), or it did not fit this turn's budget. Tell the operator plainly that this reference did not resolve, name it, and continue with the rest of the request.`
			: "";

	if (sections.length === 0) return notice;
	return [header, ...sections, ...(notice ? [notice] : [])].join("\n\n");
}
