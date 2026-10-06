import { describe, expect, it, vi } from "vite-plus/test";
import {
	jsonRpcEnvelopeErrorResponse,
	unsupportedProtocolVersionResponse,
} from "./index";
import {
	isCompleteTaskNotificationState,
	McpSubscriptionDurableObject,
} from "./subscriptions";

async function readSseMessage(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	bufferState: { buffer: string },
): Promise<Record<string, unknown>> {
	const decoder = new TextDecoder();
	for (let i = 0; i < 10; i++) {
		const boundary = bufferState.buffer.indexOf("\n\n");
		if (boundary >= 0) {
			const frame = bufferState.buffer.slice(0, boundary);
			bufferState.buffer = bufferState.buffer.slice(boundary + 2);
			const data = frame
				.split(/\r?\n/)
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trimStart())
				.join("\n");
			if (data) return JSON.parse(data) as Record<string, unknown>;
		}
		const { value, done } = await reader.read();
		if (done) break;
		bufferState.buffer += decoder.decode(value, { stream: true });
	}
	throw new Error(`no SSE message received: ${bufferState.buffer}`);
}

function makeSubscriptionRequest(body: Record<string, unknown>): Request {
	return new Request("https://mcp-subscriptions.internal/listen", {
		method: "POST",
		body: JSON.stringify({
			mcpUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
			authHeaders: {},
			corsOrigin: "https://client.example",
			organizationId: "org-1",
			...body,
		}),
	});
}

describe("McpSubscriptionDurableObject — cross-tenant fan-out", () => {
	// The subscription do is sharded by appId, so one instance holds subscribers
	// from every organization connected to a shared or aggregate app. The org
	// comparison is therefore the only tenant boundary inside it. It used to read
	// `if (event.organizationId && subscription.input.organizationId)`, skipping
	// the check whenever either side was null — and `publishMcpInventoryListChanged`
	// omitted the org entirely, so every `*_list_changed` publish was delivered to
	// every tenant on the app.
	it("does not deliver an org-less event to an org-scoped subscriber", async () => {
		const durableObject = new McpSubscriptionDurableObject(
			{} as DurableObjectState,
			{} as CloudflareEnv,
		);
		const response = await durableObject.fetch(
			makeSubscriptionRequest({
				requestId: "sub-tenant-a",
				organizationId: "org-a",
				params: { notifications: { toolsListChanged: true } },
			}),
		);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("missing response body");
		const buffer = { buffer: "" };
		try {
			await readSseMessage(reader, buffer); // ack
			const publish = await durableObject.fetch(
				new Request("https://mcp-subscriptions.internal/publish", {
					method: "POST",
					body: JSON.stringify({
						// No organizationId — the exact shape the inventory publisher sent.
						method: "notifications/tools/list_changed",
					}),
				}),
			);
			expect(await publish.json()).toMatchObject({ ok: true, delivered: 0 });
		} finally {
			await reader.cancel().catch(() => undefined);
		}
	});

	it("does not deliver one tenant's event to another tenant's subscriber", async () => {
		const durableObject = new McpSubscriptionDurableObject(
			{} as DurableObjectState,
			{} as CloudflareEnv,
		);
		const response = await durableObject.fetch(
			makeSubscriptionRequest({
				requestId: "sub-tenant-a",
				organizationId: "org-a",
				params: { notifications: { toolsListChanged: true } },
			}),
		);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("missing response body");
		const buffer = { buffer: "" };
		try {
			await readSseMessage(reader, buffer); // ack
			const publish = await durableObject.fetch(
				new Request("https://mcp-subscriptions.internal/publish", {
					method: "POST",
					body: JSON.stringify({
						organizationId: "org-b",
						method: "notifications/tools/list_changed",
					}),
				}),
			);
			expect(await publish.json()).toMatchObject({ ok: true, delivered: 0 });
		} finally {
			await reader.cancel().catch(() => undefined);
		}
	});
});

