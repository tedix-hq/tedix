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

test("typed credential miss crosses RPC and continuation pins the selected account", async () => {
	const recovery = {
		providerId: "notion",
		connectionInstanceId: "11111111-1111-4111-8111-111111111111",
		scope: "user" as const,
		scopes: ["read"],
	};
	let body: any;
	const missingEnv = {
		MCP_SERVICE: {
			fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
				body = await new Request(input, init).json();
				return Response.json({
					jsonrpc: "2.0",
					id: "1",
					result: {
						isError: true,
						_meta: { "tedix/connectionRecovery": recovery },
						content: [{ type: "text", text: "missing" }],
					},
				});
			},
		},
	} as unknown as Parameters<typeof callMcpTool>[0];
	assert.deepEqual(
		await callMcpTool(missingEnv, props, {
			namespace: "notion_tedix",
			method: "notion_search",
			args: {},
			workflow,
			connectionBinding: recovery,
		}),
		{ __tedixConnectionRequired: true, recovery },
	);
	assert.deepEqual(body.params._meta["tedix/expectedConnection"], recovery);
	const normal = await callMcpTool(env, props, {
		namespace: "notion_tedix",
		method: "notion_search",
		args: {},
		workflow,
	});
	assert.deepEqual(normal, { __tedixMcpResult: true, value: { ok: true } });
});
