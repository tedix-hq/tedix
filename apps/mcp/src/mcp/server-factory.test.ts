import type { McpServer } from "@modelcontextprotocol/server";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

const { getApiClient, listByApp, getRunArtifact } = vi.hoisted(() => {
	const listByApp = vi.fn();
	const getRunArtifact = vi.fn();
	return {
		listByApp,
		getRunArtifact,
		getApiClient: vi.fn(() => ({
			skills: { listByApp, getRunArtifact },
		})),
	};
});

vi.mock("../lib/api-client", () => ({ getApiClient }));

import { MCP_RESULT_CACHE_HINT_META_KEY } from "@tedix/mcp-shared/transport";
import {
	buildEdgeListCacheHints,
	buildMcpServer,
	type CachedAppData,
	extractCallerIdentity,
	fetchWidgetHtmlForApp,
} from "./server-factory";
import { SKILLS_LIST_PAGE_SIZE } from "./skills-list-pagination";
import { __resetSkillSnapshotCache } from "./skill-snapshot-cache";

// registerAppSkills now caches its D1 snapshot in module-global L1/L2 keyed by
// (app, org, tedi, guidance, deploy fingerprint). These tests reuse one app
// identity across builds with different mocked skill rows, so the snapshot must
// be reset between tests or an earlier build's snapshot would be served.
beforeEach(() => {
	__resetSkillSnapshotCache();
});

afterEach(() => vi.restoreAllMocks());

/** D1 skill row as returned by `skills.listByApp` — includes a `files` map so
 *  the SEP-2640 directory-model file templates have something to serve. */
const SKILL_ROW = {
	id: "skill_1",
	title: "Deploy Widget",
	slug: "deploy-widget",
	summary: "How to deploy a widget",
	description: "How to deploy a widget",
	content: "---\nname: deploy-widget\n---\n\n# Deploy procedure",
	files: { "references/guide.md": "# Guide" },
	tags: ["ops"],
	toolIds: [],
	successCount: 2,
	revision: 3,
	appId: "app_1",
	audience: ["assistant"],
	r2Path: null,
	updatedAt: "2026-06-01T00:00:00.000Z",
	createdAt: "2026-05-01T00:00:00.000Z",
};

function createCachedData(): CachedAppData {
	return {
		app: {
			id: "app_1",
			slug: "tedix",
			name: "Tedix",
			domain: null,
			// Deliberately no organizationId: keeps resource_read audit emission
			// (which would hit apps/api) inert in this unit harness.
			organizationId: undefined,
			description: null,
			logoUrl: null,
			customMcpDomain: null,
			openaiChallengeToken: null,
			openaiAppId: null,
			appStoreStatus: null,
			visibility: "public",
			discoveryStatus: null,
			metadata: null,
		} as unknown as CachedAppData["app"],
		tools: [],
		catalogMcp: null,
		catalogResources: [],
		catalogResourceTemplates: [],
		catalogPrompts: [],
		metadata: null,
		capabilities: {} as CachedAppData["capabilities"],
		organizationId: undefined,
		expiresAt: Date.now() + 60_000,
	};
}

function createEnv(): CloudflareEnv {
	return {
		ENVIRONMENT: "test",
		API_URL: "https://api.test",
		MCP_UI_URL: "https://widget.test",
	} as unknown as CloudflareEnv;
}

function createExecutionContext(): ExecutionContext {
	return {
		waitUntil: vi.fn((promise: Promise<unknown>) => {
			promise.catch(() => {});
		}),
		passThroughOnException: vi.fn(),
	} as unknown as ExecutionContext;
}

describe("fetchWidgetHtmlForApp failure", () => {
	it("returns the fallback widget and logs a structured cause chain", async () => {
		const error = new Error("widget unavailable", {
			cause: new Error("origin refused connection"),
		});
		const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(error);
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

		const html = await fetchWidgetHtmlForApp(
			createCachedData(),
			"/search",
			"Search widget",
			"mcp-app",
			createEnv(),
		);

		expect(fetchMock).toHaveBeenCalledOnce();
		expect(html).toContain("Widget Unavailable");
		expect(errorLog).toHaveBeenCalledWith(
			expect.objectContaining({
				component: "mcp.server_factory",
				event: "server_factory.widget_fetch_failed",
				appId: "app_1",
				appSlug: "tedix",
				outcome: "unavailable",
				exception: expect.objectContaining({
					message: "widget unavailable",
					cause: expect.objectContaining({
						message: "origin refused connection",
					}),
				}),
			}),
		);
	});
});

