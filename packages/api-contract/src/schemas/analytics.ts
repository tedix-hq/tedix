/**
 * Analytics Zod Schemas
 * Validation schemas for analytics endpoints
 */

import * as z from "zod";
import { JsonValueSchema } from "./common";

export const WidgetEventSchema = z.object({
	id: z.uuid(),
	organizationId: z.uuid().optional(),
	appId: z.uuid(),
	sessionId: z.string().max(256),
	eventType: z.enum([
		"item_impression",
		"item_click",
		"external_cta_click",
		"checkout_start",
		"filter",
		"sort",
		"select_item",
		"attention_impression",
		"attention_open",
		"attention_review",
		"attention_still_open",
	]),
	itemId: z.string().max(256).optional(),
	itemPosition: z.number().int().min(0).max(10000).optional(),
	widgetKey: z.string().max(128).optional(),
	displayMode: z.enum(["inline", "fullscreen", "pip", "modal"]).optional(),
	metadata: z.record(z.string().max(64), JsonValueSchema).optional(),
	createdAt: z.string().datetime().optional(),
});

export type WidgetEvent = z.infer<typeof WidgetEventSchema>;

export const AnalyticsMetricsSchema = z.object({
	totalSessions: z.number(),
	sessionsChange: z.number().optional(),
	avgMessages: z.number(),
	avgMessagesChange: z.number().optional(),
	successRate: z.number(),
	successRateChange: z.number().optional(),
});

export type AnalyticsMetrics = z.infer<typeof AnalyticsMetricsSchema>;

export const AppToolBreakdownItemSchema = z.object({
	toolName: z.string(),
	totalCalls: z.number(),
	successCalls: z.number(),
	failedCalls: z.number(),
	successRate: z.number(),
	avgDurationMs: z.number(),
	maxDurationMs: z.number(),
	/** Average request payload size in bytes (AE double3 toolInputSize). */
	avgInputBytes: z.number().default(0),
	/** Average response payload size in bytes (AE double4 toolOutputSize). */
	avgOutputBytes: z.number().default(0),
});

export const AppToolBreakdownSchema = z.object({
	tools: z.array(AppToolBreakdownItemSchema),
});

export const AppSummarySchema = z.object({
	totalEvents: z.number(),
	toolCalls: z.number(),
	promptCalls: z.number(),
	codeExecs: z.number(),
	successRate: z.number(),
	avgDurationMs: z.number(),
	uniqueUsers: z.number(),
	uniqueCallerTypes: z.array(z.string()),
});

export const TimeSeriesBucketSchema = z.object({
	bucket: z.string(),
	totalEvents: z.number(),
	successEvents: z.number(),
	failedEvents: z.number(),
	avgDurationMs: z.number(),
});

export const AppTimeSeriesSchema = z.object({
	buckets: z.array(TimeSeriesBucketSchema),
});

export const RecentExecutionSchema = z.object({
	executionId: z.string(),
	success: z.boolean(),
	durationMs: z.number(),
	timestamp: z.string(),
	toolCount: z.number(),
});

export const RecentExecutionsSchema = z.object({
	executions: z.array(RecentExecutionSchema),
});

export const AppActivityFreshnessSchema = z.object({
	windowStart: z.string().datetime(),
	windowEnd: z.string().datetime(),
	currentWindow: z.object({
		totalEvents: z.number(),
		toolExecutions: z.number(),
		codeExecutions: z.number(),
		toolErrors: z.number(),
	}),
	latestAuditEvent: z
		.object({
			action: z.string(),
			resourceId: z.string().nullable(),
			timestamp: z.string().datetime(),
			durationMs: z.number().nullable(),
			executionId: z.string().nullable(),
			traceId: z.string().nullable(),
			toolCount: z.number().nullable(),
			namespaceCount: z.number().nullable(),
		})
		.nullable(),
});

export const ExecutionEventSchema = z.object({
	toolName: z.string(),
	success: z.boolean(),
	durationMs: z.number(),
	timestamp: z.string(),
	eventType: z.string(),
	appSlug: z.string(),
	/** Error name/code for failed inner calls (audit-sourced; null when ok/unknown). */
	errorCode: z.string().nullish(),
});

