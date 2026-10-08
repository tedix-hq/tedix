/**
 * Harness Versioning + Trace Bundle Schemas
 *
 * Foundation for the harness-evolution ledger described in `docs/engineering/cognition/harness.md`
 * ("active harness versions" in the Tenant Cognitive OS table; "produce trace
 * bundle, rationale, patch, eval result, rollback plan" in the System-2 flow).
 *
 * A tedi's harness = model + context policy + retrieval policy + skill policy +
 * MCP tool routing + directive compiler + crystallizer + rationale bridge +
 * runtime event ledger + eval feedback. A `HarnessVersion` is a versioned,
 * content-hashed SNAPSHOT of that config. A `TraceBundle` is a curated
 * PROJECTION over one work episode's runtime events + rationale records +
 * artifacts — it references those rows by id rather than duplicating their
 * bodies (`packages/api-contract/src/schemas/cognitive-runtime.ts` owns the
 * canonical `TediRuntimeEvent` / `TediArtifact` shapes; rationale records live
 * in `./rationale-records.ts`).
 *
 * zod 4 conventions; mirrors `./body-certification.ts` export style. NO barrels
 * — import via `@tedix/api-contract/schemas/harness-version`.
 */

import * as z from "zod";
import { JsonValueSchema } from "./common";
import { WorkstationProfileIdSchema } from "./workstation";

// =============================================================================
// ENUM SCHEMAS
// =============================================================================

/**
 * Promotion lifecycle for a harness version / candidate
 * (docs/engineering/cognition/harness.md § "Promotion and rollback" — proposed, evaluated, canary,
 * promoted, rejected, rolled_back). `active` is the pointer a runtime body
 * actually loads.
 */
export const HarnessPromotionStatusSchema = z.enum([
	"proposed",
	"evaluated",
	"canary",
	"active",
	"promoted",
	"rejected",
	"rolled_back",
]);
export type HarnessPromotionStatus = z.infer<
	typeof HarnessPromotionStatusSchema
>;

/**
 * The harness components that can change and therefore force a version bump
 * (docs/engineering/cognition/harness.md § "Strategic Read" component list + § "Component
 * attribution" / extended blameChain). Used as the canonical key set for the
 * `components` content-hash record so attribution and version diffing share a
 * vocabulary. The record itself stays open (`z.record`) so new components do
 * not require a schema change, but these are the well-known names.
 */
export const HarnessComponentSchema = z.enum([
	"model",
	"context_policy",
	"retrieval_policy",
	"skill_policy",
	"mcp_routing",
	"directive_set",
	"crystallizer",
	"rationale_bridge",
	"prompt_template",
	"memory_schema",
	"approval_policy",
	"budget_policy",
	"artifact_rendering",
	"graph_projection",
	"attention_router",
	"workstation_profile",
	"environment_policy",
	"tool_connector_policy",
	// Agent-loop control: max tool rounds per turn + final-step stop rule. Stamped
	// so loop behaviour is versioned/auditable, not a buried runtime constant.
	"loop_policy",
]);
export type HarnessComponent = z.infer<typeof HarnessComponentSchema>;

/**
 * Outcome label for a completed work episode (drives trace-bundle review +
 * eval feedback). Mirrors the rationale outcome vocabulary loosely but is
 * episode-scoped, not decision-scoped.
 */
export const TraceBundleOutcomeSchema = z.enum([
	"success",
	"partial",
	"failure",
	"escalated",
	"aborted",
	"unknown",
]);
export type TraceBundleOutcome = z.infer<typeof TraceBundleOutcomeSchema>;

export const HarnessSubjectKindSchema = z.enum(["tedi", "kernel"]);
export type HarnessSubjectKind = z.infer<typeof HarnessSubjectKindSchema>;

export const TraceBundleWorkstationSchema = z.object({
	profileId: WorkstationProfileIdSchema,
	workstationId: z.string(),
	leaseId: z.string().nullable().default(null),
	sessionIds: z.array(z.string()).default([]),
	participantIds: z.array(z.string()).default([]),
});
export type TraceBundleWorkstation = z.infer<
	typeof TraceBundleWorkstationSchema
>;

// =============================================================================
// HARNESS VERSION
// =============================================================================

/**
 * A versioned snapshot of a tedi's active harness config.
 *
 * `components` is a content-hash / version map (component-name → hash|version)
 * so the snapshot stays flexible and small — it points at component source
 * (Artifacts commit, policy-pack id, directive-set hash) rather than copying
 * config bodies into the ledger (docs/engineering/cognition/harness.md § "Harness Manifest" — "The
 * manifest should reference source commits and component hashes, not copy large
 * source files into D1"). Keys SHOULD be drawn from `HarnessComponentSchema`
 * but the record is intentionally open.
 */
