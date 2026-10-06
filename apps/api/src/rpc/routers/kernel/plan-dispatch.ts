/**
 * Kernel — multi-tedi plan-dispatch helpers.
 *
 * Pure, side-effect-free helpers for the Home plan path: detect a planning
 * request, select the named roster owners, and build/bound/render the per-owner
 * assignment work orders. Extracted from `kernel-runtime.ts` to sit alongside the
 * single-delegate `kernel/delegation-dispatch.ts`.
 *
 * The orchestration that needs D1/context (`readHomePlanningTargets`) and the LLM
 * decomposition wiring (`maybeBuildHomePlan`) stay in `kernel-runtime.ts`; they
 * import the pure helpers below.
 */

import type { HomePlan } from "@tedix/api-contract/schemas/kernel-runtime";
import type { tedis } from "@tedix/db/schema/tedis";

export type HomePlanningTarget = Pick<
	typeof tedis.$inferSelect,
	| "displayName"
	| "id"
	| "name"
	| "runtimeKind"
	| "runtimeState"
	| "slug"
	| "status"
>;

export function tediPlanningLabel(target: HomePlanningTarget): string {
	return target.displayName || target.name || target.slug || target.id;
}

export function detectsHomePlanningRequest(content: string): boolean {
	// Cheap pre-filter: the operator is asking to plan/split/coordinate work. The
	// real gate is "≥2 named reachable tedis" (selectedHomePlanTargets, checked in
	// maybeBuildHomePlan) — generalized from the original hardcoded CPO+Echo demo
	// so ANY multi-owner request parks a plan instead of collapsing to a single
	// delegate_tedi. (kernel-evals: plan.multi_tedi_work_items.)
	return /\b(plan|split|coordinate|parallel|multi[-\s]?step|multi[-\s]?owner|multiple|both|across|assign|assignment|delegate)\b/.test(
		content.toLowerCase(),
	);
}

/**
 * Body/role-suffix noise tokens that must NOT identify a tedi — they'd false-
 * match arbitrary prose. The distinctive identifiers (cpo, cmo, ceo, cto, echo,
 * research, …) survive.
 */
const PLAN_TARGET_STOPWORDS = new Set([
	"tedi",
	"tedix", // org/brand name — not a tedi slug
	"isolate",
	"agent",
	"container",
	"bot",
	"runtime",
	"operator",
	"officer",
	"chief",
	// Generic dictionary words that appear in display-names / prose but are not
	// distinctive identity tokens (fixes false fan-out to tedis whose names
	// contain common words like "bench", "lab", "team", etc.)
	"bench",
	"lab",
	"team",
	"work",
	"home",
	"base",
	"pilot",
]);

/** Distinctive name tokens for a tedi (slug/displayName/name words, ≥3 chars). */
function planTargetTokens(target: HomePlanningTarget): string[] {
	const raw = `${target.slug ?? ""} ${target.displayName ?? ""} ${target.name ?? ""}`;
	return Array.from(
		new Set(
			raw
				.toLowerCase()
				.split(/[^a-z0-9]+/)
				.filter((tok) => tok.length >= 3 && !PLAN_TARGET_STOPWORDS.has(tok)),
		),
	);
}

/**
 * A token is STRONG when it comes from the tedi's slug (the most distinctive
 * identity signal). Slug tokens are short, org-scoped, and unlikely to appear
 * in generic prose (cto, cmo, ceo, cpo, echo, research, …). Display-name tokens
 * that survived PLAN_TARGET_STOPWORDS filtering are classified WEAK — they may
 * still be common dictionary words that happen to appear in the content without
 * the operator actually intending to name that tedi.
 */
function slugTokens(target: HomePlanningTarget): Set<string> {
	const raw = target.slug ?? "";
	return new Set(
		raw
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((tok) => tok.length >= 3 && !PLAN_TARGET_STOPWORDS.has(tok)),
	);
}

/** Match a complete compound slug, including its spaced display form. */
function slugPhrasePattern(target: HomePlanningTarget): RegExp | null {
	if (!target.slug) return null;
	const parts = target.slug
		.toLowerCase()
		.replace(/([a-z])(\d)/g, "$1 $2")
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
	if (parts.length < 2) return null;
	return new RegExp(`\\b${parts.join("[\\s_-]*")}\\b`);
}

/** Whether the operator's message names this tedi (token, word-bounded). */
function contentNamesTarget(
	normalized: string,
	target: HomePlanningTarget,
): boolean {
	return (
		(slugPhrasePattern(target)?.test(normalized) ?? false) ||
		planTargetTokens(target).some((tok) =>
			new RegExp(`\\b${tok}\\b`).test(normalized),
		)
	);
}

/** Whether the operator's message names this tedi via a STRONG (slug) token. */
function contentNamesTargetStrongly(
	normalized: string,
	target: HomePlanningTarget,
): boolean {
	return (
		(slugPhrasePattern(target)?.test(normalized) ?? false) ||
		Array.from(slugTokens(target)).some((tok) =>
			new RegExp(`\\b${tok}\\b`).test(normalized),
		)
	);
}

