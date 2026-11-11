/**
 * Audit Event Query Helpers
 * CRUD operations for the audit_events table.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { getLogStores, type DbClient } from "../client";
import { auditEvents } from "../schema/audit-events";
import {
	compareTimestampId,
	mergeLogStoreRows,
	readLogStores,
} from "../utils/log-store";

// ============================================================================
// Types
// ============================================================================

export type AuditActorType =
	| "user"
	| "service"
	| "tedi"
	| "m2m"
	| "api_key"
	| "anonymous"
	| "external_agent"
	// Tenant control-plane actor (Kernel direct tool calls). TS-type only;
	// the audit_events.actor_type D1 column is plain text — no schema change.
	| "kernel";

export interface InsertAuditEventParams {
	id?: string;
	organizationId: string;
	actorId: string;
	actorType: AuditActorType;
	action: string;
	resourceType: string;
	resourceId?: string | null;
	metadata?: Record<string, JsonValue> | null;
	ipAddress?: string | null;
	userAgent?: string | null;
	/**
	 * Treat a primary-key collision as success instead of throwing.
	 *
	 * Only meaningful with a DETERMINISTIC `id` — it turns the PK into an
	 * idempotency key, so re-delivering the same event is a no-op rather than a
	 * duplicate row. Opt-in: with the default random id a collision means the
	 * UUID space broke, and swallowing that would hide a real fault.
	 */
	ignoreDuplicates?: boolean;
	/**
	 * When the event actually happened. Defaults to now, which is right for
	 * events Tedix itself emits, but NOT for ingested ones: the Descope audit
	 * webhook is explicitly throttled and non-real-time, so stamping receipt
	 * time misdates every row. Descope only retains 30 days, so this table is
	 * the archive of record and the drift is permanent.
	 */
	occurredAt?: Date;
}

export interface SearchAuditEventsOptions {
	organizationId: string;
	actorId?: string;
	actorType?: AuditActorType;
	action?: string;
	resourceType?: string;
	resourceId?: string;
	startDate?: string;
	endDate?: string;
	limit?: number;
	offset?: number;
}

// ============================================================================
// Queries
// ============================================================================

// Only execution telemetry belongs in LOGS_DB. Access, payment, authority and
// unknown future actions keep main-D1 persistence.
const MCP_TELEMETRY_ACTIONS = new Set([
	"mcp.tool.execute",
	"mcp.tool.error",
	"mcp.code.execute",
	"mcp.code.error",
	"mcp.prompt.execute",
	"mcp.prompt.error",
	"mcp.resource.read",
	"mcp.resource.error",
]);

/**
 * Insert a single audit event.
 *
 * Known MCP execution telemetry goes to the logs database when the client has
 * one (`configureLogStore`); every other action, and every audit row composed
 * into a main-database batch through `buildInsertAuditEventStatement`, stays
 * in the main database.
 */
export async function insertAuditEvent(
	db: DbClient,
	event: InsertAuditEventParams,
): Promise<string> {
	const target = MCP_TELEMETRY_ACTIONS.has(event.action)
		? (getLogStores(db)?.logs ?? db)
		: db;
	const { id, statement } = buildInsertAuditEventStatement(target, event);
	await statement;
	return id;
}

/** Insert several main-database audit events in one D1 batch. */
export async function insertAuditEventsBatch(
	db: DbClient,
	events: InsertAuditEventParams[],
): Promise<void> {
	const [first, ...rest] = events.map(
		(event) => buildInsertAuditEventStatement(db, event).statement,
	);
	if (!first) return;
	await db.batch([first, ...rest]);
}

/**
 * MCP telemetry (`mcp.*`) carries about 98% of audit metadata bytes, in rows of
 * about 500 bytes, and most of them repeat two identifiers: `subjectUserId`
 * equal to the row's actor and `tediId` equal to `agentTediId`. New `mcp.*`
 * rows store a flag in place of the copy; `expandAuditMetadata` and the
 * analytics projections restore it. Other actions are stored as given, since
 * their readers take metadata straight from the row.
 */
const AUDIT_SUBJECT_IS_ACTOR = "subjectIsActor";
const AUDIT_TEDI_IS_AGENT = "tediIsAgent";

function compactAuditMetadata(
	event: InsertAuditEventParams,
): Record<string, JsonValue> | null {
	if (!event.metadata) return null;
	const metadata = { ...event.metadata };
	if (metadata.oauthClientId === metadata.clientId)
		delete metadata.oauthClientId;
	if (!event.action.startsWith("mcp.")) return metadata;
	if (
		metadata.subjectUserId === event.actorId &&
		metadata[AUDIT_SUBJECT_IS_ACTOR] === undefined
	) {
		delete metadata.subjectUserId;
		metadata[AUDIT_SUBJECT_IS_ACTOR] = true;
	}
	if (
		typeof metadata.tediId === "string" &&
		metadata.tediId === metadata.agentTediId &&
		metadata[AUDIT_TEDI_IS_AGENT] === undefined
	) {
		delete metadata.tediId;
		metadata[AUDIT_TEDI_IS_AGENT] = true;
	}
	return metadata;
}

