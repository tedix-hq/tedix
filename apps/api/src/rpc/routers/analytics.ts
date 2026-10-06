/**
 * Analytics oRPC Router (Contract-based)
 *
 * Contract-first development pattern for analytics data.
 * Serves analytics data to Tedix OS with internal tracking endpoints.
 *
 * Public endpoints (tagged: ['analytics']):
 * - getMetrics: GET /apps/{appId}/analytics
 *
 * Internal tracking endpoints (tagged: ['analytics', 'internal']):
 * - trackWidgetEvents: POST /analytics/widget-events
 *
 * Note: trackToolCall was removed — Analytics Engine is now the sole metrics
 * source for MCP tool calls. The mcp_tool_calls D1 table is being drained.
 */

import { implement } from "@orpc/server";
import {
	analyticsContract,
	type WidgetEvent,
} from "@tedix/api-contract/contracts/analytics";
import type {
	ActivityItem,
	ActivityReviewGroup,
	AppDescriptor,
	CognitionEvidenceBundle,
	HumanActivityReview,
	IdentityCoverage,
	PrincipalDescriptor,
	ToolDescriptor,
	TraceEvidenceCoverage,
	TraceEvidenceSummary,
	TraceFreshnessCoverage,
} from "@tedix/api-contract/schemas/analytics";
import {
	extractFactIdsFromEvidence,
	parseEvidencePayload,
} from "@tedix/api-contract/utils/fact-evidence";
import { isPlatformPrincipal } from "@tedix/auth/types";
import {
	getOrganizationIdForApp,
	getOrganizationIdsForApps,
	listEmbeddedProviderActivity,
	listEmbeddedAttentionReviews,
	trackEmbeddedAttentionOutcome,
	trackEmbeddedAttentionOutcomes,
	trackWidgetEvents,
} from "@tedix/db/queries/analytics";

import { getOrganizationById } from "@tedix/db/queries/organizations";
import { resolveActiveProviderInstallationForOutcome } from "@tedix/db/queries/provider-installations";
import {
	getAnalyticsAppFreshness,
	listAnalyticsAuditActivityWindow,
	listAnalyticsExecutionAuditRows,
	listAnalyticsRationaleEvidence,
	listAnalyticsRuntimeTraceEvidence,
	listAnalyticsTraceActivity,
	listRecentAnalyticsAuditActivity,
} from "@tedix/db/queries/analytics-audit";
import {
	listAnalyticsAppsByIds,
	listAnalyticsAppsBySlugs,
	listAnalyticsOrganizationMembers,
	listAnalyticsTedis,
	listAnalyticsTools,
	listAnalyticsUsers,
} from "@tedix/db/queries/analytics-hydration";
import { listExternalAgentPrincipalsByIds } from "@tedix/db/queries/external-agent-identity/principals";
import { insertAuditEvent } from "@tedix/db/queries/audit";
import { listTediObservabilityRows } from "@tedix/db/queries/cognitive-runtime";
import { listSkillRetrievalUtility } from "@tedix/db/queries/skill-retrieval-utility";
import type { NewWidgetEvent } from "@tedix/db/schema/analytics";
import { toJsonRecord } from "@tedix/db/utils/json";
import {
	getAppMetricsFromAE,
	getAppSummaryFromAE,
	getAppTimeSeriesFromAE,
	getAppToolBreakdownFromAE,
	getExecutionDrilldownFromAE,
	getRecentExecutionsFromAE,
	hasAEConfig,
	hasCodemodeAEConfig,
	queryCodemodeAnalyticsSummary,
} from "../../lib/analytics-engine";
import {
	type AuditActivityRow,
	buildDelegationChain,
	buildIdentityCoverage,
	humanizeIdentifier,
	mapAuditActivityRows,
	unresolvedApp,
	unresolvedPrincipal,
	unresolvedTool,
} from "../../lib/audit-activity";
import { buildDrilldownFromAuditRows } from "../../lib/execution-drilldown";
import { getToolCallPayloadsFromR2, hasR2SqlConfig } from "../../lib/r2-sql";
import {
	type CloudflareTraceEvidence,
	hasWorkersObservabilityConfig,
	queryWorkersTraceEvidence,
} from "../../lib/workers-observability";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
	withServiceAuth,
} from "../orpc";
import { requireOrgId } from "../org-scope";
import { auditActor } from "../audit-helpers";
import {
	OBSERVABILITY_MAX_WINDOW_MS,
	projectTediObservability,
	requireObservabilityTediAccess,
} from "./analytics-tedi-observability";

import {
	getWidgetLifecycleHealthProcedure,
	getExternalAgentValidationSloProcedure,
} from "./analytics-health";

/**
 * Create the contract implementer with base context
 * This enforces type safety between contract and implementation
 */
const analyticsOs = implement(analyticsContract).$context<BaseContext>();

/**
 * Create authenticated implementer - ALL procedures inherit auth
 * This ensures all analytics endpoints require authentication
 */
const authedAnalyticsOs = analyticsOs.use(withAuth);

export const getEmbeddedProviderActivityProcedure =
	authedAnalyticsOs.getEmbeddedProviderActivity
		.use(AUTHZ.analyticsRead)
		.handler(async ({ input, context }) => {
			const providerOrganizationId = requireOrgId(
				context,
				"embedded provider activity",
			);
			const source = await listEmbeddedProviderActivity(context.db, {
				providerOrganizationId,
				from: input.from,
				to: input.to,
				limit: 1_000,
				installationId: input.installationId,
				hostUserId: input.hostUserId,
			});
			const rows = source.flatMap((row) => {
				const createdAt = row.createdAt
					? normalizeD1Timestamp(row.createdAt)
					: null;
				return createdAt ? [{ ...row, createdAt }] : [];
			});
			const tenants = new Map<
				string,
				{
					installationId: string;
					externalTenantId: string;
					users: Set<string>;
					sessions: Set<string>;
					events: number;
					lastSeenAt: string;
				}
			>();
			const users = new Map<
				string,
				{
					installationId: string;
					externalTenantId: string;
					hostUserId: string;
					hostUserLabel: string | null;
					hostRole: string | null;
					sessions: Set<string>;
					events: number;
					lastSeenAt: string;
				}
			>();
			for (const row of rows) {
				const tenant = tenants.get(row.installationId) ?? {
					installationId: row.installationId,
					externalTenantId: row.externalTenantId,
					users: new Set<string>(),
					sessions: new Set<string>(),
					events: 0,
					lastSeenAt: row.createdAt,
				};
				tenant.users.add(row.hostUserId);
				tenant.sessions.add(row.sessionId);
				tenant.events += 1;
				tenants.set(row.installationId, tenant);

				const key = `${row.installationId}:${row.hostUserId}`;
				const user = users.get(key) ?? {
					installationId: row.installationId,
					externalTenantId: row.externalTenantId,
					hostUserId: row.hostUserId,
					hostUserLabel: row.hostUserLabel,
					hostRole: row.hostRole,
					sessions: new Set<string>(),
					events: 0,
					lastSeenAt: row.createdAt,
				};
				if (!user.hostUserLabel && row.hostUserLabel)
					user.hostUserLabel = row.hostUserLabel;
				if (!user.hostRole && row.hostRole) user.hostRole = row.hostRole;
				user.sessions.add(row.sessionId);
				user.events += 1;
				users.set(key, user);
			}
			return {
				from: input.from,
				to: input.to,
				tenants: [...tenants.values()].map(({ users, sessions, ...row }) => ({
					...row,
					activeUsers: users.size,
					sessions: sessions.size,
				})),
				users: [...users.values()].map(({ sessions, ...row }) => ({
					...row,
					sessions: sessions.size,
				})),
				recent: rows.slice(0, input.limit).map((row) => ({
					id: row.id,
					installationId: row.installationId,
					externalTenantId: row.externalTenantId,
					hostUserId: row.hostUserId,
					hostUserLabel: row.hostUserLabel,
					eventType: row.eventType,
					createdAt: row.createdAt,
				})),
			};
		});

export const trackEmbeddedWidgetLifecycleProcedure =
	analyticsOs.trackEmbeddedWidgetLifecycle
		.use(withServiceAuth)
		.handler(async ({ input, context }) => {
			const customerOrganizationId = context.headers.get("X-Tedix-Org-Id");
			const primaryTediId = context.headers.get("X-Tedix-Tedi-Id");
			if (!customerOrganizationId || !primaryTediId)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Embedded authority is required",
				);
			const installation = await resolveActiveProviderInstallationForOutcome(
				context.db,
				{ ...input, customerOrganizationId, primaryTediId },
			);
			if (!installation)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Embedded installation is unavailable",
				);
			const provider = await getOrganizationById(
				context.db,
				installation.providerOrganizationId,
			);
			if (
				provider?.metadata?.tediWidget?.analyticsEnabled !== true ||
				!context.env.WIDGET_ANALYTICS
			)
				return { accepted: 0 };
			for (const event of input.events) {
				const name =
					event.milestone === "submitted"
						? "message_submitted"
						: event.milestone === "first_text"
							? "first_token"
							: event.milestone === "rendered" && event.outcome === "succeeded"
								? "answer_completed"
								: event.milestone === "failed"
									? event.outcome === "cancelled"
										? "answer_cancelled"
										: "answer_failed"
									: event.milestone === "ready" || event.milestone === "session"
										? "performance"
										: "client_turn_milestone";
				context.env.WIDGET_ANALYTICS.writeDataPoint({
					blobs: [
						name,
						event.milestone === "ready" || event.milestone === "session"
							? event.milestone
							: (event.phase ?? ""),
						event.outcome ?? "",
						installation.providerOrganizationId,
						String(context.env.GIT_SHA || "unknown").slice(0, 64),
						event.errorCode ?? "",
						"embedded_widget",
						event.milestone,
						installation.id,
						installation.allowedOrigin,
					],
					doubles: [event.durationMs],
					indexes: [installation.providerOrganizationId],
				});
			}
			return { accepted: input.events.length };
		});

export const trackWidgetLifecycleProcedure =
	authedAnalyticsOs.trackWidgetLifecycle
		.use(AUTHZ.analyticsRead)
		.handler(async ({ input, context }) => {
			const organizationId = requireOrgId(
				context,
				"widget lifecycle analytics",
			);
			if (!context.env.WIDGET_ANALYTICS) return { accepted: 0 };
			for (const event of input.events) {
				context.env.WIDGET_ANALYTICS.writeDataPoint({
					blobs: [
						event.event,
						event.phase ?? "",
						event.outcome ?? "",
						organizationId,
						String(context.env.GIT_SHA || "unknown").slice(0, 64),
						event.code ?? "",
						event.surface ?? "",
						event.milestone ?? "",
					],
					doubles: [event.durationMs ?? 0],
					indexes: [organizationId],
				});
				if (event.event === "client_turn_milestone") {
					console.info("client_turn_milestone", {
						eventId: event.eventId ?? null,
						organizationId,
						surface: event.surface ?? "native_os",
						milestone: event.milestone ?? null,
						durationMs: event.durationMs ?? 0,
						conversationId: event.conversationId ?? null,
						runId: event.runId ?? null,
						traceId: event.traceId ?? event.runId ?? null,
						outcome: event.outcome ?? null,
					});
				}
			}
			return { accepted: input.events.length };
		});

// =============================================================================
// CONTRACT-BASED MIDDLEWARE
// =============================================================================

// =============================================================================
// CONTRACT-BASED PROCEDURE IMPLEMENTATIONS
// =============================================================================

/**
 * Contract-based getMetrics procedure implementation
 */