export const PrincipalDescriptorSchema = z.object({
	id: z.string(),
	type: z.enum([
		"user",
		"tedi",
		"kernel",
		"m2m",
		"service",
		"apiKey",
		"external_agent",
		"anonymous",
		"unknown",
	]),
	label: z.string(),
	secondary: z.string().nullable(),
	slug: z.string().nullable(),
	avatarUrl: z.string().nullable(),
	unresolved: z.boolean(),
});
export type PrincipalDescriptor = z.infer<typeof PrincipalDescriptorSchema>;

export const AppDescriptorSchema = z.object({
	id: z.string(),
	label: z.string(),
	slug: z.string().nullable(),
	unresolved: z.boolean(),
});
export type AppDescriptor = z.infer<typeof AppDescriptorSchema>;

export const ToolDescriptorSchema = z.object({
	id: z.string(),
	label: z.string(),
	toolName: z.string(),
	title: z.string().nullable(),
	appId: z.string().nullable(),
	appLabel: z.string().nullable(),
	appSlug: z.string().nullable(),
	unresolved: z.boolean(),
});
export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>;

export const IdentityCoverageWarningDetailSchema = z.object({
	code: z.string(),
	label: z.string(),
	severity: z.enum(["info", "warning", "critical"]),
	message: z.string(),
	recommendedAction: z.string().nullable(),
});
export type IdentityCoverageWarningDetail = z.infer<
	typeof IdentityCoverageWarningDetailSchema
>;

export const IdentityCoverageSchema = z.object({
	actorResolved: z.boolean(),
	subjectPresent: z.boolean(),
	subjectResolved: z.boolean(),
	agentPresent: z.boolean(),
	agentResolved: z.boolean(),
	appResolved: z.boolean(),
	toolResolved: z.boolean(),
	clientPresent: z.boolean(),
	warnings: z.array(z.string()),
	warningDetails: z.array(IdentityCoverageWarningDetailSchema),
});
export type IdentityCoverage = z.infer<typeof IdentityCoverageSchema>;

export const DelegationChainSchema = z.object({
	mode: z.string().nullable(),
	actor: PrincipalDescriptorSchema,
	subject: PrincipalDescriptorSchema.nullable(),
	agent: PrincipalDescriptorSchema.nullable(),
	client: z
		.object({
			id: z.string(),
			label: z.string(),
		})
		.nullable(),
	summary: z.string(),
});
export type DelegationChain = z.infer<typeof DelegationChainSchema>;

/** Who ran an execution. Sourced from D1 audit_events, absent for AE-sourced rows. */
export const ExecutionActorSchema = z.object({
	actorId: z.string(),
	actorType: z.string(),
});

export const ExecutionDrilldownSchema = z.object({
	execution: ExecutionEventSchema.nullable(),
	toolCalls: z.array(ExecutionEventSchema),
	/** The principal that ran the execution. Null when unknown (AE fallback). */
	actor: ExecutionActorSchema.nullish(),
	/** Human-readable actor/subject/agent chain. Null when unknown (AE fallback). */
	attribution: DelegationChainSchema.nullish(),
	/** Whether actor/app/tool/subject enrichment was complete enough for a review. */
	identityCoverage: IdentityCoverageSchema.nullish(),
	/** Request trace id correlating all events of the execution. */
	traceId: z.string().nullish(),
	/** MCP OAuth client id (e.g. "Claude") when present in the audit metadata. */
	clientId: z.string().nullish(),
	/** Which lane answered: "audit" (authoritative) or "analytics_engine" (sampled fallback). */
	source: z.enum(["audit", "analytics_engine"]).nullish(),
});

export type ExecutionEvent = z.infer<typeof ExecutionEventSchema>;
export type ExecutionActor = z.infer<typeof ExecutionActorSchema>;
export type ExecutionDrilldown = z.infer<typeof ExecutionDrilldownSchema>;

/**
 * One row in the audit-backed activity feed (recent activity / trace drilldown).
 * Sourced from D1 `audit_events` — carries the actor, unlike AE.
 */
