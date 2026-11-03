import { resolveContractEndpoint } from "@tedix/api-contract/utils/contract-routers";
import { describe, expect, it } from "vite-plus/test";
import {
	WORK_HIERARCHY_KIND_OVERRIDES,
	WORK_HIERARCHY_TOOL_ID_OVERRIDES,
} from "./tool-schema-overrides";
import { buildProjectedTool } from "./tool-schema-projection";

describe("repository candidate native tool projection", () => {
	it.each([
		[
			"initializeRepositoryCandidate",
			"initialize_repository_candidate",
			"write",
		],
		["readRepositoryCandidate", "read_repository_candidate", "read"],
		["submitRepositoryCandidate", "submit_repository_candidate", "write"],
		["sealRepositoryCandidate", "seal_repository_candidate", "write"],
		["applyRepositoryCandidate", "apply_repository_candidate", "write"],
		["reconcileRepositoryCandidate", "reconcile_repository_candidate", "write"],
	] as const)(
		"projects %s without inferring publication authority",
		async (operation, name, kind) => {
			const endpoint = resolveContractEndpoint(`workItems/${operation}`);
			if (!endpoint) throw new Error("Missing repository candidate endpoint");
			const { tool } = await buildProjectedTool(
				"fixture-app",
				endpoint,
				undefined,
				{
					kindOverrides: WORK_HIERARCHY_KIND_OVERRIDES,
					toolIdOverrides: WORK_HIERARCHY_TOOL_ID_OVERRIDES,
				},
			);
			expect(tool.toolId).toBe(name);
			expect(tool.writeCapability).toBe(kind);
			expect(tool.config?.transport).toBe("rpc");
		},
	);
});
