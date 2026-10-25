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
			.input(AuditSearchFiltersSchema.extend(PaginationSchema.shape).optional())
			.output(
				z.object({
					data: z.array(AuditEventSchema),
					pagination: PaginationMetaSchema,
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