export const HarnessVersionSchema = z.object({
	id: z.string(),
	tediId: z.string(),
	/** Org scope — trace/version rows are tenant-isolated (docs/engineering/cognition/harness.md § Trace Safety). */
	orgId: z.string().optional(),
	/**
	 * Monotonic int (`"7"`) or semver (`"1.4.0"`) — kept as a string so callers
	 * may choose either scheme without a schema change. Ordering within a tedi
	 * is by `createdAt` + `parentVersionId` lineage, not by parsing this field.
	 */
	version: z.string(),
	/** Runtime body class this version targets, if pinned (agent/container). */
	runtimeKind: z.string().optional(),
	/**
	 * component-name → content-hash | version string. Flexible by design; well
	 * known keys are in `HarnessComponentSchema`.
	 */
	components: z.record(z.string(), z.string()),
	/** Previous version this was forked/bumped from — lineage for diff + rollback. */
	parentVersionId: z.string().nullable().optional(),
	/** Why the version was bumped: "directive promoted", "model swap", etc. */
	reason: z.string().nullable().optional(),
	/** Artifacts commit SHA for the replayable source tree (docs/engineering/cognition/harness.md § Versioning Map). */
	artifactCommitSha: z.string().nullable().optional(),
	/** Trace-safety policy in force for trace writers under this version. */
	traceSafetyPolicyId: z.string().nullable().optional(),
	promotionStatus: HarnessPromotionStatusSchema.default("proposed"),
	createdAt: z.string(),
	metadata: z.record(z.string(), JsonValueSchema).optional(),
});
export type HarnessVersion = z.infer<typeof HarnessVersionSchema>;

/**
 * Subject-keyed harness version for non-tedi actors such as the Home Kernel.
 * This is the forward schema for harness subjects that cannot, and must not,
 * fake a tedi identity. Existing tedi body rows continue to use
 * `HarnessVersion`; kernel rows use `subjectKind="kernel"` and an org-scoped
 * `subjectId` such as `kernel:{orgId}`.
 */
export const HarnessSubjectVersionSchema = z.object({
	id: z.string(),
	subjectKind: HarnessSubjectKindSchema,
	subjectId: z.string(),
	tediId: z.string().nullable().optional(),
	orgId: z.string().optional(),
	version: z.string(),
	runtimeKind: z.string().optional(),
	components: z.record(z.string(), z.string()),
	parentVersionId: z.string().nullable().optional(),
	reason: z.string().nullable().optional(),
	artifactCommitSha: z.string().nullable().optional(),
	traceSafetyPolicyId: z.string().nullable().optional(),
	promotionStatus: HarnessPromotionStatusSchema.default("proposed"),
	createdAt: z.string(),
	metadata: z.record(z.string(), JsonValueSchema).optional(),
});
export type HarnessSubjectVersion = z.infer<typeof HarnessSubjectVersionSchema>;

// =============================================================================
// TRACE BUNDLE
// =============================================================================

/**
 * The evidence bundle for ONE work episode — a curated projection over the
 * runtime event ledger + rationale records + artifacts for a single run.
 *
 * References everything by id (no duplication): `eventIds` point into
 * `tedi_runtime_events` (`TediRuntimeEvent`), `rationaleRecordIds` into the
 * rationale journal (`RationaleRecord`), `artifactIds` into `tedi_artifacts`
 * (`TediArtifact`). `harnessVersionId` stamps which harness produced the
 * episode so before/after comparison and component attribution are possible.
 * Raw payloads (prompt, tool payloads) live in Artifacts/R2 under
 * `harness/runs/<runId>/...` (docs/engineering/cognition/harness.md § Trace Bundle Shape) and are pointed
 * at by `bundleUri`, never inlined here.
 */
export const TraceBundleSchema = z.object({
	id: z.string(),
	tediId: z.string(),
	orgId: z.string().optional(),
	conversationId: z.string().optional(),
	runId: z.string(),
	/** Which harness produced this episode — the join key for eval/attribution. */
	harnessVersionId: z.string(),
	createdAt: z.string(),
	/** Refs into tedi_runtime_events (curated, ordered subset for this episode). */
	eventIds: z.array(z.string()).default([]),
	/** Refs into the rationale journal (decisions made during this episode). */
	rationaleRecordIds: z.array(z.string()).default([]),
	/** Refs into tedi_artifacts (files/widgets created during this episode). */
	artifactIds: z.array(z.string()).default([]),
	/** Workstation that supplied shared CodeMode/sandbox/browser capability for this episode. */
	workstation: TraceBundleWorkstationSchema.nullable().default(null),
	/** Optional link to the eval result scored against this bundle. */
	evalResultId: z.string().nullable().optional(),
	/** Artifacts/R2 URI for the replayable raw evidence folder (redacted). */
	bundleUri: z.string().nullable().optional(),
	/** Human/navigation summary — NOT a replacement for raw trace retention. */
	summary: z.string().nullable().optional(),
	outcome: TraceBundleOutcomeSchema.optional(),
	metadata: z.record(z.string(), JsonValueSchema).optional(),
});
export type TraceBundle = z.infer<typeof TraceBundleSchema>;

