/**
 * oRPC MCP Server Router
 * Manages Descope Agentic Identity Hub MCP Server registration and scope sync.
 *
 * Source of truth split:
 * - Descope = MCP auth server identity / discovery
 * - D1 mcpConfig = sync strategy, scope config, and Tedix platform policy
 * - This router = bridge + status reporting only
 */

import { implement } from "@orpc/server";
import { mcpServerContract } from "@tedix/api-contract/contracts/mcp-server";
import {
	MCP_CAPABILITY_SCOPES,
	toolToAccessLevel,
	type ToolScopeHints,
} from "@tedix/api-contract/schemas/mcp-capability-scopes";
import {
	buildTedixMcpAuthorizationAudiences,
	buildTedixMcpResourceUri,
	reconcileTedixMcpOwnershipTags,
} from "@tedix/auth/aih-audiences";
import {
	hardenDescopeMcpServerRegistration,
	loadDescopeMcpServer,
	type McpServerScope,
	registerDescopeMcpResource,
	updateDescopeMcpServer,
} from "@tedix/auth/aih-client";
import {
	buildDescopeMcpDiscoveryUrl,
	getDescopeBaseUrl,
	resolveDescopeMcpScopeSyncConfig,
} from "@tedix/auth/descope-mcp";
import { collectDescopeResourceScopes } from "@tedix/auth/scope-sync";
import type { DbClient } from "@tedix/db/client";
import {
	getAppById,
	getAppMetadataJson,
	updateApp,
} from "@tedix/db/queries/app-records";
import {
	listPreviewSourceAppsByIds,
	listPreviewSourceAppsBySlugs,
	type PreviewSourceAppRow,
} from "@tedix/db/queries/apps";
import {
	isMcpToolVisibleToCaller,
	resolveMcpToolRequiredScopes,
	resolveMcpToolNamespace,
} from "@tedix/mcp-shared/auth/tool-scopes";
import {
	getToolsByAppId,
	listToolsForScopePreviewByAppIds,
	type ToolScopePreviewResult,
} from "@tedix/db/queries/tools";
import type { App, McpConfig } from "@tedix/db/schema/apps";
import { normalizeAppMetadata } from "./app-metadata";
import { requireOrgId } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";

const mcpServerOs = implement(mcpServerContract).$context<BaseContext>();
const authedMcpServerOs = mcpServerOs.use(withAuth);

async function requireAppForOrg(db: DbClient, orgId: string, appId: string) {
	const app = await getAppById(db, appId);
	if (!app || app.organizationId !== orgId) {
		throw createError(ErrorCodes.NOT_FOUND, "App not found");
	}
	return app;
}

async function extractScopes(
	db: DbClient,
	appId: string,
	mcpConfig: McpConfig | null | undefined,
): Promise<Array<{ name: string; description: string }>> {
	const tools = await getToolsByAppId(db, appId);
	return collectDescopeResourceScopes({
		mcpConfig,
		tools: tools.map((tool) => ({
			name: tool.toolId,
			description: tool.description ?? undefined,
		})),
	});
}

type AggregateEntry = {
	slug: string;
	/** Stable app id; preferred over slug when present. */
	appId?: string;
	prefix?: string;
	connectionLabel?: string;
};

type PreviewTool = {
	toolId: string;
	toolTypeId?: string | null;
	config?: Record<string, unknown> | null;
	annotations?: ToolScopeHints | null;
	// The rest of the auth shape the scope resolver reads. Without these a
	// destructive, private, or auth-required tool previews at its (much weaker)
	// namespace fallback instead of the scope the edge enforces.
	writeCapability?: string | null;
	authRequired?: boolean | null;
	visibility?: string | null;
	sourceSlug: string;
	sourceAppId: string;
	prefix: string | null;
};

type PreviewSource = {
	slug: string;
	appId: string;
	prefix: string | null;
	toolCount: number;
};

type SkippedPreviewSource = {
	slug: string;
	reason: string;
	upstreamMcpUrl?: string | null;
};

type PreviewApp = Pick<App, "id" | "slug" | "organizationId" | "metadata">;

