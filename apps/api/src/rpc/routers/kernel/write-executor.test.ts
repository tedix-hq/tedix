import { MCP_MODERN_PROTOCOL_VERSION } from "@tedix/mcp-shared/protocol";
import { describe, expect, it } from "vite-plus/test";
import { MCP_LIST_MAX_PAGES } from "@tedix/mcp-shared/bounded-list";
import {
	executeApprovedKernelWrite,
	executeApprovedOwnerToolCall,
	type HomeToolWritePayload,
	type KernelWriteExecutorTimings,
	parseHomeToolWritePayload,
	replayToolBaseName,
	resolveReplayCatalogEntry,
	type WriteExecutorEnv,
} from "./write-executor";

/**
 * Approved-write executor tests (v1). Stubs `MCP_SERVICE.fetch` to simulate
 * the provider — covering the stored-payload-only execution, upstream
 * revalidation, user-first → tenant credential fallback, and bounded
 * failures (mirrors execute.test.ts's MCP stub pattern without touching it).
 */

interface RecordedCall {
	url: string;
	headers: Headers;
	method: string;
	params: Record<string, unknown>;
}

/**
 * A 2026-07-28 server echoes the request id, stamps `resultType` on every
 * result, adds SEP-2549 freshness hints to list results, gives every listed
 * tool an object inputSchema and every tool result a content array; the fixtures
 * state only the payload that matters.
 */
function modernReply(
	body: { id?: unknown; method: string },
	json: unknown,
): unknown {
	if (!json || typeof json !== "object") return json;
	const envelope = json as { result?: Record<string, unknown> };
	return {
		...envelope,
		id: body.id,
		...(envelope.result
			? {
					result: {
						resultType: "complete",
						...(body.method.endsWith("/list")
							? { ttlMs: 0, cacheScope: "private" }
							: {}),
						...(body.method === "tools/call" ? { content: [] } : {}),
						...envelope.result,
						...(Array.isArray(envelope.result.tools)
							? {
									tools: envelope.result.tools.map(
										(tool: { inputSchema?: object }) => ({
											...tool,
											inputSchema: { type: "object", ...tool.inputSchema },
										}),
									),
								}
							: {}),
					},
				}
			: {}),
	};
}

/** The request `_meta` envelope the SDK client binds for Home's calls. */
const HOME_REQUEST_META = {
	"io.modelcontextprotocol/protocolVersion": MCP_MODERN_PROTOCOL_VERSION,
	"io.modelcontextprotocol/clientInfo": {
		name: "tedix-home",
		version: "1.0.0",
	},
	"io.modelcontextprotocol/clientCapabilities": {},
};

function mcpService(
	handler: (body: { method: string; params: Record<string, unknown> }) => {
		status?: number;
		json: unknown;
	},
) {
	const calls: RecordedCall[] = [];
	return {
		calls,
		fetch: async (input: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body ?? "{}"));
			const headers = new Headers(init?.headers);
			// The real gateway rejects legacy requests before dispatching tools.
			if (
				headers.get("MCP-Protocol-Version") !== MCP_MODERN_PROTOCOL_VERSION ||
				headers.get("Mcp-Method") !== body.method ||
				body.params?._meta?.["io.modelcontextprotocol/protocolVersion"] !==
					MCP_MODERN_PROTOCOL_VERSION ||
				!body.params?._meta?.["io.modelcontextprotocol/clientCapabilities"] ||
				(body.method === "tools/call" &&
					headers.get("Mcp-Name") !== body.params.name)
			)
				return new Response("Unsupported MCP request", { status: 400 });
			calls.push({
				url: input,
				headers,
				method: body.method,
				params: body.params,
			});
			const { status = 200, json } = handler(body);
			return new Response(JSON.stringify(modernReply(body, json)), {
				status,
				headers: { "content-type": "application/json" },
			});
		},
	};
}

function payload(
	overrides: Partial<HomeToolWritePayload> = {},
): HomeToolWritePayload {
	return {
		kind: "home_tool_write",
		appSlug: "globex-tedix",
		toolName: "globex__create_invoice",
		args: { amount: 100, customerName: "ACME" },
		organizationId: "org-1",
		homeRunId: "run-1",
		conversationId: "home:main",
		initiatedByUserId: "user-123",
		...overrides,
	};
}

function env(
	service: ReturnType<typeof mcpService>,
	overrides: Partial<WriteExecutorEnv> = {},
): WriteExecutorEnv {
	return {
		MCP_SERVICE: service,
		MCP_URL: "https://mcp.tedix.dev",
		PLATFORM_SERVICE_TOKEN: "svc-token",
		...overrides,
	};
}

const LISTED = {
	json: {
		jsonrpc: "2.0",
		id: 1,
		result: {
			tools: [
				{
					name: "globex__create_invoice",
					annotations: { destructiveHint: true },
				},
			],
		},
	},
};

