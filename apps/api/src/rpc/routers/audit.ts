/**
 * oRPC Audit Router
 * Audit trail search and retrieval for compliance and debugging
 *
 * Guarded with observability read access.
 */

import { implement } from "@orpc/server";
import { auditContract } from "@tedix/api-contract/contracts/audit";
import {
	getAuditEventsByResource as getAuditEventsByResourceQuery,
	insertAuditEvent,
	searchAuditEvents as searchAuditEventsQuery,
} from "@tedix/db/queries/audit";
import { toJsonRecord } from "@tedix/db/utils/json";
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
			data: data.map((e) => ({
				id: e.id,
				organizationId: e.organizationId,
				actorId: e.actorId,
				// `external_agent` is in the contract's output enum and rows now
				// carry it — every OS write through the MCP gateway is one.
				// Omitting it here made the cast lie about the values this reader
				// actually returns, so a caller switching on the returned type had
				// no arm for a principal that genuinely appears.
				actorType: e.actorType as
					| "user"
					| "service"
					| "tedi"
					| "m2m"
					| "api_key"
					| "external_agent"
					| "anonymous"
					| "kernel",
				action: e.action,
				resourceType: e.resourceType,
				resourceId: e.resourceId,
				metadata: e.metadata,
				ipAddress: e.ipAddress,
				userAgent: e.userAgent,
				timestamp: e.timestamp.toISOString(),
			})),
			pagination: {
				limit,
				offset,
				total,
				hasMore: offset + limit < total,
			},
		};
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
			data: events.map((e) => ({
				id: e.id,
				organizationId: e.organizationId,
				actorId: e.actorId,
				// `external_agent` is in the contract's output enum and rows now
				// carry it — every OS write through the MCP gateway is one.
				// Omitting it here made the cast lie about the values this reader
				// actually returns, so a caller switching on the returned type had
				// no arm for a principal that genuinely appears.
				actorType: e.actorType as
					| "user"
					| "service"
					| "tedi"
					| "m2m"
					| "api_key"
					| "external_agent"
					| "anonymous"
					| "kernel",
				action: e.action,
				resourceType: e.resourceType,
				resourceId: e.resourceId,
				metadata: e.metadata,
				ipAddress: e.ipAddress,
				userAgent: e.userAgent,
				timestamp: e.timestamp.toISOString(),
			})),
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
		await insertAuditEvent(context.db, {
			organizationId: input.organizationId,
			actorId: input.actorId,
			actorType: input.actorType,
			action: input.action,
			resourceType: input.resourceType,
			resourceId: input.resourceId,
			metadata:
				input.metadata === undefined ? undefined : toJsonRecord(input.metadata),
		});

		return { success: true as const };
	});

export const auditContractRouter = auditOs.router({
	search: searchAuditEvents,
	getByResource: getAuditEventsByResource,
	createEvent: createAuditEvent,
});