/**
 * Subject-keyed trace bundle for non-tedi harness actors such as the Home
 * Kernel. This mirrors `TraceBundle` without forcing an identity-less actor to
 * fabricate a tedi id. Event ids may point at actor-specific ledgers such as
 * `kernel_runtime_events`.
 */
export const HarnessSubjectTraceBundleSchema = z.object({
	id: z.string(),
	subjectKind: HarnessSubjectKindSchema,
	subjectId: z.string(),
	tediId: z.string().nullable().optional(),
	orgId: z.string().optional(),
	conversationId: z.string().optional(),
	runId: z.string(),
	harnessVersionId: z.string(),
	createdAt: z.string(),
	eventIds: z.array(z.string()).default([]),
	rationaleRecordIds: z.array(z.string()).default([]),
	artifactIds: z.array(z.string()).default([]),
	workstation: TraceBundleWorkstationSchema.nullable().default(null),
	evalResultId: z.string().nullable().optional(),
	bundleUri: z.string().nullable().optional(),
	summary: z.string().nullable().optional(),
	outcome: TraceBundleOutcomeSchema.optional(),
	metadata: z.record(z.string(), JsonValueSchema).optional(),
});
export type HarnessSubjectTraceBundle = z.infer<
	typeof HarnessSubjectTraceBundleSchema
>;

// =============================================================================
// TRACE SAFETY POLICY (docs/engineering/cognition/harness.md § Trace Safety Contract)
// =============================================================================

/**
 * The policy a trace writer MUST enforce before any raw prompt / tool payload /
 * model output is committed to R2 or Artifacts (`TraceBundle.bundleUri`). Raw
 * traces are the highest-risk artifact class in the system; nothing raw is
 * written until this policy is applied. The runtime enforcement (pure,
 * body-neutral) lives in `@tedix/context-core/trace-safety`; this schema is the
 * persisted reference shape (`HarnessVersion.traceSafetyPolicyId` /
 * `TraceBundle.traceSafetyPolicyId` point at a policy `id`).
 *
 * Grounded in the shared redaction model: redact-at-write, sentinel
 * replacement, a sensitive-key allowlist (so token-accounting fields like
 * `maxTokens` are NOT redacted), and dual-path scrub (structured object + raw
 * text). `regex` fields carry serialized source strings (case-insensitive) so
 * the policy is JSON-persistable.
 */
export const TraceSafetyPolicySchema = z.object({
	id: z.string(),
	version: z.string(),
	/** Replacement token written in place of a redacted value. */
	redactedSentinel: z.string(),
	/** Key-name regex sources whose VALUES are redacted (e.g. `token$`, `secret`). */
	sensitiveKeyPatterns: z.array(z.string()),
	/** Lowercased key suffixes exempt from redaction (token-accounting fields). */
	allowlistSuffixes: z.array(z.string()),
	/** Named regex sources scrubbed out of free TEXT + string values (Bearer, JWT, sk_, cookies, signed-URL params). */
	valueScrubbers: z.array(z.object({ name: z.string(), pattern: z.string() })),
	/** Default raw-payload vs summary retention (raw short, summaries long). */
	retention: z.object({ rawPayloadDays: z.number(), summaryDays: z.number() }),
	/** Trace rows/URIs/replay are org-scoped — cross-org trace access is forbidden. */
	orgScoped: z.literal(true),
});
export type TraceSafetyPolicy = z.infer<typeof TraceSafetyPolicySchema>;

// =============================================================================
// HARNESS EVAL RESULT (stub — fills the eval-ledger gap)
// =============================================================================

/**
 * Minimal eval-result stub for the harness eval ledger gap
 * (docs/engineering/cognition/harness.md § "Harness Evaluation Ledger"). One scored evaluation of a
 * harness version. `gates` is a per-protected-metric pass map (task success,
 * grounding, cost, latency, approval burden, data exposure, …); `passed` is
 * the AND over the required gates. Promotion logic and the multi-lane eval
 * splits (search / validation / locked-test / canary) are NOT modeled here —
 * this is the leaf record the promotion gate reads.
 */
