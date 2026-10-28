import { ORPCError, ValidationError } from "@orpc/server";
import { connectionsContract } from "@tedix/api-contract/contracts/connections";
import { mcpGovernanceContract } from "@tedix/api-contract/contracts/mcp-governance";
import { procedureInputSchema } from "@tedix/api-contract/utils/procedure-schemas";
import type { DbClient } from "@tedix/db/client";
import { describe, expect, it, vi } from "vite-plus/test";
import type { ZodType } from "zod";
import type { BaseContext } from "./context";
import { auditGatewayInputRejection } from "./gateway-input-validation";
import { enrichInputValidationError } from "./input-validation-error";

const mocks = vi.hoisted(() => ({
	emitAuditEvent: vi.fn(),
}));

vi.mock("./audit-helpers", () => ({
	emitAuditEvent: mocks.emitAuditEvent,
}));

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";

function context(): BaseContext {
	return {
		db: {} as DbClient,
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers({ "X-Tedix-Org-Id": ORGANIZATION_ID }),
		rateLimiter: {} as RateLimit,
		serviceBindingPrincipal: "mcp-edge",
		url: new URL("https://api/rpc"),
	} as BaseContext;
}

const coveredRoutes = [
	{
		name: "connections.fetchTediToken",
		path: ["connections", "fetchTediToken"],
		procedure: connectionsContract.fetchTediToken,
	},
	{
		name: "connections.fetchOrgToken",
		path: ["connections", "fetchOrgToken"],
		procedure: connectionsContract.fetchOrgToken,
	},
	{
		name: "mcpGovernance.resolveToolApprovalGrant",
		path: ["mcpGovernance", "resolveToolApprovalGrant"],
		procedure: mcpGovernanceContract.resolveToolApprovalGrant,
	},
	{
		name: "mcpGovernance.requestOwnerToolApproval",
		path: ["mcpGovernance", "requestOwnerToolApproval"],
		procedure: mcpGovernanceContract.requestOwnerToolApproval,
	},
	{
		name: "mcpGovernance.resolveHomeToolApproval",
		path: ["mcpGovernance", "resolveHomeToolApproval"],
		procedure: mcpGovernanceContract.resolveHomeToolApproval,
	},
] as const;

describe("MCP gateway contract validation", () => {
	it.each(coveredRoutes)(
		"rejects and audits malformed $name input",
		async ({ name, path, procedure }) => {
			mocks.emitAuditEvent.mockClear();
			const result = (procedureInputSchema(procedure) as ZodType).safeParse({});
			expect(result.success).toBe(false);
			if (result.success)
				throw new Error("Expected contract validation to fail");

			const error = enrichInputValidationError(
				new ORPCError("BAD_REQUEST", {
					message: "Input validation failed",
					cause: new ValidationError({
						message: "Input validation failed",
						issues: result.error.issues,
					}),
				}),
			);
			expect(error).toBeInstanceOf(ORPCError);
			expect((error as ORPCError<string, unknown>).message).toMatch(
				/^Input validation failed: /,
			);
			await auditGatewayInputRejection(context(), path, error);

			expect(mocks.emitAuditEvent).toHaveBeenCalledWith(expect.anything(), {
				organizationId: ORGANIZATION_ID,
				actorId: "mcp-edge",
				actorType: "service",
				action: "gateway.input_rejected",
				resourceType: "api_procedure",
				resourceId: name,
				metadata: {
					reason: "contract_validation_failed",
					transport: "service_binding",
				},
			});
		},
	);
});
