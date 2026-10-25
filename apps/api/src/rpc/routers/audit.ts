/**
 * oRPC Audit Router
 * Audit trail search and retrieval for compliance and debugging
 *
 * Guarded with observability read access.
 */

import { implement } from "@orpc/server";
import { auditContract } from "@tedix/api-contract/contracts/audit";
import {
	AUDIT_EXPORT_ATTRIBUTION_KEYS,
	AUDIT_EXPORT_TRUNCATED_MARKER,
	type AuditExportFormat,
} from "@tedix/api-contract/schemas/audit";
import {
	getAuditEventsByResource as getAuditEventsByResourceQuery,
	insertAuditEvent,
	searchAuditEvents as searchAuditEventsQuery,
} from "@tedix/db/queries/audit";
import { toJsonRecord } from "@tedix/db/utils/json";
import { spillAuditMetadata } from "../../lib/audit-metadata-spill";
import {
	type AuditEventOutput,
	toAuditEventOutput,
} from "../../lib/audit-event-output";
import { requireOrgId } from "../org-scope";
import {
	withAuthorization,
	type BaseContext,
	withAuth,
	withServiceAuth,
} from "../orpc";

const auditOs = implement(auditContract).$context<BaseContext>();
const authedOs = auditOs.use(withAuth);
export const AUDIT_READ_PERMISSION = "analytics:read";
export const AUDIT_READ_SCOPE = "analytics:read";

// =============================================================================
// HELPERS
// =============================================================================

/** Rows per search page while collecting an export. */
export const AUDIT_EXPORT_PAGE_SIZE = 500;

const AUDIT_EXPORT_BASE_COLUMNS = [
	"timestamp",
	"id",
	"actorType",
	"actorId",
	"action",
	"resourceType",
	"resourceId",
] as const;

function csvCell(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	return typeof value === "string" ? value : JSON.stringify(value);
}

function metadataRecord(
	metadata: AuditEventOutput["metadata"],
): Record<string, unknown> | null {
	return metadata && typeof metadata === "object" && !Array.isArray(metadata)
		? (metadata as Record<string, unknown>)
		: null;
}

/**
 * One row per event: the fixed columns, the attribution keys present on any
 * exported event (lifted from `metadata`), then the whole `metadata` as JSON.
 * A spilled body stays the pointer it was stored as.
 */
function auditEventsCsvRows(events: AuditEventOutput[]): (string | null)[][] {
	const attribution = AUDIT_EXPORT_ATTRIBUTION_KEYS.filter((key) =>
		events.some((event) => metadataRecord(event.metadata)?.[key] != null),
	);
	return [
		[...AUDIT_EXPORT_BASE_COLUMNS, ...attribution, "metadata"],
		...events.map((event) => {
			const metadata = metadataRecord(event.metadata);
			return [
				...AUDIT_EXPORT_BASE_COLUMNS.map((column) => csvCell(event[column])),
				...attribution.map((key) => csvCell(metadata?.[key])),
				csvCell(event.metadata),
			];
		}),
	];
}

/**
 * `audit-events-<stamp>.<format>`; a capped export that left matching events
 * out says so in its name: `audit-events-<stamp>-truncated-<rows>.<format>`.
 */
function exportFilename(
	format: AuditExportFormat,
	exportedAt: Date,
	truncatedAt?: number,
): string {
	const stamp = exportedAt
		.toISOString()
		.replace(/\.\d{3}Z$/, "Z")
		.replaceAll(":", "-");
	const suffix = truncatedAt === undefined ? "" : `-truncated-${truncatedAt}`;
	return `audit-events-${stamp}${suffix}.${format}`;
}

// =============================================================================
// PROCEDURES
// =============================================================================

export const searchAuditEvents = authedOs.search
	.use(withAuthorization(AUDIT_READ_PERMISSION, AUDIT_READ_SCOPE))
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);

		const limit = input?.limit ?? 50;
		const offset = input?.offset ?? 0;

		const { data, total } = await searchAuditEventsQuery(context.db, {
			organizationId: orgId,
			actorId: input?.actorId,
			action: input?.action,
			resourceType: input?.resourceType,
			resourceId: input?.resourceId,
			startDate: input?.startDate,
			endDate: input?.endDate,
			limit,
			offset,
		});

		return {
			data: data.map(toAuditEventOutput),
			pagination: {
				limit,
				offset,
				total,
				hasMore: offset + limit < total,
			},
		};
	});

