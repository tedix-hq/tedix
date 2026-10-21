import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import {
	catalogBaseAppAutoSyncEnabled,
	fetchPublicMcpManifest,
	manifestUrlCandidates,
	parseMetadata,
	parsePublicMcpManifest,
	scanResultFromPublicManifest,
} from "./mcp-scan-workflow";

const endpoint = "https://fictional.example/mcp";
const manifestUrl = "https://fictional.example/.well-known/mcp.json";
const pathManifestUrl = "https://fictional.example/mcp/.well-known/mcp.json";
const payload = {
	name: " Fictional library ",
	version: " 1.2.3 ",
	mcp_version: " 2025-06-18 ",
	protocolVersion: "ignored",
	description: " Library inventory ",
	tools: [
		{
			name: " find_books ",
			title: " Find books ",
			description: " Search books ",
			inputSchema: {
				type: "object",
				properties: { query: { type: "string" } },
			},
			outputSchema: { type: "array" },
		},
	],
	resources: [
		{
			uri: " library://books ",
			name: " books ",
			title: " Books ",
			description: " Available books ",
			mimeType: " application/json ",
		},
	],
	prompts: [
		{
			name: " recommend_book ",
			description: " Recommend a book ",
			arguments: [
				{ name: " genre ", description: " Book genre ", required: true },
			],
		},
	],
};

