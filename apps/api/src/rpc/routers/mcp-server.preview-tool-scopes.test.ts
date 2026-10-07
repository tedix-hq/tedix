/**
 * `mcpServer.previewToolScopes` must report the scopes the MCP edge ENFORCES.
 *
 * Every expectation below is cross-checked against
 * `resolveMcpToolRequiredScopes` — the resolver `tools/call` gates on — so the
 * preview cannot drift back into deriving scopes from the tool name. Each case
 * is chosen so the name-derived answer DIFFERS from the enforced one; the
 * literals record what the old `toolToCapabilityScope` path used to return.
 */

import { createRouterClient } from "@orpc/server";
import {
	inferToolNamespace,
	resolveMcpToolRequiredScopes,
	resolveMcpToolNamespace,
} from "@tedix/mcp-shared/auth/tool-scopes";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

const mocks = vi.hoisted(() => ({
	getAppById: vi.fn(),
	listPreviewSourceAppsBySlugs: vi.fn(),
	listToolsForScopePreviewByAppIds: vi.fn(),
}));

vi.mock("@tedix/db/queries/app-records", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	// `getAppMetadataJson` stays REAL: the legacy JSON-string metadata path it
	// implements is part of what this endpoint has to read correctly.
	return { ...actual, getAppById: mocks.getAppById };
});

vi.mock("@tedix/db/queries/apps", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return {
		...actual,
		listPreviewSourceAppsBySlugs: mocks.listPreviewSourceAppsBySlugs,
	};
});

vi.mock("@tedix/db/queries/tools", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return {
		...actual,
		listToolsForScopePreviewByAppIds: mocks.listToolsForScopePreviewByAppIds,
	};
});

import { mcpServerContractRouter } from "./mcp-server";

const ORG_ID = "org-1";
const APP_ID = "0b90b0e2-14da-4a34-bd35-a416ab604f25";

type ToolOverrides = {
	appId?: string;
	toolId: string;
	toolTypeId?: string;
	config?: Record<string, unknown>;
	annotations?: unknown;
	writeCapability?: string | null;
	authRequired?: boolean | null;
	visibility?: string | null;
	enabled?: boolean;
};

function makeToolRow(overrides: ToolOverrides) {
	const namespace = inferToolNamespace(overrides.toolId);
	return {
		id: `tool-${overrides.toolId}`,
		appId: APP_ID,
		toolTypeId: "rpc",
		config: { endpoint: `${namespace}/test` },
		description: null,
		annotations: null,
		writeCapability: null,
		authRequired: false,
		visibility: "public",
		enabled: true,
		...overrides,
	};
}

/** The enforced answer, computed independently of the router. */
function enforcedScopes(
	tool: ToolOverrides,
	mcpConfig: Record<string, unknown> | undefined,
): string[] {
	const shape = {
		toolId: tool.toolId,
		toolTypeId: tool.toolTypeId ?? "rpc",
		config: tool.config ?? {
			endpoint: `${inferToolNamespace(tool.toolId)}/test`,
		},
		annotations: tool.annotations as never,
		writeCapability: tool.writeCapability as never,
		authRequired: tool.authRequired ?? undefined,
		visibility: tool.visibility ?? undefined,
	};
	return resolveMcpToolRequiredScopes(
		shape,
		resolveMcpToolNamespace(
			shape,
			mcpConfig?.codeModeNamespaces as Record<string, string> | undefined,
		),
		mcpConfig,
	);
}

function makeClient() {
	const context = {
		authType: "user",
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as unknown as CloudflareEnv,
		headers: new Headers(),
		organizationId: ORG_ID,
		url: new URL("https://api.tedix.test/rpc/mcp-server"),
		user: {
			aud: "test",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			sub: "user-1",
			dct: "tenant-1",
			permissions: ["apps:read"],
			roles: [],
		},
		waitUntil: () => {},
	} as unknown as BaseContext;

	return createRouterClient(mcpServerContractRouter, { context });
}

function stubApp(metadata: unknown, tools: ToolOverrides[]) {
	mocks.getAppById.mockResolvedValue({
		id: APP_ID,
		slug: "acme",
		organizationId: ORG_ID,
		metadata,
	});
	mocks.listToolsForScopePreviewByAppIds.mockResolvedValue(
		tools.map(makeToolRow),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.listPreviewSourceAppsBySlugs.mockResolvedValue([]);
});

