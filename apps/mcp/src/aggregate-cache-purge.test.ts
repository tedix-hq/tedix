/**
 * `/__internal/purge-aggregate-cache` — cache busting for the durable aggregate
 * layers, which require explicit invalidation. `stripUnknownTopLevelKeys`
 * validates tool args against the cached schema copy, so without a purge a
 * schema-synced input stays silently stripped until the layers turn over.
 */
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const {
	getApiClient,
	getBySlugWithTools,
	getBySlugsWithTools,
	buildMcpServer,
} = vi.hoisted(() => {
	const getBySlugWithTools = vi.fn();
	const getBySlugsWithTools = vi.fn();
	return {
		getBySlugWithTools,
		getBySlugsWithTools,
		getApiClient: vi.fn(() => ({
			apps: { getBySlugWithTools, getBySlugsWithTools },
		})),
		buildMcpServer: vi.fn(async () => ({}) as unknown),
	};
});

vi.mock("./lib/api-client", () => ({ getApiClient }));
vi.mock("./mcp/server-factory", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./mcp/server-factory")>();
	return { ...actual, buildMcpServer };
});
vi.mock("@tedix/mcp-shared/transport", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@tedix/mcp-shared/transport")>();
	return {
		...actual,
		mountMcp: vi.fn(async () => new Response("{}", { status: 200 })),
	};
});

import worker, { InternalEntrypoint } from "./index";

/** Service-binding callers reach the named entrypoint, never the default. */
function internalFetch(
	request: Request,
	env: CloudflareEnv,
	ctx: ExecutionContext,
): Promise<Response> {
	return new InternalEntrypoint(ctx, env).fetch(request);
}

function createExecutionContext() {
	return {
		waitUntil: vi.fn((promise: Promise<unknown>) => {
			promise.catch(() => {});
		}),
		passThroughOnException: vi.fn(),
	} as unknown as ExecutionContext;
}

function createEnv(overrides: Record<string, unknown> = {}) {
	return {
		ENVIRONMENT: "development",
		MCP_URL: "https://mcp.tedix.tech",
		API_URL: "https://api.tedix.tech",
		MCP_UI_URL: "https://mcp-ui.tedix.tech",
		GIT_SHA: "dev",
		DESCOPE_AIH_BASE_URL: "https://api.descope.com",
		DEFAULT_APP_SLUG: "",
		DO_NOT_TRACK: "1",
		API_SERVICE: { fetch: vi.fn() },
		...overrides,
	} as unknown as CloudflareEnv;
}

function purgeRequest(headers: Record<string, string> = {}) {
	return new Request(
		"https://mcp.tedix.tech/__internal/purge-aggregate-cache",
		{
			method: "POST",
			headers: { "Content-Type": "application/json", ...headers },
			body: JSON.stringify({ reason: "test" }),
		},
	);
}

function discoveryPurgeRequest(headers: Record<string, string> = {}) {
	return new Request(
		"https://mcp.tedix.tech/__internal/purge-discovery-cache",
		{
			method: "POST",
			headers: { "Content-Type": "application/json", ...headers },
			body: JSON.stringify({
				appId: "app-1",
				appResolutionKeys: ["mcp-subdomain:alpha", "custom:alpha.example.com"],
			}),
		},
	);
}

describe("purge-aggregate-cache", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});
	it("rejects callers that are not service bindings", async () => {
		// Same gate as purge-discovery-cache: a public caller must never be able
		// to force global cold rebuilds (that is a cheap DoS on the ~6s fan-out).
		const response = await worker.fetch(
			purgeRequest(),
			createEnv(),
			createExecutionContext(),
		);
		expect(response.status).toBe(403);
	});

	it("deletes every R2 aggregate snapshot, honoring list pagination", async () => {
		const deleted: string[][] = [];
		const pages = [
			{
				objects: [
					{ key: "aggregate-surface/v1/aaaa" },
					{ key: "aggregate-surface/v1/bbbb" },
				],
				truncated: true,
				cursor: "next",
			},
			{
				objects: [{ key: "aggregate-surface/v1/cccc" }],
				truncated: false,
			},
		];
		const list = vi.fn(async () => pages.shift());
		const env = createEnv({
			AGGREGATE_CACHE: {
				list,
				put: vi.fn(async () => undefined),
				delete: vi.fn(async (keys: string[]) => {
					deleted.push(keys);
				}),
			},
		});
		const response = await internalFetch(
			purgeRequest({ "X-Service-Binding": "true" }),
			env,
			createExecutionContext(),
		);
		const body = (await response.json()) as { ok: boolean; r2Deleted: number };
		expect(response.status).toBe(200);
		expect(body.ok).toBe(true);
		// Pagination must be walked: stopping at page one would silently strand
		// stale snapshots — the exact failure mode this route exists to end.
		expect(body.r2Deleted).toBe(3);
		expect(deleted.flat()).toEqual([
			"aggregate-surface/v1/aaaa",
			"aggregate-surface/v1/bbbb",
			"aggregate-surface/v1/cccc",
		]);
		expect(list).toHaveBeenCalledTimes(2);
	});

	it("still succeeds with no R2 binding (local dev)", async () => {
		const response = await internalFetch(
			purgeRequest({ "X-Service-Binding": "true" }),
			createEnv(),
			createExecutionContext(),
		);
		const body = (await response.json()) as { ok: boolean; r2Deleted: number };
		expect(body.ok).toBe(true);
		expect(body.r2Deleted).toBe(0);
	});
});

