import assert from "node:assert/strict";
import type { ToolSet } from "ai";
import { cronFacetToolSurface } from "./cron-tool-surface";

const code = { description: "code" };
const browser = { description: "browser" };
const workspace = { description: "workspace" };
const tools = {
	tedix_mcp_code: code,
	browser,
	workspace,
} as unknown as ToolSet;

const projected = cronFacetToolSurface(tools);
assert.deepEqual(Object.keys(projected), ["tedix_mcp_code"]);
assert.equal(projected.tedix_mcp_code, code);
assert.equal(
	tools.browser,
	browser,
	"projection must not mutate the full tool set",
);

assert.deepEqual(
	cronFacetToolSurface({ browser } as unknown as ToolSet),
	{},
	"a missing MCP runtime must fail closed to no cron tools",
);

console.log("cron-tool-surface OK");