describe("previewToolScopes reports enforced scopes", () => {
	it("uses the endpoint namespace and configured Code Mode override", async () => {
		const mcpConfig = {
			toolScopes: {},
			codeModeNamespaces: { appTools: "app_config" },
		};
		stubApp({ mcpConfig }, [
			{ toolId: "get_app", config: { endpoint: "apps/get" } },
			{
				toolId: "list_app_tools",
				config: { endpoint: "appTools/list" },
			},
			{
				toolId: "preview_tool_scopes",
				config: { endpoint: "mcpServer/previewToolScopes" },
			},
		]);

		const result = await makeClient().previewToolScopes({ appId: APP_ID });

		expect(result.toolScopes).toEqual({
			get_app: ["mcp:apps.read"],
			list_app_tools: ["mcp:apps.read"],
			preview_tool_scopes: ["mcp:apps.read"],
		});
	});

	it("reports [] for a tool the edge lets through, and buckets it under (none)", async () => {
		// `app_create` sits in the `app` namespace, which HAS a fallback scope, so
		// with no toolScopes config and no dangerous/private signal the edge
		// requires nothing. The old name-derived preview claimed "mcp:apps.read".
		const tool: ToolOverrides = { toolId: "app_create" };
		stubApp(null, [tool]);
		expect(enforcedScopes(tool, undefined)).toEqual([]);

		const result = await makeClient().previewToolScopes({ appId: APP_ID });

		expect(result.toolScopes).toEqual({ app_create: [] });
		expect(result.granularToolScopes).toEqual({ app_create: [] });
		expect(result.grouped).toEqual({ "(none)": ["app_create"] });
		expect(result.granularGrouped).toEqual({ "(none)": ["app_create"] });
		expect(result.scopeSummary).toEqual({ "(none)": 1 });
		expect(result.granularScopeSummary).toEqual({ "(none)": 1 });
	});

	it("uses the domain admin scope for a DECLARED-destructive tool", async () => {
		// `sync_ledger` reads as ordinary content work by name (the old preview
		// said "mcp:content.write") and carries no annotations at all — only the
		// declared `writeCapability` marks it destructive, and the edge promotes
		// it to platform admin on that alone.
		const tool: ToolOverrides = {
			toolId: "sync_ledger",
			writeCapability: "destructive",
		};
		stubApp(null, [tool]);
		expect(enforcedScopes(tool, undefined)).toEqual(["mcp:content.admin"]);

		const result = await makeClient().previewToolScopes({ appId: APP_ID });

		expect(result.toolScopes).toEqual({ sync_ledger: ["mcp:content.admin"] });
		// `platform:admin` is separate platform authority and has no read/write/admin tiers, so the
		// granular view must pass it through rather than invent "platform:admin.write".
		expect(result.granularToolScopes).toEqual({
			sync_ledger: ["mcp:content.admin"],
		});
		expect(result.grouped).toEqual({ "mcp:content.admin": ["sync_ledger"] });
	});

	it("honours a per-app toolScopes override", async () => {
		// The whole point of the override: the operator pinned this tool to
		// mcp:content, while its name resolves to the unclassified-tool failure.
		const mcpConfig = { toolScopes: { list_invoices: ["mcp:content.write"] } };
		const tool: ToolOverrides = { toolId: "list_invoices" };
		stubApp({ mcpConfig }, [tool]);
		expect(enforcedScopes(tool, mcpConfig)).toEqual(["mcp:content.write"]);

		const result = await makeClient().previewToolScopes({ appId: APP_ID });

		expect(result.toolScopes).toEqual({
			list_invoices: ["mcp:content.write"],
		});
		expect(result.granularToolScopes).toEqual({
			list_invoices: ["mcp:content.write"],
		});
		expect(result.grouped).toEqual({
			"mcp:content.write": ["list_invoices"],
		});
	});

	it("reports per-tool policy scopes for an enforcePolicies app", async () => {
		const mcpConfig = { enforcePolicies: true };
		const tool: ToolOverrides = { toolId: "list_invoices" };
		stubApp({ mcpConfig }, [tool]);
		expect(enforcedScopes(tool, mcpConfig)).toEqual(["mcp:list.invoices"]);

		const result = await makeClient().previewToolScopes({ appId: APP_ID });

		expect(result.toolScopes).toEqual({
			list_invoices: ["mcp:list.invoices"],
		});
		// Not a broad capability scope, so there is no tier to append.
		expect(result.granularToolScopes).toEqual({
			list_invoices: ["mcp:list.invoices"],
		});
	});

	it("reads mcpConfig off metadata stored as a legacy JSON string", async () => {
		// A raw column read yields `undefined` mcpConfig for these rows, which
		// would silently downgrade the answer to the no-config one (`[]` here).
		const mcpConfig = { enforcePolicies: true };
		stubApp(JSON.stringify({ mcpConfig }), [{ toolId: "app_create" }]);

		const result = await makeClient().previewToolScopes({ appId: APP_ID });

		expect(result.toolScopes).toEqual({ app_create: ["mcp:app.create"] });
	});

	it("splits a wildcard-public app between unenforced and destructive tools", async () => {
		// `toolScopes: {"*": []}` makes every SAFE tool public, but the resolver
		// refuses to apply an empty configured scope list to a destructive tool
		// and falls through to platform:admin. One config, two answers — a per-name
		// derivation cannot express this at all.
		const mcpConfig = { toolScopes: { "*": [] } };
		const safe: ToolOverrides = { toolId: "app_create" };
		const destructive: ToolOverrides = {
			toolId: "sync_ledger",
			annotations: { destructiveHint: true },
		};
		stubApp({ mcpConfig }, [safe, destructive]);
		expect(enforcedScopes(safe, mcpConfig)).toEqual([]);
		expect(enforcedScopes(destructive, mcpConfig)).toEqual([
			"mcp:content.admin",
		]);

		const result = await makeClient().previewToolScopes({ appId: APP_ID });

		expect(result.toolScopes).toEqual({
			app_create: [],
			sync_ledger: ["mcp:content.admin"],
		});
		expect(result.grouped).toEqual({
			"(none)": ["app_create"],
			"mcp:content.admin": ["sync_ledger"],
		});
		expect(result.toolCount).toBe(2);
		expect(result.complete).toBe(true);
	});
});