export const getMetricsProcedure = authedAnalyticsOs.getMetrics
	.use(AUTHZ.analyticsRead)
	.handler(async ({ input, context }) => {
		const { env } = context;
		const { appId, from, to } = input;

		// Enforce org-from-context: caller may only read their own org's app
		// (platform principals may read cross-org). App-scoped metrics below
		// filter by appId, not org, so the resolved org is only used for access.
		await resolveAppOrgScoped(context, appId);

		const fallback = {
			totalSessions: 0,
			sessionsChange: undefined,
			avgMessages: 0,
			avgMessagesChange: undefined,
			successRate: 0,
			successRateChange: undefined,
		};

		// Query Analytics Engine SQL API (sole metrics source for tool calls)
		if (!hasAEConfig(env)) return fallback;

		try {
			return await getAppMetricsFromAE(env, appId, from, to);
		} catch (error) {
			console.error("[Analytics] AE query failed, returning zeros:", error);
			return fallback;
		}
	});

/**
 * Contract-based getAppToolBreakdown procedure implementation
 */
export const getAppToolBreakdownProcedure =
	authedAnalyticsOs.getAppToolBreakdown
		.use(AUTHZ.analyticsRead)
		.handler(async ({ input, context }) => {
			const { env } = context;
			const { appId, from, to, limit } = input;

			// Enforce org-from-context before reading app telemetry.
			await resolveAppOrgScoped(context, appId);

			if (!hasAEConfig(env)) return { tools: [] };

			try {
				const tools = await getAppToolBreakdownFromAE(
					env,
					appId,
					from,
					to,
					limit,
				);
				return { tools };
			} catch (error) {
				console.error("[Analytics] AE tool breakdown query failed:", error);
				return { tools: [] };
			}
		});

/**
 * Contract-based getAppSummary procedure implementation
 */
export const getAppSummaryProcedure = authedAnalyticsOs.getAppSummary
	.use(AUTHZ.analyticsRead)
	.handler(async ({ input, context }) => {
		const { env } = context;
		const { appId, from, to } = input;

		// Enforce org-from-context before reading app telemetry.
		await resolveAppOrgScoped(context, appId);

		const fallback = {
			totalEvents: 0,
			toolCalls: 0,
			promptCalls: 0,
			codeExecs: 0,
			successRate: 0,
			avgDurationMs: 0,
			uniqueUsers: 0,
			uniqueCallerTypes: [],
		};

		if (!hasAEConfig(env)) return fallback;

		try {
			return await getAppSummaryFromAE(env, appId, from, to);
		} catch (error) {
			console.error("[Analytics] AE app summary query failed:", error);
			return fallback;
		}
	});

/**
 * Contract-based getAppTimeSeries procedure implementation
 * Returns time-bucketed event metrics for an app.
 */
export const getAppTimeSeriesProcedure = authedAnalyticsOs.getAppTimeSeries
	.use(AUTHZ.analyticsRead)
	.handler(async ({ input, context }) => {
		const { env } = context;
		const { appId, from, to, granularity } = input;

		// Enforce org-from-context before reading app telemetry.
		await resolveAppOrgScoped(context, appId);

		if (!hasAEConfig(env)) return { buckets: [] };

		try {
			const buckets = await getAppTimeSeriesFromAE(
				env,
				appId,
				from,
				to,
				granularity,
			);
			return { buckets };
		} catch (error) {
			console.error("[Analytics] AE time-series query failed:", error);
			return { buckets: [] };
		}
	});

/**
 * Contract-based getRecentExecutions procedure implementation
 * Lists recent Code Mode executions for drill-down navigation.
 */
export const getRecentExecutionsProcedure =
	authedAnalyticsOs.getRecentExecutions
		.use(AUTHZ.analyticsRead)
		.handler(async ({ input, context }) => {
			const { env } = context;
			const { appId, from, to, limit } = input;

			// Enforce org-from-context before reading app telemetry.
			await resolveAppOrgScoped(context, appId);

			if (!hasAEConfig(env)) return { executions: [] };

			try {
				const executions = await getRecentExecutionsFromAE(
					env,
					appId,
					from,
					to,
					limit,
				);
				return { executions };
			} catch (error) {
				console.error("[Analytics] AE recent executions query failed:", error);
				return { executions: [] };
			}
		});

/**
 * Contract-based getAppFreshness procedure implementation.
 * Reads the audit trail directly so Tedix OS can show current-window
 * activity even while AE aggregates are delayed or intentionally bucketed.
 */
export const getAppFreshnessProcedure = authedAnalyticsOs.getAppFreshness
	.use(AUTHZ.analyticsRead)
	.handler(async ({ input, context }) => {
		const { appId } = input;
		const organizationId = await resolveAppOrgScoped(context, appId);
		const now = new Date();
		const windowEnd = input.windowEnd ? new Date(input.windowEnd) : now;
		const windowStart = input.windowStart
			? new Date(input.windowStart)
			: new Date(
					Date.UTC(
						windowEnd.getUTCFullYear(),
						windowEnd.getUTCMonth(),
						windowEnd.getUTCDate(),
						windowEnd.getUTCHours(),
						0,
						0,
						0,
					),
				);
		const windowStartSeconds = Math.floor(windowStart.getTime() / 1000);
		const windowEndSeconds = Math.floor(windowEnd.getTime() / 1000);

		const { countsRow, latestRow } = await getAnalyticsAppFreshness(
			context.db,
			{
				organizationId,
				appId,
				windowStartSeconds,
				windowEndSeconds,
			},
		);

		return {
			windowStart: windowStart.toISOString(),
			windowEnd: windowEnd.toISOString(),
			currentWindow: {
				totalEvents: Number(countsRow?.totalEvents ?? 0),
				toolExecutions: Number(countsRow?.toolExecutions ?? 0),
				codeExecutions: Number(countsRow?.codeExecutions ?? 0),
				toolErrors: Number(countsRow?.toolErrors ?? 0),
			},
			latestAuditEvent: latestRow
				? {
						action: latestRow.action,
						resourceId: latestRow.resourceId,
						timestamp: auditTimestampToIso(latestRow.timestamp),
						durationMs: nullableNumber(latestRow.durationMs),
						executionId: latestRow.executionId,
						traceId: latestRow.traceId,
						toolCount: nullableNumber(latestRow.toolCount),
						namespaceCount: nullableNumber(latestRow.namespaceCount),
					}
				: null,
		};
	});

/**
 * Contract-based getExecutionDrilldown procedure implementation
 * Drills into a single Code Mode execution by executionId.
 */
export const getExecutionDrilldownProcedure =
	authedAnalyticsOs.getExecutionDrilldown
		.use(AUTHZ.analyticsRead)
		.handler(async ({ input, context }) => {
			const { env } = context;
			const { executionId } = input;

			// Enforce org-from-context: scope to the caller's org so an executionId
			// from another tenant resolves to nothing (platform principals pass
			// undefined for full cross-org access).
			const organizationId = analyticsOrgScope(context);
			// PRIMARY lane: D1 audit_events — unsampled, has every inner tool call,
			// and carries the actor identity (AE has neither guarantee). AE is a
			// sampled aggregate store; its inner rows for one execution can be
			// dropped, which is why this drilldown previously came back empty.
			try {
				const rows = await listAnalyticsExecutionAuditRows(context.db, {
					executionId,
					organizationId,
				});
				if (rows.length > 0) {
					const drilldown = buildDrilldownFromAuditRows(rows);
					const contextRow =
						rows.find((r) => r.action.startsWith("mcp.code")) ?? rows[0];
					if (contextRow) {
						const [activity] = await hydrateActivityRows(
							context,
							[
								{
									action: contextRow.action,
									actorId: contextRow.actorId,
									actorType: contextRow.actorType,
									resourceId: contextRow.resourceId,
									timestamp: contextRow.timestamp,
									appId: null,
									durationMs: contextRow.durationMs,
									errorCode: contextRow.errorCode,
									executionId,
									traceId: contextRow.traceId,
									clientId: contextRow.clientId,
									subjectUserId: contextRow.subjectUserId,
									agentTediId: contextRow.agentTediId,
									oauthClientId: contextRow.oauthClientId,
									delegationMode: contextRow.delegationMode,
								},
							],
							organizationId,
						);
						return {
							...drilldown,
							attribution: activity?.attribution ?? null,
							identityCoverage: activity?.identityCoverage ?? null,
						};
					}
					return drilldown;
				}
			} catch (error) {
				console.error("[Analytics] audit drilldown query failed:", error);
			}

			// FALLBACK lane: AE — for executions older than the audit trail, or if
			// the audit query failed. No actor/errorCode available here.
			const fallback = {
				execution: null,
				toolCalls: [],
				actor: null,
				traceId: null,
				clientId: null,
				source: "analytics_engine" as const,
			};
			if (!hasAEConfig(env)) return fallback;
			try {
				const ae = await getExecutionDrilldownFromAE(
					env,
					executionId,
					organizationId,
				);
				return { ...fallback, ...ae, source: "analytics_engine" as const };
			} catch (error) {
				console.error(
					"[Analytics] AE execution drilldown query failed:",
					error,
				);
				return fallback;
			}
		});

/**
 * Contract-based getToolCallPayloads procedure implementation.
 * Reads tool-call request/response payloads from R2 SQL (R2 Data Catalog /
 * Iceberg). Requires traceId or executionId. Returns empty + configured=false
 * when R2 SQL is not configured, and degrades to empty on query error (like the
 * AE procedures) so Tedix OS never hard-fails on a payload drill-down.
 */
export const getToolCallPayloadsProcedure =
	authedAnalyticsOs.getToolCallPayloads
		.use(AUTHZ.analyticsRead)
		.handler(async ({ input, context }) => {
			const { env } = context;
			const { traceId, executionId, toolName, limit } = input;

			if (!traceId && !executionId) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Provide traceId or executionId to read tool-call payloads.",
				);
			}

			const configured = hasR2SqlConfig(env);
			if (!configured) return { payloads: [], configured };

			// Payload forensics are tenant-scoped: the query is hard-filtered to
			// the caller's org so a circulating trace id can never read another
			// org's payloads.
			if (!context.organizationId) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Organization context is required to read tool-call payloads.",
				);
			}

			try {
				const payloads = await getToolCallPayloadsFromR2(env, {
					organizationId: context.organizationId,
					traceId,
					executionId,
					toolName,
					limit,
				});
				return { payloads, configured };
			} catch (error) {
				console.error("[Analytics] R2 SQL payload query failed:", error);
				return { payloads: [], configured };
			}
		});

/**
 * Recent MCP tool/code activity WITH the actor identity, from D1 audit_events
 * (authoritative + unsampled). This is the "who used which tool recently" lane —
 * the question that, answered against sampled AE / shallow R2, misattributes.
 */
export const getRecentActivityProcedure = authedAnalyticsOs.getRecentActivity
	.use(AUTHZ.analyticsRead)
	.handler(async ({ input, context }) => {
		const organizationId = analyticsOrgScope(context);
		const limit = input.limit ?? 50;
		const rows = await listRecentAnalyticsAuditActivity(context.db, {
			organizationId,
			appId: input.appId,
			actorId: input.actorId,
			limit,
		});
		return { items: await hydrateActivityRows(context, rows, organizationId) };
	});

/**
 * Everything correlated to one request trace, joined across lanes: D1 audit
 * (actor + every inner tool, authoritative) + R2 payload bodies (when capture
 * covered the window). Org-scoped; payloads require an org (platform principals
 * get events but no R2 bodies, since R2 reads are hard org-filtered).
 */
