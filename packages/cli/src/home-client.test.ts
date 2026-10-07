import { isAuthError } from "./operator/runtime-errors";
import { describe, expect, test } from "bun:test";
import { normalizeCodeResult } from "./code-result";
import {
	createCliRequestTrace,
	delegatedChildStopFromPayload,
	isPendingHomeApproval,
	isRateLimitError,
	isSettledHomeStatus,
	latestRunFromSet,
	type McpClientLike,
	parseHomeRunEventsPage,
	rateLimitRetryAfterMs,
	resolveCliDestructiveElicitation,
	resolveCliTaskInputResponses,
	summarizeHomePayload,
	TedixHomeClient,
	isExpiredSessionError,
	unwrapToolResult,
} from "./home-client";

const TASK_TIME = "2026-08-30T00:00:00.000Z";
const taskBase = (taskId: string) => ({
	taskId,
	createdAt: TASK_TIME,
	lastUpdatedAt: TASK_TIME,
	ttlMs: null,
});

describe("isPendingHomeApproval", () => {
	const base = {
		assistantText: "prepared",
		homeRunId: "run-approval",
		delegationMode: "needs_approval",
	};
	test.each(["completed", "failed", "canceled"] as const)(
		"retains %s proposal metadata without offering an approval",
		(status) => {
			for (const delegationStatus of [undefined, "draft", "pending"]) {
				const summary = { ...base, status, delegationStatus };
				expect(isPendingHomeApproval(summary)).toBe(false);
				expect(summary.delegationMode).toBe("needs_approval");
			}
		},
	);
	test("keeps live approvals and rejects resolved or dispatched recommendations", () => {
		expect(
			isPendingHomeApproval({ ...base, status: "requires_approval" }),
		).toBe(true);
		expect(
			isPendingHomeApproval({
				...base,
				status: "queued",
				delegationStatus: "draft",
			}),
		).toBe(true);
		expect(
			isPendingHomeApproval({
				...base,
				status: "queued",
				delegationStatus: "approved",
			}),
		).toBe(false);
		expect(
			isPendingHomeApproval({
				...base,
				status: "running",
				childRunId: "child-1",
			}),
		).toBe(false);
	});
});

describe("gateway rate-limit parsing", () => {
	test("recognizes transport and tool-level 429 messages", () => {
		expect(isRateLimitError(new Error("HTTP 429 Too Many Requests"))).toBe(
			true,
		);
		expect(isRateLimitError("Rate limit exceeded")).toBe(true);
		expect(isRateLimitError(new Error("Invalid params"))).toBe(false);
	});

	test("honors bounded retryAfter seconds and supplies a fallback", () => {
		expect(
			rateLimitRetryAfterMs(
				new Error('{"error":"Rate limit exceeded","retryAfter":60}'),
			),
		).toBe(60_000);
		expect(rateLimitRetryAfterMs(new Error("429 retryAfter=999"))).toBe(
			120_000,
		);
		expect(rateLimitRetryAfterMs(new Error("Too many requests"))).toBe(5_000);
		expect(rateLimitRetryAfterMs(new Error("HTTP 503"))).toBeNull();
	});
});

describe("@tedix/cli latestRunFromSet (timeout recovery)", () => {
	test("finds the newest run id + status from a run-set payload", () => {
		expect(
			latestRunFromSet({
				conversationId: "c1",
				runs: [
					{ id: "old", status: "completed", createdAt: "2026-06-20T10:00:00Z" },
					{ id: "new", status: "running", createdAt: "2026-06-21T10:00:00Z" },
				],
			}),
		).toEqual({ homeRunId: "new", status: "running" });
	});

	test("returns null when no run array is present", () => {
		expect(latestRunFromSet({ foo: "bar" })).toBeNull();
		expect(latestRunFromSet(null)).toBeNull();
	});

	test("tie-breaking: equal timestamps → last element wins (newest insertion)", () => {
		const result = latestRunFromSet({
			runs: [
				{ id: "first", status: "completed", createdAt: "2026-06-21T10:00:00Z" },
				{ id: "second", status: "running", createdAt: "2026-06-21T10:00:00Z" },
			],
		});
		// On equal timestamps, the later array element (second) should win.
		expect(result?.homeRunId).toBe("second");
	});

	test("missing timestamps: entry with real timestamp beats entry with no timestamp", () => {
		const result = latestRunFromSet({
			runs: [
				{ id: "no-stamp", status: "completed" },
				{
					id: "has-stamp",
					status: "running",
					createdAt: "2026-06-21T10:00:00Z",
				},
			],
		});
		expect(result?.homeRunId).toBe("has-stamp");
	});

	test("all missing timestamps: last element wins", () => {
		const result = latestRunFromSet({
			runs: [
				{ id: "first", status: "completed" },
				{ id: "last", status: "running" },
			],
		});
		expect(result?.homeRunId).toBe("last");
	});

	test("matches the exact client submission during timeout recovery", () => {
		expect(
			latestRunFromSet(
				{
					runs: [
						{ id: "other", metadata: { clientSubmissionId: "other" } },
						{ id: "mine", metadata: { clientSubmissionId: "submission-1" } },
					],
				},
				"submission-1",
			),
		).toEqual({ homeRunId: "mine", status: undefined });
		expect(
			latestRunFromSet(
				{ runs: [{ id: "other", metadata: { clientSubmissionId: "other" } }] },
				"submission-1",
			),
		).toBeNull();
	});
});

interface HarnessState {
	calls: number;
	closes: number;
	connects: number;
}

/**
 * Build a TedixHomeClient with an injected fake connection. `callImpl` decides
 * what each callTool does, keyed by overall call index and the connection
 * generation it runs on, so tests can simulate a dropped shared transport.
 */
function harness(
	callImpl: (
		callIndex: number,
		generation: number,
		params?: { name: string; arguments: Record<string, unknown> },
	) => Promise<unknown>,
): { client: TedixHomeClient; state: HarnessState } {
	const state: HarnessState = { calls: 0, closes: 0, connects: 0 };
	const connect = async (): Promise<McpClientLike> => {
		state.connects++;
		const generation = state.connects;
		return {
			callTool: async (params) => callImpl(++state.calls, generation, params),
			close: async () => {
				state.closes++;
			},
		};
	};
	const client = new TedixHomeClient({ connect, headers: {}, url: "http://x" });
	return { client, state };
}

const okResult = {
	structuredContent: { run: { id: "r", status: "completed" } },
};

function isRecordRun(value: unknown): boolean {
	return typeof value === "object" && value !== null && "run" in value;
}

