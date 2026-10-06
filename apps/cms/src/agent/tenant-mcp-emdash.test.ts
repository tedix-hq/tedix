import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDialect } from "emdash/db/sqlite";
import {
	GET as mcpGet,
	POST as mcpPost,
} from "../../templates/tedix/node_modules/emdash/dist/astro/routes/api/mcp.mjs";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import {
	type CmsProxyContext,
	callCmsRest,
	callTenantMcpTool,
	clearTenantMcpEras,
	type ToolResult,
} from "./cms-proxy-runtime";

vi.mock("virtual:emdash/config", () => ({ default: {} }));
// The released auth middleware's Astro/virtual imports. Bearer (PAT) auth, the
// only mode exercised here, never reaches the external `authenticate` hook.
vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));
vi.mock("virtual:emdash/auth", () => ({
	authenticate: () => {
		throw new Error("external auth is not exercised");
	},
}));
vi.mock("virtual:emdash/seed", () => ({
	seed: {
		version: "1",
		settings: {},
		collections: [
			{
				slug: "pages",
				label: "Pages",
				supports: ["drafts", "revisions", "scheduling"],
				fields: [{ slug: "title", label: "Title", type: "string" }],
			},
		],
	},
	userSeed: null,
}));

// The compiled runtime and MCP route shipped in the tenant starter: the route
// serves MCP through the official 2025-era SDK
// WebStandardStreamableHTTPServerTransport, exactly as deployed.
// @ts-expect-error Emdash does not publish declarations for its internal chunk.
import { n as TedixEmDashRuntime } from "../../templates/tedix/node_modules/emdash/dist/emdash-runtime-BlybX9Ui.mjs";
// @ts-expect-error Emdash does not publish declarations for its internal chunk.
import { n as handleEntryLockAcquire } from "../../templates/tedix/node_modules/emdash/dist/entry-lock-De1L8qUQ.mjs";
// @ts-expect-error Emdash does not publish declarations for its internal chunk.
import { n as handleApiTokenCreate } from "../../templates/tedix/node_modules/emdash/dist/api-tokens-P3mAaQgr.mjs";
import { onRequest as authMiddleware } from "../../templates/tedix/node_modules/emdash/dist/astro/middleware/auth.mjs";
import * as bylinesRoute from "../../templates/tedix/node_modules/emdash/dist/astro/routes/api/admin/bylines/index.mjs";
import * as bylineRoute from "../../templates/tedix/node_modules/emdash/dist/astro/routes/api/admin/bylines/_id_/index.mjs";
import * as bylineTranslationsRoute from "../../templates/tedix/node_modules/emdash/dist/astro/routes/api/admin/bylines/_id_/translations.mjs";

type Runtime = InstanceType<typeof TedixEmDashRuntime>;

const ROLE_SUBSCRIBER = 10;
const ROLE_ADMIN = 50;

let runtimeCount = 0;

async function createRuntime(testDir: string): Promise<Runtime> {
	const url = `file:${join(testDir, "site.db")}`;
	// Emdash caches the database per entrypoint; a destroyed one must not be
	// reused by the next test.
	runtimeCount++;
	return TedixEmDashRuntime.create({
		config: {
			database: {
				entrypoint: `tenant-mcp-writes-${runtimeCount}`,
				config: { url },
				type: "sqlite",
			},
		},
		plugins: [],
		createDialect: () => createDialect({ url }),
		createStorage: null,
		sandboxEnabled: false,
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
	});
}

/**
 * A Site Builder context whose CMS dispatch serves the tenant MCP endpoint
 * from the released Emdash route, and records (without serving) any REST
 * request so a test can prove which transport a call took.
 */