export const getTraceActivityProcedure = authedAnalyticsOs.getTraceActivity
	.use(AUTHZ.analyticsRead)
	.handler(async ({ input, context }) => {
		const { env } = context;
		const organizationId = analyticsOrgScope(context);
		const { traceId } = input;
		const rows = await listAnalyticsTraceActivity(context.db, {
			traceId,
			organizationId,
		});
		const events = await hydrateActivityRows(context, rows, organizationId);

		const payloadsConfigured = hasR2SqlConfig(env);
		let payloads: Awaited<ReturnType<typeof getToolCallPayloadsFromR2>> = [];
		if (payloadsConfigured && organizationId) {
			try {
				payloads = await getToolCallPayloadsFromR2(env, {
					organizationId,
					traceId,
					limit: 50,
				});
			} catch (error) {
				console.error("[Analytics] trace payload join failed:", error);
			}
		}
		return { events, payloads, payloadsConfigured };
	});

/**
 * Human-readable grouped MCP activity review. This keeps audit_events as the
 * evidence source, then adds the semantic layer operators actually read.
 */
export const getHumanActivityReviewProcedure =
	authedAnalyticsOs.getHumanActivityReview
		.use(AUTHZ.analyticsRead)
		.handler(async ({ input, context }) => {
			const organizationId = analyticsOrgScope(context);
			const now = new Date();
			const windowEnd = input.to ? new Date(input.to) : now;
			const windowStart = input.from
				? new Date(input.from)
				: new Date(windowEnd.getTime() - 24 * 60 * 60 * 1000);
			const startSeconds = Math.floor(windowStart.getTime() / 1000);
			const endSeconds = Math.floor(windowEnd.getTime() / 1000);
			const limit = input.limit ?? 250;
			const rows = await listAnalyticsAuditActivityWindow(context.db, {
				organizationId,
				appId: input.appId,
				actorId: input.actorId,
				startSeconds,
				endSeconds,
				limit,
			});
			const items = await hydrateActivityRows(context, rows, organizationId);
			const traceEvidenceByTraceId = await loadTraceEvidenceSummaries(
				context,
				organizationId,
				items.map((item) => item.traceId).filter((id): id is string => !!id),
				windowStart.getTime(),
				windowEnd.getTime(),
			);
			return buildHumanActivityReview({
				items,
				windowStart: windowStart.toISOString(),
				windowEnd: windowEnd.toISOString(),
				payloadsConfigured: hasR2SqlConfig(context.env),
				traceEvidenceByTraceId,
			});
		});

export const getTediObservabilitySnapshotProcedure =
	authedAnalyticsOs.getTediObservabilitySnapshot
		.use(AUTHZ.analyticsRead)
		.handler(async ({ input, context }) => {
			const from = new Date(input.from);
			const to = new Date(input.to);
			if (
				to.getTime() <= from.getTime() ||
				to.getTime() - from.getTime() > OBSERVABILITY_MAX_WINDOW_MS
			) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Observability window must be positive and no longer than 24 hours",
				);
			}
			const tedi = await requireObservabilityTediAccess(context, input.tediId);
			const rows = await listTediObservabilityRows(context.db, {
				organizationId: tedi.organizationId,
				tediId: input.tediId,
				from: from.toISOString(),
				to: to.toISOString(),
				limit: input.limit,
			});
			const receiptId = crypto.randomUUID();
			const actor = auditActor(context);
			await insertAuditEvent(context.db, {
				id: receiptId,
				organizationId: tedi.organizationId,
				actorId: actor.actorId,
				actorType: actor.actorType,
				action: "observability.snapshot.read",
				resourceType: "tedi",
				resourceId: input.tediId,
				metadata: toJsonRecord({
					from: from.toISOString(),
					to: to.toISOString(),
					limit: input.limit,
					runtimeEventCount: rows.runtimeEvents.length,
					auditEventCount: rows.auditEvents.length,
					truncated: rows.runtimeTruncated || rows.auditTruncated,
					...actor.actorMetadata,
				}),
				ipAddress: context.headers.get("CF-Connecting-IP"),
				userAgent: context.headers.get("User-Agent"),
			});
			return projectTediObservability({
				tediId: input.tediId,
				from: from.toISOString(),
				to: to.toISOString(),
				runtimeEvents: rows.runtimeEvents,
				auditEvents: rows.auditEvents,
				truncated: rows.runtimeTruncated || rows.auditTruncated,
				auditReceiptId: receiptId,
			});
		});

export const getSkillRetrievalUtilityProcedure =
	authedAnalyticsOs.getSkillRetrievalUtility
		.use(AUTHZ.analyticsRead)
		.handler(async ({ input, context }) => {
			const from = new Date(input.from);
			const to = new Date(input.to);
			if (
				to.getTime() <= from.getTime() ||
				to.getTime() - from.getTime() > OBSERVABILITY_MAX_WINDOW_MS
			) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Skill utility window must be positive and no longer than 24 hours",
				);
			}
			const tedi = await requireObservabilityTediAccess(context, input.tediId);
			const result = await listSkillRetrievalUtility(context.db, {
				organizationId: tedi.organizationId,
				tediId: input.tediId,
				from: from.toISOString(),
				to: to.toISOString(),
				limit: input.limit,
			});
			const auditReceiptId = crypto.randomUUID();
			const actor = auditActor(context);
			await insertAuditEvent(context.db, {
				id: auditReceiptId,
				organizationId: tedi.organizationId,
				actorId: actor.actorId,
				actorType: actor.actorType,
				action: "skill.retrieval_utility.read",
				resourceType: "tedi",
				resourceId: input.tediId,
				metadata: toJsonRecord({
					from: from.toISOString(),
					to: to.toISOString(),
					limit: input.limit,
					rowCount: result.rows.length,
					truncated: result.truncated,
					...actor.actorMetadata,
				}),
				ipAddress: context.headers.get("CF-Connecting-IP"),
				userAgent: context.headers.get("User-Agent"),
			});
			return {
				tediId: input.tediId,
				from: from.toISOString(),
				to: to.toISOString(),
				source: "tenant_d1" as const,
				truncated: result.truncated,
				metrics: {
					injected: result.rows.length,
					verifiedSuccess: result.rows.filter((row) => row.status === "success")
						.length,
					verifiedFailure: result.rows.filter((row) => row.status === "failure")
						.length,
					unknown: result.rows.filter((row) => row.status === "unknown").length,
				},
				rows: result.rows,
				auditReceiptId,
			};
		});

/**
 * Contract-based getCodemodeAnalyticsSummary procedure implementation.
 *
 * Reads from the Code Mode Analytics Engine dataset written directly by
 * apps/mcp.
 * No appId → org-scoped. With appId → additionally filtered to that app.
 * Platform principals read cross-org (no org filter).
 * Returns empty when CF_ACCOUNT_ID / token are not configured.
 */
export const getCodemodeAnalyticsSummaryProcedure =
	authedAnalyticsOs.getCodemodeAnalyticsSummary
		.use(AUTHZ.analyticsRead)
		.handler(async ({ input, context }) => {
			const { env } = context;
			const { from, to, appId, limit } = input;

			const fallback = {
				byNamespace: [],
				topTools: [],
				execSummary: {
					totalExecs: 0,
					successExecs: 0,
					failedExecs: 0,
					successRate: 0,
					avgDurationMs: 0,
					avgToolCount: 0,
					avgNamespaceCount: 0,
				},
			};

			if (!hasCodemodeAEConfig(env)) return fallback;

			// Enforce org-scoped access: platform principals get full cross-org read;
			// tenant callers are filtered to their own org. When appId is provided,
			// also verify the caller has access to that app.
			const organizationId = isPlatformPrincipal(context)
				? undefined
				: (context.organizationId ?? undefined);

			if (!isPlatformPrincipal(context) && appId) {
				await resolveAppOrgScoped(context, appId);
			}

			try {
				return await queryCodemodeAnalyticsSummary(env, from, to, {
					organizationId,
					appId,
					limit,
				});
			} catch (error) {
				console.error("[Analytics] Codemode AE query failed:", error);
				return fallback;
			}
		});

/**
 * Contract-based trackWidgetEvents procedure implementation
 * Internal endpoint - tagged: ['analytics', 'internal']
 *
 * SECURITY: Uses service auth - called from MCP server
 */
export const trackWidgetEventsProcedure = analyticsOs.trackWidgetEvents
	.use(withServiceAuth)
	.handler(async ({ input, context }) => {
		const { db } = context;

		// Defense-in-depth: when caller supplies expectedAppId (e.g. MCP Worker
		// passing its subdomain-pinned agent.appId), reject any event whose appId
		// doesn't match. Prevents an internal service-binding caller from
		// attributing events to apps they don't represent.
		if (input.expectedAppId) {
			const mismatches = input.events.filter(
				(e) => e.appId !== input.expectedAppId,
			);
			if (mismatches.length > 0) {
				console.warn(
					`[Analytics] Rejected ${mismatches.length}/${input.events.length} events: appId mismatch (expected ${input.expectedAppId})`,
				);
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Event appId does not match expectedAppId",
				);
			}
		}

		try {
			const resolvedEvents = await resolveWidgetEventsWithOrgIds(input.events, {
				resolveAppIds: (appIds) => getOrganizationIdsForApps(db, appIds),
			});
			await trackWidgetEvents(db, resolvedEvents);
			return { success: true, tracked: input.events.length };
		} catch (error) {
			console.error("[Analytics] Failed to track widget events:", error);
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Failed to track widget events",
			);
		}
	});

export const trackEmbeddedAttentionOutcomeProcedure =
	analyticsOs.trackEmbeddedAttentionOutcome
		.use(withServiceAuth)
		.handler(async ({ input, context }) => {
			const organizationId = context.headers.get("X-Tedix-Org-Id");
			const tediId = context.headers.get("X-Tedix-Tedi-Id");
			if (!organizationId || !tediId) {
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Embedded Tedi authority headers are required",
				);
			}
			const installation = await resolveActiveProviderInstallationForOutcome(
				context.db,
				{
					installationId: input.installationId,
					providerAppId: input.providerAppId,
					customerOrganizationId: organizationId,
					primaryTediId: tediId,
					externalTenantId: input.hostOrganizationId,
					allowedOrigin: input.origin,
				},
			);
			if (!installation) {
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Embedded attention authority does not match an active installation",
				);
			}
			await trackEmbeddedAttentionOutcome(context.db, {
				id: input.id,
				organizationId,
				appId: installation.providerAppId,
				sessionId: input.sessionId,
				eventType: `attention_${input.eventType}`,
				widgetKey: input.attentionRef,
				displayMode: "inline",
				metadata: {
					installationId: installation.id,
					tediId,
					hostOrganizationId: input.hostOrganizationId,
					hostUserId: input.hostUserId,
					origin: input.origin,
				},
			});
			return { success: true as const };
		});

function normalizeD1Timestamp(value: string): string | null {
	const candidate = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
	const parsed = Date.parse(candidate);
	return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export const correlateEmbeddedAttentionFollowUpsProcedure =
	analyticsOs.correlateEmbeddedAttentionFollowUps
		.use(withServiceAuth)
		.handler(async ({ input, context }) => {
			const organizationId = context.headers.get("X-Tedix-Org-Id");
			const tediId = context.headers.get("X-Tedix-Tedi-Id");
			if (!organizationId || !tediId) {
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Embedded Tedi authority headers are required",
				);
			}
			const installation = await resolveActiveProviderInstallationForOutcome(
				context.db,
				{
					installationId: input.installationId,
					providerAppId: input.providerAppId,
					customerOrganizationId: organizationId,
					primaryTediId: tediId,
					externalTenantId: input.hostOrganizationId,
					allowedOrigin: input.origin,
				},
			);
			if (!installation) {
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Embedded attention authority does not match an active installation",
				);
			}

			const reviews = await listEmbeddedAttentionReviews(context.db, {
				organizationId,
				appId: installation.providerAppId,
				installationId: installation.id,
				tediId,
				hostOrganizationId: input.hostOrganizationId,
				hostUserId: input.hostUserId,
				origin: input.origin,
				attentionRefs: [...new Set(input.attentionRefs)],
			});
			const items = reviews.flatMap((review) => {
				const reviewedAt = normalizeD1Timestamp(review.reviewedAt);
				return reviewedAt
					? [
							{
								attentionRef: review.attentionRef,
								state: "still_open" as const,
								reviewedAt,
							},
						]
					: [];
			});
			await trackEmbeddedAttentionOutcomes(
				context.db,
				items.map((item) => ({
					id: crypto.randomUUID(),
					organizationId,
					appId: installation.providerAppId,
					sessionId: input.sessionId,
					eventType: "attention_still_open",
					widgetKey: item.attentionRef,
					displayMode: "inline",
					metadata: {
						installationId: installation.id,
						tediId,
						hostOrganizationId: input.hostOrganizationId,
						hostUserId: input.hostUserId,
						origin: input.origin,
						reviewedAt: item.reviewedAt,
						sourceGeneratedAt: input.sourceGeneratedAt,
					},
				})),
			);
			return { items };
		});

