import { decodeAuditCursor } from "../schemas/audit-cursor";
import "@orpc/openapi/extensions/route";
/**
 * Audit Contract for oRPC
 * Type-safe API contract for audit trail endpoints
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	PaginationMetaSchema,
	PaginationSchema,
	SuccessResponseSchema,
} from "../schemas/common";
import {
	AuditActorTypeSchema,
	McpAuditBatchInputSchema,
	GatewayChangeRecordAppendedSchema,
	GatewayChangeRecordInputSchema,
	GatewayChangeRecordCheckpointsExportSchema,
	GatewayChangeRecordCheckpointsInputSchema,
	GatewayChangeRecordSchema,
	GatewayChangeRecordsExportSchema,
	GatewayChangeRecordsInputSchema,
	GatewayLedgerQuerySchema,
	AuditExportInputSchema,
	AuditExportOutputSchema,
	AuditSearchFiltersSchema,
} from "../schemas/audit";

// =============================================================================
// SCHEMAS
// =============================================================================

const AuditEventSchema = z.object({
	id: z.string(),
	organizationId: z.string(),
	actorId: z.string(),
	actorType: AuditActorTypeSchema,
	action: z.string(),
	resourceType: z.string(),
	resourceId: z.string().nullable(),
	metadata: z.unknown().nullable(),
	ipAddress: z.string().nullable(),
	userAgent: z.string().nullable(),
	timestamp: z.string().datetime(),
});

// =============================================================================
// CONTRACT
// =============================================================================

/**
 * Audit contract defining all audit trail endpoints
 *
 * All endpoints are org-scoped via JWT context
 */
export const auditContract = oc
	.route({ tags: ["audit"], prefix: "/audit" })
	.errors(baseErrors)
	.router({
		appendChangeRecord: oc
			.route({
				tags: ["internal"],
				method: "POST",
				path: "/changes",
				summary: "Append gateway change record",
			})
			.input(GatewayChangeRecordInputSchema)
			.output(GatewayChangeRecordAppendedSchema),
		listChangeRecords: oc
			.route({
				tags: ["internal"],
				method: "GET",
				path: "/changes",
				summary: "List gateway change records",
			})
			.input(GatewayLedgerQuerySchema)
			.output(z.array(GatewayChangeRecordSchema)),
		getChangeRecord: oc
			.route({
				tags: ["internal"],
				method: "GET",
				path: "/changes/{id}",
				summary: "Get gateway change record",
			})
			.input(z.object({ id: z.string().min(1) }))
			.output(GatewayChangeRecordSchema.nullable()),
		listGatewayChangeRecords: oc
			.route({
				method: "GET",
				path: "/gateway-change-records",
				summary: "List and count gateway change records",
				description:
					"Read your organization's record of tool calls made through the MCP gateway, allowed or refused, for a time range. Returns one page, oldest first, plus the count of hot-store records in the range. Ranges reaching before the 30-day window return archivedBefore and EU archive day manifestKeys. An archived range is not 'no records': download the manifests and their checkpoint bundles to read and verify the older records. Follow nextAfterSequence with the same range to read the remaining records. Pass subjectId to read only the records of calls about one Work Item. Records hold a hash of the call's arguments, never the arguments. Only an active owner or admin of the organization can call it.",
			})
			.input(GatewayChangeRecordsInputSchema)
			.output(GatewayChangeRecordsExportSchema),
		listGatewayChangeRecordCheckpoints: oc
			.route({
				method: "GET",
				path: "/gateway-change-record-checkpoints",
				summary: "List gateway change record checkpoints",
				description:
					"Read the signed checkpoints that make your organization's gateway change records tamper-evident, by record sequence or by when they were sealed, oldest first. Each checkpoint states how many records it covers and the hash its last record must chain to; a checkpoint signed with the organization's key holds that statement in a signed envelope. Use them with list_gateway_change_records to check an export offline. Also returns the current public key; confirm it through another channel before trusting it. Only an active owner or admin of the organization can call it.",
			})
			.input(GatewayChangeRecordCheckpointsInputSchema)
			.output(GatewayChangeRecordCheckpointsExportSchema),

		/**
		 * Search audit events with optional filters
		 * GET /audit
		 */
		search: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "" as `/${string}`,
				summary: "Search audit events",
				description:
					"Search audit events for the current organization with optional filters and pagination",
			})
			.input(
				AuditSearchFiltersSchema.extend(PaginationSchema.shape)
					.extend({
						cursor: z
							.string()
							.max(2048)
							.refine(
								(value) => decodeAuditCursor(value) !== undefined,
								"Invalid audit cursor",
							)
							.optional(),
					})
					.strict()
					.optional(),
			)
			.output(
				z.object({
					data: z.array(AuditEventSchema),
					pagination: PaginationMetaSchema.extend({
						nextCursor: z.string().nullable().optional(),
					}),
				}),
			),

		/**
		 * Export audit events matching the search filters as a file
		 * GET /audit/export
		 *
		 * Newest first, capped at `limit` rows. Spilled metadata exports its
		 * stored pointer; bodies are not hydrated.
		 */
		export: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "/export",
				summary: "Export audit events",
				description:
					"Download audit events for the current organization as CSV or JSON Lines, using the same filters as audit search. Returns at most `limit` events (default 5000, maximum 10000), newest first. When matching events were left out, the filename ends `-truncated-<rows>` and JSON Lines end with an `_export` marker line.",
			})
			.input(AuditExportInputSchema)
			.output(AuditExportOutputSchema),

		/**
		 * Get audit events for a specific resource
		 * GET /audit/resource/{resourceType}/{resourceId}
		 */
		getByResource: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "/resource/{resourceType}/{resourceId}",
				summary: "Get audit events by resource",
				description: "Get all audit events for a specific resource type and ID",
			})
			.input(
				z.object({
					resourceType: z.string().min(1),
					resourceId: z.string().min(1),
				}),
			)
			.output(
				z.object({
					data: z.array(AuditEventSchema),
				}),
			),

		createTelemetryBatch: oc
			.route({
				method: "POST",
				path: "/telemetry-batch",
				tags: ["internal"],
				summary: "Create MCP audit telemetry batch",
			})
			.input(McpAuditBatchInputSchema)
			.output(SuccessResponseSchema),

		/**
		 * Create an audit event (internal service use)
		 * POST /audit/events
		 *
		 * Used by apps/mcp to bridge MCP tool call telemetry
		 * into the platform audit trail.
		 */
		createEvent: oc
			.route({
				method: "POST",
				path: "/events",
				summary: "Create audit event",
				description:
					"Create an audit event programmatically. Internal service endpoint.",
				tags: ["audit", "internal"],
			})
			.input(
				z.object({
					organizationId: z.uuid(),
					actorId: z.string(),
					actorType: AuditActorTypeSchema,
					action: z.string(),
					resourceType: z.string(),
					resourceId: z.string().optional(),
					metadata: z.record(z.string(), z.unknown()).optional(),
				}),
			)
			.output(SuccessResponseSchema),
	});

export type AuditContract = typeof auditContract;