describe("@tedix/cli home client helpers", () => {
	test("destructive elicitation accepts only an explicit call-local reason form", () => {
		expect(
			resolveCliDestructiveElicitation("operator cleanup", {
				params: {
					mode: "form",
					requestedSchema: {
						type: "object",
						properties: { reason: { type: "string" } },
					},
				},
			}),
		).toEqual({
			action: "accept",
			content: { reason: "operator cleanup" },
		});
		expect(
			resolveCliDestructiveElicitation(undefined, {
				params: {
					mode: "form",
					requestedSchema: { properties: { reason: {} } },
				},
			}),
		).toEqual({ action: "decline" });
		expect(
			resolveCliDestructiveElicitation("operator cleanup", {
				params: {
					mode: "url",
					requestedSchema: { properties: { reason: {} } },
				},
			}),
		).toEqual({ action: "decline" });
	});

	test("task input responses reuse the explicit destructive approval and fail closed otherwise", () => {
		const requests = {
			approval: {
				method: "elicitation/create",
				params: {
					mode: "form",
					requestedSchema: { properties: { reason: { type: "string" } } },
				},
			},
		};
		expect(resolveCliTaskInputResponses("ship release", requests)).toEqual({
			approval: { action: "accept", content: { reason: "ship release" } },
		});
		expect(resolveCliTaskInputResponses(undefined, requests)).toBeNull();
		expect(
			resolveCliTaskInputResponses("ship release", {
				approval: { method: "sampling/createMessage", params: {} },
			}),
		).toBeNull();
	});

	test("unwrapToolResult prefers structuredContent over presentation text", () => {
		const payload = {
			status: "queued",
			run: { id: "home-run-1", status: "running" },
		};
		const result = {
			content: [
				{
					type: "text",
					text: "Working on it - poll read_home_run for the result.",
				},
				{ type: "text", text: JSON.stringify({ stale: true }) },
			],
			structuredContent: payload,
		};

		expect(unwrapToolResult(result)).toBe(payload);
	});

	test("unwrapToolResult uses the canonical toolResult and content semantics", () => {
		const toolResult = { ok: true, rows: [1, 2] };
		expect(unwrapToolResult({ toolResult }, "catalog.list_items")).toBe(
			toolResult,
		);
		expect(
			unwrapToolResult(
				{
					structuredContent: null,
					content: [{ type: "text", text: "42" }],
				},
				"catalog.count_items",
			),
		).toBe(42);
	});

	test("unwrapToolResult preserves structured media content", () => {
		const content = [
			{ type: "image", data: "base64-image", mimeType: "image/png" },
			{ type: "text", text: "caption" },
		];
		expect(unwrapToolResult({ content }, "media.render_preview")).toBe(content);
	});

	test("unwrapToolResult fails closed for input_required and joins tool errors", () => {
		expect(() =>
			unwrapToolResult({ resultType: "input_required" }, "admin.delete_item"),
		).toThrow("MCP_INPUT_REQUIRED: admin.delete_item");
		expect(() =>
			unwrapToolResult(
				{
					isError: true,
					content: [
						{ type: "text", text: "validation failed" },
						{ type: "text", text: "missing id" },
					],
				},
				"catalog.get_item",
			),
		).toThrow("MCP tool error: validation failed\nmissing id");
		expect(() =>
			unwrapToolResult(
				{ isError: true, content: [{ type: "image", data: "x" }] },
				"media.render_preview",
			),
		).toThrow("MCP tool error: Tool call failed");
	});

	test("runCode calls the `code` tool with the source and unwraps the result", async () => {
		const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
		const client = new TedixHomeClient({
			connect: async () => ({
				callTool: async (params: {
					name: string;
					arguments: Record<string, unknown>;
				}) => {
					calls.push({ name: params.name, args: params.arguments });
					return {
						content: [
							{ type: "text", text: JSON.stringify({ ok: 1, items: [2, 3] }) },
						],
					};
				},
				close: async () => {},
			}),
			headers: {},
			url: "http://x",
		});
		const src = "async () => await discover.search({ query: 'firecrawl' })";
		const result = await client.runCode(src);
		expect(calls).toEqual([{ name: "code", args: { code: src } }]);
		expect(result).toEqual({ ok: 1, items: [2, 3] });
	});

	test("runCodeWithDestructiveApproval uses the code tool and rejects an empty reason", async () => {
		const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
		const client = new TedixHomeClient({
			connect: async () => ({
				callTool: async (params: {
					name: string;
					arguments: Record<string, unknown>;
				}) => {
					calls.push({ name: params.name, args: params.arguments });
					return { content: [{ type: "text", text: '{"ok":true}' }] };
				},
				close: async () => {},
			}),
			headers: {},
			url: "http://x",
		});
		const source = "async () => await work.authorize_owned_channel({})";
		await expect(
			client.runCodeWithDestructiveApproval(source, "authorize campaign"),
		).resolves.toEqual({ ok: true });
		expect(calls).toEqual([{ name: "code", args: { code: source } }]);
		await expect(
			client.runCodeWithDestructiveApproval(source, "  "),
		).rejects.toThrow("destructive approval reason");
		expect(calls).toHaveLength(1);
	});

	test("fulfills synchronous modern input_required before retrying the tool", async () => {
		const toolParams: Record<string, unknown>[] = [];
		const client = new TedixHomeClient({
			fetch: async (_input, init) => {
				const body = JSON.parse(String(init?.body)) as {
					id: string;
					method: string;
					params: Record<string, unknown>;
				};
				if (body.method === "server/discover") {
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result: { supportedVersions: ["2026-07-28"] },
					});
				}
				toolParams.push(body.params);
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result:
						toolParams.length === 1
							? {
									resultType: "input_required",
									requestState: "signed-state",
									inputRequests: {
										approval: {
											method: "elicitation/create",
											params: {
												mode: "form",
												requestedSchema: { properties: { reason: {} } },
											},
										},
									},
								}
							: { structuredContent: { committed: true } },
				});
			},
			headers: {},
			url: "https://example.com/mcp",
		});

		await expect(
			client.runCodeWithDestructiveApproval("async () => commit()", "ship"),
		).resolves.toEqual({ committed: true });
		expect(toolParams[1]).toMatchObject({
			requestState: "signed-state",
			inputResponses: {
				approval: { action: "accept", content: { reason: "ship" } },
			},
		});
	});

	test("fails closed when synchronous input_required cannot be answered", async () => {
		const client = new TedixHomeClient({
			connect: async () => ({
				callTool: async () => ({ resultType: "input_required" }),
				close: async () => {},
			}),
			headers: {},
			url: "http://x",
		});

		await expect(client.callTool("admin__delete_item", {})).rejects.toThrow(
			"MCP_INPUT_REQUIRED: admin__delete_item",
		);
	});

	test("runCode throws when the code result is an error", async () => {
		const client = new TedixHomeClient({
			connect: async () => ({
				callTool: async () => ({
					isError: true,
					content: [
						{ type: "text", text: "ReferenceError: foo is not defined" },
					],
				}),
				close: async () => {},
			}),
			headers: {},
			url: "http://x",
		});
		await expect(client.runCode("async () => foo()")).rejects.toThrow(
			"ReferenceError: foo is not defined",
		);
	});

	test("polls a native MCP Task to its completed tool result", async () => {
		const requests: Array<{ body: Record<string, unknown>; headers: Headers }> =
			[];
		let getCount = 0;
		const client = new TedixHomeClient({
			fetch: async (_input, init) => {
				const body = JSON.parse(String(init?.body)) as Record<
					string,
					unknown
				> & {
					method: string;
				};
				requests.push({ body, headers: new Headers(init?.headers) });
				if (body.method === "server/discover") {
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							resultType: "complete",
							supportedVersions: ["2026-07-28"],
							capabilities: {
								extensions: { "io.modelcontextprotocol/tasks": {} },
							},
						},
					});
				}
				if (body.method === "tools/call") {
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							resultType: "task",
							...taskBase("task-1"),
							status: "working",
						},
					});
				}
				getCount++;
				return Response.json({
					jsonrpc: "2.0",
					id: "response",
					result:
						getCount === 1
							? {
									resultType: "complete",
									...taskBase("task-1"),
									taskId: "task-1",
									status: "working",
									pollIntervalMs: 1,
								}
							: {
									resultType: "complete",
									...taskBase("task-1"),
									taskId: "task-1",
									status: "completed",
									result: { structuredContent: { ok: true } },
								},
				});
			},
			headers: { Authorization: "Bearer test" },
			timeoutMs: 1_000,
			url: "https://example.com/mcp",
		});

		const result = await client.callTool("slow_tool", {});
		expect(result).toEqual({ ok: true });
		expect(requests.map(({ body }) => body.method)).toEqual([
			"server/discover",
			"tools/call",
			"tasks/get",
			"tasks/get",
		]);
		const discoverParams = requests[0]?.body.params as Record<string, unknown>;
		expect(discoverParams._meta).toMatchObject({
			"io.modelcontextprotocol/clientCapabilities": {
				extensions: { "io.modelcontextprotocol/tasks": {} },
			},
		});
		const first = requests[2];
		expect(first?.headers.get("MCP-Protocol-Version")).toBe("2026-07-28");
		expect(first?.headers.get("Mcp-Method")).toBe("tasks/get");
		expect(first?.headers.get("Mcp-Name")).toBe("task-1");
		expect(first?.headers.get("Authorization")).toBe("Bearer test");
		const params = first?.body.params as Record<string, unknown>;
		expect(params.taskId).toBe("task-1");
		expect(params._meta).toMatchObject({
			"io.modelcontextprotocol/protocolVersion": "2026-07-28",
			"io.modelcontextprotocol/clientCapabilities": {
				extensions: { "io.modelcontextprotocol/tasks": {} },
			},
		});
	});

	test("rejects a Task result when the server did not advertise the Tasks extension", async () => {
		const client = new TedixHomeClient({
			fetch: async (_input, init) => {
				const body = JSON.parse(String(init?.body)) as {
					id: string;
					method: string;
				};
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result:
						body.method === "server/discover"
							? {
									supportedVersions: ["2026-07-28"],
									capabilities: {},
								}
							: {
									resultType: "task",
									...taskBase("unnegotiated-task"),
									status: "working",
								},
				});
			},
			headers: {},
			url: "https://example.com/mcp",
		});

		await expect(client.callTool("slow_tool", {})).rejects.toThrow(
			"returned a Task without advertising io.modelcontextprotocol/tasks",
		);
	});

	test("answers each asynchronous input request once through tasks/update", async () => {
		const methods: string[] = [];
		let getCount = 0;
		let updateParams: Record<string, unknown> | undefined;
		const client = new TedixHomeClient({
			connect: async () => ({
				callTool: async () => ({
					resultType: "task",
					...taskBase("task-input"),
					status: "working",
				}),
				close: async () => {},
			}),
			fetch: async (_input, init) => {
				const body = JSON.parse(String(init?.body)) as {
					method: string;
					params: Record<string, unknown>;
				};
				methods.push(body.method);
				if (body.method === "tasks/update") {
					updateParams = body.params;
					return Response.json({
						jsonrpc: "2.0",
						id: "update",
						result: { resultType: "complete" },
					});
				}
				getCount++;
				const inputRequired = {
					resultType: "complete",
					...taskBase("task-input"),
					taskId: "task-input",
					status: "input_required",
					pollIntervalMs: 1,
					inputRequests: {
						approval: {
							method: "elicitation/create",
							params: {
								mode: "form",
								requestedSchema: { properties: { reason: {} } },
							},
						},
					},
				};
				return Response.json({
					jsonrpc: "2.0",
					id: "get",
					result:
						getCount < 3
							? inputRequired
							: {
									resultType: "complete",
									...taskBase("task-input"),
									taskId: "task-input",
									status: "completed",
									result: { structuredContent: { approved: true } },
								},
				});
			},
			headers: {},
			timeoutMs: 1_000,
			url: "https://example.com/mcp",
		});

		await expect(
			client.runCodeWithDestructiveApproval("async () => slow()", "release"),
		).resolves.toEqual({ approved: true });
		expect(methods).toEqual([
			"tasks/get",
			"tasks/update",
			"tasks/get",
			"tasks/get",
		]);
		expect(updateParams).toMatchObject({
			taskId: "task-input",
			inputResponses: {
				approval: { action: "accept", content: { reason: "release" } },
			},
		});
	});

	test("fails closed when asynchronous task input cannot be answered", async () => {
		const client = new TedixHomeClient({
			connect: async () => ({
				callTool: async () => ({
					resultType: "task",
					...taskBase("task-input"),
					status: "working",
				}),
				close: async () => {},
			}),
			fetch: async () =>
				Response.json({
					jsonrpc: "2.0",
					id: "get",
					result: {
						resultType: "complete",
						...taskBase("task-input"),
						taskId: "task-input",
						status: "input_required",
						inputRequests: {
							approval: {
								method: "elicitation/create",
								params: {
									mode: "form",
									requestedSchema: { properties: { reason: {} } },
								},
							},
						},
					},
				}),
			headers: {},
			timeoutMs: 1_000,
			url: "https://example.com/mcp",
		});

		await expect(client.callTool("admin__slow_delete", {})).rejects.toThrow(
			"MCP_INPUT_REQUIRED: admin__slow_delete",
		);
	});

	test("cancels an active MCP Task when its caller aborts", async () => {
		const controller = new AbortController();
		const methods: string[] = [];
		const client = new TedixHomeClient({
			connect: async () => ({
				callTool: async () => ({
					resultType: "task",
					...taskBase("task-abort"),
					status: "working",
				}),
				close: async () => {},
			}),
			fetch: async (_input, init) => {
				const body = JSON.parse(String(init?.body)) as { method: string };
				methods.push(body.method);
				if (body.method === "tasks/get") controller.abort(new Error("stop"));
				if (body.method === "tasks/cancel") {
					return Response.json({
						jsonrpc: "2.0",
						id: "response",
						result: { resultType: "complete" },
					});
				}
				return Response.json({
					jsonrpc: "2.0",
					id: "response",
					result: {
						resultType: "complete",
						...taskBase("task-abort"),
						taskId: "task-abort",
						status: "working",
						pollIntervalMs: 1_000,
					},
				});
			},
			headers: {},
			timeoutMs: 1_000,
			url: "https://example.com/mcp",
		});

		await expect(
			client.callTool("slow_tool", {}, { signal: controller.signal }),
		).rejects.toThrow("stop");
		expect(methods).toEqual(["tasks/get", "tasks/cancel"]);
	});

	test("returns a native ask Task as the durable Home acknowledgement without a second call", async () => {
		const calls: string[] = [];
		const client = new TedixHomeClient({
			connect: async () => ({
				callTool: async ({ name }) => {
					calls.push(name);
					if (name === "ask") {
						return {
							resultType: "task",
							...taskBase("home-run-task"),
							status: "working",
						};
					}
					return {
						structuredContent: {
							run: { id: "home-run-task", status: "running" },
						},
					};
				},
				close: async () => {},
			}),
			headers: {},
			url: "https://example.com/mcp",
		});

		await expect(
			client.askHome({ content: "hello", conversationId: "conversation" }),
		).resolves.toEqual({
			run: { id: "home-run-task", status: "running" },
			mcpTask: {
				resultType: "task",
				...taskBase("home-run-task"),
				status: "working",
			},
		});
		expect(calls).toEqual(["ask"]);
	});

	test("treats a terminal ask acknowledgement as provisional until tasks/get", async () => {
		const client = new TedixHomeClient({
			connect: async () => ({
				callTool: async () => ({
					resultType: "task",
					...taskBase("home-run-task"),
					status: "completed",
					result: {},
				}),
				close: async () => {},
			}),
			headers: {},
			url: "https://example.com/mcp",
		});

		await expect(
			client.askHome({ content: "hello", conversationId: "conversation" }),
		).resolves.toMatchObject({
			run: { id: "home-run-task", status: "running" },
			mcpTask: { taskId: "home-run-task", status: "working" },
		});
	});

	test("rejects a malformed native ask Task instead of inventing required fields", async () => {
		const client = new TedixHomeClient({
			connect: async () => ({
				callTool: async () => ({
					resultType: "task",
					taskId: "missing-required-fields",
					status: "working",
				}),
				close: async () => {},
			}),
			headers: {},
			url: "https://example.com/mcp",
		});

		await expect(
			client.askHome({ content: "hello", conversationId: "conversation" }),
		).rejects.toThrow("invalid Tasks extension response");
	});

	test("routes Home readback through Code Mode instead of removed direct tools", async () => {
		const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
		const client = new TedixHomeClient({
			connect: async () => ({
				callTool: async ({ name, arguments: args }) => {
					calls.push({ name, args });
					return { structuredContent: { ok: true } };
				},
				close: async () => {},
			}),
			headers: {},
			url: "https://example.com/mcp",
		});

		await expect(client.readHomeRun("run-1")).resolves.toEqual({ ok: true });
		expect(calls).toEqual([
			{
				name: "code",
				args: {
					code: 'async () => await home.read_home_run({"runId":"run-1"})',
				},
			},
		]);
	});

	test("summarizeHomePayload extracts route answer and status", () => {
		const summary = summarizeHomePayload({
			run: {
				id: "home-run-1",
				status: "completed",
				conversationId: "home:cli:test",
				metadata: {
					kernelRoute: {
						routeKind: "answer_in_home",
						answer: "The kernel is reachable.",
					},
				},
			},
		});

		expect(summary).toMatchObject({
			homeRunId: "home-run-1",
			status: "completed",
			conversationId: "home:cli:test",
			assistantText: "The kernel is reachable.",
		});
		expect(summary?.kernelRoute?.routeKind).toBe("answer_in_home");
	});

	test("summarizeHomePayload reads clarifying questions for ask_human", () => {
		const summary = summarizeHomePayload({
			run: {
				id: "home-run-2",
				status: "completed",
				metadata: {
					kernelRoute: {
						routeKind: "ask_human",
						clarifyingQuestion: "Which repo should I inspect?",
					},
				},
			},
		});

		expect(summary?.assistantText).toBe("Which repo should I inspect?");
	});

	test("delegatedChildStopFromPayload reads the async child-stop outcome", () => {
		const stop = delegatedChildStopFromPayload({
			run: {
				id: "r1",
				metadata: {
					delegatedChildStop: { outcome: "succeeded", childRunId: "child-1" },
				},
			},
		});
		expect(stop).toEqual({ outcome: "succeeded", childRunId: "child-1" });
	});

	test("delegatedChildStopFromPayload returns null when no child was stopped", () => {
		expect(
			delegatedChildStopFromPayload({ run: { id: "r1", metadata: {} } }),
		).toBeNull();
		expect(delegatedChildStopFromPayload({})).toBeNull();
	});

	test("summarizeHomePayload extracts delegated child run metadata", () => {
		const summary = summarizeHomePayload({
			run: {
				id: "home-run-3",
				status: "running",
				childRunId: "child-run-1",
				delegatedTediId: "tedi-cto",
				metadata: {
					childConversationId: "agent:cto:main",
					childRunPreview: "checking workstation evidence",
					delegationError: "runtime warming",
				},
			},
		});

		expect(summary).toMatchObject({
			homeRunId: "home-run-3",
			status: "running",
			delegatedTediId: "tedi-cto",
			childRunId: "child-run-1",
			childRunPreview: "checking workstation evidence",
			delegationError: "runtime warming",
			assistantText: "checking workstation evidence",
		});
	});

	test("summarizeHomePayload extracts delegate target and approval decision", () => {
		const summary = summarizeHomePayload({
			run: {
				id: "home-run-4",
				status: "completed",
				metadata: {
					homeDelegation: {
						workOrder: {
							status: "draft",
						},
						decision: {
							mode: "needs_approval",
							reason: "target requires approval for its actions",
						},
					},
					kernelRoute: {
						routeKind: "delegate_tedi",
						answer: "CTO owns this.",
						targetTediId: "tedi-cto",
						targetTediLabel: "CTO",
					},
				},
			},
		});

		expect(summary).toMatchObject({
			homeRunId: "home-run-4",
			status: "completed",
			targetTediId: "tedi-cto",
			targetTediLabel: "CTO",
			delegationMode: "needs_approval",
			delegationReason: "target requires approval for its actions",
			delegationStatus: "draft",
			assistantText: "CTO owns this.",
		});
	});

	test("summarizeHomePayload exposes rejected delegation resolution", () => {
		const summary = summarizeHomePayload({
			run: {
				id: "home-run-4b",
				status: "canceled",
				metadata: {
					childRunPreview: "Delegation rejected by operator.",
					homeDelegation: {
						resolution: "Rejecting this parked delegation.",
						resolutionStatus: "rejected",
						resolvedAt: "2026-06-27T08:04:59.712Z",
						workOrder: {
							status: "rejected",
						},
						decision: {
							mode: "needs_approval",
							reason: "operator explicitly held dispatch for approval",
						},
					},
					kernelRoute: {
						routeKind: "delegate_tedi",
						targetTediLabel: "CTO",
					},
				},
			},
		});

		expect(summary).toMatchObject({
			homeRunId: "home-run-4b",
			status: "canceled",
			delegationMode: "needs_approval",
			delegationReason: "operator explicitly held dispatch for approval",
			delegationStatus: "rejected",
			delegationResolution: "Rejecting this parked delegation.",
			delegationResolvedAt: "2026-06-27T08:04:59.712Z",
			childRunPreview: "Delegation rejected by operator.",
			targetTediLabel: "CTO",
		});
	});

	test("summarizeHomePayload keeps a canceled run authoritative over stale child output", () => {
		const summary = summarizeHomePayload({
			run: {
				id: "home-run-canceled",
				status: "canceled",
				metadata: {
					cancelReason: "validation stop",
					bodyExecutionResult: { summary: "On it — delegating to CTO." },
					childRunPreview: "Raw result: { partial: true }",
				},
			},
		});

		expect(summary?.assistantText).toBe(
			"Home run canceled by operator: validation stop",
		);
		expect(summary?.childRunPreview).toBe("Raw result: { partial: true }");
	});

	test("summarizeHomePayload reads bodyExecutionResult.summary on the poll path", () => {
		// Simulates read_home_run response with no assistantMessage while the
		// durable body summary holds the operator-facing result.
		const summary = summarizeHomePayload({
			run: {
				id: "home-run-5",
				status: "completed",
				metadata: {
					kernelRoute: {
						routeKind: "delegate_tedi",
						answer: null,
						toolIntent: {
							appSlug: "tedix-unified",
							capability: "mcp.gateway.activity.stats.read",
						},
					},
					bodyExecutionResult: {
						status: "completed",
						summary:
							"Read mcp.gateway.activity.stats.read from tedix-unified (get_info): 0 results.",
					},
				},
			},
		});

		expect(summary?.assistantText).toBe(
			"Read mcp.gateway.activity.stats.read from tedix-unified (get_info): 0 results.",
		);
		expect(summary?.homeRunId).toBe("home-run-5");
	});

	test("summarizeHomePayload reads bodyExecutionResult.summary for delegate_tedi approval recommendations", () => {
		const summary = summarizeHomePayload({
			run: {
				id: "home-run-6",
				status: "completed",
				metadata: {
					homeDelegation: {
						decision: {
							mode: "needs_approval",
							reason: "operator explicitly held dispatch for approval",
						},
					},
					kernelRoute: {
						routeKind: "delegate_tedi",
						answer: null,
						targetTediId: "tedi-cto",
						targetTediLabel: "CTO",
					},
					bodyExecutionResult: {
						status: "completed",
						summary:
							"I prepared a delegation to CTO. It is not dispatched yet; approve this Home run to dispatch the work order.",
					},
				},
			},
		});

		expect(summary?.assistantText).toBe(
			"I prepared a delegation to CTO. It is not dispatched yet; approve this Home run to dispatch the work order.",
		);
		expect(summary?.delegationMode).toBe("needs_approval");
	});

	test("summarizeHomePayload exposes approved delegation work order scope", () => {
		const summary = summarizeHomePayload({
			run: {
				id: "home-run-7",
				status: "queued",
				childRunId: "child-run-7",
				metadata: {
					workItemId: "wi-approved-7",
					delegationWorkOrder: {
						status: "approved",
						objective:
							"The operator approved this previously parked delegation to CTO. Execute the intended delegated task now.",
						outputContract:
							"Return the completed delegated task result with concrete evidence.",
						sourceContent: "Approved Home delegation.",
					},
					kernelRoute: {
						routeKind: "delegate_tedi",
						answer: null,
					},
					bodyExecutionResult: {
						status: "completed",
						summary: "Dispatching approved work order.",
					},
				},
			},
		});

		expect(summary?.approvedDelegationWorkOrder).toMatchObject({
			status: "approved",
			objective: expect.stringContaining("Execute the intended"),
			outputContract: expect.stringContaining("completed delegated task"),
			sourceContent: "Approved Home delegation.",
		});
		expect(summary?.workItemId).toBe("wi-approved-7");
	});

	test("summarizeHomePayload prefers route answers over bodyExecutionResult.summary", () => {
		// For answer_in_home the route.answer is authoritative.
		const summary = summarizeHomePayload({
			run: {
				id: "home-run-8",
				status: "completed",
				metadata: {
					kernelRoute: {
						routeKind: "answer_in_home",
						answer: "Here is the answer.",
					},
					bodyExecutionResult: {
						status: "completed",
						summary: "should not appear",
					},
				},
			},
		});

		expect(summary?.assistantText).toBe("Here is the answer.");
	});

	test("parseHomeRunEventsPage maps array-index offsets and stays live", () => {
		const page = parseHomeRunEventsPage({
			events: [
				{ id: "e3", kind: "tool_call", createdAt: "t3", payload: { a: 1 } },
				{ id: "e4", type: "tool_result", at: "t4", delta: { b: 2 } },
			],
			stream: { offset: 3, nextOffset: 5, closed: false },
		});
		expect(page.events).toHaveLength(2);
		expect(page.events[0]).toMatchObject({ offset: "3", kind: "tool_call" });
		expect(page.events[1]).toMatchObject({ offset: "4", kind: "tool_result" });
		expect(page.events[1]?.payload).toEqual({ b: 2 });
		expect(page.nextOffset).toBe("5");
		// A page that carried events is NOT caught up — the server bounds a page by
		// `limit`, so the reader must drain to an empty page before it stops.
		expect(page.upToDate).toBe(false);
		// Live runs report no settled status, so the follow loop keeps polling.
		expect(page.status).toBeUndefined();
	});

	test("parseHomeRunEventsPage derives settled status from the terminal event", () => {
		const page = parseHomeRunEventsPage({
			events: [
				{ id: "e0", kind: "run_start" },
				{ id: "e1", kind: "run_failed" },
			],
			stream: { offset: 0, nextOffset: 2, closed: true, terminalEventId: "e1" },
		});
		expect(page.nextOffset).toBe("2");
		expect(page.status).toBe("failed");
		expect(isSettledHomeStatus(page.status)).toBe(true);
	});

	test("parseHomeRunEventsPage reports a non-empty page as not caught up and advances nextOffset by event count", () => {
		const page = parseHomeRunEventsPage({
			events: [
				{ id: "a", kind: "step" },
				{ id: "b", kind: "step" },
			],
			stream: { offset: 7, nextOffset: 9, closed: false },
		});
		expect(page.upToDate).toBe(false);
		expect(page.nextOffset).toBe("9");
		expect(page.events).toHaveLength(2);
		expect(page.events[0]?.offset).toBe("7");
		expect(page.events[1]?.offset).toBe("8");
		expect(page.status).toBeUndefined();
	});

	test("parseHomeRunEventsPage resumes from the previous offset when empty", () => {
		const page = parseHomeRunEventsPage(
			{ events: [], stream: { closed: false } },
			"9",
		);
		expect(page.events).toEqual([]);
		expect(page.nextOffset).toBe("9");
		expect(page.upToDate).toBe(true);
	});

	test("parseHomeRunEventsPage reads the page through the Code Mode envelope", () => {
		const page = parseHomeRunEventsPage(
			normalizeCodeResult({
				executionId: "exec-1",
				result: {
					events: [
						{ id: "e3", kind: "message.delta", payload: { text: "hi" } },
						{ id: "e4", kind: "message.delta", payload: { text: "!" } },
					],
					stream: { offset: 3, nextOffset: 5, closed: false },
				},
				logs: [],
			}).value,
			"3",
		);
		expect(page.events).toHaveLength(2);
		expect(page.events[0]).toMatchObject({
			offset: "3",
			kind: "message.delta",
		});
		expect(page.nextOffset).toBe("5");
		expect(page.status).toBeUndefined();
	});

	test("readHomeRunEvents unwraps the Code Mode envelope before parsing", async () => {
		const { client } = harness(async () => ({
			structuredContent: {
				executionId: "exec-1",
				result: {
					events: [
						{ id: "e0", kind: "run.started" },
						{ id: "e1", kind: "message.delta", payload: { text: "hi" } },
					],
					stream: { offset: 0, nextOffset: 2, closed: false },
				},
				logs: [],
			},
		}));
		const page = await client.readHomeRunEvents({ homeRunId: "r", waitMs: 5 });
		expect(page.events).toHaveLength(2);
		expect(page.events[1]).toMatchObject({
			offset: "1",
			kind: "message.delta",
		});
		expect(page.nextOffset).toBe("2");
		expect(page.status).toBeUndefined();
	});

	test("readHomeRunEvents halves the page until the gateway stops truncating", async () => {
		const limits: number[] = [];
		const { client } = harness(async (callIndex, _generation, params) => {
			const match = /"limit":(\d+)/.exec(
				String(
					(params?.arguments as { code?: unknown } | undefined)?.code ?? "",
				),
			);
			if (match?.[1]) limits.push(Number(match[1]));
			return {
				structuredContent: {
					executionId: "exec-1",
					result:
						callIndex < 3
							? {
									__tedix_truncated: true,
									preview: '{"events":[{"id":"e9","kind":"message.delta"',
									approxTokens: 90000,
								}
							: {
									events: [{ id: "e9", kind: "message.delta" }],
									stream: { offset: 9, nextOffset: 10, closed: false },
								},
				},
			};
		});
		const page = await client.readHomeRunEvents({
			homeRunId: "r",
			offset: "9",
			limit: 8,
		});
		expect(limits).toEqual([8, 4, 2]);
		expect(page.events).toHaveLength(1);
		expect(page.nextOffset).toBe("10");
	});

	test("readHomeRunEvents fails loudly when even a single event cannot be returned", async () => {
		const { client } = harness(async () => ({
			structuredContent: {
				executionId: "exec-1",
				result: {
					__tedix_truncated: true,
					preview: '{"events":[{"id":"e9","kind":"message.delta"',
					approxTokens: 90000,
					guidance: "Result truncated by the Code Mode gateway",
				},
			},
		}));
		// Silence is what made `tedix tail` print nothing for a real run: a page the
		// gateway will not return must surface as an error, never as "no events".
		await expect(
			client.readHomeRunEvents({ homeRunId: "r", offset: "9", limit: 1 }),
		).rejects.toThrow(/too large for the Code Mode gateway/);
	});

	test("a non-connection error on a read is not retried and never resets", async () => {
		const { client, state } = harness(async () => {
			throw new Error("Invalid params: -32602");
		});
		await expect(client.readHomeRun("r")).rejects.toThrow("Invalid params");
		expect(state.calls).toBe(1); // not retried
		expect(state.closes).toBe(0); // shared client not reset
		expect(state.connects).toBe(1);
	});

	test("a rate-limited read preserves the connection and allows a later retry", async () => {
		const { client, state } = harness(async (callIndex) => {
			if (callIndex === 1) {
				throw new Error('{"error":"Rate limit exceeded","retryAfter":0}');
			}
			return okResult;
		});
		await expect(client.readHomeRun("r")).rejects.toThrow("Rate limit");
		const result = await client.readHomeRun("r");
		expect(isRecordRun(result)).toBe(true);
		expect(state.calls).toBe(2);
		expect(state.closes).toBe(0);
		expect(state.connects).toBe(1);
	});

	test("close releases reads parked behind retryAfter", async () => {
		const { client } = harness(async (callIndex) => {
			if (callIndex === 1) {
				throw new Error('{"error":"Rate limit exceeded","retryAfter":60}');
			}
			return okResult;
		});
		await expect(client.readHomeRun("r")).rejects.toThrow("Rate limit");
		const parkedRead = client.readHomeRun("r");
		await Promise.resolve();
		await client.close();
		const result = await Promise.race([
			parkedRead,
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("cooldown did not release")), 100),
			),
		]);
		expect(isRecordRun(result)).toBe(true);
		await client.close();
	});

	test("a single connection-closed error on a read reconnects once and succeeds", async () => {
		const { client, state } = harness(async (callIndex) => {
			if (callIndex === 1) throw new Error("Connection closed");
			return okResult;
		});
		const result = await client.readHomeRun("r");
		expect(isRecordRun(result)).toBe(true);
		expect(state.calls).toBe(2); // retried once
		expect(state.closes).toBe(1); // reset once
		expect(state.connects).toBe(2); // reconnected once
	});

	test("concurrent reads that both see a dropped transport reconnect once, not in a cascade", async () => {
		// Calls on generation 1 fail (the shared transport dropped); generation 2 works.
		const { client, state } = harness(async (_callIndex, generation) => {
			if (generation === 1) throw new Error("Connection closed");
			return okResult;
		});
		const [a, b] = await Promise.all([
			client.readHomeRun("a"),
			client.readHomeRun("b"),
		]);
		expect(isRecordRun(a)).toBe(true);
		expect(isRecordRun(b)).toBe(true);
		// The generation gate ensures exactly one reset + one reconnect, not a
		// close-cascade where each sibling closes the other's fresh client.
		expect(state.closes).toBe(1);
		expect(state.connects).toBe(2);
	});

	test("settled statuses match Home run terminal and approval states", () => {
		expect(isSettledHomeStatus("completed")).toBe(true);
		expect(isSettledHomeStatus("requires_approval")).toBe(true);
		expect(isSettledHomeStatus("running")).toBe(false);
		expect(isSettledHomeStatus(undefined)).toBe(false);
	});

	// KEYSTONE: failed/canceled runs must NOT exit 0 (fix #1)
	test("parseHomeRunEventsPage: run.failed with matching terminalEventId → status=failed", () => {
		const page = parseHomeRunEventsPage({
			events: [
				{ id: "e0", kind: "run_start" },
				{ id: "e1", kind: "run_failed" },
				{ id: "e2", kind: "submission.settled" },
			],
			stream: { offset: 0, nextOffset: 3, closed: true, terminalEventId: "e1" },
		});
		expect(page.status).toBe("failed");
		expect(isSettledHomeStatus(page.status)).toBe(true);
	});

	test("parseHomeRunEventsPage: run.failed trailing submission.settled, no terminalEventId → still failed (keystone)", () => {
		// The durable ledger's submission.settled trails run.failed; without
		// terminalEventId the old code would trust the last event (submission.settled)
		// and return "completed". The fix must scan all events.
		const page = parseHomeRunEventsPage({
			events: [
				{ id: "e0", kind: "run_start" },
				{ id: "e1", kind: "run_failed" },
				{ id: "e2", kind: "submission.settled" },
			],
			stream: { offset: 0, nextOffset: 3, closed: true },
		});
		expect(page.status).toBe("failed");
	});

	test("parseHomeRunEventsPage: run.canceled trailing submission.settled, no terminalEventId → canceled", () => {
		const page = parseHomeRunEventsPage({
			events: [
				{ id: "e0", kind: "run_start" },
				{ id: "e1", kind: "run.canceled" },
				{ id: "e2", kind: "submission.settled" },
			],
			stream: { offset: 0, nextOffset: 3, closed: true },
		});
		expect(page.status).toBe("canceled");
	});

	test("parseHomeRunEventsPage: subagent.failed trailing submission.settled → failed", () => {
		const page = parseHomeRunEventsPage({
			events: [
				{ id: "e0", kind: "run_start" },
				{ id: "e1", kind: "subagent.failed" },
				{ id: "e2", kind: "submission.settled" },
			],
			stream: { offset: 0, nextOffset: 3, closed: true },
		});
		expect(page.status).toBe("failed");
	});

	test("parseHomeRunEventsPage: approval.rejected → requires_approval via scan", () => {
		const page = parseHomeRunEventsPage({
			events: [
				{ id: "e0", kind: "run_start" },
				{ id: "e1", kind: "approval.rejected" },
			],
			stream: { offset: 0, nextOffset: 2, closed: true },
		});
		// approval.rejected matches /approval|approve|await/ → requires_approval
		// (isSettledHomeStatus covers this so the CLI does not exit 0 on it)
		expect(page.status).toBe("requires_approval");
		expect(isSettledHomeStatus(page.status)).toBe(true);
	});

	// Fix #2: closed stream with terminalEventId not found → 'unknown'
	test("parseHomeRunEventsPage: closed stream with terminalEventId not in events → unknown", () => {
		const page = parseHomeRunEventsPage({
			events: [{ id: "e0", kind: "run_start" }],
			stream: {
				offset: 0,
				nextOffset: 1,
				closed: true,
				terminalEventId: "e99-not-present",
			},
		});
		expect(page.status).toBe("unknown");
	});

	// Fix #3: isAuthError narrowing
	test("isAuthError: 401 is an auth error", () => {
		expect(isAuthError(new Error("HTTP 401 Unauthorized"))).toBe(true);
	});

	test("isAuthError: 'unauthorized' string is an auth error", () => {
		expect(isAuthError(new Error("unauthorized"))).toBe(true);
	});

	test("isAuthError: 'invalid token' is an auth error", () => {
		expect(isAuthError(new Error("invalid token provided"))).toBe(true);
	});

	test("isAuthError: 'authentication failed' is an auth error", () => {
		expect(isAuthError(new Error("authentication failed"))).toBe(true);
	});

	test("isAuthError: 403 rate-limit is NOT an auth error", () => {
		// A 403 scope-denial/rate-limit must not trigger re-login.
		expect(isAuthError(new Error("403 Forbidden — rate limit exceeded"))).toBe(
			false,
		);
		expect(isAuthError(new Error("HTTP 403"))).toBe(false);
	});

	test("isAuthError: 'forbidden' alone is NOT an auth error", () => {
		expect(isAuthError(new Error("forbidden"))).toBe(false);
	});

	test("isAuthError: connection errors are not auth errors", () => {
		expect(isAuthError(new Error("connection closed"))).toBe(false);
		expect(isAuthError(new Error("network timeout"))).toBe(false);
	});
});

