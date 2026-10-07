import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

/**
 * The aggregate rebuild must resolve its entries in one upstream call, not one
 * per app.
 *
 * Every apps/api invocation costs seconds of CPU on a cold isolate (the
 * `worker-app` module graph is evaluated per isolate), so N concurrent
 * `getBySlugWithTools` calls produce N cold isolates, mostly timed-out entries,
 * and a `degraded` surface with a fraction of the expected tools.
 *
 * These tests pin the call SHAPE, which is the thing that regressed — plus the
 * fail-open behaviour that makes the optimisation safe.
 */

const { getApiClient, getByDomain, getBySlugWithTools, getBySlugsWithTools } =
	vi.hoisted(() => {
		const getByDomain = vi.fn();
		const getBySlugWithTools = vi.fn();
		const getBySlugsWithTools = vi.fn();
		return {
			getByDomain,
			getBySlugWithTools,
			getBySlugsWithTools,
			getApiClient: vi.fn(() => ({
				apps: { getByDomain, getBySlugWithTools, getBySlugsWithTools },
			})),
		};
	});

vi.mock("./lib/api-client", () => ({ getApiClient }));

vi.mock("@tedix/mcp-shared/transport", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@tedix/mcp-shared/transport")>();
	return {
		...actual,
		mountMcp: vi.fn(
			async () =>
				new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		),
	};
});

const { buildMcpServer } = vi.hoisted(() => ({
	buildMcpServer: vi.fn(async () => ({}) as unknown),
}));

vi.mock("./mcp/server-factory", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./mcp/server-factory")>();
	return { ...actual, buildMcpServer };
});

import worker, {
	aggregateAndPrefixTools,
	aggregateSurfaceCacheKey,
} from "./index";

function createExecutionContext() {
	return {
		waitUntil: vi.fn((promise: Promise<unknown>) => {
			promise.catch(() => {});
		}),
		passThroughOnException: vi.fn(),
	} as unknown as ExecutionContext;
}

function createEnv() {
	return {
		ENVIRONMENT: "development",
		MCP_URL: "https://mcp.tedix.tech",
		API_URL: "https://api.tedix.tech",
		MCP_UI_URL: "https://mcp-ui.tedix.tech",
		// Unique per test run so L1/L2 aggregate caches never carry a surface
		// across cases (the cache key includes the deployment fingerprint).
		GIT_SHA: `test-${Math.random().toString(36).slice(2)}`,
		DESCOPE_AIH_BASE_URL: "https://api.descope.com",
		DEFAULT_APP_SLUG: "",
		DO_NOT_TRACK: "1",
		API_SERVICE: { fetch: vi.fn() },
	} as unknown as CloudflareEnv;
}

interface AppFixture {
	slug: string;
	mcpConfig?: Record<string, unknown>;
	tools?: Array<Record<string, unknown>>;
}

function appResponse({ slug, mcpConfig, tools }: AppFixture) {
	return {
		app: {
			id: `app-${slug}`,
			slug,
			name: slug,
			domain: null,
			organizationId: `org-${slug}`,
			description: null,
			logoUrl: null,
			customMcpDomain: null,
			openaiChallengeToken: null,
			openaiAppId: null,
			appStoreStatus: null,
			visibility: "public",
			discoveryStatus: null,
			metadata: mcpConfig ? { mcpConfig } : null,
		},
		tools: tools ?? [],
		catalogMcp: null,
		catalogResources: [],
		catalogResourceTemplates: [],
	};
}

function tool(toolId: string) {
	return {
		id: `tool-${toolId}`,
		toolId,
		title: toolId,
		description: null,
		toolTypeId: "external",
		inputSchema: { type: "object", properties: {} },
		outputSchema: null,
		config: { endpoint: `https://upstream.example/${toolId}` },
		enabled: true,
		visibility: "public",
		authRequired: false,
	};
}

/** Wire both the single-slug and the batched upstream against one fixture set. */
function installFixtures(fixtures: AppFixture[]) {
	const bySlug = new Map(fixtures.map((f) => [f.slug, appResponse(f)]));
	getBySlugWithTools.mockImplementation(async ({ slug }: { slug: string }) => {
		return bySlug.get(slug) ?? { app: null, tools: [] };
	});
	getBySlugsWithTools.mockImplementation(
		async ({ apps }: { apps: Array<{ slug: string }> }) => ({
			// Positionally parallel to the request, every entry present.
			results: apps.map(({ slug }) => ({
				slug,
				...(bySlug.get(slug) ?? { app: null, tools: [] }),
			})),
		}),
	);
	return bySlug;
}

