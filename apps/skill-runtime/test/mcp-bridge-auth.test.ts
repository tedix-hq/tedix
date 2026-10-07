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

test("a bare method on a single-app wrapper resolves to its prefixed wire name", async () => {
	const calls: Array<{ host: string; method: string; name?: string }> = [];
	const wrapperEnv = {
		MCP_SERVICE: {
			fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
				const request = new Request(input, init);
				const body = (await request.json()) as {
					id: string;
					method: string;
					params?: { name?: string };
				};
				calls.push({
					host: new URL(request.url).hostname,
					method: body.method,
					name: body.params?.name,
				});
				// The wrapper registers only its aggregated, prefixed tools. A
				// programmatic bare call materializes no tool, so the SDK server has
				// no tools/call handler at all and answers -32601.
				if (body.method === "tools/list") {
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							tools: [
								{ name: "planetscale__planetscale_execute_read_query" },
								{ name: "planetscale__planetscale_list_databases" },
							],
						},
					});
				}
				if (
					body.params?.name === "planetscale__planetscale_execute_read_query"
				) {
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result: { content: [{ type: "text", text: '{"rows":[]}' }] },
					});
				}
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					error: { code: -32601, message: "Method not found" },
				});
			},
		},
	} as unknown as Parameters<typeof callMcpTool>[0];

	const result = await callMcpTool(
		wrapperEnv,
		{
			...props,
			manifest: {
				...manifest,
				mcp: { planetscale_acme: ["planetscale_execute_read_query"] },
			},
			namespaceToSlug: { planetscale_acme: "planetscale-acme" },
		},
		{
			namespace: "planetscale_acme",
			method: "planetscale_execute_read_query",
			args: { query: "select 1" },
			workflow,
		},
	);

	assert.deepEqual(result, { __tedixMcpResult: true, value: { rows: [] } });
	assert.deepEqual(calls, [
		{
			host: "planetscale-acme.mcp.tedix.dev",
			method: "tools/call",
			name: "planetscale_execute_read_query",
		},
		{
			host: "planetscale-acme.mcp.tedix.dev",
			method: "tools/list",
			name: undefined,
		},
		{
			host: "planetscale-acme.mcp.tedix.dev",
			method: "tools/call",
			name: "planetscale__planetscale_execute_read_query",
		},
	]);
});

test("a mapped Code Mode app with no prefixed match still falls back to the aggregate", async () => {
	const calls: string[] = [];
	const codeModeEnv = {
		MCP_SERVICE: {
			fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
				const request = new Request(input, init);
				const body = (await request.json()) as {
					id: string;
					method: string;
					params?: { name?: string };
				};
				const host = new URL(request.url).hostname;
				calls.push(`${host} ${body.method} ${body.params?.name ?? ""}`);
				if (body.method === "tools/list") {
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result: { tools: [{ name: "code" }] },
					});
				}
				if (host.startsWith("tedix-unified.") && body.params?.name === "code") {
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							content: [
								{
									type: "text",
									text: '{"executionId":"e1","result":{"hits":1}}',
								},
							],
						},
					});
				}
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					error: { code: -32601, message: "Method not found" },
				});
			},
		},
	} as unknown as Parameters<typeof callMcpTool>[0];

	const result = await callMcpTool(
		codeModeEnv,
		{
			...props,
			manifest: {
				...manifest,
				mcp: { firecrawl_tedix: ["firecrawl_search"] },
			},
			namespaceToSlug: { firecrawl_tedix: "firecrawl-tedix" },
		},
		{
			namespace: "firecrawl_tedix",
			method: "firecrawl_search",
			args: { query: "example" },
			workflow,
		},
	);

	assert.deepEqual(result, { __tedixMcpResult: true, value: { hits: 1 } });
	assert.deepEqual(calls, [
		"firecrawl-tedix.mcp.tedix.dev tools/call firecrawl_search",
		"firecrawl-tedix.mcp.tedix.dev tools/list ",
		"tedix-unified.mcp.tedix.dev tools/call code",
	]);
});
