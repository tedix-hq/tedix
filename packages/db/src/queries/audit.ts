/**
 * Audit Event Query Helpers
 * CRUD operations for the audit_events table.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import type { DbClient } from "../client";
import { auditEvents } from "../schema";

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

/**
 * Insert a single audit event.
 */
export async function insertAuditEvent(
	db: DbClient,
	event: InsertAuditEventParams,
): Promise<string> {
	const id = event.id ?? crypto.randomUUID();
	const insert = db.insert(auditEvents).values({
		id,
		organizationId: event.organizationId,
		actorId: event.actorId,
		actorType: event.actorType,
		action: event.action,
		resourceType: event.resourceType,
		resourceId: event.resourceId ?? null,
		metadata: event.metadata ?? null,
		ipAddress: event.ipAddress ?? null,
		userAgent: event.userAgent ?? null,
		timestamp: event.occurredAt ?? new Date(),
	});
	// DO NOTHING, never DO UPDATE: an audit row is evidence, so a redelivery must
	// not be able to rewrite what was already recorded.
	await (event.ignoreDuplicates ? insert.onConflictDoNothing() : insert);
	return id;
}

/**
 * Search audit events with optional filters and pagination.
 */
export async function searchAuditEvents(
	db: DbClient,
	options: SearchAuditEventsOptions,
): Promise<{ data: (typeof auditEvents.$inferSelect)[]; total: number }> {
	const { organizationId, limit = 50, offset = 0 } = options;

	const conditions = [eq(auditEvents.organizationId, organizationId)];

	if (options.actorId)
		conditions.push(eq(auditEvents.actorId, options.actorId));
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
		.orderBy(desc(auditEvents.timestamp))
		.limit(limit)
		.offset(offset);

	const total = await db.$count(auditEvents, whereClause);

	return { data, total };
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
	return db
		.select()
		.from(auditEvents)
		.where(
			and(
				eq(auditEvents.organizationId, organizationId),
				eq(auditEvents.resourceType, resourceType),
				eq(auditEvents.resourceId, resourceId),
			),
		)
		.orderBy(desc(auditEvents.timestamp))
		.limit(limit);
}
