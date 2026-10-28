import { ORPCError, ValidationError } from "@orpc/server";
import { emitAuditEvent } from "./audit-helpers";
import type { BaseContext } from "./context";

const AUDITED_MCP_GATEWAY_ROUTES = new Set([
	"connections.fetchTediToken",
	"connections.fetchOrgToken",
	"mcpGovernance.resolveToolApprovalGrant",
	"mcpGovernance.requestOwnerToolApproval",
	"mcpGovernance.resolveHomeToolApproval",
]);

export async function auditGatewayInputRejection(
	context: BaseContext,
	path: readonly string[],
	error: unknown,
): Promise<void> {
	const procedure = path.join(".");
	if (
		context.serviceBindingPrincipal !== "mcp-edge" ||
		!AUDITED_MCP_GATEWAY_ROUTES.has(procedure) ||
		!(error instanceof ORPCError) ||
		error.code !== "BAD_REQUEST" ||
		!(error.cause instanceof ValidationError)
	) {
		return;
	}

	const organizationId = context.headers.get("X-Tedix-Org-Id")?.trim();
	if (!organizationId) return;

	try {
		await emitAuditEvent(context.db, {
			organizationId,
			actorId: "mcp-edge",
			actorType: "service",
			action: "gateway.input_rejected",
			resourceType: "api_procedure",
			resourceId: procedure,
			metadata: {
				reason: "contract_validation_failed",
				transport: "service_binding",
			},
		});
	} catch {
		// The malformed request remains rejected even if audit storage is unavailable.
		console.error("[oRPC] Failed to audit rejected MCP gateway input", {
			procedure,
		});
	}
}
