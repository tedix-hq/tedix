import "@orpc/openapi/extensions/route";
/**
 * Analytics Contract for oRPC
 * Type-safe API contract for Analytics endpoints
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import {
	AnalyticsMetricsSchema,
	AppActivityFreshnessSchema,
	AppSummarySchema,
	AppTimeSeriesSchema,
	AppToolBreakdownSchema,
	CodemodeAnalyticsSummarySchema,
	ExternalAgentValidationSloSchema,
	EmbeddedProviderActivitySchema,
	ExecutionDrilldownSchema,
	HumanActivityReviewSchema,
	RecentActivitySchema,
	RecentExecutionsSchema,
	TediObservabilitySnapshotSchema,
	SkillRetrievalUtilitySchema,
	ToolCallPayloadsSchema,
	TraceActivitySchema,
	WidgetEventSchema,
	WidgetLifecycleHealthSchema,
	WidgetLifecycleEventSchema,
} from "../schemas/analytics";
import { AppIdParamSchema } from "../schemas/common";

export const TediObservabilitySnapshotInputSchema = z.object({
	tediId: z.string().uuid(),
	from: z.string().datetime(),
	to: z.string().datetime(),
	limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const SkillRetrievalUtilityInputSchema = z.object({
	tediId: z.string().uuid(),
	from: z.string().datetime(),
	to: z.string().datetime(),
	limit: z.coerce.number().int().min(1).max(50).default(20),
});

// =============================================================================
// CONTRACT DEFINITIONS
// =============================================================================

/**
 * Analytics Contract - defines the shape of all analytics-related endpoints
 *
 * Tags:
 * - ['analytics']: Public analytics endpoints
 * - ['analytics', 'internal']: Internal tracking endpoints (excluded from public API)
 *
 * @example Using the contract for client-side type inference:
 * ```typescript
 * import { analyticsContract } from '@tedix/api-contract';
 * type GetMetricsInput = z.infer<typeof analyticsContract.getMetrics.InputSchema>;
 * type GetMetricsOutput = z.infer<typeof analyticsContract.getMetrics.OutputSchema>;
 * ```
 */