type PreviewGraph = {
	/** Keyed by {@link previewRef}: `id:<appId>` or a lowercased slug. */
	appsByRef: Map<string, PreviewApp>;
	unavailable: Map<string, string>;
	toolsByAppId: Map<string, ToolScopePreviewResult[]>;
};

function previewSlug(slug: string): string {
	return slug.toLowerCase();
}

function previewSourceAllowed(
	rootOrganizationId: string,
	source: PreviewSourceAppRow,
): boolean {
	// The root tenant may reference its own apps or Tedix Cloud's shared apps.
	return (
		source.organizationId === rootOrganizationId ||
		source.sourceOrgSlug === "tedix" ||
		source.sourceOrgTenantId === "org_tedix"
	);
}

function getAggregateApps(
	mcpConfig: McpConfig | null | undefined,
): AggregateEntry[] {
	const entries = mcpConfig?.aggregateApps;
	if (!Array.isArray(entries)) return [];
	return entries.filter(
		(entry): entry is AggregateEntry =>
			!!entry &&
			typeof entry === "object" &&
			typeof (entry as AggregateEntry).slug === "string" &&
			(entry as AggregateEntry).slug.length > 0,
	);
}

function prefixToolId(prefix: string, toolId: string): string {
	return `${prefix}__${toolId}`;
}

/**
 * Graph key for one aggregate entry. An entry with a stable `appId` is linked
 * by id; only entries written before ids were stored fall back to the slug.
 */
function previewRef(entry: Pick<AggregateEntry, "slug" | "appId">): string {
	return typeof entry.appId === "string" && entry.appId
		? `id:${entry.appId}`
		: previewSlug(entry.slug);
}

/** Hydrate each aggregate depth in bulk; recurse only after ownership checks. */
async function loadPreviewGraph(
	db: DbClient,
	root: App,
): Promise<PreviewGraph> {
	const appsByRef = new Map<string, PreviewApp>([
		[previewSlug(root.slug), root],
		[`id:${root.id}`, root],
	]);
	const unavailable = new Map<string, string>();
	const pending = new Set(
		getAggregateApps(getAppMetadataJson(root)?.mcpConfig).map(previewRef),
	);

	while (pending.size > 0) {
		const refs = [...pending].filter(
			(ref) => !appsByRef.has(ref) && !unavailable.has(ref),
		);
		pending.clear();
		if (refs.length === 0) break;
		const slugs = refs.filter((ref) => !ref.startsWith("id:"));
		const ids = refs
			.filter((ref) => ref.startsWith("id:"))
			.map((ref) => ref.slice(3));
		const candidatesByRef = new Map<string, PreviewSourceAppRow[]>();
		const addCandidate = (ref: string, row: PreviewSourceAppRow) => {
			const candidates = candidatesByRef.get(ref) ?? [];
			candidates.push(row);
			candidatesByRef.set(ref, candidates);
		};
		if (slugs.length > 0) {
			for (const row of await listPreviewSourceAppsBySlugs(db, slugs)) {
				addCandidate(previewSlug(row.slug), row);
			}
		}
		if (ids.length > 0) {
			for (const row of await listPreviewSourceAppsByIds(db, ids)) {
				addCandidate(`id:${row.id}`, row);
			}
		}
		for (const ref of refs) {
			const candidates = candidatesByRef.get(ref) ?? [];
			// Slugs can repeat across organizations. Prefer the caller's own app;
			// never select an unrelated tenant merely because its row came first.
			// An id names exactly one row, which must pass the same boundary.
			const source =
				candidates.find((row) => row.organizationId === root.organizationId) ??
				candidates.find((row) =>
					previewSourceAllowed(root.organizationId, row),
				);
			if (!source) {
				unavailable.set(
					ref,
					candidates.length > 0
						? "aggregate app is outside the allowed preview boundary"
						: "aggregate app not found",
				);
				continue;
			}
			appsByRef.set(ref, source);
			for (const entry of getAggregateApps(
				getAppMetadataJson(source)?.mcpConfig,
			)) {
				pending.add(previewRef(entry));
			}
		}
	}

	const toolsByAppId = new Map<string, ToolScopePreviewResult[]>();
	for (const tool of await listToolsForScopePreviewByAppIds(db, [
		...new Set([...appsByRef.values()].map((app) => app.id)),
	])) {
		const tools = toolsByAppId.get(tool.appId) ?? [];
		tools.push(tool);
		toolsByAppId.set(tool.appId, tools);
	}
	return { appsByRef, unavailable, toolsByAppId };
}

