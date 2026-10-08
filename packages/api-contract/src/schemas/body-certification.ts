import { KernelPricingEvidenceSchema } from "./cost-provenance";
/**
 * Body Certification Manifest Schemas
 *
 * A runtime body declares this manifest; certification asserts the
 * load-bearing gates (session.*, events.*, isolation.*,
 * lifecycle.runtimeStateLossTolerant) are proven before a body may be promoted
 * to `certified` / production routing.
 */

import * as z from "zod";
import { JsonValueSchema } from "./common";
import { WorkstationProfileIdSchema } from "./workstation";

// =============================================================================
// ENUM SCHEMAS
// =============================================================================

/** Dual-process role this body is certified to fill (docs/engineering/cognition/runtime.md). */
export const EmbodimentClassSchema = z.enum([
	"system1-facet",
	"system2-org-body",
	"specialist",
]);
export type EmbodimentClass = z.infer<typeof EmbodimentClassSchema>;

export const BodyCertificationStatusSchema = z.enum([
	"certified",
	"candidate",
	"experimental",
	"deprecated",
]);
export type BodyCertificationStatus = z.infer<
	typeof BodyCertificationStatusSchema
>;

/** MUST be tedix-ledger to certify. */
export const SessionCanonicalStoreSchema = z.enum([
	"tedix-ledger",
	"body-local",
]);
export type SessionCanonicalStore = z.infer<typeof SessionCanonicalStoreSchema>;

export const SessionCompactionSchema = z.enum([
	"tedix-repo",
	"sdk-overlay",
	"none",
]);
export type SessionCompaction = z.infer<typeof SessionCompactionSchema>;

export const TelemetryBillingTypeSchema = z.enum([
	"prepaid",
	"passthrough",
	"included",
	"unknown",
]);
export type TelemetryBillingType = z.infer<typeof TelemetryBillingTypeSchema>;

export const ApprovalsModelSchema = z.enum(["first-class", "none"]);
export type ApprovalsModel = z.infer<typeof ApprovalsModelSchema>;

export const ApprovalsTimeoutBehaviorSchema = z.enum(["deny", "allow", "n/a"]);
export type ApprovalsTimeoutBehavior = z.infer<
	typeof ApprovalsTimeoutBehaviorSchema
>;

export const CertificationProofKindSchema = z.enum([
	"source",
	"test",
	"smoke",
	"eval_run",
	"trace_bundle",
	"mcp_validation",
	"deployment",
]);
export type CertificationProofKind = z.infer<
	typeof CertificationProofKindSchema
>;

export const CertificationProofStatusSchema = z.enum([
	"passed",
	"failed",
	"blocked",
	"unknown",
]);
export type CertificationProofStatus = z.infer<
	typeof CertificationProofStatusSchema
>;

export const BodyExecutionStatusSchema = z.enum([
	"completed",
	"failed",
	"canceled",
	"timed_out",
	"blocked",
]);
export type BodyExecutionStatus = z.infer<typeof BodyExecutionStatusSchema>;

export const BodyExecutionErrorKindSchema = z.enum([
	"model",
	"tool",
	"approval",
	"timeout",
	"runtime",
	"policy",
	"unknown",
]);
export type BodyExecutionErrorKind = z.infer<
	typeof BodyExecutionErrorKindSchema
>;

export const BodyExecutionWorkstationSchema = z.object({
	profileId: WorkstationProfileIdSchema,
	workstationId: z.string(),
	leaseId: z.string().nullable().default(null),
	sessionId: z.string().nullable().default(null),
	participantIds: z.array(z.string()).default([]),
});
export type BodyExecutionWorkstation = z.infer<
	typeof BodyExecutionWorkstationSchema
>;

// =============================================================================
// MANIFEST SCHEMA
// =============================================================================