function aggregateHost(slug: string, toolId: string) {
	return {
		app: {
			id: `app-${slug}`,
			slug,
			name: slug,
			domain: null,
			organizationId: "org-test",
			metadata:
				slug === "generation-host"
					? {
							mcpConfig: {
								authMode: "public",
								aggregateApps: [{ slug: "source" }],
							},
						}
					: null,
		},
		tools:
			slug === "source"
				? [
						{
							id: `tool-${toolId}`,
							toolId,
							title: toolId,
							toolTypeId: "external",
							inputSchema: { type: "object" },
							config: { endpoint: `https://example.test/${toolId}` },
							enabled: true,
							visibility: "public",
							authRequired: false,
						},
					]
				: [],
		catalogResources: [],
		catalogResourceTemplates: [],
	};
}

function installGenerationFixtures(toolId: () => string) {
	getBySlugWithTools.mockImplementation(async ({ slug }: { slug: string }) =>
		aggregateHost(slug, toolId()),
	);
	getBySlugsWithTools.mockImplementation(
		async ({ apps }: { apps: Array<{ slug: string }> }) => ({
			results: apps.map(({ slug }) => ({
				slug,
				...aggregateHost(slug, toolId()),
			})),
		}),
	);
}

async function listGenerationTools(env: CloudflareEnv) {
	await worker.fetch(
		new Request("https://generation-host.mcp.tedix.tech/mcp"),
		env,
		createExecutionContext(),
	);
	const input = (buildMcpServer.mock.calls.at(-1) as unknown[])?.[0] as
		| { tools: Array<{ toolId: string }> }
		| undefined;
	return input?.tools.map((tool) => tool.toolId) ?? [];
}