describe("expired session retry", () => {
	test("recognises the API's expired forwarded-token rejection", () => {
		expect(
			isExpiredSessionError(
				new Error("UNAUTHORIZED: Forwarded MCP user token is expired"),
			),
		).toBe(true);
		// Neighbouring messages from the same guard must NOT trigger a renewal:
		// a token that is not a user token is not going to become one.
		expect(
			isExpiredSessionError(
				new Error("UNAUTHORIZED: Forwarded MCP user token is not a user token"),
			),
		).toBe(false);
		expect(isExpiredSessionError(new Error("rate limited"))).toBe(false);
		expect(isExpiredSessionError(undefined)).toBe(false);
	});
});

describe("CLI request trace receipts", () => {
	const parent = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-00";
	test("preserves explicit header context, caller metadata and header precedence", () => {
		const meta = {
			traceparent: "00-abcdef0123456789abcdef0123456789-abcdef0123456789-01",
			tracestate: "vendor=meta",
			custom: { keep: true },
		};
		const result = createCliRequestTrace(
			{ Traceparent: parent, Tracestate: "vendor=header" },
			meta,
		);
		expect(result.traceId).toBe("01234567-89ab-cdef-0123-456789abcdef");
		expect(result.headers.traceparent).toBe(parent);
		expect(result.meta).toEqual({
			...meta,
			traceparent: parent,
			tracestate: "vendor=header",
		});
		expect(meta.tracestate).toBe("vendor=meta");
		expect(createCliRequestTrace({}, meta).headers.traceparent).toBe(
			meta.traceparent,
		);
	});
	test("replaces malformed or zero context without reflecting arbitrary identifiers", () => {
		for (const invalid of [
			"secret-not-an-id",
			"00-00000000000000000000000000000000-0123456789abcdef-01",
			"00-0123456789abcdef0123456789abcdef-0000000000000000-01",
		]) {
			const result = createCliRequestTrace({
				traceparent: invalid,
				"X-Trace-Id": "secret-not-an-id",
			});
			expect(result.traceId).toMatch(/^[a-f0-9]{8}-[a-f0-9-]{27}$/);
			expect(result.headers.traceparent).not.toBe(invalid);
			expect(result.headers["x-trace-id"]).toBe(result.traceId);
		}
	});
	test("rejects all-zero legacy trace IDs", () => {
		for (const zero of [
			"00000000000000000000000000000000",
			"00000000-0000-0000-0000-000000000000",
		]) {
			expect(createCliRequestTrace({ "X-Trace-Id": zero }).traceId).not.toBe(
				"00000000-0000-0000-0000-000000000000",
			);
		}
	});

	for (const oauth of [false, true]) {
		test(`${oauth ? "OAuth" : "raw"} requests carry independent traces and safe failure receipts`, async () => {
			const seen: Array<{
				headers: Headers;
				body: { params: { _meta: { traceparent: string } } };
			}> = [];
			const client = new TedixHomeClient({
				headers: { "X-Api-Key": "private-api-key" },
				url: "https://example.com/mcp",
				...(oauth
					? {
							oauthProvider: {
								tokens: () => ({
									access_token: "private-oauth-token",
									token_type: "Bearer",
								}),
								clientInformation: () => ({ client_id: "fixture" }),
							} as NonNullable<
								ConstructorParameters<
									typeof TedixHomeClient
								>[0]["oauthProvider"]
							>,
						}
					: {}),
				fetch: async (_url, init) => {
					const body = JSON.parse(String(init?.body));
					seen.push({ body, headers: new Headers(init?.headers) });
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						error: { code: -32603, message: "fixture failed" },
					});
				},
			});
			try {
				const results = await Promise.allSettled([
					client.discoverProtocol(),
					client.discoverProtocol(),
				]);
				expect(seen).toHaveLength(2);
				expect(seen[0]!.headers.get("x-trace-id")).not.toBe(
					seen[1]!.headers.get("x-trace-id"),
				);
				for (let i = 0; i < results.length; i++) {
					const request = seen[i]!;
					expect(request.body.params._meta.traceparent).toBe(
						request.headers.get("traceparent")!,
					);
					const result = results[i]!;
					expect(result.status).toBe("rejected");
					if (result.status !== "rejected") throw new Error("expected failure");
					expect(result.reason.message).toContain(
						`[traceId: ${request.headers.get("x-trace-id")}]`,
					);
					expect(result.reason.message).not.toContain("private-api-key");
					expect(result.reason.message).not.toContain("private-oauth-token");
				}
			} finally {
				await client.close();
			}
		});
	}
});