/**
 * Contract-based router using os.router() pattern
 * This enforces that all procedures match the contract
 *
 * Note: Uses base implementer (analyticsOs) to allow mixed auth:
 * - getMetrics: user auth (Tedix OS)
 * - trackWidgetEvents: service auth (MCP internal)
 */
export const analyticsContractRouter = analyticsOs.router({
	getMetrics: getMetricsProcedure,
	getAppToolBreakdown: getAppToolBreakdownProcedure,
	getAppSummary: getAppSummaryProcedure,
	getAppTimeSeries: getAppTimeSeriesProcedure,
	getRecentExecutions: getRecentExecutionsProcedure,
	getAppFreshness: getAppFreshnessProcedure,
	getExecutionDrilldown: getExecutionDrilldownProcedure,
	getToolCallPayloads: getToolCallPayloadsProcedure,
	getRecentActivity: getRecentActivityProcedure,
	getTraceActivity: getTraceActivityProcedure,
	getHumanActivityReview: getHumanActivityReviewProcedure,
	getTediObservabilitySnapshot: getTediObservabilitySnapshotProcedure,
	getSkillRetrievalUtility: getSkillRetrievalUtilityProcedure,
	getCodemodeAnalyticsSummary: getCodemodeAnalyticsSummaryProcedure,
	getExternalAgentValidationSlo: getExternalAgentValidationSloProcedure,
	getWidgetLifecycleHealth: getWidgetLifecycleHealthProcedure,
	getEmbeddedProviderActivity: getEmbeddedProviderActivityProcedure,
	trackEmbeddedWidgetLifecycle: trackEmbeddedWidgetLifecycleProcedure,
	trackWidgetLifecycle: trackWidgetLifecycleProcedure,
	trackWidgetEvents: trackWidgetEventsProcedure,
	trackEmbeddedAttentionOutcome: trackEmbeddedAttentionOutcomeProcedure,
	correlateEmbeddedAttentionFollowUps:
		correlateEmbeddedAttentionFollowUpsProcedure,
});

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Resolve the organization that owns `appId` and enforce the org-from-context
 * invariant: a non-platform caller may only read analytics for apps in their
 * own org. Platform principals (platform:admin / platform:admin) may read cross-org.
 * Mirrors `requireAppForOrg` in apps.ts.
 */
async function resolveAppOrgScoped(
	context: BaseContext,
	appId: string,
): Promise<string> {
	const organizationId = await getOrganizationIdForApp(context.db, appId);
	if (!organizationId) {
		throw createError(
			ErrorCodes.NOT_FOUND,
			"App not found or missing organization",
		);
	}
	if (
		!isPlatformPrincipal(context) &&
		organizationId !== context.organizationId
	) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"You do not have access to this app",
		);
	}
	return organizationId;
}

/**
 * The org to scope analytics reads to: undefined for platform principals
 * (full cross-org access), the caller's org otherwise.
 */
function analyticsOrgScope(context: BaseContext): string | undefined {
	if (isPlatformPrincipal(context)) return undefined;
	const orgId = context.organizationId;
	if (!orgId) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Organization context required. Use an org-scoped token.",
		);
	}
	return orgId;
}

type HydrationMaps = {
	apps: Map<string, AppDescriptor>;
	namespaceTedis: Map<string, PrincipalDescriptor>;
	tools: Map<string, ToolDescriptor>;
	principals: Map<string, PrincipalDescriptor>;
};

type AuditToolParts = {
	localToolName: string;
	namespace: string | null;
};

function keyForTool(
	appId: string | null | undefined,
	toolName: string,
): string {
	return `${appId ?? ""}:${toolName}`;
}

function uniqueValues(values: string[]): string[] {
	return Array.from(new Set(values.filter(Boolean)));
}

function parseAuditToolName(toolName: string): AuditToolParts {
	if (toolName.startsWith("tedi:")) {
		const [, namespace, ...rest] = toolName.split(":");
		const localToolName = rest.join(":");
		if (namespace && localToolName) {
			return { localToolName, namespace };
		}
	}
	const separatorIndex = toolName.indexOf("__");
	if (separatorIndex < 0) return { localToolName: toolName, namespace: null };
	return {
		localToolName: toolName.slice(separatorIndex + 2),
		namespace: toolName.slice(0, separatorIndex),
	};
}

const AGGREGATE_TEDI_COMPUTER_TOOL_LABELS: Record<string, string> = {
	open_computer: "Open Computer",
	close_computer: "Close Computer",
	exec: "Computer Command",
	read_execution: "Read Execution",
	cancel_execution: "Cancel Execution",
	read: "Read File",
	write: "Write File",
	edit: "Edit File",
	delete: "Delete File",
	ls: "List Files",
	find: "Find Files",
	grep: "Search Files",
};
const AGGREGATE_TEDI_COMPUTER_TOOL_NAMES = new Set(
	Object.keys(AGGREGATE_TEDI_COMPUTER_TOOL_LABELS),
);

export function toolIdCandidatesForAuditResource(toolName: string): string[] {
	const { localToolName } = parseAuditToolName(toolName);
	return uniqueValues([
		toolName,
		localToolName,
		localToolName.replaceAll("-", "_"),
		localToolName.replaceAll("_", "-"),
	]);
}

export function namespaceSlugCandidatesForAuditResource(
	toolName: string,
): string[] {
	const { namespace } = parseAuditToolName(toolName);
	if (!namespace) return [];
	return uniqueValues([namespace, namespace.replaceAll("_", "-")]);
}

function virtualResolvedTool(
	toolName: string,
	app: AppDescriptor | null,
): ToolDescriptor | null {
	if (
		toolName !== "code" &&
		toolName !== "execute_muscle_code" &&
		toolName !== "get_info"
	) {
		return null;
	}
	const fallback = unresolvedTool(toolName, app);
	if (!fallback) return null;
	return {
		...fallback,
		title: fallback.label,
		unresolved: false,
	};
}

function normalizedNamespaceToken(
	value: string | null | undefined,
): string | null {
	return value?.replaceAll("-", "_").toLowerCase() ?? null;
}

function tediScopedVirtualTool(
	toolName: string,
	app: AppDescriptor | null,
	principals: Array<PrincipalDescriptor | null>,
	namespaceTedis: Map<string, PrincipalDescriptor> = new Map(),
): ToolDescriptor | null {
	const { localToolName, namespace } = parseAuditToolName(toolName);
	const normalizedNamespace = normalizedNamespaceToken(namespace);
	if (!normalizedNamespace) return null;
	const principalOwner = principals.find(
		(principal) =>
			principal?.type === "tedi" &&
			!principal.unresolved &&
			normalizedNamespaceToken(principal.slug) === normalizedNamespace,
	);
	if (
		!principalOwner &&
		!AGGREGATE_TEDI_COMPUTER_TOOL_NAMES.has(localToolName)
	) {
		return null;
	}
	const owner = principalOwner ?? namespaceTedis.get(normalizedNamespace);
	if (!owner) return null;
	const label = AGGREGATE_TEDI_COMPUTER_TOOL_NAMES.has(localToolName)
		? `${owner.label} / ${
				AGGREGATE_TEDI_COMPUTER_TOOL_LABELS[localToolName] ??
				humanizeIdentifier(localToolName)
			}`
		: humanizeIdentifier(localToolName);
	return {
		id: toolName,
		label,
		toolName,
		title: label,
		appId: app?.id ?? null,
		appLabel: owner.label,
		appSlug: owner.slug,
		unresolved: false,
	};
}

function principalKey(
	type: string | null | undefined,
	id: string | null | undefined,
): string {
	return `${normalizePrincipalType(type)}:${id ?? ""}`;
}

function normalizePrincipalType(type: string | null | undefined) {
	if (type === "api_key") return "apiKey";
	if (
		type === "user" ||
		type === "tedi" ||
		type === "kernel" ||
		type === "m2m" ||
		type === "service" ||
		type === "apiKey" ||
		type === "external_agent" ||
		type === "anonymous"
	) {
		return type;
	}
	return "unknown";
}

const OPAQUE_PRINCIPAL_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function shortEvidenceId(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length <= 18) return trimmed;
	return `${trimmed.slice(0, 8)}...${trimmed.slice(-4)}`;
}

function readableMachineId(id: string): string | null {
	const trimmed = id.trim();
	if (!trimmed || trimmed === "unknown") return null;
	if (OPAQUE_PRINCIPAL_ID.test(trimmed) || trimmed.length > 32) return null;
	return humanizeIdentifier(trimmed)
		.replace(/\bApi\b/g, "API")
		.replace(/\bJwt\b/g, "JWT")
		.replace(/\bMcp\b/g, "MCP")
		.replace(/\bOauth\b/g, "OAuth")
		.replace(/\bR2\b/g, "R2")
		.replace(/\bD1\b/g, "D1");
}

function machinePrincipalDescriptor(
	id: string,
	type: Extract<
		PrincipalDescriptor["type"],
		"service" | "m2m" | "apiKey" | "anonymous"
	>,
): PrincipalDescriptor {
	const typeLabel: Record<"anonymous" | "apiKey" | "m2m" | "service", string> =
		{
			anonymous: "Anonymous caller",
			apiKey: "API key",
			m2m: "M2M client",
			service: "Service",
		};
	const readable =
		type === "service" || type === "m2m" ? readableMachineId(id) : null;
	return {
		id,
		type,
		label: readable ?? typeLabel[type],
		secondary:
			type === "anonymous"
				? null
				: `${typeLabel[type]} · ${shortEvidenceId(id)}`,
		slug: null,
		avatarUrl: null,
		unresolved: false,
	};
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
	return Array.from(new Set(values.filter((v): v is string => !!v)));
}