async function serveAndCaptureTools(hostSlug: string) {
	const response = await worker.fetch(
		new Request(`https://${hostSlug}.mcp.tedix.tech/mcp`),
		createEnv(),
		createExecutionContext(),
	);
	expect(response.status).toBe(200);
	const cachedData = (buildMcpServer.mock.calls.at(-1) as unknown[])[0] as {
		tools: Array<{ toolId: string }>;
	};
	// Drop the host's own first-class `home__*` tools — only aggregated entries
	// are under test here.
	return cachedData.tools
		.map((t) => t.toolId)
		.filter((id) => id.includes("__") && !id.startsWith("home__"));
}

/** App counts carried by each batched call, in call order. */
function batchedAppCounts(): number[] {
	return getBySlugsWithTools.mock.calls.map(
		(call) => ((call[0] ?? { apps: [] }) as { apps: unknown[] }).apps.length,
	);
}

/** Which aggregate ENTRIES (never the host apps) were resolved one at a time. */
function singleResolveSlugs(...hostSlugs: string[]): string[] {
	return getBySlugWithTools.mock.calls
		.map((call) => (call[0] as { slug: string }).slug)
		.filter((slug) => !hostSlugs.includes(slug));
}

function hostWith(slug: string, entrySlugs: string[]): AppFixture[] {
	return [
		{
			slug,
			mcpConfig: {
				authMode: "public",
				aggregateApps: entrySlugs.map((entry) => ({ slug: entry })),
			},
		},
		...entrySlugs.map((entry) => ({
			slug: entry,
			tools: [tool(`${entry}_list`)],
		})),
	];
}

