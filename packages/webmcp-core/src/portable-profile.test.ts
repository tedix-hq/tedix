import { describe, expect, it, vi } from "vite-plus/test";
import {
	bindPortableToolArguments,
	compactPortableResult,
	createPortableRouteAdapter,
	createSameOriginPortableToolCaller,
	executePortableTool,
	selectPortableRoute,
	type PortableRouteContext,
	type PortableWebMcpProfile,
} from "./portable-profile";

describe("createPortableRouteAdapter", () => {
	it("publishes bounded router context through the widget context API", () => {
		const published: PortableRouteContext[] = [];
		const adapter = createPortableRouteAdapter({
			target: { context: (value) => published.push(value) },
			routes: {
				orders: {} as { state?: string },
				"order-detail": {} as { orderId: string },
			},
			pathname: () => "/m/orders/42",
		});

		expect(
			adapter.setRoute("order-detail", {
				params: { orderId: "42" },
				entity: { type: "order", id: "42" },
			}),
		).toEqual({
			pathname: "/m/orders/42",
			routeKey: "order-detail",
			params: { orderId: "42" },
			entity: { type: "order", id: "42" },
		});
		expect(published).toHaveLength(1);
	});
});

describe("createSameOriginPortableToolCaller", () => {
	it("sends only a signed route and exact callable to the dedicated first-party relay", async () => {
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			expect(JSON.parse(String(init?.body))).toEqual({
				token: "signed-capability",
				routeId: "workspaces",
				callable: "os.list_os_workspaces",
				args: { limit: 2 },
			});
			expect(init?.credentials).toBe("same-origin");
			return Response.json({
				result: {
					structuredContent: { executionId: "one", result: { data: [] } },
				},
			});
		});
		const call = createSameOriginPortableToolCaller({
			endpoint: "/_tedix/webmcp/portable-call",
			routeScoped: true,
			fetch: fetchMock as typeof fetch,
		});
		await expect(
			call({
				callable: "os.list_os_workspaces",
				args: { limit: 2 },
				routeCapability: { token: "signed-capability", routeId: "workspaces" },
			}),
		).resolves.toEqual({ data: [] });
		await expect(
			call({ callable: "os.list_os_workspaces", args: {} }),
		).rejects.toThrow("Signed portable route is required");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
	it("calls a validated inner tool through same-origin Code Mode", async () => {
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			expect(body.params).toEqual({
				name: "code",
				arguments: {
					code: 'async () => await os.list_os_workspaces({"limit":25})',
				},
			});
			expect(init?.credentials).toBe("same-origin");
			expect(init?.mode).toBe("same-origin");
			expect(init?.redirect).toBe("error");
			return new Response(
				JSON.stringify({
					result: {
						structuredContent: {
							executionId: "execution-1",
							result: { items: [{ id: "workspace-1" }] },
						},
					},
				}),
			);
		});
		const call = createSameOriginPortableToolCaller({
			fetch: fetchMock as typeof fetch,
		});
		await expect(
			call({ callable: "os.list_os_workspaces", args: { limit: 25 } }),
		).resolves.toEqual({ items: [{ id: "workspace-1" }] });
	});

	it.each([
		"https://example.invalid/mcp",
		"//example.invalid/mcp",
		"/\\example.invalid/mcp",
		"/\n/example.invalid/mcp",
		"mcp",
	])("rejects an unconfined relay endpoint %j before fetch", (endpoint) => {
		const fetchMock = vi.fn();
		expect(() =>
			createSameOriginPortableToolCaller({ endpoint, fetch: fetchMock }),
		).toThrow("Portable MCP endpoint must be a same-origin absolute path");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("preserves a custom same-origin relay path and query", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({ result: { structuredContent: { ok: true } } }),
		);
		const call = createSameOriginPortableToolCaller({
			endpoint: "/api/mcp?version=1",
			fetch: fetchMock,
		});
		await call({ callable: "os.list_os_workspaces", args: {} });
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/mcp?version=1",
			expect.objectContaining({ mode: "same-origin", redirect: "error" }),
		);
	});

	it("rejects callables that could escape the generated expression", async () => {
		const call = createSameOriginPortableToolCaller({
			fetch: vi.fn() as unknown as typeof fetch,
		});
		await expect(
			call({ callable: "os.list();globalThis.bad", args: {} }),
		).rejects.toThrow("Invalid portable callable");
	});
});

