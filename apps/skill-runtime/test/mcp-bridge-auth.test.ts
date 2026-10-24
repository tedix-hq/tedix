import assert from "node:assert/strict";
import { mock, test } from "bun:test";
import type { CapabilityManifest } from "@tedix/api-contract/utils/skill-manifest";
import { awaitReasonTurn } from "../src/reason-core";

mock.module("cloudflare:workers", () => ({
	WorkerEntrypoint: class {},
}));

const {
	callMcpTool,
	CapabilityNotDeclaredError,
	McpNamespaceUnavailableError,
} = await import("../src/mcp-bridge");

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
		"firecrawl-tedix.mcp.tedix.dev tools/call code",
		"tedix-unified.mcp.tedix.dev tools/call code",
	]);
});

function namespaceMissEnv(calls: string[], missing: string) {
	return {
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
						result: { tools: [] },
					});
				}
				if (host.startsWith("tedix-unified.") && body.params?.name === "code") {
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							isError: true,
							content: [
								{
									type: "text",
									text: `Execution error: ${missing} is not defined`,
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
}

test("a namespace that names no app explains the miss instead of 'is not defined'", async () => {
	const calls: string[] = [];
	await assert.rejects(
		callMcpTool(
			namespaceMissEnv(calls, "resend_old_acme"),
			{
				...props,
				manifest: { ...manifest, mcp: { resend_old_acme: ["list-emails"] } },
				// A renamed app no longer resolves, so the namespace is unmapped.
				namespaceToSlug: {},
			},
			{
				namespace: "resend_old_acme",
				method: "list-emails",
				args: {},
				workflow,
			},
		),
		(error: unknown) => {
			assert.ok(error instanceof McpNamespaceUnavailableError);
			assert.match(
				error.message,
				/^MCP_NAMESPACE_UNAVAILABLE: env\.MCP\.resend_old_acme\.list-emails names no app in this organization/,
			);
			assert.match(error.message, /renamed or removed/);
			assert.match(error.message, /resend_old_acme is not defined/);
			return true;
		},
	);
	assert.equal(calls.at(-1), "tedix-unified.mcp.tedix.dev tools/call code");
});

test("a mapped app without the tool names the app, not just the namespace", async () => {
	const calls: string[] = [];
	await assert.rejects(
		callMcpTool(
			namespaceMissEnv(calls, "resend_acme"),
			{
				...props,
				manifest: { ...manifest, mcp: { resend_acme: ["list-emails"] } },
				namespaceToSlug: { resend_acme: "resend-acme" },
			},
			{
				namespace: "resend_acme",
				method: "list-emails",
				args: {},
				workflow,
			},
		),
		(error: unknown) => {
			assert.ok(error instanceof McpNamespaceUnavailableError);
			assert.match(
				error.message,
				/app "resend-acme" exposes no "list-emails" tool to this run/,
			);
			return true;
		},
	);
	assert.deepEqual(calls, [
		"resend-acme.mcp.tedix.dev tools/call list-emails",
		"resend-acme.mcp.tedix.dev tools/list ",
		"resend-acme.mcp.tedix.dev tools/call code",
		"tedix-unified.mcp.tedix.dev tools/call code",
	]);
});

test("an unrelated Code Mode failure keeps its original error", async () => {
	await assert.rejects(
		callMcpTool(
			namespaceMissEnv([], "somethingElse"),
			{
				...props,
				manifest: { ...manifest, mcp: { resend_acme: ["list-emails"] } },
				namespaceToSlug: { resend_acme: "resend-acme" },
			},
			{
				namespace: "resend_acme",
				method: "list-emails",
				args: {},
				workflow,
			},
		),
		(error: unknown) => {
			assert.ok(!(error instanceof McpNamespaceUnavailableError));
			assert.match((error as Error).message, /somethingElse is not defined/);
			return true;
		},
	);
});

test("reasoning unwraps real MCP bridge receipts while retaining the synthesis request", async () => {
	const sessionKey = "workflow:synth:example";
	const programs: string[] = [];
	const pending = {
		ok: true,
		run_id: "synthesis-run",
		session_key: sessionKey,
		pending: true,
		assistant: null,
	};
	const settled = {
		ok: true,
		run_id: "synthesis-run",
		session_key: sessionKey,
		assistant: { content: "Project purpose" },
	};
	const probeEnv = {
		MCP_SERVICE: {
			fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
				const body = (await new Request(input, init).json()) as {
					params: { arguments: { code: string } };
				};
				programs.push(body.params.arguments.code);
				return Response.json({
					jsonrpc: "2.0",
					id: "reply",
					result: {
						structuredContent: {
							executionId: "execution",
							result: programs.length === 1 ? pending : settled,
						},
					},
				});
			},
		},
	} as unknown as Parameters<typeof callMcpTool>[0];
	let now = 0;
	const result = await awaitReasonTurn(
		sessionKey,
		() =>
			callMcpTool(
				probeEnv,
				{
					...props,
					tediNamespace: "chief",
					manifest: {
						...manifest,
						mcp: { tedi: ["run_tedi_turn"] },
						expectedAnnotations: { destructive: false, readOnly: false },
					},
				},
				{
					namespace: "tedi",
					method: "run_tedi_turn",
					workflow,
					args: {
						session_key: sessionKey,
						text: "Explain the project purpose",
						client_request_id: "reason:stable",
					},
				},
			),
		{
			now: () => now,
			sleep: async (ms) => {
				now += ms;
			},
		},
	);
	assert.deepEqual(result, settled);
	assert.equal(programs.length, 2);
	assert.equal(programs[0], programs[1]);
	assert.match(programs[0]!, /"client_request_id":"reason:stable"/);
});

test("a failed tedi turn ends the waiting call with a permanent error", async () => {
	const taskId = "tedi:tedi-1:run-failed";
	const methods: string[] = [];
	const failedTurnEnv = {
		MCP_SERVICE: {
			fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
				const body = (await new Request(input, init).json()) as {
					method: string;
				};
				methods.push(body.method);
				if (body.method === "tools/call") {
					const accepted = {
						ok: true,
						accepted: true,
						pending: true,
						assistant: null,
						task: { id: taskId, pollWith: "tasks/get" },
					};
					return Response.json({
						jsonrpc: "2.0",
						id: "call",
						result: {
							structuredContent: accepted,
							content: [{ type: "text", text: JSON.stringify(accepted) }],
						},
					});
				}
				return Response.json({
					jsonrpc: "2.0",
					id: "get",
					result: {
						taskId,
						status: "failed",
						error: { message: "Turn failed: tool registry unavailable" },
					},
				});
			},
		},
	} as unknown as Parameters<typeof callMcpTool>[0];
	const startedAt = Date.now();
	await assert.rejects(
		callMcpTool(
			failedTurnEnv,
			{
				...props,
				manifest: {
					...manifest,
					mcp: { notion_tedix: ["run_tedi_turn"] },
					expectedAnnotations: { destructive: false, readOnly: false },
				},
			},
			{
				namespace: "notion_tedix",
				method: "run_tedi_turn",
				args: { session_key: "factory:example", text: "Report" },
				workflow,
			},
		),
		(error: unknown) => {
			assert.match(
				(error as Error).message,
				/^MCP_TASK_FAILED: run_tedi_turn task tedi:tedi-1:run-failed failed: Turn failed: tool registry unavailable$/,
			);
			return true;
		},
	);
	assert.deepEqual(methods, ["tools/call", "tasks/get"]);
	assert.ok(Date.now() - startedAt < 5_000);
});