export const HarnessEvalResultSchema = z.object({
	id: z.string(),
	harnessVersionId: z.string(),
	tediId: z.string(),
	orgId: z.string().optional(),
	/** Aggregate score (scheme-defined; higher is better unless gates say otherwise). */
	score: z.number(),
	/** Per-metric pass/fail map — protected metrics that gate promotion. */
	gates: z.record(z.string(), z.boolean()),
	/** AND over required gates. */
	passed: z.boolean(),
	/** Which eval lane produced this (search/validation/locked-test/canary). */
	lane: z.string().nullable().optional(),
	/** Task set this was scored against. */
	taskSetId: z.string().nullable().optional(),
	createdAt: z.string(),
	metadata: z.record(z.string(), JsonValueSchema).optional(),
});
export type HarnessEvalResult = z.infer<typeof HarnessEvalResultSchema>;

// =============================================================================
// EVAL SUMMARY (aggregate read for the promotion gate)
// =============================================================================

/**
 * Aggregate over a harness version's eval ledger — the shape the promotion gate
 * (`evalGateForCertification`) reads. Counts pass/fail, surfaces the latest
 * score, and rolls up per-lane and per-gate pass state from the LATEST eval in
 * each lane. This is a derived projection, not a stored row.
 */
export const HarnessEvalSummarySchema = z.object({
	harnessVersionId: z.string(),
	/** Total eval results recorded for this version. */
	total: z.number().int(),
	/** Count with `passed === true`. */
	passedCount: z.number().int(),
	/** Count with `passed === false`. */
	failedCount: z.number().int(),
	/** Score of the most recent eval (by createdAt), or null when none exist. */
	latestScore: z.number().nullable(),
	/** createdAt of the most recent eval, or null. */
	latestCreatedAt: z.string().nullable(),
	/** Distinct eval lanes seen across the ledger (nulls collapsed to "default"). */
	lanes: z.array(z.string()),
	/**
	 * Per-lane pass state of the LATEST eval in that lane. A lane passes iff its
	 * most recent eval `passed`. Empty when no evals exist.
	 */
	latestPassByLane: z.record(z.string(), z.boolean()),
});
export type HarnessEvalSummary = z.infer<typeof HarnessEvalSummarySchema>;

/** Canonical lane label for an eval whose `lane` is null/empty. */
export const DEFAULT_EVAL_LANE = "default";

// =============================================================================
// CERTIFICATION EVAL GATE (behavioral bridge)
// =============================================================================

export const EvalGateDecisionSchema = z.object({
	/** True iff every required lane's latest eval passed (and at least one exists). */
	eligible: z.boolean(),
	/** Human-readable reasons a version is NOT eligible (empty when eligible). */
	reasons: z.array(z.string()),
});
export type EvalGateDecision = z.infer<typeof EvalGateDecisionSchema>;

export interface EvalGateOptions {
	/**
	 * Lanes that MUST have a passing latest eval before the version is eligible.
	 * When omitted, every lane present in the summary is required (a version is
	 * eligible iff every lane it was evaluated in currently passes).
	 */
	requiredLanes?: readonly string[];
}

/**
 * Behavioral promotion gate: maps a harness version's eval summary → whether it
 * is eligible to advance its `promotionStatus` toward `certified`.
 *
 * This is the BEHAVIORAL counterpart to `body-certification.ts`'s
 * `assertCertifiable`, which gates on declared CAPABILITY manifests
 * (session.*, events.*, isolation.* — "can this body do the thing"). Capability
 * gates prove a body *can* operate the harness; this eval gate proves the
 * harness version *actually behaves* — its latest evals pass on every required
 * lane. A harness version should only advance toward `certified` when BOTH
 * hold: the body it runs on is certifiable (capability) AND its eval ledger is
 * green (behavioral). The promotion path is expected to call this AND
 * `assertCertifiable` on the underlying body.
 *
 * Pure — no I/O. The eval RUNNER (what executes evals and writes the rows this
 * summarizes) is out of scope; this only reads the recorded ledger.
 */
export function evalGateForCertification(
	summary: HarnessEvalSummary,
	options: EvalGateOptions = {},
): EvalGateDecision {
	const reasons: string[] = [];

	if (summary.total === 0) {
		return {
			eligible: false,
			reasons: ["no eval results recorded for this harness version"],
		};
	}

	const required =
		options.requiredLanes && options.requiredLanes.length > 0
			? options.requiredLanes
			: summary.lanes;

	if (required.length === 0) {
		// total > 0 but no lanes resolved should be impossible, but guard anyway.
		reasons.push("no eval lanes present to gate on");
	}

	for (const lane of required) {
		const pass = summary.latestPassByLane[lane];
		if (pass === undefined) {
			reasons.push(`required lane "${lane}" has no eval result`);
		} else if (!pass) {
			reasons.push(`latest eval on lane "${lane}" did not pass`);
		}
	}

	return { eligible: reasons.length === 0, reasons };
}

// =============================================================================
// MODULE-LOAD SMOKE EXAMPLES
// =============================================================================