export const ActivityItemSchema = z.object({
	timestamp: z.string(),
	actorId: z.string(),
	actorType: z.string(),
	actor: PrincipalDescriptorSchema,
	subject: PrincipalDescriptorSchema.nullable(),
	agent: PrincipalDescriptorSchema.nullable(),
	attribution: DelegationChainSchema,
	identityCoverage: IdentityCoverageSchema,
	/** Full audit action, e.g. "mcp.tool.execute" / "mcp.code.error". */
	action: z.string(),
	success: z.boolean(),
	/** Tool name (audit resourceId) — null for non-tool events. */
	toolName: z.string().nullable(),
	tool: ToolDescriptorSchema.nullable(),
	appId: z.string().nullable(),
	app: AppDescriptorSchema.nullable(),
	executionId: z.string().nullable(),
	traceId: z.string().nullable(),
	clientId: z.string().nullable(),
	delegationMode: z.string().nullable(),
	durationMs: z.number().nullable(),
	errorCode: z.string().nullable(),
	securityDecision: z.object({
		disposition: z.enum(["executed", "denied"]),
		denialReason: z
			.string()
			.nullable()
			.describe("Stable reason for denied requests; null for executed events."),
		httpStatus: z
			.number()
			.nullable()
			.describe(
				"HTTP status returned by a pre-dispatch denial; null for executed events.",
			),
		mcpMethod: z
			.string()
			.nullable()
			.describe(
				"Validated MCP method when available; null for legacy or non-JSON requests.",
			),
		riskTier: z
			.enum([
				"read",
				"bounded_write",
				"high_impact_write",
				"external_side_effect",
			])
			.nullable()
			.describe(
				"Config-driven tool risk tier; null until a tool has an explicit classification.",
			),
	}),
});
export type ActivityItem = z.infer<typeof ActivityItemSchema>;

export const RecentActivitySchema = z.object({
	items: z.array(ActivityItemSchema),
});
export type RecentActivity = z.infer<typeof RecentActivitySchema>;

export const ReviewToolSummarySchema = z.object({
	tool: ToolDescriptorSchema,
	count: z.number(),
	errors: z.number(),
});

export const CognitionEvidenceBundleSchema = z.object({
	summary: z.string(),
	retrievedFactIds: z.array(z.string()),
	citedFactIds: z.array(z.string()),
	ignoredFactIds: z.array(z.string()),
	decisionIds: z.array(z.string()),
	latestDecision: z
		.object({
			id: z.string(),
			category: z.string().nullable(),
			outcomeStatus: z.string().nullable(),
			confidence: z.number().nullable(),
			createdAt: z.string().datetime().nullable(),
			completedAt: z.string().datetime().nullable(),
			source: z.enum(["runtime", "rationale_record"]),
		})
		.nullable(),
	retrieval: z.object({
		topK: z.number().nullable(),
		returnedCount: z.number().nullable(),
		vectorEnabled: z.boolean().nullable(),
		vectorMs: z.number().nullable(),
		hydrateFactsMs: z.number().nullable(),
	}),
	graph: z.object({
		status: z.enum(["not_applicable", "not_observed", "observed"]),
		projectedDecisionIds: z.array(z.string()),
		warnings: z.array(z.string()),
	}),
	warnings: z.array(z.string()),
});
export type CognitionEvidenceBundle = z.infer<
	typeof CognitionEvidenceBundleSchema
>;

export const TraceEvidenceSummarySchema = z.object({
	status: z.enum([
		"missing_trace",
		"audit_only",
		"mcp_linked",
		"runtime_linked",
		"cognitive_linked",
		"retrieval_decision_linked",
	]),
	mcpEvents: z.number(),
	runtimeEvents: z.number(),
	cognitiveEvents: z.number(),
	retrievalEvents: z.number(),
	decisionEvents: z.number(),
	retrievedFactCount: z.number(),
	citedFactCount: z.number(),
	ignoredFactCount: z.number(),
	runtimeBackends: z.array(z.string()),
	hasRetrievalDecisionJoin: z.boolean(),
	latestRuntimeAt: z.string().datetime().nullable(),
	latestCognitiveAt: z.string().datetime().nullable(),
	latestRetrievalAt: z.string().datetime().nullable(),
	latestDecisionAt: z.string().datetime().nullable(),
	cloudflare: z.object({
		sampled: z.boolean(),
		traceId: z
			.string()
			.nullable()
			.describe("Cloudflare trace ID, null when the episode was not sampled"),
		spanCount: z.number(),
		serviceNames: z.array(z.string()),
		durationMs: z
			.number()
			.nullable()
			.describe("Sampled Cloudflare trace duration, null when unavailable"),
		errorCount: z.number(),
		traceStartAt: z
			.string()
			.datetime()
			.nullable()
			.describe("Sampled Cloudflare trace start, null when unavailable"),
		traceEndAt: z
			.string()
			.datetime()
			.nullable()
			.describe("Sampled Cloudflare trace end, null when unavailable"),
	}),
	cognition: CognitionEvidenceBundleSchema,
	warnings: z.array(z.string()),
});
export type TraceEvidenceSummary = z.infer<typeof TraceEvidenceSummarySchema>;