test("HTTP and network failures retain a request trace and error classification", async () => {
	for (const failure of [new TypeError("fetch failed"), null]) {
		let traceId: string | null = null;
		const client = new TedixHomeClient({
			headers: {},
			url: "https://example.com/mcp",
			fetch: async (_url, init) => {
				traceId = new Headers(init?.headers).get("x-trace-id");
				if (failure) throw failure;
				return new Response("unavailable", { status: 503 });
			},
		});
		try {
			await client.discoverProtocol();
			throw new Error("expected failure");
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toContain(`[traceId: ${traceId}]`);
			if (failure) {
				expect(error).toBeInstanceOf(TypeError);
				expect((error as Error).cause).toBe(failure);
			} else expect((error as Error).message).toContain("503");
		} finally {
			await client.close();
		}
	}
});

test("immutable and shared failures get independent trace receipts", async () => {
	const shared = new TypeError("fetch failed");
	Object.defineProperty(shared, "message", {
		value: "fetch failed",
		configurable: false,
		writable: false,
	});
	Object.freeze(shared);
	const client = new TedixHomeClient({
		headers: {},
		url: "https://example.com/mcp",
		fetch: async () => {
			throw shared;
		},
	});
	try {
		const outcomes = await Promise.allSettled([
			client.discoverProtocol(),
			client.discoverProtocol(),
		]);
		const errors = outcomes.map((outcome) => {
			if (outcome.status !== "rejected") throw new Error("expected rejection");
			return outcome.reason as Error;
		});
		expect(errors[0]).toBeInstanceOf(TypeError);
		expect(errors[1]).toBeInstanceOf(TypeError);
		expect(errors[0]!.message).not.toBe(errors[1]!.message);
		expect(shared.message).toBe("fetch failed");
		for (const error of errors) {
			expect(error.message.match(/traceId:/g)).toHaveLength(1);
			expect(error.cause).toBe(shared);
		}
	} finally {
		await client.close();
	}
});

