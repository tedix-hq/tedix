import { parseToolPolicyMetadata } from "@tedix/api-contract/schemas/tools";
import { resolveContractEndpoint } from "@tedix/api-contract/utils/contract-routers";
import { expect, it } from "vite-plus/test";
import {
	OS_TOOL_ID_OVERRIDES,
	OS_KIND_OVERRIDES,
} from "./tool-schema-overrides";
import { buildProjectedTool } from "./tool-schema-projection";

it("projects the workspace change record export as one read-only gateway tool", async () => {
	const endpoint = resolveContractEndpoint(
		"osWorkspaces/workspaces/changeRecords",
	);
	if (!endpoint) throw new Error("Missing change record contract endpoint");
	const { tool } = await buildProjectedTool(
		"fixture-app",
		endpoint,
		undefined,
		{ toolIdOverrides: OS_TOOL_ID_OVERRIDES, kindOverrides: OS_KIND_OVERRIDES },
	);
	expect(tool.toolId).toBe("list_os_workspace_change_records");
	expect(tool.writeCapability).toBe("read");
	expect(parseToolPolicyMetadata(tool.meta)).toMatchObject({
		riskTier: "read",
		blastRadius: "none",
	});
	expect(tool.config?.transport).toBe("rpc");
});
