import assert from "node:assert/strict";
import {
	AgentMcpRuntime,
	callMcpCredentialApi,
	INTERACTIVE_MCP_TOOL_TIMEOUTS,
	mcpCredentialResolveInput,
	writeDiscoveryCacheMetric,
	toTediToolRuntimeEvent,
} from "./mcp-client-runtime";

const observed = [
	{ innerCallId: "exec:0", receipt: { kind: "docs_file_observation" } },
];
const delegatedTurn = {
	runId: "child-run",
	homeRunId: "home-run",
	workItemId: "work-1",
};
assert.deepEqual(
	mcpCredentialResolveInput(
		"tedi-1",
		"https://gateway.mcp.tedix.dev/mcp",
		delegatedTurn,
	),
	{
		tediId: "tedi-1",
		serverUrl: "https://gateway.mcp.tedix.dev/mcp",
		delegatedTurn,
	},
);
assert.deepEqual(
	mcpCredentialResolveInput("tedi-1", "https://gateway.mcp.tedix.dev/mcp"),
	{ tediId: "tedi-1", serverUrl: "https://gateway.mcp.tedix.dev/mcp" },
);
const mapped = toTediToolRuntimeEvent(
	{
		kind: "tool.completed",
		sequence: 401,
		idSuffix: "tool.0.completed",
		conversationId: "conversation",
		runId: "run",
		payload: { readObservations: observed, tediId: "attacker" },
	},
	"canonical-tedi",
	"2026-09-22T12:00:00.000Z",
);
assert.equal(mapped.tediId, "canonical-tedi");
assert.equal(mapped.runId, "run");
assert.equal(mapped.conversationId, "conversation");
assert.deepEqual(mapped.payload, {
	readObservations: observed,
	tediId: "attacker",
});

assert.deepEqual(INTERACTIVE_MCP_TOOL_TIMEOUTS, {
	tedix_mcp_code: 45_000,
	tedix_mcp_call_tool: 30_000,
	tedix_mcp_list_namespaces: 30_000,
	tedix_mcp_search_tools: 30_000,
});

const discoveryPoints: AnalyticsEngineDataPoint[] = [];
writeDiscoveryCacheMetric(
	{
		writeDataPoint: (point) => {
			if (point) discoveryPoints.push(point);
		},
	},
	{
		outcome: "miss",
		endpoint: "https://srv.example/mcp",
		modern: true,
		ttlMs: 0,
		digest: "sha256:result",
	},
	{ organizationId: "org-1", tediId: "tedi-1" },
);
assert.deepEqual(discoveryPoints, [
	{
		blobs: [
			"mcp_discovery_cache",
			"miss",
			"https://srv.example/mcp",
			"modern",
			"sha256:result",
			"org-1",
			"tedi-1",
		],
		doubles: [0],
		indexes: ["org-1"],
	},
]);

assert.doesNotThrow(() =>
	writeDiscoveryCacheMetric(
		{
			writeDataPoint: () => {
				throw new Error("analytics unavailable");
			},
		},
		{
			outcome: "hit",
			endpoint: "https://srv.example/mcp",
			modern: false,
			ttlMs: 5000,
		},
		{ tediId: "tedi-1" },
	),
);

let assignedServersRequest:
	| { input: string | URL | Request; init?: RequestInit }
	| undefined;
const assignedServers = await callMcpCredentialApi<{ servers: unknown[] }>({
	apiUrl: "https://api.tedix.dev",
	path: "mcpCredentials/listServers",
	tediId: "tedi-1",
	organizationId: "org-1",
	body: { tediId: "tedi-1" },
	fetch: async (input, init) => {
		assignedServersRequest = { input, init };
		return Response.json({ json: { servers: [] } });
	},
});

assert.deepEqual(assignedServers, { servers: [] });
assert.ok(assignedServersRequest);
assert.equal(
	String(assignedServersRequest.input),
	"https://api.tedix.dev/rpc/mcpCredentials/listServers",
);
assert.equal(assignedServersRequest.init?.method, "POST");
const assignedHeaders = new Headers(assignedServersRequest.init?.headers);
assert.equal(assignedHeaders.get("X-Service-Binding"), "true");
assert.equal(assignedHeaders.get("X-Tedix-Tedi-Id"), "tedi-1");
assert.equal(assignedHeaders.get("X-Tedix-Organization-Id"), "org-1");
assert.equal(assignedHeaders.has("Authorization"), false);
assert.deepEqual(JSON.parse(String(assignedServersRequest.init?.body)), {
	json: { tediId: "tedi-1" },
});

let credentialsRequest: { init?: RequestInit } | undefined;
await callMcpCredentialApi({
	apiUrl: "http://localhost:8787",
	path: "mcpCredentials/resolve",
	tediId: "tedi-2",
	body: {
		tediId: "tedi-2",
		serverUrl: "https://example.mcp.tedix.dev/mcp",
	},
	fetch: async (_input, init) => {
		credentialsRequest = { init };
		return Response.json({ json: { headers: {} } });
	},
});

const credentialsHeaders = new Headers(credentialsRequest?.init?.headers);
assert.equal(credentialsHeaders.has("X-Tedix-Organization-Id"), false);
assert.equal(credentialsHeaders.has("Authorization"), false);

console.log("PASS: MCP credential API transport uses the canonical oRPC link");

// Adapter correlation preserves an explicit absent binding instead of borrowing a sibling.
const invocationRuntime = new AgentMcpRuntime(
	{} as Cloudflare.Env,
	"tedi",
	"org",
);
const forwarded: Array<unknown> = [];
(
	invocationRuntime as unknown as {
		core: {
			executeTool: (
				name: string,
				args: unknown,
				opts?: unknown,
			) => Promise<unknown>;
		};
	}
).core.executeTool = async (_name, _args, opts) => {
	forwarded.push(opts);
	return "done";
};
await invocationRuntime.executeTool("tedix_mcp_code", {}, { binding: null });
await invocationRuntime.executeTool(
	"tedix_mcp_code",
	{},
	{ binding: undefined },
);
await invocationRuntime.executeTool("tedix_mcp_code", {});
const invocationSignal = new AbortController().signal;
await invocationRuntime.executeTool(
	"tedix_mcp_code",
	{},
	{ binding: null, signal: invocationSignal },
);
assert.deepEqual(forwarded, [
	{ binding: null },
	{ binding: null },
	undefined,
	{ binding: null, signal: invocationSignal },
]);