export const analyticsContract = oc
	.route({ tags: ["analytics"], prefix: "/analytics" })
	.router({
		/**
		 * GET /analytics/apps/{appId} - Get app analytics metrics
		 */
		getMetrics: oc
			.route({
				method: "GET",
				path: "/apps/{appId}",
				summary: "Get app analytics metrics",
				description:
					"Get analytics metrics for an app within a specified time range",
			})
			.input(
				AppIdParamSchema.extend({
					from: z.string().datetime(),
					to: z.string().datetime(),
				}),
			)
			.output(AnalyticsMetricsSchema),

		/**
		 * GET /analytics/apps/{appId}/tools - Per-app tool call breakdown
		 */
		getAppToolBreakdown: oc
			.route({
				method: "GET",
				path: "/apps/{appId}/tools",
				summary: "Get per-tool call breakdown for an app",
				description:
					"Get tool-level metrics (calls, success rate, latency) from Analytics Engine",
			})
			.input(
				AppIdParamSchema.extend({
					from: z.string().datetime(),
					to: z.string().datetime(),
					limit: z.coerce.number().int().min(1).max(200).default(50),
				}),
			)
			.output(AppToolBreakdownSchema),

		/**
		 * GET /analytics/apps/{appId}/summary - Per-app summary metrics
		 */
		getAppSummary: oc
			.route({
				method: "GET",
				path: "/apps/{appId}/summary",
				summary: "Get summary metrics for an app",
				description:
					"Get aggregate metrics covering all event types (tool_call, prompt_get, code_exec) from Analytics Engine",
			})
			.input(
				AppIdParamSchema.extend({
					from: z.string().datetime(),
					to: z.string().datetime(),
				}),
			)
			.output(AppSummarySchema),

		/**
		 * GET /analytics/apps/{appId}/timeseries - Time-series event metrics
		 */
		getAppTimeSeries: oc
			.route({
				method: "GET",
				path: "/apps/{appId}/timeseries",
				summary: "Get time-series event metrics for an app",
				description:
					"Get event counts and avg duration bucketed by hour or day from Analytics Engine",
			})
			.input(
				AppIdParamSchema.extend({
					from: z.string().datetime(),
					to: z.string().datetime(),
					granularity: z.enum(["hour", "day"]).default("day"),
				}),
			)
			.output(AppTimeSeriesSchema),

		/**
		 * GET /analytics/apps/{appId}/executions - List recent Code Mode executions
		 */
		getRecentExecutions: oc
			.route({
				method: "GET",
				path: "/apps/{appId}/executions",
				summary: "List recent Code Mode executions",
				description:
					"Get recent code_exec events with execution IDs for drill-down navigation",
			})
			.input(
				AppIdParamSchema.extend({
					from: z.string().datetime(),
					to: z.string().datetime(),
					limit: z.coerce.number().int().min(1).max(50).default(20),
				}),
			)
			.output(RecentExecutionsSchema),

		/**
		 * GET /analytics/apps/{appId}/freshness - Current audit-trail freshness
		 */
		getAppFreshness: oc
			.route({
				method: "GET",
				path: "/apps/{appId}/freshness",
				summary: "Get current app audit freshness",
				description:
					"Get current-window audit trail activity for an app to complement Analytics Engine aggregates",
			})
			.input(
				AppIdParamSchema.extend({
					windowStart: z.string().datetime().optional(),
					windowEnd: z.string().datetime().optional(),
				}),
			)
			.output(AppActivityFreshnessSchema),

		/**
		 * GET /analytics/executions/{executionId} - Drill into a code execution
		 */
		getExecutionDrilldown: oc
			.route({
				method: "GET",
				path: "/executions/{executionId}",
				summary: "Drill into a code execution",
				description:
					"Get the code_exec event and all inner tool_call events for a given executionId",
			})
			.input(
				z.object({
					executionId: z.string().uuid(),
				}),
			)
			.output(ExecutionDrilldownSchema),

		/**
		 * GET /analytics/tool-calls/payloads - Tool-call request/response payloads
		 * Read from R2 SQL (R2 Data Catalog / Iceberg). Correlated by traceId or
		 * executionId; at least one is required (enforced in the handler).
		 */
		getToolCallPayloads: oc
			.route({
				method: "GET",
				path: "/tool-calls/payloads",
				summary: "Get tool-call request/response payloads",
				description:
					"Read tool-call input args + output bodies from R2 SQL (R2 Data Catalog / Iceberg) by traceId or executionId. Returns empty when R2 SQL is not configured.",
			})
			.input(
				z.object({
					traceId: z.string().optional(),
					executionId: z.string().optional(),
					toolName: z.string().optional(),
					limit: z.coerce.number().int().min(1).max(50).default(20),
				}),
			)
			.output(ToolCallPayloadsSchema),

		/**
		 * GET /analytics/activity/recent - Recent tool/code activity with the actor.
		 * Audit-backed (D1 audit_events): answers "who used which tool recently"
		 * without raw SQL. Optional appId / actorId filters.
		 */
		getRecentActivity: oc
			.route({
				method: "GET",
				path: "/activity/recent",
				summary: "Recent MCP tool activity (with actor)",
				description:
					"List recent inbound MCP tool/code events from D1 audit_events, newest first, including the actor identity. Org-scoped; optional appId and actorId filters.",
			})
			.input(
				z.object({
					appId: z.string().uuid().optional(),
					actorId: z.string().optional(),
					limit: z.coerce.number().int().min(1).max(100).default(50),
				}),
			)
			.output(RecentActivitySchema),

		/**
		 * GET /analytics/activity/trace/{traceId} - Everything in one request trace.
		 * Joins D1 audit_events (actor + every inner tool) with R2 payload bodies.
		 */
		getTraceActivity: oc
			.route({
				method: "GET",
				path: "/activity/trace/{traceId}",
				summary: "Drill into a request trace across lanes",
				description:
					"All audit events for a traceId (actor + inner tools) joined with the redacted R2 payload bodies for that trace. Org-scoped.",
			})
			.input(
				z.object({
					traceId: z.string(),
				}),
			)
			.output(TraceActivitySchema),

		/**
		 * GET /analytics/activity/review - Human-readable grouped activity review.
		 * Audit-backed, descriptor-hydrated, and explicit about identity gaps.
		 */
		getHumanActivityReview: oc
			.route({
				method: "GET",
				path: "/activity/review",
				summary: "Human-readable MCP activity review",
				description:
					"Groups recent inbound MCP audit events into human-readable episodes with hydrated actor, subject, agent, app, tool, delegation-chain, and identity-coverage details.",
			})
			.input(
				z.object({
					appId: z.string().uuid().optional(),
					actorId: z.string().optional(),
					from: z.string().datetime().optional(),
					to: z.string().datetime().optional(),
					limit: z.coerce.number().int().min(1).max(500).default(250),
				}),
			)
			.output(HumanActivityReviewSchema),

		/**
		 * GET /analytics/tedis/{tediId}/observability - Tenant-safe runtime snapshot.
		 * Content-free projection from tenant D1 runtime and audit records only.
		 */
		getTediObservabilitySnapshot: oc
			.route({
				method: "GET",
				path: "/tedis/{tediId}/observability",
				summary: "Get a tedi observability snapshot",
				description:
					"Get bounded, content-free diagnostics, invocation, trace, metric, and audit summaries for one accessible tedi. Never returns raw Logpush or R2 payloads.",
			})
			.input(TediObservabilitySnapshotInputSchema)
			.output(TediObservabilitySnapshotSchema),

		getSkillRetrievalUtility: oc
			.route({
				method: "GET",
				path: "/tedis/{tediId}/skill-retrieval-utility",
				summary: "Get verified skill retrieval-to-workflow outcomes",
				description:
					"Bounded tenant evidence for injected skills linked to exact workflow runs and terminal outcomes. Unknown means use was not verifiable.",
			})
			.input(SkillRetrievalUtilityInputSchema)
			.output(SkillRetrievalUtilitySchema),

		/**
		 * GET /analytics/codemode/summary - Code Mode AE aggregated summary
		 * Reads from the tedix_codemode_analytics_{env} dataset written by apps/mcp.
		 * Returns per-namespace call counts, top-tool breakdown, and exec totals.
		 */
		getCodemodeAnalyticsSummary: oc
			.route({
				method: "GET",
				path: "/codemode/summary",
				summary: "Get Code Mode analytics summary",
				description:
					"Aggregated summary from the codemode Analytics Engine dataset: per-namespace RPC call counts, top-tool breakdown, and execution-level totals. Reads the tedix_codemode_analytics_{env} dataset written by apps/mcp.",
			})
			.input(
				z.object({
					from: z.string().datetime(),
					to: z.string().datetime(),
					appId: z.string().uuid().optional(),
					limit: z.coerce.number().int().min(1).max(200).default(50),
				}),
			)
			.output(CodemodeAnalyticsSummarySchema),

		/** GET /analytics/external-agents/validation-slo */
		getExternalAgentValidationSlo: oc
			.route({
				method: "GET",
				path: "/external-agents/validation-slo",
				summary: "Get external-agent validation SLO",
				description:
					"Get org-scoped sampled availability, latency, and bounded outcome counts for external-agent credential validation.",
			})
			.input(
				z.object({
					from: z.string().datetime(),
					to: z.string().datetime(),
				}),
			)
			.output(ExternalAgentValidationSloSchema),

		/** GET /analytics/widget/lifecycle-health */
		getWidgetLifecycleHealth: oc
			.route({
				method: "GET",
				path: "/widget/lifecycle-health",
				summary: "Get embedded widget lifecycle health",
				description:
					"Get org-scoped content-free ready and signed-session reliability totals from consented widget lifecycle events.",
			})
			.input(
				z.object({
					from: z.string().datetime(),
					to: z.string().datetime(),
					installationId: z
						.uuid()
						.optional()
						.describe(
							"Omit to aggregate all provider-owned installations; otherwise restrict to this installation.",
						),
				}),
			)
			.output(WidgetLifecycleHealthSchema),

		getEmbeddedProviderActivity: oc
			.route({
				method: "GET",
				path: "/widget/provider-activity",
				summary: "Get signed embedded widget activity",
				description:
					"List provider-owned tenants and users that started signed embedded sessions, plus their bounded content-free activity.",
			})
			.input(
				z.object({
					from: z.string().datetime(),
					to: z.string().datetime(),
					installationId: z
						.uuid()
						.optional()
						.describe("Restrict history to one provider-owned installation."),
					hostUserId: z
						.string()
						.trim()
						.min(1)
						.max(200)
						.optional()
						.describe(
							"Restrict history to a stable host user ID within the selected installation.",
						),
					limit: z.coerce.number().int().min(1).max(100).default(50),
				}),
			)
			.output(EmbeddedProviderActivitySchema),

		trackEmbeddedWidgetLifecycle: oc
			.route({
				method: "POST",
				path: "/widget/embedded-lifecycle",
				tags: ["internal"],
				summary: "Record verified provider widget measurements",
			})
			.input(
				z
					.object({
						installationId: z.uuid(),
						providerAppId: z.uuid(),
						externalTenantId: z.string().min(1).max(200),
						allowedOrigin: z.url(),
						events: z
							.array(
								z
									.object({
										eventId: z.uuid(),
										milestone: z.enum([
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
										]),
										durationMs: z.number().int().min(0).max(300_000),
										phase: z
											.string()
											.regex(/^[A-Za-z0-9_.-]{1,80}$/)
											.optional()
											.describe(
												"Present only when the client observed a runtime phase.",
											),
										outcome: z
											.enum(["succeeded", "failed", "cancelled"])
											.optional()
											.describe(
												"Present only for terminal or successful connection outcomes.",
											),
										errorCode: z
											.string()
											.regex(/^[A-Za-z0-9_.-]{1,80}$/)
											.optional()
											.describe(
												"Present only when the client observed a bounded error classification.",
											),
										reconnectAttempt: z
											.number()
											.int()
											.min(1)
											.max(10)
											.optional()
											.describe("Present only for reconnect milestones."),
									})
									.strict(),
							)
							.min(1)
							.max(20),
					})
					.strict(),
			)
			.output(z.object({ accepted: z.number().int().nonnegative() })),

		trackWidgetLifecycle: oc
			.route({
				method: "POST",
				path: "/widget/lifecycle",
				summary: "Track embedded widget lifecycle events",
				description:
					"Record an authenticated organization batch of consented, content-free widget lifecycle events.",
			})
			.input(
				z.object({
					events: z.array(WidgetLifecycleEventSchema).min(1).max(20),
				}),
			)
			.output(z.object({ accepted: z.number().int().nonnegative() })),

		/**
		 * POST /analytics/widget-events - Track widget events (bulk)
		 * Internal endpoint called by apps/mcp-ui to send user interaction events
		 */
		trackWidgetEvents: oc
			.route({
				method: "POST",
				path: "/widget-events",
				tags: ["internal"],
				summary: "Track widget events",
				description:
					"Internal endpoint called by apps/mcp-ui to send user interaction events in bulk",
			})
			.input(
				z.object({
					events: z.array(WidgetEventSchema).min(1).max(100),
					/**
					 * Trusted appId from the calling Worker's context (e.g. agent.appId
					 * from the MCP subdomain). When provided, the handler validates
					 * every event.appId matches this value and rejects mismatched batches.
					 * Defense-in-depth against forged event.appId values.
					 */
					expectedAppId: z.uuid().optional(),
				}),
			)
			.output(z.object({ success: z.boolean(), tracked: z.number().int() })),

		/** Privacy-minimized outcome emitted by a signed embedded Tedi session. */
		trackEmbeddedAttentionOutcome: oc
			.route({
				method: "POST",
				path: "/embedded-attention-outcomes",
				tags: ["internal"],
				summary: "Track a signed embedded attention outcome",
				description:
					"Internal runtime-only endpoint. Signed embedded authority is revalidated before this bounded payload is sent.",
			})
			.input(
				z.object({
					id: z.uuid(),
					installationId: z.uuid(),
					providerAppId: z.uuid(),
					hostOrganizationId: z.string().trim().min(1).max(200),
					hostUserId: z.string().trim().min(1).max(200),
					origin: z.url().max(500),
					sessionId: z.string().min(1).max(256),
					eventType: z.enum(["impression", "open", "review"]),
					attentionRef: z.string().regex(/^attn_[a-f0-9]{32}$/),
				}),
			)
			.output(z.object({ success: z.literal(true) })),

		/** Correlate a fresh source brief with this actor's prior reviews. */
		correlateEmbeddedAttentionFollowUps: oc
			.route({
				method: "POST",
				path: "/embedded-attention-follow-ups",
				tags: ["internal"],
				summary: "Correlate current embedded attention with prior reviews",
				description:
					"Internal runtime-only endpoint. Returns only reviewed recommendations that a fresh provider brief proves are still open.",
			})
			.input(
				z.object({
					installationId: z.uuid(),
					providerAppId: z.uuid(),
					hostOrganizationId: z.string().trim().min(1).max(200),
					hostUserId: z.string().trim().min(1).max(200),
					origin: z.url().max(500),
					sessionId: z.string().min(1).max(256),
					sourceGeneratedAt: z.string().datetime(),
					attentionRefs: z
						.array(z.string().regex(/^attn_[a-f0-9]{32}$/))
						.min(1)
						.max(2),
				}),
			)
			.output(
				z.object({
					items: z.array(
						z.object({
							attentionRef: z.string().regex(/^attn_[a-f0-9]{32}$/),
							state: z.literal("still_open"),
							reviewedAt: z.string().datetime(),
						}),
					),
				}),
			),
	});

export type AnalyticsContract = typeof analyticsContract;

export {
	type AnalyticsMetrics,
	AnalyticsMetricsSchema,
	AppActivityFreshnessSchema,
	AppSummarySchema,
	AppTimeSeriesSchema,
	AppToolBreakdownItemSchema,
	AppToolBreakdownSchema,
	CodemodeAnalyticsSummarySchema,
	CodemodeExecSummarySchema,
	CodemodeNamespaceSummarySchema,
	CodemodeToolStatSchema,
	ExternalAgentValidationSloSchema,
	ExecutionDrilldownSchema,
	ExecutionEventSchema,
	HumanActivityReviewSchema,
	RecentExecutionSchema,
	RecentExecutionsSchema,
	TimeSeriesBucketSchema,
	type ToolCallPayload,
	ToolCallPayloadSchema,
	ToolCallPayloadsSchema,
	TraceEvidenceSummarySchema,
	type WidgetEvent,
	WidgetEventSchema,
} from "../schemas/analytics";
