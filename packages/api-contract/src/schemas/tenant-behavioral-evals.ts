import { z } from "zod";

export const TenantBehavioralEvalLaneSchema = z.literal(
	"kernel_route_observe_v1",
);
export const TenantBehavioralEvalSeveritySchema = z.enum(["gate", "soft"]);
export const TenantBehavioralEvalDispositionSchema = z.enum([
	"passed",
	"failed",
	"unresolved",
	"void",
]);
export const TenantBehavioralEvalRunManifestSchema = z.strictObject({
	schemaVersion: z.literal(1),
	definitionId: z.string(),
	revisionId: z.string(),
	revisionNumber: z.number().int().positive(),
	specDigest: z.string(),
	caseIds: z.array(z.string()),
	assetTediId: z.string(),
	lane: TenantBehavioralEvalLaneSchema,
	executionPolicy: z.literal("observe_only"),
	modelSelection: z.literal("kernel_runtime_default"),
	requestedModelRef: z
		.null()
		.describe(
			"This observe-only Home lane does not request a per-turn model ref.",
		),
	capturedAt: z.string(),
});
export type TenantBehavioralEvalRunManifest = z.infer<
	typeof TenantBehavioralEvalRunManifestSchema
>;
export const TenantBehavioralEvalExecutionReceiptSchema = z.strictObject({
	schemaVersion: z.literal(1),
	source: z.literal("home_terminal_metadata"),
	observedProvider: z
		.string()
		.nullable()
		.describe("Null when Home did not report one provider for the turn."),
	observedModel: z
		.string()
		.nullable()
		.describe("Null when Home did not report one model for the turn."),
	inputTokens: z
		.number()
		.int()
		.nonnegative()
		.nullable()
		.describe("Null when Home did not report a complete input token count."),
	outputTokens: z
		.number()
		.int()
		.nonnegative()
		.nullable()
		.describe("Null when Home did not report a complete output token count."),
	reasoningTokens: z
		.number()
		.int()
		.nonnegative()
		.nullable()
		.describe("Null when Home did not report reasoning tokens."),
	harnessVersionId: z
		.string()
		.nullable()
		.describe("Null when Home did not stamp a harness version."),
	traceBundleId: z
		.string()
		.nullable()
		.describe("Null when Home did not create a trace bundle."),
	routerVersion: z
		.string()
		.nullable()
		.describe("Null when Home did not stamp a router version."),
	durationMs: z
		.number()
		.nonnegative()
		.nullable()
		.describe("Null when Home did not report a valid turn duration."),
});
export type TenantBehavioralEvalExecutionReceipt = z.infer<
	typeof TenantBehavioralEvalExecutionReceiptSchema
