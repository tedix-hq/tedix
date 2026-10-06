import assert from "node:assert/strict";
import { resolveEmbeddedToolSchemas } from "./embedded-tool-schemas";

const schema = {
	type: "object",
	properties: { id: { type: "integer" } },
	required: ["id"],
};
let code = "";
const rows = await resolveEmbeddedToolSchemas(
	["inventory.get_item", "inventory.get_item", "invalid();"],
	async (program) => {
		code = program;
		return [
			{
				callable: "inventory.get_item",
				parameters: schema,
				description: "unrelated",
			},
			{ callable: "other.get_item", parameters: schema },
			null,
			{ callable: "inventory.get_item" },
		];
	},
);
assert.deepEqual(
	rows.schemas.map((row) => JSON.parse(row)),
	[{ callable: "inventory.get_item", parameters: schema }],
);
// "inventory.get_item" resolved; nothing else in `selected` was admitted, and
// the row without parameters must not be reported as resolved.
assert.deepEqual(rows.missing, []);
assert.match(code, /discover.describe\(callable\)/);
assert.doesNotMatch(code, /discover.search|invalid|other/);
assert.deepEqual(
	await resolveEmbeddedToolSchemas([], async () => {
		throw new Error("must not discover");
	}),
	{ schemas: [], missing: [] },
);
// A truncated read resolves nothing, and every admitted callable is reported
// missing so the caller neither caches the gap nor advertises the tools.
assert.deepEqual(
	await resolveEmbeddedToolSchemas(["inventory.get_item"], async () => ({
		__tedix_truncated: true,
	})),
	{ schemas: [], missing: ["inventory.get_item"] },
);
// A callable the gateway never mounted describes as null: reported, not dropped.
assert.deepEqual(
	await resolveEmbeddedToolSchemas(
		["inventory.get_item", "inventory.search_items"],
		async () => [{ callable: "inventory.get_item", parameters: schema }],
	),
	{
		schemas: [
			JSON.stringify({ callable: "inventory.get_item", parameters: schema }),
		],
		missing: ["inventory.search_items"],
	},
);
console.log("embedded exact tool schemas passed");

// Exercise the actual MCP runtime unwrapping path, not a resolver-only array mock.
const { TedixMcpRuntime } = await import("@tedix/mcp-client-core/runtime");
const runtime = new TedixMcpRuntime({
	manager: {
		listConnections: () => [{ serverId: "tedix-unified" }],
		listTools: () => [{ name: "code" }],
		callTool: async () => ({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						executionId: "metadata-read",
						result: [{ callable: "inventory.get_item", parameters: schema }],
					}),
				},
			],
		}),
	} as never,
	platform: {
		listServers: async () => [],
		resolveCredentials: async () => ({ headers: {} }),
		recordToolEvent: async () => {},
	},
});
runtime.ensureSynced = async () => {};
assert.deepEqual(
	await resolveEmbeddedToolSchemas(["inventory.get_item"], (program) =>
		runtime.executeTool("tedix_mcp_code", { code: program }),
	),
	{
		schemas: [
			JSON.stringify({ callable: "inventory.get_item", parameters: schema }),
		],
		missing: [],
	},
);
