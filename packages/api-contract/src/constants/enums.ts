/**
 * Canonical enum constants — single source of truth.
 *
 * These arrays back zod enums in contracts/schemas, drizzle schema column
 * `enum` options, MCP tool descriptions, and dashboard filter UIs. Importing
 * from here prevents the drift between docs/MCP descriptions and actual
 * contract validation that caused the 400 BAD_REQUEST on `write_rationale`
 * (April 2026).
 *
 * Rule: never re-declare these literal arrays anywhere else. Always
 *   `import { RATIONALE_CATEGORIES } from "@tedix/api-contract/constants/enums"`
 * and use `z.enum(RATIONALE_CATEGORIES)` at validation sites.
 */

// =============================================================================
// RATIONALE RECORDS — decision journal
// =============================================================================

export const RATIONALE_CATEGORIES = [
	"health_check",
	"config_change",
	"skill_creation",
	"skill_update",
	"content",
	"deployment",
	"recovery",
	"optimization",
	"communication",
	"custom",
] as const;
export type RationaleCategory = (typeof RATIONALE_CATEGORIES)[number];

export const RATIONALE_OUTCOME_STATUSES = [
	"pending",
	"success",
	"failure",
	"partial",
	/**
	 * A success CLAIM that carried no span-checkable proof ref (WS1 flywheel
	 * remodel). The server maps proof-less `success` completions here — callers
	 * can never write `success` without evidence. Mirrors the Work Items
	 * completion-requires-proof disposition doctrine.
	 */
	"unverified",
] as const;
export type RationaleOutcomeStatus =
	(typeof RATIONALE_OUTCOME_STATUSES)[number];

/** Subset that callers may set when COMPLETING a record (excludes "pending").
 * `unverified` is deliberately absent: it is server-assigned only, as the
 * mapped result of a proof-less `success` claim. */
export const RATIONALE_TERMINAL_STATUSES = [
	"success",
	"failure",
	"partial",
] as const;
export type RationaleTerminalStatus =
	(typeof RATIONALE_TERMINAL_STATUSES)[number];

/**
 * Span-checkable proof-ref kinds for rationale outcome claims (WS1).
 * A `success` completion must point at one of these evidence spans:
 * a runtime run, a tool-call span, an artifact, or a work-item state change.
 */
export const RATIONALE_PROOF_REF_KINDS = [
	"run",
	"tool_call",
	"artifact",
	"work_item",
] as const;
export type RationaleProofRefKind = (typeof RATIONALE_PROOF_REF_KINDS)[number];

// =============================================================================
// MUSCLE MEMORY — two-axis taxonomy (kind × origin)
// =============================================================================

export const MUSCLE_KIND = [
	"action_template",
	"correction_hook",
	"project_prime",
] as const;
export type MuscleKind = (typeof MUSCLE_KIND)[number];

export const MUSCLE_ORIGIN = [
	"manual",
	"crystallized",
	"from_skill",
	"from_correction",
] as const;
export type MuscleOrigin = (typeof MUSCLE_ORIGIN)[number];

// =============================================================================
// MEMORY GRAPH — fact types and feedback signals
// =============================================================================

export const MEMORY_FACT_TYPES = [
	"technical",
	"strategic",
	"pattern",
	"decision",
	"preference",
	"feedback",
	"procedural",
	"gap",
	"opinion",
	"question",
	"episode",
] as const;
export type MemoryFactType = (typeof MEMORY_FACT_TYPES)[number];

/**
 * Memory feedback signals — calibrate retrieval/usage correlation.
 *  - used:     fact influenced response
 *  - not_used: retrieved but unused
 *  - outdated: stale info
 *  - wrong:    incorrect fact
 *  - failed:   tool using this fact failed
 */
export const MEMORY_FEEDBACK_SIGNALS = [
	"used",
	"not_used",
	"outdated",
	"wrong",
	"failed",
] as const;
export type MemoryFeedbackSignal = (typeof MEMORY_FEEDBACK_SIGNALS)[number];