describe("parseHomeToolWritePayload", () => {
	it("verifies a Home write with a distinct authorized read before rendering success", async () => {
		const service = mcpService((body) => ({
			json: {
				jsonrpc: "2.0",
				result:
					body.method === "tools/list"
						? {
								tools: [
									{
										name: "os__create_os_output",
										annotations: { readOnlyHint: false },
									},
									{
										name: "os__get_os_output",
										annotations: { readOnlyHint: true },
									},
								],
							}
						: {
								structuredContent: {
									output: {
										id: "scratch-output",
										status:
											body.params.name === "os__get_os_output"
												? "archived"
												: "active",
									},
								},
							},
			},
		}));
		const result = await executeApprovedKernelWrite({
			env: env(service, { OS_URL: "https://os.example.test" }),
			payload: payload({ toolName: "os__create_os_output", args: {} }),
		});
		expect(result).toMatchObject({
			ok: true,
			data: {
				actionReceipt: {
					verified: true,
					state: "archived",
					url: "https://os.example.test/outputs/scratch-output",
					actor: "kernel on behalf of user:user-123",
				},
			},
		});
		expect(
			service.calls
				.filter((call) => call.method === "tools/call")
				.map((call) => call.params.name),
		).toEqual(["os__create_os_output", "os__get_os_output"]);
	});
	it("round-trips a valid payload and normalizes initiatedByUserId", () => {
		expect(parseHomeToolWritePayload(payload())).toEqual(payload());
		expect(
			parseHomeToolWritePayload(payload({ initiatedByUserId: null })),
		).toEqual(payload({ initiatedByUserId: null }));
	});

	it("keeps a Work-item batch and refuses one on any other tool", () => {
		const base = {
			kind: "home_tool_write",
			appSlug: "tedix-unified",
			organizationId: "org",
			homeRunId: "run",
			conversationId: "home:c",
			initiatedByUserId: "user",
			args: { title: "A" },
			additionalArgs: [{ title: "B" }],
		};
		expect(
			parseHomeToolWritePayload({
				...base,
				toolName: "work.create_work_items",
			})?.additionalArgs,
		).toEqual([{ title: "B" }]);
		expect(
			parseHomeToolWritePayload({ ...base, toolName: "os.rename_os_output" }),
		).toBeNull();
	});

	it("rejects other kinds, missing fields, and non-object args", () => {
		expect(parseHomeToolWritePayload(null)).toBeNull();
		expect(
			parseHomeToolWritePayload({ ...payload(), kind: "workstation.attach" }),
		).toBeNull();
		expect(
			parseHomeToolWritePayload({ ...payload(), toolName: "" }),
		).toBeNull();
		expect(parseHomeToolWritePayload({ ...payload(), args: [1] })).toBeNull();
		expect(
			parseHomeToolWritePayload({ ...payload(), homeRunId: undefined }),
		).toBeNull();
	});
});