describe("McpSubscriptionDurableObject", () => {
	it("recognizes only complete DetailedTask notification snapshots", () => {
		expect(
			isCompleteTaskNotificationState({
				taskId: "task-working",
				status: "working",
				createdAt: "2026-06-29T00:00:00.000Z",
				lastUpdatedAt: "2026-06-29T00:00:01.000Z",
				ttlMs: 30_000,
			}),
		).toBe(true);
		expect(
			isCompleteTaskNotificationState({
				taskId: "task-completed",
				status: "completed",
				createdAt: "2026-06-29T00:00:00.000Z",
				lastUpdatedAt: "2026-06-29T00:00:01.000Z",
				ttlMs: null,
			}),
		).toBe(false);
		expect(
			isCompleteTaskNotificationState({
				taskId: "task-failed",
				status: "failed",
				createdAt: "2026-06-29T00:00:00.000Z",
				lastUpdatedAt: "2026-06-29T00:00:01.000Z",
				ttlMs: null,
				error: { message: "missing code" },
			}),
		).toBe(false);
	});

	it("opens an SSE stream with the mandatory subscription acknowledgment", async () => {
		const durableObject = new McpSubscriptionDurableObject(
			{} as DurableObjectState,
			{} as CloudflareEnv,
		);

		const response = await durableObject.fetch(
			makeSubscriptionRequest({
				requestId: "sub-1",
				params: { notifications: { taskIds: ["task-1"] } },
			}),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toContain("text/event-stream");
		expect(response.headers.get("X-Accel-Buffering")).toBe("no");
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
			"https://client.example",
		);

		const reader = response.body?.getReader();
		if (!reader) throw new Error("missing response body");
		try {
			const message = await readSseMessage(reader, { buffer: "" });
			expect(message).toMatchObject({
				jsonrpc: "2.0",
				method: "notifications/subscriptions/acknowledged",
				params: {
					_meta: { "io.modelcontextprotocol/subscriptionId": "sub-1" },
					notifications: { taskIds: ["task-1"] },
				},
			});
		} finally {
			await reader.cancel().catch(() => undefined);
		}
	});

	it("fans out published tool-list changes to matching subscriptions", async () => {
		const durableObject = new McpSubscriptionDurableObject(
			{} as DurableObjectState,
			{} as CloudflareEnv,
		);
		const response = await durableObject.fetch(
			makeSubscriptionRequest({
				requestId: "sub-tools",
				params: { notifications: { toolsListChanged: true } },
			}),
		);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("missing response body");
		const buffer = { buffer: "" };
		try {
			await readSseMessage(reader, buffer); // ack
			const publish = await durableObject.fetch(
				new Request("https://mcp-subscriptions.internal/publish", {
					method: "POST",
					body: JSON.stringify({
						organizationId: "org-1",
						method: "notifications/tools/list_changed",
					}),
				}),
			);
			expect(await publish.json()).toMatchObject({ ok: true, delivered: 1 });
			const event = await readSseMessage(reader, buffer);
			expect(event).toMatchObject({
				jsonrpc: "2.0",
				method: "notifications/tools/list_changed",
				params: {
					_meta: { "io.modelcontextprotocol/subscriptionId": "sub-tools" },
				},
			});
		} finally {
			await reader.cancel().catch(() => undefined);
		}
	});

	it("fans out published resource-list changes to matching subscriptions", async () => {
		const durableObject = new McpSubscriptionDurableObject(
			{} as DurableObjectState,
			{} as CloudflareEnv,
		);
		const response = await durableObject.fetch(
			makeSubscriptionRequest({
				requestId: "sub-resources",
				params: { notifications: { resourcesListChanged: true } },
			}),
		);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("missing response body");
		const buffer = { buffer: "" };
		try {
			await readSseMessage(reader, buffer); // ack
			const publish = await durableObject.fetch(
				new Request("https://mcp-subscriptions.internal/publish", {
					method: "POST",
					body: JSON.stringify({
						organizationId: "org-1",
						method: "notifications/resources/list_changed",
					}),
				}),
			);
			expect(await publish.json()).toMatchObject({ ok: true, delivered: 1 });
			const event = await readSseMessage(reader, buffer);
			expect(event).toMatchObject({
				jsonrpc: "2.0",
				method: "notifications/resources/list_changed",
				params: {
					_meta: { "io.modelcontextprotocol/subscriptionId": "sub-resources" },
				},
			});
		} finally {
			await reader.cancel().catch(() => undefined);
		}
	});

	it("accepts the task extension subscription filter", async () => {
		const durableObject = new McpSubscriptionDurableObject(
			{} as DurableObjectState,
			{} as CloudflareEnv,
		);
		const response = await durableObject.fetch(
			makeSubscriptionRequest({
				requestId: "sub-structured-task",
				params: {
					notifications: { taskIds: ["task-structured"] },
				},
			}),
		);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("missing response body");
		const buffer = { buffer: "" };
		try {
			const ack = await readSseMessage(reader, buffer);
			expect(ack).toMatchObject({
				method: "notifications/subscriptions/acknowledged",
				params: {
					_meta: {
						"io.modelcontextprotocol/subscriptionId": "sub-structured-task",
					},
					notifications: {
						taskIds: ["task-structured"],
					},
				},
			});

			const publish = await durableObject.fetch(
				new Request("https://mcp-subscriptions.internal/publish", {
					method: "POST",
					body: JSON.stringify({
						organizationId: "org-1",
						method: "notifications/tasks",
						taskId: "task-structured",
						state: {
							taskId: "task-structured",
							status: "completed",
							createdAt: "2026-06-29T00:00:00.000Z",
							lastUpdatedAt: "2026-06-29T00:00:01.000Z",
							ttlMs: null,
							result: { content: [{ type: "text", text: "done" }] },
						},
					}),
				}),
			);
			expect(await publish.json()).toMatchObject({ ok: true, delivered: 1 });
			const event = await readSseMessage(reader, buffer);
			expect(event).toMatchObject({
				method: "notifications/tasks",
				params: { taskId: "task-structured", status: "completed" },
			});
			const completion = await readSseMessage(reader, buffer);
			expect(completion).toMatchObject({
				id: "sub-structured-task",
				result: {
					resultType: "complete",
					_meta: {
						"io.modelcontextprotocol/subscriptionId": "sub-structured-task",
					},
				},
			});
		} finally {
			await reader.cancel().catch(() => undefined);
		}
	});

	it("does not negotiate retired task subscription shapes", async () => {
		const durableObject = new McpSubscriptionDurableObject(
			{} as DurableObjectState,
			{} as CloudflareEnv,
		);
		const response = await durableObject.fetch(
			makeSubscriptionRequest({
				requestId: "sub-retired-task-status",
				params: {
					taskIds: ["flat-task"],
					notificationTypes: ["notifications/tasks"],
					notifications: {
						notificationTypes: ["notifications/tasks/status"],
						tasks: { taskIds: ["nested-task"] },
					},
				},
			}),
		);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("missing response body");
		try {
			const ack = await readSseMessage(reader, { buffer: "" });
			expect(ack).toMatchObject({
				method: "notifications/subscriptions/acknowledged",
				params: { notifications: {} },
			});
		} finally {
			await reader.cancel().catch(() => undefined);
		}
	});

	it("fans out published task states without waiting for polling", async () => {
		const durableObject = new McpSubscriptionDurableObject(
			{} as DurableObjectState,
			{} as CloudflareEnv,
		);
		const response = await durableObject.fetch(
			makeSubscriptionRequest({
				requestId: "sub-task",
				params: {
					notifications: { taskIds: ["task-1"] },
				},
			}),
		);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("missing response body");
		const buffer = { buffer: "" };
		try {
			await readSseMessage(reader, buffer); // ack
			const publish = await durableObject.fetch(
				new Request("https://mcp-subscriptions.internal/publish", {
					method: "POST",
					body: JSON.stringify({
						organizationId: "org-1",
						method: "notifications/tasks",
						taskId: "task-1",
						state: {
							taskId: "task-1",
							status: "completed",
							createdAt: "2026-06-29T00:00:00.000Z",
							lastUpdatedAt: "2026-06-29T00:00:01.000Z",
							ttlMs: null,
							result: { ok: true },
						},
					}),
				}),
			);
			expect(await publish.json()).toMatchObject({ ok: true, delivered: 1 });
			const event = await readSseMessage(reader, buffer);
			expect(event).toMatchObject({
				jsonrpc: "2.0",
				method: "notifications/tasks",
				params: {
					_meta: { "io.modelcontextprotocol/subscriptionId": "sub-task" },
					taskId: "task-1",
					status: "completed",
					result: { ok: true },
				},
			});
		} finally {
			await reader.cancel().catch(() => undefined);
		}
	});

	it("logs a content-free poll failure and continues to the next task", async () => {
		const originalFetch = globalThis.fetch;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		globalThis.fetch = (async (_input, init) => {
			const taskId = new Headers(init?.headers).get("Mcp-Name");
			if (taskId === "task-failed") {
				throw new Error("outer bearer secret", {
					cause: new TypeError("inner bearer secret"),
				});
			}
			return Response.json({
				jsonrpc: "2.0",
				id: "task-read",
				result: {
					taskId: "task-ok",
					status: "completed",
					createdAt: "2026-06-29T00:00:00.000Z",
					lastUpdatedAt: "2026-06-29T00:00:02.000Z",
					ttlMs: null,
					result: { content: [{ type: "text", text: "done" }] },
				},
			});
		}) as typeof fetch;

		const durableObject = new McpSubscriptionDurableObject(
			{} as DurableObjectState,
			{} as CloudflareEnv,
		);
		const response = await durableObject.fetch(
			makeSubscriptionRequest({
				requestId: "sub-poll-failure",
				params: {
					notifications: { taskIds: ["task-failed", "task-ok"] },
				},
			}),
		);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("missing response body");
		const buffer = { buffer: "" };
		try {
			await readSseMessage(reader, buffer); // ack
			const event = await readSseMessage(reader, buffer);
			expect(event).toMatchObject({
				method: "notifications/tasks",
				params: { taskId: "task-ok", status: "completed" },
			});
			expect(warn.mock.calls[0]?.[0]).toMatchObject({
				component: "mcp.subscription.poller",
				event: "mcp.subscription.task_poll_failed",
				taskId: "task-failed",
				outcome: "unavailable",
				exception: {
					type: "Error",
					message: "Content omitted",
					cause: { type: "TypeError", message: "Content omitted" },
				},
			});
			expect(JSON.stringify(warn.mock.calls)).not.toContain("bearer secret");
		} finally {
			await reader.cancel().catch(() => undefined);
			globalThis.fetch = originalFetch;
			warn.mockRestore();
		}
	});

	it("recovers an incomplete published task state through canonical tasks/get", async () => {
		const originalFetch = globalThis.fetch;
		let fetchCount = 0;
		let releaseInitialPoll: (() => void) | undefined;
		globalThis.fetch = (async () => {
			fetchCount++;
			if (fetchCount === 1) {
				await new Promise<void>((resolve) => {
					releaseInitialPoll = resolve;
				});
			}
			return Response.json({
				jsonrpc: "2.0",
				id: "task-read",
				result: {
					resultType: "complete",
					taskId: "task-recover",
					status: "completed",
					createdAt: "2026-06-29T00:00:00.000Z",
					lastUpdatedAt: "2026-06-29T00:00:02.000Z",
					ttlMs: null,
					result: { content: [{ type: "text", text: "done" }] },
				},
			});
		}) as typeof fetch;

		const durableObject = new McpSubscriptionDurableObject(
			{} as DurableObjectState,
			{} as CloudflareEnv,
		);
		const response = await durableObject.fetch(
			makeSubscriptionRequest({
				requestId: "sub-recover",
				params: { notifications: { taskIds: ["task-recover"] } },
			}),
		);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("missing response body");
		const buffer = { buffer: "" };
		try {
			await readSseMessage(reader, buffer); // ack; initial poll remains paused
			const publish = await durableObject.fetch(
				new Request("https://mcp-subscriptions.internal/publish", {
					method: "POST",
					body: JSON.stringify({
						organizationId: "org-1",
						method: "notifications/tasks",
						taskId: "task-recover",
						state: { taskId: "task-recover", status: "completed" },
					}),
				}),
			);
			expect(await publish.json()).toMatchObject({ ok: true, delivered: 1 });
			const event = await readSseMessage(reader, buffer);
			expect(event).toMatchObject({
				method: "notifications/tasks",
				params: {
					taskId: "task-recover",
					status: "completed",
					result: { content: [{ type: "text", text: "done" }] },
				},
			});
		} finally {
			releaseInitialPoll?.();
			await reader.cancel().catch(() => undefined);
			globalThis.fetch = originalFetch;
		}
	});
});

