/**
 * Analytics Query Helpers
 * Database queries for widget events and retention cleanup.
 *
 * Per-app MCP tool-call metrics are sourced from Analytics Engine (AE) — see
 * apps/api/src/lib/analytics-engine.ts. The dead D1 mcp_tool_calls and
 * session_metrics tables were removed (they had no live writers).
 *
 * Active functions:
 * - Widget event tracking (trackWidgetEvent, trackWidgetEvents)
 * - Org ID resolution helpers (getOrganizationIdForApp, getOrganizationIdsForApps)
 * - Retention cleanup (deleteOldWidgetEvents)
 */

import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import { type NewWidgetEvent, widgetEvents } from "../schema/analytics";
import { apps } from "../schema/apps";
import { providerInstallations } from "../schema/provider-installations";
import { chunkForBoundParams } from "../utils/batch";
import { getAffectedRows } from "../utils/d1-result";

// Re-export types for consumers
export type {
	NewWidgetEvent,
	WidgetEvent,
	WidgetEventType,
} from "../schema/analytics";

// =============================================================================
// Type Definitions
// =============================================================================

/**
 * Date range filter for queries
 */
export interface DateRange {
	from: string; // ISO 8601
	to: string; // ISO 8601
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Resolve organizationId for a single app (relational query)
 */
export async function getOrganizationIdForApp(
	db: DbClient,
	appId: string,
): Promise<string | null> {
	const rows = await db
		.select({ organizationId: apps.organizationId })
		.from(apps)
		.where(eq(apps.id, appId))
		.limit(1);

	return rows[0]?.organizationId ?? null;
}

/**
 * Resolve organizationIds for a list of apps (relational query)
 */
export async function getOrganizationIdsForApps(
	db: DbClient,
	appIds: string[],
): Promise<Map<string, string>> {
	if (appIds.length === 0) return new Map();

	const map = new Map<string, string>();
	// D1 caps bound parameters at 100 per statement; chunk the id IN() list.
	for (const chunk of chunkForBoundParams([...new Set(appIds)], 50)) {
		const results = await db
			.select({ id: apps.id, organizationId: apps.organizationId })
			.from(apps)
			.where(inArray(apps.id, chunk));
		for (const row of results) {
			map.set(row.id, row.organizationId);
		}
	}

	return map;
}

// =============================================================================
// Widget Event Tracking
// =============================================================================

/**
 * Track widget event
 * Records user interactions within widgets
 */
export async function trackWidgetEvent(
	db: DbClient,
	event: NewWidgetEvent,
): Promise<void> {
	await db.insert(widgetEvents).values(event);
}

/**
 * Track widget events (bulk insert)
 * Records multiple widget events in a single transaction
 */
export async function trackWidgetEvents(
	db: DbClient,
	events: NewWidgetEvent[],
): Promise<void> {
	if (events.length === 0) return;
	await db.insert(widgetEvents).values(events);
}

/** Idempotent, privacy-minimized event written by the embedded Tedi runtime. */
export async function trackEmbeddedAttentionOutcome(
	db: DbClient,
	event: NewWidgetEvent,
): Promise<void> {
	await db.insert(widgetEvents).values(event).onConflictDoNothing({
		target: widgetEvents.id,
	});
}

export async function trackEmbeddedAttentionOutcomes(
	db: DbClient,
	events: NewWidgetEvent[],
): Promise<void> {
	if (events.length === 0) return;
	await db.insert(widgetEvents).values(events).onConflictDoNothing({
		target: widgetEvents.id,
	});
}

export type EmbeddedProviderActivityRow = {
	id: string;
	installationId: string;
	externalTenantId: string;
	hostUserId: string;
	hostUserLabel: string | null;
	hostRole: string | null;
	sessionId: string;
	eventType: string;
	createdAt: string | null;
};

/**
 * Provider-scoped embedded activity. Identity is read only from event metadata
 * written under a verified provider installation; browser-supplied tenant
 * filters never participate in this query.
 */
export async function listEmbeddedProviderActivity(
	db: DbClient,
	input: {
		providerOrganizationId: string;
		from: string;
		to: string;
		limit: number;
		installationId?: string;
		hostUserId?: string;
	},
): Promise<EmbeddedProviderActivityRow[]> {
	const installationId = sql<string>`json_extract(${widgetEvents.metadata}, '$.installationId')`;
	const hostUserId = sql<string>`json_extract(${widgetEvents.metadata}, '$.hostUserId')`;
	const hostUserLabel = sql<
		string | null
	>`json_extract(${widgetEvents.metadata}, '$.hostUserLabel')`;
	const hostRole = sql<
		string | null
	>`json_extract(${widgetEvents.metadata}, '$.hostRole')`;
	return db
		.select({
			id: widgetEvents.id,
			installationId,
			externalTenantId: providerInstallations.externalTenantId,
			hostUserId,
			hostUserLabel,
			hostRole,
			sessionId: widgetEvents.sessionId,
			eventType: widgetEvents.eventType,
			createdAt: widgetEvents.createdAt,
		})
		.from(widgetEvents)
		.innerJoin(
			providerInstallations,
			and(
				eq(providerInstallations.id, installationId),
				eq(
					providerInstallations.providerOrganizationId,
					input.providerOrganizationId,
				),
			),
		)
		.where(
			and(
				sql`datetime(${widgetEvents.createdAt}) >= datetime(${input.from})`,
				sql`datetime(${widgetEvents.createdAt}) <= datetime(${input.to})`,
				sql`${hostUserId} IS NOT NULL`,
				input.installationId
					? eq(providerInstallations.id, input.installationId)
					: undefined,
				input.hostUserId ? eq(hostUserId, input.hostUserId) : undefined,
			),
		)
		.orderBy(desc(widgetEvents.createdAt))
		.limit(input.limit);
}

export type EmbeddedAttentionReview = {
	attentionRef: string;
	reviewedAt: string;
};

/**
 * Returns only this signed installation/tenant/actor's latest review for each
 * current opaque attention reference. The current refs come from a freshly
 * validated provider brief; absence is intentionally not interpreted here.
 */
export async function listEmbeddedAttentionReviews(
	db: DbClient,
	input: {
		organizationId: string;
		appId: string;
		installationId: string;
		tediId: string;
		hostOrganizationId: string;
		hostUserId: string;
		origin: string;
		attentionRefs: string[];
	},
): Promise<EmbeddedAttentionReview[]> {
	if (input.attentionRefs.length === 0) return [];
	const attentionRefs = [...new Set(input.attentionRefs)].slice(0, 2);
	const rows = await db
		.select({
			attentionRef: widgetEvents.widgetKey,
			reviewedAt: widgetEvents.createdAt,
		})
		.from(widgetEvents)
		.where(
			and(
				eq(widgetEvents.organizationId, input.organizationId),
				eq(widgetEvents.appId, input.appId),
				eq(widgetEvents.eventType, "attention_review"),
				// bound-params: the embedded attention contract and this query cap current refs at two.
				inArray(widgetEvents.widgetKey, attentionRefs),
				sql`json_extract(${widgetEvents.metadata}, '$.installationId') = ${input.installationId}`,
				sql`json_extract(${widgetEvents.metadata}, '$.tediId') = ${input.tediId}`,
				sql`json_extract(${widgetEvents.metadata}, '$.hostOrganizationId') = ${input.hostOrganizationId}`,
				sql`json_extract(${widgetEvents.metadata}, '$.hostUserId') = ${input.hostUserId}`,
				sql`json_extract(${widgetEvents.metadata}, '$.origin') = ${input.origin}`,
			),
		)
		.orderBy(desc(widgetEvents.createdAt))
		.limit(attentionRefs.length * 10);

	const latest = new Map<string, string>();
	for (const row of rows) {
		if (row.attentionRef && row.reviewedAt && !latest.has(row.attentionRef)) {
			latest.set(row.attentionRef, row.reviewedAt);
		}
	}
	return Array.from(latest, ([attentionRef, reviewedAt]) => ({
		attentionRef,
		reviewedAt,
	}));
}

// =============================================================================
// Retention Cleanup
// =============================================================================

/**
 * Delete widget_events older than N days.
 * Returns number of deleted records.
 */
export async function deleteOldWidgetEvents(db: DbClient, days = 30) {
	const result = await db
		.delete(widgetEvents)
		.where(
			lt(widgetEvents.createdAt, sql`datetime('now', ${`-${days} days`})`),
		);
	return getAffectedRows(result);
}