function collectPreviewToolsForApp(
	app: PreviewApp,
	graph: PreviewGraph,
	options?: {
		prefix?: string | null;
		visited?: Set<string>;
	},
): {
	tools: PreviewTool[];
	sources: PreviewSource[];
	skippedSources: SkippedPreviewSource[];
} {
	const metadata = getAppMetadataJson(app);
	const mcpConfig = metadata?.mcpConfig;
	const prefix = options?.prefix ?? null;
	const visited = options?.visited ?? new Set<string>();

	if (visited.has(app.slug)) {
		return {
			tools: [],
			sources: [],
			skippedSources: [{ slug: app.slug, reason: "cycle detected" }],
		};
	}
	visited.add(app.slug);

	const dbTools = (graph.toolsByAppId.get(app.id) ?? []).filter(
		(tool) => tool.enabled !== false,
	);
	const ownTools = dbTools.map((tool): PreviewTool => ({
		toolId: prefix ? prefixToolId(prefix, tool.toolId) : tool.toolId,
		toolTypeId: tool.toolTypeId,
		config: prefix
			? { ...tool.config, _aggregateNamespace: prefix }
			: tool.config,
		annotations: tool.annotations as ToolScopeHints | null,
		writeCapability: tool.writeCapability,
		authRequired: tool.authRequired,
		visibility: tool.visibility,
		sourceSlug: app.slug,
		sourceAppId: app.id,
		prefix,
	}));

	const sources: PreviewSource[] =
		ownTools.length > 0
			? [{ slug: app.slug, appId: app.id, prefix, toolCount: ownTools.length }]
			: [];
	const skippedSources: SkippedPreviewSource[] = [];
	const tools = [...ownTools];

	const upstreamMcpUrl =
		typeof mcpConfig?.upstreamMcpUrl === "string"
			? mcpConfig.upstreamMcpUrl
			: null;
	if (upstreamMcpUrl) {
		skippedSources.push({
			slug: app.slug,
			reason:
				"stale upstreamMcpUrl ignored; materialize upstream tools into D1 app_tools before scope preview",
			upstreamMcpUrl,
		});
	}

	for (const entry of getAggregateApps(mcpConfig)) {
		const sourceApp = graph.appsByRef.get(previewRef(entry));
		if (!sourceApp) {
			skippedSources.push({
				slug: entry.slug,
				reason:
					graph.unavailable.get(previewRef(entry)) ?? "aggregate app not found",
			});
			continue;
		}
		const entryPrefix = prefix ?? entry.prefix ?? entry.slug;
		const nested = collectPreviewToolsForApp(sourceApp, graph, {
			prefix: entryPrefix,
			visited: new Set(visited),
		});
		tools.push(...nested.tools);
		sources.push(...nested.sources);
		skippedSources.push(...nested.skippedSources);
	}

	return { tools, sources, skippedSources };
}

function buildUpdatedMcpConfig(params: {
	mcpConfig: McpConfig | null | undefined;
	changes: Partial<McpConfig>;
	scopeSyncChanges?: Record<string, unknown>;
}): McpConfig {
	const { mcpConfig, changes, scopeSyncChanges } = params;
	return {
		...mcpConfig,
		...changes,
		scopeSync: {
			...(mcpConfig?.scopeSync as Record<string, unknown> | undefined),
			...scopeSyncChanges,
		},
	};
}

function toDescopeConnectionScopes(
	scopes: Array<{ name: string; description: string }>,
): McpServerScope[] {
	return scopes.map((scope) => ({
		name: scope.name,
		description: scope.description,
		optional: true,
	}));
}

async function persistMcpConfig(
	db: DbClient,
	appId: string,
	metadata: Record<string, unknown> | null | undefined,
	mcpConfig: McpConfig,
) {
	await updateApp(db, appId, {
		metadata: {
			...metadata,
			mcpConfig,
		},
	});
}