describe("extractCallerIdentity — trusted workflow provenance", () => {
	it("decodes bounded workflow headers only for service callers", () => {
		const identity = extractCallerIdentity(
			new Request("https://mcp.test/mcp", {
				headers: {
					"x-tedix-auth-type": "service",
					"x-tedix-skill-run-id": "run-1",
					"x-tedix-skill-id": "skill-1",
					"x-tedix-workflow-step-id": `wfstep_${"a".repeat(64)}`,
					"x-tedix-workflow-step-name": "research%20%E2%9C%93",
					"x-tedix-workflow-step-count": "2",
					"x-tedix-workflow-step-attempt": "3",
					"x-tedix-workflow-call-id": `wfcall_${"b".repeat(64)}`,
					"x-tedix-workflow-idempotency-key": `wfidem_${"c".repeat(64)}`,
				},
			}),
		);

		expect(identity).toMatchObject({
			skillRunId: "run-1",
			skillId: "skill-1",
			workflowStepName: "research ✓",
			workflowStepCount: 2,
			workflowStepAttempt: 3,
			workflowStepId: `wfstep_${"a".repeat(64)}`,
			workflowCallId: `wfcall_${"b".repeat(64)}`,
			workflowIdempotencyKey: `wfidem_${"c".repeat(64)}`,
		});
	});

	it("ignores workflow trust headers on non-service identities", () => {
		const identity = extractCallerIdentity(
			new Request("https://mcp.test/mcp", {
				headers: {
					"x-tedix-auth-type": "oauth",
					"x-tedix-skill-run-id": "spoofed-run",
					"x-tedix-skill-id": "spoofed-skill",
					"x-tedix-workflow-step-id": "spoofed",
					"x-tedix-workflow-step-name": "spoofed",
					"x-tedix-workflow-step-count": "1",
					"x-tedix-workflow-idempotency-key": "spoofed",
				},
			}),
		);

		expect(identity?.workflowStepId).toBeUndefined();
		expect(identity?.skillRunId).toBeUndefined();
		expect(identity?.skillId).toBeUndefined();
		expect(identity?.workflowStepName).toBeUndefined();
		expect(identity?.workflowStepCount).toBeUndefined();
		expect(identity?.workflowIdempotencyKey).toBeUndefined();
	});

	it("drops malformed workflow coordinates instead of partially parsing them", () => {
		const identity = extractCallerIdentity(
			new Request("https://mcp.test/mcp", {
				headers: {
					"x-tedix-auth-type": "service",
					"x-tedix-workflow-step-count": "2junk",
					"x-tedix-workflow-step-attempt": "0",
					"x-tedix-workflow-step-name": "%0D%0Ainjected",
				},
			}),
		);

		expect(identity?.workflowStepCount).toBeUndefined();
		expect(identity?.workflowStepAttempt).toBeUndefined();
		expect(identity?.workflowStepName).toBeUndefined();
	});
});

interface RpcResponse {
	id: number;
	result?: Record<string, unknown>;
	error?: { code: number; message: string; data?: Record<string, unknown> };
}

/** Raw JSON-RPC client over a linked InMemoryTransport pair — drives the
 *  LEGACY handshake (initialize → notifications/initialized) so tests observe
 *  exactly what a conformant legacy client sees on the wire. */