export const exportAuditEvents = authedOs.export
	.use(withAuthorization(AUDIT_READ_PERMISSION, AUDIT_READ_SCOPE))
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const exportedAt = new Date();
		// Pin the window to the export's start so events written while paging
		// cannot shift the offsets; ids are deduplicated for the same reason.
		const endDate =
			input.endDate && new Date(input.endDate) < exportedAt
				? input.endDate
				: exportedAt.toISOString();

		const filters = {
			organizationId: orgId,
			actorId: input.actorId,
			action: input.action,
			resourceType: input.resourceType,
			resourceId: input.resourceId,
			startDate: input.startDate,
			endDate,
		};
		const seen = new Set<string>();
		const events: AuditEventOutput[] = [];
		// Page through the same search query the trail reads, so events kept in
		// the logs store are exported alongside the main database's.
		let offset = 0;
		while (offset < input.limit) {
			const pageLimit = Math.min(AUDIT_EXPORT_PAGE_SIZE, input.limit - offset);
			const { data } = await searchAuditEventsQuery(context.db, {
				...filters,
				limit: pageLimit,
				offset,
			});
			for (const row of data) {
				if (seen.has(row.id)) continue;
				seen.add(row.id);
				events.push(toAuditEventOutput(row));
			}
			offset += data.length;
			if (data.length < pageLimit) break;
		}
		// The cap was reached: one probe past it says whether events were left out.
		const truncated =
			offset >= input.limit &&
			(
				await searchAuditEventsQuery(context.db, {
					...filters,
					limit: 1,
					offset,
				})
			).data.length > 0;

		const filename = exportFilename(
			input.format,
			exportedAt,
			truncated ? events.length : undefined,
		);
		if (input.format === "jsonl") {
			const body =
				events.map((event) => `${JSON.stringify(event)}\n`).join("") +
				(truncated
					? `${JSON.stringify({ [AUDIT_EXPORT_TRUNCATED_MARKER]: { truncated: true, events: events.length, limit: input.limit } })}\n`
					: "");
			return new File([body], filename, {
				type: "application/x-ndjson; charset=utf-8",
			});
		}
		// Deferred like the output exports: the writer stays off this router's
		// import graph until a CSV is asked for.
		const { encodeCsv } = await import("../../lib/os-output-csv");
		return new File([encodeCsv(auditEventsCsvRows(events))], filename, {
			type: "text/csv; charset=utf-8",
		});
	});

export const getAuditEventsByResource = authedOs.getByResource
	.use(withAuthorization(AUDIT_READ_PERMISSION, AUDIT_READ_SCOPE))
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);

		const events = await getAuditEventsByResourceQuery(
			context.db,
			orgId,
			input.resourceType,
			input.resourceId,
		);

		return {
			data: events.map(toAuditEventOutput),
		};
	});

/**
 * Create an audit event (internal service endpoint)
 *
 * SECURITY: Uses service auth - called from MCP server
 * to bridge tool call telemetry into the platform audit trail.
 */
export const createAuditEvent = auditOs.createEvent
	.use(withServiceAuth)
	.handler(async ({ input, context }) => {
		const id = crypto.randomUUID();
		// Bodies over 4 KiB go to R2 with a pointer; the row keeps the scalars.
		const metadata =
			input.metadata === undefined
				? undefined
				: await spillAuditMetadata(toJsonRecord(input.metadata), {
						bucket: (context.env as { TEDI_R2_BUCKET?: R2Bucket })
							.TEDI_R2_BUCKET,
						organizationId: input.organizationId,
						auditId: id,
					});
		await insertAuditEvent(context.db, {
			id,
			organizationId: input.organizationId,
			actorId: input.actorId,
			actorType: input.actorType,
			action: input.action,
			resourceType: input.resourceType,
			resourceId: input.resourceId,
			metadata,
		});

		return { success: true as const };
	});

export const auditContractRouter = auditOs.router({
	search: searchAuditEvents,
	export: exportAuditEvents,
	getByResource: getAuditEventsByResource,
	createEvent: createAuditEvent,
});