for (const failure of [
	"tool",
	"protocol",
	"transport",
	"approval",
	"connection",
	"task",
] as const) {
	test(`mapped Code Mode ${failure} failure is not replayed on the aggregate`, async () => {
		const calls: string[] = [];
		const recovery = {
			providerId: "notion",
			connectionInstanceId: "11111111-1111-4111-8111-111111111111",
			scope: "user" as const,
			scopes: ["write"],
		};
		const failureEnv = {
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
					if (body.method === "tasks/get") {
						return Response.json({
							jsonrpc: "2.0",
							id: body.id,
							result: {
								taskId: "task-failed",
								status: "failed",
								error: { message: "Method not found after provider write" },
							},
						});
					}
					if (body.params?.name !== "code") {
						return Response.json({
							jsonrpc: "2.0",
							id: body.id,
							error: { code: -32601, message: "Method not found" },
						});
					}
					assert.equal(
						host,
						"notion-tedix.mcp.tedix.dev",
						"must not replay at another target",
					);
					if (failure === "transport")
						throw new Error("response lost after provider write");
					if (failure === "protocol") {
						return Response.json({
							jsonrpc: "2.0",
							id: body.id,
							error: {
								code: -32603,
								message: "Method not found after provider write",
							},
						});
					}
					if (failure === "task") {
						return Response.json({
							jsonrpc: "2.0",
							id: body.id,
							result: {
								structuredContent: {
									executionId: "e-failed",
									result: { resultType: "task", taskId: "task-failed" },
								},
							},
						});
					}
					const result =
						failure === "approval"
							? { resultType: "input_required", inputRequests: [] }
							: {
									isError: true,
									...(failure === "connection"
										? { _meta: { "tedix/connectionRecovery": recovery } }
										: {}),
									content: [
										{
											type: "text",
											text: "Method not found after provider write",
										},
									],
								};
					return Response.json({ jsonrpc: "2.0", id: body.id, result });
				},
			},
		} as unknown as Parameters<typeof callMcpTool>[0];
		const operation = callMcpTool(failureEnv, props, {
			namespace: "notion_tedix",
			method: "notion_search",
			args: {},
			workflow,
		});
		if (failure === "connection") {
			assert.deepEqual(await operation, {
				__tedixConnectionRequired: true,
				recovery,
			});
		} else {
			await assert.rejects(
				operation,
				failure === "approval"
					? /MCP_INPUT_REQUIRED/
					: failure === "transport"
						? /response lost after provider write/
						: /Method not found after provider write/,
			);
		}
		assert.deepEqual(calls, [
			"notion-tedix.mcp.tedix.dev tools/call notion_search",
			"notion-tedix.mcp.tedix.dev tools/list ",
			"notion-tedix.mcp.tedix.dev tools/call code",
			...(failure === "task" ? ["notion-tedix.mcp.tedix.dev tasks/get "] : []),
		]);
	});
}
