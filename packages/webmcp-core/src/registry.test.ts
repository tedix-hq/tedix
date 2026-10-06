// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ModelContextLike, WebMcpToolDef } from "./model-context";
import {
	webMcpContextUnavailable,
	webMcpError,
	webMcpResult,
} from "./model-context";
import {
	currentWebMcpInvocationId,
	registerWebMcpScope,
	setModelContextResolverForTests,
	setWebMcpInvocationObserver,
	type WebMcpInvocationEvent,
	webMcpRegistrationStatus,
	webMcpRegisteredToolNames,
} from "./registry";

function tool(name: string): WebMcpToolDef {
	return {
		name,
		description: `${name} description`,
		inputSchema: { type: "object", properties: {} },
		annotations: { readOnlyHint: true, untrustedContentHint: false },
		execute: async () => webMcpResult({ name }),
	};
}

afterEach(() => {
	setModelContextResolverForTests(null);
	setWebMcpInvocationObserver(null);
});

describe("registerWebMcpScope", () => {
	it.each(["registerTool", "provideContext"] as const)(
		"forwards invocation cancellation through %s without changing attribution",
		async (api) => {
			let registered: WebMcpToolDef | undefined;
			setModelContextResolverForTests(() =>
				api === "registerTool"
					? {
							registerTool: (value) => {
								registered = value;
							},
						}
					: {
							provideContext: ({ tools }) => {
								registered = tools[0];
							},
						},
			);
			const observer = vi.fn();
			setWebMcpInvocationObserver(observer);
			const execute = vi.fn<WebMcpToolDef["execute"]>(
				async (_args, options) => {
					options?.signal?.throwIfAborted();
					return webMcpResult({ ok: true });
				},
			);
			registerWebMcpScope("cancellable", [{ ...tool("read_state"), execute }]);
			const controller = new AbortController();
			const options = { signal: controller.signal };
			const args = { limit: 1 };
			await expect(registered!.execute(args, options)).resolves.toEqual(
				webMcpResult({ ok: true }),
			);
			expect(execute).toHaveBeenLastCalledWith(args, options);
			expect(execute.mock.calls[0]?.[1]).toBe(options);
			const reason = new Error("Browser cancelled invocation");
			controller.abort(reason);
			await expect(registered!.execute(args, options)).rejects.toBe(reason);
			await expect(registered!.execute(args)).resolves.toEqual(
				webMcpResult({ ok: true }),
			);
			expect(execute).toHaveBeenLastCalledWith(args, undefined);
			expect(observer.mock.calls.map(([event]) => event.outcome)).toEqual([
				"ok",
				"error",
				"ok",
			]);
			expect(
				new Set(observer.mock.calls.map(([event]) => event.invocationId)).size,
			).toBe(3);
			expect(currentWebMcpInvocationId()).toBeNull();
		},
	);

	it("is a free no-op without a WebMCP surface", () => {
		setModelContextResolverForTests(() => null);
		const dispose = registerWebMcpScope("work", [tool("list_work_items")]);
		expect(webMcpRegisteredToolNames()).toEqual([]);
		dispose();
	});

	it("projects the composed scope set through provideContext", () => {
		const provided: WebMcpToolDef[][] = [];
		const context: ModelContextLike = {
			provideContext: ({ tools }) => provided.push(tools),
		};
		setModelContextResolverForTests(() => context);

		const disposeWork = registerWebMcpScope("work", [
			tool("list_work_items"),
			tool("create_work_item"),
		]);
		registerWebMcpScope("chat", [tool("ask_tedi")]);
		expect(provided.at(-1)?.map((t) => t.name)).toEqual([
			"list_work_items",
			"create_work_item",
			"ask_tedi",
		]);

		disposeWork();
		expect(provided.at(-1)?.map((t) => t.name)).toEqual(["ask_tedi"]);
	});

	it("replaces a re-registered scope instead of duplicating it", () => {
		const provided: WebMcpToolDef[][] = [];
		const context: ModelContextLike = {
			provideContext: ({ tools }) => provided.push(tools),
		};
		setModelContextResolverForTests(() => context);

		registerWebMcpScope("work", [tool("list_work_items")]);
		registerWebMcpScope("work", [tool("get_work_item")]);
		expect(provided.at(-1)?.map((t) => t.name)).toEqual(["get_work_item"]);
	});

	it("drops name collisions across scopes (first registration wins)", () => {
		const context: ModelContextLike = { provideContext: () => {} };
		setModelContextResolverForTests(() => context);
		registerWebMcpScope("a", [tool("list_work_items")]);
		registerWebMcpScope("b", [tool("list_work_items")]);
		expect(webMcpRegisteredToolNames()).toEqual(["list_work_items"]);
	});

	it("passes one AbortSignal to imperative registrations and aborts on dispose", async () => {
		const registered: string[] = [];
		const signals: AbortSignal[] = [];
		const context: ModelContextLike = {
			registerTool: async (t, options) => {
				registered.push(t.name);
				signals.push(options?.signal as AbortSignal);
			},
		};
		setModelContextResolverForTests(() => context);

		const dispose = registerWebMcpScope("work", [
			tool("list_work_items"),
			tool("create_work_item"),
		]);
		expect(registered).toEqual(["list_work_items", "create_work_item"]);
		expect(signals[0]).toBe(signals[1]);
		expect(signals[0]?.aborted).toBe(false);

		dispose();
		expect(signals[0]?.aborted).toBe(true);
		expect(webMcpRegisteredToolNames()).toEqual([]);
	});

	it("aborts the previous projection before replacing a scope", () => {
		const signals: AbortSignal[] = [];
		const context: ModelContextLike = {
			registerTool: (_tool, options) => {
				signals.push(options?.signal as AbortSignal);
			},
		};
		setModelContextResolverForTests(() => context);
		registerWebMcpScope("work", [tool("list_work_items")]);
		registerWebMcpScope("work", [tool("get_work_item")]);
		expect(signals[0]?.aborted).toBe(true);
		expect(signals[1]?.aborted).toBe(false);
	});

	it("records a non-abort registration failure for live diagnostics", async () => {
		const context: ModelContextLike = {
			registerTool: () => Promise.reject(new Error("permission denied")),
		};
		setModelContextResolverForTests(() => context);
		registerWebMcpScope("work", [tool("list_work_items")]);
		await Promise.resolve();
		await Promise.resolve();
		expect(webMcpRegistrationStatus().error).toBe("permission denied");
	});

	it("contains synchronous tool registration failures", async () => {
		const error = new Error("duplicate registration");
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		setModelContextResolverForTests(() => ({
			registerTool: () => {
				throw error;
			},
		}));

		expect(() => registerWebMcpScope("chat", [tool("ask_tedi")])).not.toThrow();
		await Promise.resolve();
		await Promise.resolve();

		expect(webMcpRegistrationStatus().error).toBe("duplicate registration");
		expect(consoleError).toHaveBeenCalledWith(
			"WebMCP tool registration failed",
			error,
		);
		consoleError.mockRestore();
	});

	it("contains synchronous legacy host failures so application controls still mount", () => {
		const error = new Error("stale registration");
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		setModelContextResolverForTests(() => ({
			provideContext: () => {
				throw error;
			},
		}));

		const dispose = registerWebMcpScope("chat", [tool("ask_tedi")]);

		expect(webMcpRegisteredToolNames()).toEqual(["ask_tedi"]);
		expect(webMcpRegistrationStatus().error).toBe("stale registration");
		expect(consoleError).toHaveBeenCalledWith(
			"WebMCP tool registration failed",
			error,
		);
		expect(() => dispose()).not.toThrow();
		consoleError.mockRestore();
	});

	it("double dispose is safe and does not clobber a newer scope", () => {
		const provided: WebMcpToolDef[][] = [];
		const context: ModelContextLike = {
			provideContext: ({ tools }) => provided.push(tools),
		};
		setModelContextResolverForTests(() => context);

		const first = registerWebMcpScope("work", [tool("list_work_items")]);
		registerWebMcpScope("work", [tool("get_work_item")]);
		const projectionCount = provided.length;
		first(); // stale dispose of a replaced scope must not remove the new one
		expect(webMcpRegisteredToolNames()).toEqual(["get_work_item"]);
		expect(provided).toHaveLength(projectionCount);
		first();
		expect(webMcpRegisteredToolNames()).toEqual(["get_work_item"]);
	});
});

