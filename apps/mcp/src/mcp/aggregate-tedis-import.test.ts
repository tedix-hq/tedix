import { describe, expect, it, vi } from "vite-plus/test";
import { normalizeSearchTerms, scoreCatalogSearch } from "./codemode-discovery";

vi.mock("@tedix/api-contract/utils/tool-json-schema", () => ({
	zodToToolInputJsonSchema: () => {
		throw new Error("Dynamic import exceeded memory limits.");
	},
	zodToStructuredOutputJsonSchema: () => {
		throw new Error("Dynamic import exceeded memory limits.");
	},
}));

describe("aggregate tedi discovery import", () => {
	it.each([
		"workspace chat",
		"workspace send turn",
		"ask workspace agent",
		"workspace chat turn send cancel",
		"list workspaces",
		"workspace turn",
	])(
		"searches %s without projecting contracts in the request isolate",
		async (query) => {
			// The reported rays failed while importing aggregate-tedis, after the
			// source-app catalog was already resident. Reject that allocation path.
			const { buildAggregateTediTools } = await import("./aggregate-tedis");
			const tools = buildAggregateTediTools(
				[{ slug: "fixture", namespace: "fixture", tediId: "fixture-id" }],
				{ MCP_URL: "https://mcp.example.test" } as CloudflareEnv,
			);
			expect(tools.length).toBeGreaterThan(100);
			expect(
				tools.find((tool) => tool.toolId === "fixture__run_tedi_turn"),
			).toBeDefined();
			expect(tools.every((tool) => tool.inputSchema.type === "object")).toBe(
				true,
			);
			const terms = normalizeSearchTerms(query);
			const matches = tools.filter((tool) =>
				scoreCatalogSearch(terms, "fixture", tool.toolId, {
					callable: `fixture.${tool.toolId}`,
					namespace: "fixture",
					tool: tool.toolId,
					name: tool.title ?? tool.toolId,
					displayName: tool.title ?? tool.toolId,
					description: tool.description ?? "",
					parameters: tool.inputSchema,
				}),
			);
			expect(matches.length).toBeGreaterThan(0);
		},
	);
});