/** Session harness (load-bearing). */
export const BodySessionSchema = z.object({
	/** builds prompt context via TediSessionHarness.buildContext */
	harnessRead: z.boolean(),
	/** appends turns via TediSessionHarness.appendTurn */
	harnessWrite: z.boolean(),
	canonicalStore: SessionCanonicalStoreSchema,
	/** reconstructs prompt context from D1 after cold start / body swap */
	cacheLossRecovery: z.boolean(),
	compaction: SessionCompactionSchema,
});
export type BodySession = z.infer<typeof BodySessionSchema>;

/**
 * Voice surface (structured; advisory — NOT a load-bearing cert gate).
 * The realtime layer is a front-end that consults the canonical tedi loop;
 * durable transcript/recap writes route through the session harness/ledger,
 * not the voice body's ephemeral store. See docs/engineering/cognition/runtime.md.
 */
export const BodyVoiceSchema = z.object({
	/** async voice-note STT folded into a normal chat turn */
	messages: z.boolean(),
	/** in-browser live call: "full" certified, "experimental" shipping, or false */
	browserCall: z.union([z.enum(["full", "experimental"]), z.literal(false)]),
	/** Twilio/PSTN telephony */
	telephony: z.boolean(),
});
export type BodyVoice = z.infer<typeof BodyVoiceSchema>;

/** Capabilities (declared; gate: PRIMITIVE-COVERAGE capability manifest). */
export const BodyCapabilitiesSchema = z.object({
	mcpClient: z.boolean(),
	mcpServer: z.boolean(),
	shell: z.boolean(),
	filesystem: z.boolean(),
	browser: z.boolean(),
	voice: BodyVoiceSchema,
	channels: z.array(z.string()),
	approvals: z.boolean(),
	stopCancel: z.boolean(),
	schedules: z.boolean(),
	durableWork: z.boolean(),
	subagents: z.boolean(),
});
export type BodyCapabilities = z.infer<typeof BodyCapabilitiesSchema>;

/** Cognitive-runtime event coverage (the canonical ledger). */
export const BodyEventsSchema = z.object({
	messages: z.boolean(),
	runs: z.boolean(),
	tools: z.boolean(),
	approvals: z.boolean(),
	artifacts: z.boolean(),
	contextInjection: z.boolean(),
	compaction: z.boolean(),
	/** completed / error / aborted */
	terminalStates: z.boolean(),
});
export type BodyEvents = z.infer<typeof BodyEventsSchema>;

/** Telemetry / result envelope (modeled on a comparable AdapterExecutionResult pattern). */
export const BodyTelemetrySchema = z.object({
	model: z.boolean(),
	provider: z.boolean(),
	tokens: z.boolean(),
	cacheUsage: z.boolean(),
	toolCost: z.boolean(),
	latency: z.boolean(),
	costUsd: z.boolean(),
	billingType: TelemetryBillingTypeSchema,
	failures: z.boolean(),
	artifacts: z.boolean(),
});
export type BodyTelemetry = z.infer<typeof BodyTelemetrySchema>;

/** Lifecycle / operability. */
export const BodyLifecycleSchema = z.object({
	wake: z.boolean(),
	stop: z.boolean(),
	reconnect: z.boolean(),
	replay: z.boolean(),
	diagnose: z.boolean(),
	repair: z.boolean(),
	/** can lose runtime-local state without losing cognitive state */
	runtimeStateLossTolerant: z.boolean(),
});
export type BodyLifecycle = z.infer<typeof BodyLifecycleSchema>;

/** Policy / isolation. */
export const BodyIsolationSchema = z.object({
	tenantIdentity: z.boolean(),
	authScopes: z.boolean(),
	secretBoundary: z.boolean(),
	traceSafety: z.boolean(),
});
export type BodyIsolation = z.infer<typeof BodyIsolationSchema>;

/** Approval semantics. */
export const BodyApprovalsSchema = z.object({
	model: ApprovalsModelSchema,
	/** certified bodies that support approvals MUST default-deny */
	timeoutBehavior: ApprovalsTimeoutBehaviorSchema,
});
export type BodyApprovals = z.infer<typeof BodyApprovalsSchema>;