async function connectLegacyClient(server: McpServer) {
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	const pending = new Map<number, (msg: RpcResponse) => void>();
	let nextId = 1;
	clientTransport.onmessage = (message) => {
		const msg = message as unknown as RpcResponse;
		if (typeof msg.id === "number" && ("result" in msg || "error" in msg)) {
			pending.get(msg.id)?.(msg);
			pending.delete(msg.id);
		}
	};
	await server.connect(serverTransport);
	const request = (
		method: string,
		params?: Record<string, unknown>,
	): Promise<RpcResponse> => {
		const id = nextId++;
		const response = new Promise<RpcResponse>((resolve) => {
			pending.set(id, resolve);
		});
		void clientTransport.send({
			jsonrpc: "2.0",
			id,
			method,
			...(params ? { params } : {}),
		} as never);
		return response;
	};
	const init = await request("initialize", {
		protocolVersion: "2025-11-25",
		capabilities: {},
		clientInfo: { name: "legacy-test-client", version: "0.0.1" },
	});
	await clientTransport.send({
		jsonrpc: "2.0",
		method: "notifications/initialized",
	} as never);
	return { init, request };
}

async function buildServerWithSkill(rows: unknown[] = [SKILL_ROW]) {
	listByApp.mockReset();
	getRunArtifact.mockReset();
	listByApp.mockResolvedValue({ skills: rows });
	const server = await buildMcpServer(
		createCachedData(),
		undefined,
		createEnv(),
		createExecutionContext(),
	);
	return connectLegacyClient(server);
}

describe("catalog MCP prompts", () => {
	it("publishes upstream prompt metadata and forwards prompts/get to the source", async () => {
		listByApp.mockReset();
		listByApp.mockResolvedValue({ skills: [] });
		getRunArtifact.mockReset();
		const cachedData = createCachedData();
		cachedData.catalogMcp = {
			id: "catalog-docs",
			slug: "docs",
			mcpEndpointNormalized: "https://docs.example.test/mcp",
			baseUrl: null,
			scanConnectionId: null,
			scanConnectionHeader: null,
			scanConnectionTemplate: null,
		};
		cachedData.catalogPrompts = [
			{
				id: "prompt-1",
				promptName: "summarize_page",
				title: "Summarize a page",
				description: "Summarize a Docs page",
				arguments: [
					{ name: "pageId", description: "Page identifier", required: true },
					{ name: "style", description: "Optional style", required: false },
				],
				icons: [{ src: "https://docs.example.test/icon.svg" }],
				annotations: { audience: ["assistant"], priority: 0.6 },
				meta: { "vendor.example/trace": { enabled: true } },
				catalogMcp: cachedData.catalogMcp,
			},
		];
		cachedData.catalogResources = [
			{
				id: "resource-1",
				uri: "docs://guide/start",
				name: "start-guide",
				title: "Start guide",
				description: "Getting started guide",
				mimeType: "text/markdown",
				icons: [{ src: "https://docs.example.test/icon.svg" }],
				annotations: {
					audience: ["assistant"],
					priority: 0.5,
					lastModified: "2026-09-22T10:00:00Z",
				},
				meta: { "vendor.example/resource": "kept" },
				sourceAppSlug: "docs",
				catalogMcp: cachedData.catalogMcp,
			},
		];
		cachedData.catalogResourceTemplates = [
			{
				id: "template-1",
				name: "page-template",
				title: "Page template",
				uriTemplate: "docs://pages/{pageId}",
				description: "A Docs page",
				mimeType: "text/markdown",
				icons: [{ src: "https://docs.example.test/icon.svg" }],
				annotations: {
					audience: ["assistant"],
					priority: 0.4,
					lastModified: "2026-09-22T10:00:00Z",
				},
				meta: { "vendor.example/template": "kept" },
				sourceAppSlug: "docs",
				catalogMcp: cachedData.catalogMcp,
			},
		];
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const request = JSON.parse(String(init?.body)) as {
					method: string;
					params: { name: string; arguments: Record<string, string> };
				};
				expect(String(input)).toBe("https://docs.example.test/mcp");
				expect(request).toMatchObject({
					method: "prompts/get",
					params: {
						name: "summarize_page",
						arguments: { pageId: "page-42" },
					},
				});
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: "upstream-1",
						result: {
							description: "Resolved upstream prompt",
							messages: [
								{
									role: "user",
									content: { type: "text", text: "Summarize page-42" },
								},
							],
							_meta: { "vendor.example/result": "preserved" },
						},
					}),
					{ headers: { "content-type": "application/json" } },
				);
			},
		);
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(fetchMock);
		try {
			const server = await buildMcpServer(
				cachedData,
				undefined,
				createEnv(),
				createExecutionContext(),
			);
			const { request } = await connectLegacyClient(server);
			const list = await request("prompts/list", {});
			expect(list.result?.prompts).toMatchObject([
				{
					name: "summarize_page",
					title: "Summarize a page",
					description: "Summarize a Docs page",
					arguments: [
						{ name: "pageId", description: "Page identifier", required: true },
						{ name: "style", description: "Optional style", required: false },
					],
					icons: [{ src: "https://docs.example.test/icon.svg" }],
					_meta: { "vendor.example/trace": { enabled: true } },
				},
			]);
			const resources = await request("resources/list", {});
			const resource = (
				resources.result?.resources as Array<Record<string, unknown>>
			).find((item) => item.uri === "docs://guide/start");
			expect(resource).toMatchObject({
				uri: "docs://guide/start",
				name: "catalog-resource-docs-guide-start",
				title: "Start guide",
				description: "Getting started guide",
				mimeType: "text/markdown",
				icons: [{ src: "https://docs.example.test/icon.svg" }],
				annotations: {
					audience: ["assistant"],
					priority: 0.5,
					lastModified: "2026-09-22T10:00:00Z",
				},
				_meta: { "vendor.example/resource": "kept" },
			});
			const templates = await request("resources/templates/list", {});
			const template = (
				templates.result?.resourceTemplates as Array<Record<string, unknown>>
			).find((item) => item.uriTemplate === "docs://pages/{pageId}");
			expect(template).toMatchObject({
				name: "catalog-resource-template-page-template",
				title: "Page template",
				uriTemplate: "docs://pages/{pageId}",
				description: "A Docs page",
				mimeType: "text/markdown",
				icons: [{ src: "https://docs.example.test/icon.svg" }],
				annotations: {
					audience: ["assistant"],
					priority: 0.4,
					lastModified: "2026-09-22T10:00:00Z",
				},
				_meta: { "vendor.example/template": "kept" },
			});
			const result = await request("prompts/get", {
				name: "summarize_page",
				arguments: { pageId: "page-42" },
			});
			expect(result.result).toMatchObject({
				description: "Resolved upstream prompt",
				messages: [
					{
						role: "user",
						content: { type: "text", text: "Summarize page-42" },
					},
				],
				_meta: { "vendor.example/result": "preserved" },
			});
			expect(fetchMock).toHaveBeenCalledTimes(1);
		} finally {
			fetchSpy.mockRestore();
		}
	});
});