describe("executePortableTool", () => {
	it.each(["write", "converge"])(
		"preserves %s failures after cancellation instead of reporting no change",
		async (phase) => {
			const controller = new AbortController();
			const failure = new Error(`${phase} failed after dispatch`);
			const calls: string[] = [];
			await expect(
				executePortableTool({
					tool,
					args: {},
					signal: controller.signal,
					confirm: async () => true,
					call: async (callable) => {
						calls.push(callable);
						if (callable === tool.callable) {
							controller.abort();
							if (phase === "write") throw failure;
						}
						if (callable === tool.action.convergeCallable) throw failure;
						return {};
					},
				}),
			).rejects.toBe(failure);
			expect(calls).toEqual([
				tool.action.prepareCallable,
				tool.callable,
				...(phase === "converge" ? [tool.action.convergeCallable] : []),
			]);
		},
	);

	it.each(["before-start", "prepare", "confirm"])(
		"does not dispatch a write after cancellation at %s",
		async (phase) => {
			const controller = new AbortController();
			const calls: string[] = [];
			const confirm = vi.fn(async () => {
				if (phase === "confirm") controller.abort();
				return true;
			});
			if (phase === "before-start") controller.abort();
			await expect(
				executePortableTool({
					tool,
					args: {},
					signal: controller.signal,
					call: async (callable) => {
						calls.push(callable);
						if (phase === "prepare") controller.abort();
						return {};
					},
					confirm,
				}),
			).resolves.toEqual({ status: "cancelled", changed: false });
			expect(calls).toEqual(
				phase === "before-start" ? [] : [tool.action.prepareCallable],
			);
			expect(confirm).toHaveBeenCalledTimes(phase === "confirm" ? 1 : 0);
		},
	);

	it("still converges after cancellation once a write has been dispatched", async () => {
		const controller = new AbortController();
		const calls: string[] = [];
		await expect(
			executePortableTool({
				tool,
				args: {},
				signal: controller.signal,
				confirm: async () => true,
				call: async (callable) => {
					calls.push(callable);
					if (callable === tool.callable) controller.abort();
					return { callable };
				},
			}),
		).resolves.toEqual({
			status: "completed",
			result: { callable: tool.callable },
			convergence: { callable: tool.action.convergeCallable },
		});
		expect(calls).toEqual([
			tool.action.prepareCallable,
			tool.callable,
			tool.action.convergeCallable,
		]);
	});

	it("compacts read results to the declared fields", async () => {
		await expect(
			executePortableTool({
				tool: {
					callable: "os.get_record",
					name: "get_record",
					description: "Read",
					inputSchema: {},
					annotations: { readOnlyHint: true },
					resultFields: ["id"],
				},
				args: {},
				call: async () => ({ id: "one", privateNote: "hidden" }),
				confirm: async () => false,
			}),
		).resolves.toEqual({ status: "read", result: { id: "one" } });
	});

	it("does not forward inherited fields to preparation or convergence", async () => {
		const args = Object.assign(Object.create({ inherited: "not-owned" }), {
			id: "one",
		});
		const calls: Record<string, unknown>[] = [];
		await executePortableTool({
			tool: {
				...tool,
				action: {
					...tool.action,
					prepareFields: ["id", "inherited"],
					convergeFields: ["id", "inherited"],
				},
			},
			args,
			call: async (_callable, input) => {
				calls.push(input);
				return {};
			},
			confirm: async () => true,
		});
		expect(calls[0]).toEqual({ id: "one" });
		expect(calls[2]).toEqual({ id: "one" });
	});

	const tool = {
		callable: "acme.orders_update",
		name: "update_order",
		description: "Update an order",
		inputSchema: {},
		action: {
			prepareCallable: "acme.orders_preview_update",
			convergeCallable: "acme.orders_get",
			confirmationTitle: "Update this order?",
			confirmationLabel: "Update order",
		},
		annotations: { readOnlyHint: false },
	};
	it("never calls the writer when confirmation is cancelled", async () => {
		const calls: string[] = [];
		await expect(
			executePortableTool({
				tool,
				args: { orderId: "42" },
				call: async (callable) => {
					calls.push(callable);
					return { orderId: "42" };
				},
				confirm: async () => false,
			}),
		).resolves.toEqual({ status: "cancelled", changed: false });
		expect(calls).toEqual(["acme.orders_preview_update"]);
	});

	it("orders prepare, confirmation, execute, then convergence", async () => {
		const events: string[] = [];
		await expect(
			executePortableTool({
				tool,
				args: { orderId: "42" },
				call: async (callable) => {
					events.push(callable);
					return { callable };
				},
				confirm: async () => {
					events.push("human-confirmed");
					return true;
				},
			}),
		).resolves.toEqual({
			status: "completed",
			result: { callable: "acme.orders_update" },
			convergence: { callable: "acme.orders_get" },
		});
		expect(events).toEqual([
			"acme.orders_preview_update",
			"human-confirmed",
			"acme.orders_update",
			"acme.orders_get",
		]);
	});

	it("projects only declared fields into write preparation and convergence", async () => {
		const calls: Array<{ callable: string; args: Record<string, unknown> }> =
			[];
		await executePortableTool({
			tool: {
				...tool,
				action: {
					...tool.action,
					prepareFields: ["id"],
					convergeFields: ["id"],
				},
			},
			args: { id: "item-1", body: "confirmed comment" },
			call: async (callable, args) => {
				calls.push({ callable, args });
				return {};
			},
			confirm: async () => true,
		});
		expect(calls).toEqual([
			{ callable: "acme.orders_preview_update", args: { id: "item-1" } },
			{
				callable: "acme.orders_update",
				args: { id: "item-1", body: "confirmed comment" },
			},
			{ callable: "acme.orders_get", args: { id: "item-1" } },
		]);
	});
});

