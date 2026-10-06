import { describe, expect, it } from "vite-plus/test";
import {
	isMcpToolVisibleToCaller,
	resolveMcpToolRequiredScopes,
	type ToolAuthShape,
} from "./tool-scopes";

const operations = [
	["run_tedi_durable_code", "runTediDurableCode", "write"],
	["list_tedi_code_executions", "listTediCodeExecutions", "read"],
	["get_tedi_code_execution", "getTediCodeExecution", "read"],
	["approve_tedi_code_execution", "approveTediCodeExecution", "admin"],
	["reject_tedi_code_execution", "rejectTediCodeExecution", "admin"],
	["rollback_tedi_code_execution", "rollbackTediCodeExecution", "admin"],
	["recover_tedi_code_execution", "recoverTediCodeExecution", "admin"],
] as const;

describe("resource-bound durable worker scope gates", () => {
	it.each(operations)(
		"pins %s to its exact RPC tier",
		(name, endpoint, tier) => {
			const tool: ToolAuthShape = {
				toolId: `customer_unified__${name}`,
				toolTypeId: "rpc",
				config: { endpoint: `tedis/${endpoint}` },
				authRequired: true,
				visibility: "private",
			};
			const overrides = { toolScopes: { "*": ["mcp:tedis.read"] } };
			expect(
				resolveMcpToolRequiredScopes(tool, "customer_unified", overrides),
			).toEqual([`mcp:tedis.${tier}`]);
			expect(
				isMcpToolVisibleToCaller(tool, "customer_unified", overrides, {
					authType: "oauth",
					scopes: [`mcp:tedis.${tier}`],
				}),
			).toBe(true);
			expect(
				isMcpToolVisibleToCaller(tool, "customer_unified", overrides, {
					authType: "oauth",
					scopes: ["connections.execute"],
				}),
			).toBe(false);
			if (tier !== "read")
				expect(
					isMcpToolVisibleToCaller(tool, "customer_unified", overrides, {
						authType: "oauth",
						scopes: ["mcp:tedis.read"],
					}),
				).toBe(false);
		},
	);
	it.each(operations)(
		"rejects a forged RPC binding for %s before overrides",
		(name, endpoint) => {
			const overrides = { toolScopes: { "*": ["mcp:tedis.read"] } };
			for (const tool of [
				{ toolId: name, toolTypeId: "rpc", config: { endpoint: "tedis/get" } },
				{
					toolId: "list_unrelated",
					toolTypeId: "rpc",
					config: { endpoint: `tedis/${endpoint}` },
				},
				{
					toolId: name,
					toolTypeId: "mcp",
					config: { endpoint: `tedis/${endpoint}` },
				},
			])
				expect(() =>
					resolveMcpToolRequiredScopes(tool, "customer_unified", overrides),
				).toThrow("invalid durable worker RPC binding");
		},
	);
});