describe("buildMcpServer — legacy initialize skills extension declaration", () => {
	it("declares io.modelcontextprotocol/skills with directoryRead, byte-for-byte like the modern server/discover path", async () => {
		const { init } = await buildServerWithSkill();

		const capabilities = init.result?.capabilities as
			| { extensions?: Record<string, unknown> }
			| undefined;
		expect(
			capabilities?.extensions?.["io.modelcontextprotocol/skills"],
		).toEqual({
			directoryRead: true,
		});
		// The sibling extension declarations are unchanged.
		expect(capabilities?.extensions).toEqual({
			"io.modelcontextprotocol/apps": {},
			"io.modelcontextprotocol/ui": {},
			"io.modelcontextprotocol/skills": { directoryRead: true },
		});
	});
});

describe("Skills-over-MCP v1 methods", () => {
	it("implements both methods when the enumerable catalog is empty", async () => {
		listByApp.mockReset();
		listByApp.mockResolvedValue({ skills: [] });
		const server = await buildMcpServer(
			createCachedData(),
			undefined,
			createEnv(),
			createExecutionContext(),
		);
		const { request } = await connectLegacyClient(server);
		// Whole (empty) catalog, and no nextCursor on the last page.
		expect((await request("skills/list", {})).result).toEqual({ skills: [] });
		expect(
			(await request("skills/get", { uri: "skill://missing/SKILL.md" })).error
				?.code,
		).toBe(-32602);
	});

	it("serves skills/list and skills/get with complete per-file digests", async () => {
		const { request } = await buildServerWithSkill();
		const listed = await request("skills/list", {});
		expect(listed.error).toBeUndefined();
		const skills = listed.result?.skills as Array<{
			uri: string;
			frontmatter: Record<string, unknown>;
			resources: Array<{ uri: string; digest: string; size: number }>;
		}>;
		expect(skills).toHaveLength(1);
		expect(skills[0]?.uri).toBe("skill://tedix/deploy-widget/SKILL.md");
		expect(skills[0]?.frontmatter).toMatchObject({
			name: "deploy-widget",
			description: "How to deploy a widget",
		});
		expect(skills[0]?.resources.map((resource) => resource.uri)).toEqual([
			"skill://tedix/deploy-widget/SKILL.md",
			"skill://tedix/deploy-widget/references/guide.md",
		]);
		expect(
			skills[0]?.resources.every(
				(resource) =>
					/^sha256:[0-9a-f]{64}$/.test(resource.digest) &&
					Number.isSafeInteger(resource.size) &&
					resource.size >= 0,
			),
		).toBe(true);
		const skillRead = await request("resources/read", {
			uri: skills[0]?.uri,
		});
		const servedMarkdown = (
			skillRead.result as { contents: Array<{ text: string }> }
		).contents[0]!.text;
		expect(skills[0]?.resources[0]?.size).toBe(
			new TextEncoder().encode(servedMarkdown).byteLength,
		);
		const guideRead = await request("resources/read", {
			uri: skills[0]?.resources[1]?.uri,
		});
		const servedGuide = (
			guideRead.result as { contents: Array<{ text: string }> }
		).contents[0]!.text;
		expect(skills[0]?.resources[1]?.size).toBe(
			new TextEncoder().encode(servedGuide).byteLength,
		);
		// Full-set behavior for a client that never paginates: the catalog fits
		// in one page, so nextCursor is absent.
		expect(listed.result?.nextCursor).toBeUndefined();

		const fetched = await request("skills/get", { uri: skills[0]?.uri });
		expect(fetched.result?.skill).toEqual(skills[0]);

		const missing = await request("skills/get", {
			uri: "skill://tedix/missing/SKILL.md",
		});
		expect(missing.error?.code).toBe(-32602);
	});

	it.each([
		{
			name: "exactly 512 total resources",
			files: Object.fromEntries(
				Array.from({ length: 511 }, (_, index) => [
					`references/${index}.md`,
					"x",
				]),
			),
			accepted: true,
		},
		{
			name: "512 supporting files",
			files: Object.fromEntries(
				Array.from({ length: 512 }, (_, index) => [
					`references/${index}.md`,
					"x",
				]),
			),
			accepted: false,
		},
		{
			name: "more than 16 MiB of files",
			files: { "references/large.md": "x".repeat(16 * 1024 * 1024) },
			accepted: false,
		},
	])(
		"enforces SEP-2640 resource limits: $name",
		async ({ files, accepted }) => {
			const { request } = await buildServerWithSkill([{ ...SKILL_ROW, files }]);

			const listed = await request("skills/list", {});
			expect(listed.error).toBeUndefined();
			if (accepted) {
				const skills = listed.result?.skills as Array<{
					resources: unknown[];
				}>;
				expect(skills).toHaveLength(1);
				expect(skills[0]?.resources).toHaveLength(512);
				return;
			}
			expect(listed.result?.skills).toEqual([]);
			const read = await request("resources/read", {
				uri: "skill://tedix/deploy-widget/SKILL.md",
			});
			expect(read.error?.code).toBe(-32602);
		},
	);

	it("paginates skills/list with opaque cursors in deterministic uri order", async () => {
		// Zero-padded slugs, mocked in REVERSE order: the served order must come
		// from the explicit uri sort, not the D1 read / Map insertion order.
		const count = SKILLS_LIST_PAGE_SIZE + 20;
		const rows = Array.from({ length: count }, (_, i) => {
			const slug = `skill-${String(i).padStart(4, "0")}`;
			return {
				...SKILL_ROW,
				id: `skill_${i}`,
				slug,
				title: `Skill ${i}`,
				files: null,
				content: `---\nname: ${slug}\n---\n\n# Procedure ${i}`,
			};
		}).reverse();
		listByApp.mockReset();
		getRunArtifact.mockReset();
		listByApp.mockResolvedValue({ skills: rows });
		const server = await buildMcpServer(
			createCachedData(),
			undefined,
			createEnv(),
			createExecutionContext(),
		);
		const { request } = await connectLegacyClient(server);

		const first = await request("skills/list", {});
		expect(first.error).toBeUndefined();
		const firstSkills = first.result?.skills as Array<{ uri: string }>;
		expect(firstSkills).toHaveLength(SKILLS_LIST_PAGE_SIZE);
		const firstUris = firstSkills.map((skill) => skill.uri);
		expect(firstUris).toEqual([...firstUris].sort());
		const nextCursor = first.result?.nextCursor as string;
		expect(typeof nextCursor).toBe("string");
		// Opaque: the cursor never leaks the anchoring uri in the clear.
		expect(nextCursor).not.toContain("skill://");

		const second = await request("skills/list", { cursor: nextCursor });
		expect(second.error).toBeUndefined();
		const secondSkills = second.result?.skills as Array<{ uri: string }>;
		expect(secondSkills).toHaveLength(count - SKILLS_LIST_PAGE_SIZE);
		// Terminal page: nextCursor absent.
		expect(second.result?.nextCursor).toBeUndefined();

		// Walk is complete, gapless, and globally uri-sorted.
		const all = [...firstUris, ...secondSkills.map((skill) => skill.uri)];
		expect(new Set(all).size).toBe(count);
		expect(all).toEqual([...all].sort());
	});

	it("rejects an unrecognized skills/list cursor with -32602", async () => {
		const { request } = await buildServerWithSkill();
		const response = await request("skills/list", {
			cursor: "not-a-cursor",
		});
		expect(response.result).toBeUndefined();
		expect(response.error?.code).toBe(-32602);
	});
});