export const TraceFreshnessCoverageSchema = z.object({
	status: z.enum(["met", "warning", "breach", "no_data"]),
	targetMaxLagMs: z.number(),
	freshnessRate: z.number(),
	proofGroups: z.number(),
	freshGroups: z.number(),
	staleGroups: z.number(),
	missingProofTimestampGroups: z.number(),
	maxLagMs: z.number().nullable(),
	latestAuditAt: z.string().datetime().nullable(),
	latestProofAt: z.string().datetime().nullable(),
	warnings: z.array(z.string()),
});
export type TraceFreshnessCoverage = z.infer<
	typeof TraceFreshnessCoverageSchema
>;

export const TraceEvidenceCoverageSchema = z.object({
	status: z.enum(["met", "warning", "breach", "no_data"]),
	targetCoverageRate: z.number(),
	proofCoverageRate: z.number(),
	proofLinkedGroups: z.number(),
	auditOnlyGroups: z.number(),
	mcpLinkedGroups: z.number(),
	runtimeLinkedGroups: z.number(),
	cognitiveLinkedGroups: z.number(),
	retrievalDecisionLinkedGroups: z.number(),
	missingTraceGroups: z.number(),
	warnings: z.array(z.string()),
});
export type TraceEvidenceCoverage = z.infer<typeof TraceEvidenceCoverageSchema>;

export const ActivityReviewGroupSchema = z.object({
	id: z.string(),
	title: z.string(),
	summary: z.string(),
	startedAt: z.string(),
	endedAt: z.string(),
	totalEvents: z.number(),
	successfulEvents: z.number(),
	errorEvents: z.number(),
	traceId: z.string().nullable(),
	executionId: z.string().nullable(),
	actor: PrincipalDescriptorSchema,
	subject: PrincipalDescriptorSchema.nullable(),
	agent: PrincipalDescriptorSchema.nullable(),
	attribution: DelegationChainSchema,
	apps: z.array(AppDescriptorSchema),
	topTools: z.array(ReviewToolSummarySchema),
	identityCoverage: IdentityCoverageSchema,
	traceEvidence: TraceEvidenceSummarySchema,
	securityPosture: z.object({
		disposition: z.enum(["executed", "denied", "mixed"]),
		executedEvents: z.number(),
		deniedEvents: z.number(),
		denialReasons: z.array(z.string()),
		mcpMethods: z.array(z.string()),
		riskTiers: z.array(
			z.enum([
				"read",
				"bounded_write",
				"high_impact_write",
				"external_side_effect",
			]),
		),
		unknownRiskEvents: z.number(),
	}),
	evidence: z.object({
		auditEventCount: z.number(),
		payloadsConfigured: z.boolean(),
		source: z.literal("audit_events"),
	}),
});
export type ActivityReviewGroup = z.infer<typeof ActivityReviewGroupSchema>;

export const HumanActivityReviewSchema = z.object({
	windowStart: z.string(),
	windowEnd: z.string(),
	totalEvents: z.number(),
	groups: z.array(ActivityReviewGroupSchema),
	coverage: z.object({
		totalGroups: z.number(),
		unresolvedActorGroups: z.number(),
		missingSubjectGroups: z.number(),
		unresolvedToolGroups: z.number(),
		securityPosture: z.object({
			executedGroups: z.number(),
			deniedGroups: z.number(),
			mixedGroups: z.number(),
			executedEvents: z.number(),
			deniedEvents: z.number(),
			unknownRiskEvents: z.number(),
			denialReasons: z.array(z.string()),
		}),
		traceEvidence: TraceEvidenceCoverageSchema,
		traceFreshness: TraceFreshnessCoverageSchema,
		warnings: z.array(z.string()),
	}),
});
export type HumanActivityReview = z.infer<typeof HumanActivityReviewSchema>;

const TediObservabilityOutcomeSchema = z.enum([
	"success",
	"failure",
	"warning",
	"unknown",
]);

