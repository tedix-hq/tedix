import { parseToolPolicyMetadata } from "@tedix/api-contract/schemas/tools";
import { resolveContractEndpoint } from "@tedix/api-contract/utils/contract-routers";
import { expect, it } from "vite-plus/test";
import { buildProjectedTool } from "./tool-schema-projection";

it("projects the gateway change record read as one read-only gateway tool", async () => {
	const endpoint = resolveContractEndpoint("audit/listGatewayChangeRecords");
	if (!endpoint) throw new Error("Missing change record contract endpoint");
	const { tool } = await buildProjectedTool("fixture-app", endpoint);
	expect(tool.toolId).toBe("list_gateway_change_records");
	expect(tool.writeCapability).toBe("read");
	expect(parseToolPolicyMetadata(tool.meta)).toMatchObject({
		riskTier: "read",
		blastRadius: "none",
	});
	expect(tool.config?.transport).toBe("rpc");
	expect(
		Object.keys(
			(tool.inputSchema as { properties: Record<string, unknown> }).properties,
		).sort(),
	).toEqual(["actorId", "afterSequence", "from", "limit", "resource", "until"]);
});