describe("skill:// resource reads — unknown skill/file are protocol errors, not 200 prose", () => {
	it("resources/read of an unknown skill via the flat SKILL.md template returns JSON-RPC -32602", async () => {
		const { request } = await buildServerWithSkill();

		const response = await request("resources/read", {
			uri: "skill://nope/SKILL.md",
		});
		expect(response.result).toBeUndefined();
		expect(response.error?.code).toBe(-32602);
		expect(response.error?.data?.reason).toBe("resource_not_found");
	});

	it("resources/read of an unknown skill via the app-scoped SKILL.md template returns -32602", async () => {
		const { request } = await buildServerWithSkill();

		const response = await request("resources/read", {
			uri: "skill://tedix/nope/SKILL.md",
		});
		expect(response.error?.code).toBe(-32602);
		expect(response.error?.data?.reason).toBe("resource_not_found");
	});

	it("resources/read of a file under an unknown skill returns -32602 (no runs/ probing leak)", async () => {
		const { request } = await buildServerWithSkill();

		const response = await request("resources/read", {
			uri: "skill://tedix/nope/references/anything.md",
		});
		expect(response.error?.code).toBe(-32602);
		expect(response.error?.data?.reason).toBe("resource_not_found");
	});

	it("resources/read of a missing file in a known skill returns -32602", async () => {
		const { request } = await buildServerWithSkill();

		const response = await request("resources/read", {
			uri: "skill://tedix/deploy-widget/references/missing.md",
		});
		expect(response.error?.code).toBe(-32602);
		expect(response.error?.data?.reason).toBe("resource_not_found");
	});

	it("resources/read of a malformed runs/ path returns -32602 without hitting the artifact API", async () => {
		const { request } = await buildServerWithSkill();

		const response = await request("resources/read", {
			uri: "skill://tedix/deploy-widget/runs/only-a-run-id",
		});
		expect(response.error?.code).toBe(-32602);
		expect(response.error?.data?.reason).toBe("resource_not_found");
		expect(getRunArtifact).not.toHaveBeenCalled();
	});

	it("resources/read of a missing run artifact returns -32602 when the artifact API rejects", async () => {
		const { request } = await buildServerWithSkill();
		getRunArtifact.mockRejectedValue(new Error("artifact not found"));

		const response = await request("resources/read", {
			uri: "skill://tedix/deploy-widget/runs/run_1/output.txt",
		});
		expect(response.error?.code).toBe(-32602);
		expect(response.error?.data?.reason).toBe("resource_not_found");
		expect(getRunArtifact).toHaveBeenCalledWith({
			runId: "run_1",
			path: "output.txt",
			skillId: "skill_1",
		});
	});

	it("still serves known skill files and SKILL.md (happy path unchanged)", async () => {
		const { request } = await buildServerWithSkill();

		const file = await request("resources/read", {
			uri: "skill://tedix/deploy-widget/references/guide.md",
		});
		expect(file.error).toBeUndefined();
		const fileContents = file.result?.contents as Array<{
			text?: string;
			mimeType?: string;
		}>;
		expect(fileContents[0]?.text).toBe("# Guide");
		expect(fileContents[0]?.mimeType).toBe("text/markdown");

		const skillMd = await request("resources/read", {
			uri: "skill://tedix/deploy-widget/SKILL.md",
		});
		expect(skillMd.error).toBeUndefined();
		const skillContents = skillMd.result?.contents as Array<{ text?: string }>;
		expect(skillContents[0]?.text).toContain("# Deploy procedure");
	});

	it("does not publish the removed pre-v1 skill index", async () => {
		const { request } = await buildServerWithSkill();
		const listed = await request("resources/list", {});
		const resources = listed.result?.resources as Array<{ uri: string }>;
		expect(
			resources.some((resource) => resource.uri === "skill://index.json"),
		).toBe(false);

		const read = await request("resources/read", { uri: "skill://index.json" });
		expect(read.error).toBeDefined();
	});
});

