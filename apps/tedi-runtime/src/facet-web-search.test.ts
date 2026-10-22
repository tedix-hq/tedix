import assert from "node:assert/strict";
import type { Tool } from "ai";
import type { DelegationCapabilityPlan } from "@tedix/api-contract/schemas/kernel-runtime";
import type { WebSearchInput } from "@tedix/api-contract/schemas/web-search";
import { MCP_FACET_TURN_INPUT, mcpFacetTurnProbe } from "../test/tedi-do";

// A Home-delegated turn whose capability plan names web_search must receive
// the tool, under the same organization / tedi / runtime-tool gating as a
// parent turn.

const plan: DelegationCapabilityPlan = {
	version: "delegation-capabilities.v1",
	requiredCapabilities: ["web.search"],
	allowedToolIds: ["web_search", "browser_markdown", "browser_read_result"],
	urls: [],
	outputIds: [],
	missingCapabilities: [],
};
const delegated = {
	...MCP_FACET_TURN_INPUT,
	runId: "run-acme-search",
	workItemId: "3f1c2a1e-0000-4000-8000-000000000001",
	homeRunId: "home-1",
	capabilityPlan: plan,
};

const searches: WebSearchInput[] = [];
const pages: string[] = [];
const platform = {
	searchWeb: async (input: WebSearchInput) => {
		searches.push(input);
		return {
			status: "ok" as const,
			query: input.query,
			trust: "untrusted" as const,
			results: [
				{
					title: "Release notes",
					url: "https://example.com/releases",
					description: null,
					lastModified: null,
				},
			],
			citations: ["[1. example.com](https://example.com/releases)"],
			truncated: false,
		};
	},
	recordRuntimeEvent: async () => {},
	setEpisodeTrace: () => {},
};
const browserTool = (name: string) => ({
	inputSchema: {},
	execute: async (args: { url?: string }) => {
		pages.push(`${name}:${args.url ?? ""}`);
		return "page";
	},
});

function probe(state: Record<string, unknown>) {
	return mcpFacetTurnProbe({
		platform,
		fields: {
			env: { AI: { websearch: async () => new Response("{}") } },
			state: {
				tediId: "tedi-1",
				orgId: "org-acme",
				slug: "acme",
				systemPrompt: "SYSTEM",
				...state,
			},
			eventOutbox: { publish: async () => {} },
			browserAiTools: () => ({
				browser_markdown: browserTool("browser_markdown"),
				browser_read_result: browserTool("browser_read_result"),
			}),
		},
	});
}

const enabled = { organizationWebSearch: { enabled: true, maxResults: 5 } };

{
	const setup = await probe({ ...enabled, toolPolicy: {} }).prepareMcpFacetTurn(
		delegated,
	);
	assert.deepEqual(Object.keys(setup.tools).sort(), [
		"browser_markdown",
		"browser_read_result",
		"web_search",
	]);
	const options = { toolCallId: "call-1", messages: [], context: undefined };
	const tools = setup.tools as Record<string, Tool<Record<string, unknown>>>;
	await tools.web_search!.execute!({ query: "latest bun version" }, options);
	assert.deepEqual(searches, [
		{ query: "latest bun version", runId: "run-acme-search" },
	]);
	// A page the search returned may be read; any other page stays outside the plan.
	await tools.browser_markdown!.execute!(
		{ url: "https://example.com/releases" },
		{ ...options, toolCallId: "call-2" },
	);
	assert.deepEqual(pages, ["browser_markdown:https://example.com/releases"]);
	await assert.rejects(
		async () =>
			tools.browser_markdown!.execute!(
				{ url: "https://other.example/private" },
				{ ...options, toolCallId: "call-3" },
			),
		/outside the delegated request; read only a URL web_search returned/,
	);
}

// Supervised delegations without a capability plan keep web search too.
{
	const setup = await probe({ ...enabled, toolPolicy: {} }).prepareMcpFacetTurn(
		{ ...delegated, capabilityPlan: undefined },
	);
	assert.ok("web_search" in setup.tools);
}

// Existing gating still applies: org off, tedi opt-out, runtime-tool ceiling.
for (const state of [
	{ toolPolicy: {} },
	{ organizationWebSearch: { enabled: false }, toolPolicy: {} },
	{ ...enabled, toolPolicy: { webSearch: "off" } },
	{ ...enabled, toolPolicy: { runtimeTools: ["browser_markdown"] } },
]) {
	const setup = await probe(state).prepareMcpFacetTurn({
		...delegated,
		capabilityPlan: undefined,
	});
	assert.equal("web_search" in setup.tools, false);
	await assert.rejects(
		probe(state).prepareMcpFacetTurn(delegated),
		/capability tool unavailable: web_search/,
	);
}

console.log("facet-web-search.test.ts: delegated web search wiring passed");
