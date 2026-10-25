import type { AuditActorType } from "@tedix/api-contract/schemas/audit";
import type { searchAuditEvents } from "@tedix/db/queries/audit";

export type AuditEventRow = Awaited<
	ReturnType<typeof searchAuditEvents>
>["data"][number];

/** The audit event as the API returns and exports it. */
export function toAuditEventOutput(e: AuditEventRow) {
	return {
		id: e.id,
		organizationId: e.organizationId,
		actorId: e.actorId,
		// `external_agent` is in the contract's output enum and rows now carry
		// it — every OS write through the MCP gateway is one. The cast must name
		// every value this reader actually returns.
		actorType: e.actorType as AuditActorType,
		action: e.action,
		resourceType: e.resourceType,
		resourceId: e.resourceId,
		metadata: e.metadata,
		ipAddress: e.ipAddress,
		userAgent: e.userAgent,
		timestamp: e.timestamp.toISOString(),
	};
}

export type AuditEventOutput = ReturnType<typeof toAuditEventOutput>;