// Example fixtures use "org_tedix", Tedix Cloud's own tenant key; an own-account installation never matches it.
/**
 * Representative objects that MUST parse — these double as documentation of the
 * minimal shape an emitter writes and as a module-load assertion (parse throws
 * on drift). Mirrors the `*.parse(...)` declared-manifest pattern in
 * `./body-certification.ts`.
 */
export const EXAMPLE_HARNESS_VERSION: HarnessVersion =
	HarnessVersionSchema.parse({
		id: "hv_01",
		tediId: "tedi_cto",
		orgId: "org_tedix",
		version: "1",
		runtimeKind: "agent",
		components: {
			model: "tedi-system1-v1",
			context_policy: "sha256:ctx-abc",
			retrieval_policy: "sha256:ret-def",
			skill_policy: "sha256:skl-ghi",
			mcp_routing: "sha256:mcp-jkl",
			directive_set: "sha256:dir-mno",
		},
		parentVersionId: null,
		reason: "initial baseline harness",
		promotionStatus: "active",
		createdAt: "2026-05-31T00:00:00.000Z",
	});

export const EXAMPLE_TRACE_BUNDLE: TraceBundle = TraceBundleSchema.parse({
	id: "tb_01",
	tediId: "tedi_cto",
	orgId: "org_tedix",
	conversationId: "conv_01",
	runId: "run_01",
	harnessVersionId: "hv_01",
	createdAt: "2026-05-31T00:00:01.000Z",
	eventIds: ["evt_a", "evt_b", "evt_c"],
	rationaleRecordIds: ["rr_a"],
	artifactIds: ["art_a"],
	evalResultId: null,
	bundleUri: "artifact://tedi_cto/harness/runs/run_01/",
	summary: "answered support escalation using policy fact set",
	outcome: "success",
});

export const EXAMPLE_HARNESS_EVAL_RESULT: HarnessEvalResult =
	HarnessEvalResultSchema.parse({
		id: "her_01",
		harnessVersionId: "hv_01",
		tediId: "tedi_cto",
		orgId: "org_tedix",
		score: 0.87,
		gates: {
			task_success: true,
			grounding: true,
			cost: true,
			latency: true,
			approval_burden: true,
			data_exposure: true,
		},
		passed: true,
		lane: "validation",
		taskSetId: "taskset_support_v1",
		createdAt: "2026-05-31T00:01:00.000Z",
	});

// =============================================================================
// HARNESS EVAL RUN (groups N results) + PROMOTION DECISION
// =============================================================================

const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/**
 * One explicit cache boundary observed during one model step. The evaluator,
 * rather than this contract, decides which stable prompt section owns `key`.
 * `opportunityTokens` is the token count that could have been served from that
 * exact boundary; new prompt growth is deliberately excluded. This avoids the
 * run-length-confounded inference that treats the previous step's whole prompt
 * as a cache opportunity.
 */
export const HarnessEvalCacheBoundarySchema = z
	.object({
		key: z.string().min(1).max(200),
		opportunityTokens: z.number().int().nonnegative(),
		cacheReadTokens: z.number().int().nonnegative(),
	})
	.superRefine((boundary, ctx) => {
		if (boundary.cacheReadTokens > boundary.opportunityTokens) {
			ctx.addIssue({
				code: "custom",
				message: "cacheReadTokens cannot exceed opportunityTokens",
				path: ["cacheReadTokens"],
			});
		}
	});
export type HarnessEvalCacheBoundary = z.infer<
	typeof HarnessEvalCacheBoundarySchema
>;

export const HarnessEvalTrialStepSchema = z
	.object({
		sequence: z.number().int().positive(),
		inputTokens: z.number().int().nonnegative(),
		outputTokens: z.number().int().nonnegative(),
		/** Provider-billed cost in integer micro-US-dollars. */
		costUsdMicros: z.number().int().nonnegative(),
		cacheBoundaries: z.array(HarnessEvalCacheBoundarySchema).default([]),
	})
	.superRefine((step, ctx) => {
		const keys = new Set<string>();
		for (const [index, boundary] of step.cacheBoundaries.entries()) {
			if (keys.has(boundary.key)) {
				ctx.addIssue({
					code: "custom",
					message: `duplicate cache boundary key "${boundary.key}" in one step`,
					path: ["cacheBoundaries", index, "key"],
				});
			}
			keys.add(boundary.key);
		}
	});
export type HarnessEvalTrialStep = z.infer<typeof HarnessEvalTrialStepSchema>;

