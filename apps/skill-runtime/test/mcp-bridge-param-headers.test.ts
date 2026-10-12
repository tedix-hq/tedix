import assert from "node:assert/strict";
import { mock, test } from "bun:test";
import type { CapabilityManifest } from "@tedix/api-contract/utils/skill-manifest";

mock.module("cloudflare:workers", () => ({
	WorkerEntrypoint: class {},
}));

const { callMcpTool } = await import("../src/mcp-bridge");

const manifest: CapabilityManifest = {
	mcp: { code_host: ["get_commit"] },
	network: false,
	rationale: { mode: "off" },
	expectedAnnotations: { destructive: false, readOnly: true },
	grounding: { required: false, minCausalScore: 1, enforce: "warn" },
	schedule: null,
	reliability: null,
	reason: { enabled: false, maxCalls: null },
};

const props: Parameters<typeof callMcpTool>[1] = {
	manifest,
	tediId: "tedi-1",
	aggregateMcpSlug: "acme-unified",
	orgId: "org-1",
	skillId: "skill-1",
	runId: "run-1",
	executionEpoch: 0,
	namespaceToSlug: { code_host: "code-host" },
	mcpBaseHost: "mcp.example.test",
	serviceToken: "test-service-token",
};
const workflow = {
	stepName: "check",
	stepCount: 1,
	stepType: "do" as const,
	attempt: 1,
	phase: "run" as const,
	ordinal: 1,
};
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

test("resends a header-bound call with Mcp-Param headers from the tool schema", async () => {
	const calls: Array<{ method: string; owner: string | null }> = [];
	const env = {
		MCP_SERVICE: {
			fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
				const request = new Request(input, init);
				const body = (await request.json()) as { id: string; method: string };
				const owner = request.headers.get("Mcp-Param-owner");
				calls.push({ method: body.method, owner });
				if (body.method === "tools/list")
					return json({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							tools: [
								{
									name: "get_commit",
									inputSchema: {
										type: "object",
										properties: {
											owner: { type: "string", "x-mcp-header": "owner" },
											sha: { type: "string" },
										},
									},
								},
							],
						},
					});
				if (!owner)
					return json(
						{
							jsonrpc: "2.0",
							id: body.id,
							error: {
								code: -32020,
								message:
									"Bad Request: the request headers and body disagree: owner",
							},
						},
						400,
					);
				return json({
					jsonrpc: "2.0",
					id: body.id,
					result: { content: [{ type: "text", text: '{"sha":"abc"}' }] },
				});
			},
		},
	} as unknown as Parameters<typeof callMcpTool>[0];

	const first = await callMcpTool(env, props, {
		namespace: "code_host",
		method: "get_commit",
		args: { owner: "example-org", sha: "abc" },
		workflow,
	});
	assert.deepEqual(first, { __tedixMcpResult: true, value: { sha: "abc" } });
	assert.deepEqual(calls, [
		{ method: "tools/call", owner: null },
		{ method: "tools/list", owner: null },
		{ method: "tools/call", owner: "example-org" },
	]);

	// The learned schema is reused: the next call sends the header first.
	calls.length = 0;
	await callMcpTool(env, props, {
		namespace: "code_host",
		method: "get_commit",
		args: { owner: "other-org", sha: "def" },
		workflow: { ...workflow, ordinal: 2 },
	});
	assert.deepEqual(calls, [{ method: "tools/call", owner: "other-org" }]);
});