export const TediObservabilitySnapshotSchema = z.object({
	tediId: z.string().uuid(),
	from: z.string().datetime(),
	to: z.string().datetime(),
	source: z.literal("tenant_d1"),
	truncated: z.boolean(),
	metrics: z.object({
		runtimeEvents: z.number().int().nonnegative(),
		auditEvents: z.number().int().nonnegative(),
		invocations: z.number().int().nonnegative(),
		failedInvocations: z.number().int().nonnegative(),
		traceCount: z.number().int().nonnegative(),
		averageInvocationDurationMs: z
			.number()
			.nonnegative()
			.nullable()
			.describe("Null when no invocation in the window records a duration"),
	}),
	logs: z.array(
		z.object({
			id: z.string(),
			kind: z.string(),
			outcome: TediObservabilityOutcomeSchema,
			runId: z
				.string()
				.nullable()
				.describe("Null for diagnostics emitted outside a runtime run"),
			traceId: z
				.string()
				.nullable()
				.describe("Null when the source runtime event has no trace context"),
			occurredAt: z.string().datetime(),
		}),
	),
	invocations: z.array(
		z.object({
			id: z.string(),
			toolName: z.string(),
			outcome: TediObservabilityOutcomeSchema,
			durationMs: z
				.number()
				.nonnegative()
				.nullable()
				.describe("Null when the runtime did not record invocation duration"),
			runId: z
				.string()
				.nullable()
				.describe("Null for invocations emitted outside a runtime run"),
			traceId: z
				.string()
				.nullable()
				.describe("Null when the source invocation has no trace context"),
			occurredAt: z.string().datetime(),
		}),
	),
	traces: z.array(
		z.object({
			traceId: z.string(),
			firstAt: z.string().datetime(),
			lastAt: z.string().datetime(),
			eventCount: z.number().int().positive(),
			invocationCount: z.number().int().nonnegative(),
			failureCount: z.number().int().nonnegative(),
		}),
	),
	auditEvents: z.array(
		z.object({
			id: z.string(),
			action: z.string(),
			resourceType: z.string(),
			resourceId: z
				.string()
				.nullable()
				.describe("Null for audit actions that target a resource collection"),
			occurredAt: z.string().datetime(),
		}),
	),
	auditReceiptId: z.string().uuid(),
});
export type TediObservabilitySnapshot = z.infer<
	typeof TediObservabilitySnapshotSchema
>;

/** Workflow use requires an exact turn, run, skill, and terminal ledger join. */
export const SkillRetrievalUtilitySchema = z.object({
	tediId: z.string().uuid(),
	from: z.string().datetime(),
	to: z.string().datetime(),
	source: z.literal("tenant_d1"),
	truncated: z.boolean(),
	metrics: z.object({
		injected: z.number().int().nonnegative(),
		verifiedSuccess: z.number().int().nonnegative(),
		verifiedFailure: z.number().int().nonnegative(),
		unknown: z.number().int().nonnegative(),
	}),
	rows: z.array(
		z.object({
			injectionEventId: z
				.string()
				.min(1)
				.describe(
					"Canonical runtime event ID; includes the structured turn run ID.",
				),
			turnRunId: z
				.string()
				.min(1)
				.describe("Structured Tedi run ID in tediId:surface:turnKey form."),
			conversationId: z
				.string()
				.nullable()
				.describe(
					"Null when the canonical injection event has no conversation binding.",
				),
			skillId: z.string().uuid(),
			injectedAt: z.string().datetime(),
			status: z.enum(["unknown", "success", "failure"]),
			skillRunId: z
				.string()
				.uuid()
				.nullable()
				.describe(
					"Null until exact workflow completion and terminal usage prove execution.",
				),
		}),
	),
	auditReceiptId: z.string().uuid(),
});

/**
 * A single tool-call payload row read from R2 SQL (R2 Data Catalog / Iceberg).
 * Flat columns written by the payload Pipeline — the request/response bodies
 * that are too large/contextual for Analytics Engine. `success`/`truncated` are
 * numeric (1/0) as stored; sizes are byte counts.
 */
export const ToolCallPayloadSchema = z.object({
	traceId: z.string(),
	executionId: z.string(),
	appId: z.string(),
	appSlug: z.string(),
	organizationId: z.string(),
	toolName: z.string(),
	eventType: z.string(),
	success: z.number(),
	errorCode: z.string(),
	durationMs: z.number(),
	timestamp: z.string(),
	userId: z.string(),
	tediId: z.string(),
	authType: z.string(),
	inputArgs: z.string(),
	inputBytes: z.number(),
	outputBody: z.string(),
	outputBytes: z.number(),
	truncated: z.number(),
});