export const HarnessEvalTrialSchema = z
	.object({
		id: z.string().min(1).max(300),
		ordinal: z.number().int().positive(),
		/** Stable seed supplied to the model/simulator for exact replay. */
		seed: z.string().min(1).max(200),
		/** Digest of the complete task input presented to every trial. */
		inputDigest: Sha256DigestSchema,
		/** Digest of model/provider/sampling/tool settings held fixed across trials. */
		settingsDigest: Sha256DigestSchema,
		sourceTraceBundleId: z.string().min(1).max(300).optional(),
		status: z.enum(["completed", "error", "cancelled", "timed_out"]),
		score: z.number().nullable(),
		passed: z.boolean().nullable(),
		steps: z.array(HarnessEvalTrialStepSchema),
	})
	.superRefine((trial, ctx) => {
		if (trial.status === "completed") {
			if (trial.score === null) {
				ctx.addIssue({
					code: "custom",
					message: "completed trials require a score",
					path: ["score"],
				});
			}
			if (trial.passed === null) {
				ctx.addIssue({
					code: "custom",
					message: "completed trials require a pass verdict",
					path: ["passed"],
				});
			}
		} else if (trial.score !== null || trial.passed !== null) {
			ctx.addIssue({
				code: "custom",
				message: "non-completed trials cannot claim a score or pass verdict",
			});
		}
		const sequences = new Set<number>();
		for (const [index, step] of trial.steps.entries()) {
			if (sequences.has(step.sequence)) {
				ctx.addIssue({
					code: "custom",
					message: `duplicate step sequence ${step.sequence}`,
					path: ["steps", index, "sequence"],
				});
			}
			sequences.add(step.sequence);
		}
	});
export type HarnessEvalTrial = z.infer<typeof HarnessEvalTrialSchema>;

export const HarnessEvalBoundarySummarySchema = z.object({
	key: z.string(),
	opportunities: z.number().int().nonnegative(),
	opportunityTokens: z.number().int().nonnegative(),
	cacheReadTokens: z.number().int().nonnegative(),
	cacheBreakTokens: z.number().int().nonnegative(),
	hitRate: z.number().min(0).max(1).nullable(),
	breakRate: z.number().min(0).max(1).nullable(),
});
export type HarnessEvalBoundarySummary = z.infer<
	typeof HarnessEvalBoundarySummarySchema
>;

export const HarnessEvalTrialSummarySchema = z.object({
	trialCount: z.number().int().nonnegative(),
	completedTrials: z.number().int().nonnegative(),
	totalInputTokens: z.number().int().nonnegative(),
	totalOutputTokens: z.number().int().nonnegative(),
	totalCostUsdMicros: z.number().int().nonnegative(),
	meanCostUsdMicros: z.number().nonnegative(),
	cacheOpportunityTokens: z.number().int().nonnegative(),
	cacheReadTokens: z.number().int().nonnegative(),
	cacheBreakTokens: z.number().int().nonnegative(),
	cacheHitRate: z.number().min(0).max(1).nullable(),
	cacheBreakRate: z.number().min(0).max(1).nullable(),
	boundaries: z.array(HarnessEvalBoundarySummarySchema),
});
export type HarnessEvalTrialSummary = z.infer<
	typeof HarnessEvalTrialSummarySchema
>;

const HarnessEvalRunReportShapeSchema = z.object({
	protocolVersion: z.literal(1),
	/** Stable identity for retries of this complete trial cohort. */
	replayGroupKey: z.string().min(1).max(300),
	trials: z.array(HarnessEvalTrialSchema).min(2).max(100),
	summary: HarnessEvalTrialSummarySchema,
});

/**
 * Reproducible multi-trial evidence attached to one eval run. All trials replay
 * the same input and settings digests; only the stable seed/ordinal may vary.
 * Summary values are verified against leaf step telemetry at the API boundary.
 */
export const HarnessEvalRunReportSchema =
	HarnessEvalRunReportShapeSchema.superRefine((report, ctx) => {
		const ids = new Set<string>();
		const ordinals = new Set<number>();
		const inputDigest = report.trials[0]?.inputDigest;
		const settingsDigest = report.trials[0]?.settingsDigest;
		for (const [index, trial] of report.trials.entries()) {
			if (ids.has(trial.id)) {
				ctx.addIssue({
					code: "custom",
					message: `duplicate trial id "${trial.id}"`,
					path: ["trials", index, "id"],
				});
			}
			if (ordinals.has(trial.ordinal)) {
				ctx.addIssue({
					code: "custom",
					message: `duplicate trial ordinal ${trial.ordinal}`,
					path: ["trials", index, "ordinal"],
				});
			}
			if (trial.inputDigest !== inputDigest) {
				ctx.addIssue({
					code: "custom",
					message: "every trial must replay the same input digest",
					path: ["trials", index, "inputDigest"],
				});
			}
			if (trial.settingsDigest !== settingsDigest) {
				ctx.addIssue({
					code: "custom",
					message: "every trial must replay the same settings digest",
					path: ["trials", index, "settingsDigest"],
				});
			}
			ids.add(trial.id);
			ordinals.add(trial.ordinal);
		}
		for (let ordinal = 1; ordinal <= report.trials.length; ordinal += 1) {
			if (!ordinals.has(ordinal)) {
				ctx.addIssue({
					code: "custom",
					message: "trial ordinals must be contiguous from 1",
					path: ["trials"],
				});
				break;
			}
		}
		const expected = summarizeHarnessEvalTrials(report.trials);
		if (JSON.stringify(report.summary) !== JSON.stringify(expected)) {
			ctx.addIssue({
				code: "custom",
				message: "summary must equal the canonical trial telemetry fold",
				path: ["summary"],
			});
		}
	});