describe("invocation observer", () => {
	/** Registers one scope and returns the projected (instrumented) tools. */
	function projectTools(scopeKey: string, tools: WebMcpToolDef[]) {
		const projected: WebMcpToolDef[][] = [];
		const context: ModelContextLike = {
			provideContext: ({ tools: t }) => projected.push(t),
		};
		setModelContextResolverForTests(() => context);
		registerWebMcpScope(scopeKey, tools);
		return projected.at(-1) ?? [];
	}

	it("is a plain passthrough with no observer set", async () => {
		const [projected] = projectTools("work", [tool("list_work_items")]);
		const result = await projected?.execute({});
		expect(result?.structuredContent).toEqual({ name: "list_work_items" });
	});

	it("classifies ok, error, and context_unavailable with a duration", async () => {
		const events: WebMcpInvocationEvent[] = [];
		setWebMcpInvocationObserver((event) => events.push(event));
		const defs: WebMcpToolDef[] = [
			tool("list_work_items"),
			{ ...tool("get_work_item"), execute: async () => webMcpError("nope") },
			{
				...tool("create_work_item"),
				execute: async () => webMcpContextUnavailable("org scope not bound"),
			},
		];
		const projected = projectTools("work", defs);
		for (const t of projected) await t.execute({});

		expect(events.map((e) => [e.tool, e.scope, e.outcome])).toEqual([
			["list_work_items", "work", "ok"],
			["get_work_item", "work", "error"],
			["create_work_item", "work", "context_unavailable"],
		]);
		for (const event of events) {
			expect(Number.isFinite(event.durationMs)).toBe(true);
			expect(event.durationMs).toBeGreaterThanOrEqual(0);
		}
	});

	it("swallows an observer throw without affecting the tool result", async () => {
		setWebMcpInvocationObserver(() => {
			throw new Error("telemetry sink is broken");
		});
		const [projected] = projectTools("work", [tool("list_work_items")]);
		const result = await projected?.execute({});
		expect(result?.structuredContent).toEqual({ name: "list_work_items" });
		expect(result?.isError).toBeUndefined();
	});

	it("records an escaping execute rejection as error and rethrows", async () => {
		const events: WebMcpInvocationEvent[] = [];
		setWebMcpInvocationObserver((event) => events.push(event));
		const [projected] = projectTools("work", [
			{
				...tool("list_work_items"),
				execute: () => Promise.reject(new Error("defect")),
			},
		]);
		await expect(projected?.execute({})).rejects.toThrow("defect");
		expect(events).toEqual([
			expect.objectContaining({
				tool: "list_work_items",
				scope: "work",
				outcome: "error",
			}),
		]);
	});

	it("never touches args or results beyond classification", async () => {
		const events: WebMcpInvocationEvent[] = [];
		setWebMcpInvocationObserver((event) => events.push(event));
		const [projected] = projectTools("work", [tool("list_work_items")]);
		await projected?.execute({ secret: "customer content" });
		expect(events).toHaveLength(1);
		expect(Object.keys(events[0]!).sort()).toEqual([
			"durationMs",
			"invocationId",
			"outcome",
			"scope",
			"tool",
		]);
	});

	it("mints a fresh invocationId per execute", async () => {
		const events: WebMcpInvocationEvent[] = [];
		setWebMcpInvocationObserver((event) => events.push(event));
		const [projected] = projectTools("work", [tool("list_work_items")]);
		await projected?.execute({});
		await projected?.execute({});
		const UUID =
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
		expect(events).toHaveLength(2);
		for (const event of events) expect(event.invocationId).toMatch(UUID);
		expect(events[0]!.invocationId).not.toBe(events[1]!.invocationId);
	});
});