describe("jsonRpcEnvelopeErrorResponse (subscriptions/listen fast path)", () => {
	it("answers method-not-found (-32601) with HTTP 404 for the modern fast path, body unchanged", async () => {
		const response = jsonRpcEnvelopeErrorResponse(
			{ body: { jsonrpc: "2.0", id: "sub-404" }, isSingleItemBatch: false },
			-32601,
			"Method not found: subscriptions/listen is not configured for this MCP Worker",
		);
		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toMatchObject({
			jsonrpc: "2.0",
			id: "sub-404",
			error: { code: -32601 },
		});
	});

	it("keeps ladder and version codes on HTTP 400 and echoes the request id", async () => {
		for (const code of [-32600, -32020, -32021, -32022]) {
			const response = jsonRpcEnvelopeErrorResponse(
				{ body: { jsonrpc: "2.0", id: 7 }, isSingleItemBatch: false },
				code,
				"rejected",
			);
			expect(response.status).toBe(400);
			await expect(response.json()).resolves.toMatchObject({
				id: 7,
				error: { code },
			});
		}
	});
});

describe("unsupportedProtocolVersionResponse", () => {
	it("echoes a parseable JSON-RPC request id", async () => {
		const response = await unsupportedProtocolVersionResponse(
			new Request("https://example.test/mcp", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: "req-42",
					method: "tools/list",
				}),
			}),
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			jsonrpc: "2.0",
			id: "req-42",
			error: { code: -32022 },
		});
	});

	it("uses null when the request id cannot be parsed", async () => {
		const response = await unsupportedProtocolVersionResponse(
			new Request("https://example.test/mcp", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "not-json",
			}),
		);
		expect(await response.json()).toMatchObject({ jsonrpc: "2.0", id: null });
	});

	it("rejects an oversized body with 413 without parsing it", async () => {
		const response = await unsupportedProtocolVersionResponse(
			new Request("https://example.test/mcp", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": String(4 * 1024 * 1024 + 1),
				},
				body: "{}",
			}),
		);
		expect(response.status).toBe(413);
		expect(await response.json()).toMatchObject({ error: { code: -32000 } });
	});
});