describe("bounded native calls", () => {
	const provider = {
		tokens: () => ({ access_token: "fictional-token", token_type: "Bearer" }),
		clientInformation: () => ({ client_id: "fictional-cli" }),
	} as NonNullable<
		ConstructorParameters<typeof TedixHomeClient>[0]["oauthProvider"]
	>;
	const response = (id: string, result: unknown) =>
		Response.json({ jsonrpc: "2.0", id, result });
	const options = {
		maxResponseBytes: 4 * 1024 * 1024,
		retryable: false,
		timeoutMs: 1000,
	};
	for (const oauth of [false, true]) {
		const make = (
			fetcher: NonNullable<
				ConstructorParameters<typeof TedixHomeClient>[0]["fetch"]
			>,
		) =>
			new TedixHomeClient({
				headers: {},
				url: "https://fictional.example/mcp",
				fetch: fetcher,
				...(oauth ? { oauthProvider: provider } : {}),
			});
		test(`${oauth ? "OAuth SDK" : "raw"} refuses oversized streaming body and cancels without replay`, async () => {
			let calls = 0,
				cancelled = 0;
			const client = make(async (_url, init) => {
				const b = JSON.parse(String(init?.body));
				if (b.method === "server/discover")
					return response(b.id, { supportedVersions: ["2026-07-28"] });
				calls++;
				return new Response(
					new ReadableStream({
						start(c) {
							c.enqueue(new Uint8Array(4 * 1024 * 1024 + 1).fill(32));
						},
						cancel() {
							cancelled++;
						},
					}),
					{ headers: { "content-type": "application/json" } },
				);
			});
			try {
				await expect(
					client.callTool("fictional_mutation", {}, options),
				).rejects.toThrow("byte limit");
				expect(calls).toBe(1);
				expect(cancelled).toBe(1);
			} finally {
				await client.close();
			}
		});
		test(`${oauth ? "OAuth SDK" : "raw"} caller abort owns pending body and does not poison next invocation`, async () => {
			let cancelled = 0,
				calls = 0;
			let begun!: () => void;
			const started = new Promise<void>((r) => {
				begun = r;
			});
			const client = make(async (_url, init) => {
				const b = JSON.parse(String(init?.body));
				if (b.method === "server/discover")
					return response(b.id, { supportedVersions: ["2026-07-28"] });
				if (++calls === 1)
					return new Response(
						new ReadableStream({
							start() {
								begun();
							},
							pull() {
								return new Promise(() => {});
							},
							cancel() {
								cancelled++;
							},
						}),
						{ headers: { "content-type": "application/json" } },
					);
				return response(b.id, { structuredContent: { ok: true } });
			});
			const abort = new AbortController();
			try {
				const pending = client.callTool(
					"fictional_mutation",
					{},
					{ ...options, signal: abort.signal },
				);
				const outcome = pending.then(
					() => {
						throw new Error("unexpected success");
					},
					(error) => error,
				);
				await started;
				abort.abort(new Error("withdrawn"));
				expect((await outcome).message).toContain("withdrawn");
				expect(cancelled).toBe(1);
				await expect(
					client.callTool("fictional_read", {}, options),
				).resolves.toEqual({ ok: true });
				expect(calls).toBe(2);
			} finally {
				await client.close();
			}
		});
		test(`${oauth ? "OAuth SDK" : "raw"} input continuations share one response quota`, async () => {
			let calls = 0;
			const lengths: number[] = [];
			const client = make(async (_url, init) => {
				const b = JSON.parse(String(init?.body));
				const result =
					b.method === "server/discover"
						? { supportedVersions: ["2026-07-28"] }
						: ++calls === 1
							? {
									resultType: "input_required",
									requestState: "signed-state",
									inputRequests: {
										approval: {
											method: "elicitation/create",
											params: {
												mode: "form",
												requestedSchema: { properties: { reason: {} } },
											},
										},
									},
								}
							: { structuredContent: { padding: "x".repeat(300) } };
				const wire = JSON.stringify({ jsonrpc: "2.0", id: b.id, result });
				lengths.push(new TextEncoder().encode(wire).byteLength);
				return new Response(wire, {
					headers: { "content-type": "application/json" },
				});
			});
			try {
				await expect(
					client.callToolWithDestructiveApproval(
						"fictional_mutation",
						{},
						"fictional approval",
						{ ...options, maxResponseBytes: 600 },
					),
				).rejects.toThrow("byte limit");
				expect(calls).toBe(2);
				expect(lengths.every((n) => n < 600)).toBe(true);
				expect(lengths.reduce((a, b) => a + b, 0)).toBeGreaterThan(600);
			} finally {
				await client.close();
			}
		});
		test(`${oauth ? "OAuth SDK" : "raw"} task progress cannot renew original deadline`, async () => {
			let starts = 0,
				polls = 0;
			const client = make(async (_url, init) => {
				const b = JSON.parse(String(init?.body));
				if (b.method === "server/discover")
					return response(b.id, {
						supportedVersions: ["2026-07-28"],
						capabilities: {
							extensions: { "io.modelcontextprotocol/tasks": {} },
						},
					});
				if (b.method === "tools/call") {
					starts++;
					return response(b.id, {
						resultType: "task",
						...taskBase("fictional-task"),
						status: "working",
					});
				}
				polls++;
				return response(b.id, {
					resultType: "complete",
					...taskBase("fictional-task"),
					status: "working",
					pollIntervalMs: 1,
				});
			});
			try {
				await expect(
					client.callTool(
						"fictional_mutation",
						{},
						{ ...options, timeoutMs: 40 },
					),
				).rejects.toThrow("deadline");
				expect(starts).toBe(1);
				expect(polls).toBeGreaterThan(0);
			} finally {
				await client.close();
			}
		});
		test(`${oauth ? "OAuth SDK" : "raw"} refuses malformed UTF-8 before publication`, async () => {
			const client = make(async (_url, init) => {
				const b = JSON.parse(String(init?.body));
				if (b.method === "server/discover")
					return response(b.id, { supportedVersions: ["2026-07-28"] });
				return new Response(new Uint8Array([0xff]), {
					headers: { "content-type": "application/json" },
				});
			});
			try {
				await expect(
					client.callTool("fictional_read", {}, options),
				).rejects.toThrow();
			} finally {
				await client.close();
			}
		});
		test(`${oauth ? "OAuth SDK" : "raw"} original deadline cancels ignored fetch without retry`, async () => {
			let calls = 0;
			const client = make(async (_url, init) => {
				const b = JSON.parse(String(init?.body));
				if (b.method === "server/discover")
					return response(b.id, { supportedVersions: ["2026-07-28"] });
				calls++;
				return await new Promise<Response>(() => {});
			});
			try {
				await expect(
					client.callTool(
						"fictional_mutation",
						{},
						{ ...options, timeoutMs: 30 },
					),
				).rejects.toThrow("deadline");
				expect(calls).toBe(1);
			} finally {
				await client.close();
			}
		});
	}
	test("aborted destructive queue never starts and retains predecessor serialization", async () => {
		let release!: (v: unknown) => void;
		const started: string[] = [];
		const client = new TedixHomeClient({
			headers: {},
			url: "https://fictional.example/mcp",
			connect: async () => ({
				callTool: async ({ name }) => {
					started.push(name);
					if (name === "first")
						return await new Promise((r) => {
							release = r;
						});
					return { structuredContent: { ok: true } };
				},
				close: async () => {},
			}),
		});
		try {
			const first = client.callToolWithDestructiveApproval(
				"first",
				{},
				"first reason",
				options,
			);
			while (!release) await new Promise((r) => setTimeout(r, 1));
			const abort = new AbortController();
			const second = client.callToolWithDestructiveApproval(
				"second",
				{},
				"second reason",
				{ ...options, signal: abort.signal },
			);
			const outcome = second.then(
				() => {
					throw new Error("unexpected success");
				},
				(error) => error,
			);
			abort.abort(new Error("withdrawn"));
			expect((await outcome).message).toContain("withdrawn");
			const third = client.callToolWithDestructiveApproval(
				"third",
				{},
				"third reason",
				options,
			);
			await new Promise((r) => setTimeout(r, 5));
			expect(started).toEqual(["first"]);
			release({ structuredContent: { ok: true } });
			await first;
			await third;
			expect(started).toEqual(["first", "third"]);
		} finally {
			await client.close();
		}
	});
});