describe("currentWebMcpInvocationId", () => {
	/** Registers one scope and returns the projected (instrumented) tools. */
	function projectTools(scopeKey: string, tools: WebMcpToolDef[]) {
		const projected: WebMcpToolDef[][] = [];
		const context: ModelContextLike = {
			provideContext: ({ tools: t }) => projected.push(t),
		};
		setModelContextResolverForTests(() => context);
		registerWebMcpScope(scopeKey, tools);
		return projected.at(-1) ?? [];
	}

	it("is null outside an execute", () => {
		expect(currentWebMcpInvocationId()).toBeNull();
	});

	it("exposes the id while an execute is in flight and matches the emitted event", async () => {
		const events: WebMcpInvocationEvent[] = [];
		setWebMcpInvocationObserver((event) => events.push(event));
		let observedDuringExecute: string | null = null;
		const [projected] = projectTools("work", [
			{
				...tool("list_work_items"),
				execute: async () => {
					// Cross an await boundary before reading, as a real tool's
					// osApi call would.
					await Promise.resolve();
					observedDuringExecute = currentWebMcpInvocationId();
					return webMcpResult({ ok: true });
				},
			},
		]);
		await projected?.execute({});
		expect(observedDuringExecute).toBe(events[0]!.invocationId);
		expect(currentWebMcpInvocationId()).toBeNull();
	});

	it("clears the ambient id when an execute rejects, even with no observer", async () => {
		const [projected] = projectTools("work", [
			{
				...tool("list_work_items"),
				execute: () => Promise.reject(new Error("defect")),
			},
		]);
		await expect(projected?.execute({})).rejects.toThrow("defect");
		expect(currentWebMcpInvocationId()).toBeNull();
	});

	it("does not let an older execute finishing clear a newer execute's id", async () => {
		let releaseSlow: () => void = () => {};
		const slowGate = new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});
		let releaseNewer: () => void = () => {};
		const newerGate = new Promise<void>((resolve) => {
			releaseNewer = resolve;
		});
		const [slow, newer] = projectTools("work", [
			{
				...tool("slow_tool"),
				execute: async () => {
					await slowGate;
					return webMcpResult({ ok: true });
				},
			},
			{
				...tool("newer_tool"),
				execute: async () => {
					await newerGate;
					return webMcpResult({ ok: true });
				},
			},
		]);
		const slowPending = slow!.execute({});
		// The overlapping newer execute overwrites the ambient id — the
		// documented best-effort caveat of the single ambient slot.
		const newerPending = newer!.execute({});
		const newerId = currentWebMcpInvocationId();
		expect(newerId).not.toBeNull();
		// The OLDER execute settling must not clear the newer execute's id:
		// its guard sees a slot it no longer owns.
		releaseSlow();
		await slowPending;
		expect(currentWebMcpInvocationId()).toBe(newerId);
		releaseNewer();
		await newerPending;
		expect(currentWebMcpInvocationId()).toBeNull();
	});
});

