import { parseToolPolicyMetadata } from "@tedix/api-contract/schemas/tools";
import { resolveContractEndpoint } from "@tedix/api-contract/utils/contract-routers";
import { describe, expect, it } from "vite-plus/test";
import { SKILL_WORKFLOW_KIND_OVERRIDES } from "./tool-schema-overrides";
import { buildProjectedTool } from "./tool-schema-projection";

describe("workspace draft tool risk projection", () => {
	it.each([
		["getWorkspaceDraftGrant", "read", "read", "none"],
		["getWorkspaceDraftProposal", "read", "read", "none"],
		["listWorkspaceDraftProposals", "read", "read", "none"],
		["proposeWorkspaceRevision", "write", "bounded_write", "single_resource"],
		[
			"withdrawWorkspaceDraftProposal",
			"write",
			"bounded_write",
			"single_resource",
		],
		["setWorkspaceDraftGrant", "destructive", "high_impact_write", "tenant"],
	] as const)(
		"keeps %s in its own operational policy tier",
		async (operation, capability, riskTier, blastRadius) => {
			const endpoint = resolveContractEndpoint(`skills/${operation}`);
			if (!endpoint) throw new Error("Missing draft contract endpoint");
			const { tool } = await buildProjectedTool(
				"fixture-app",
				endpoint,
				undefined,
				{ kindOverrides: SKILL_WORKFLOW_KIND_OVERRIDES },
			);
			expect(tool.writeCapability).toBe(capability);
			expect(parseToolPolicyMetadata(tool.meta)).toMatchObject({
				riskTier,
				blastRadius,
			});
			expect(tool.config?.transport).toBe("rpc");
		},
	);
});
