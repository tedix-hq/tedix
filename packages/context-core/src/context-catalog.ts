/**
 * Declared catalog of what may enter a turn's cognitive context, and which
 * turns deliberately withhold each block.
 *
 * WHY THIS EXISTS. `prompt-composition.ts` MEASURES what went into a prompt.
 * Nothing DECLARED what was allowed in. The rules were real and load-bearing
 * but lived in three unrelated places: an ordering constant in
 * `cognitive-addenda.ts`, a `skipDirectives` boolean the caller computed from
 * `isHomeDelegationWorkOrder(userText)`, and an `isLeanContextSession` session-
 * key predicate. Answering "what does a Home delegation work order actually
 * receive?" meant tracing a boolean across two packages.
 *
 * Making it a table means the answer is readable in one place, the withholding
 * rules can be tested directly, and a new block cannot be added without stating
 * what it is for and which turns must not see it.
 *
 * The shape is taken from a comparable coding agent's `src/reminders/catalog.ts`, which
 * declares each per-turn injection with an id and a provider rather than
 * appending them ad hoc. Their engine-parity test — the catalog and the engine
 * must agree on the id set — is reproduced here, because the failure it catches
 * (a block declared but never produced, or produced but never declared) is
 * silent in exactly the way a dark cognitive input is silent.
 *
 * WHAT THIS IS NOT: a truncation or budgeting mechanism. Nothing here trims
 * anything, and `prompt-composition.ts` explains at length why a byte count is
 * the wrong reflex for in-context material.
 */

/** Blocks that can be appended to a tedi's system prompt for one turn. */
export const CONTEXT_SEGMENT_IDS = [
	"directives",
	"brainDigest",
	"skillGuidance",
	"retrievedSkills",
] as const;

export type ContextSegmentId = (typeof CONTEXT_SEGMENT_IDS)[number];

/**
 * Kinds of turn, in the terms that actually change what context applies.
 *
 * - `standard` — an ordinary tedi turn; everything applies.
 * - `home-delegation-work-order` — an explicit, bounded operator work order.
 *   Keeps identity, memory and operational guidance, but withholds learned
 *   preferences so a loosely matching directive cannot redirect the order.
 * - `lean` — blind verification (an evidence judge that must receive NO
 *   accumulated belief, or the verdict is contaminated) and lean workflow
 *   synthesis (self-contained summarization whose whole input is already in the
 *   prompt, so the addenda haul is pure cost). Receives nothing.
 */
export const CONTEXT_TURN_KINDS = [
	"standard",
	"home-delegation-work-order",
	"lean",
] as const;

export type ContextTurnKind = (typeof CONTEXT_TURN_KINDS)[number];

export interface ContextSegmentDefinition {
	id: ContextSegmentId;
	/** One line: what this block contributes to the turn. */
	purpose: string;
	/**
	 * Turn kinds that deliberately do NOT receive this block, each with the
	 * reason — a withholding rule without a reason becomes undeletable.
	 */
	withheldFrom: ReadonlyArray<{ kind: ContextTurnKind; because: string }>;
}

export const CONTEXT_SEGMENT_CATALOG: readonly ContextSegmentDefinition[] = [
	{
		id: "directives",
		purpose:
			"Compiled directives matching this turn's user text — learned preferences.",
		withheldFrom: [
			{
				kind: "home-delegation-work-order",
				because:
					"An explicit operator work order must not be redirected by a loosely matching learned preference.",
			},
			{ kind: "lean", because: "Lean turns receive no cognitive addenda." },
		],
	},
	{
		id: "brainDigest",
		purpose:
			"Cached top-K brain digest — the tedi's accumulated beliefs about its world.",
		withheldFrom: [
			{
				kind: "lean",
				because:
					"A blind verification judge must receive no accumulated belief, or its verdict is contaminated by the thing it is judging.",
			},
		],
	},
	{
		id: "skillGuidance",
		purpose: "Per-turn skill guidance summaries — how to do the work.",
		withheldFrom: [
			{ kind: "lean", because: "Lean turns receive no cognitive addenda." },
		],
	},
	{
		id: "retrievedSkills",
		purpose:
			"Act-time retrieved skills: top-K proven procedures matched to this turn's task text (the AWM/Memp retrieve leg).",
		withheldFrom: [
			{ kind: "lean", because: "Lean turns receive no cognitive addenda." },
		],
	},
];

const CATALOG_BY_ID = new Map(
	CONTEXT_SEGMENT_CATALOG.map((entry) => [entry.id, entry]),
);

export function contextSegmentDefinition(
	id: ContextSegmentId,
): ContextSegmentDefinition {
	const entry = CATALOG_BY_ID.get(id);
	if (!entry) throw new Error(`Unknown context segment: ${id}`);
	return entry;
}

/**
 * Which blocks apply to a turn, in catalog order.
 *
 * Order is the catalog's, not the caller's, so the assembled prompt cannot
 * drift between call sites.
 */
export function contextSegmentsForTurn(
	kind: ContextTurnKind,
): ContextSegmentId[] {
	return CONTEXT_SEGMENT_CATALOG.filter(
		(entry) => !entry.withheldFrom.some((rule) => rule.kind === kind),
	).map((entry) => entry.id);
}

/**
 * Classify a turn from the two signals the runtime already has.
 *
 * `lean` wins over everything: it is a correctness boundary (a contaminated
 * blind verdict is worse than a missing one), whereas the work-order rule is a
 * scoping preference.
 */
export function classifyContextTurn(input: {
	isLeanContextSession: boolean;
	isHomeDelegationWorkOrder: boolean;
}): ContextTurnKind {
	if (input.isLeanContextSession) return "lean";
	if (input.isHomeDelegationWorkOrder) return "home-delegation-work-order";
	return "standard";
}