/** The metadata as it was written, before `compactAuditMetadata`. */
export function expandAuditMetadata<
	T extends { actorId: string; metadata: Record<string, JsonValue> | null },
>(row: T): T {
	const metadata = row.metadata;
	if (
		!metadata ||
		(metadata[AUDIT_SUBJECT_IS_ACTOR] !== true &&
			metadata[AUDIT_TEDI_IS_AGENT] !== true)
	)
		return row;
	const expanded = { ...metadata };
	if (expanded[AUDIT_SUBJECT_IS_ACTOR] === true) {
		delete expanded[AUDIT_SUBJECT_IS_ACTOR];
		expanded.subjectUserId = row.actorId;
	}
	if (expanded[AUDIT_TEDI_IS_AGENT] === true) {
		delete expanded[AUDIT_TEDI_IS_AGENT];
		if (expanded.agentTediId !== undefined)
			expanded.tediId = expanded.agentTediId;
	}
	return { ...row, metadata: expanded };
}

/** Unexecuted audit insert, for `db.batch()` composition. */
export function buildInsertAuditEventStatement(
	db: DbClient,
	event: InsertAuditEventParams,
) {
	const id = event.id ?? crypto.randomUUID();
	const metadata = compactAuditMetadata(event);
	const insert = db.insert(auditEvents).values({
		id,
		organizationId: event.organizationId,
		actorId: event.actorId,
		actorType: event.actorType,
		action: event.action,
		resourceType: event.resourceType,
		resourceId: event.resourceId ?? null,
		metadata,
		ipAddress: event.ipAddress ?? null,
		userAgent: event.userAgent ?? null,
		timestamp: event.occurredAt ?? new Date(),
	});
	// DO NOTHING, never DO UPDATE: an audit row is evidence, so a redelivery must
	// not be able to rewrite what was already recorded.
	return {
		id,
		statement: event.ignoreDuplicates ? insert.onConflictDoNothing() : insert,
	};
}

/**
 * Search audit events with optional filters and pagination.
 */
export async function searchAuditEvents(
	db: DbClient,
	options: SearchAuditEventsOptions,
): Promise<{ data: (typeof auditEvents.$inferSelect)[]; total: number }> {
	const { organizationId, limit = 50, offset = 0 } = options;
	const pages = await readLogStores(
		db,
		(store) =>
			searchAuditEvents(store, {
				...options,
				limit: limit + offset,
				offset: 0,
			}),
		{ from: options.startDate, to: options.endDate },
	);
	if (pages) {
		return {
			data: mergeLogStoreRows(
				pages.map((page) => page.data),
				{ compare: compareTimestampId("desc"), limit, offset },
			),
			total: pages.reduce((total, page) => total + page.total, 0),
		};
	}

	const conditions = [eq(auditEvents.organizationId, organizationId)];

	if (options.actorId)
		conditions.push(eq(auditEvents.actorId, options.actorId));
	if (options.actorType)
		conditions.push(eq(auditEvents.actorType, options.actorType));
	if (options.action) conditions.push(eq(auditEvents.action, options.action));
	if (options.resourceType)
		conditions.push(eq(auditEvents.resourceType, options.resourceType));
	if (options.resourceId)
		conditions.push(eq(auditEvents.resourceId, options.resourceId));
	if (options.startDate)
		conditions.push(gte(auditEvents.timestamp, new Date(options.startDate)));
	if (options.endDate)
		conditions.push(lte(auditEvents.timestamp, new Date(options.endDate)));

	const whereClause = and(...conditions);

	const data = await db
		.select()
		.from(auditEvents)
		.where(whereClause)
		.orderBy(desc(auditEvents.timestamp), desc(auditEvents.id))
		.limit(limit)
		.offset(offset);

	const total = await db.$count(auditEvents, whereClause);

	return { data: data.map(expandAuditMetadata), total };
}

/**
 * Get audit events for a specific resource.
 */
export async function getAuditEventsByResource(
	db: DbClient,
	organizationId: string,
	resourceType: string,
	resourceId: string,
	limit = 100,
): Promise<(typeof auditEvents.$inferSelect)[]> {
	const pages = await readLogStores(db, (store) =>
		getAuditEventsByResource(
			store,
			organizationId,
			resourceType,
			resourceId,
			limit,
		),
	);
	if (pages)
		return mergeLogStoreRows(pages, {
			compare: compareTimestampId("desc"),
			limit,
		});
	const rows = await db
		.select()
		.from(auditEvents)
		.where(
			and(
				eq(auditEvents.organizationId, organizationId),
				eq(auditEvents.resourceType, resourceType),
				eq(auditEvents.resourceId, resourceId),
			),
		)
		.orderBy(desc(auditEvents.timestamp), desc(auditEvents.id))
		.limit(limit);
	return rows.map(expandAuditMetadata);
}
