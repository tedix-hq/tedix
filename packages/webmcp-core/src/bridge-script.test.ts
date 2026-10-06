// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	WEBMCP_BRIDGE_PROTOCOL_VERSION,
	webMcpBridgeScript,
} from "./bridge-script";

/**
 * Runs the emitted bridge module in a controlled scope. `import.meta.url` is
 * only legal inside a real module, so the harness substitutes an injected URL
 * string before evaluating — everything else runs byte-for-byte as shipped.
 */
function runBridge(scope: {
	navigator?: unknown;
	document?: unknown;
	windowOrigin?: string;
	moduleUrl?: string;
	failFetchCount?: number;
}): Array<{
	url: string;
	body: Record<string, unknown>;
	headers: Record<string, string>;
}> {
	const calls: Array<{
		url: string;
		body: Record<string, unknown>;
		headers: Record<string, string>;
	}> = [];
	let remainingFailures = scope.failFetchCount ?? 0;
	const fetchStub = async (url: string, init: RequestInit) => {
		calls.push({
			url,
			body: JSON.parse(String(init.body)) as Record<string, unknown>,
			headers: init.headers as Record<string, string>,
		});
		const failed = remainingFailures-- > 0;
		return {
			ok: !failed,
			json: async () => ({
				...(failed ? { error: { message: "session not ready" } } : {}),
				result: {
					tools: failed
						? []
						: [
								{
									name: "search_site",
									title: "Search",
									description: "Search pages",
									inputSchema: { type: "object" },
									annotations: { readOnlyHint: true },
								},
								{
									name: "read_page",
									title: "Read",
									description: "Read a page",
									inputSchema: { type: "object" },
								},
							],
				},
			}),
		};
	};
	const source = webMcpBridgeScript().replaceAll(
		"import.meta.url",
		"__importMetaUrl",
	);
	const run = new Function(
		"navigator",
		"document",
		"window",
		"fetch",
		"__importMetaUrl",
		source,
	);
	run(
		scope.navigator,
		scope.document,
		{ location: { origin: scope.windowOrigin ?? "https://tenant.example" } },
		fetchStub,
		scope.moduleUrl ??
			"https://tenant.example/_tedix/webmcp/bridge.js?mcp-url=%2F_tedix%2Fwebmcp%2Fmcp",
	);
	return calls;
}