>;
export const TenantBehavioralEvalAssertionSchema = z.discriminatedUnion(
	"type",
	[
		z.strictObject({
			type: z.literal("route_is"),
			expected: z.string().min(1).max(100),
			severity: TenantBehavioralEvalSeveritySchema.optional().describe(
				"Absent on historical revisions; grading treats it as gate.",
			),
		}),
		z.strictObject({
			type: z.literal("terminal_status_is"),
			expected: z.enum(["completed", "failed", "canceled"]),
			severity: TenantBehavioralEvalSeveritySchema.optional().describe(
				"Absent on historical revisions; grading treats it as gate.",
			),
		}),
		z.strictObject({
			type: z.literal("no_effects"),
			severity: TenantBehavioralEvalSeveritySchema.optional().describe(
				"Absent on historical revisions; grading treats it as gate.",
			),
		}),
	],
);
export const TenantBehavioralEvalCaseSchema = z.strictObject({
	id: z
		.string()
		.min(1)
		.max(100)
		.regex(/^[A-Za-z0-9_-]+$/),
	input: z.string().min(1).max(8_000),
	assertions: z.array(TenantBehavioralEvalAssertionSchema).min(1).max(10),
});
export const TenantBehavioralEvalRevisionSpecSchema = z.strictObject({
	lane: TenantBehavioralEvalLaneSchema,
	cases: z
		.array(TenantBehavioralEvalCaseSchema)
		.min(1)
		.max(20)
		.superRefine((cases, ctx) => {
			const seen = new Set<string>();
			for (const [index, value] of cases.entries()) {
				if (seen.has(value.id))
					ctx.addIssue({
						code: "custom",
						message: "case ids must be unique",
						path: [index, "id"],
					});
				seen.add(value.id);
			}
		}),
});
export const TenantBehavioralEvalDefinitionSchema = z.strictObject({
	id: z.string(),
	organizationId: z.string(),
	tediId: z.string(),
	name: z.string(),
	latestRevision: z.number().int().positive(),
	createdAt: z.string(),
});
export const TenantBehavioralEvalRevisionSchema = z.strictObject({
	id: z.string(),
	definitionId: z.string(),
	organizationId: z.string(),
	revision: z.number().int().positive(),
	spec: TenantBehavioralEvalRevisionSpecSchema,
	createdAt: z.string(),
});
export const TenantBehavioralEvalRunStatusSchema = z.enum([
	"pending",
	"running",
	"completed",
	"failed",
]);
export const TenantBehavioralEvalRunSchema = z.strictObject({
	id: z.string(),
	organizationId: z.string(),
	definitionId: z.string(),
	revisionId: z.string(),
	tediId: z.string(),
	status: TenantBehavioralEvalRunStatusSchema,
	version: z.number().int().nonnegative(),
	idempotencyKey: z.string(),
	payloadDigest: z.string(),
	manifest: TenantBehavioralEvalRunManifestSchema.nullable().describe(
		"Null for runs created before provenance manifests were stored.",
	),
	manifestDigest: z
		.string()
		.nullable()
		.describe("Null for runs created before provenance manifests were stored."),
	passed: z
		.boolean()
		.nullable()
		.describe("Null until every case stream is closed, drained, and graded."),
	lastAdvanceError: z
		.string()
		.nullable()
		.describe("Null until an advance fails under the run lease."),
	lastAdvanceErrorPhase: z
		.enum(["dispatch", "evidence", "assertion"])
		.nullable()
		.describe("Null until an advance failure has a recorded phase."),
	lastAdvanceErrorRetryable: z
		.boolean()
		.nullable()
		.describe("Null until an advance failure is classified."),
	createdAt: z.string(),
	updatedAt: z.string(),
});
export const TenantBehavioralEvalCaseRunSchema = z.strictObject({
	id: z.string(),
	runId: z.string(),
	caseId: z.string(),
	homeRunId: z.string(),
	attemptNumber: z.number().int().positive(),
	status: z.enum(["pending", "enqueued", "streaming", "completed", "failed"]),
	eventCursor: z.number().int().nonnegative(),
	sawClosed: z.boolean(),
	drained: z.boolean(),
	terminalStatus: z
		.string()
		.nullable()
		.describe("Null until a durable terminal run event is observed."),
	selectedRoute: z
		.string()
		.nullable()
		.describe(
			"Null until canonical completed Home run metadata records a route.",
		),
	effectsSuppressed: z
		.boolean()
		.nullable()
		.describe(
			"Null while effect suppression remains unobserved; false is sticky after an effect-bearing event.",
		),
	error: z
		.string()
		.nullable()
		.describe("Null unless the case reaches a recorded diagnostic failure."),
	disposition: TenantBehavioralEvalDispositionSchema.nullable().describe(
		"Null before grading or on historical case rows that predate dispositions.",
	),
	executionReceipt:
		TenantBehavioralEvalExecutionReceiptSchema.nullable().describe(
			"Null before the Home event stream is closed and drained, or for historical cases.",
		),
});
export const TenantBehavioralEvalCaseAttemptSchema = z.strictObject({
	id: z.string(),
	caseRunId: z.string(),
	attemptNumber: z.number().int().positive(),
	homeRunId: z.string(),
	status: z.enum(["completed", "failed"]),
	disposition: TenantBehavioralEvalDispositionSchema,
	error: z
		.string()
		.nullable()
		.describe("Null when the sealed attempt has no infrastructure error."),
	eventCursor: z.number().int().nonnegative(),
	terminalStatus: z
		.string()
		.nullable()
		.describe("Null when no terminal status event was observed."),
	selectedRoute: z
		.string()
		.nullable()
		.describe("Null when the Home run did not yield a route."),
	effectsSuppressed: z
		.boolean()
		.nullable()
		.describe("Null when Home supplied no effect observation."),
	executionReceipt:
		TenantBehavioralEvalExecutionReceiptSchema.nullable().describe(
			"Null for attempts without verified terminal Home metadata.",
		),
	recordedAt: z.string(),
});
export const TenantBehavioralEvalAssertionResultSchema = z.strictObject({
	id: z.string(),
	caseRunId: z.string(),
	assertionIndex: z.number().int().nonnegative(),
	type: z.enum(["route_is", "terminal_status_is", "no_effects"]),
	passed: z.boolean(),
	severity: TenantBehavioralEvalSeveritySchema,
	disposition: TenantBehavioralEvalDispositionSchema,
	detail: z.string(),
});
export const CreateTenantBehavioralEvalInputSchema = z.strictObject({
	organizationId: z.string().min(1),
	tediId: z.string().min(1),
	name: z.string().min(1).max(200),
	spec: TenantBehavioralEvalRevisionSpecSchema,
});
export const ReviseTenantBehavioralEvalInputSchema = z.strictObject({
	organizationId: z.string().min(1),
	definitionId: z.string().min(1),
	expectedVersion: z.number().int().positive(),
	spec: TenantBehavioralEvalRevisionSpecSchema,
});
export const GetTenantBehavioralEvalInputSchema = z.strictObject({
	organizationId: z.string().min(1),
	definitionId: z.string().min(1),
});
export const ListTenantBehavioralEvalsInputSchema = z.strictObject({
	organizationId: z.string().min(1),
	limit: z.number().int().positive().max(100).default(50),
});
export const StartTenantBehavioralEvalRunInputSchema = z.strictObject({
	organizationId: z.string().min(1),
	definitionId: z.string().min(1),
	revisionId: z.string().min(1),
	idempotencyKey: z.string().min(1).max(200),
});
export const AdvanceTenantBehavioralEvalRunInputSchema = z.strictObject({
	organizationId: z.string().min(1),
	runId: z.string().min(1),
	expectedVersion: z.number().int().nonnegative(),
});
export const GetTenantBehavioralEvalRunInputSchema = z.strictObject({
	organizationId: z.string().min(1),
	runId: z.string().min(1),
});
export const ListTenantBehavioralEvalRunsInputSchema = z.strictObject({
	organizationId: z.string().min(1),
	definitionId: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Omitted to list runs across all definitions in the authenticated organization.",
		),
	limit: z.number().int().positive().max(100).default(50),
});
export const TenantBehavioralEvalRunDetailSchema = z.strictObject({
	run: TenantBehavioralEvalRunSchema,
	caseRuns: z.array(TenantBehavioralEvalCaseRunSchema),
	caseAttempts: z.array(TenantBehavioralEvalCaseAttemptSchema),
	assertionResults: z.array(TenantBehavioralEvalAssertionResultSchema),
});
export type TenantBehavioralEvalRevisionSpec = z.infer<
	typeof TenantBehavioralEvalRevisionSpecSchema
>;