const profile: PortableWebMcpProfile = {
	version: 1,
	routes: [
		{
			id: "order-detail",
			match: { pathname: "/m/order/:orderId" },
			tools: [
				{
					callable: "acme_staging.get_order",
					name: "get_current_order",
					description: "Read the current order",
					inputSchema: { type: "object", additionalProperties: false },
					bind: { orderId: "$route.orderId", revision: "$context.revision" },
					resultFields: ["order.id", "order.status"],
					annotations: { readOnlyHint: true },
				},
			],
		},
	],
};

describe("Portable WebMCP profiles", () => {
	it("selects and extracts route parameters", () => {
		const selected = selectPortableRoute(profile, {
			pathname: "/m/order/42",
		});
		expect(selected?.route.id).toBe("order-detail");
		expect(selected?.routeParams).toEqual({ orderId: "42" });
		expect(
			selectPortableRoute(profile, { pathname: "/m/dashboard" }),
		).toBeNull();
	});

	it("overwrites agent arguments with bound route and context values", () => {
		expect(
			bindPortableToolArguments({
				args: { orderId: "attacker", limit: 5 },
				bindings: profile.routes[0]!.tools[0]!.bind,
				context: { pathname: "/m/order/42", revision: "r7" },
				routeParams: { orderId: "42" },
			}),
		).toEqual({ orderId: "42", limit: 5, revision: "r7" });
	});

	it("returns only configured result fields", () => {
		expect(
			compactPortableResult(
				{
					order: { id: 42, status: "open", privateNote: "hidden" },
				},
				["order.id", "order.status"],
			),
		).toEqual({
			"order.id": 42,
			"order.status": "open",
		});
	});
});