async function loadHydrationMaps(
	context: BaseContext,
	rows: AuditActivityRow[],
	organizationId: string | undefined,
): Promise<HydrationMaps> {
	const appIds = uniqueStrings(rows.map((r) => r.appId));
	const toolNames = uniqueStrings(rows.map((r) => r.resourceId));
	const toolIdCandidates = uniqueStrings(
		toolNames.flatMap(toolIdCandidatesForAuditResource),
	);
	const namespaceSlugCandidates = uniqueStrings(
		toolNames.flatMap(namespaceSlugCandidatesForAuditResource),
	);
	const userIds = uniqueStrings(
		rows.flatMap((r) => [
			normalizePrincipalType(r.actorType) === "user" ||
			normalizePrincipalType(r.actorType) === "kernel"
				? r.actorId
				: null,
			r.subjectUserId,
		]),
	);
	const tediIds = uniqueStrings(
		rows.flatMap((r) => [
			normalizePrincipalType(r.actorType) === "tedi" ? r.actorId : null,
			r.agentTediId,
		]),
	);
	const externalAgentIds = uniqueStrings(
		rows.map((row) =>
			normalizePrincipalType(row.actorType) === "external_agent"
				? row.actorId
				: null,
		),
	);
	const allPrincipalIds = uniqueStrings([...userIds, ...tediIds]);

	const apps = new Map<string, AppDescriptor>();
	if (appIds.length > 0) {
		const appRows = await listAnalyticsAppsByIds(context.db, appIds);
		for (const app of appRows) {
			apps.set(app.id, {
				id: app.id,
				label: app.name || app.slug || app.id,
				slug: app.slug ?? null,
				unresolved: false,
			});
		}
	}

	const namespaceApps = new Map<string, AppDescriptor>();
	const namespaceLookupAppIds = new Map<string, string[]>();
	if (namespaceSlugCandidates.length > 0) {
		const namespaceAppRows = await listAnalyticsAppsBySlugs(
			context.db,
			namespaceSlugCandidates,
		);
		const sourceAppIds = uniqueStrings(
			namespaceAppRows.map((app) => app.sourceAppId),
		);
		const sourceApps =
			sourceAppIds.length > 0
				? await listAnalyticsAppsByIds(context.db, sourceAppIds)
				: [];
		for (const app of sourceApps) {
			apps.set(app.id, {
				id: app.id,
				label: app.name || app.slug || app.id,
				slug: app.slug ?? null,
				unresolved: false,
			});
		}
		for (const app of namespaceAppRows) {
			const descriptor: AppDescriptor = {
				id: app.id,
				label: app.name || app.slug || app.id,
				slug: app.slug ?? null,
				unresolved: false,
			};
			apps.set(app.id, descriptor);
			if (app.slug) {
				namespaceApps.set(app.slug, descriptor);
				namespaceApps.set(app.slug.replaceAll("-", "_"), descriptor);
				const lookupIds = uniqueStrings([app.id, app.sourceAppId]);
				namespaceLookupAppIds.set(app.slug, lookupIds);
				namespaceLookupAppIds.set(app.slug.replaceAll("-", "_"), lookupIds);
			}
		}
	}

	const tools = new Map<string, ToolDescriptor>();
	const lookupAppIds = uniqueStrings([
		...appIds,
		...Array.from(namespaceApps.values(), (app) => app.id),
		...Array.from(namespaceLookupAppIds.values()).flat(),
	]);
	if (lookupAppIds.length > 0 && toolIdCandidates.length > 0) {
		const toolRows = await listAnalyticsTools(context.db, {
			appIds: lookupAppIds,
			toolIds: toolIdCandidates,
		});
		for (const tool of toolRows) {
			const app = apps.get(tool.appId) ?? unresolvedApp(tool.appId);
			tools.set(keyForTool(tool.appId, tool.toolId), {
				id: tool.toolId,
				label: tool.title || tool.toolId,
				toolName: tool.toolId,
				title: tool.title ?? null,
				appId: tool.appId,
				appLabel: app?.label ?? null,
				appSlug: app?.slug ?? null,
				unresolved: false,
			});
		}
	}
	for (const row of rows) {
		if (!row.resourceId) continue;
		const servedKey = keyForTool(row.appId, row.resourceId);
		if (tools.has(servedKey)) continue;
		const servedApp = row.appId
			? (apps.get(row.appId) ?? unresolvedApp(row.appId))
			: null;
		const virtual = virtualResolvedTool(row.resourceId, servedApp);
		if (virtual) {
			tools.set(servedKey, virtual);
			continue;
		}
		for (const namespaceSlug of namespaceSlugCandidatesForAuditResource(
			row.resourceId,
		)) {
			const lookupIds = namespaceLookupAppIds.get(namespaceSlug) ?? [];
			for (const lookupAppId of lookupIds) {
				for (const candidate of toolIdCandidatesForAuditResource(
					row.resourceId,
				)) {
					const sourceTool = tools.get(keyForTool(lookupAppId, candidate));
					if (!sourceTool) continue;
					tools.set(servedKey, {
						...sourceTool,
						id: row.resourceId,
						toolName: row.resourceId,
					});
					break;
				}
				if (tools.has(servedKey)) break;
			}
			if (tools.has(servedKey)) break;
		}
	}

	const principals = new Map<string, PrincipalDescriptor>();
	const namespaceTedis = new Map<string, PrincipalDescriptor>();
	if (externalAgentIds.length > 0) {
		const externalAgents = await listExternalAgentPrincipalsByIds(context.db, {
			principalIds: externalAgentIds,
			organizationId,
		});
		for (const principal of externalAgents) {
			if (!externalAgentIds.includes(principal.id)) continue;
			principals.set(principalKey("external_agent", principal.id), {
				id: principal.id,
				type: "external_agent",
				label: principal.displayName || principal.key || principal.id,
				secondary: principal.key ?? null,
				slug: principal.key ?? null,
				avatarUrl: null,
				unresolved: false,
			});
		}
	}
	if (userIds.length > 0) {
		const memberRows = await listAnalyticsOrganizationMembers(context.db, {
			userIds,
			organizationId,
		});
		for (const member of memberRows) {
			const label = member.name || member.email || member.descopeUserId;
			principals.set(principalKey("user", member.descopeUserId), {
				id: member.descopeUserId,
				type: "user",
				label,
				secondary: member.email ?? member.role ?? null,
				slug: null,
				avatarUrl: member.avatarUrl ?? null,
				unresolved: false,
			});
			principals.set(principalKey("kernel", member.descopeUserId), {
				id: member.descopeUserId,
				type: "kernel",
				label: "Home Kernel",
				secondary: `acting for ${label}`,
				slug: null,
				avatarUrl: member.avatarUrl ?? null,
				unresolved: false,
			});
		}

		const userRows = await listAnalyticsUsers(context.db, userIds);
		for (const user of userRows) {
			if (!principals.has(principalKey("user", user.id))) {
				const label = user.name || user.email || user.id;
				principals.set(principalKey("user", user.id), {
					id: user.id,
					type: "user",
					label,
					secondary: user.email ?? null,
					slug: null,
					avatarUrl: user.avatarUrl ?? null,
					unresolved: false,
				});
			}
			if (!principals.has(principalKey("kernel", user.id))) {
				const label = user.name || user.email || user.id;
				principals.set(principalKey("kernel", user.id), {
					id: user.id,
					type: "kernel",
					label: "Home Kernel",
					secondary: `acting for ${label}`,
					slug: null,
					avatarUrl: user.avatarUrl ?? null,
					unresolved: false,
				});
			}
		}
	}

	if (allPrincipalIds.length > 0 || namespaceSlugCandidates.length > 0) {
		const tediRows = await listAnalyticsTedis(context.db, {
			principalIds: allPrincipalIds,
			tediIds,
			slugs: namespaceSlugCandidates,
			organizationId,
		});
		for (const tedi of tediRows) {
			const label = tedi.displayName || tedi.name || tedi.slug || tedi.id;
			const descriptor: PrincipalDescriptor = {
				id: tedi.id,
				type: "tedi",
				label,
				secondary: tedi.slug ?? tedi.descopeUserId ?? null,
				slug: tedi.slug ?? null,
				avatarUrl: tedi.avatar ?? null,
				unresolved: false,
			};
			principals.set(principalKey("tedi", tedi.id), descriptor);
			const normalizedSlug = normalizedNamespaceToken(tedi.slug);
			if (normalizedSlug) namespaceTedis.set(normalizedSlug, descriptor);
			if (tedi.descopeUserId) {
				const descopeDescriptor: PrincipalDescriptor = {
					...descriptor,
					id: tedi.descopeUserId,
				};
				principals.set(
					principalKey("tedi", tedi.descopeUserId),
					descopeDescriptor,
				);
				if (!principals.has(principalKey("user", tedi.descopeUserId))) {
					principals.set(
						principalKey("user", tedi.descopeUserId),
						descopeDescriptor,
					);
				}
			}
		}
	}

	return { apps, namespaceTedis, tools, principals };
}

function describePrincipal(
	id: string | null | undefined,
	type: string | null | undefined,
	maps: HydrationMaps,
): PrincipalDescriptor {
	const normalizedType = normalizePrincipalType(type);
	if (!id) return unresolvedPrincipal(id, normalizedType);
	const hydrated = maps.principals.get(principalKey(normalizedType, id));
	if (hydrated) return hydrated;
	if (
		normalizedType === "service" ||
		normalizedType === "m2m" ||
		normalizedType === "apiKey" ||
		normalizedType === "anonymous"
	) {
		return machinePrincipalDescriptor(id, normalizedType);
	}
	return unresolvedPrincipal(id, normalizedType);
}

function hydrateActivityItem(
	item: ActivityItem,
	row: AuditActivityRow,
	maps: HydrationMaps,
): ActivityItem {
	const actor = describePrincipal(row.actorId, row.actorType, maps);
	let subject = row.subjectUserId
		? describePrincipal(row.subjectUserId, "user", maps)
		: null;
	const agent = row.agentTediId
		? describePrincipal(row.agentTediId, "tedi", maps)
		: null;
	const tediAgentSubject =
		actor.type === "tedi" &&
		!actor.unresolved &&
		agent?.type === "tedi" &&
		!agent.unresolved &&
		actor.id === agent.id &&
		(row.delegationMode === "agent" || row.actorType === "tedi");
	if (tediAgentSubject && (!subject || subject.unresolved)) {
		subject = agent;
	}
	const app = row.appId
		? (maps.apps.get(row.appId) ?? unresolvedApp(row.appId))
		: null;
	let tool = row.resourceId
		? (maps.tools.get(keyForTool(row.appId, row.resourceId)) ??
			unresolvedTool(row.resourceId, app))
		: null;
	const clientId = row.clientId ?? row.oauthClientId ?? item.clientId;
	const delegationMode = row.delegationMode ?? item.delegationMode;
	if (row.resourceId && (!tool || tool.unresolved)) {
		tool =
			tediScopedVirtualTool(
				row.resourceId,
				app,
				[agent, actor],
				maps.namespaceTedis,
			) ?? tool;
	}
	const attribution = buildDelegationChain({
		mode: delegationMode,
		actor,
		subject,
		agent,
		clientId,
	});
	const identityCoverage = buildIdentityCoverage({
		actor,
		subject,
		agent,
		app,
		tool,
		clientId,
		subjectPresent: !!row.subjectUserId || tediAgentSubject,
		agentPresent: !!row.agentTediId,
	});
	return {
		...item,
		actor,
		subject,
		agent,
		app,
		tool,
		clientId,
		delegationMode,
		attribution,
		identityCoverage,
	};
}

async function hydrateActivityRows(
	context: BaseContext,
	rows: AuditActivityRow[],
	organizationId: string | undefined,
): Promise<ActivityItem[]> {
	const items = mapAuditActivityRows(rows);
	if (rows.length === 0) return items;
	const maps = await loadHydrationMaps(context, rows, organizationId);
	return items.map((item, index) =>
		hydrateActivityItem(item, rows[index]!, maps),
	);
}

function mergeCoverage(items: ActivityItem[]): IdentityCoverage {
	const warnings = Array.from(
		new Set(items.flatMap((item) => item.identityCoverage.warnings)),
	);
	return {
		actorResolved: items.every((item) => item.identityCoverage.actorResolved),
		subjectPresent: items.some((item) => item.identityCoverage.subjectPresent),
		subjectResolved: items
			.filter((item) => item.identityCoverage.subjectPresent)
			.every((item) => item.identityCoverage.subjectResolved),
		agentPresent: items.some((item) => item.identityCoverage.agentPresent),
		agentResolved: items
			.filter((item) => item.identityCoverage.agentPresent)
			.every((item) => item.identityCoverage.agentResolved),
		appResolved: items.every((item) => item.identityCoverage.appResolved),
		toolResolved: items.every((item) => item.identityCoverage.toolResolved),
		clientPresent: items.some((item) => item.identityCoverage.clientPresent),
		warnings,
		warningDetails: Array.from(
			new Map(
				items
					.flatMap((item) => item.identityCoverage.warningDetails)
					.map((detail) => [detail.code, detail]),
			).values(),
		),
	};
}

