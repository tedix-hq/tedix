import assert from "node:assert/strict";
import { tool } from "ai";
import { z } from "zod";
import { MCP_FACET_TURN_INPUT, mcpFacetTurnProbe } from "../test/tedi-do";
import { supervisedDelegationToolSet } from "./delegation-authority";
import { selectRepositoryToolSurface } from "./runtime-tool-guidance";

const offered = {
	tedix_mcp_code: tool({
		inputSchema: z.object({}),
		execute: async () => "source",
	}),
	browser_markdown: tool({
		inputSchema: z.object({}),
		execute: async () => "page",
	}),
	read: tool({ inputSchema: z.object({}), execute: async () => "file" }),
	exec: tool({ inputSchema: z.object({}), execute: async () => "shell" }),
	delete: tool({ inputSchema: z.object({}), execute: async () => "deleted" }),
};
const agent = mcpFacetTurnProbe({
	fields: {
		// Select the injected child gateway without constructing a remote client.
		state: { slug: "reader", systemPrompt: "SYSTEM" },
		workspaceAiTools: () => offered,
	},
});
const input = {
	...MCP_FACET_TURN_INPUT,
	workItemId: "work-1",
	homeRunId: "home-1",
	executionSurface: "native",
	repositoryMode: "research",
	toolsOnly: true,
};
const prepared = await agent.prepareMcpFacetTurn(input);
assert.deepEqual(
	Object.keys(prepared.tools),
	Object.keys(
		supervisedDelegationToolSet(
			selectRepositoryToolSurface(offered, "research"),
			true,
		),
	),
);
assert.ok(prepared.tools.tedix_mcp_code);
await assert.rejects(
	mcpFacetTurnProbe({
		mcpRuntime: { ensureSynced: async () => {}, executeTool: async () => [] },
		fields: { state: { slug: "reader" } },
	}).prepareMcpFacetTurn({
		...input,
		capabilityPlan: {
			version: "delegation-capabilities.v1",
			requiredCapabilities: ["source.read"],
			allowedToolIds: ["source.read"],
			missingCapabilities: [],
			urls: [],
			outputIds: [],
		},
	}),
	/Delegation preflight failed: source.read is unavailable or unauthorized/,
);

// Direct personal requests cannot reuse or overwrite a concurrent scheduled
// turn's MCP binding. A cold request failure must not borrow that shared client.
let sharedClientLookups = 0;
const requestIsolation = mcpFacetTurnProbe({
	fields: {
		async getMcpRuntime() {
			sharedClientLookups++;
			return null;
		},
	},
});
await requestIsolation.prepareMcpFacetTurn({
	...MCP_FACET_TURN_INPUT,
	toolsOnly: true,
});
assert.equal(sharedClientLookups, 1);
await requestIsolation.prepareMcpFacetTurn({
	...MCP_FACET_TURN_INPUT,
	personalRequest: true,
	toolsOnly: true,
});
assert.equal(
	sharedClientLookups,
	1,
	"personal request must not use the scheduled MCP client",
);

const personalReadGuidance = /google_gmail_tedix\.search_threads/;
for (const request of [
	{ personalRequest: true },
	{ homeRunId: "home-1", workItemId: "work-1" },
]) {
	const turn = await agent.prepareMcpFacetTurn({
		...MCP_FACET_TURN_INPUT,
		...request,
	});
	assert.match(turn.system, personalReadGuidance);
	assert.match(turn.system, /google_calendar_tedix\.list_events/);
	assert.match(turn.system, /gateway verifies the requester and account owner/);
}
const background = await agent.prepareMcpFacetTurn(MCP_FACET_TURN_INPUT);
assert.doesNotMatch(background.system, personalReadGuidance);
