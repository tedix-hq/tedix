/**
 * Audit Event Query Helpers
 * CRUD operations for the audit_events table.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, desc, eq, gte, inArray, lte, lt, or } from "drizzle-orm";
import { getLogStores, type DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { auditEvents } from "../schema/audit-events";
import { auditMetadataRefs } from "../schema/audit-metadata-refs";
import { chunkForBoundParams } from "../utils/batch";
import { MCP_TELEMETRY_ACTIONS } from "../utils/audit-telemetry";
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
	cursor?: { timestamp: string; id: string };
}

// ============================================================================
// Queries
// ============================================================================

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
	// Keep attribution inline: a dictionary lookup must not block the audit write.
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

/** Inline metadata avoids a dictionary read and up to two inserts per event. */
export async function insertMcpAuditEventsBatch(
	db: DbClient,
	events: InsertAuditEventParams[],
): Promise<void> {
	if (events.some((event) => !MCP_TELEMETRY_ACTIONS.has(event.action)))
		throw new Error("Only MCP execution telemetry may use the log batch");
	const target = getLogStores(db)?.logs ?? db;
	const table = coreTable(target, auditEvents);
	// Eleven bound columns per row; eight rows stay below D1's 100-param cap.
	const [first, ...rest] = chunkForBoundParams(events, 8).map((chunk) =>
		target.insert(table).values(
			chunk.map((event) => ({
				id: event.id ?? crypto.randomUUID(),
				organizationId: event.organizationId,
				actorId: event.actorId,
				actorType: event.actorType,
				action: event.action,
				resourceType: event.resourceType,
				resourceId: event.resourceId ?? null,
				metadata: compactAuditMetadata(event),
				ipAddress: event.ipAddress ?? null,
				userAgent: event.userAgent ?? null,
				timestamp: event.occurredAt ?? new Date(),
			})),
		),
	);
	if (first) await target.batch([first, ...rest]);
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
const AUDIT_METADATA_REFS = "_r";

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

async function expandAuditMetadataRefs<
	T extends {
		organizationId: string;
		actorId: string;
		metadata: Record<string, JsonValue> | null;
	},
>(db: DbClient, rows: T[]): Promise<T[]> {
	const refs = [
		...new Set(
			rows.flatMap((row) => {
				const metadata = row.metadata;
				if (!metadata) return [];
				const metadataRefs = metadata[AUDIT_METADATA_REFS];
				if (
					typeof metadataRefs !== "object" ||
					metadataRefs === null ||
					Array.isArray(metadataRefs)
				)
					return [];
				return [metadataRefs.a, metadataRefs.c].filter(
					(value): value is string => typeof value === "string",
				);
			}),
		),
	];
	if (refs.length === 0) return rows.map(expandAuditMetadata);
	const values = new Map<string, string>();
	for (const chunk of chunkForBoundParams(refs, 50)) {
		const mappings = await db
			.select()
			.from(auditMetadataRefs)
			.where(inArray(auditMetadataRefs.ref, chunk));
		for (const mapping of mappings)
			values.set(`${mapping.organizationId}\0${mapping.ref}`, mapping.value);
	}
	return rows.map((row) => {
		if (!row.metadata) return expandAuditMetadata(row);
		const metadata = { ...row.metadata };
		const metadataRefs = metadata[AUDIT_METADATA_REFS];
		if (
			typeof metadataRefs !== "object" ||
			metadataRefs === null ||
			Array.isArray(metadataRefs)
		)
			return expandAuditMetadata(row);
		for (const [refKey, key] of [
			["a", "appId"],
			["c", "clientId"],
		] as const) {
			const ref = metadataRefs[refKey];
			if (typeof ref !== "string") continue;
			const value = values.get(`${row.organizationId}\0${ref}`);
			if (value === undefined)
				throw new Error(`Missing audit metadata reference: ${ref}`);
			metadata[key] = value;
		}
		delete metadata[AUDIT_METADATA_REFS];
		return expandAuditMetadata({ ...row, metadata });
	});
}

/** Unexecuted audit insert, for `db.batch()` composition. */
export function buildInsertAuditEventStatement(
	db: DbClient,
	event: InsertAuditEventParams,
) {
	const id = event.id ?? crypto.randomUUID();
	const metadata = compactAuditMetadata(event);
	const insert = db.insert(coreTable(db, auditEvents)).values({
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
	const cursor = options.cursor;
	const pageWhere = cursor
		? and(
				whereClause,
				or(
					lt(auditEvents.timestamp, new Date(cursor.timestamp)),
					and(
						eq(auditEvents.timestamp, new Date(cursor.timestamp)),
						lt(auditEvents.id, cursor.id),
					),
				),
			)
		: whereClause;

	const data = await db
		.select()
		.from(auditEvents)
		.where(pageWhere)
		.orderBy(desc(auditEvents.timestamp), desc(auditEvents.id))
		.limit(limit)
		.offset(offset);

	const total = await db.$count(auditEvents, whereClause);

	return { data: await expandAuditMetadataRefs(db, data), total };
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
	return expandAuditMetadataRefs(db, rows);
}