function reviewGroupKey(item: ActivityItem): string {
	if (item.traceId) return `trace:${item.traceId}`;
	if (item.executionId) return `execution:${item.executionId}`;
	const ts = Date.parse(item.timestamp);
	const bucket = Number.isFinite(ts) ? Math.floor(ts / 300_000) : 0;
	return `actor:${item.actorId}:${bucket}`;
}

function buildToolSummaries(items: ActivityItem[]) {
	const byTool = new Map<
		string,
		{ tool: ToolDescriptor; count: number; errors: number }
	>();
	for (const item of items) {
		if (!item.tool) continue;
		const existing = byTool.get(item.tool.toolName) ?? {
			tool: item.tool,
			count: 0,
			errors: 0,
		};
		existing.count += 1;
		if (!item.success) existing.errors += 1;
		byTool.set(item.tool.toolName, existing);
	}
	return Array.from(byTool.values())
		.sort((a, b) => b.count - a.count || b.errors - a.errors)
		.slice(0, 6);
}

function buildSecurityPosture(
	items: ActivityItem[],
): ActivityReviewGroup["securityPosture"] {
	const deniedEvents = items.filter(
		(item) => item.securityDecision.disposition === "denied",
	).length;
	const executedEvents = items.length - deniedEvents;
	return {
		disposition:
			deniedEvents === 0
				? "executed"
				: executedEvents === 0
					? "denied"
					: "mixed",
		executedEvents,
		deniedEvents,
		denialReasons: [
			...new Set(
				items.flatMap((item) =>
					item.securityDecision.denialReason
						? [item.securityDecision.denialReason]
						: [],
				),
			),
		].sort(),
		mcpMethods: [
			...new Set(
				items.flatMap((item) =>
					item.securityDecision.mcpMethod
						? [item.securityDecision.mcpMethod]
						: [],
				),
			),
		].sort(),
		riskTiers: [
			...new Set(
				items.flatMap((item) =>
					item.securityDecision.riskTier
						? [item.securityDecision.riskTier]
						: [],
				),
			),
		].sort(),
		unknownRiskEvents: items.filter(
			(item) => item.securityDecision.riskTier === null,
		).length,
	};
}

const cognitiveTraceEventKinds = new Set([
	"memory.observed",
	"memory.bridged",
	"memory.retrieved",
	"decision.recorded",
	"decision.completed",
	"skill.used",
	"skill.crystallized",
	"task.detected",
	"task.synced",
	"approval.requested",
	"approval.resolved",
	"context.injected",
	"context.compacted",
]);

const ACTIVITY_REVIEW_TRACE_PROOF_TARGET = 0.8;
const ACTIVITY_REVIEW_TRACE_FRESHNESS_TARGET = 0.9;
const ACTIVITY_REVIEW_TRACE_FRESHNESS_MAX_LAG_MS = 5 * 60 * 1000;

const emptyCloudflareTraceEvidence =
	(): TraceEvidenceSummary["cloudflare"] => ({
		sampled: false,
		traceId: null,
		spanCount: 0,
		serviceNames: [],
		durationMs: null,
		errorCount: 0,
		traceStartAt: null,
		traceEndAt: null,
	});

export interface RuntimeTraceEvidenceRow {
	traceId: string | null;
	kind: string;
	createdAt?: Date | number | string | null;
	runtimeBackend: string;
	payload: unknown;
}

export interface DurableRationaleEvidenceRow {
	id: string;
	category: string | null;
	outcomeStatus: string | null;
	confidence: number | null;
	evidence: unknown;
	createdAt: string | null;
	completedAt: string | null;
}

function traceEvidenceFallback(traceId: string | null): TraceEvidenceSummary {
	return {
		status: traceId ? "audit_only" : "missing_trace",
		mcpEvents: 0,
		runtimeEvents: 0,
		cognitiveEvents: 0,
		retrievalEvents: 0,
		decisionEvents: 0,
		retrievedFactCount: 0,
		citedFactCount: 0,
		ignoredFactCount: 0,
		runtimeBackends: [],
		hasRetrievalDecisionJoin: false,
		latestRuntimeAt: null,
		latestCognitiveAt: null,
		latestRetrievalAt: null,
		latestDecisionAt: null,
		cloudflare: emptyCloudflareTraceEvidence(),
		cognition: emptyCognitionEvidence(),
		warnings: traceId ? ["runtime_trace_missing"] : ["trace_missing"],
	};
}

export function markMcpTraceEvidence(
	traceEvidence: TraceEvidenceSummary,
	mcpEvents: number,
): TraceEvidenceSummary {
	if (
		mcpEvents <= 0 ||
		traceEvidence.status !== "audit_only" ||
		traceEvidence.runtimeEvents > 0
	) {
		return traceEvidence;
	}

	return {
		...traceEvidence,
		status: "mcp_linked",
		mcpEvents,
		warnings: traceEvidence.warnings.filter(
			(warning) => warning !== "runtime_trace_missing",
		),
	};
}