export const registerProcedure = authedMcpServerOs.register
	.use(AUTHZ.appsWrite)
	.handler(async ({ input, context }) => {
		const { db, env } = context;
		const { appId } = input;

		const orgId = requireOrgId(context);
		const app = await requireAppForOrg(db, orgId, appId);
		const metadata = getAppMetadataJson(app);
		const mcpConfig = metadata?.mcpConfig;
		const baseUrl = getDescopeBaseUrl(env);
		const projectId = env.DESCOPE_PROJECT_ID;
		if (!projectId) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Descope configuration missing (DESCOPE_PROJECT_ID)",
			);
		}

		const scopes = await extractScopes(db, appId, mcpConfig);
		if (mcpConfig?.descopeResourceId) {
			const existing = await loadDescopeMcpServer(
				env,
				mcpConfig.descopeResourceId as string,
			);
			await updateDescopeMcpServer(
				env,
				hardenDescopeMcpServerRegistration(
					{
						...existing,
						audienceWhitelist: buildTedixMcpAuthorizationAudiences(app.slug),
						tags: reconcileTedixMcpOwnershipTags(existing.tags, {
							app: app.slug,
						}),
						approvedScopes: {
							...existing.approvedScopes,
							connectionsScopes: toDescopeConnectionScopes(scopes),
						},
					},
					env,
				),
			);
			return {
				descopeResourceId: mcpConfig.descopeResourceId as string,
				discoveryUrl: buildDescopeMcpDiscoveryUrl({
					baseUrl,
					projectId,
					resourceId: mcpConfig.descopeResourceId as string,
				}),
				status: "already_exists" as const,
			};
		}

		let descopeResourceId: string | null = null;
		try {
			const server = await registerDescopeMcpResource(env, {
				name: mcpConfig?.serverName ?? `${app.name} MCP`,
				description: app.description ?? `MCP Server for ${app.name}`,
				audienceWhitelist: [buildTedixMcpResourceUri(app.slug)],
				approvedScopes: {
					connectionsScopes: toDescopeConnectionScopes(scopes),
				},
				tags: reconcileTedixMcpOwnershipTags([], { app: app.slug }),
			});
			descopeResourceId = server.id;
		} catch (error) {
			console.error("[MCP Server] Descope registration failed:", error);
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				error instanceof Error
					? error.message
					: "Descope MCP Server registration failed",
			);
		}

		if (!descopeResourceId) {
			console.error(
				"[MCP Server] Descope response missing server ID:",
				JSON.stringify({ descopeResourceId }),
			);
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Descope response missing MCP Server ID",
			);
		}

		await persistMcpConfig(
			db,
			appId,
			metadata,
			buildUpdatedMcpConfig({
				mcpConfig,
				changes: { descopeResourceId },
				scopeSyncChanges: { lastError: null },
			}),
		);

		const discoveryUrl = buildDescopeMcpDiscoveryUrl({
			baseUrl,
			projectId,
			resourceId: descopeResourceId,
		});

		const { emitAuditEvent } = await import("../audit-helpers");
		await emitAuditEvent(db, {
			organizationId: orgId,
			actorId:
				(context as BaseContext & { user?: { sub?: string } }).user?.sub ??
				"unknown",
			actorType: "user",
			action: "mcp_server.registered",
			resourceType: "app",
			resourceId: appId,
			metadata: { descopeResourceId },
		});

		return {
			descopeResourceId,
			discoveryUrl,
			status: "created" as const,
		};
	});