export type ToolCallPayload = z.infer<typeof ToolCallPayloadSchema>;

export const ToolCallPayloadsSchema = z.object({
	payloads: z.array(ToolCallPayloadSchema),
	/** false when R2 SQL is not configured in this environment. */
	configured: z.boolean(),
});

/**
 * Everything correlated to one request trace, joined across lanes: the audit
 * events (actor + every inner tool, authoritative) plus the redacted payload
 * bodies from R2 when capture covered the window. (Defined after
 * ToolCallPayloadSchema because it embeds it.)
 */
export const TraceActivitySchema = z.object({
	events: z.array(ActivityItemSchema),
	payloads: z.array(ToolCallPayloadSchema),
	/** R2 payload forensics configured in this environment. */
	payloadsConfigured: z.boolean(),
});

// =============================================================================
// Code Mode Analytics schemas
// =============================================================================

/**
 * Per-namespace aggregate derived from Code Mode `rpc` events.
 */
export const CodemodeNamespaceSummarySchema = z.object({
	namespace: z.string(),
	totalCalls: z.number().int(),
	successCalls: z.number().int(),
	failedCalls: z.number().int(),
	/** Success percentage, 0–100 with one decimal place. */
	successRate: z.number(),
	avgDurationMs: z.number().int(),
});

/**
 * Per-tool RPC breakdown from Code Mode `rpc` events.
 */
export const CodemodeToolStatSchema = z.object({
	/** "ns.tool" compound name as written by apps/mcp. */
	toolName: z.string(),
	namespace: z.string(),
	totalCalls: z.number().int(),
	successCalls: z.number().int(),
	failedCalls: z.number().int(),
	successRate: z.number(),
	avgDurationMs: z.number().int(),
	/** Median (p50) duration in ms, weighted by Analytics Engine sampling. */
	p50DurationMs: z.number().int(),
});

/**
 * Execution-level summary from Code Mode `exec` events.
 */
export const CodemodeExecSummarySchema = z.object({
	totalExecs: z.number().int(),
	successExecs: z.number().int(),
	failedExecs: z.number().int(),
	successRate: z.number(),
	avgDurationMs: z.number().int(),
	/** Average number of tool RPC calls per execution. */
	avgToolCount: z.number(),
	/** Average number of distinct namespaces accessed per execution. */
	avgNamespaceCount: z.number(),
});

/**
 * Output schema for the `getCodemodeAnalyticsSummary` procedure.
 */
export const CodemodeAnalyticsSummarySchema = z.object({
	byNamespace: z.array(CodemodeNamespaceSummarySchema),
	topTools: z.array(CodemodeToolStatSchema),
	execSummary: CodemodeExecSummarySchema,
});

/** Org-scoped health of external-agent credential validation at the MCP edge. */
export const ExternalAgentValidationSloSchema = z.object({
	from: z.string().datetime(),
	to: z.string().datetime(),
	status: z.enum([
		"healthy",
		"degraded",
		"no_data",
		"query_unavailable",
		"unconfigured",
	]),
	configured: z.boolean(),
	hasData: z.boolean(),
	latestValidationAt: z
		.string()
		.datetime()
		.nullable()
		.describe("Null when the requested window contains no validation samples."),
	/** Lag from the requested `to` boundary to the newest validation sample. */
	freshnessLagMs: z
		.number()
		.int()
		.nonnegative()
		.nullable()
		.describe("Null when no latest validation sample is available."),
	totalValidations: z.number().int(),
	successfulValidations: z.number().int(),
	inactiveValidations: z.number().int(),
	unavailableValidations: z.number().int(),
	/** Percentage of validations completed without a dependency failure. */
	availabilityPercent: z.number(),
	avgLatencyMs: z.number().int(),
});