describe("webMcpRegistrationStatus host reporting", () => {
	it("reports no host, distinguishing it from a route with no tools", () => {
		setModelContextResolverForTests(() => null);
		registerWebMcpScope("work", [tool("list_work_items")]);
		const status = webMcpRegistrationStatus();
		expect(status.host).toEqual({
			detected: false,
			source: null,
			api: "none",
		});
		expect(status.tools).toEqual([]);
		expect(status.generation).toBe(0);
		expect(status.error).toBeNull();
	});

	it("reports a detected host, its source, and its projection API", () => {
		const context: ModelContextLike = { registerTool: () => {} };
		setModelContextResolverForTests(() => ({
			context,
			source: "document" as const,
		}));
		registerWebMcpScope("work", [tool("list_work_items")]);
		const status = webMcpRegistrationStatus();
		expect(status.host).toEqual({
			detected: true,
			source: "document",
			api: "registerTool",
		});
		expect(status.tools).toEqual(["list_work_items"]);
		expect(status.generation).toBe(1);
		expect(status.error).toBeNull();
	});

	it("reports the navigator surface and the legacy provideContext API", () => {
		const context: ModelContextLike = { provideContext: () => {} };
		setModelContextResolverForTests(() => ({
			context,
			source: "navigator" as const,
		}));
		registerWebMcpScope("chat", [tool("ask_tedi")]);
		expect(webMcpRegistrationStatus().host).toEqual({
			detected: true,
			source: "navigator",
			api: "provideContext",
		});
	});

	it("reports a detected but inert host as api none", () => {
		setModelContextResolverForTests(() => ({
			context: {},
			source: "document" as const,
		}));
		expect(webMcpRegistrationStatus().host).toEqual({
			detected: true,
			source: "document",
			api: "none",
		});
	});

	it("hints once per document when registration is dropped for want of a host", () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		try {
			setModelContextResolverForTests(() => null);
			registerWebMcpScope("work", [tool("list_work_items")]);
			registerWebMcpScope("chat", [tool("ask_tedi")]);
			registerWebMcpScope("outputs", [tool("list_outputs")]);
			expect(info).toHaveBeenCalledTimes(1);
			const message = String(info.mock.calls[0]?.[0]);
			expect(message).toContain("no WebMCP host detected");
			expect(message).toContain("window.__tedixWebMcp.status()");
			// Payload-free: no tool names leak into the hint.
			expect(message).not.toContain("list_work_items");
		} finally {
			info.mockRestore();
		}
	});

	it("is inert with a host present", () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		try {
			setModelContextResolverForTests(() => ({
				context: { registerTool: () => {} },
				source: "document" as const,
			}));
			registerWebMcpScope("work", [tool("list_work_items")]);
			expect(info).not.toHaveBeenCalled();
		} finally {
			info.mockRestore();
		}
	});
});

describe("result helpers", () => {
	it("webMcpResult mirrors data into text and structuredContent", () => {
		const result = webMcpResult({ ok: true }, "/work/123");
		expect(result.structuredContent).toEqual({
			ok: true,
			deepLink: "/work/123",
		});
		expect(JSON.parse(result.content[0]!.text)).toEqual({
			ok: true,
			deepLink: "/work/123",
		});
	});

	it("webMcpError flags isError", () => {
		expect(webMcpError("nope").isError).toBe(true);
	});
});
