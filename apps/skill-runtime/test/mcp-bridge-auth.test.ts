import assert from "node:assert/strict";
import { mock, test } from "bun:test";
import type { CapabilityManifest } from "@tedix/api-contract/utils/skill-manifest";

mock.module("cloudflare:workers", () => ({
	WorkerEntrypoint: class {},
}));

const { callMcpTool, CapabilityNotDeclaredError } =
	await import("../src/mcp-bridge");

const manifest: CapabilityManifest = {
	mcp: { notion_tedix: ["notion_search"] },
	network: false,
	rationale: { mode: "off" },
	expectedAnnotations: { destructive: false, readOnly: true },
	grounding: { required: false, minCausalScore: 1, enforce: "warn" },
	schedule: null,
	reliability: null,
	reason: { enabled: false, maxCalls: null },
};

const requests: Request[] = [];
const env = {
	MCP_SERVICE: {
		fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
			requests.push(new Request(input, init));
			return new Response(
				JSON.stringify({
					jsonrpc: "2.0",
					id: "call-1",
					result: { content: [{ type: "text", text: '{"ok":true}' }] },
				}),
				{ headers: { "Content-Type": "application/json" } },
			);
		},
	},
} as unknown as Parameters<typeof callMcpTool>[0];
const props: Parameters<typeof callMcpTool>[1] = {
	manifest,
	tediId: "tedi-1",
	aggregateMcpSlug: "tedix-unified",
	orgId: "org-1",
	skillId: "skill-1",
	runId: "run-1",
	executionEpoch: 0,
	namespaceToSlug: { notion_tedix: "notion-tedix" },
	mcpBaseHost: "mcp.tedix.dev",
	serviceToken: "test-service-token",
};
const workflow = {
	stepName: "discover",
	stepCount: 1,
	stepType: "do" as const,
	attempt: 1,
	phase: "run" as const,
	ordinal: 1,
};

test("admitted workflow delegates only the provider scope and rejects undeclared tools", async () => {
	await callMcpTool(env, props, {
		namespace: "notion_tedix",
		method: "notion_search",
		args: { query: "example" },
		workflow,
	});

	assert.equal(requests.length, 1);
	const headers = requests[0]!.headers;
	assert.equal(headers.get("X-Service-Binding"), "true");
	assert.equal(headers.get("X-Tedix-Tedi-Id"), "tedi-1");
	assert.equal(headers.get("X-Tedix-Tedi-Scopes"), "connections.execute");
	assert.equal(headers.get("X-Tedix-Org-Id"), "org-1");
	assert.equal(headers.get("Mcp-Name"), "notion_search");

	await assert.rejects(
		callMcpTool(env, props, {
			namespace: "notion_tedix",
			method: "notion_delete_page",
			args: { pageId: "page-1" },
			workflow,
		}),
		CapabilityNotDeclaredError,
	);
	assert.equal(requests.length, 1);
});