describe("aggregate activation generations", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps a live surface when R2 fails and logs content-free causes", async () => {
		installGenerationFixtures(() => "live_tool");
		const failure = new Error("Bearer private-cache-token", {
			cause: new Error("private cache object path"),
		});
		const env = createEnv({
			GIT_SHA: `r2-failure-${crypto.randomUUID()}`,
			AGGREGATE_CACHE: {
				get: vi.fn(async (key: string) => {
					if (key === "aggregate-activation/v1/current") {
						return new Response("epoch-r2-failure");
					}
					if (key.startsWith("aggregate-surface/v1/")) throw failure;
					return null;
				}),
				put: vi.fn(async (key: string) => {
					if (key.startsWith("aggregate-surface/v1/")) throw failure;
				}),
			},
		});
		const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(await listGenerationTools(env)).toContain("source__live_tool");
			for (const eventName of [
				"aggregate.cache_read_failed",
				"aggregate.cache_write_failed",
			]) {
				const event = warnings.mock.calls
					.map(([entry]) => entry)
					.find(
						(entry) =>
							typeof entry === "object" &&
							entry !== null &&
							(entry as { event?: string }).event === eventName,
					);
				expect(event).toMatchObject({
					component: "mcp.router",
					step: "r2",
					outcome: "unavailable",
					error: "Content omitted",
					exception: {
						type: "Error",
						message: "Content omitted",
						cause: { type: "Error", message: "Content omitted" },
					},
				});
			}
			expect(JSON.stringify(warnings.mock.calls)).not.toContain(
				"private-cache-token",
			);
			expect(JSON.stringify(warnings.mock.calls)).not.toContain(
				"private cache object path",
			);
		} finally {
			warnings.mockRestore();
		}
	});

	it("uses the new generation immediately and does not reuse old internal tools", async () => {
		const store = new Map([["aggregate-activation/v1/current", "epoch-0"]]);
		let currentTool = "old_tool";
		installGenerationFixtures(() => currentTool);
		const env = createEnv({
			GIT_SHA: `generation-${crypto.randomUUID()}`,
			AGGREGATE_CACHE: {
				get: vi.fn(async (key: string) => {
					const value = store.get(key);
					return value ? new Response(value) : null;
				}),
				put: vi.fn(async (key: string, value: string) => store.set(key, value)),
				list: vi.fn(async () => ({ objects: [], truncated: false })),
				delete: vi.fn(async () => undefined),
			},
		});

		expect(await listGenerationTools(env)).toContain("source__old_tool");
		currentTool = "new_tool";
		store.set("aggregate-activation/v1/current", "epoch-1");

		const tools = await listGenerationTools(env);
		expect(tools).toContain("source__new_tool");
		expect(tools).not.toContain("source__old_tool");
	});

	it("bypasses aggregate and internal caches when the epoch read fails", async () => {
		let currentTool = "cached_tool";
		let failEpoch = false;
		installGenerationFixtures(() => currentTool);
		const env = createEnv({
			GIT_SHA: `failure-${crypto.randomUUID()}`,
			AGGREGATE_CACHE: {
				get: vi.fn(async (key: string) => {
					if (key === "aggregate-activation/v1/current") {
						if (failEpoch) {
							throw new Error("private epoch path", {
								cause: new Error("Bearer private-epoch-token"),
							});
						}
						return new Response("epoch-ok");
					}
					return null;
				}),
				put: vi.fn(async () => undefined),
			},
		});

		expect(await listGenerationTools(env)).toContain("source__cached_tool");
		currentTool = "live_tool";
		failEpoch = true;
		const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});

		const tools = await listGenerationTools(env);
		expect(tools).toContain("source__live_tool");
		expect(tools).not.toContain("source__cached_tool");
		expect(warnings.mock.calls.map(([entry]) => entry)).toContainEqual(
			expect.objectContaining({
				component: "mcp.router",
				event: "aggregate.activation_epoch_read_failed",
				outcome: "unavailable",
				error: "Content omitted",
				exception: {
					type: "Error",
					message: "Content omitted",
					cause: { type: "Error", message: "Content omitted" },
				},
			}),
		);
		expect(JSON.stringify(warnings.mock.calls)).not.toContain(
			"private epoch path",
		);
		expect(JSON.stringify(warnings.mock.calls)).not.toContain(
			"private-epoch-token",
		);
	});

	it.each(["", "bad\nepoch", "x".repeat(129)])(
		"does not treat an existing invalid marker as the initial generation",
		async (invalidMarker) => {
			const store = new Map<string, string>();
			let currentTool = "initial_tool";
			installGenerationFixtures(() => currentTool);
			const env = createEnv({
				GIT_SHA: `invalid-${crypto.randomUUID()}`,
				AGGREGATE_CACHE: {
					get: vi.fn(async (key: string) =>
						store.has(key) ? new Response(store.get(key)) : null,
					),
					put: vi.fn(async (key: string, value: string) =>
						store.set(key, value),
					),
				},
			});

			expect(await listGenerationTools(env)).toContain("source__initial_tool");
			currentTool = "live_tool";
			store.set("aggregate-activation/v1/current", invalidMarker);
			vi.spyOn(console, "warn").mockImplementation(() => {});

			const tools = await listGenerationTools(env);
			expect(tools).toContain("source__live_tool");
			expect(tools).not.toContain("source__initial_tool");
		},
	);

	it("does not join an internal prefetch that started under an older epoch", async () => {
		const store = new Map([["aggregate-activation/v1/current", "epoch-old"]]);
		let releaseOld!: (value: unknown) => void;
		const oldBatch = new Promise((resolve) => {
			releaseOld = resolve;
		});
		getBySlugWithTools.mockImplementation(async ({ slug }: { slug: string }) =>
			aggregateHost(slug, "fallback"),
		);
		getBySlugsWithTools
			.mockReturnValueOnce(oldBatch)
			.mockImplementationOnce(
				async ({ apps }: { apps: Array<{ slug: string }> }) => ({
					results: apps.map(({ slug }) => ({
						slug,
						...aggregateHost(slug, "fresh_tool"),
					})),
				}),
			);
		const env = createEnv({
			GIT_SHA: `inflight-${crypto.randomUUID()}`,
			AGGREGATE_CACHE: {
				get: vi.fn(async (key: string) => {
					const value = store.get(key);
					return value ? new Response(value) : null;
				}),
				put: vi.fn(async (key: string, value: string) => store.set(key, value)),
			},
		});

		const oldRequest = listGenerationTools(env);
		await vi.waitFor(() =>
			expect(getBySlugsWithTools).toHaveBeenCalledTimes(1),
		);
		store.set("aggregate-activation/v1/current", "epoch-new");
		const freshRequest = listGenerationTools(env);
		await expect(freshRequest).resolves.toContain("source__fresh_tool");

		releaseOld({
			results: [{ slug: "source", ...aggregateHost("source", "old_tool") }],
		});
		await expect(oldRequest).resolves.toContain("source__old_tool");
	});
});

describe("purge-discovery-cache", () => {
	it("purges exact app-resolution keys even without a Workers Cache context", async () => {
		const deleted: string[][] = [];
		const response = await internalFetch(
			discoveryPurgeRequest({ "X-Service-Binding": "true" }),
			createEnv({
				AGGREGATE_CACHE: {
					put: vi.fn(async () => undefined),
					delete: vi.fn(async (keys: string[]) => deleted.push(keys)),
				},
			}),
			createExecutionContext(),
		);
		const body = (await response.json()) as {
			ok: boolean;
			discoveryPurged: boolean;
			r2Deleted: number;
		};

		expect(response.status).toBe(200);
		expect(body).toMatchObject({
			ok: true,
			discoveryPurged: false,
			r2Deleted: 2,
		});
		expect(deleted).toEqual([
			[
				`app-resolution/v1/${encodeURIComponent("mcp-subdomain:alpha")}`,
				`app-resolution/v1/${encodeURIComponent("custom:alpha.example.com")}`,
			],
		]);
	});
});