describe("aggregate entry resolution is batched", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		getByDomain.mockResolvedValue({ app: null });
		getBySlugWithTools.mockResolvedValue({ app: null, tools: [] });
		buildMcpServer.mockResolvedValue({} as unknown);
	});

	it("keeps consent-composed catalogs transient while sharing source caches and concurrent loads", async () => {
		const cache = { match: vi.fn(), put: vi.fn() };
		vi.stubGlobal("caches", { default: cache });
		try {
			const env = createEnv();
			const get = vi.fn().mockResolvedValue(null);
			const put = vi.fn().mockResolvedValue(undefined);
			env.AGGREGATE_CACHE = { get, put } as unknown as R2Bucket;
			installFixtures([{ slug: "transient-source", tools: [tool("list")] }]);
			const entries = ["org-a", "org-b"].map((organizationId) => ({
				slug: "transient-source",
				organizationId,
				prefix: organizationId,
			}));
			const load = () =>
				aggregateAndPrefixTools(
					entries,
					env,
					new Set(),
					undefined,
					"connect",
					undefined,
					false,
				);
			const [first, joined] = await Promise.all([load(), load()]);
			expect(joined).toBe(first);
			expect(
				first.tools.map((entry) => [
					entry.toolId,
					entry.config?._multiOrgOrganizationId,
				]),
			).toEqual([
				["org-a__list", "org-a"],
				["org-b__list", "org-b"],
			]);
			const next = await load();
			expect(next).not.toBe(first);
			expect(next.tools).toEqual(first.tools);
			expect(getBySlugsWithTools).toHaveBeenCalledTimes(1);
			expect(cache.match).not.toHaveBeenCalled();
			expect(cache.put).not.toHaveBeenCalled();
			expect(put).not.toHaveBeenCalled();
			expect(get.mock.calls.length).toBe(3);
			expect(new Set(get.mock.calls.map(([key]) => key)).size).toBe(1);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("retains shared aggregate snapshots for ordinary roots", async () => {
		const cache = { match: vi.fn(), put: vi.fn() };
		vi.stubGlobal("caches", { default: cache });
		try {
			const env = createEnv();
			const get = vi.fn().mockResolvedValue(null);
			const put = vi.fn().mockResolvedValue(undefined);
			env.AGGREGATE_CACHE = { get, put } as unknown as R2Bucket;
			installFixtures([{ slug: "shared-source", tools: [tool("list")] }]);
			const load = () =>
				aggregateAndPrefixTools([{ slug: "shared-source" }], env);
			const first = await load();
			expect(await load()).toBe(first);
			expect(cache.match).toHaveBeenCalledTimes(1);
			expect(cache.put).toHaveBeenCalledTimes(1);
			expect(put).toHaveBeenCalledTimes(1);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("gives each app of a Connect organization mount its own namespace", async () => {
		installFixtures([
			{
				slug: "acme-unified",
				mcpConfig: {
					aggregateApps: [
						{ slug: "resend-2-acme", prefix: "resend_2_acme" },
						{ slug: "crm-acme" },
					],
				},
				tools: [tool("list_all_mine")],
			},
			{ slug: "resend-2-acme", tools: [tool("list-contacts")] },
			{ slug: "crm-acme", tools: [tool("list_contacts")] },
		]);
		const surface = await aggregateAndPrefixTools(
			[
				{
					slug: "acme-unified",
					prefix: "acme-unified",
					organizationId: "org-acme",
					organizationMount: true,
				},
			],
			createEnv(),
			new Set(),
			undefined,
			"connect",
			undefined,
			false,
		);
		expect(
			surface.tools.map((entry) => [
				entry.toolId,
				entry.config?._aggregateNamespace,
				entry.config?._aggregateLegacyNamespace,
				entry.config?._multiOrgOrganizationId,
			]),
		).toEqual([
			["acme-unified__list_all_mine", "acme-unified", undefined, "org-acme"],
			[
				"acme_unified_resend_2__list-contacts",
				"acme_unified_resend_2",
				"acme-unified",
				"org-acme",
			],
			[
				"acme_unified_crm__list_contacts",
				"acme_unified_crm",
				"acme-unified",
				"org-acme",
			],
		]);
	});

	it("carries an organization's reviewed scopes to its per-app namespaces", async () => {
		installFixtures([
			{
				slug: "scoped-unified",
				mcpConfig: {
					aggregateApps: [
						{ slug: "cms-scoped-landing", prefix: "cms_landing" },
						{ slug: "cms-scoped-blog", prefix: "cms_blog" },
						{ slug: "bench-scoped", prefix: "bench" },
					],
					toolScopes: {
						cms_landing: ["mcp:content"],
						cms_blog__media_delete: ["mcp:content.admin"],
						"*": ["mcp:apps"],
					},
				},
				tools: [],
			},
			{ slug: "cms-scoped-landing", tools: [tool("byline_list")] },
			{ slug: "cms-scoped-blog", tools: [tool("media_delete")] },
			{
				slug: "bench-scoped",
				mcpConfig: {
					toolScopes: { calculate: ["mcp:apps.read"], "*": ["mcp:apps"] },
				},
				tools: [tool("calculate")],
			},
		]);
		const surface = await aggregateAndPrefixTools(
			[
				{
					slug: "scoped-unified",
					prefix: "scoped-unified",
					organizationId: "org-scoped",
					organizationMount: true,
				},
			],
			createEnv(),
			new Set(),
			undefined,
			"connect",
			undefined,
			false,
		);
		expect(surface.toolScopes).toEqual({
			scoped_unified_cms_landing: ["mcp:content"],
			scoped_unified_cms_blog__media_delete: ["mcp:content.admin"],
			scoped_unified_bench__calculate: ["mcp:apps.read"],
		});
	});

	it("keeps a selected gateway's native and nested tools under one organization", async () => {
		installFixtures([
			{
				slug: "selected-host",
				mcpConfig: {
					authMode: "public",
					aggregateApps: [
						{
							slug: "selected-gateway",
							prefix: "selected",
							organizationId: "selected-org",
						},
					],
				},
			},
			{
				slug: "selected-gateway",
				mcpConfig: { aggregateApps: [{ slug: "nested-source" }] },
				tools: [tool("native")],
			},
			{ slug: "nested-source", tools: [tool("nested")] },
		]);
		expect(await serveAndCaptureTools("selected-host")).toEqual([
			"selected__native",
			"selected__nested",
		]);
		const surface = (buildMcpServer.mock.calls.at(-1) as unknown[])[0] as {
			tools: Array<{ toolId: string; config: Record<string, unknown> }>;
		};
		expect(
			surface.tools
				.filter((entry) => entry.toolId.startsWith("selected__"))
				.map((entry) => entry.config?._multiOrgOrganizationId),
		).toEqual(["selected-org", "selected-org"]);
		expect(
			aggregateSurfaceCacheKey([
				{ slug: "selected-gateway", organizationId: "selected-org" },
			]),
		).not.toBe(
			aggregateSurfaceCacheKey([
				{ slug: "selected-gateway", organizationId: "different-org" },
			]),
		);
	});

	it("resolves many entries with ONE batched call and no per-entry calls", async () => {
		const entries = Array.from({ length: 12 }, (_, i) => `batched-app-${i}`);
		installFixtures(hostWith("batched-host", entries));

		const toolIds = await serveAndCaptureTools("batched-host");

		// The whole surface is present…
		for (const entry of entries) {
			expect(toolIds).toContain(`${entry}__${entry}_list`);
		}
		// …and it cost exactly one upstream round trip for all 12 entries.
		expect(getBySlugsWithTools).toHaveBeenCalledTimes(1);
		expect(batchedAppCounts()).toEqual([12]);
		// This is the regression: it used to be 12 separate calls.
		expect(singleResolveSlugs("batched-host")).toEqual([]);
	});

	it("splits into bounded chunks instead of one unbounded request", async () => {
		// 25 entries > the 20-app chunk: two calls, never 25.
		const entries = Array.from({ length: 25 }, (_, i) => `chunked-app-${i}`);
		installFixtures(hostWith("chunked-host", entries));

		const toolIds = await serveAndCaptureTools("chunked-host");

		expect(toolIds).toHaveLength(25);
		expect(getBySlugsWithTools).toHaveBeenCalledTimes(2);
		const sizes = batchedAppCounts();
		expect(sizes.every((size) => size <= 20)).toBe(true);
		expect(sizes.reduce((a, b) => a + b, 0)).toBe(25);
		expect(singleResolveSlugs("chunked-host")).toEqual([]);
	});

	it("falls back to per-entry resolution when the batch call fails", async () => {
		const entries = ["failopen-a", "failopen-b", "failopen-c"];
		installFixtures(hostWith("failopen-host", entries));
		getBySlugsWithTools.mockRejectedValue(new Error("apps/api is down"));

		const toolIds = await serveAndCaptureTools("failopen-host");

		// Fail-open: the surface is complete, built the old way.
		for (const entry of entries) {
			expect(toolIds).toContain(`${entry}__${entry}_list`);
		}
		expect(singleResolveSlugs("failopen-host").sort()).toEqual([...entries]);
	});

	it("logs a content-free cause chain when a source app cannot resolve", async () => {
		const bySlug = installFixtures(
			hostWith("failed-source-host", ["failed-source"]),
		);
		getBySlugsWithTools.mockResolvedValue({ results: [] });
		getBySlugWithTools.mockImplementation(
			async ({ slug }: { slug: string }) => {
				if (slug === "failed-source") {
					throw new Error("Bearer private-provider-token", {
						cause: new Error("private upstream response"),
					});
				}
				return bySlug.get(slug) ?? { app: null, tools: [] };
			},
		);
		const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(await serveAndCaptureTools("failed-source-host")).toEqual([]);
			const event = warnings.mock.calls
				.map(([entry]) => entry)
				.find(
					(entry) =>
						typeof entry === "object" &&
						entry !== null &&
						(entry as { event?: string }).event ===
							"aggregate.source_resolution_failed",
				);
			expect(event).toMatchObject({
				component: "mcp.router",
				appSlug: "failed-source",
				outcome: "unavailable",
				error: "Content omitted",
				exception: {
					type: "Error",
					message: "Content omitted",
					cause: { type: "Error", message: "Content omitted" },
				},
			});
			expect(JSON.stringify(warnings.mock.calls)).not.toContain(
				"private-provider-token",
			);
			expect(JSON.stringify(warnings.mock.calls)).not.toContain(
				"private upstream response",
			);
		} finally {
			warnings.mockRestore();
		}
	});

	it("treats a short or misaligned batch response as 'not asked for', not as empty", async () => {
		const entries = ["partial-a", "partial-b", "partial-c"];
		const bySlug = installFixtures(hostWith("partial-host", entries));
		// Upstream answers only the first entry.
		getBySlugsWithTools.mockImplementation(
			async ({ apps }: { apps: Array<{ slug: string }> }) => ({
				results: apps
					.slice(0, 1)
					.map(({ slug }) => ({ slug, ...bySlug.get(slug)! })),
			}),
		);

		const toolIds = await serveAndCaptureTools("partial-host");

		// Nothing is silently dropped: the unanswered entries resolve individually.
		for (const entry of entries) {
			expect(toolIds).toContain(`${entry}__${entry}_list`);
		}
		expect(singleResolveSlugs("partial-host").sort()).toEqual([
			"partial-b",
			"partial-c",
		]);
	});

	it("keeps a batched app:null as 'no tools', not as a failed resolve", async () => {
		installFixtures([
			{
				slug: "missing-host",
				mcpConfig: {
					authMode: "public",
					aggregateApps: [{ slug: "present-app" }, { slug: "absent-app" }],
				},
			},
			{ slug: "present-app", tools: [tool("present_list")] },
			// `absent-app` intentionally has no fixture → batched `app: null`.
		]);

		const toolIds = await serveAndCaptureTools("missing-host");

		expect(toolIds).toEqual(["present-app__present_list"]);
		// A known-absent app is an answered request, so it is never re-asked —
		// "no tools" and "not asked for" stay distinguishable.
		expect(singleResolveSlugs("missing-host")).toEqual([]);
	});

	it("does not re-request entries already warm in the per-slug cache", async () => {
		const entries = ["warm-a", "warm-b"];
		installFixtures(hostWith("warm-host", entries));

		// Two different hosts aggregating the same entries: the second rebuild has
		// a different aggregate cache key but the same warm per-slug entries.
		await serveAndCaptureTools("warm-host");
		expect(getBySlugsWithTools).toHaveBeenCalledTimes(1);

		installFixtures([
			...hostWith("warm-host-2", entries),
			...hostWith("warm-host", entries),
		]);
		await serveAndCaptureTools("warm-host-2");

		// Still one batched call in total — the L1 per-slug cache absorbed the rest,
		// and nothing fell back to per-entry resolution either.
		expect(getBySlugsWithTools).toHaveBeenCalledTimes(1);
		expect(singleResolveSlugs("warm-host", "warm-host-2")).toEqual([]);
	});

	it("folds concurrent NESTED single-entry prefetches into one batch", async () => {
		// A nested aggregate's entries are only discovered once its parent
		// resolves, so each nested level used to prefetch its one entry alone and
		// pay a full cold apps/api round trip — single-app prefetches dominated
		// rebuild time. Parents resolve concurrently, so the coalescing window
		// folds their nested prefetches into one batched call.
		installFixtures([
			{
				slug: "nested-host",
				mcpConfig: {
					authMode: "public",
					aggregateApps: [
						{ slug: "mid-a" },
						{ slug: "mid-b" },
						{ slug: "mid-c" },
					],
				},
			},
			...["a", "b", "c"].map((k) => ({
				slug: `mid-${k}`,
				mcpConfig: {
					authMode: "public",
					aggregateApps: [{ slug: `leaf-${k}` }],
				},
			})),
			...["a", "b", "c"].map((k) => ({
				slug: `leaf-${k}`,
				tools: [tool(`leaf_${k}_list`)],
			})),
		]);

		const toolIds = await serveAndCaptureTools("nested-host");

		// Every leaf still resolved through the nesting.
		expect(toolIds.some((id) => id.includes("leaf_a_list"))).toBe(true);
		expect(toolIds.some((id) => id.includes("leaf_c_list"))).toBe(true);

		// Two batched calls total: one for the three mid entries, then one more
		// folding all three leaves. Before coalescing each leaf issued its own.
		expect(getBySlugsWithTools).toHaveBeenCalledTimes(2);
		const secondBatch = getBySlugsWithTools.mock.calls[1]?.[0] as
			| { apps: Array<{ slug: string }> }
			| undefined;
		expect((secondBatch?.apps ?? []).map((a) => a.slug).sort()).toEqual([
			"leaf-a",
			"leaf-b",
			"leaf-c",
		]);
	});

	it("shares ONE prefetch across concurrent cold rebuilds", async () => {
		// The prefetch skipped keys already in `internalToolInFlight` but never
		// registered its own, so concurrent cold requests each fanned the same
		// apps out again, and the duplicates contended for the same apps/api
		// isolates. Without the single-flight guard this expects 3.
		const entries = ["herd-a", "herd-b"];
		installFixtures(hostWith("herd-host", entries));

		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const original = getBySlugsWithTools.getMockImplementation();
		getBySlugsWithTools.mockImplementationOnce(async (input: unknown) => {
			// Hold the first batch open so the other two rebuilds start while it
			// is still in flight — the exact race the guard exists for.
			await gate;
			return original?.(input);
		});

		const inFlight = [
			serveAndCaptureTools("herd-host"),
			serveAndCaptureTools("herd-host"),
			serveAndCaptureTools("herd-host"),
		];
		release?.();
		await Promise.all(inFlight);

		expect(getBySlugsWithTools).toHaveBeenCalledTimes(1);
	});
});
