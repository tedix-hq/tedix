import { describe, expect, it, vi } from "vite-plus/test";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	requireDestructiveToolApproval,
	callToolResultText,
} from "./governance";
import type { ServerContext } from "./server-context";

function context() {
	return {
		server: { server: { elicitInput: vi.fn() } },
		callerIdentity: { authType: "tedi", tediId: "tedi" },
		appSlug: "work",
		app: { organizationId: "org" },
		apiClient: {
			mcpGovernance: {
				resolveAgentTransportPolicy: vi.fn(async () => ({
					requireExplicitApprovalPolicy: false,
					autonomy: { version: 1, maxRisk: "medium" },
				})),
				resolveToolApprovalGrant: vi.fn(async () => ({
					approved: false,
					grantId: null,
				})),
			},
		},
	} as unknown as Pick<ServerContext, "server">;
}
describe("tedi autonomous actions", () => {
	it.each([true, false])(
		"auto-resolves bounded writes with Code Mode auto-confirm=%s",
		async (autoConfirmAgent) => {
			const result = await requireDestructiveToolApproval(
				context(),
				{
					toolId: "add_comment",
					title: "Add comment",
					config: { transport: "rpc", approvalPolicy: "always" },
					meta: {
						"com.tedix/policy": {
							riskTier: "bounded_write",
							blastRadius: "single_resource",
						},
					},
				},
				{ destructiveHint: true },
				{ autoConfirmAgent },
			);
			expect(result).toBeNull();
		},
	);
	it.each([
		"send_email",
		"publish_content",
		"delete_records",
		"grant_role",
		"increase_budget",
		"oauth_consent",
	])(
		"never self-confirms critical %s even with a low/medium declaration or confirmDestructive",
		async (toolId) => {
			const result = await requireDestructiveToolApproval(
				context(),
				{
					toolId,
					title: "Critical action",
					config: { transport: "rpc" },
					meta: {
						"com.tedix/policy": {
							riskTier: "bounded_write",
							blastRadius: "single_resource",
						},
					},
				},
				{ readOnlyHint: false, destructiveHint: false },
				{
					autoConfirmAgent: true,
					args: { confirmDestructive: true, reason: "agent says approved" },
				},
			);
			expect(result?.isError).toBe(true);
			expect(callToolResultText(result!)).toContain("Human approval required");
		},
	);
	it("retains human approval for high and unclassified writes", async () => {
		for (const meta of [
			{
				"com.tedix/policy": {
					riskTier: "high_impact_write",
					blastRadius: "tenant",
				},
			},
			{},
		] as Array<Record<string, JsonValue>>) {
			const result = await requireDestructiveToolApproval(
				context(),
				{
					toolId: "run_operation",
					title: "Run operation",
					config: { transport: "rpc" },
					meta,
				},
				{ destructiveHint: true },
				{ autoConfirmAgent: true },
			);
			expect(result?.isError).toBe(true);
		}
	});
});