export type HarnessEvalRunReport = z.infer<typeof HarnessEvalRunReportSchema>;

/** Fold explicit per-boundary opportunities; never infer them from run length. */
export function summarizeHarnessEvalTrials(
	trials: readonly HarnessEvalTrial[],
): HarnessEvalTrialSummary {
	let completedTrials = 0;
	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let totalCostUsdMicros = 0;
	const byBoundary = new Map<
		string,
		{
			opportunities: number;
			opportunityTokens: number;
			cacheReadTokens: number;
		}
	>();
	for (const trial of trials) {
		if (trial.status === "completed") completedTrials += 1;
		for (const step of trial.steps) {
			totalInputTokens += step.inputTokens;
			totalOutputTokens += step.outputTokens;
			totalCostUsdMicros += step.costUsdMicros;
			for (const boundary of step.cacheBoundaries) {
				const aggregate = byBoundary.get(boundary.key) ?? {
					opportunities: 0,
					opportunityTokens: 0,
					cacheReadTokens: 0,
				};
				aggregate.opportunities += 1;
				aggregate.opportunityTokens += boundary.opportunityTokens;
				aggregate.cacheReadTokens += boundary.cacheReadTokens;
				byBoundary.set(boundary.key, aggregate);
			}
		}
	}
	const boundaries = [...byBoundary.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, value]): HarnessEvalBoundarySummary => {
			const cacheBreakTokens = value.opportunityTokens - value.cacheReadTokens;
			return {
				key,
				...value,
				cacheBreakTokens,
				hitRate:
					value.opportunityTokens === 0
						? null
						: value.cacheReadTokens / value.opportunityTokens,
				breakRate:
					value.opportunityTokens === 0
						? null
						: cacheBreakTokens / value.opportunityTokens,
			};
		});
	const cacheOpportunityTokens = boundaries.reduce(
		(total, boundary) => total + boundary.opportunityTokens,
		0,
	);
	const cacheReadTokens = boundaries.reduce(
		(total, boundary) => total + boundary.cacheReadTokens,
		0,
	);
	const cacheBreakTokens = cacheOpportunityTokens - cacheReadTokens;
	return {
		trialCount: trials.length,
		completedTrials,
		totalInputTokens,
		totalOutputTokens,
		totalCostUsdMicros,
		meanCostUsdMicros:
			trials.length === 0 ? 0 : totalCostUsdMicros / trials.length,
		cacheOpportunityTokens,
		cacheReadTokens,
		cacheBreakTokens,
		cacheHitRate:
			cacheOpportunityTokens === 0
				? null
				: cacheReadTokens / cacheOpportunityTokens,
		cacheBreakRate:
			cacheOpportunityTokens === 0
				? null
				: cacheBreakTokens / cacheOpportunityTokens,
		boundaries,
	};
}

/**
 * One execution of a task set against one harness version on one lane — the
 * grouping an eval runner produces. N
 * `HarnessEvalResult` rows roll up into one run; the run's `eligible` is the
 * gate decision over its own results. Persisted in `harness_eval_runs`.
 */
export const HarnessEvalRunSchema = z.object({
	id: z.string(),
	harnessVersionId: z.string(),
	tediId: z.string(),
	orgId: z.string().optional(),
	/** Which lane this run scored (search/validation/locked-test/canary). */
	lane: z.string(),
	taskSetId: z.string(),
	total: z.number().int(),
	passed: z.number().int(),
	failed: z.number().int(),
	/** Mean score across the run's results. */
	meanScore: z.number(),
	/** Run-level gate: did the lane pass (no failing task)? */
	eligible: z.boolean(),
	/** Optional replayable multi-trial evidence and canonical cost/cache fold. */
	report: HarnessEvalRunReportSchema.nullable().optional(),
	createdAt: z.string(),
	metadata: z.record(z.string(), JsonValueSchema).optional(),
});
export type HarnessEvalRun = z.infer<typeof HarnessEvalRunSchema>;

// =============================================================================
// SUBJECT-KEYED EVAL RESULT + EVAL RUN (kernel / non-tedi actors)
// =============================================================================

