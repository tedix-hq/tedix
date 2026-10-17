import assert from "node:assert/strict";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { configuredRuntimeTools } from "./configured-tool-surface";
const stub = tool({ inputSchema: z.object({}), execute: async () => "ok" });
const tools: ToolSet = {
	tedix_mcp_code: stub,
	read_skill: stub,
	bash: stub,
	deploy: stub,
	browser: stub,
	email_send: stub,
};
assert.deepEqual(
	Object.keys(
		configuredRuntimeTools(tools, ["tedix_mcp_code", "read_skill"]),
	).sort(),
	["read_skill", "tedix_mcp_code"],
);
assert.deepEqual(configuredRuntimeTools(tools, []), {});
assert.equal(configuredRuntimeTools(tools, undefined), tools);
assert.deepEqual(configuredRuntimeTools(tools, ["unknown"]), {});
console.log("configured tool ceiling passed");