describe("OAuth SDK request-bound SSE resumption", () => {
	const provider = {
		tokens: () => ({ access_token: "fictional-token", token_type: "Bearer" }),
		clientInformation: () => ({ client_id: "fictional-cli" }),
	} as NonNullable<
		ConstructorParameters<typeof TedixHomeClient>[0]["oauthProvider"]
	>;
	for (const mode of ["oversized", "cumulative", "deadline"] as const) {
		test(`resumed GET preserves ${mode} guard without repeating POST`, async () => {
			let posts = 0,
				gets = 0,
				cancelled = 0;
			const lengths: number[] = [];
			const client = new TedixHomeClient({
				headers: {},
				url: "https://fictional.example/mcp",
				oauthProvider: provider,
				fetch: async (_url, init) => {
					if (init?.method === "GET") {
						gets++;
						expect(new Headers(init.headers).get("last-event-id")).toBe(
							"fictional-resume-token",
						);
						if (mode === "deadline")
							return new Response(
								new ReadableStream({
									pull() {
										return new Promise(() => {});
									},
									cancel() {
										cancelled++;
									},
								}),
								{ headers: { "content-type": "text/event-stream" } },
							);
						const bytes =
							mode === "oversized"
								? new Uint8Array(4 * 1024 * 1024 + 1).fill(32)
								: new TextEncoder().encode(
										`data: ${JSON.stringify({ jsonrpc: "2.0", id: "replayed", result: { structuredContent: { padding: "x".repeat(260) } } })}\n\n`,
									);
						lengths.push(bytes.byteLength);
						return new Response(
							new ReadableStream({
								start(c) {
									c.enqueue(bytes);
								},
								cancel() {
									cancelled++;
								},
							}),
							{ headers: { "content-type": "text/event-stream" } },
						);
					}
					const b = JSON.parse(String(init?.body));
					if (b.method === "server/discover") {
						const wire = JSON.stringify({
							jsonrpc: "2.0",
							id: b.id,
							result: { supportedVersions: ["2026-07-28"] },
						});
						lengths.push(new TextEncoder().encode(wire).byteLength);
						return new Response(wire, {
							headers: { "content-type": "application/json" },
						});
					}
					posts++;
					const prime =
						"retry: 1\nid: fictional-resume-token\nevent: priming\ndata: {}\n\n";
					lengths.push(new TextEncoder().encode(prime).byteLength);
					return new Response(prime, {
						headers: { "content-type": "text/event-stream" },
					});
				},
			});
			try {
				await expect(
					client.callTool(
						"fictional_mutation",
						{},
						{
							retryable: false,
							maxResponseBytes: mode === "cumulative" ? 400 : 4 * 1024 * 1024,
							timeoutMs: mode === "deadline" ? 80 : 1000,
						},
					),
				).rejects.toThrow(mode === "deadline" ? "deadline" : "byte limit");
				expect(posts).toBe(1);
				expect(gets).toBe(1);
				expect(cancelled).toBe(1);
				if (mode === "cumulative") {
					expect(lengths.every((n) => n <= 400)).toBe(true);
					expect(lengths.reduce((a, b) => a + b, 0)).toBeGreaterThan(400);
				}
			} finally {
				await client.close();
			}
		});
	}
	test("resumed response succeeds inside the same original quota", async () => {
		let posts = 0,
			gets = 0;
		let requestId = "";
		const client = new TedixHomeClient({
			headers: {},
			url: "https://fictional.example/mcp",
			oauthProvider: provider,
			fetch: async (_url, init) => {
				if (init?.method === "GET") {
					gets++;
					return new Response(
						`data: ${JSON.stringify({ jsonrpc: "2.0", id: requestId, result: { structuredContent: { ok: true } } })}\n\n`,
						{ headers: { "content-type": "text/event-stream" } },
					);
				}
				const b = JSON.parse(String(init?.body));
				if (b.method === "server/discover")
					return Response.json({
						jsonrpc: "2.0",
						id: b.id,
						result: { supportedVersions: ["2026-07-28"] },
					});
				requestId = b.id;
				posts++;
				return new Response(
					"retry: 1\nid: fictional-positive\nevent: priming\ndata: {}\n\n",
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		});
		try {
			await expect(
				client.callTool(
					"fictional_read",
					{},
					{ retryable: false, maxResponseBytes: 600, timeoutMs: 1000 },
				),
			).resolves.toEqual({ ok: true });
			expect(posts).toBe(1);
			expect(gets).toBe(1);
		} finally {
			await client.close();
		}
	});
	test("colliding resumption tokens refuse rather than select another invocation", async () => {
		let posts = 0,
			gets = 0;
		const client = new TedixHomeClient({
			headers: {},
			url: "https://fictional.example/mcp",
			oauthProvider: provider,
			fetch: async (_url, init) => {
				if (init?.method === "GET") {
					gets++;
					throw new Error("ambiguous GET must not fetch");
				}
				const b = JSON.parse(String(init?.body));
				if (b.method === "server/discover")
					return Response.json({
						jsonrpc: "2.0",
						id: b.id,
						result: { supportedVersions: ["2026-07-28"] },
					});
				posts++;
				return new Response(
					"retry: 30\nid: fictional-collision\nevent: priming\ndata: {}\n\n",
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		});
		try {
			const results = await Promise.allSettled([
				client.callTool(
					"fictional_first",
					{},
					{ retryable: false, maxResponseBytes: 600, timeoutMs: 1000 },
				),
				client.callTool(
					"fictional_second",
					{},
					{ retryable: false, maxResponseBytes: 600, timeoutMs: 1000 },
				),
			]);
			for (const result of results) {
				expect(result.status).toBe("rejected");
				if (result.status !== "rejected") throw new Error("unexpected success");
				expect(String(result.reason)).toContain(
					"Ambiguous native SSE resumption identity",
				);
			}
			expect(posts).toBe(2);
			expect(gets).toBe(0);
		} finally {
			await client.close();
		}
	});
	for (const mode of ["input", "task"] as const) {
		test(`resumed ${mode} continuation retains the original cumulative quota`, async () => {
			let posts = 0,
				gets = 0,
				requestId = "",
				cancelled = 0;
			const lengths: number[] = [];
			const client = new TedixHomeClient({
				headers: {},
				url: "https://fictional.example/mcp",
				oauthProvider: provider,
				fetch: async (_url, init) => {
					if (init?.method === "GET") {
						gets++;
						const result =
							mode === "task"
								? {
										resultType: "complete",
										...taskBase("fictional-task"),
										status: "completed",
										result: { structuredContent: { padding: "x".repeat(350) } },
									}
								: { structuredContent: { padding: "x".repeat(350) } };
						const bytes = new TextEncoder().encode(
							`data: ${JSON.stringify({ jsonrpc: "2.0", id: requestId, result })}\n\n`,
						);
						lengths.push(bytes.byteLength);
						return new Response(
							new ReadableStream({
								start(c) {
									c.enqueue(bytes);
								},
								cancel() {
									cancelled++;
								},
							}),
							{ headers: { "content-type": "text/event-stream" } },
						);
					}
					const b = JSON.parse(String(init?.body));
					let result: unknown;
					if (b.method === "server/discover")
						result = {
							supportedVersions: ["2026-07-28"],
							capabilities: {
								extensions: { "io.modelcontextprotocol/tasks": {} },
							},
						};
					else if (b.method === "tools/call" && ++posts === 1)
						result =
							mode === "task"
								? {
										resultType: "task",
										...taskBase("fictional-task"),
										status: "working",
									}
								: {
										resultType: "input_required",
										requestState: "signed-state",
										inputRequests: {
											approval: {
												method: "elicitation/create",
												params: {
													mode: "form",
													requestedSchema: { properties: { reason: {} } },
												},
											},
										},
									};
					else {
						requestId = b.id;
						const prime =
							"retry: 1\nid: fictional-continuation\nevent: priming\ndata: {}\n\n";
						lengths.push(new TextEncoder().encode(prime).byteLength);
						return new Response(prime, {
							headers: { "content-type": "text/event-stream" },
						});
					}
					const wire = JSON.stringify({ jsonrpc: "2.0", id: b.id, result });
					lengths.push(new TextEncoder().encode(wire).byteLength);
					return new Response(wire, {
						headers: { "content-type": "application/json" },
					});
				},
			});
			try {
				await expect(
					client.callToolWithDestructiveApproval(
						"fictional_mutation",
						{},
						"fictional approval",
						{ retryable: false, maxResponseBytes: 700, timeoutMs: 1000 },
					),
				).rejects.toThrow("byte limit");
				expect(posts).toBe(mode === "input" ? 2 : 1);
				expect(gets).toBe(1);
				expect(cancelled).toBe(1);
				expect(lengths.every((n) => n < 700)).toBe(true);
				expect(lengths.reduce((a, b) => a + b, 0)).toBeGreaterThan(700);
			} finally {
				await client.close();
			}
		});
	}
	test("many event IDs retain only the current request token and completed owners retire", async () => {
		let posts = 0,
			gets = 0,
			requestId = "",
			latest = "";
		const client = new TedixHomeClient({
			headers: {},
			url: "https://fictional.example/mcp",
			oauthProvider: provider,
			fetch: async (_url, init) => {
				if (init?.method === "GET") {
					gets++;
					expect(new Headers(init.headers).get("last-event-id")).toBe(latest);
					return new Response(
						`data: ${JSON.stringify({ jsonrpc: "2.0", id: requestId, result: { structuredContent: { ok: true } } })}\n\n`,
						{ headers: { "content-type": "text/event-stream" } },
					);
				}
				const b = JSON.parse(String(init?.body));
				if (b.method === "server/discover")
					return Response.json({
						jsonrpc: "2.0",
						id: b.id,
						result: { supportedVersions: ["2026-07-28"] },
					});
				posts++;
				requestId = b.id;
				let prime = "retry: 1\n";
				for (let i = 0; i < 128; i++) {
					latest = `fictional-${posts}-${i}`;
					prime += `id: ${latest}\nevent: priming\ndata: {}\n\n`;
				}
				return new Response(prime, {
					headers: { "content-type": "text/event-stream" },
				});
			},
		});
		try {
			for (let i = 0; i < 70; i++)
				await expect(
					client.callTool(
						"fictional_read",
						{},
						{ retryable: false, maxResponseBytes: 16384, timeoutMs: 1000 },
					),
				).resolves.toEqual({ ok: true });
			expect(posts).toBe(70);
			expect(gets).toBe(70);
		} finally {
			await client.close();
		}
	});
	test("active registration refusal does not evict a sibling owner", async () => {
		const abort = new AbortController();
		let posts = 0;
		const client = new TedixHomeClient({
			headers: {},
			url: "https://fictional.example/mcp",
			oauthProvider: provider,
			fetch: async (_url, init) => {
				if (init?.method === "GET")
					throw new Error("retry waits past original deadline");
				const b = JSON.parse(String(init?.body));
				if (b.method === "server/discover")
					return Response.json({
						jsonrpc: "2.0",
						id: b.id,
						result: { supportedVersions: ["2026-07-28"] },
					});
				posts++;
				return new Response(
					`retry: 60000\nid: fictional-${b.id}\nevent: priming\ndata: {}\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		});
		try {
			const pending = Array.from({ length: 65 }, () =>
				client
					.callTool(
						"fictional_read",
						{},
						{
							retryable: false,
							maxResponseBytes: 600,
							timeoutMs: 1000,
							signal: abort.signal,
						},
					)
					.then(
						() => new Error("unexpected success"),
						(error) => error,
					),
			);
			const last = await pending[64];
			expect(String(last)).toContain("active resumption limit");
			expect(posts).toBe(65);
			abort.abort(new Error("withdrawn siblings"));
			const others = await Promise.all(pending.slice(0, 64));
			for (const error of others)
				expect(String(error)).toContain("withdrawn siblings");
		} finally {
			abort.abort();
			await client.close();
		}
	});
});