/** Consent-aware, content-free lifecycle health for the white-label widget. */
export const WidgetLifecycleHealthSchema = z.object({
	from: z.string().datetime(),
	to: z.string().datetime(),
	status: z.enum([
		"healthy",
		"degraded",
		"no_data",
		"query_unavailable",
		"unconfigured",
	]),
	configured: z.boolean(),
	hasData: z.boolean(),
	latestEventAt: z
		.string()
		.datetime()
		.nullable()
		.describe("Null until the consented window contains a lifecycle event."),
	totalEvents: z.number().int().nonnegative(),
	readyEvents: z.number().int().nonnegative(),
	sessionAttempts: z.number().int().nonnegative(),
	failedSessions: z.number().int().nonnegative(),
	messageSubmissions: z.number().int().nonnegative(),
	firstTokens: z.number().int().nonnegative(),
	completedAnswers: z.number().int().nonnegative(),
	cancelledAnswers: z.number().int().nonnegative(),
	failedAnswers: z.number().int().nonnegative(),
	avgReadyMs: z.number().int().nonnegative(),
	avgSessionMs: z.number().int().nonnegative(),
	avgFirstTokenMs: z.number().int().nonnegative(),
	avgAnswerMs: z.number().int().nonnegative(),
});

/** Provider-owned view of signed, content-free embedded widget activity. */
export const EmbeddedProviderActivitySchema = z.object({
	from: z.string().datetime(),
	to: z.string().datetime(),
	tenants: z.array(
		z.object({
			installationId: z.uuid(),
			externalTenantId: z.string(),
			activeUsers: z.number().int().nonnegative(),
			sessions: z.number().int().nonnegative(),
			events: z.number().int().nonnegative(),
			lastSeenAt: z.string().datetime(),
		}),
	),
	users: z.array(
		z.object({
			installationId: z.uuid(),
			externalTenantId: z.string(),
			hostUserId: z.string(),
			hostUserLabel: z
				.string()
				.nullable()
				.describe("Optional host-authenticated display label for this user."),
			hostRole: z
				.string()
				.nullable()
				.describe(
					"Optional role supplied by the authenticated host application.",
				),
			sessions: z.number().int().nonnegative(),
			events: z.number().int().nonnegative(),
			lastSeenAt: z.string().datetime(),
		}),
	),
	recent: z.array(
		z.object({
			id: z.string(),
			installationId: z.uuid(),
			externalTenantId: z.string(),
			hostUserId: z.string(),
			hostUserLabel: z
				.string()
				.nullable()
				.describe("Optional host-authenticated display label for this user."),
			eventType: z.string(),
			createdAt: z.string().datetime(),
		}),
	),
});

export const WidgetLifecycleEventSchema = z
	.object({
		event: z.enum([
			"ready",
			"opened",
			"closed",
			"error",
			"performance",
			"message_submitted",
			"first_token",
			"answer_completed",
			"answer_cancelled",
			"answer_failed",
			"client_turn_milestone",
		]),
		milestone: z
			.enum([
				"ready",
				"session",
				"submitted",
				"acknowledged",
				"workspace_opened",
				"first_phase",
				"first_text",
				"terminal_received",
				"rendered",
				"reconnect_started",
				"reconnect_recovered",
				"failed",
			])
			.optional()
			.describe("Present only for content-free client turn measurements."),
		surface: z
			.enum(["native_os", "embedded_widget"])
			.optional()
			.describe("Present only for client turn measurements."),
		conversationId: z
			.string()
			.min(8)
			.max(128)
			.optional()
			.describe("Present only when a measured turn has a conversation."),
		runId: z
			.string()
			.min(8)
			.max(256)
			.optional()
			.describe("Present only after a measured turn has a run correlation."),
		traceId: z
			.string()
			.min(8)
			.max(256)
			.optional()
			.describe("Present only after a measured turn has a trace correlation."),
		eventId: z
			.uuid()
			.optional()
			.describe("Present only for idempotent client turn measurements."),
		phase: z
			.enum(["ready", "session", "turn"])
			.optional()
			.describe("Present only for performance events."),
		outcome: z
			.enum(["succeeded", "failed", "cancelled"])
			.optional()
			.describe("Present when the measured phase has settled."),
		code: z
			.string()
			.trim()
			.min(1)
			.max(80)
			.regex(/^[a-z0-9_.-]+$/i)
			.optional()
			.describe("Present only for bounded widget error classifications."),
		durationMs: z
			.number()
			.int()
			.min(0)
			.max(300_000)
			.optional()
			.describe("Present only for performance events, never wall-clock time."),
	})
	.strict();
export type TraceActivity = z.infer<typeof TraceActivitySchema>;