function asObject(value: unknown): Record<string, unknown> {
	if (!value) return {};
	if (typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	if (typeof value !== "string" || value.trim().length === 0) return {};
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function addStringValues(target: Set<string>, value: unknown): void {
	if (Array.isArray(value)) {
		for (const item of value) addStringValues(target, item);
		return;
	}
	if (typeof value === "string" && value.trim()) target.add(value.trim());
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
	return Object.hasOwn(obj, key);
}

function numberOrNull(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const numeric = Number(value);
		return Number.isFinite(numeric) ? numeric : null;
	}
	return null;
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sortedValues(values: Set<string>): string[] {
	return Array.from(values).sort();
}

function emptyCognitionEvidence(): CognitionEvidenceBundle {
	return {
		summary: "No cognitive evidence linked.",
		retrievedFactIds: [],
		citedFactIds: [],
		ignoredFactIds: [],
		decisionIds: [],
		latestDecision: null,
		retrieval: {
			topK: null,
			returnedCount: null,
			vectorEnabled: null,
			vectorMs: null,
			hydrateFactsMs: null,
		},
		graph: {
			status: "not_applicable",
			projectedDecisionIds: [],
			warnings: [],
		},
		warnings: [],
	};
}

function timestampMs(
	value: Date | number | string | null | undefined,
): number | null {
	if (value == null) return null;
	if (value instanceof Date) return value.getTime();
	if (typeof value === "number") {
		return new Date(value < 10_000_000_000 ? value * 1000 : value).getTime();
	}
	const numeric = Number(value);
	if (Number.isFinite(numeric)) {
		return new Date(
			numeric < 10_000_000_000 ? numeric * 1000 : numeric,
		).getTime();
	}
	const parsed = new Date(value).getTime();
	return Number.isFinite(parsed) ? parsed : null;
}

function latestIso(current: string | null, candidate: unknown): string | null {
	const candidateMs = timestampMs(
		candidate as Date | number | string | null | undefined,
	);
	if (candidateMs == null) return current;
	const currentMs = timestampMs(current);
	if (currentMs != null && currentMs >= candidateMs) return current;
	return new Date(candidateMs).toISOString();
}

function buildCognitionSummary(input: {
	retrievedFactCount: number;
	citedFactCount: number;
	ignoredFactCount: number;
	decisionCount: number;
	latestDecision: CognitionEvidenceBundle["latestDecision"];
	graph: CognitionEvidenceBundle["graph"];
}): string {
	const parts: string[] = [];
	if (input.retrievedFactCount > 0) {
		parts.push(`${input.retrievedFactCount} fact(s) retrieved`);
	}
	if (input.citedFactCount > 0 || input.ignoredFactCount > 0) {
		parts.push(
			`${input.citedFactCount} cited / ${input.ignoredFactCount} ignored`,
		);
	}
	if (input.decisionCount > 0) {
		const outcome = input.latestDecision?.outcomeStatus
			? `, ${input.latestDecision.outcomeStatus}`
			: "";
		parts.push(`${input.decisionCount} decision event(s)${outcome}`);
	}

	if (input.graph.status === "not_observed") {
		parts.push("graph projection not observed");
	}
	return parts.length > 0 ? parts.join("; ") : "No cognitive evidence linked.";
}

export function buildTraceEvidenceSummary(
	traceId: string | null,
	rows: RuntimeTraceEvidenceRow[],
): TraceEvidenceSummary {
	if (!traceId) return traceEvidenceFallback(null);
	if (rows.length === 0) return traceEvidenceFallback(traceId);

	const runtimeBackends = new Set<string>();
	const retrievedFactIds = new Set<string>();
	const citedFactIds = new Set<string>();
	const ignoredFactIds = new Set<string>();
	const decisionIds = new Set<string>();
	const projectedDecisionIds = new Set<string>();
	let cognitiveEvents = 0;
	let retrievalEvents = 0;
	let decisionEvents = 0;
	let sawDecisionFactPayload = false;
	let latestDecision: CognitionEvidenceBundle["latestDecision"] = null;
	let latestDecisionMs: number | null = null;
	let topK: number | null = null;
	let returnedCount: number | null = null;
	let vectorEnabled: boolean | null = null;
	let vectorMs: number | null = null;
	let hydrateFactsMs: number | null = null;
	let latestRuntimeAt: string | null = null;
	let latestCognitiveAt: string | null = null;
	let latestRetrievalAt: string | null = null;
	let latestDecisionAt: string | null = null;

	for (const row of rows) {
		runtimeBackends.add(row.runtimeBackend);
		latestRuntimeAt = latestIso(latestRuntimeAt, row.createdAt);
		if (cognitiveTraceEventKinds.has(row.kind)) {
			cognitiveEvents += 1;
			latestCognitiveAt = latestIso(latestCognitiveAt, row.createdAt);
		}
		const payload = asObject(row.payload);
		if (row.kind === "memory.retrieved") {
			retrievalEvents += 1;
			latestRetrievalAt = latestIso(latestRetrievalAt, row.createdAt);
			addStringValues(retrievedFactIds, payload.factIds);
			addStringValues(retrievedFactIds, payload.retrievedFactIds);
			topK = numberOrNull(payload.topK) ?? topK;
			returnedCount =
				numberOrNull(payload.returnedCount) ??
				numberOrNull(payload.returnedFactCount) ??
				returnedCount;
			vectorEnabled =
				typeof payload.vectorEnabled === "boolean"
					? payload.vectorEnabled
					: vectorEnabled;
			vectorMs = numberOrNull(payload.vectorMs) ?? vectorMs;
			hydrateFactsMs = numberOrNull(payload.hydrateFactsMs) ?? hydrateFactsMs;
		}
		if (row.kind === "decision.recorded" || row.kind === "decision.completed") {
			decisionEvents += 1;
			latestDecisionAt = latestIso(latestDecisionAt, row.createdAt);
			const rationaleRecordId = stringOrNull(payload.rationaleRecordId);
			if (rationaleRecordId) decisionIds.add(rationaleRecordId);
			if (
				hasOwn(payload, "citedFactIds") ||
				hasOwn(payload, "usedFactIds") ||
				hasOwn(payload, "ignoredFactIds")
			) {
				sawDecisionFactPayload = true;
			}
			addStringValues(citedFactIds, payload.citedFactIds);
			addStringValues(citedFactIds, payload.usedFactIds);
			addStringValues(ignoredFactIds, payload.ignoredFactIds);
			const rowMs = timestampMs(row.createdAt);
			if (
				rowMs != null &&
				(latestDecisionMs == null || rowMs >= latestDecisionMs)
			) {
				latestDecisionMs = rowMs;
				latestDecision = rationaleRecordId
					? {
							id: rationaleRecordId,
							category: stringOrNull(payload.category),
							outcomeStatus: stringOrNull(payload.outcomeStatus),
							confidence: numberOrNull(payload.confidence),
							createdAt: latestIso(null, row.createdAt),
							completedAt:
								row.kind === "decision.completed"
									? latestIso(null, row.createdAt)
									: null,
							source: "runtime",
						}
					: latestDecision;
			}
		}
		if (row.kind.startsWith("graph.")) {
			addStringValues(projectedDecisionIds, payload.decisionIds);
			addStringValues(projectedDecisionIds, payload.projectedDecisionIds);
		}
	}

	if (sawDecisionFactPayload && retrievedFactIds.size > 0) {
		for (const factId of retrievedFactIds) {
			if (!citedFactIds.has(factId)) ignoredFactIds.add(factId);
		}
	}

	const hasRetrievalDecisionJoin =
		retrievalEvents > 0 &&
		decisionEvents > 0 &&
		(citedFactIds.size > 0 || ignoredFactIds.size > 0);
	const cognitionWarnings: string[] = [];
	const graph: CognitionEvidenceBundle["graph"] =
		decisionIds.size === 0
			? { status: "not_applicable", projectedDecisionIds: [], warnings: [] }
			: projectedDecisionIds.size > 0
				? {
						status: "observed",
						projectedDecisionIds: sortedValues(projectedDecisionIds),
						warnings: [],
					}
				: {
						status: "not_observed",
						projectedDecisionIds: [],
						warnings: ["graph_projection_not_observed"],
					};

	const cognition: CognitionEvidenceBundle = {
		summary: buildCognitionSummary({
			retrievedFactCount: retrievedFactIds.size,
			citedFactCount: citedFactIds.size,
			ignoredFactCount: ignoredFactIds.size,
			decisionCount: decisionEvents,
			latestDecision,
			graph,
		}),
		retrievedFactIds: sortedValues(retrievedFactIds),
		citedFactIds: sortedValues(citedFactIds),
		ignoredFactIds: sortedValues(ignoredFactIds),
		decisionIds: sortedValues(decisionIds),
		latestDecision,
		retrieval: {
			topK,
			returnedCount,
			vectorEnabled,
			vectorMs,
			hydrateFactsMs,
		},
		graph,
		warnings: [...cognitionWarnings, ...graph.warnings],
	};
	const warnings: string[] = [];
	if (cognitiveEvents === 0) warnings.push("cognitive_trace_missing");
	if (retrievalEvents > 0 && decisionEvents === 0) {
		warnings.push("retrieval_without_decision");
	}
	if (decisionEvents > 0 && retrievalEvents === 0) {
		warnings.push("decision_without_retrieval");
	}
	if (retrievalEvents > 0 && decisionEvents > 0 && !hasRetrievalDecisionJoin) {
		warnings.push("retrieval_decision_fact_join_missing");
	}

	const status: TraceEvidenceSummary["status"] = hasRetrievalDecisionJoin
		? "retrieval_decision_linked"
		: cognitiveEvents > 0
			? "cognitive_linked"
			: "runtime_linked";

	return {
		status,
		mcpEvents: 0,
		runtimeEvents: rows.length,
		cognitiveEvents,
		retrievalEvents,
		decisionEvents,
		retrievedFactCount: retrievedFactIds.size,
		citedFactCount: citedFactIds.size,
		ignoredFactCount: ignoredFactIds.size,
		runtimeBackends: Array.from(runtimeBackends).sort(),
		hasRetrievalDecisionJoin,
		latestRuntimeAt,
		latestCognitiveAt,
		latestRetrievalAt,
		latestDecisionAt,
		cloudflare: emptyCloudflareTraceEvidence(),
		cognition,
		warnings,
	};
}

function recomputeTraceEvidenceStatus(
	summary: TraceEvidenceSummary,
	citedFactCount: number,
	ignoredFactCount: number,
): TraceEvidenceSummary["status"] {
	const hasRetrievalDecisionJoin =
		summary.retrievalEvents > 0 &&
		summary.decisionEvents > 0 &&
		(citedFactCount > 0 || ignoredFactCount > 0);
	if (hasRetrievalDecisionJoin) return "retrieval_decision_linked";
	if (summary.cognitiveEvents > 0) return "cognitive_linked";
	if (summary.runtimeEvents > 0) return "runtime_linked";
	return summary.status;
}

function removeWarnings(warnings: string[], remove: Set<string>): string[] {
	return warnings.filter((warning) => !remove.has(warning));
}

function latestRationaleRecord(
	records: DurableRationaleEvidenceRow[],
): DurableRationaleEvidenceRow | null {
	let latest: DurableRationaleEvidenceRow | null = null;
	let latestMs: number | null = null;
	for (const record of records) {
		const ms = timestampMs(record.completedAt ?? record.createdAt);
		if (ms == null) continue;
		if (latestMs == null || ms >= latestMs) {
			latest = record;
			latestMs = ms;
		}
	}
	return latest;
}

export function applyDurableCognitionEvidence(
	summary: TraceEvidenceSummary,
	records: DurableRationaleEvidenceRow[],
): TraceEvidenceSummary {
	if (records.length === 0) return summary;

	const retrievedFactIds = new Set(summary.cognition.retrievedFactIds);
	const citedFactIds = new Set(summary.cognition.citedFactIds);
	const ignoredFactIds = new Set(summary.cognition.ignoredFactIds);
	const decisionIds = new Set(summary.cognition.decisionIds);

	for (const record of records) {
		decisionIds.add(record.id);
		for (const factId of extractFactIdsFromEvidence(record.evidence)) {
			citedFactIds.add(factId);
		}
	}

	if (retrievedFactIds.size > 0 && citedFactIds.size > 0) {
		for (const factId of retrievedFactIds) {
			if (!citedFactIds.has(factId)) ignoredFactIds.add(factId);
		}
	}

	const latestRecord = latestRationaleRecord(records);
	const latestDecision = latestRecord
		? {
				id: latestRecord.id,
				category: latestRecord.category,
				outcomeStatus: latestRecord.outcomeStatus,
				confidence: latestRecord.confidence,
				createdAt: latestRecord.createdAt,
				completedAt: latestRecord.completedAt,
				source: "rationale_record" as const,
			}
		: summary.cognition.latestDecision;
	const graph =
		summary.cognition.graph.status === "observed"
			? summary.cognition.graph
			: {
					status:
						decisionIds.size > 0
							? ("not_observed" as const)
							: ("not_applicable" as const),
					projectedDecisionIds: summary.cognition.graph.projectedDecisionIds,
					warnings:
						decisionIds.size > 0 ? ["graph_projection_not_observed"] : [],
				};
	const cognitionWarnings = removeWarnings(
		summary.cognition.warnings,
		new Set(["graph_projection_not_observed"]),
	);
	for (const warning of graph.warnings) cognitionWarnings.push(warning);
	const uniqueCognitionWarnings = Array.from(new Set(cognitionWarnings));
	const status = recomputeTraceEvidenceStatus(
		summary,
		citedFactIds.size,
		ignoredFactIds.size,
	);
	const warnings = removeWarnings(
		summary.warnings,
		new Set(["retrieval_decision_fact_join_missing"]),
	);
	if (
		summary.retrievalEvents > 0 &&
		summary.decisionEvents > 0 &&
		status !== "retrieval_decision_linked"
	) {
		warnings.push("retrieval_decision_fact_join_missing");
	}

	const cognition: CognitionEvidenceBundle = {
		...summary.cognition,
		summary: buildCognitionSummary({
			retrievedFactCount: retrievedFactIds.size,
			citedFactCount: citedFactIds.size,
			ignoredFactCount: ignoredFactIds.size,
			decisionCount: summary.decisionEvents,
			latestDecision,
			graph,
		}),
		retrievedFactIds: sortedValues(retrievedFactIds),
		citedFactIds: sortedValues(citedFactIds),
		ignoredFactIds: sortedValues(ignoredFactIds),
		decisionIds: sortedValues(decisionIds),
		latestDecision,
		graph,
		warnings: uniqueCognitionWarnings,
	};

	return {
		...summary,
		status,
		retrievedFactCount: retrievedFactIds.size,
		citedFactCount: citedFactIds.size,
		ignoredFactCount: ignoredFactIds.size,
		hasRetrievalDecisionJoin: status === "retrieval_decision_linked",
		cognition,
		warnings: Array.from(new Set(warnings)),
	};
}

export function applyCloudflareTraceEvidence(
	summary: TraceEvidenceSummary,
	evidence: CloudflareTraceEvidence | undefined,
): TraceEvidenceSummary {
	if (!evidence) return summary;
	return {
		...summary,
		cloudflare: {
			sampled: true,
			traceId: evidence.cloudflareTraceId,
			spanCount: evidence.spanCount,
			serviceNames: evidence.serviceNames,
			durationMs: evidence.durationMs,
			errorCount: evidence.errorCount,
			traceStartAt: evidence.traceStartAt,
			traceEndAt: evidence.traceEndAt,
		},
	};
}

async function loadTraceEvidenceSummaries(
	context: BaseContext,
	organizationId: string | undefined,
	traceIds: string[],
	fromMs: number,
	toMs: number,
): Promise<Map<string, TraceEvidenceSummary>> {
	const uniqueTraceIds = uniqueStrings(traceIds).slice(0, 100);
	if (!organizationId || uniqueTraceIds.length === 0) return new Map();
	const rows = await listAnalyticsRuntimeTraceEvidence(context.db, {
		organizationId,
		traceIds: uniqueTraceIds,
		limit: 2000,
	});
	const byTrace = new Map<string, RuntimeTraceEvidenceRow[]>();
	for (const row of rows) {
		if (!row.traceId) continue;
		byTrace.set(row.traceId, [...(byTrace.get(row.traceId) ?? []), row]);
	}
	const summaries = new Map<string, TraceEvidenceSummary>();
	for (const traceId of uniqueTraceIds) {
		summaries.set(
			traceId,
			buildTraceEvidenceSummary(traceId, byTrace.get(traceId) ?? []),
		);
	}
	const decisionIds = uniqueStrings(
		Array.from(summaries.values()).flatMap(
			(summary) => summary.cognition.decisionIds,
		),
	).slice(0, 200);
	if (decisionIds.length > 0) {
		const rationaleRows = await listAnalyticsRationaleEvidence(context.db, {
			organizationId,
			decisionIds,
		});
		const rationaleRowsById = new Map(
			rationaleRows.map((row) => [row.id, row as DurableRationaleEvidenceRow]),
		);
		for (const [traceId, summary] of summaries.entries()) {
			const durableRecords = summary.cognition.decisionIds
				.map((decisionId) => rationaleRowsById.get(decisionId))
				.filter((row): row is DurableRationaleEvidenceRow => !!row);
			if (durableRecords.length > 0) {
				summaries.set(
					traceId,
					applyDurableCognitionEvidence(summary, durableRecords),
				);
			}
		}
	}

	if (hasWorkersObservabilityConfig(context.env)) {
		try {
			const cloudflareEvidence = await queryWorkersTraceEvidence(context.env, {
				fromMs: fromMs - ACTIVITY_REVIEW_TRACE_FRESHNESS_MAX_LAG_MS,
				toMs: toMs + ACTIVITY_REVIEW_TRACE_FRESHNESS_MAX_LAG_MS,
				traceIds: uniqueTraceIds,
			});
			for (const [traceId, summary] of summaries.entries()) {
				summaries.set(
					traceId,
					applyCloudflareTraceEvidence(
						summary,
						cloudflareEvidence.get(traceId),
					),
				);
			}
		} catch (error) {
			console.error("[Analytics] Workers trace evidence join failed:", error);
		}
	}
	return summaries;
}

export function buildTraceEvidenceCoverage(
	groups: Pick<ActivityReviewGroup, "traceEvidence">[],
): TraceEvidenceCoverage {
	const totalGroups = groups.length;
	const auditOnlyGroups = groups.filter(
		(group) => group.traceEvidence.status === "audit_only",
	).length;
	const runtimeLinkedGroups = groups.filter(
		(group) => group.traceEvidence.status === "runtime_linked",
	).length;
	const mcpLinkedGroups = groups.filter(
		(group) => group.traceEvidence.status === "mcp_linked",
	).length;
	const cognitiveLinkedGroups = groups.filter(
		(group) => group.traceEvidence.status === "cognitive_linked",
	).length;
	const retrievalDecisionLinkedGroups = groups.filter(
		(group) => group.traceEvidence.status === "retrieval_decision_linked",
	).length;
	const missingTraceGroups = groups.filter(
		(group) => group.traceEvidence.status === "missing_trace",
	).length;
	const proofLinkedGroups =
		mcpLinkedGroups +
		runtimeLinkedGroups +
		cognitiveLinkedGroups +
		retrievalDecisionLinkedGroups;
	const proofCoverageRate =
		totalGroups > 0 ? proofLinkedGroups / totalGroups : 0;
	const warnings = Array.from(
		new Set(groups.flatMap((group) => group.traceEvidence.warnings)),
	);
	const status: TraceEvidenceCoverage["status"] =
		totalGroups === 0
			? "no_data"
			: proofCoverageRate >= ACTIVITY_REVIEW_TRACE_PROOF_TARGET
				? "met"
				: proofCoverageRate >= ACTIVITY_REVIEW_TRACE_PROOF_TARGET / 2
					? "warning"
					: "breach";

	return {
		status,
		targetCoverageRate: ACTIVITY_REVIEW_TRACE_PROOF_TARGET,
		proofCoverageRate,
		proofLinkedGroups,
		auditOnlyGroups,
		mcpLinkedGroups,
		runtimeLinkedGroups,
		cognitiveLinkedGroups,
		retrievalDecisionLinkedGroups,
		missingTraceGroups,
		warnings,
	};
}

function latestProofTimestamp(
	group: Pick<ActivityReviewGroup, "endedAt" | "traceEvidence">,
): string | null {
	switch (group.traceEvidence.status) {
		case "mcp_linked":
			return group.endedAt;
		case "runtime_linked":
			return group.traceEvidence.latestRuntimeAt;
		case "cognitive_linked":
			return (
				group.traceEvidence.latestCognitiveAt ??
				group.traceEvidence.latestRuntimeAt
			);
		case "retrieval_decision_linked":
			return (
				group.traceEvidence.latestDecisionAt ??
				group.traceEvidence.latestRetrievalAt ??
				group.traceEvidence.latestCognitiveAt ??
				group.traceEvidence.latestRuntimeAt
			);
		case "audit_only":
		case "missing_trace":
			return null;
	}
}

export function buildTraceFreshnessCoverage(
	groups: Pick<ActivityReviewGroup, "endedAt" | "traceEvidence">[],
): TraceFreshnessCoverage {
	const proofGroups = groups.filter(
		(group) =>
			group.traceEvidence.status !== "audit_only" &&
			group.traceEvidence.status !== "missing_trace",
	);
	let freshGroups = 0;
	let staleGroups = 0;
	let missingProofTimestampGroups = 0;
	let maxLagMs: number | null = null;
	let latestAuditAt: string | null = null;
	let latestProofAt: string | null = null;

	for (const group of proofGroups) {
		latestAuditAt = latestIso(latestAuditAt, group.endedAt);
		const proofAt = latestProofTimestamp(group);
		latestProofAt = latestIso(latestProofAt, proofAt);
		const auditMs = timestampMs(group.endedAt);
		const proofMs = timestampMs(proofAt);
		if (auditMs == null || proofMs == null) {
			missingProofTimestampGroups += 1;
			continue;
		}
		const lagMs = Math.abs(auditMs - proofMs);
		maxLagMs = maxLagMs == null ? lagMs : Math.max(maxLagMs, lagMs);
		if (lagMs <= ACTIVITY_REVIEW_TRACE_FRESHNESS_MAX_LAG_MS) {
			freshGroups += 1;
		} else {
			staleGroups += 1;
		}
	}

	const freshnessRate =
		proofGroups.length > 0 ? freshGroups / proofGroups.length : 0;
	const warnings = [
		...(staleGroups > 0 ? ["trace_proof_stale"] : []),
		...(missingProofTimestampGroups > 0
			? ["trace_proof_timestamp_missing"]
			: []),
	];
	const status: TraceFreshnessCoverage["status"] =
		proofGroups.length === 0
			? "no_data"
			: freshnessRate >= ACTIVITY_REVIEW_TRACE_FRESHNESS_TARGET
				? "met"
				: freshnessRate >= ACTIVITY_REVIEW_TRACE_FRESHNESS_TARGET / 2
					? "warning"
					: "breach";

	return {
		status,
		targetMaxLagMs: ACTIVITY_REVIEW_TRACE_FRESHNESS_MAX_LAG_MS,
		freshnessRate,
		proofGroups: proofGroups.length,
		freshGroups,
		staleGroups,
		missingProofTimestampGroups,
		maxLagMs,
		latestAuditAt,
		latestProofAt,
		warnings,
	};
}

function buildHumanActivityReview(input: {
	items: ActivityItem[];
	windowStart: string;
	windowEnd: string;
	payloadsConfigured: boolean;
	traceEvidenceByTraceId?: Map<string, TraceEvidenceSummary>;
}): HumanActivityReview {
	const groupsMap = new Map<string, ActivityItem[]>();
	for (const item of input.items) {
		const key = reviewGroupKey(item);
		groupsMap.set(key, [...(groupsMap.get(key) ?? []), item]);
	}
	const groups: ActivityReviewGroup[] = Array.from(groupsMap.entries()).map(
		([id, groupItems]) => {
			const ordered = [...groupItems].sort((a, b) =>
				a.timestamp.localeCompare(b.timestamp),
			);
			const first = ordered[0]!;
			const apps = Array.from(
				new Map(
					ordered
						.map((item) => item.app)
						.filter((app): app is AppDescriptor => !!app)
						.map((app) => [app.id, app]),
				).values(),
			);
			const topTools = buildToolSummaries(ordered);
			const errorEvents = ordered.filter((item) => !item.success).length;
			const coverage = mergeCoverage(ordered);
			const appText =
				apps.length > 0 ? ` on ${apps.map((app) => app.label).join(", ")}` : "";
			const toolText =
				topTools.length > 0
					? topTools
							.slice(0, 3)
							.map((tool) => tool.tool.label)
							.join(", ")
					: "MCP activity";
			const runtimeTraceEvidence =
				(first.traceId
					? input.traceEvidenceByTraceId?.get(first.traceId)
					: undefined) ?? traceEvidenceFallback(first.traceId);
			const traceEvidence = markMcpTraceEvidence(
				runtimeTraceEvidence,
				ordered.filter((item) => item.action.startsWith("mcp.")).length,
			);
			const securityPosture = buildSecurityPosture(ordered);
			const titleVerb =
				securityPosture.disposition === "denied" ? "was denied" : "used";
			const title = `${first.attribution.actor.label} ${titleVerb} ${toolText}${appText}`;
			const summary = `${ordered.length} audit event(s), ${securityPosture.deniedEvents} denied, ${errorEvents} error(s). ${first.attribution.summary}.`;

			return {
				id,
				title,
				summary,
				startedAt: ordered[0]!.timestamp,
				endedAt: ordered[ordered.length - 1]!.timestamp,
				totalEvents: ordered.length,
				successfulEvents: ordered.length - errorEvents,
				errorEvents,
				traceId: first.traceId,
				executionId: first.executionId,
				actor: first.actor,
				subject: first.subject,
				agent: first.agent,
				attribution: first.attribution,
				apps,
				topTools,
				identityCoverage: coverage,
				traceEvidence,
				securityPosture,
				evidence: {
					auditEventCount: ordered.length,
					payloadsConfigured: input.payloadsConfigured,
					source: "audit_events",
				},
			};
		},
	);
	groups.sort((a, b) => b.endedAt.localeCompare(a.endedAt));
	const warnings = Array.from(
		new Set(groups.flatMap((group) => group.identityCoverage.warnings)),
	);
	const traceEvidence = buildTraceEvidenceCoverage(groups);
	const traceFreshness = buildTraceFreshnessCoverage(groups);
	const securityPosture = {
		executedGroups: groups.filter(
			(group) => group.securityPosture.disposition === "executed",
		).length,
		deniedGroups: groups.filter(
			(group) => group.securityPosture.disposition === "denied",
		).length,
		mixedGroups: groups.filter(
			(group) => group.securityPosture.disposition === "mixed",
		).length,
		executedEvents: groups.reduce(
			(total, group) => total + group.securityPosture.executedEvents,
			0,
		),
		deniedEvents: groups.reduce(
			(total, group) => total + group.securityPosture.deniedEvents,
			0,
		),
		unknownRiskEvents: groups.reduce(
			(total, group) => total + group.securityPosture.unknownRiskEvents,
			0,
		),
		denialReasons: [
			...new Set(
				groups.flatMap((group) => group.securityPosture.denialReasons),
			),
		].sort(),
	};
	return {
		windowStart: input.windowStart,
		windowEnd: input.windowEnd,
		totalEvents: input.items.length,
		groups,
		coverage: {
			totalGroups: groups.length,
			unresolvedActorGroups: groups.filter(
				(group) => !group.identityCoverage.actorResolved,
			).length,
			missingSubjectGroups: groups.filter(
				(group) => !group.identityCoverage.subjectPresent,
			).length,
			unresolvedToolGroups: groups.filter(
				(group) => !group.identityCoverage.toolResolved,
			).length,
			securityPosture,
			traceEvidence,
			traceFreshness,
			warnings,
		},
	};
}

function auditTimestampToIso(value: Date | number | string): string {
	if (value instanceof Date) return value.toISOString();
	if (typeof value === "number") return new Date(value * 1000).toISOString();
	const numeric = Number(value);
	if (Number.isFinite(numeric)) return new Date(numeric * 1000).toISOString();
	return new Date(value).toISOString();
}

function nullableNumber(value: unknown): number | null {
	if (value == null) return null;
	const numberValue = Number(value);
	return Number.isFinite(numberValue) ? numberValue : null;
}

async function resolveWidgetEventsWithOrgIds(
	events: WidgetEvent[],
	helpers: {
		resolveAppIds: (appIds: string[]) => Promise<Map<string, string>>;
	},
): Promise<NewWidgetEvent[]> {
	const missingAppIds = Array.from(
		new Set(
			events
				.filter((event) => !event.organizationId)
				.map((event) => event.appId),
		),
	);

	const orgIdMap = new Map<string, string>();
	if (missingAppIds.length > 0) {
		const resolvedMap = await helpers.resolveAppIds(missingAppIds);
		for (const [appId, organizationId] of resolvedMap.entries()) {
			orgIdMap.set(appId, organizationId);
		}
	}

	return events.map((event) => {
		const organizationId =
			event.organizationId ?? orgIdMap.get(event.appId) ?? null;

		if (!organizationId) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Missing organizationId for widget event (appId: ${event.appId})`,
			);
		}

		return {
			...event,
			organizationId,
			metadata:
				event.metadata === undefined ? undefined : toJsonRecord(event.metadata),
		};
	});
}

// =============================================================================
// TYPE EXPORTS
// =============================================================================
