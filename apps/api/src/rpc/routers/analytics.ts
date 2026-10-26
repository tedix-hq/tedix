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

import { safeExceptionTopology } from "../../lib/safe-log-metadata";
import { implement } from "@orpc/server";
import {
	analyticsContract,
	type WidgetEvent,
} from "@tedix/api-contract/contracts/analytics";
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
	listAnalyticsTraceActivity,
	listRecentAnalyticsAuditActivity,
} from "@tedix/db/queries/analytics-audit";
import { insertAuditEvent } from "@tedix/db/queries/audit";
import { listTediObservabilityRows } from "@tedix/db/queries/cognitive-runtime";
import { listSkillRetrievalUtility } from "@tedix/db/queries/skill-retrieval-utility";
import type { NewWidgetEvent } from "@tedix/db/schema/analytics";
import { toJsonRecord } from "@tedix/db/utils/json";
import {
	getAppMetricsFromAE,
	getAppToolBreakdownFromAE,
} from "../../lib/analytics-engine";
import {
	getAppSummaryFromAE,
	getAppTimeSeriesFromAE,
	getExecutionDrilldownFromAE,
	getRecentExecutionsFromAE,
} from "../../lib/analytics-engine-apps";
import { hasAEConfig } from "../../lib/analytics-engine-query";
import {
	hasCodemodeAEConfig,
	queryCodemodeAnalyticsSummary,
} from "../../lib/analytics-engine-codemode";
import { buildDrilldownFromAuditRows } from "../../lib/execution-drilldown";
import { getToolCallPayloadsFromR2, hasR2SqlConfig } from "../../lib/r2-sql";
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
import { hydrateActivityRows } from "./analytics/activity-hydration";
import { loadTraceEvidenceSummaries } from "./analytics/trace-evidence";
import { buildHumanActivityReview } from "./analytics/human-activity-review";

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
			console.error("[Analytics] AE query failed, returning zeros", {
				exception: safeExceptionTopology(error),
			});
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
				console.error("[Analytics] AE tool breakdown query failed", {
					exception: safeExceptionTopology(error),
				});
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
			console.error("[Analytics] AE app summary query failed", {
				exception: safeExceptionTopology(error),
			});
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
			console.error("[Analytics] AE time-series query failed", {
				exception: safeExceptionTopology(error),
			});
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
				console.error("[Analytics] AE recent executions query failed", {
					exception: safeExceptionTopology(error),
				});
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
				console.error("[Analytics] audit drilldown query failed", {
					exception: safeExceptionTopology(error),
				});
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
				console.error("[Analytics] AE execution drilldown query failed", {
					exception: safeExceptionTopology(error),
				});
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
				console.error("[Analytics] R2 SQL payload query failed", {
					exception: safeExceptionTopology(error),
				});
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
				console.error("[Analytics] trace payload join failed", {
					exception: safeExceptionTopology(error),
				});
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
				console.error("[Analytics] Codemode AE query failed", {
					exception: safeExceptionTopology(error),
				});
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
			console.error("[Analytics] Failed to track widget events", {
				exception: safeExceptionTopology(error),
			});
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