async function settle(): Promise<void> {
	// Two fetch→json promise chains deep; a handful of microtask turns covers it.
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

afterEach(() => {
	vi.useRealTimers();
});

describe("webMcpBridgeScript", () => {
	it("detects current document.modelContext before the navigator compatibility fallback", () => {
		const script = webMcpBridgeScript();
		expect(script).toContain("navigator.modelContext");
		expect(script.indexOf("document.modelContext")).toBeLessThan(
			script.indexOf("navigator.modelContext"),
		);
		expect(script).toContain("import.meta.url");
		expect(script).toContain('searchParams.get("mcp-url")');
		expect(script).toContain("io.modelcontextprotocol/clientInfo");
		expect(script).toContain(WEBMCP_BRIDGE_PROTOCOL_VERSION);
	});

	it("registers each listed tool with a shared AbortSignal", async () => {
		const registered: Array<{
			name: string;
			execute: (a?: unknown) => unknown;
		}> = [];
		const signals: AbortSignal[] = [];
		const calls = runBridge({
			document: {
				modelContext: {
					registerTool: (
						tool: { name: string; execute: () => unknown },
						options: { signal: AbortSignal },
					) => {
						registered.push(tool);
						signals.push(options.signal);
					},
				},
			},
			navigator: {},
		});
		await settle();

		expect(calls[0]?.body.method).toBe("tools/list");
		expect(calls[0]?.url).toBe("https://tenant.example/_tedix/webmcp/mcp");
		expect(registered.map((tool) => tool.name)).toEqual([
			"search_site",
			"read_page",
		]);
		expect(signals[0]).toBe(signals[1]);
		expect(signals[0]?.aborted).toBe(false);

		// The registered execute proxies tools/call with the mcp-name header.
		await registered[0]?.execute({ query: "pricing" });
		await settle();
		expect(calls[1]?.body.method).toBe("tools/call");
		expect(calls[1]?.body.params).toEqual({
			name: "search_site",
			arguments: { query: "pricing" },
		});
		expect(calls[1]?.headers["mcp-name"]).toBe("search_site");
		expect(calls[1]?.headers["mcp-protocol-version"]).toBe(
			WEBMCP_BRIDGE_PROTOCOL_VERSION,
		);
	});

	it("falls back to one provideContext({ tools }) call when registerTool is absent", async () => {
		const provided: Array<{ tools: Array<{ name: string }> }> = [];
		runBridge({
			navigator: undefined,
			document: {
				modelContext: {
					provideContext: (context: { tools: Array<{ name: string }> }) =>
						provided.push(context),
				},
			},
		});
		await settle();

		expect(provided).toHaveLength(1);
		expect(provided[0]?.tools.map((tool) => tool.name)).toEqual([
			"search_site",
			"read_page",
		]);
	});

	it("prefers registerTool when both shapes exist", async () => {
		const registered: string[] = [];
		let providedCalls = 0;
		runBridge({
			navigator: {
				modelContext: {
					registerTool: (tool: { name: string }) => registered.push(tool.name),
					provideContext: () => providedCalls++,
				},
			},
		});
		await settle();
		expect(registered).toEqual(["search_site", "read_page"]);
		expect(providedCalls).toBe(0);
	});

	it("silently no-ops when no WebMCP surface exists", async () => {
		vi.useFakeTimers();
		const calls = runBridge({ navigator: {}, document: {} });
		await vi.advanceTimersByTimeAsync(5_100);
		expect(calls).toHaveLength(0);
	});

	it("waits for a browser-injected modelContext before listing tools", async () => {
		vi.useFakeTimers();
		const registered: string[] = [];
		const documentScope: { modelContext?: unknown } = {};
		const calls = runBridge({ navigator: {}, document: documentScope });
		documentScope.modelContext = {
			registerTool: (tool: { name: string }) => registered.push(tool.name),
		};
		await vi.advanceTimersByTimeAsync(100);
		await settle();
		expect(calls[0]?.body.method).toBe("tools/list");
		expect(registered).toEqual(["search_site", "read_page"]);
	});

	it("retries a transient tools/list failure within the jittered base delay", async () => {
		vi.useFakeTimers();
		const registered: string[] = [];
		const calls = runBridge({
			document: {
				modelContext: {
					registerTool: (tool: { name: string }) => registered.push(tool.name),
				},
			},
			failFetchCount: 1,
		});
		await settle();
		expect(calls).toHaveLength(1);
		// Full jitter: the first retry lands somewhere within the 5s base.
		await vi.advanceTimersByTimeAsync(5_000);
		await settle();
		expect(calls).toHaveLength(2);
		expect(registered).toEqual(["search_site", "read_page"]);
	});

	it("backs off exponentially with full jitter across consecutive failures", async () => {
		vi.useFakeTimers();
		// Pin the jitter so each delay is exactly half the exponential window:
		// 2500ms, 5000ms, 10000ms for attempts 0/1/2 of a 5s base, factor 2.
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const registered: string[] = [];
		const calls = runBridge({
			document: {
				modelContext: {
					registerTool: (tool: { name: string }) => registered.push(tool.name),
				},
			},
			failFetchCount: 3,
		});
		await settle();
		expect(calls).toHaveLength(1);

		// First retry: 0.5 × (5000 × 2^0) = 2500ms — not a moment earlier.
		await vi.advanceTimersByTimeAsync(2_499);
		expect(calls).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		await settle();
		expect(calls).toHaveLength(2);

		// Second retry: 0.5 × (5000 × 2^1) = 5000ms.
		await vi.advanceTimersByTimeAsync(4_999);
		expect(calls).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1);
		await settle();
		expect(calls).toHaveLength(3);

		// Third retry: 0.5 × (5000 × 2^2) = 10000ms — then success registers.
		await vi.advanceTimersByTimeAsync(9_999);
		expect(calls).toHaveLength(3);
		await vi.advanceTimersByTimeAsync(1);
		await settle();
		expect(calls).toHaveLength(4);
		expect(registered).toEqual(["search_site", "read_page"]);
	});

	it("resets the backoff once the endpoint answers", async () => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		// tools/list #1 fails (backoff attempt 0 consumed). tools/list #2 answers
		// — which must reset the backoff — but registration itself rejects, so a
		// retry is scheduled again. Reset means that retry waits the BASE window
		// (2500ms at pinned jitter), not the doubled 5000ms.
		let registerCalls = 0;
		const registered: string[] = [];
		const calls = runBridge({
			document: {
				modelContext: {
					registerTool: (tool: { name: string }) => {
						if (registerCalls++ < 2) {
							return Promise.reject(new Error("surface not ready"));
						}
						registered.push(tool.name);
						return undefined;
					},
				},
			},
			failFetchCount: 1,
		});
		await settle();
		expect(calls).toHaveLength(1);

		// Failed fetch → first retry at 2500ms.
		await vi.advanceTimersByTimeAsync(2_500);
		await settle();
		expect(calls).toHaveLength(2);

		// The fetch answered (reset) but registration rejected → the next retry is
		// scheduled from the BASE window again: due at 2500ms, NOT 5000ms.
		await vi.advanceTimersByTimeAsync(2_500);
		await settle();
		expect(calls).toHaveLength(3);
		expect(registered).toEqual(["search_site", "read_page"]);
	});

	it("silently no-ops when the endpoint is cross-origin", async () => {
		const calls = runBridge({
			navigator: { modelContext: { registerTool: () => {} } },
			windowOrigin: "https://other.example",
		});
		await settle();
		expect(calls).toHaveLength(0);
	});

	it("derives the /mcp endpoint from the bridge path when mcp-url is absent", async () => {
		const calls = runBridge({
			navigator: { modelContext: { registerTool: () => {} } },
			moduleUrl: "https://tenant.example/_tedix/webmcp/bridge.js",
		});
		await settle();
		expect(calls[0]?.url).toBe("https://tenant.example/_tedix/webmcp/mcp");
	});
});