function tenantContext(
	runtime: Runtime,
	options: { role?: number; tokenScopes?: string[] } = {},
) {
	const toolCalls: string[] = [];
	const restRequests: string[] = [];
	const invalidatedTags: string[][] = [];
	const urlPatternInvalidations: number[] = [];
	// The request-scoped handlers object the Emdash middleware builds from the
	// runtime (astro/middleware.ts): runtime methods plus the URL-pattern cache
	// invalidator that schema mutations call.
	const handlers = new Proxy(runtime, {
		get(target, prop) {
			if (prop === "invalidateUrlPatternCache") {
				return () => urlPatternInvalidations.push(Date.now());
			}
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const ctx: CmsProxyContext = {
		orgSlug: "acme",
		forwardedAuth: undefined,
		serviceApiKey: "ec_pat_secret",
		internalAuthToken: undefined,
		environment: "production",
		cmsDispatch: {
			fetch: async (request: Request) => {
				const url = new URL(request.url);
				if (url.pathname !== "/_emdash/api/mcp") {
					restRequests.push(`${request.method} ${url.pathname}`);
					return Response.json(
						{ success: false, error: { code: "TEST", message: "REST hit" } },
						{ status: 418 },
					);
				}
				if (request.method !== "POST") {
					return mcpGet({} as Parameters<typeof mcpGet>[0]);
				}
				const body = (await request.clone().json()) as {
					method?: string;
					params?: { name?: string };
				};
				if (body.method === "tools/call") toolCalls.push(body.params!.name!);
				return mcpPost({
					request,
					locals: {
						emdash: handlers,
						user: { id: "service", role: options.role ?? ROLE_ADMIN },
						tokenScopes: options.tokenScopes,
					},
					cache: {
						enabled: true,
						invalidate: async ({ tags }: { tags: string[] }) => {
							invalidatedTags.push(tags);
						},
					},
				} as unknown as Parameters<typeof mcpPost>[0]);
			},
		} as unknown as Fetcher,
	};
	return {
		ctx,
		toolCalls,
		restRequests,
		invalidatedTags,
		urlPatternInvalidations,
	};
}

function payload(result: ToolResult): Record<string, any> {
	expect(result.isError, result.content[0]?.text).toBeUndefined();
	const parsed = JSON.parse(result.content[0]?.text ?? "{}");
	expect(parsed.success).toBe(true);
	return parsed.data;
}

async function createDraft(runtime: Runtime, title: string): Promise<string> {
	const created = await runtime.handleContentCreate("pages", {
		data: { title },
	});
	if (!created.success) throw new Error(created.error.message);
	return created.data.item.id as string;
}

describe("Site Builder content and schema writes over the released Emdash MCP route", () => {
	let runtime: Runtime | undefined;
	let testDir: string | undefined;

	beforeEach(async () => {
		clearTenantMcpEras();
		testDir = await mkdtemp(join(tmpdir(), "tedix-tenant-mcp-writes-"));
		runtime = await createRuntime(testDir);
	});

	afterEach(async () => {
		if (runtime) {
			await runtime.stopCron();
			await runtime.db.destroy();
		}
		runtime = undefined;
		if (testDir) await rm(testDir, { recursive: true, force: true });
		testDir = undefined;
	});

	it("updates and publishes natively under a current _rev and rejects a stale one", async () => {
		const id = await createDraft(runtime!, "Draft");
		const { ctx, toolCalls, restRequests, invalidatedTags } = tenantContext(
			runtime!,
		);

		const read = payload(
			await callCmsRest(ctx, "content_get", { collection: "pages", id }),
		);
		const staleRev = read._rev as string;

		const updated = payload(
			await callCmsRest(ctx, "content_update", {
				collection: "pages",
				id,
				data: { title: "Edited" },
				_rev: staleRev,
			}),
		);
		expect(updated.item.data.title).toBe("Edited");
		expect(typeof updated._rev).toBe("string");
		expect(updated._rev).not.toBe(staleRev);

		const conflict = await callCmsRest(ctx, "content_update", {
			collection: "pages",
			id,
			data: { title: "Lost update" },
			_rev: staleRev,
		});
		expect(conflict.isError).toBe(true);
		expect(conflict.content[0]?.text).toContain("CONFLICT");

		const stalePublish = await callCmsRest(ctx, "content_publish", {
			collection: "pages",
			id,
			_rev: staleRev,
		});
		expect(stalePublish.isError).toBe(true);
		expect(stalePublish.content[0]?.text).toContain("CONFLICT");

		const published = payload(
			await callCmsRest(ctx, "content_publish", {
				collection: "pages",
				id,
				_rev: updated._rev,
			}),
		);
		expect(published.item.status).toBe("published");

		const live = await runtime!.handleContentGet("pages", id);
		if (!live.success) throw new Error(live.error.message);
		expect(live.data.item.data.title).toBe("Edited");
		expect(live.data.item.status).toBe("published");

		// Every call rode tools/call exactly once, never the REST API, and the
		// successful writes invalidated the entry's route-cache tags.
		expect(toolCalls).toEqual([
			"content_get",
			"content_update",
			"content_update",
			"content_publish",
			"content_publish",
		]);
		expect(restRequests).toEqual([]);
		expect(invalidatedTags).toContainEqual(["pages", id]);
	});

	it.each(["content_unpublish", "content_schedule", "content_discard_draft"])(
		"guards %s with the current native revision",
		async (tool) => {
			const id = await createDraft(runtime!, "Draft");
			const { ctx, toolCalls, restRequests } = tenantContext(runtime!);
			const read = payload(
				await callCmsRest(ctx, "content_get", { collection: "pages", id }),
			);
			const updated = payload(
				await callCmsRest(ctx, "content_update", {
					collection: "pages",
					id,
					data: { title: "Edited" },
					_rev: read._rev,
				}),
			);
			const args = {
				collection: "pages",
				id,
				...(tool === "content_schedule"
					? { scheduledAt: "2099-01-01T00:00:00Z" }
					: {}),
			};
			const stale = await callCmsRest(ctx, tool, { ...args, _rev: read._rev });
			expect(stale.isError).toBe(true);
			expect(stale._meta?.code).toBe("CONFLICT");
			const fresh = await callCmsRest(ctx, tool, {
				...args,
				_rev: updated._rev,
			});
			expect(fresh.isError).toBeUndefined();
			expect(toolCalls.slice(-2)).toEqual([tool, tool]);
			expect(restRequests).toEqual([]);
		},
	);

	it("keeps rev-less and locale-scoped content writes on REST", async () => {
		const id = await createDraft(runtime!, "Draft");
		const { ctx, toolCalls, restRequests } = tenantContext(runtime!);

		await callCmsRest(ctx, "content_update", {
			collection: "pages",
			id,
			data: { title: "No rev" },
		});
		await callCmsRest(ctx, "content_publish", { collection: "pages", id });
		await callCmsRest(ctx, "content_delete", {
			collection: "pages",
			id,
			locale: "de",
		});
		await callCmsRest(ctx, "content_unpublish", { collection: "pages", id });

		expect(toolCalls).toEqual([]);
		expect(restRequests).toEqual([
			`PUT /_emdash/api/content/pages/${id}`,
			`POST /_emdash/api/content/pages/${id}/publish`,
			`DELETE /_emdash/api/content/pages/${id}`,
			`POST /_emdash/api/content/pages/${id}/unpublish`,
		]);
	});

	it("trashes, restores, duplicates, unschedules and permanently deletes natively", async () => {
		const id = await createDraft(runtime!, "Original");
		const { ctx, toolCalls, restRequests, invalidatedTags } = tenantContext(
			runtime!,
		);

		const copy = payload(
			await callCmsRest(ctx, "content_duplicate", {
				collection: "pages",
				id,
			}),
		);
		expect(copy.item.id).not.toBe(id);
		expect(copy.item.status).toBe("draft");

		const scheduledAt = new Date(Date.now() + 86_400_000).toISOString();
		const scheduled = await runtime!.handleContentSchedule(
			"pages",
			id,
			scheduledAt,
		);
		if (!scheduled.success) throw new Error(scheduled.error.message);
		const unscheduled = payload(
			await callCmsRest(ctx, "content_unschedule", {
				collection: "pages",
				id,
			}),
		);
		expect(unscheduled.item.scheduledAt ?? null).toBeNull();

		payload(
			await callCmsRest(ctx, "content_delete", { collection: "pages", id }),
		);
		const trashed = payload(
			await callCmsRest(ctx, "content_list_trashed", { collection: "pages" }),
		);
		expect(trashed.items.map((item: { id: string }) => item.id)).toEqual([id]);

		const restored = payload(
			await callCmsRest(ctx, "content_restore", { collection: "pages", id }),
		);
		expect(restored).toBeDefined();
		expect((await runtime!.handleContentGet("pages", id)).success).toBe(true);

		payload(
			await callCmsRest(ctx, "content_delete", { collection: "pages", id }),
		);
		payload(
			await callCmsRest(ctx, "content_permanent_delete", {
				collection: "pages",
				id,
			}),
		);
		expect(
			(await runtime!.handleContentGetIncludingTrashed("pages", id)).success,
		).toBe(false);

		expect(toolCalls).toEqual([
			"content_duplicate",
			"content_unschedule",
			"content_delete",
			"content_list_trashed",
			"content_restore",
			"content_delete",
			"content_permanent_delete",
		]);
		expect(restRequests).toEqual([]);
		expect(invalidatedTags).toContainEqual(["pages", id]);
	});

	it("refuses a native write while another editor holds the entry lock", async () => {
		const id = await createDraft(runtime!, "Locked");
		await runtime!.db
			.insertInto("users")
			.values({ id: "editor", email: "editor@example.com", role: 40 })
			.execute();
		const lock = await handleEntryLockAcquire(
			runtime!.db,
			"pages",
			id,
			"editor",
		);
		expect(lock.success).toBe(true);
		const { ctx } = tenantContext(runtime!);

		const refused = await callCmsRest(ctx, "content_delete", {
			collection: "pages",
			id,
		});
		expect(refused.isError).toBe(true);
		expect(refused.content[0]?.text).toContain("ENTRY_LOCKED");
		expect((await runtime!.handleContentGet("pages", id)).success).toBe(true);

		payload(
			await callCmsRest(ctx, "content_delete", {
				collection: "pages",
				id,
				overrideLock: true,
			}),
		);
		expect((await runtime!.handleContentGet("pages", id)).success).toBe(false);
	});

	it("restores through native lock policy only with explicit override and retains permissions", async () => {
		const id = await createDraft(runtime!, "Original");
		const { ctx } = tenantContext(runtime!);
		const read = payload(
			await callCmsRest(ctx, "content_get", { collection: "pages", id }),
		);
		payload(
			await callCmsRest(ctx, "content_update", {
				collection: "pages",
				id,
				_rev: read._rev,
				data: { title: "Revision" },
			}),
		);
		const revisions = payload(
			await callCmsRest(ctx, "revision_list", { collection: "pages", id }),
		);
		const revisionId = revisions.items[0].id;
		await runtime!.db
			.insertInto("users")
			.values({ id: "editor", email: "editor@example.com", role: 40 })
			.execute();
		await handleEntryLockAcquire(runtime!.db, "pages", id, "editor");
		for (const overrideLock of [undefined, false]) {
			const refused = await callCmsRest(ctx, "revision_restore", {
				revisionId,
				overrideLock,
			});
			expect(refused.isError).toBe(true);
			expect(refused.content[0]?.text).toContain("ENTRY_LOCKED");
		}
		for (const options of [
			{ role: ROLE_SUBSCRIBER },
			{ tokenScopes: ["content:read"] },
		]) {
			const refused = await callCmsRest(
				tenantContext(runtime!, options).ctx,
				"revision_restore",
				{ revisionId, overrideLock: true },
			);
			expect(refused.isError).toBe(true);
			expect(refused.content[0]?.text).toMatch(
				/INSUFFICIENT_(PERMISSIONS|SCOPE)/,
			);
		}
		const restored = payload(
			await callCmsRest(ctx, "revision_restore", {
				revisionId,
				overrideLock: true,
			}),
		);
		expect(restored.item.data.title).toBe("Revision");
		expect(restored.item.status).toBe("draft");
	});

	it("never widens access: a subscriber or read-scoped token cannot use the native writes", async () => {
		const id = await createDraft(runtime!, "Unpublished draft");
		const subscriber = tenantContext(runtime!, { role: ROLE_SUBSCRIBER });

		const duplicate = await callCmsRest(subscriber.ctx, "content_duplicate", {
			collection: "pages",
			id,
		});
		expect(duplicate.isError).toBe(true);
		expect(duplicate.content[0]?.text).toContain("INSUFFICIENT_PERMISSIONS");
		expect(duplicate.content[0]?.text).not.toContain("Unpublished draft");

		const readOnly = tenantContext(runtime!, { tokenScopes: ["content:read"] });
		const deleted = await callCmsRest(readOnly.ctx, "content_delete", {
			collection: "pages",
			id,
		});
		expect(deleted.isError).toBe(true);
		expect(deleted.content[0]?.text).toContain("INSUFFICIENT_SCOPE");
		const schema = await callCmsRest(readOnly.ctx, "schema_update_collection", {
			slug: "pages",
			label: "Hijacked",
		});
		expect(schema.isError).toBe(true);
		expect(schema.content[0]?.text).toContain("INSUFFICIENT_SCOPE");

		const current = await runtime!.handleContentGet("pages", id);
		if (!current.success) throw new Error(current.error.message);
		expect(current.data.item.status).toBe("draft");
	});

	it("updates collection settings and block types natively with fingerprint conflicts", async () => {
		const { ctx, toolCalls, restRequests, urlPatternInvalidations } =
			tenantContext(runtime!);

		const collection = payload(
			await callCmsRest(ctx, "schema_update_collection", {
				slug: "pages",
				label: "Seiten",
				urlPattern: "/seiten/{slug}",
				hasSeo: true,
			}),
		);
		expect(collection.item ?? collection).toMatchObject({
			slug: "pages",
			label: "Seiten",
			urlPattern: "/seiten/{slug}",
			hasSeo: true,
		});
		expect(urlPatternInvalidations).toHaveLength(1);

		const field = { slug: "headline", label: "Headline", type: "string" };
		const created = payload(
			await callCmsRest(ctx, "schema_create_block_type", {
				slug: "hero",
				label: "Hero",
				fields: [field],
			}),
		);
		const fingerprint = created.item.versions.find(
			(version: { version: number }) =>
				version.version === created.item.currentVersion,
		).fingerprint as string;

		const listed = payload(
			await callCmsRest(ctx, "schema_list_block_types", {}),
		);
		expect(listed.items.map((item: { slug: string }) => item.slug)).toContain(
			"hero",
		);
		payload(await callCmsRest(ctx, "schema_get_block_type", { slug: "hero" }));

		const stale = await callCmsRest(ctx, "schema_update_block_type", {
			slug: "hero",
			expectedFingerprint: "stale",
			label: "Stale",
		});
		expect(stale.isError).toBe(true);
		expect(stale.content[0]?.text).toContain("CONFLICT");

		const updated = payload(
			await callCmsRest(ctx, "schema_update_block_type", {
				slug: "hero",
				expectedFingerprint: fingerprint,
				label: "Hero banner",
			}),
		);
		expect(updated.item.label).toBe("Hero banner");

		const staleActivate = await callCmsRest(
			ctx,
			"schema_activate_block_type_version",
			{ slug: "hero", version: 1, expectedFingerprint: "stale" },
		);
		expect(staleActivate.isError).toBe(true);
		expect(staleActivate.content[0]?.text).toContain("CONFLICT");

		expect(toolCalls).toEqual([
			"schema_update_collection",
			"schema_create_block_type",
			"schema_list_block_types",
			"schema_get_block_type",
			"schema_update_block_type",
			"schema_update_block_type",
			"schema_activate_block_type_version",
		]);
		expect(restRequests).toEqual([]);
	});
});

describe("tenant MCP forwarding against the released Emdash MCP route", () => {
	let runtime: Runtime | undefined;
	let testDir: string | undefined;

	beforeEach(() => clearTenantMcpEras());

	afterEach(async () => {
		if (runtime) {
			await runtime.stopCron();
			await runtime.db.destroy();
		}
		runtime = undefined;
		if (testDir) await rm(testDir, { recursive: true, force: true });
		testDir = undefined;
	});

	it("negotiates the legacy era once, then reuses it without re-probing", async () => {
		testDir = await mkdtemp(join(tmpdir(), "tedix-tenant-mcp-emdash-"));
		const url = `file:${join(testDir, "site.db")}`;
		runtime = await TedixEmDashRuntime.create({
			config: {
				database: { entrypoint: "tenant-mcp", config: { url }, type: "sqlite" },
			},
			plugins: [],
			createDialect: () => createDialect({ url }),
			createStorage: null,
			sandboxEnabled: false,
			sandboxedPluginEntries: [],
			createSandboxRunner: null,
		});
		const created = await runtime!.handleContentCreate("pages", {
			data: { title: "Hello" },
			status: "published",
		});
		if (!created.success) throw new Error(created.error.message);
		const id = created.data.item.id as string;

		const exchanges: Array<{
			method: string;
			rpc: string | undefined;
			status: number;
		}> = [];
		const ctx: CmsProxyContext = {
			orgSlug: "acme",
			forwardedAuth: undefined,
			serviceApiKey: "ec_pat_secret",
			internalAuthToken: undefined,
			environment: "production",
			cmsDispatch: {
				fetch: async (request: Request) => {
					expect(new URL(request.url).href).toBe(
						"https://acme.cms.tedix.dev/_emdash/api/mcp",
					);
					expect(request.headers.get("authorization")).toBe(
						"Bearer ec_pat_secret",
					);
					const rpc =
						request.method === "POST"
							? ((await request.clone().json()) as { method?: string }).method
							: undefined;
					const response =
						request.method === "POST"
							? await mcpPost({
									request,
									locals: {
										emdash: runtime,
										user: { id: "service", role: 50 },
									},
								} as unknown as Parameters<typeof mcpPost>[0])
							: await mcpGet({} as Parameters<typeof mcpGet>[0]);
					exchanges.push({
						method: request.method,
						rpc,
						status: response.status,
					});
					return response;
				},
			} as unknown as Fetcher,
		};

		const first = await callTenantMcpTool(ctx, "content_get", {
			collection: "pages",
			id,
		});
		expect(first.isError).toBeUndefined();
		expect(JSON.parse(first.content[0]?.text ?? "{}").item.data.title).toBe(
			"Hello",
		);
		// Emdash rejects the 2026 probe with HTTP 400 "Unsupported protocol
		// version"; the SDK treats that as a legacy signal, not a failure.
		expect(exchanges).toEqual([
			{ method: "POST", rpc: "server/discover", status: 400 },
			{ method: "POST", rpc: "initialize", status: 200 },
			{ method: "POST", rpc: "notifications/initialized", status: 202 },
			{ method: "POST", rpc: "tools/call", status: 200 },
		]);

		exchanges.length = 0;
		const second = await callTenantMcpTool(ctx, "content_get", {
			collection: "pages",
			id: "missing",
		});
		expect(second.isError).toBe(true);
		expect(second.content[0]?.text).toContain("NOT_FOUND");
		// The remembered legacy verdict skips the probe; the tool error is
		// returned as-is and tools/call is sent exactly once.
		expect(exchanges).toEqual([
			{ method: "POST", rpc: "initialize", status: 200 },
			{ method: "POST", rpc: "notifications/initialized", status: 202 },
			{ method: "POST", rpc: "tools/call", status: 200 },
		]);
	});
});

type RouteModule = Record<string, unknown>;

/**
 * A Site Builder context whose CMS dispatch runs every request through the
 * released Emdash auth middleware with a real PAT stored in the site database:
 * the middleware resolves the token, enforces its REST scope rules, and hands
 * off to the released byline REST routes or the MCP route.
 */
function authenticatedTenant(runtime: Runtime, token: string) {
	const toolCalls: string[] = [];
	const restRequests: string[] = [];
	const handlers = new Proxy(runtime, {
		get(target, prop) {
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const routeFor = (
		pathname: string,
	): { module: RouteModule; params: Record<string, string> } | null => {
		if (pathname === "/_emdash/api/mcp") {
			return { module: { GET: mcpGet, POST: mcpPost }, params: {} };
		}
		const match =
			/^\/_emdash\/api\/admin\/bylines(?:\/([^/]+)(\/translations)?)?$/.exec(
				pathname,
			);
		if (!match) return null;
		if (!match[1]) return { module: bylinesRoute, params: {} };
		return {
			module: match[2] ? bylineTranslationsRoute : bylineRoute,
			params: { id: decodeURIComponent(match[1]) },
		};
	};
	const ctx: CmsProxyContext = {
		orgSlug: "acme",
		forwardedAuth: undefined,
		serviceApiKey: token,
		internalAuthToken: undefined,
		environment: "production",
		cmsDispatch: {
			fetch: async (request: Request) => {
				const url = new URL(request.url);
				const route = routeFor(url.pathname);
				if (!route) return new Response(null, { status: 404 });
				if (url.pathname !== "/_emdash/api/mcp") {
					restRequests.push(`${request.method} ${url.pathname}`);
				} else if (request.method === "POST") {
					const body = (await request.clone().json()) as {
						method?: string;
						params?: { name?: string };
					};
					if (body.method === "tools/call") toolCalls.push(body.params!.name!);
				}
				const context = {
					request,
					url,
					params: route.params,
					locals: { emdash: handlers },
					cache: { enabled: false },
					session: undefined,
				};
				const handler = route.module[request.method] as
					| ((routeContext: typeof context) => Promise<Response>)
					| undefined;
				const middleware = authMiddleware as unknown as (
					routeContext: typeof context,
					next: () => Promise<Response>,
				) => Promise<Response>;
				return middleware(context, async () =>
					handler ? handler(context) : new Response(null, { status: 405 }),
				);
			},
		} as unknown as Fetcher,
	};
	return { ctx, toolCalls, restRequests };
}

describe("byline tools keep the REST admin-scope requirement", () => {
	let runtime: Runtime | undefined;
	let testDir: string | undefined;

	beforeEach(async () => {
		clearTenantMcpEras();
		testDir = await mkdtemp(join(tmpdir(), "tedix-tenant-mcp-bylines-"));
		runtime = await createRuntime(testDir);
		await runtime!.db
			.insertInto("users")
			.values({ id: "owner", email: "owner@example.com", role: ROLE_ADMIN })
			.execute();
	});

	afterEach(async () => {
		if (runtime) {
			await runtime.stopCron();
			await runtime.db.destroy();
		}
		runtime = undefined;
		if (testDir) await rm(testDir, { recursive: true, force: true });
		testDir = undefined;
	});

	async function issueToken(scopes: string[]): Promise<string> {
		const created = await handleApiTokenCreate(runtime!.db, "owner", {
			name: `test ${scopes.join(" ")}`,
			scopes,
		});
		if (!created.success) throw new Error(created.error.message);
		return created.data.token as string;
	}

	it("refuses a content-scoped service key on every byline tool and serves an admin key", async () => {
		const admin = authenticatedTenant(runtime!, await issueToken(["admin"]));
		const content = authenticatedTenant(
			runtime!,
			await issueToken(["content:read", "content:write"]),
		);

		// The widening this guards against: the native byline tool accepts the
		// content-scoped key outright.
		const nativeList = await callTenantMcpTool(content.ctx, "byline_list", {});
		expect(nativeList.isError).toBeUndefined();

		const created = payload(
			await callCmsRest(admin.ctx, "byline_create", {
				slug: "jordan",
				displayName: "Jordan",
				isGuest: true,
			}),
		);
		const id = (created.item ?? created).id as string;
		expect(typeof id).toBe("string");

		const calls: Array<[string, Record<string, unknown>]> = [
			["byline_list", { limit: 5 }],
			["byline_get", { id }],
			["byline_translations", { id }],
			["byline_create", { slug: "sam", displayName: "Sam", isGuest: true }],
		];
		for (const [tool, args] of calls) {
			const refused = await callCmsRest(content.ctx, tool, args);
			expect(refused.isError, tool).toBe(true);
			expect(refused.content[0]?.text, tool).toContain("403");
			expect(refused.content[0]?.text, tool).toContain("INSUFFICIENT_SCOPE");

			const served = await callCmsRest(admin.ctx, tool, args);
			expect(served.isError, served.content[0]?.text).toBeUndefined();
		}

		const listed = payload(
			await callCmsRest(admin.ctx, "byline_list", { limit: 5 }),
		);
		expect(
			listed.items.map((byline: { slug: string }) => byline.slug).sort(),
		).toEqual(["jordan", "sam"]);

		// Only the deliberate native probe above rode tools/call; every byline
		// tool went through the scope-enforcing REST middleware.
		expect(content.toolCalls).toEqual(["byline_list"]);
		expect(admin.toolCalls).toEqual([]);
		expect(content.restRequests).toEqual([
			"GET /_emdash/api/admin/bylines",
			`GET /_emdash/api/admin/bylines/${id}`,
			`GET /_emdash/api/admin/bylines/${id}/translations`,
			"POST /_emdash/api/admin/bylines",
		]);
	});
});
