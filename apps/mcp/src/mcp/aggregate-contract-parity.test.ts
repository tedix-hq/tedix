import { resolveContractEndpoint } from "@tedix/api-contract/utils/contract-routers";
import { describe, expect, it } from "vite-plus/test";
import { buildAggregateTediTools } from "./aggregate-tedis";
import { buildHomeSurfaceTools } from "./home-surface";

// API's contract-parity test separately proves every resolved contract is served.
describe("native MCP RPC endpoint parity", () => {
	it("maps every Home and aggregate RPC tool to a contract procedure", () => {
		const tools = [
			...buildHomeSurfaceTools(),
			...buildAggregateTediTools(
				[
					{
						slug: "cedar",
						tediId: "10000000-0000-4000-8000-000000000001",
						organizationId: "20000000-0000-4000-8000-000000000001",
						runtimeKind: "agent",
					},
					{
						slug: "birch",
						tediId: "10000000-0000-4000-8000-000000000002",
						organizationId: "20000000-0000-4000-8000-000000000001",
						surface: "collaboration",
					},
				],
				{ MCP_URL: "https://mcp.example.test" } as CloudflareEnv,
			),
		];
		const rpcTools = tools.filter((tool) => tool.config?.transport === "rpc");
		expect(rpcTools.length).toBeGreaterThan(0);
		const missing = rpcTools.flatMap((tool) => {
			const endpoint = tool.config?.endpoint;
			return typeof endpoint === "string" && resolveContractEndpoint(endpoint)
				? []
				: [`${tool.toolId} -> ${String(endpoint)}`];
		});
		expect(missing).toEqual([]);
	});
});