/**
 * Subject-keyed eval result — mirrors `HarnessEvalResultSchema` but with
 * `subjectKind` + `subjectId` instead of `tediId NOT NULL`. `tediId` is
 * nullable (null for kernel rows). Used by `harness_subject_eval_results`.
 */
export const HarnessSubjectEvalResultSchema = z.object({
	id: z.string(),
	subjectKind: HarnessSubjectKindSchema,
	subjectId: z.string(),
	tediId: z.string().nullable().optional(),
	orgId: z.string().optional(),
	harnessVersionId: z.string(),
	score: z.number(),
	gates: z.record(z.string(), z.boolean()),
	passed: z.boolean(),
	lane: z.string().nullable().optional(),
	taskSetId: z.string().nullable().optional(),
	createdAt: z.string(),
	metadata: z.record(z.string(), JsonValueSchema).optional(),
});
export type HarnessSubjectEvalResult = z.infer<
	typeof HarnessSubjectEvalResultSchema
>;

/**
 * Subject-keyed eval run — mirrors `HarnessEvalRunSchema` with the same
 * substitutions as `HarnessSubjectEvalResultSchema`.
 */
export const HarnessSubjectEvalRunSchema = z.object({
	id: z.string(),
	subjectKind: HarnessSubjectKindSchema,
	subjectId: z.string(),
	tediId: z.string().nullable().optional(),
	orgId: z.string().optional(),
	harnessVersionId: z.string(),
	lane: z.string(),
	taskSetId: z.string(),
	total: z.number().int(),
	passed: z.number().int(),
	failed: z.number().int(),
	meanScore: z.number(),
	eligible: z.boolean(),
	report: HarnessEvalRunReportSchema.nullable().optional(),
	createdAt: z.string(),
	metadata: z.record(z.string(), JsonValueSchema).optional(),
});
export type HarnessSubjectEvalRun = z.infer<typeof HarnessSubjectEvalRunSchema>;

/**
 * The lane each promotion stage gates on, and the status it advances to. A
 * version climbs: proposed --(validation passes)--> evaluated --(locked-test
 * passes)--> canary --(canary passes)--> promoted. A failing required lane sends
 * it to `rejected`. `active` (the live pointer), `promoted`, `rejected`, and
 * `rolled_back` are terminal for the automatic ladder — `active`/`rolled_back`
 * are managed by the runtime/operator, not the eval gate. Mirrors
 * `docs/engineering/cognition/harness.md` § Promotion Gate And Eval Splits.
 */
export const PROMOTION_STAGE_LANE: Readonly<
	Partial<Record<HarnessPromotionStatus, string>>
> = { proposed: "validation", evaluated: "locked-test", canary: "canary" };
const PROMOTION_STAGE_NEXT: Readonly<
	Partial<Record<HarnessPromotionStatus, HarnessPromotionStatus>>
> = { proposed: "evaluated", evaluated: "canary", canary: "promoted" };

export const PromotionDecisionSchema = z.object({
	/** The status the version should move to (= current when it cannot advance). */
	nextStatus: HarnessPromotionStatusSchema,
	/** True when nextStatus differs from the current status. */
	advanced: z.boolean(),
	/** Human-readable why. */
	reasons: z.array(z.string()),
});
export type PromotionDecision = z.infer<typeof PromotionDecisionSchema>;

/**
 * Decide the next promotion status for a harness version from its eval summary.
 * PURE — no I/O. The caller persists `nextStatus` only when `advanced` (or when
 * it transitions to `rejected`). Does NOT auto-promote to `active`: clearing the
 * `canary` gate yields `promoted`; making a `promoted` version the live `active`
 * pointer is a separate runtime/operator step (single-active invariant).
 */
export function decidePromotion(
	current: HarnessPromotionStatus,
	summary: HarnessEvalSummary,
): PromotionDecision {
	const stay = (reason: string): PromotionDecision => ({
		nextStatus: current,
		advanced: false,
		reasons: [reason],
	});

	const requiredLane = PROMOTION_STAGE_LANE[current];
	if (!requiredLane)
		return stay(`status "${current}" is terminal for the eval ladder`);
	if (summary.total === 0)
		return stay("no eval results recorded for this version");

	const lanePass = summary.latestPassByLane[requiredLane];
	if (lanePass === undefined)
		return stay(
			`awaiting a "${requiredLane}" eval before leaving "${current}"`,
		);
	if (lanePass === false)
		return {
			nextStatus: "rejected",
			advanced: true,
			reasons: [`"${requiredLane}" lane failed — version rejected`],
		};

	const next = PROMOTION_STAGE_NEXT[current]!;
	return {
		nextStatus: next,
		advanced: true,
		reasons: [
			`"${requiredLane}" lane passed — advancing "${current}" → "${next}"`,
		],
	};
}