describe("aggregate scope preview", () => {
	it("omits tools the MCP edge hides for missing capability mappings", async () => {
		stubApp(
			{
				mcpConfig: {
					toolScopes: {},
					aggregateApps: [{ slug: "cms", prefix: "cms_site" }],
				},
			},
			[],
		);
		mocks.listPreviewSourceAppsBySlugs.mockResolvedValue([
			{
				id: "cms-id",
				slug: "cms",
				organizationId: ORG_ID,
				sourceOrgSlug: "acme",
				sourceOrgTenantId: "tenant-1",
				metadata: null,
			},
		]);
		mocks.listToolsForScopePreviewByAppIds.mockResolvedValue([
			makeToolRow({
				appId: "cms-id",
				toolId: "activate_media_usage",
				toolTypeId: "mcp",
				config: {},
				writeCapability: "destructive",
			}),
			makeToolRow({
				appId: "cms-id",
				toolId: "content_get",
				toolTypeId: "mcp",
				config: {},
				writeCapability: "read",
			}),
		]);

		const result = await makeClient().previewToolScopes({ appId: APP_ID });

		expect(result.complete).toBe(true);
		expect(result.toolCount).toBe(1);
		expect(Object.keys(result.toolScopes)).toEqual(["cms_site__content_get"]);
		expect(result.unmappedTools).toEqual(["cms_site__activate_media_usage"]);
	});

	it("loads nested sources in breadth-first waves and inherits the outer prefix", async () => {
		stubApp(
			{
				mcpConfig: {
					toolScopes: { "*": ["mcp:apps.read"] },
					aggregateApps: [{ slug: "parent", prefix: "bundle" }],
				},
			},
			[],
		);
		const sources = [
			{
				id: "parent-id",
				slug: "parent",
				organizationId: ORG_ID,
				sourceOrgSlug: "acme",
				sourceOrgTenantId: "tenant-1",
				metadata: { mcpConfig: { aggregateApps: [{ slug: "child" }] } },
			},
			{
				id: "child-id",
				slug: "child",
				organizationId: ORG_ID,
				sourceOrgSlug: "acme",
				sourceOrgTenantId: "tenant-1",
				metadata: null,
			},
		];
		mocks.listPreviewSourceAppsBySlugs.mockImplementation(
			async (_db: unknown, slugs: string[]) =>
				sources.filter((source) => slugs.includes(source.slug)),
		);
		mocks.listToolsForScopePreviewByAppIds.mockResolvedValue([
			makeToolRow({ appId: "child-id", toolId: "get_status" }),
		]);

		const result = await makeClient().previewToolScopes({ appId: APP_ID });

		expect(result.complete).toBe(true);
		expect(Object.keys(result.toolScopes)).toEqual(["bundle__get_status"]);
		expect(mocks.listPreviewSourceAppsBySlugs).toHaveBeenCalledTimes(2);
	});

	it("hydrates a forty-source aggregate in one app wave and one tool projection", async () => {
		const sources = Array.from({ length: 40 }, (_, index) => ({
			id: `source-${index}`,
			slug: `source-${index}`,
			organizationId: ORG_ID,
			sourceOrgSlug: "acme",
			sourceOrgTenantId: "tenant-1",
			metadata: null,
		}));
		stubApp(
			{
				mcpConfig: {
					toolScopes: { "*": ["mcp:apps.read"] },
					aggregateApps: sources.map(({ slug }) => ({ slug })),
				},
			},
			[],
		);
		mocks.listPreviewSourceAppsBySlugs.mockImplementation(
			async (_db: unknown, slugs: string[]) =>
				sources.filter((source) => slugs.includes(source.slug)),
		);
		mocks.listToolsForScopePreviewByAppIds.mockResolvedValue(
			sources.map((source) =>
				makeToolRow({ appId: source.id, toolId: "list_items" }),
			),
		);

		const result = await makeClient().previewToolScopes({ appId: APP_ID });

		expect(result.complete).toBe(true);
		expect(result.toolCount).toBe(40);
		expect(result.sources).toHaveLength(40);
		expect(result.skippedSources).toEqual([]);
		expect(mocks.listPreviewSourceAppsBySlugs).toHaveBeenCalledTimes(1);
		expect(mocks.listToolsForScopePreviewByAppIds).toHaveBeenCalledTimes(1);
	});

	it("prefers the tenant's own slug and skips foreign, missing, and cyclic sources", async () => {
		stubApp(
			{
				mcpConfig: {
					toolScopes: { "*": ["mcp:apps.read"] },
					aggregateApps: [
						{ slug: "shared", prefix: "mine" },
						{ slug: "cloud" },
						{ slug: "evil" },
						{ slug: "missing" },
					],
				},
			},
			[],
		);
		const sources = [
			{
				id: "foreign-shared",
				slug: "shared",
				organizationId: "foreign-org",
				sourceOrgSlug: "other",
				sourceOrgTenantId: "other-tenant",
				metadata: null,
			},
			{
				id: "own-shared",
				slug: "shared",
				organizationId: ORG_ID,
				sourceOrgSlug: "acme",
				sourceOrgTenantId: "tenant-1",
				metadata: { mcpConfig: { aggregateApps: [{ slug: "acme" }] } },
			},
			{
				id: "cloud-app",
				slug: "cloud",
				organizationId: "tedix-org",
				sourceOrgSlug: "tedix",
				sourceOrgTenantId: "org_tedix",
				metadata: null,
			},
			{
				id: "foreign-evil",
				slug: "evil",
				organizationId: "foreign-org",
				sourceOrgSlug: "other",
				sourceOrgTenantId: "other-tenant",
				metadata: null,
			},
		];
		mocks.listPreviewSourceAppsBySlugs.mockImplementation(
			async (_db: unknown, slugs: string[]) =>
				sources.filter((source) => slugs.includes(source.slug)),
		);
		mocks.listToolsForScopePreviewByAppIds.mockResolvedValue([
			makeToolRow({ appId: "own-shared", toolId: "list_items" }),
			makeToolRow({ appId: "cloud-app", toolId: "get_status" }),
		]);

		const result = await makeClient().previewToolScopes({ appId: APP_ID });

		expect(Object.keys(result.toolScopes)).toEqual([
			"cloud__get_status",
			"mine__list_items",
		]);
		expect(result.sources.map((source) => source.appId)).toEqual([
			"own-shared",
			"cloud-app",
		]);
		expect(result.skippedSources).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ slug: "acme", reason: "cycle detected" }),
				expect.objectContaining({
					slug: "evil",
					reason: "aggregate app is outside the allowed preview boundary",
				}),
				expect.objectContaining({
					slug: "missing",
					reason: "aggregate app not found",
				}),
			]),
		);
		expect(result.complete).toBe(false);
	});
});