describe("skill resource _meta — custom frontmatter key lives under io.tedix/", () => {
	it("emits io.tedix/frontmatter and never the reserved io.modelcontextprotocol.skills/ prefix", async () => {
		const { request } = await buildServerWithSkill();

		const response = await request("resources/list", {});
		const resources = response.result?.resources as Array<{
			uri: string;
			_meta?: Record<string, unknown>;
		}>;
		const skillResource = resources.find(
			(resource) => resource.uri === "skill://tedix/deploy-widget/SKILL.md",
		);
		expect(skillResource).toBeDefined();
		expect(skillResource?._meta?.["io.tedix/frontmatter"]).toMatchObject({
			version: 3,
			tags: ["ops"],
			provenance: "tedix.mcp.tedix.dev",
		});
		expect(
			skillResource?._meta?.["io.modelcontextprotocol.skills/frontmatter"],
		).toBeUndefined();
	});
});

describe("skill://…/SKILL.md — SEP-2549 result-level hint", () => {
	it("attaches the 5 min private hint marker (not the 60s method default)", async () => {
		const { request } = await buildServerWithSkill();

		const response = await request("resources/read", {
			uri: "skill://tedix/deploy-widget/SKILL.md",
		});
		expect(response.error).toBeUndefined();
		// Raw marker (this harness bypasses mountMcp); the transport consumes it
		// into top-level `ttlMs`/`cacheScope` wire fields.
		const meta = response.result?._meta as Record<string, unknown> | undefined;
		expect(meta?.[MCP_RESULT_CACHE_HINT_META_KEY]).toEqual({
			ttlMs: 5 * 60_000,
			cacheScope: "private",
		});
	});
});

describe("buildEdgeListCacheHints — SEP-2549 list-surface hints mirror the backing caches", () => {
	it("defaults to the 60s per-app D1 cache TTL, private, on every list method", () => {
		const hints = buildEdgeListCacheHints();
		for (const method of [
			"tools/list",
			"prompts/list",
			"resources/list",
			"resources/templates/list",
			// SEP-2640: skills/list is a list surface with the same freshness
			// reality (the catalog rebuilds with the app context / aggregate
			// surface), so it carries the same hint.
			"skills/list",
		]) {
			expect(hints[method], method).toEqual({
				ttlMs: 60_000,
				cacheScope: "private",
			});
		}
		// resources/read keeps the transport default; per-result markers own it.
		expect(hints["resources/read"]).toBeUndefined();
	});

	it("aggregate mounts pass their 120s surface-cache TTL through", () => {
		const hints = buildEdgeListCacheHints(120_000);
		expect(hints["tools/list"]).toEqual({
			ttlMs: 120_000,
			cacheScope: "private",
		});
	});
});