export function selectedHomePlanTargets(input: {
	content: string;
	targets: HomePlanningTarget[];
}): HomePlanningTarget[] {
	const normalized = input.content.toLowerCase();
	// Generalized from the original hardcoded cpo/echo match: select EVERY reachable
	// roster tedi the operator explicitly named. No arbitrary slice fallback — if
	// fewer than 2 are named, maybeBuildHomePlan declines to fabricate a plan.
	const matched = input.targets.filter((target) =>
		contentNamesTarget(normalized, target),
	);

	// Single-strong-target dominance: if exactly ONE target matched on a STRONG
	// (slug-derived) token AND every other matched target matched ONLY on weak
	// (display-name) tokens, the operator named a single specific tedi — collapse
	// to that target rather than fanning out. This prevents "ask the CTO to …"
	// from pulling in other tedis whose display-names contain incidental prose
	// matches (e.g. "Tedix Bench" matching "tedix" before stopword filtering,
	// or a display-name word that appears in the sentence).
	// When ≥2 targets match on STRONG tokens the full multi-owner plan is kept.
	const stronglyMatched = matched.filter((target) =>
		contentNamesTargetStrongly(normalized, target),
	);
	if (stronglyMatched.length === 1 && matched.length > 1) {
		return stronglyMatched;
	}

	return matched;
}

export function previewPlanContent(content: string): string {
	const trimmed = content.trim().replace(/\s+/g, " ");
	return trimmed.length > 140 ? `${trimmed.slice(0, 137)}...` : trimmed;
}

/**
 * Bound an LLM-decomposed plan objective before it becomes a dispatched work
 * order. Mirrors the single-delegate `MAX_OBJECTIVE_LEN`/clamp
 * (kernel/delegation-dispatch.ts) so the plan path is capped the same way; the v0
 * template is already bounded by the 140-char content preview.
 */
const MAX_PLAN_OBJECTIVE_LEN = 600;
export function clampPlanObjective(objective: string): string {
	const trimmed = objective.trim();
	return trimmed.length > MAX_PLAN_OBJECTIVE_LEN
		? `${trimmed.slice(0, MAX_PLAN_OBJECTIVE_LEN - 1).trimEnd()}…`
		: trimmed;
}

export function buildHomePlanAssignment(input: {
	content: string;
	index: number;
	runId: string;
	target: HomePlanningTarget;
	/** LLM-decomposed per-owner objective (plan v1); null → v0 template fallback. */
	objective?: string | null;
}): HomePlan["assignments"][number] {
	const label = tediPlanningLabel(input.target);
	const preview = previewPlanContent(input.content);
	const objective =
		input.objective && input.objective.trim().length > 0
			? clampPlanObjective(input.objective)
			: `Own ${label}'s slice of the operator's multi-owner request: ${preview}`;
	return {
		id: `${input.runId}:assignment:${input.index + 1}:${input.target.id}`,
		ownerTediId: input.target.id,
		ownerSlug: input.target.slug ?? null,
		ownerLabel: label,
		routeKind: "agent",
		objective,
		expectedEvidence: [
			"Result summary tied back to the Home request.",
			"Evidence, cited sources, or explicit blockers before any dispatch.",
		],
		risk: "low",
		confidence: 0.8,
		requiresApproval: true,
		required: true,
		status: "proposed",
	};
}

/**
 * Bound the plan-v1 decomposition LLM call so a slow model never stalls the
 * ask ack. On timeout the plan falls back to the v0 template (fail-soft).
 */
export const PLAN_DECOMPOSITION_TIMEOUT_MS = 6000;

export const HOME_PLAN_ASSIGNMENT_SCOPE_INSTRUCTIONS = [
	"Assignment scope is authoritative: execute and report only the objective above.",
	"The original Home request is supporting context for facts, identifiers, and constraints, but sibling assignments remain out of scope.",
	"Do not perform, summarize, or claim completion of another owner's objective; Home will synthesize the branches.",
].join(" ");

export function homePlanAssignmentDispatchContent(input: {
	assignment: HomePlan["assignments"][number];
	homeRunId: string;
	plan: HomePlan;
	sourceRequest?: string | null;
	workItemId: string;
}): string {
	const evidence = input.assignment.expectedEvidence
		.map((item) => `- ${item}`)
		.join("\n");
	const sourceRequest = input.sourceRequest ?? "";
	return [
		`Home approved this assignment for ${input.assignment.ownerLabel}.`,
		"",
		`Objective: ${input.assignment.objective}`,
		"",
		HOME_PLAN_ASSIGNMENT_SCOPE_INSTRUCTIONS,
		...(sourceRequest
			? ["", "Original Home request (supporting context only):", sourceRequest]
			: []),
		`Work Item: ${input.workItemId}`,
		`Home plan: ${input.plan.id}`,
		`Home run: ${input.homeRunId}`,
		"",
		"Return concise evidence to Home when complete:",
		evidence || "- Result summary tied back to the Home request.",
	].join("\n");
}
