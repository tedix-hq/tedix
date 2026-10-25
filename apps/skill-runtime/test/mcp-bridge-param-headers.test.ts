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

function bindingProbe(label: string) {
	const scopedProps = { ...props, mcpBaseHost: `${label}.example.test` };
	const calls: Array<{
		method: string;
		params: Record<string, string>;
		key: string | null;
	}> = [];
	let binding = "account-a";
	let listed = true;
	let failure: { status: number; body: unknown } | undefined;
	const env = {
		MCP_SERVICE: {
			fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
				const request = new Request(input, init);
				const body = (await request.json()) as { id: string; method: string };
				const params = Object.fromEntries(
					[...request.headers].filter(([name]) =>
						name.startsWith("mcp-param-"),
					),
				);
				calls.push({
					method: body.method,
					params,
					key: request.headers.get("Idempotency-Key"),
				});
				if (body.method === "tools/list") {
					assert.deepEqual(params, {}, "listing must not carry stale bindings");
					return json({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							tools: listed
								? [
										{
											name: "get_commit",
											inputSchema: {
												type: "object",
												properties: {
													owner: { type: "string", "x-mcp-header": binding },
												},
											},
										},
									]
								: [],
						},
					});
				}
				if (failure) return json(failure.body, failure.status);
				if (params[`mcp-param-${binding}`] !== "example-org") {
					return json(
						{
							jsonrpc: "2.0",
							id: body.id,
							error: { code: -32020, message: "HeaderMismatch" },
						},
						400,
					);
				}
				return json({
					jsonrpc: "2.0",
					id: body.id,
					result: { content: [{ type: "text", text: '{"ok":true}' }] },
				});
			},
		},
	} as unknown as Parameters<typeof callMcpTool>[0];
	return {
		props: scopedProps,
		calls,
		setBinding(value: string) {
			binding = value;
		},
		hideTool() {
			listed = false;
		},
		fail(status: number, body: unknown) {
			failure = { status, body };
		},
		call(caller = scopedProps) {
			return callMcpTool(env, caller, {
				namespace: "code_host",
				method: "get_commit",
				args: { owner: "example-org" },
				workflow,
			});
		},
	};
}

for (const change of [
	{ orgId: "org-2" },
	{ tediId: "tedi-2" },
	{ startedBy: "user:operator-2" },
	{ runId: "run-2" },
	{ skillId: "skill-2" },
	{ workItemId: "work-2" },
	{ executionEpoch: 1 },
	{ serviceToken: "other-test-token" },
]) {
	const field = Object.keys(change)[0]!;
	test(`does not reuse another caller's schema when ${field} changes`, async () => {
		const probe = bindingProbe(`caller-${field.toLowerCase()}`);
		await probe.call();
		probe.calls.length = 0;
		probe.setBinding("account-b");
		const callerB = { ...probe.props, ...change };
		assert.deepEqual(await probe.call(callerB), {
			__tedixMcpResult: true,
			value: { ok: true },
		});
		assert.deepEqual(
			probe.calls.map(({ method, params }) => ({ method, params })),
			[
				{ method: "tools/call", params: {} },
				{ method: "tools/list", params: {} },
				{
					method: "tools/call",
					params: { "mcp-param-account-b": "example-org" },
				},
			],
		);
		probe.calls.length = 0;
		probe.setBinding("account-a");
		await probe.call();
		assert.deepEqual(
			probe.calls.map(({ params }) => params),
			[{ "mcp-param-account-a": "example-org" }],
		);
	});
}

test("refreshes a cached schema once when its binding changes", async () => {
	const probe = bindingProbe("changed-schema");
	await probe.call();
	probe.calls.length = 0;
	probe.setBinding("account-b");
	assert.deepEqual(await probe.call(), {
		__tedixMcpResult: true,
		value: { ok: true },
	});
	assert.deepEqual(
		probe.calls.map(({ method, params }) => ({ method, params })),
		[
			{
				method: "tools/call",
				params: { "mcp-param-account-a": "example-org" },
			},
			{ method: "tools/list", params: {} },
			{
				method: "tools/call",
				params: { "mcp-param-account-b": "example-org" },
			},
		],
	);
	assert.ok(probe.calls[0]!.key);
	assert.equal(probe.calls[0]!.key, probe.calls[2]!.key);
	probe.calls.length = 0;
	await probe.call();
	assert.deepEqual(
		probe.calls.map(({ params }) => params),
		[{ "mcp-param-account-b": "example-org" }],
	);
});

test("does not retry a second HeaderMismatch", async () => {
	const probe = bindingProbe("persistent-mismatch");
	await probe.call();
	probe.calls.length = 0;
	probe.fail(400, { error: { code: -32020, message: "HeaderMismatch" } });
	await assert.rejects(probe.call(), /MCP upstream returned 400/);
	assert.deepEqual(
		probe.calls.map(({ method }) => method),
		["tools/call", "tools/list", "tools/call"],
	);
});

test("evicts a rejected cached schema when the tool is no longer listed", async () => {
	const probe = bindingProbe("removed-tool");
	await probe.call();
	probe.calls.length = 0;
	probe.setBinding("account-b");
	probe.hideTool();
	await assert.rejects(probe.call(), /MCP upstream returned 400/);
	assert.deepEqual(
		probe.calls.map(({ method }) => method),
		["tools/call", "tools/list"],
	);
	probe.calls.length = 0;
	await assert.rejects(probe.call(), /MCP upstream returned 400/);
	assert.deepEqual(probe.calls[0]!.params, {});
});

for (const failure of [
	{
		label: "other-code",
		status: 400,
		body: { error: { code: -32603, message: "mentions -32020" } },
	},
	{ label: "wrong-status", status: 500, body: { error: { code: -32020 } } },
	{ label: "non-envelope", status: 400, body: { message: "-32020" } },
]) {
	test(`does not refresh or replay ${failure.label}`, async () => {
		const probe = bindingProbe(failure.label);
		await probe.call();
		probe.calls.length = 0;
		probe.fail(failure.status, failure.body);
		await assert.rejects(probe.call(), /MCP upstream returned/);
		assert.deepEqual(
			probe.calls.map(({ method }) => method),
			["tools/call"],
		);
	});
}
