import { describe, expect, test } from "vite-plus/test";
import { DIRECTORY_MCP_SURFACE } from "./directory-mcp-surface";

const expectedTools = [
	"get_profile",
	"get_connection_info",
	"list_work_items",
	"get_work_item",
	"list_work_item_events",
	"list_work_item_evidence",
	"list_workspaces",
	"get_workspace_output",
	"show_deck",
	"show_feed",
	"add_work_item_comment",
	"create_work_item",
];

describe("directory MCP surface", () => {
	test("pins the reviewed standard-mode tool surface", () => {
		expect(DIRECTORY_MCP_SURFACE.app.mcpConfig.codeMode).toBe(false);
		expect(DIRECTORY_MCP_SURFACE.tools.map((tool) => tool.toolId)).toEqual(
			expectedTools,
		);
		expect(new Set(expectedTools).size).toBe(expectedTools.length);
		expect(
			DIRECTORY_MCP_SURFACE.tools.every(
				(tool) => tool.inputSchema.additionalProperties === false,
			),
		).toBe(true);
	});

	test("declares annotations and only the three directory scopes", () => {
		for (const tool of DIRECTORY_MCP_SURFACE.tools) {
			expect(tool.annotations.destructiveHint).toBe(false);
			expect(tool.annotations.openWorldHint).toBe(false);
			expect(tool.annotations.readOnlyHint).toBe(
				tool.writeCapability === "read",
			);
		}
		expect(
			new Set(
				Object.values(DIRECTORY_MCP_SURFACE.app.mcpConfig.toolScopes).flat(),
			),
		).toEqual(new Set(["mcp:content.read", "mcp:work.read", "mcp:work.write"]));
	});

	test("keeps the connection response narrow", () => {
		const config = DIRECTORY_MCP_SURFACE.app.mcpConfig.bootstrapInfo;
		expect(config).toMatchObject({
			toolId: "get_connection_info",
			title: "Tedix connection details",
			responseMode: "connection",
		});
		expect(config.description).not.toMatch(
			/accountId|commerce|fastPath|checkout|cart|wishlist|compare|map/,
		);
	});
});