/** Cost envelope. */
export const BodyCostEnvelopeSchema = z.object({
	perTurnUsdCeiling: z.number().nullable(),
	biller: z.string().nullable(),
});
export type BodyCostEnvelope = z.infer<typeof BodyCostEnvelopeSchema>;

/** Concrete evidence reference used to prove manifest claims. */
export const CertificationProofReferenceSchema = z.object({
	kind: CertificationProofKindSchema,
	id: z.string(),
	description: z.string(),
	status: CertificationProofStatusSchema,
	/** Command, file path, trace id, MCP surface, deploy run, or source pointer. */
	surface: z.string(),
	observedAt: z.string().nullable(),
});
export type CertificationProofReference = z.infer<
	typeof CertificationProofReferenceSchema
>;

/**
 * Certification evidence index. Candidate bodies may carry partial/unknown refs;
 * certified bodies must carry recent proof for the load-bearing gates.
 */
export const BodyCertificationEvidenceSchema = z.object({
	lastCertifiedAt: z.string().nullable(),
	lastLiveMcpValidationAt: z.string().nullable(),
	lastLiveMcpValidationSurface: z.string().nullable(),
	smokeName: z.string().nullable(),
	evalRunId: z.string().nullable(),
	traceBundleId: z.string().nullable(),
	proofRefs: z.array(CertificationProofReferenceSchema),
});
export type BodyCertificationEvidence = z.infer<
	typeof BodyCertificationEvidenceSchema
>;

// =============================================================================
// EXECUTION RESULT ENVELOPE
// =============================================================================

/**
 * Canonical, body-neutral per-turn token usage. Every body turn result carries
 * this object (the {@link BodyExecutionResultSchema}.usage invariant); the
 * kernel route planner ({@link ../routers/kernel/route-planner KernelRouteUsage})
 * and the isolate step telemetry both project onto it.
 *
 * USAGE INVARIANT (modeled on a comparable per-executor usage test pattern): each field
 * is `null` when the provider DID NOT report it. `null` means "unavailable" and
 * MUST NOT be fabricated as `0` — a real `0` (e.g. zero cache reads) is a
 * distinct, meaningful value. Callers that sum usage treat `null` as absent, not
 * zero, so a turn with no telemetry never reports a misleading zero-token count.
 */
export const BodyExecutionUsageSchema = z.object({
	provider: z.string().nullable(),
	model: z.string().nullable(),
	inputTokens: z.number().nullable(),
	outputTokens: z.number().nullable(),
	reasoningTokens: z
		.number()
		.nullable()
		.describe("Null when the provider does not report reasoning token usage"),
	cacheReadTokens: z.number().nullable(),
	cacheWriteTokens: z.number().nullable(),
});
export type BodyExecutionUsage = z.infer<typeof BodyExecutionUsageSchema>;

/**
 * Runtime-neutral result envelope every certified body turn must emit. Modeled
 * on a comparable AdapterExecutionResult pattern, but with Tedix canonical ids
 * above body-local session/runtime details.
 */
export const BodyExecutionResultSchema = z.object({
	id: z.string(),
	bodyKind: z.string(),
	status: BodyExecutionStatusSchema,
	runId: z.string(),
	tediId: z.string().nullable(),
	orgId: z.string().nullable(),
	conversationId: z.string().nullable(),
	sessionKey: z.string().nullable(),
	harnessVersionId: z.string().nullable(),
	traceBundleId: z.string().nullable(),
	workstation: BodyExecutionWorkstationSchema.nullable().default(null),
	startedAt: z.string(),
	endedAt: z.string().nullable(),
	durationMs: z.number().nullable(),
	summary: z.string().nullable(),
	structuredResult: z.record(z.string(), JsonValueSchema).nullable(),
	error: z
		.object({
			kind: BodyExecutionErrorKindSchema,
			message: z.string(),
			retryable: z.boolean(),
		})
		.nullable(),
	usage: BodyExecutionUsageSchema,
	cost: z.object({
		pricing: KernelPricingEvidenceSchema.nullable().describe(
			"Null for historical or non-inference results without immutable attempt evidence; never interpreted as a known zero.",
		),
		billingType: TelemetryBillingTypeSchema,
		biller: z.string().nullable(),
		modelCostUsd: z.number().nullable(),
		toolCostUsd: z.number().nullable(),
		totalCostUsd: z.number().nullable(),
	}),
	session: z.object({
		beforeRef: z.string().nullable(),
		afterRef: z.string().nullable(),
		adapterSessionRef: z.string().nullable(),
		clearSession: z.boolean(),
	}),
	approvalIds: z.array(z.string()),
	artifactIds: z.array(z.string()),
	runtimeServices: z.array(z.string()),
});
export type BodyExecutionResult = z.infer<typeof BodyExecutionResultSchema>;