describe("executeApprovedKernelWrite", () => {
	it.each([
		"work.respond_work_interaction",
		"work__respond_work_interaction",
		"globex__create_invoice",
	])(
		"forwards human response authority only for the approved Work tool (%s)",
		async (toolName) => {
			const service = mcpService((body) => ({
				json: {
					jsonrpc: "2.0",
					id: 1,
					result:
						body.method === "tools/list"
							? { tools: [{ name: toolName }] }
							: { structuredContent: { ok: true } },
				},
			}));
			const result = await executeApprovedKernelWrite({
				env: env(service),
				payload: payload({ toolName }),
				approvedWorkResponderUserId: "approver-sub",
			});
			expect(result.ok).toBe(true);
			expect(
				service.calls[0]?.headers.get("X-Tedix-Approved-Work-Responder"),
			).toBeNull();
			expect(
				service.calls[1]?.headers.get("X-Tedix-Approved-Work-Responder"),
			).toBe(
				toolName.includes("respond_work_interaction") ? "approver-sub" : null,
			);
			expect(service.calls[1]?.headers.get("X-Tedix-Acting-User")).toBe(
				"user-123",
			);
		},
	);

	it("executes the STORED call once with the acting user", async () => {
		const service = mcpService((body) =>
			body.method === "tools/list"
				? LISTED
				: {
						json: {
							jsonrpc: "2.0",
							id: 1,
							result: {
								structuredContent: { id: "INV-1" },
								isError: false,
							},
						},
					},
		);
		const result = await executeApprovedKernelWrite({
			env: env(service),
			payload: payload(),
		});

		expect(result).toMatchObject({
			ok: true,
			data: {
				id: "INV-1",
				actionReceipt: {
					verified: false,
					actor: "kernel on behalf of user:user-123",
				},
			},
		});
		expect(service.calls.map((c) => c.method)).toEqual([
			"tools/list",
			"tools/call",
		]);
		const call = service.calls[1];
		expect(call?.headers.get("X-Tedix-Host")).toBe(
			"globex-tedix.mcp.tedix.dev",
		);
		expect(call?.headers.get("X-Tedix-Org-Id")).toBe("org-1");
		expect(call?.headers.get("X-Tedix-Acting-User")).toBe("user-123");
		// Tenant control-plane audit marker on BOTH the re-verify list and the
		// write itself (kernel actor in apps/mcp).
		for (const c of service.calls) {
			expect(c.headers.get("X-Tedix-Kernel")).toBe("true");
		}
		// EXACTLY the stored args reach the provider.
		expect(call?.params).toEqual({
			_meta: HOME_REQUEST_META,
			name: "globex__create_invoice",
			arguments: { amount: 100, customerName: "ACME" },
		});
	});

	it.each([undefined, "sample-approval"])(
		"falls back to the tenant credential when the personal one is missing (approval %s)",
		async (approvalRequestId) => {
			// First tools/call (with acting user) reports the missing credential,
			// the retry (without acting user) succeeds.
			let toolCallIndex = 0;
			const service = mcpService((body) => {
				if (body.method === "tools/list") return LISTED;
				toolCallIndex += 1;
				if (toolCallIndex === 1) {
					return {
						json: {
							jsonrpc: "2.0",
							id: 1,
							result: {
								isError: true,
								content: [
									{ type: "text", text: "Connection credential not found" },
								],
							},
						},
					};
				}
				return {
					json: {
						jsonrpc: "2.0",
						id: 1,
						result: { structuredContent: { id: "INV-2" }, isError: false },
					},
				};
			});

			const result = await executeApprovedKernelWrite({
				env: env(service),
				payload: payload(),
				...(approvalRequestId ? { approvalRequestId } : {}),
			});
			expect(result).toMatchObject({
				ok: true,
				data: { id: "INV-2" },
			});
			const toolCalls = service.calls.filter((c) => c.method === "tools/call");
			expect(toolCalls).toHaveLength(2);
			expect(toolCalls[0]?.headers.get("X-Tedix-Acting-User")).toBe("user-123");
			expect(toolCalls[1]?.headers.get("X-Tedix-Acting-User")).toBeNull();
			// The tenant retry names the approval's member only when one exists.
			expect(
				toolCalls[0]?.headers.get("X-Tedix-Approved-Home-User"),
			).toBeNull();
			expect(toolCalls[1]?.headers.get("X-Tedix-Approved-Home-User")).toBe(
				approvalRequestId ? "user-123" : null,
			);
		},
	);

	it.each([
		{
			label: "names the approver on the tenant credential",
			payload: { initiatedByUserId: null },
			approvalRequestId: "sample-approval",
			approvedByUserId: "approver-1",
			expected: "approver-1",
		},
		{
			label: "names nobody without an approval receipt",
			payload: { initiatedByUserId: null },
			approvedByUserId: "approver-1",
			expected: null,
		},
		{
			label: "keeps the initiator's receipt when one asked for the write",
			payload: {},
			approvalRequestId: "sample-approval",
			approvedByUserId: "approver-1",
			expected: null,
		},
	])(
		"an agent-started approved write $label",
		async ({
			payload: overrides,
			approvalRequestId,
			approvedByUserId,
			expected,
		}) => {
			const service = mcpService((body) =>
				body.method === "tools/list"
					? LISTED
					: {
							json: {
								jsonrpc: "2.0",
								id: 1,
								result: { structuredContent: { id: "INV-3" }, isError: false },
							},
						},
			);
			const result = await executeApprovedKernelWrite({
				env: env(service),
				payload: payload(overrides),
				...(approvalRequestId ? { approvalRequestId } : {}),
				approvedByUserId,
			});
			expect(result).toMatchObject({ ok: true });
			const toolCalls = service.calls.filter((c) => c.method === "tools/call");
			expect(toolCalls).toHaveLength(1);
			// The approver never becomes the acting user: no personal credential.
			expect(toolCalls[0]?.headers.get("X-Tedix-Acting-User")).toBe(
				overrides.initiatedByUserId === null ? null : "user-123",
			);
			expect(toolCalls[0]?.headers.get("X-Tedix-Approved-Home-User")).toBe(
				expected,
			);
		},
	);

	it.each([
		"native",
		"approved",
		"denied",
		"ineligible",
		"malformed",
		"read-only",
		"missing",
		"transport",
		"tool-error",
	])(
		"executes the stored write through a fresh descriptor (%s)",
		async (scenario) => {
			const service = mcpService((body) => {
				if (
					body.params.name === "code" &&
					String((body.params.arguments as { code: string }).code).includes(
						"discover.describe",
					)
				) {
					return {
						json: {
							jsonrpc: "2.0",
							result: {
								structuredContent: {
									callable:
										scenario === "missing"
											? "work.another_write"
											: "work.create_work_items",
									annotations: { readOnlyHint: scenario === "read-only" },
									native:
										scenario === "malformed"
											? { name: "unverified" }
											: {
													name: "create_work_items",
													toolRowId: "configured-row",
													endpoint: "workItems/create",
													eligible: scenario !== "ineligible",
													authorized: scenario !== "denied",
													schemaFreshness: {
														source: "rpc",
														sourceRef: "workItems/create",
														sourceHash: "schema-hash",
														syncedAt: "2026-10-01T00:00:00Z",
													},
												},
								},
							},
						},
					};
				}
				if (scenario === "transport") return { status: 503, json: {} };
				return {
					json: {
						jsonrpc: "2.0",
						result: {
							isError: scenario === "tool-error",
							structuredContent: { id: "WI-1" },
							content:
								scenario === "tool-error"
									? [{ type: "text", text: "write refused" }]
									: [],
						},
					},
				};
			});
			const result = await executeApprovedKernelWrite({
				env: env(service),
				...(scenario === "approved"
					? { approvalRequestId: "sample-approval" }
					: {}),
				payload: payload({
					toolName: "work.create_work_items",
					args: { title: "Stored arguments" },
					transport: "codemode",
				}),
			});
			const rejected = [
				"read-only",
				"missing",
				"transport",
				"tool-error",
			].includes(scenario);
			expect(result.ok).toBe(!rejected);
			expect(service.calls.every((call) => call.method === "tools/call")).toBe(
				true,
			);
			const writes = service.calls.filter(
				(call) => call.params.name === "create_work_items",
			);
			const fallback = ["denied", "ineligible", "malformed"].includes(scenario);
			if (["read-only", "missing"].includes(scenario))
				expect(service.calls).toHaveLength(1);
			else if (fallback) {
				expect(writes).toHaveLength(0);
				expect(service.calls[1]?.params).toMatchObject({
					name: "code",
					arguments: {
						code: 'async () => await work.create_work_items({"title":"Stored arguments"})',
					},
				});
			} else {
				expect(writes).toHaveLength(1);
				expect(writes[0]?.params.arguments).toEqual({
					title: "Stored arguments",
				});
				if (scenario === "approved") {
					expect(service.calls[0]?.params._meta).not.toHaveProperty(
						"com.tedix/homeApprovalRequestId",
					);
					expect(writes[0]?.params._meta).toMatchObject({
						"com.tedix/homeApprovalRequestId": "sample-approval",
						"com.tedix/homeApprovalToolName": "work.create_work_items",
					});
				}
			}
			for (const call of service.calls) {
				expect(call.headers.get("X-Tedix-Org-Id")).toBe("org-1");
				expect(call.headers.get("X-Tedix-Acting-User")).toBe("user-123");
				expect(call.headers.get("X-Tedix-Kernel")).toBe("true");
			}
		},
	);

	it("revalidates and executes an approved Code Mode callable", async () => {
		let codeCall = 0;
		const service = mcpService((body) => {
			if (body.method === "tools/list") {
				return {
					json: {
						jsonrpc: "2.0",
						id: 1,
						result: { tools: [{ name: "code" }] },
					},
				};
			}
			codeCall += 1;
			return codeCall === 1
				? {
						json: {
							jsonrpc: "2.0",
							id: 1,
							result: {
								structuredContent: {
									executionId: "exec-discovery",
									result: JSON.stringify([
										{
											callable: "work.create_work_items",
											annotations: { readOnlyHint: false },
											parameters: {
												properties: { title: { type: "string" } },
												required: ["title"],
											},
										},
									]),
								},
							},
						},
					}
				: {
						json: {
							jsonrpc: "2.0",
							id: 1,
							result: {
								structuredContent: {
									executionId: "exec-1",
									result: { id: "WI-1" },
								},
							},
						},
					};
		});
		const timings: KernelWriteExecutorTimings = {};
		const result = await executeApprovedKernelWrite({
			env: env(service),
			payload: payload({
				appSlug: "tedix-unified",
				toolName: "work.create_work_items",
				args: { title: "Release proof" },
				transport: "codemode",
			}),
			timings,
		});

		expect(result).toMatchObject({
			ok: true,
			data: { id: "WI-1", actionReceipt: { verified: false } },
		});
		expect(timings).toEqual({
			revalidateMs: expect.any(Number),
			callMs: expect.any(Number),
			verifyMs: expect.any(Number),
		});
		expect(service.calls.map((call) => call.method)).toEqual([
			"tools/call",
			"tools/call",
			"tools/call",
		]);
		expect(service.calls[0]?.params).toEqual({
			_meta: HOME_REQUEST_META,
			name: "code",
			arguments: {
				code: 'async () => await discover.describe({"callable":"work.create_work_items"})',
			},
		});
		expect(service.calls[1]?.params).toEqual({
			_meta: HOME_REQUEST_META,
			name: "code",
			arguments: {
				code: 'async () => await work.create_work_items({"title":"Release proof"})',
			},
		});
	});

	it("creates each Work item of an approved batch as its own call", async () => {
		const created: string[] = [];
		const service = mcpService((body) => {
			const code = String(
				(body.params as { arguments?: { code?: string } })?.arguments?.code ??
					"",
			);
			if (code.includes("discover.describe"))
				return {
					json: {
						jsonrpc: "2.0",
						id: 1,
						result: {
							structuredContent: {
								executionId: "exec-discovery",
								result: JSON.stringify([
									{
										callable: "work.create_work_items",
										annotations: { readOnlyHint: false },
										parameters: {
											properties: { title: { type: "string" } },
											required: ["title"],
										},
									},
								]),
							},
						},
					},
				};
			if (code.includes("create_work_items")) created.push(code);
			return {
				json: {
					jsonrpc: "2.0",
					id: 1,
					result: {
						structuredContent: {
							executionId: `exec-${created.length}`,
							result: { id: `WI-${created.length}` },
						},
					},
				},
			};
		});
		const result = await executeApprovedKernelWrite({
			env: env(service),
			payload: payload({
				appSlug: "tedix-unified",
				toolName: "work.create_work_items",
				args: { title: "First" },
				additionalArgs: [{ title: "Second" }],
				transport: "codemode",
			}),
		});
		expect(created).toEqual([
			'async () => await work.create_work_items({"title":"First"})',
			'async () => await work.create_work_items({"title":"Second"})',
		]);
		expect(result).toMatchObject({
			ok: true,
			data: { id: "WI-1", batch: [{ id: "WI-2" }] },
		});
	});

	it("fails an approved Code Mode write when the outer code tool reports an inner MCP error", async () => {
		let codeCall = 0;
		const service = mcpService((body) => {
			if (body.method === "tools/list") {
				return {
					json: {
						jsonrpc: "2.0",
						id: 1,
						result: { tools: [{ name: "code" }] },
					},
				};
			}
			codeCall += 1;
			return codeCall === 1
				? {
						json: {
							jsonrpc: "2.0",
							id: 1,
							result: {
								structuredContent: {
									executionId: "exec-discovery",
									result: JSON.stringify([
										{
											callable: "google_gmail.apply_sensitive_thread_label",
											annotations: {
												readOnlyHint: false,
												destructiveHint: true,
											},
											parameters: {
												properties: {
													threadId: { type: "string" },
													labelOption: { type: "string" },
												},
												required: ["threadId", "labelOption"],
											},
										},
									]),
								},
							},
						},
					}
				: {
						json: {
							jsonrpc: "2.0",
							id: 1,
							result: {
								isError: true,
								content: [
									{
										type: "text",
										text: "Execution error: Request had insufficient authentication scopes.",
									},
								],
								structuredContent: {
									error: "Request had insufficient authentication scopes.",
								},
							},
						},
					};
		});

		const result = await executeApprovedKernelWrite({
			env: env(service),
			payload: payload({
				appSlug: "google-gmail-tedix",
				toolName: "google_gmail.apply_sensitive_thread_label",
				args: { threadId: "thread-1", labelOption: "TRASH" },
				transport: "codemode",
			}),
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("insufficient authentication scopes");
		}
		expect(service.calls.map((call) => call.method)).toEqual([
			"tools/call",
			"tools/call",
		]);
	});

	it("fails an approved Code Mode write whose inner tool returned ok:false", async () => {
		let codeCall = 0;
		const service = mcpService((body) => {
			if (body.method === "tools/list") {
				return {
					json: {
						jsonrpc: "2.0",
						id: 1,
						result: { tools: [{ name: "code" }] },
					},
				};
			}
			codeCall += 1;
			const result =
				codeCall === 1
					? JSON.stringify([
							{
								callable: "work.create_work_items",
								annotations: { readOnlyHint: false },
								parameters: {
									properties: { title: { type: "string" } },
									required: ["title"],
								},
							},
						])
					: { ok: false, error: "BAD_REQUEST: PURPOSE_REQUIRED: no purpose" };
			return {
				json: {
					jsonrpc: "2.0",
					id: 1,
					result: { structuredContent: { executionId: "exec-1", result } },
				},
			};
		});

		const result = await executeApprovedKernelWrite({
			env: env(service),
			payload: payload({
				appSlug: "tedix-unified",
				toolName: "work.create_work_items",
				args: { title: "Release proof" },
				transport: "codemode",
			}),
		});

		expect(result).toEqual({
			ok: false,
			error: "BAD_REQUEST: PURPOSE_REQUIRED: no purpose",
		});
	});

	it("fails an approved Code Mode write whose inner tool returned success:false", async () => {
		let codeCall = 0;
		const service = mcpService((body) => {
			if (body.method === "tools/list") {
				return {
					json: {
						jsonrpc: "2.0",
						id: 1,
						result: { tools: [{ name: "code" }] },
					},
				};
			}
			codeCall += 1;
			const result =
				codeCall === 1
					? JSON.stringify([
							{
								callable: "notion.update_page",
								annotations: { readOnlyHint: false },
							},
						])
					: { success: false, message: "Page is archived" };
			return {
				json: {
					jsonrpc: "2.0",
					id: 1,
					result: {
						structuredContent: {
							executionId: "exec-1",
							result,
							failures: [
								{ tool: "notion.update_page", error: "Page is archived" },
							],
						},
					},
				},
			};
		});

		const result = await executeApprovedKernelWrite({
			env: env(service),
			payload: payload({
				appSlug: "tedix-unified",
				toolName: "notion.update_page",
				args: { pageId: "page-1" },
				transport: "codemode",
			}),
		});

		expect(result).toEqual({ ok: false, error: "Page is archived" });
	});

	it.each([
		["ok:false", { ok: false, error: "Invoice locked" }],
		["success:false", { success: false, error: "Invoice locked" }],
		["a bare error", { error: "Invoice locked" }],
	])(
		"fails a direct write whose HTTP-200 result reports %s",
		async (_label, body) => {
			const service = mcpService((request) =>
				request.method === "tools/list"
					? LISTED
					: {
							json: {
								jsonrpc: "2.0",
								id: 1,
								result: { structuredContent: body },
							},
						},
			);
			const result = await executeApprovedKernelWrite({
				env: env(service),
				payload: payload({ initiatedByUserId: null }),
			});
			expect(result).toEqual({ ok: false, error: "Invoice locked" });
		},
	);

	it("executes a direct write whose result carries an empty error field", async () => {
		const service = mcpService((request) =>
			request.method === "tools/list"
				? LISTED
				: {
						json: {
							jsonrpc: "2.0",
							id: 1,
							result: { structuredContent: { id: "inv-1", error: null } },
						},
					},
		);
		const result = await executeApprovedKernelWrite({
			env: env(service),
			payload: payload({ initiatedByUserId: null }),
		});
		expect(result).toMatchObject({
			ok: true,
			data: { id: "inv-1", error: null, actionReceipt: { verified: false } },
		});
	});

	it("aborts (no tools/call) when the stored tool no longer exists upstream", async () => {
		const service = mcpService((body) =>
			body.method === "tools/list"
				? {
						json: {
							jsonrpc: "2.0",
							id: 1,
							result: { tools: [{ name: "globex__something_else" }] },
						},
					}
				: { json: { jsonrpc: "2.0", id: 1, result: {} } },
		);
		const result = await executeApprovedKernelWrite({
			env: env(service),
			payload: payload(),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("no longer available");
		expect(service.calls.map((c) => c.method)).toEqual(["tools/list"]);
	});

	it("executes an approved write whose tool sorts past the first catalog page", async () => {
		const service = mcpService((body) => {
			if (body.method === "tools/list") {
				const cursor = (body.params as { cursor?: string }).cursor;
				return {
					json: {
						jsonrpc: "2.0",
						id: 1,
						result:
							cursor === undefined
								? {
										tools: Array.from({ length: 200 }, (_, i) => ({
											name: `globex__filler_${i}`,
										})),
										nextCursor: "page-2",
									}
								: {
										tools: [
											{
												name: "globex__create_invoice",
												annotations: { destructiveHint: true },
											},
										],
									},
					},
				};
			}
			return {
				json: {
					jsonrpc: "2.0",
					id: 1,
					result: { structuredContent: { id: "INV-9" } },
				},
			};
		});
		const result = await executeApprovedKernelWrite({
			env: env(service),
			payload: payload(),
		});

		expect(result).toMatchObject({
			ok: true,
			data: { id: "INV-9", actionReceipt: { verified: false } },
		});
		expect(
			service.calls
				.filter((call) => call.method === "tools/list")
				.map((call) => call.params.cursor),
		).toEqual([undefined, "page-2"]);
	});

	it("reports a tool unverified — not missing — when the catalog hits the page bound", async () => {
		let page = 0;
		const service = mcpService((body) => {
			if (body.method !== "tools/list") {
				return { json: { jsonrpc: "2.0", id: 1, result: {} } };
			}
			page += 1;
			return {
				json: {
					jsonrpc: "2.0",
					id: 1,
					result: {
						tools: [{ name: `globex__filler_${page}` }],
						nextCursor: `page-${page}`,
					},
				},
			};
		});
		const result = await executeApprovedKernelWrite({
			env: env(service),
			payload: payload(),
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("could not be verified");
			expect(result.error).not.toContain("no longer available");
		}
		// The walk is bounded and no tools/call was attempted.
		expect(page).toBe(MCP_LIST_MAX_PAGES);
		expect(service.calls.every((call) => call.method === "tools/list")).toBe(
			true,
		);
	});

	it("aborts when the stored tool was re-published as read-only", async () => {
		const service = mcpService((body) =>
			body.method === "tools/list"
				? {
						json: {
							jsonrpc: "2.0",
							id: 1,
							result: {
								tools: [
									{
										name: "globex__create_invoice",
										annotations: { readOnlyHint: true },
									},
								],
							},
						},
					}
				: { json: { jsonrpc: "2.0", id: 1, result: {} } },
		);
		const result = await executeApprovedKernelWrite({
			env: env(service),
			payload: payload(),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("read-only");
		expect(service.calls.map((c) => c.method)).toEqual(["tools/list"]);
	});

	it("returns a bounded upstream error on tools/call isError", async () => {
		const longError = "boom ".repeat(200);
		const service = mcpService((body) =>
			body.method === "tools/list"
				? LISTED
				: {
						json: {
							jsonrpc: "2.0",
							id: 1,
							result: {
								isError: true,
								content: [{ type: "text", text: longError }],
							},
						},
					},
		);
		const result = await executeApprovedKernelWrite({
			env: env(service),
			payload: payload({ initiatedByUserId: null }),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.length).toBeLessThanOrEqual(301);
	});

	it("fails-soft when the MCP service binding is unavailable", async () => {
		const result = await executeApprovedKernelWrite({
			env: {},
			payload: payload(),
		});
		expect(result).toEqual({
			ok: false,
			error: "MCP service binding is not configured",
		});
	});
});

describe("factory approval receipt forwarding", () => {
	it.each([
		"projects.create_factory",
		"projects.pause_factory",
		"projects.resume_factory",
		"projects.archive_factory",
		"globex__create_invoice",
	])("restricts factory approval header to %s", async (toolName) => {
		const service = mcpService((body) => ({
			json: {
				jsonrpc: "2.0",
				id: 1,
				result:
					body.method === "tools/list"
						? { tools: [{ name: toolName }] }
						: { structuredContent: { ok: true } },
			},
		}));
		const result = await executeApprovedKernelWrite({
			env: env(service),
			payload: payload({ toolName }),
			approvalRequestId: "sample-approval",
		});
		expect(result.ok).toBe(true);
		expect(
			service.calls[0]?.headers.get("X-Tedix-Approved-Factory-Request"),
		).toBeNull();
		expect(
			service.calls[1]?.headers.get("X-Tedix-Approved-Factory-Request"),
		).toBe(toolName.startsWith("projects.") ? "sample-approval" : null);
		expect(service.calls[0]?.params._meta).not.toHaveProperty(
			"com.tedix/homeApprovalRequestId",
		);
		expect(service.calls[1]?.params._meta).toMatchObject({
			"com.tedix/homeApprovalRequestId": "sample-approval",
		});
	});
});

describe("approved write failure text", () => {
	it("records the gateway's words, not its MCP content array", async () => {
		const service = mcpService((body) => ({
			json: {
				jsonrpc: "2.0",
				id: 1,
				result:
					body.method === "tools/list"
						? { tools: [{ name: "globex__create_invoice" }] }
						: {
								isError: true,
								content: [{ type: "text", text: "Invoice is locked." }],
							},
			},
		}));
		await expect(
			executeApprovedKernelWrite({
				env: env(service),
				payload: payload({ initiatedByUserId: null }),
			}),
		).resolves.toEqual({ ok: false, error: "Invoice is locked." });
	});
});

describe("edited write live validation", () => {
	const approverEdits = {
		editedBy: "approver",
		editedAt: "2026-10-21T10:00:00.000Z",
		changes: [{ field: "customerName", before: "Draft", after: "ACME" }],
	};
	const schema = {
		type: "object",
		properties: {
			amount: { type: "number", maximum: 200 },
			customerName: { type: "string", minLength: 2 },
		},
		required: ["amount", "customerName"],
		additionalProperties: false,
	};

	it.each(["direct", "codemode"] as const)(
		"refuses stale args against the live %s schema",
		async (transport) => {
			const service = mcpService((body) => ({
				json: {
					jsonrpc: "2.0",
					result:
						body.method === "tools/list"
							? {
									tools: [
										{ name: "globex__create_invoice", inputSchema: schema },
									],
								}
							: {
									structuredContent: [
										{ callable: "globex.create_invoice", parameters: schema },
									],
								},
				},
			}));
			const result = await executeApprovedKernelWrite({
				env: env(service),
				payload: payload({
					transport,
					toolName:
						transport === "direct"
							? "globex__create_invoice"
							: "globex.create_invoice",
					args: { amount: 300, customerName: "ACME" },
					approverEdits,
				}),
			});
			expect(result).toMatchObject({
				ok: false,
				error: expect.stringContaining("live tool schema"),
			});
			expect(service.calls).toHaveLength(1);
		},
	);

	it("fails closed when the live schema cannot be validated", async () => {
		const service = mcpService(() => ({
			json: {
				jsonrpc: "2.0",
				result: {
					tools: [
						{
							name: "globex__create_invoice",
							inputSchema: {
								...schema,
								dependentRequired: { customerName: ["amount"] },
							},
						},
					],
				},
			},
		}));
		const result = await executeApprovedKernelWrite({
			env: env(service),
			payload: payload({ approverEdits }),
		});
		expect(result).toMatchObject({
			ok: false,
			error: expect.stringContaining(
				"could not be validated against the live tool schema",
			),
		});
		expect(service.calls).toHaveLength(1);
	});

	it("preserves the edit audit marker when parsing stored payloads", () => {
		expect(parseHomeToolWritePayload(payload({ approverEdits }))).toMatchObject(
			{ approverEdits },
		);
	});

	it("refuses destination edits from older pending cards unless the live tool explicitly permits them", async () => {
		const changed = {
			...approverEdits,
			changes: [{ field: "accountId", before: "a", after: "b" }],
		};
		for (const explicit of [false, true]) {
			const service = mcpService((body) => ({
				json: {
					jsonrpc: "2.0",
					result:
						body.method === "tools/list"
							? {
									tools: [
										{
											name: "globex__create_invoice",
											inputSchema: {
												type: "object",
												properties: { accountId: { type: "string" } },
												required: ["accountId"],
											},
											...(explicit
												? {
														_meta: {
															"com.tedix/policy": {
																approvalEditableFields: ["accountId"],
															},
														},
													}
												: {}),
										},
									],
								}
							: { structuredContent: { ok: true } },
				},
			}));
			const result = await executeApprovedKernelWrite({
				env: env(service),
				payload: payload({ args: { accountId: "b" }, approverEdits: changed }),
			});
			expect(result.ok).toBe(explicit);
			expect(service.calls).toHaveLength(explicit ? 2 : 1);
		}
	});

	it("executes a valid content edit with the requester's credentials", async () => {
		const service = mcpService((body) => ({
			json: {
				jsonrpc: "2.0",
				result:
					body.method === "tools/list"
						? {
								tools: [
									{ name: "globex__create_invoice", inputSchema: schema },
								],
							}
						: { structuredContent: { ok: true } },
			},
		}));
		expect(
			(
				await executeApprovedKernelWrite({
					env: env(service),
					payload: payload({ approverEdits }),
				})
			).ok,
		).toBe(true);
		expect(service.calls[1]?.headers.get("X-Tedix-Acting-User")).toBe(
			"user-123",
		);
	});
});

/**
 * Owner tool approval replay. A programmatic caller's `tools/list` on a Code
 * Mode gateway is the compact surface, so the stored native tool is found
 * through the gateway's own catalog and matched by its wire name across the
 * three ways a tool reaches an organization gateway.
 */
describe("approved owner tool call replay", () => {
	const descope = {
		name: "descope.delete_descope_aih_mcp_client",
		annotations: { readOnlyHint: false, destructiveHint: true },
		wire: {
			name: "tedix__delete_descope_aih_mcp_client",
			endpoint: "descopeAih/deleteMcpClient",
		},
	};
	const native = {
		name: "work.add_comment",
		annotations: { readOnlyHint: false },
		wire: { name: "tedix__add_comment", endpoint: "workItems/addComment" },
	};
	const tenantMcp = {
		name: "notion.notion_update_page",
		annotations: { readOnlyHint: false },
		wire: { name: "notion__notion_update_page", endpoint: null },
	};
	const unbound = { name: "home.ask", annotations: { readOnlyHint: true } };
	const catalog = [native, descope, tenantMcp, unbound];

	it("matches the stored wire name, not the Code Mode namespace, for every mount type", () => {
		// Native tedix tool on the organization gateway.
		expect(resolveReplayCatalogEntry(catalog, "tedix__add_comment")).toBe(
			native,
		);
		// Aggregated platform app: mounted as `tedix__`, projected as `descope.`.
		expect(
			resolveReplayCatalogEntry(
				catalog,
				"tedix__delete_descope_aih_mcp_client",
			),
		).toBe(descope);
		// Tenant MCP app, parked through `connect` and replayed on the
		// organization gateway under its source-qualified name.
		expect(
			resolveReplayCatalogEntry(
				catalog,
				"example_unified_notion__notion_update_page",
			),
		).toBe(tenantMcp);
		expect(
			resolveReplayCatalogEntry(catalog, "tedix__delete_something_else"),
		).toBeUndefined();
		expect(resolveReplayCatalogEntry(catalog, "home.ask")).toBeUndefined();
	});

	it("strips every mount prefix to the tool's own name", () => {
		expect(replayToolBaseName("tedix__delete_descope_aih_mcp_client")).toBe(
			"delete_descope_aih_mcp_client",
		);
		expect(
			replayToolBaseName("example_unified_notion__notion_update_page"),
		).toBe("notion_update_page");
		expect(replayToolBaseName("add_comment")).toBe("add_comment");
	});

	function codeModeGateway(
		entries: unknown[],
		onCall: (params: Record<string, unknown>) => unknown,
	) {
		return mcpService((body) => {
			if (body.method === "tools/list")
				return {
					json: {
						jsonrpc: "2.0",
						id: 1,
						result: {
							tools: [
								{ name: "code", inputSchema: { type: "object" } },
								{ name: "ask", inputSchema: { type: "object" } },
							],
						},
					},
				};
			const code = String(
				(body.params as { arguments?: { code?: string } })?.arguments?.code ??
					"",
			);
			if (body.params.name === "code" && code.includes("discover.search"))
				return {
					json: {
						jsonrpc: "2.0",
						id: 1,
						result: {
							structuredContent: {
								executionId: "exec-lookup",
								result: JSON.stringify(entries),
							},
						},
					},
				};
			return { json: onCall(body.params) };
		});
	}

	const liveEntry = {
		callable: "descope.delete_descope_aih_mcp_client",
		annotations: { readOnlyHint: false, destructiveHint: true },
		native: {
			name: "tedix__delete_descope_aih_mcp_client",
			toolRowId: "row-1",
			endpoint: "descopeAih/deleteMcpClient",
			eligible: false,
			authorized: true,
			schemaFreshness: {
				source: "orpc",
				sourceRef: "descopeAih/deleteMcpClient",
				sourceHash: null,
				syncedAt: null,
			},
		},
	};

	it("finds a native tool the compact tools/list hides and calls it by its wire name with the receipt", async () => {
		const service = codeModeGateway([liveEntry], () => ({
			jsonrpc: "2.0",
			id: 1,
			result: { structuredContent: { success: true, id: "TPA-1" } },
		}));
		const timings: KernelWriteExecutorTimings = {};
		const result = await executeApprovedOwnerToolCall({
			env: env(service),
			payload: {
				appSlug: "example-unified",
				toolId: "tedix__delete_descope_aih_mcp_client",
				args: { id: "TPA-1", mcpServerId: "RS-1", confirmDestructive: true },
				organizationId: "org-1",
				initiatedByUserId: "owner-1",
			},
			approvalRequestId: "approval-1",
			timings,
		});
		expect(result).toEqual({ ok: true, data: { success: true, id: "TPA-1" } });
		const lookup = service.calls.find(
			(call) => call.method === "tools/call" && call.params.name === "code",
		);
		expect(
			String((lookup?.params.arguments as { code: string }).code),
		).toContain('"query":"delete_descope_aih_mcp_client"');
		const call = service.calls.at(-1)!;
		expect(call.params).toEqual({
			_meta: {
				...HOME_REQUEST_META,
				"com.tedix/approvalRequestId": "approval-1",
			},
			name: "tedix__delete_descope_aih_mcp_client",
			arguments: { id: "TPA-1", mcpServerId: "RS-1", confirmDestructive: true },
		});
		expect(call.headers.get("X-Tedix-Acting-User")).toBe("owner-1");
		expect(call.headers.get("X-Tedix-Kernel")).toBe("true");
		expect(timings.revalidateMs).toBeTypeOf("number");
	});

	it("replays a hyphenated connected tool only through its matching wire binding", async () => {
		const service = codeModeGateway(
			[
				{
					callable: "notion.notion_update_page",
					annotations: { readOnlyHint: false },
					wire: { name: "notion-tedix__notion-update-page" },
					_meta: {
						"com.tedix/connectedTool": {
							providerId: "notion",
							toolName: "notion-update-page",
						},
					},
				},
			],
			() => ({
				jsonrpc: "2.0",
				id: 1,
				result: { structuredContent: { success: true } },
			}),
		);
		const result = await executeApprovedOwnerToolCall({
			env: env(service),
			payload: {
				appSlug: "example-unified",
				toolId: "example_unified_notion__notion-update-page",
				target: {
					transport: "mcp",
					providerId: "notion",
					mcpToolName: "notion-update-page",
				},
				args: { page_id: "page-1", command: "insert_content" },
				organizationId: "org-1",
				initiatedByUserId: "owner-1",
			},
			approvalRequestId: "approval-1",
		});
		expect(result).toEqual({ ok: true, data: { success: true } });
		expect(service.calls.at(-1)?.params).toMatchObject({
			name: "notion-tedix__notion-update-page",
			arguments: { page_id: "page-1", command: "insert_content" },
			_meta: { "com.tedix/approvalRequestId": "approval-1" },
		});
	});

	it("refuses ambiguous connected tool bindings", () => {
		const entry = {
			wire: { name: "notion-tedix__notion-update-page", endpoint: null },
			_meta: {
				"com.tedix/connectedTool": {
					providerId: "notion",
					toolName: "notion-update-page",
				},
			},
		};
		const target = {
			transport: "mcp",
			providerId: "notion",
			mcpToolName: "notion-update-page",
		};
		expect(
			resolveReplayCatalogEntry(
				[
					entry,
					{
						...entry,
						wire: { ...entry.wire, name: "other__notion-update-page" },
					},
				],
				"tedix_unified_notion__notion-update-page",
				target,
			),
		).toBeUndefined();
		expect(
			resolveReplayCatalogEntry(
				[entry],
				"tedix_unified_notion__notion-update-page",
				{ ...target, providerId: "other" },
			),
		).toBeUndefined();
	});

	it("reports an unresolvable tool as a retryable platform-side failure", async () => {
		const service = codeModeGateway([], () => {
			throw new Error("must not call");
		});
		const result = await executeApprovedOwnerToolCall({
			env: env(service),
			payload: {
				appSlug: "example-unified",
				toolId: "tedix__delete_descope_aih_mcp_client",
				args: {},
				organizationId: "org-1",
				initiatedByUserId: "owner-1",
			},
			approvalRequestId: "approval-1",
		});
		expect(result).toEqual({
			ok: false,
			error:
				'Tool "tedix__delete_descope_aih_mcp_client" is no longer available on example-unified',
			retryable: true,
		});
	});

	it("keeps a target refusal final", async () => {
		const service = codeModeGateway([liveEntry], () => ({
			jsonrpc: "2.0",
			id: 1,
			result: {
				isError: true,
				content: [{ type: "text", text: "insufficient_scope: platform:admin" }],
			},
		}));
		const result = await executeApprovedOwnerToolCall({
			env: env(service),
			payload: {
				appSlug: "example-unified",
				toolId: "tedix__delete_descope_aih_mcp_client",
				args: {},
				organizationId: "org-1",
				initiatedByUserId: "owner-1",
			},
			approvalRequestId: "approval-1",
		});
		expect(result).toEqual({
			ok: false,
			error: "insufficient_scope: platform:admin",
		});
	});

	it("aborts a tool re-published as read-only", async () => {
		const service = codeModeGateway(
			[{ ...liveEntry, annotations: { readOnlyHint: true } }],
			() => {
				throw new Error("must not call");
			},
		);
		const result = await executeApprovedOwnerToolCall({
			env: env(service),
			payload: {
				appSlug: "example-unified",
				toolId: "tedix__delete_descope_aih_mcp_client",
				args: {},
				organizationId: "org-1",
				initiatedByUserId: "owner-1",
			},
			approvalRequestId: "approval-1",
		});
		expect(result).toMatchObject({ ok: false });
		expect((result as { error: string }).error).toContain("read-only");
	});

	it("uses the full catalog of a gateway without Code Mode", async () => {
		const service = mcpService((body) =>
			body.method === "tools/list"
				? {
						json: {
							jsonrpc: "2.0",
							id: 1,
							result: {
								tools: [{ name: "mail__send", annotations: {} }],
							},
						},
					}
				: {
						json: {
							jsonrpc: "2.0",
							id: 1,
							result: { structuredContent: { ok: true, id: "msg-1" } },
						},
					},
		);
		const result = await executeApprovedOwnerToolCall({
			env: env(service),
			payload: {
				appSlug: "mail",
				toolId: "mail__send",
				args: { to: "a@example.test" },
				organizationId: "org-1",
				initiatedByUserId: "owner-1",
			},
			approvalRequestId: "approval-2",
		});
		expect(result).toEqual({ ok: true, data: { ok: true, id: "msg-1" } });
		expect(service.calls.at(-1)?.params.name).toBe("mail__send");
	});
});