beforeEach(() => {
	// Any unconfigured request fails locally; no test can contact a server.
	vi.stubGlobal(
		"fetch",
		vi.fn().mockRejectedValue(new Error("Unexpected fetch")),
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("catalog metadata", () => {
	it.each([{ mcpConfig: { autoSync: false } }, {}])(
		"reads object and JSON metadata %j",
		(metadata) => {
			expect(parseMetadata(metadata)).toEqual(metadata);
			expect(parseMetadata(JSON.stringify(metadata))).toEqual(metadata);
		},
	);

	it.each([
		undefined,
		null,
		[],
		true,
		42,
		"",
		"{",
		"null",
		"[]",
		"true",
		'"text"',
		"42",
	])("rejects missing or malformed metadata %j", (metadata) => {
		expect(parseMetadata(metadata)).toBeNull();
	});

	it("preserves explicit manual sync in object and serialized settings", () => {
		const metadata = { mcpConfig: { autoSync: false } };
		expect(catalogBaseAppAutoSyncEnabled(metadata)).toBe(false);
		expect(catalogBaseAppAutoSyncEnabled(JSON.stringify(metadata))).toBe(false);
	});

	it.each([
		undefined,
		null,
		"{",
		{},
		{ autoSync: false },
		{ mcpConfig: null },
		{ mcpConfig: [] },
		{ mcpConfig: "manual" },
		{ mcpConfig: {} },
		...[true, null, 0, "false"].map((autoSync) => ({
			mcpConfig: { autoSync },
		})),
	])(
		"defaults to auto sync unless nested setting is boolean false: %j",
		(metadata) => {
			expect(catalogBaseAppAutoSyncEnabled(metadata)).toBe(true);
		},
	);
});

describe("manifestUrlCandidates", () => {
	it.each([
		"https://fictional.example",
		"https://fictional.example/",
		"https://fictional.example/?query=1#fragment",
	])("deduplicates the origin candidate for %s", (url) => {
		expect(manifestUrlCandidates(url)).toEqual([manifestUrl]);
	});

	it.each([
		endpoint,
		`${endpoint}/`,
		`${endpoint}?query=1#fragment`,
		`${endpoint}/?query=1`,
	])(
		"tries origin before endpoint path without query or fragment: %s",
		(url) => {
			expect(manifestUrlCandidates(url)).toEqual([
				manifestUrl,
				pathManifestUrl,
			]);
		},
	);

	it("keeps nested endpoint paths and nondefault ports", () => {
		expect(
			manifestUrlCandidates("https://fictional.example:8443/api/mcp"),
		).toEqual([
			"https://fictional.example:8443/.well-known/mcp.json",
			"https://fictional.example:8443/api/mcp/.well-known/mcp.json",
		]);
	});
});

describe("parsePublicMcpManifest", () => {
	it("maps the fictional inventory and marks manifest provenance", () => {
		const provenance = {
			"com.tedix/source": "mcp-manifest",
			"com.tedix/manifestUrl": manifestUrl,
		};
		expect(parsePublicMcpManifest(manifestUrl, payload)).toEqual({
			url: manifestUrl,
			name: "Fictional library",
			version: "1.2.3",
			protocolVersion: "2025-06-18",
			description: "Library inventory",
			tools: [
				{
					name: "find_books",
					title: "Find books",
					description: "Search books",
					inputSchema: payload.tools[0].inputSchema,
					outputSchema: payload.tools[0].outputSchema,
					_meta: provenance,
				},
			],
			resources: [
				{
					uri: "library://books",
					name: "books",
					title: "Books",
					description: "Available books",
					mimeType: "application/json",
					_meta: provenance,
				},
			],
			prompts: [
				{
					name: "recommend_book",
					description: "Recommend a book",
					arguments: [
						{ name: "genre", description: "Book genre", required: true },
					],
				},
			],
		});
	});

	it.each([
		null,
		undefined,
		[],
		"manifest",
		42,
		true,
		{},
		{ tools: [], resources: [], prompts: [] },
		{ tools: {}, resources: "books", prompts: false },
		{
			tools: [null, [], {}, { name: " " }, { name: 1 }],
			resources: [{ uri: false }],
			prompts: [{ name: null }],
		},
	])("does not turn unusable payload into inventory: %j", (value) => {
		expect(parsePublicMcpManifest(manifestUrl, value)).toBeNull();
	});

	it.each([
		{ tools: [{ name: "find_books" }] },
		{ resources: [{ uri: "library://books" }] },
		{ prompts: [{ name: "recommend_book" }] },
	])(
		"accepts one nonempty inventory list with the others empty or absent: %j",
		(inventory) => {
			const manifest = parsePublicMcpManifest(manifestUrl, inventory)!;
			expect(manifest).not.toBeNull();
			expect(
				manifest.tools.length +
					manifest.resources.length +
					manifest.prompts.length,
			).toBe(1);
			for (const list of ["tools", "resources", "prompts"] as const) {
				if (!(list in inventory)) expect(manifest[list]).toEqual([]);
			}
		},
	);

	it("filters invalid entries and ignores wrong optional field types", () => {
		const manifest = parsePublicMcpManifest(manifestUrl, {
			name: 1,
			version: false,
			description: [],
			mcp_version: " ",
			protocolVersion: " 2025-03-26 ",
			tools: [
				null,
				{},
				{
					name: " find_books ",
					title: 3,
					description: " ",
					inputSchema: [],
					outputSchema: false,
				},
			],
			resources: [
				null,
				{},
				{ uri: "library://books", name: false, mimeType: 1 },
			],
			prompts: [
				null,
				{},
				{
					name: "recommend_book",
					arguments: [
						null,
						[],
						{ name: " ", description: 1, required: "true" },
						{ name: "genre", required: false },
					],
				},
				{ name: "no_arguments", arguments: {} },
			],
		})!;
		expect(manifest).toMatchObject({
			name: undefined,
			version: undefined,
			description: undefined,
			protocolVersion: "2025-03-26",
		});
		expect(manifest.tools).toEqual([
			{
				name: "find_books",
				title: undefined,
				description: undefined,
				inputSchema: undefined,
				outputSchema: undefined,
				_meta: {
					"com.tedix/source": "mcp-manifest",
					"com.tedix/manifestUrl": manifestUrl,
				},
			},
		]);
		expect(manifest.resources).toHaveLength(1);
		expect(manifest.resources[0]).toMatchObject({
			uri: "library://books",
			name: undefined,
			mimeType: undefined,
		});
		expect(manifest.prompts).toEqual([
			{
				name: "recommend_book",
				description: undefined,
				arguments: [
					{ name: "argument", description: undefined, required: undefined },
					{ name: "genre", description: undefined, required: false },
				],
			},
			{ name: "no_arguments", description: undefined, arguments: [] },
		]);
	});
});

describe("scanResultFromPublicManifest", () => {
	it.each([
		{
			status: "blocked",
			authState: "none",
			errorClass: "waf",
			errorMessage: "Blocked by fictional WAF",
		},
		{
			status: "requires_auth",
			authState: "required",
			errorClass: "auth",
			errorMessage: "Authentication required",
		},
	] as const)(
		"retains $status diagnostics while mapping declared inventory",
		(diagnostics) => {
			const base = {
				...diagnostics,
				connectTimeMs: 12,
				totalTimeMs: 34,
				transportUsed: "streamable-http" as const,
				checkedAt: "2026-10-21T00:00:00.000Z",
			};
			const manifest = parsePublicMcpManifest(manifestUrl, payload)!;
			expect(scanResultFromPublicManifest(base, manifest)).toEqual({
				...base,
				serverName: "Fictional library",
				serverVersion: "1.2.3",
				capabilities: { manifestUrl, manifestDeclared: true },
				instructions: "Library inventory",
				toolCount: 1,
				resourceCount: 1,
				promptCount: 1,
				resourceTemplateCount: 0,
				tools: manifest.tools,
				resources: manifest.resources,
				prompts: manifest.prompts,
				resourceTemplates: [],
				protocolVersion: "2025-06-18",
				supportsResources: true,
				supportsPrompts: true,
			});
		},
	);

	it("does not infer resource or prompt support from a tools-only manifest", () => {
		const manifest = parsePublicMcpManifest(manifestUrl, {
			tools: payload.tools,
		})!;
		expect(
			scanResultFromPublicManifest(
				{ status: "requires_auth", checkedAt: "2026-10-21T00:00:00.000Z" },
				manifest,
			),
		).toMatchObject({
			toolCount: 1,
			resourceCount: 0,
			promptCount: 0,
			supportsResources: false,
			supportsPrompts: false,
		});
	});
});

describe("fetchPublicMcpManifest", () => {
	beforeEach(() => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	it("returns the first valid manifest using public JSON headers", async () => {
		const fetchMock = vi.fn().mockResolvedValue(Response.json(payload));
		vi.stubGlobal("fetch", fetchMock);
		expect(await fetchPublicMcpManifest(endpoint, 30_000)).toEqual(
			parsePublicMcpManifest(manifestUrl, payload),
		);
		expect(fetchMock).toHaveBeenCalledExactlyOnceWith(manifestUrl, {
			headers: {
				Accept: "application/json",
				"User-Agent": "tedix-mcp-scanner/1.0",
			},
			signal: expect.any(AbortSignal),
		});
	});

	it.each([
		"404",
		"invalid JSON",
		"wrong type",
		"empty inventory",
		"network error",
	])("tries the path candidate after %s", async (failure) => {
		const fetchMock = vi.fn();
		if (failure === "network error")
			fetchMock.mockRejectedValueOnce(new Error("offline"));
		else
			fetchMock.mockResolvedValueOnce(
				failure === "404"
					? new Response("missing", { status: 404 })
					: failure === "invalid JSON"
						? new Response("{")
						: Response.json(
								failure === "wrong type"
									? []
									: { tools: [], resources: [], prompts: [] },
							),
			);
		fetchMock.mockResolvedValueOnce(Response.json(payload));
		vi.stubGlobal("fetch", fetchMock);
		expect(await fetchPublicMcpManifest(endpoint, 100)).toEqual(
			parsePublicMcpManifest(pathManifestUrl, payload),
		);
		expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
			manifestUrl,
			pathManifestUrl,
		]);
	});

	it.each([
		new Response("missing", { status: 404 }),
		new Response("{"),
		Response.json({ tools: [], resources: [], prompts: [] }),
	])(
		"returns null when every candidate is unavailable or malformed (%#)",
		async (response) => {
			const fetchMock = vi
				.fn()
				.mockImplementation(async () => response.clone());
			vi.stubGlobal("fetch", fetchMock);
			expect(await fetchPublicMcpManifest(endpoint, 100)).toBeNull();
			expect(fetchMock).toHaveBeenCalledTimes(2);
		},
	);

	it.each([25, 30_000])(
		"aborts each candidate after min(%i, 5000) ms and clears timers",
		async (timeoutMs) => {
			vi.useFakeTimers();
			const signals: AbortSignal[] = [];
			vi.stubGlobal(
				"fetch",
				vi.fn(
					(_url: string, init: RequestInit) =>
						new Promise<Response>((_resolve, reject) => {
							const signal = init.signal!;
							signals.push(signal);
							signal.addEventListener(
								"abort",
								() => reject(new DOMException("Aborted", "AbortError")),
								{ once: true },
							);
						}),
				),
			);
			const result = fetchPublicMcpManifest(endpoint, timeoutMs);
			const delay = Math.min(timeoutMs, 5000);
			await vi.advanceTimersByTimeAsync(delay - 1);
			expect(signals).toHaveLength(1);
			expect(signals[0].aborted).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			expect(signals).toHaveLength(2);
			expect(signals[0].aborted).toBe(true);
			expect(signals[1].aborted).toBe(false);
			await vi.advanceTimersByTimeAsync(delay);
			expect(await result).toBeNull();
			expect(signals.every((signal) => signal.aborted)).toBe(true);
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it("clears the timeout on success", async () => {
		vi.useFakeTimers();
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(payload)));
		expect(await fetchPublicMcpManifest(endpoint, 100)).not.toBeNull();
		expect(vi.getTimerCount()).toBe(0);
	});
});