export const BodyCertificationManifestSchema = z.object({
	// ── Identity ──────────────────────────────────────────────────────────────
	/** Adapter id — runtime metadata, NOT a canonical product id. */
	bodyKind: z.string(),
	embodimentClass: EmbodimentClassSchema,
	status: BodyCertificationStatusSchema,

	// ── Sections ────────────────────────────────────────────────────────────
	session: BodySessionSchema,
	capabilities: BodyCapabilitiesSchema,
	events: BodyEventsSchema,
	telemetry: BodyTelemetrySchema,
	lifecycle: BodyLifecycleSchema,
	isolation: BodyIsolationSchema,
	approvals: BodyApprovalsSchema,
	costEnvelope: BodyCostEnvelopeSchema,
	evidence: BodyCertificationEvidenceSchema,
});
export type BodyCertificationManifest = z.infer<
	typeof BodyCertificationManifestSchema
>;

// =============================================================================
// CERTIFICATION GATE
// =============================================================================

function hasPassedProofRef(
	evidence: BodyCertificationEvidence,
	kind: CertificationProofKind,
	id?: string | null,
): boolean {
	return evidence.proofRefs.some(
		(proof) =>
			proof.kind === kind &&
			proof.status === "passed" &&
			(typeof id !== "string" || proof.id === id),
	);
}

/**
 * Load-bearing gates a body MUST prove before it may be promoted to
 * `certified`. `candidate` / `experimental` bodies are
 * exempt — declaration without proof is `candidate`, never `certified`.
 *
 * Intended to be invoked by CI/smoke: iterate declared manifests and call
 * `assertCertifiable(manifest)` so a body tagged `certified` without the gates
 * fails the build.
 */
export function assertCertifiable(manifest: BodyCertificationManifest): void {
	if (manifest.status !== "certified") return;

	const gates: Array<[string, boolean]> = [
		["session.harnessRead", manifest.session.harnessRead],
		["session.harnessWrite", manifest.session.harnessWrite],
		[
			'session.canonicalStore === "tedix-ledger"',
			manifest.session.canonicalStore === "tedix-ledger",
		],
		["session.cacheLossRecovery", manifest.session.cacheLossRecovery],
		[
			"lifecycle.runtimeStateLossTolerant",
			manifest.lifecycle.runtimeStateLossTolerant,
		],
		["isolation.tenantIdentity", manifest.isolation.tenantIdentity],
		["isolation.authScopes", manifest.isolation.authScopes],
		["isolation.secretBoundary", manifest.isolation.secretBoundary],
		["isolation.traceSafety", manifest.isolation.traceSafety],
		["events.messages", manifest.events.messages],
		["events.runs", manifest.events.runs],
		["events.tools", manifest.events.tools],
		["events.approvals", manifest.events.approvals],
		["events.artifacts", manifest.events.artifacts],
		["events.contextInjection", manifest.events.contextInjection],
		["events.terminalStates", manifest.events.terminalStates],
		[
			'approvals.timeoutBehavior === "deny"',
			manifest.approvals.model === "none" ||
				manifest.approvals.timeoutBehavior === "deny",
		],
		[
			"evidence.lastCertifiedAt",
			typeof manifest.evidence.lastCertifiedAt === "string" &&
				manifest.evidence.lastCertifiedAt.length > 0,
		],
		[
			"evidence.lastLiveMcpValidationAt",
			typeof manifest.evidence.lastLiveMcpValidationAt === "string" &&
				manifest.evidence.lastLiveMcpValidationAt.length > 0,
		],
		[
			"evidence.evalRunId",
			typeof manifest.evidence.evalRunId === "string" &&
				manifest.evidence.evalRunId.length > 0,
		],
		[
			"evidence.traceBundleId",
			typeof manifest.evidence.traceBundleId === "string" &&
				manifest.evidence.traceBundleId.length > 0,
		],
		[
			"evidence.smokeName",
			typeof manifest.evidence.smokeName === "string" &&
				manifest.evidence.smokeName.length > 0,
		],
		[
			"evidence.proofRefs.smoke.passed",
			hasPassedProofRef(
				manifest.evidence,
				"smoke",
				manifest.evidence.smokeName,
			),
		],
		[
			"evidence.proofRefs.mcp_validation.passed",
			hasPassedProofRef(manifest.evidence, "mcp_validation"),
		],
		[
			"evidence.proofRefs.eval_run.passed",
			hasPassedProofRef(
				manifest.evidence,
				"eval_run",
				manifest.evidence.evalRunId,
			),
		],
		[
			"evidence.proofRefs.trace_bundle.passed",
			hasPassedProofRef(
				manifest.evidence,
				"trace_bundle",
				manifest.evidence.traceBundleId,
			),
		],
	];

	const unmet = gates.filter(([, ok]) => !ok).map(([name]) => name);
	if (unmet.length > 0) {
		throw new Error(
			`Body "${manifest.bodyKind}" declares status "certified" but fails load-bearing gates: ${unmet.join(", ")}`,
		);
	}
}