export const adoptResourceProcedure = authedMcpServerOs.adoptResource
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		const { db, env } = context;
		const orgId = requireOrgId(context);
		const app = await requireAppForOrg(db, orgId, input.appId);
		const metadata = getAppMetadataJson(app);
		const mcpConfig = metadata?.mcpConfig;
		const resource = await loadDescopeMcpServer(env, input.descopeResourceId);
		const expectedAudience = buildTedixMcpResourceUri(app.slug);
		if (
			resource.audienceWhitelist?.length !== 1 ||
			resource.audienceWhitelist[0] !== expectedAudience
		) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Descope Resource must expose exactly ${expectedAudience}`,
			);
		}

		const scopes = await extractScopes(db, app.id, mcpConfig);
		await updateDescopeMcpServer(env, {
			...resource,
			tags: reconcileTedixMcpOwnershipTags(resource.tags, { app: app.slug }),
			approvedScopes: {
				...resource.approvedScopes,
				connectionsScopes: toDescopeConnectionScopes(scopes),
			},
		});

		const previousDescopeResourceId =
			typeof mcpConfig?.descopeResourceId === "string"
				? mcpConfig.descopeResourceId
				: null;
		await persistMcpConfig(
			db,
			app.id,
			metadata,
			buildUpdatedMcpConfig({
				mcpConfig,
				changes: { descopeResourceId: input.descopeResourceId },
				scopeSyncChanges: { lastError: null },
			}),
		);

		const { emitAuditEvent } = await import("../audit-helpers");
		await emitAuditEvent(db, {
			organizationId: orgId,
			actorId:
				(context as BaseContext & { user?: { sub?: string } }).user?.sub ??
				"unknown",
			actorType: "user",
			action: "mcp_server.resource_adopted",
			resourceType: "app",
			resourceId: app.id,
			metadata: {
				previousDescopeResourceId,
				descopeResourceId: input.descopeResourceId,
			},
		});

		return {
			descopeResourceId: input.descopeResourceId,
			previousDescopeResourceId,
			discoveryUrl: buildDescopeMcpDiscoveryUrl({
				baseUrl: getDescopeBaseUrl(env),
				projectId: env.DESCOPE_PROJECT_ID!,
				resourceId: input.descopeResourceId,
			}),
		};
	});

export const syncScopesProcedure = authedMcpServerOs.syncScopes
	.use(AUTHZ.appsWrite)
	.handler(async ({ input, context }) => {
		const { db, env } = context;
		const { appId } = input;

		const orgId = requireOrgId(context);
		const app = await requireAppForOrg(db, orgId, appId);
		const metadata = getAppMetadataJson(app);
		const mcpConfig = metadata?.mcpConfig;
		const scopes = await extractScopes(db, appId, mcpConfig);
		const syncConfig = resolveDescopeMcpScopeSyncConfig(mcpConfig);
		const syncedAt = new Date().toISOString();

		if (
			!mcpConfig?.descopeResourceId &&
			syncConfig.strategy === "descope-api"
		) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"MCP Server not registered in Descope. Call register first.",
			);
		}

		if (syncConfig.strategy === "resource-metadata") {
			await persistMcpConfig(
				db,
				appId,
				metadata,
				buildUpdatedMcpConfig({
					mcpConfig,
					changes: { lastScopesSyncedAt: syncedAt },
					scopeSyncChanges: {
						lastSyncedAt: syncedAt,
						lastError: null,
					},
				}),
			);

			console.log(
				`[MCP Server] Refreshed ${scopes.length} scopes from protected resource metadata: app=${app.slug}`,
			);

			return {
				synced: true,
				scopeCount: scopes.length,
				strategy: syncConfig.strategy,
				message:
					"Scopes are served from OAuth protected resource metadata; no Descope management API sync was needed.",
			};
		}

		try {
			const server = await loadDescopeMcpServer(
				env,
				mcpConfig!.descopeResourceId as string,
			);
			await updateDescopeMcpServer(
				env,
				hardenDescopeMcpServerRegistration(
					{
						...server,
						audienceWhitelist: buildTedixMcpAuthorizationAudiences(app.slug),
						tags: reconcileTedixMcpOwnershipTags(server.tags, {
							app: app.slug,
						}),
						approvedScopes: {
							...server.approvedScopes,
							connectionsScopes: toDescopeConnectionScopes(scopes),
						},
					},
					env,
				),
			);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Descope scope sync failed";
			console.error("[MCP Server] Descope scope sync failed:", error);
			await persistMcpConfig(
				db,
				appId,
				metadata,
				buildUpdatedMcpConfig({
					mcpConfig,
					changes: {},
					scopeSyncChanges: {
						lastError: message,
					},
				}),
			);
			throw createError(ErrorCodes.INTERNAL_SERVER_ERROR, message);
		}

		await persistMcpConfig(
			db,
			appId,
			metadata,
			buildUpdatedMcpConfig({
				mcpConfig,
				changes: { lastScopesSyncedAt: syncedAt },
				scopeSyncChanges: {
					lastSyncedAt: syncedAt,
					lastError: null,
				},
			}),
		);

		console.log(
			`[MCP Server] Synced ${scopes.length} scopes to Descope: app=${app.slug}`,
		);

		return {
			synced: true,
			scopeCount: scopes.length,
			strategy: syncConfig.strategy,
			message: "Scopes were synced to Descope management API.",
		};
	});

export const getStatusProcedure = authedMcpServerOs.getStatus
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { appId } = input;

		const orgId = requireOrgId(context);
		const app = await requireAppForOrg(db, orgId, appId);
		const metadata = getAppMetadataJson(app);
		const mcpConfig = metadata?.mcpConfig;
		const syncConfig = resolveDescopeMcpScopeSyncConfig(mcpConfig);
		const descopeResourceId = (mcpConfig?.descopeResourceId as string) ?? null;
		const lastSyncedAt =
			syncConfig.lastSyncedAt ??
			(mcpConfig?.lastScopesSyncedAt as string) ??
			null;

		return {
			registered: !!descopeResourceId,
			descopeResourceId,
			scopesSynced: !!lastSyncedAt,
			lastSyncedAt: lastSyncedAt,
			scopeSyncStrategy: syncConfig.strategy,
			lastSyncError: syncConfig.lastError,
		};
	});

/**
 * Bucket key for tools the edge lets through with NO scope at all. Those tools
 * belong in the grouped view — "your app enforces nothing on these 40 tools" is
 * the single most useful thing this preview can tell an operator — but they
 * have no scope to group under, and inventing one would make the preview
 * disagree with enforcement again. `(none)` cannot collide with a real scope:
 * every scope this resolver can return is `mcp:`-prefixed or an operator's own
 * configured string, and a bare parenthesised word is neither.
 */
const UNENFORCED_SCOPE_KEY = "(none)";

/**
 * The scopes the MCP edge ACTUALLY requires for a tool, from the same resolver
 * `tools/call` gates on. Previously this endpoint ran the tool NAME through
 * `toolToCapabilityScope`, which is only the resolver's last fallback: it
 * silently ignored per-app `toolScopes` overrides, `enforcePolicies` mode,
 * dangerous-tool promotion to `platform:admin`, and the namespace fallbacks, so the
 * preview an operator copied into D1 described a policy model nothing enforced.
 *
 * No options object is passed, matching both edge call sites: `tools/list`
 * passes none and `tools/call` passes `fallbackOnAuthenticatedAuthMode: false`,
 * and the flag is tested with `=== true`, so the two resolve identically.
 * The namespace itself comes from the same persisted-metadata resolver as Code
 * Mode/native dispatch; using `inferToolNamespace(toolId)` here classified
 * `get_*` and `list_*` by verb and made a single unmapped row abort the report.
 */
function resolveEnforcedScopes(
	tool: PreviewTool,
	mcpConfig: Record<string, unknown> | undefined,
): string[] {
	const namespaceOverrides = mcpConfig?.codeModeNamespaces as
		| Record<string, string>
		| undefined;
	return resolveMcpToolRequiredScopes(
		{
			toolId: tool.toolId,
			toolTypeId: tool.toolTypeId,
			config: tool.config,
			annotations: tool.annotations as never,
			writeCapability: tool.writeCapability as never,
			authRequired: tool.authRequired ?? undefined,
			visibility: tool.visibility ?? undefined,
		},
		resolveMcpToolNamespace(tool, namespaceOverrides),
		mcpConfig,
	);
}

function isScopePreviewToolVisible(
	tool: PreviewTool,
	mcpConfig: Record<string, unknown> | undefined,
): boolean {
	const namespaceOverrides = mcpConfig?.codeModeNamespaces as
		| Record<string, string>
		| undefined;
	return isMcpToolVisibleToCaller(
		{
			toolId: tool.toolId,
			toolTypeId: tool.toolTypeId,
			config: tool.config,
			annotations: tool.annotations as never,
			writeCapability: tool.writeCapability as never,
			authRequired: tool.authRequired ?? undefined,
			visibility: tool.visibility ?? undefined,
		},
		resolveMcpToolNamespace(tool, namespaceOverrides),
		mcpConfig,
		{ authType: "service" },
	);
}

/**
 * The granular (`.read`/`.write`/`.admin`) refinement of an ENFORCED scope,
 * offered as the stricter policy an operator could move to.
 *
 * Only capability-family scopes are refined for preview. `platform:admin` is separate
 * platform authority, and an operator's configured exact scope is not ours to
 * decorate — appending a tier there would advertise a scope that exists nowhere
 * in Descope.
 */
function toGranularScope(scope: string, tool: PreviewTool): string {
	if (scope === "platform:admin") return scope;
	if (!Object.hasOwn(MCP_CAPABILITY_SCOPES, scope)) return scope;
	return `${scope}.${toolToAccessLevel(tool.toolId, tool.annotations)}`;
}

function groupToolByScopes(
	groups: Record<string, string[]>,
	toolId: string,
	scopes: string[],
): void {
	for (const scope of scopes.length > 0 ? scopes : [UNENFORCED_SCOPE_KEY]) {
		(groups[scope] ??= []).push(toolId);
	}
}

function readMcpConfig(app: App): Record<string, unknown> | undefined {
	// Read metadata the way the edge does. `getAppMetadataJson` parses rows whose
	// metadata was stored as a JSON string; a raw column read yields `undefined`
	// mcpConfig for exactly those legacy rows, which would silently downgrade
	// their preview to the no-config answer.
	const metadata = normalizeAppMetadata(getAppMetadataJson(app));
	return (metadata?.mcpConfig ?? undefined) as
		| Record<string, unknown>
		| undefined;
}

export const previewToolScopesProcedure = authedMcpServerOs.previewToolScopes
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { appId } = input;

		const orgId = requireOrgId(context);
		const app = await requireAppForOrg(db, orgId, appId);

		const preview = collectPreviewToolsForApp(
			app,
			await loadPreviewGraph(db, app),
		);
		const toolsById = new Map<string, PreviewTool>();
		for (const tool of preview.tools) {
			toolsById.set(tool.toolId, tool);
		}

		// The mcpConfig of the app being SERVED governs every tool it exposes,
		// aggregated sources included — that is the config the edge resolves
		// against, so the preview must resolve against the same one.
		const mcpConfig = readMcpConfig(app);
		// Omit tools the edge hides for missing capability mappings.
		const effectiveTools = [...toolsById.values()]
			.filter((tool) => isScopePreviewToolVisible(tool, mcpConfig))
			.sort((a, b) => a.toolId.localeCompare(b.toolId));
		const toolNames = effectiveTools.map((t) => t.toolId);

		const toolScopes: Record<string, string[]> = {};
		const granularToolScopes: Record<string, string[]> = {};
		const grouped: Record<string, string[]> = {};
		const granularGrouped: Record<string, string[]> = {};
		for (const tool of effectiveTools) {
			const enforced = resolveEnforcedScopes(tool, mcpConfig);
			const granular = [
				...new Set(enforced.map((scope) => toGranularScope(scope, tool))),
			];
			toolScopes[tool.toolId] = enforced;
			granularToolScopes[tool.toolId] = granular;
			groupToolByScopes(grouped, tool.toolId, enforced);
			groupToolByScopes(granularGrouped, tool.toolId, granular);
		}

		const scopeSummary: Record<string, number> = {};
		for (const [scope, scopeTools] of Object.entries(grouped)) {
			scopeSummary[scope] = scopeTools.length;
		}
		const granularScopeSummary: Record<string, number> = {};
		for (const [scope, scopeTools] of Object.entries(granularGrouped)) {
			granularScopeSummary[scope] = scopeTools.length;
		}

		return {
			toolScopes,
			grouped,
			granularToolScopes,
			granularGrouped,
			toolCount: toolNames.length,
			complete: preview.skippedSources.length === 0,
			scopeSummary,
			granularScopeSummary,
			sources: preview.sources,
			skippedSources: preview.skippedSources,
		};
	});

export const mcpServerContractRouter = mcpServerOs.router({
	register: registerProcedure,
	adoptResource: adoptResourceProcedure,
	syncScopes: syncScopesProcedure,
	getStatus: getStatusProcedure,
	previewToolScopes: previewToolScopesProcedure,
});