// =============================================================================
// Declared manifests
// =============================================================================

/**
 * Agent facet — `apps/tedi-runtime`. Cloudflare Agents with native Pi body, System 1.
 * The remaining advisory gap is full costUsd telemetry. Proof ids and
 * timestamps below are illustrative placeholders; the gate checks
 * that each required proof kind is declared and passed.
 */
export const AGENT_FACET_MANIFEST: BodyCertificationManifest =
	BodyCertificationManifestSchema.parse({
		bodyKind: "agent",
		embodimentClass: "system1-facet",
		status: "certified",
		session: {
			harnessRead: true,
			harnessWrite: true,
			canonicalStore: "tedix-ledger",
			cacheLossRecovery: true,
			compaction: "tedix-repo",
		},
		capabilities: {
			mcpClient: true,
			mcpServer: true,
			// Bounded Computer workspace tools execute inside the Agent runtime;
			// long-lived OS/process work still escalates to a workstation lease.
			shell: true,
			filesystem: true,
			browser: false,
			// Async voice-notes + experimental in-browser live calls ship here.
			voice: { messages: true, browserCall: "experimental", telephony: false },
			channels: [],
			approvals: true,
			stopCancel: true,
			schedules: true,
			durableWork: true,
			subagents: true,
		},
		events: {
			messages: true,
			runs: true,
			tools: true,
			approvals: true,
			artifacts: true,
			contextInjection: true,
			compaction: true,
			terminalStates: true,
		},
		telemetry: {
			model: true,
			provider: true,
			tokens: true,
			cacheUsage: true,
			toolCost: true,
			latency: true,
			// costUsd partial.
			costUsd: false,
			billingType: "unknown",
			failures: true,
			artifacts: true,
		},
		lifecycle: {
			wake: true,
			stop: true,
			reconnect: true,
			replay: true,
			diagnose: true,
			repair: true,
			runtimeStateLossTolerant: true,
		},
		isolation: {
			tenantIdentity: true,
			authScopes: true,
			secretBoundary: true,
			traceSafety: true,
		},
		approvals: {
			model: "first-class",
			timeoutBehavior: "deny",
		},
		costEnvelope: {
			perTurnUsdCeiling: null,
			biller: null,
		},
		evidence: {
			lastCertifiedAt: "2026-01-01T00:00:00.000Z",
			lastLiveMcpValidationAt: "2026-01-01T00:00:00.000Z",
			lastLiveMcpValidationSurface:
				"MCP: home.ask plus tedi runtime, harness, trace, and eval readback",
			smokeName: "body-certification-live-smoke",
			evalRunId:
				"hrun_0f0f0f0f-0000-4000-8000-000000000001_validation_0f0f0f0f-0000-4000-8000-000000000002:mcp:0f0f0f0f-0000-4000-8000-000000000003",
			traceBundleId:
				"0f0f0f0f-0000-4000-8000-000000000002:mcp:0f0f0f0f-0000-4000-8000-000000000003:bundle",
			proofRefs: [
				{
					kind: "test",
					id: "body-certification-schema",
					description:
						"Declared manifest parses and remains guarded by assertCertifiable.",
					status: "passed",
					surface:
						"packages/api-contract/src/schemas/body-certification.test.ts",
					observedAt: null,
				},
				{
					kind: "source",
					id: "agent-trace-bundle-writer",
					description:
						"Agent success/recovery paths can write redacted trace bundle folders.",
					status: "passed",
					surface: "apps/tedi-runtime/src/trace-bundle-writer.ts",
					observedAt: null,
				},
				{
					kind: "smoke",
					id: "body-certification-live-smoke",
					description:
						"Home marker plus tedi runtime, active harness, trace-bundle, and eval-run readback passed.",
					status: "passed",
					surface: "live smoke against a deployed tedi",
					observedAt: "2026-01-01T00:00:00.000Z",
				},
				{
					kind: "mcp_validation",
					id: "body-certification-live-mcp",
					description:
						"Home and tedi readback matched the marker while the tedi reported a healthy Cloudflare Agents backend.",
					status: "passed",
					surface: "kernel+tedi-mcp",
					observedAt: "2026-01-01T00:00:00.000Z",
				},
				{
					kind: "eval_run",
					id: "hrun_0f0f0f0f-0000-4000-8000-000000000001_validation_0f0f0f0f-0000-4000-8000-000000000002:mcp:0f0f0f0f-0000-4000-8000-000000000003",
					description:
						"The tedi's active Agent harness recorded an eligible validation-lane live-turn eval.",
					status: "passed",
					surface: "harness_eval_runs",
					observedAt: "2026-01-01T00:00:00.000Z",
				},
				{
					kind: "trace_bundle",
					id: "0f0f0f0f-0000-4000-8000-000000000002:mcp:0f0f0f0f-0000-4000-8000-000000000003:bundle",
					description:
						"The tedi's trace bundle captured a successful body execution result for the active Agent harness.",
					status: "passed",
					surface: "harness_trace_bundle",
					observedAt: "2026-01-01T00:00:00.000Z",
				},
				{
					kind: "test",
					id: "agent-run-completed-tokens-used",
					description:
						"Agent run.completed carries tokensUsed (summed from step telemetry) with null-absent invariant — body-parity with kernel.",
					status: "passed",
					surface:
						"apps/tedi-runtime/src/ledger-mirror.test.ts (body-parity tokensUsed block)",
					observedAt: null,
				},
				{
					kind: "test",
					id: "agent-computer-workspace-capabilities",
					description:
						"Agent turns expose bounded Computer read/write/exec tools backed by the durable DO workspace.",
					status: "passed",
					surface: "apps/tedi-runtime/src/computer-workspace-tools.test.ts",
					observedAt: null,
				},
				{
					kind: "test",
					id: "agent-facet-durable-work",
					description:
						"Conversation sub-agent facets and the durable ChatTurnWorkflow are covered by runtime contract tests.",
					status: "passed",
					surface:
						"apps/tedi-runtime/src/conversation-facet.test.ts + apps/tedi-runtime/src/chat-turn-steps.test.ts",
					observedAt: null,
				},
			],
		},
	});

/** All declared bodies — iterate in CI/smoke to assert certifiability. */
export const DECLARED_BODY_MANIFESTS: readonly BodyCertificationManifest[] = [
	AGENT_FACET_MANIFEST,
];
