/**
 * Core app record and hydrated-surface queries.
 *
 * Kept separate from the compatibility query barrel so an app lookup does not
 * evaluate every unrelated DB query module in a fresh Worker isolate.
 */

import {
	anyIds,
	coreStore,
	jsonRead,
	jsonType,
	pgTextArray,
} from "../core-store/dialect";
import { batchNonEmpty } from "../utils/batch";
import type { SQL, SQLWrapper } from "drizzle-orm";
import { coreTable } from "../core-store/client";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { resolveConnectionResourceAccess } from "@tedix/api-contract/utils/connection-resource-policy";
import { listOrganizationConnectionInstances } from "./connection-instances";
import { listOrganizationConnectionAllowedResources } from "./connection-providers";
import type { InstallationTrustPolicy } from "@tedix/api-contract/schemas/installation-trust";
import { getInstallationTrustPolicy } from "./installation-trust";
import type { WidgetConfig } from "@tedix/api-contract/schemas/widget";
import {
	and,
	asc,
	desc,
	eq,
	getColumns,
	exists,
	isNull,
	or,
	sql,
} from "drizzle-orm";
import type { DbClient } from "../client";
import type { AppMetadata, NewApp } from "../schema/apps";
import { apps as schemaApps } from "../schema/apps";
import {
	appCatalog as schemaAppCatalog,
	appCatalogMcpPrompts as schemaAppCatalogMcpPrompts,
	appCatalogMcpResources as schemaAppCatalogMcpResources,
	appCatalogMcpResourceTemplates as schemaAppCatalogMcpResourceTemplates,
} from "../schema/catalog";
import { appToolCspDomains as schemaAppToolCspDomains } from "../schema/configuration";
import { organizations as schemaOrganizations } from "../schema/organizations";
import { providerInstallations as schemaProviderInstallations } from "../schema/provider-installations";
import { appTools as schemaAppTools } from "../schema/tools";
import { withTransientD1ReadRetry } from "../utils/d1-retry";
import { aggregateAppEntryMatchesSql } from "./aggregate-app-links";
import { toolDefinitionIsLive } from "./tool-review-visibility";

/** Apply the execution resolver to the tools offered by discovery and skill binding. */
export async function filterAppConnectionResourceTools<
	T extends { config: typeof schemaAppTools.$inferSelect.config },
>(
	db: DbClient,
	app: Pick<typeof schemaApps.$inferSelect, "organizationId" | "metadata">,
	tools: T[],
): Promise<T[]> {
	const defaults = app.metadata?.mcpConfig;
	const candidates = tools.map((tool) => {
		const config = tool.config;
		const auth = isRecord(config?.auth) ? config.auth : undefined;
		const ownProvider =
			typeof auth?.connectionId === "string" ? auth.connectionId : undefined;
		const providerId =
			defaults?.connectionProviderId ??
			(auth?.type === "connection" ? ownProvider : undefined);
		const inherited = Boolean(defaults?.connectionProviderId);
		const instanceId =
			typeof auth?.connectionInstanceId === "string"
				? auth.connectionInstanceId
				: inherited
					? defaults?.connectionInstanceId
					: undefined;
		const scope =
			defaults?.connectionScope ??
			auth?.credentialScope ??
			auth?.scope ??
			"tenant";
		return {
			tool,
			config,
			auth,
			providerId,
			instanceId,
			bypass: !providerId || scope === "user",
		};
	});
	const tenant = candidates.filter((candidate) => !candidate.bypass);
	if (!tenant.length) return tools;
	const key = (providerId: string, id: string) =>
		JSON.stringify([providerId, id]);
	const pairs = tenant.flatMap(({ providerId, instanceId }) =>
		providerId && instanceId ? [{ providerId, id: instanceId }] : [],
	);
	const [policies, rows] = await Promise.all([
		listOrganizationConnectionAllowedResources(
			db,
			app.organizationId,
			tenant.flatMap((candidate) =>
				candidate.providerId ? [candidate.providerId] : [],
			),
		),
		listOrganizationConnectionInstances(db, app.organizationId, pairs),
	]);
	const providerLimits = new Map(
		policies.map((row) => [row.providerId, row.allowedResources]),
	);
	const instances = new Map(
		rows.map((row) => [key(row.providerId, row.id), row]),
	);
	return candidates
		.filter(({ config, auth, providerId, instanceId, bypass }) => {
			if (bypass || !providerId) return true;
			const allowedResources = providerLimits.get(providerId) ?? null;
			const effectiveConfig =
				auth?.type && auth.type !== "connection"
					? config
					: {
							...config,
							auth: { ...auth, type: "connection", connectionId: providerId },
						};
			if (
				!resolveConnectionResourceAccess({
					allowedResources,
					providerId,
					config: effectiveConfig,
				}).allowed
			)
				return false;
			if (!instanceId) return true;
			const instance = instances.get(key(providerId, instanceId));
			return Boolean(
				instance &&
				resolveConnectionResourceAccess({
					allowedResources,
					additionalLimits: [instance.allowedResources],
					providerId,
					config: effectiveConfig,
				}).allowed,
			);
		})
		.map((candidate) => candidate.tool);
}

type ToolSelectionOptions = {
	endpointPrefixes?: string[];
	toolIds?: string[];
	projection?: "definition" | "contract";
};

type CatalogMcpSurface = {
	catalogMcp: {
		id: string;
		slug: string | null;
		mcpEndpointNormalized: string | null;
		baseUrl: string | null;
		scanConnectionId: string | null;
		scanConnectionHeader: string | null;
		scanConnectionTemplate: string | null;
	} | null;
	catalogResources: Array<typeof schemaAppCatalogMcpResources.$inferSelect>;
	catalogResourceTemplates: Array<
		typeof schemaAppCatalogMcpResourceTemplates.$inferSelect
	>;
	catalogPrompts: Array<typeof schemaAppCatalogMcpPrompts.$inferSelect>;
};

function emptyCatalogMcpSurface(): CatalogMcpSurface {
	return {
		catalogMcp: null,
		catalogResources: [],
		catalogResourceTemplates: [],
		catalogPrompts: [],
	};
}

async function getCatalogMcpSurfaceForApp(
	db: DbClient,
	catalogAppId: string | null,
): Promise<CatalogMcpSurface> {
	const appCatalog = coreTable(db, schemaAppCatalog);
	const appCatalogMcpPrompts = coreTable(db, schemaAppCatalogMcpPrompts);
	const appCatalogMcpResources = coreTable(db, schemaAppCatalogMcpResources);
	const appCatalogMcpResourceTemplates = coreTable(
		db,
		schemaAppCatalogMcpResourceTemplates,
	);
	if (!catalogAppId) return emptyCatalogMcpSurface();

	const [
		catalogRows,
		catalogResources,
		catalogResourceTemplates,
		catalogPrompts,
	] = await db.batch([
		db
			.select({
				id: appCatalog.id,
				slug: appCatalog.slug,
				mcpEndpointNormalized: appCatalog.mcpEndpointNormalized,
				baseUrl: appCatalog.baseUrl,
				scanConnectionId: appCatalog.scanConnectionId,
				scanConnectionHeader: appCatalog.scanConnectionHeader,
				scanConnectionTemplate: appCatalog.scanConnectionTemplate,
			})
			.from(appCatalog)
			.where(eq(appCatalog.id, catalogAppId))
			.limit(1),
		db
			.select()
			.from(appCatalogMcpResources)
			.where(
				and(
					eq(appCatalogMcpResources.catalogAppId, catalogAppId),
					isNull(appCatalogMcpResources.removedAt),
				),
			)
			.orderBy(asc(appCatalogMcpResources.uri)),
		db
			.select()
			.from(appCatalogMcpResourceTemplates)
			.where(
				and(
					eq(appCatalogMcpResourceTemplates.catalogAppId, catalogAppId),
					isNull(appCatalogMcpResourceTemplates.removedAt),
				),
			)
			.orderBy(asc(appCatalogMcpResourceTemplates.name)),
		db
			.select()
			.from(appCatalogMcpPrompts)
			.where(
				and(
					eq(appCatalogMcpPrompts.catalogAppId, catalogAppId),
					isNull(appCatalogMcpPrompts.removedAt),
				),
			)
			.orderBy(asc(appCatalogMcpPrompts.promptName)),
	]);

	return {
		catalogMcp: catalogRows[0] ?? null,
		catalogResources,
		catalogResourceTemplates,
		catalogPrompts,
	};
}

/**
 * Batched {@link getCatalogMcpSurfaceForApp}. Four statements for the bound set of
 * catalog ids instead of four per app — the single-app version issued 4×N
 * queries for an N-app aggregate rebuild.
 *
 * Ordering within a catalog app is unchanged: rows come back ordered by
 * (catalog id, natural key), and grouping by catalog id restricts that to the
 * same relative order the per-app query produced.
 */
async function getCatalogMcpSurfacesForApps(
	db: DbClient,
	catalogAppIds: string[],
): Promise<Map<string, CatalogMcpSurface>> {
	const appCatalog = coreTable(db, schemaAppCatalog);
	const appCatalogMcpPrompts = coreTable(db, schemaAppCatalogMcpPrompts);
	const appCatalogMcpResources = coreTable(db, schemaAppCatalogMcpResources);
	const appCatalogMcpResourceTemplates = coreTable(
		db,
		schemaAppCatalogMcpResourceTemplates,
	);
	const out = new Map<string, CatalogMcpSurface>();
	const unique = [...new Set(catalogAppIds.filter(Boolean))];
	for (const id of unique) out.set(id, emptyCatalogMcpSurface());
	if (unique.length === 0) return out;

	const [
		catalogRows,
		catalogResources,
		catalogResourceTemplates,
		catalogPrompts,
	] = await db.batch([
		db
			.select({
				id: appCatalog.id,
				slug: appCatalog.slug,
				mcpEndpointNormalized: appCatalog.mcpEndpointNormalized,
				baseUrl: appCatalog.baseUrl,
				scanConnectionId: appCatalog.scanConnectionId,
				scanConnectionHeader: appCatalog.scanConnectionHeader,
				scanConnectionTemplate: appCatalog.scanConnectionTemplate,
			})
			.from(appCatalog)
			.where(anyIds(db, appCatalog.id, unique)),
		db
			.select()
			.from(appCatalogMcpResources)
			.where(
				and(
					anyIds(db, appCatalogMcpResources.catalogAppId, unique),
					isNull(appCatalogMcpResources.removedAt),
				),
			)
			.orderBy(
				asc(appCatalogMcpResources.catalogAppId),
				asc(appCatalogMcpResources.uri),
			),
		db
			.select()
			.from(appCatalogMcpResourceTemplates)
			.where(
				and(
					anyIds(db, appCatalogMcpResourceTemplates.catalogAppId, unique),
					isNull(appCatalogMcpResourceTemplates.removedAt),
				),
			)
			.orderBy(
				asc(appCatalogMcpResourceTemplates.catalogAppId),
				asc(appCatalogMcpResourceTemplates.name),
			),
		db
			.select()
			.from(appCatalogMcpPrompts)
			.where(
				and(
					anyIds(db, appCatalogMcpPrompts.catalogAppId, unique),
					isNull(appCatalogMcpPrompts.removedAt),
				),
			)
			.orderBy(
				asc(appCatalogMcpPrompts.catalogAppId),
				asc(appCatalogMcpPrompts.promptName),
			),
	]);

	for (const row of catalogRows) {
		const surface = out.get(row.id);
		if (surface) surface.catalogMcp = row;
	}
	for (const row of catalogResources) {
		out.get(row.catalogAppId)?.catalogResources.push(row);
	}
	for (const row of catalogResourceTemplates) {
		out.get(row.catalogAppId)?.catalogResourceTemplates.push(row);
	}
	for (const row of catalogPrompts) {
		out.get(row.catalogAppId)?.catalogPrompts.push(row);
	}
	return out;
}

function buildToolSelectionConditions(
	db: DbClient,
	options?: ToolSelectionOptions,
) {
	const appTools = coreTable(db, schemaAppTools);
	const conditions = [eq(appTools.enabled, true), toolDefinitionIsLive()];
	const toolIds = options?.toolIds?.filter(Boolean) ?? [];
	const endpointPrefixes = options?.endpointPrefixes?.filter(Boolean) ?? [];

	if (toolIds.length > 0) {
		conditions.push(anyIds(db, appTools.toolId, toolIds));
	}

	if (endpointPrefixes.length > 0) {
		const endpoint = jsonRead(db, appTools.config, ["endpoint"]);
		const prefixes =
			coreStore(db) === "postgres"
				? sql`jsonb_array_elements_text(${JSON.stringify(endpointPrefixes)}::text::jsonb) AS prefix(value)`
				: sql`json_each(${JSON.stringify(endpointPrefixes)}) AS prefix`;
		const nested =
			coreStore(db) === "postgres"
				? sql`translate(${endpoint}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') LIKE translate(prefix.value || '/%', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') ESCAPE ''`
				: sql`${endpoint} LIKE prefix.value || '/%'`;
		conditions.push(
			exists(
				db
					.select({ one: sql`1` })
					.from(prefixes)
					.where(or(sql`${endpoint} = prefix.value`, nested)),
			),
		);
	}

	return conditions;
}

function compareAppToolOrder(
	a: typeof schemaAppTools.$inferSelect,
	b: typeof schemaAppTools.$inferSelect,
): number {
	const sortA = a.sortOrder ?? Number.NEGATIVE_INFINITY;
	const sortB = b.sortOrder ?? Number.NEGATIVE_INFINITY;
	if (sortA !== sortB) return sortA - sortB;
	return (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
}

// ============================================================================
// App Queries
// ============================================================================

/**
 * Get app by ID
 */
export async function getAppById(db: DbClient, id: string) {
	return db.query.apps.findFirst({ where: { id } });
}

/**
 * Get an app only when it belongs to the requested organization.
 *
 * Tenant-facing callers should prefer this over fetching by id and checking
 * ownership afterward: the organization predicate stays in the D1 statement,
 * so a foreign row never crosses the query boundary.
 */
export async function getAppByIdForOrganization(
	db: DbClient,
	id: string,
	organizationId: string,
) {
	return db.query.apps.findFirst({ where: { id, organizationId } });
}

/** Ownership and row identity checks must not hydrate input/output schemas. */
export async function getAppPolicyMountMetadataForOrganization(
	db: DbClient,
	id: string,
	organizationId: string,
) {
	const apps = coreTable(db, schemaApps);
	const appTools = coreTable(db, schemaAppTools);
	const [app] = await db
		.select({
			id: apps.id,
			slug: apps.slug,
			organizationId: apps.organizationId,
			metadata: apps.metadata,
		})
		.from(apps)
		.where(and(eq(apps.id, id), eq(apps.organizationId, organizationId)))
		.limit(1);
	if (!app) return null;
	const rows = await db
		.select({
			id: appTools.id,
			toolId: appTools.toolId,
			config: appTools.config,
		})
		.from(appTools)
		.where(
			and(
				eq(appTools.appId, id),
				eq(appTools.enabled, true),
				toolDefinitionIsLive(),
			),
		)
		.orderBy(
			sql`${appTools.sortOrder} ASC NULLS FIRST`,
			sql`${appTools.createdAt} ASC NULLS FIRST`,
		);
	const tools = await filterAppConnectionResourceTools(db, app, rows);
	return { app, tools: tools.map(({ id, toolId }) => ({ id, toolId })) };
}

/**
 * Get an organization-owned app by ID with enabled tools (and tool type
 * metadata). The app ownership predicate is evaluated before any child rows
 * are loaded.
 */
export async function getAppByIdWithToolsForOrganization(
	db: DbClient,
	id: string,
	organizationId: string,
	options?: ToolSelectionOptions,
) {
	const apps = coreTable(db, schemaApps);
	const appTools = coreTable(db, schemaAppTools);
	const appRows = await db
		.select()
		.from(apps)
		.where(and(eq(apps.id, id), eq(apps.organizationId, organizationId)))
		.limit(1);
	const app = appRows[0];
	if (!app) return null;

	const tools = await db
		.select()
		.from(appTools)
		.where(
			and(eq(appTools.appId, id), ...buildToolSelectionConditions(db, options)),
		)
		.orderBy(
			sql`${appTools.sortOrder} ASC NULLS FIRST`,
			sql`${appTools.createdAt} ASC NULLS FIRST`,
		);

	const toolCsp = await getAppSurfaceCspDomains(
		db,
		tools.length ? [app.id] : [],
	);
	const toolCspByToolId = new Map<string, typeof toolCsp>();
	for (const domain of toolCsp) {
		const list = toolCspByToolId.get(domain.appToolId) ?? [];
		list.push(domain);
		toolCspByToolId.set(domain.appToolId, list);
	}

	const toolsWithCsp = tools.map((tool) => {
		const cspDomains = toolCspByToolId.get(tool.id) ?? [];
		return {
			...tool,
			toolCspDomains: cspDomains.map((domain) => ({
				toolId: tool.toolId,
				domainType: domain.domainType,
				domainUrl: domain.domainUrl,
				active: domain.active ?? true,
			})),
		};
	});

	const catalogSurface = await getCatalogMcpSurfaceForApp(db, app.catalogAppId);

	return {
		app,
		tools: await filterAppConnectionResourceTools(db, app, toolsWithCsp),
		...catalogSurface,
	};
}

/** Groups tool reads that share one selection in the batched surface load. */
function appSurfaceKey(slug: string, options?: ToolSelectionOptions): string {
	// Sorted so two requests for the same set in a different order share a group.
	const toolIds = [...(options?.toolIds ?? [])].sort().join(",");
	const prefixes = [...(options?.endpointPrefixes ?? [])].sort().join(",");
	return `${slug}\0${toolIds}\0${prefixes}\0${options?.projection ?? "definition"}`;
}

/**
 * Get app by slug with enabled tools (and tool type metadata)
 * Used by MCP to load tools quickly in one pass.
 */
export function getAppBySlugWithTools(
	db: DbClient,
	slug: string,
	options?: ToolSelectionOptions,
) {
	const apps = coreTable(db, schemaApps);
	const appTools = coreTable(db, schemaAppTools);
	return withTransientD1ReadRetry(`app ${slug} with tools`, async () => {
		const appRows = await db
			.select()
			.from(apps)
			.where(eq(apps.slug, slug))
			.limit(1);
		const app = appRows[0];
		if (!app) return null;

		const toolsById = new Map<string, typeof schemaAppTools.$inferSelect>();
		{
			const selection = options;
			const rows = await db
				.select()
				.from(appTools)
				.where(
					and(
						eq(appTools.appId, app.id),
						...buildToolSelectionConditions(db, selection),
					),
				)
				.orderBy(
					sql`${appTools.sortOrder} ASC NULLS FIRST`,
					sql`${appTools.createdAt} ASC NULLS FIRST`,
				);
			for (const row of rows) toolsById.set(row.id, row);
		}
		const tools = [...toolsById.values()].sort(compareAppToolOrder);

		const toolCsp = await getAppSurfaceCspDomains(
			db,
			tools.length ? [app.id] : [],
		);
		const toolCspByToolId = new Map<string, typeof toolCsp>();
		for (const domain of toolCsp) {
			const list = toolCspByToolId.get(domain.appToolId) ?? [];
			list.push(domain);
			toolCspByToolId.set(domain.appToolId, list);
		}

		const toolsWithCsp = tools.map((tool) => {
			const cspDomains = toolCspByToolId.get(tool.id) ?? [];
			return {
				...tool,
				toolCspDomains: cspDomains.map((domain) => ({
					toolId: tool.toolId,
					domainType: domain.domainType,
					domainUrl: domain.domainUrl,
					active: domain.active ?? true,
				})),
			};
		});

		const catalogSurface = await getCatalogMcpSurfaceForApp(
			db,
			app.catalogAppId,
		);

		return {
			app,
			tools: await filterAppConnectionResourceTools(db, app, toolsWithCsp),
			...catalogSurface,
		};
	});
}

/**
 * One aggregate entry to resolve. `appId`, when present, wins over `slug`: the
 * entry resolves by its stable id and `slug` is only the display/fallback name
 * stored beside it. `hostOrganizationId` names the organization of the app
 * whose `aggregateApps` holds the entry. Both id and legacy slug entries
 * must pass the aggregate ownership rule when a host is supplied (see
 * {@link aggregateSourceAllowed}).
 */
export type AppSurfaceRequest = {
	slug: string;
	appId?: string;
	hostOrganizationId?: string;
} & ToolSelectionOptions;

/** Cross-organization aggregate access needs an installation or provider grant. */
function aggregateSourceAllowed(
	hostOrganizationId: string,
	sourceOrganizationId: string,
	trust: InstallationTrustPolicy | null,
	providerGrants: ReadonlySet<string>,
): boolean {
	return (
		sourceOrganizationId === hostOrganizationId ||
		providerGrants.has(`${sourceOrganizationId}:${hostOrganizationId}`) ||
		trust?.aggregate.sharedSourceOrganizationIds.includes(
			sourceOrganizationId,
		) === true ||
		trust?.aggregate.aggregateHostOrganizationIds.includes(
			hostOrganizationId,
		) === true
	);
}

/** Read aggregate authority once for a batch of source organizations. */
export async function getAggregateAllowedSourceOrganizationIds(
	db: DbClient,
	hostOrganizationId: string,
	sourceOrganizationIds: string[],
): Promise<Set<string>> {
	const providerInstallations = coreTable(db, schemaProviderInstallations);
	const allowed = new Set<string>();
	const foreign = [...new Set(sourceOrganizationIds)].filter((id) => {
		if (id !== hostOrganizationId) return true;
		allowed.add(id);
		return false;
	});
	if (foreign.length === 0) return allowed;
	const trust = await getInstallationTrustPolicy(db);
	const remaining = foreign.filter((id) => {
		if (!aggregateSourceAllowed(hostOrganizationId, id, trust, new Set()))
			return true;
		allowed.add(id);
		return false;
	});
	if (remaining.length) {
		const grants = await db
			.select({
				sourceOrganizationId: providerInstallations.providerOrganizationId,
			})
			.from(providerInstallations)
			.where(
				and(
					eq(providerInstallations.status, "active"),
					eq(providerInstallations.customerOrganizationId, hostOrganizationId),
					anyIds(db, providerInstallations.providerOrganizationId, remaining),
				),
			);
		for (const grant of grants) allowed.add(grant.sourceOrganizationId);
	}
	return allowed;
}

/** The same ownership rule used by app writes, discovery, preview and skill binding. */
export async function isAggregateSourceAllowed(
	db: DbClient,
	hostOrganizationId: string,
	sourceOrganizationId: string,
): Promise<boolean> {
	return (
		await getAggregateAllowedSourceOrganizationIds(db, hostOrganizationId, [
			sourceOrganizationId,
		])
	).has(sourceOrganizationId);
}

/** Result element of {@link getAppsBySlugsWithTools}; `null` = slug not found. */
type LoadedAppSurface = NonNullable<
	Awaited<ReturnType<typeof getAppBySlugWithTools>>
>;
export type AppSurfaceResult =
	| (Omit<LoadedAppSurface, "tools"> & {
			tools: Array<
				LoadedAppSurface["tools"][number] & { inputSchemaChars?: number }
			>;
	  })
	| null;

/** Read CSP by resolved app, so tool count never adds serial D1 round trips. */
async function getAppSurfaceCspDomains(db: DbClient, appIds: string[]) {
	const appToolCspDomains = coreTable(db, schemaAppToolCspDomains);
	const appTools = coreTable(db, schemaAppTools);
	const domains: Array<typeof schemaAppToolCspDomains.$inferSelect> = [];
	if (appIds.length) {
		domains.push(
			...(await db
				.select(getColumns(appToolCspDomains))
				.from(appToolCspDomains)
				.innerJoin(appTools, eq(appTools.id, appToolCspDomains.appToolId))
				.where(anyIds(db, appTools.appId, appIds))),
		);
	}
	return domains;
}

/**
 * Batched {@link getAppBySlugWithTools} — one apps/api invocation for MANY apps.
 *
 * The MCP aggregate rebuild resolves ~40 apps and was issuing one
 * `apps.getBySlugWithTools` per app. Each apps/api invocation pays a cold-isolate
 * startup cost, so that fan-out pushed entries past the per-entry deadline and
 * degraded the surface.
 *
 * The results array is POSITIONALLY parallel to `requests`: index i is the
 * surface for `requests[i]`, and `null` means that slug does not exist. A caller
 * can therefore always tell "this app has no tools" (`tools: []`) from "this app
 * was never resolved" (absent / null) without a second lookup. Duplicate slugs
 * with different tool selections are legal and each gets its own entry.
 *
 * Per-app ordering is preserved exactly: `app_tools` is globally ordered by the
 * same (sort_order, created_at) keys and then grouped by app, which restricts to
 * the same relative order the single-app query produced. Same for the catalog
 * surfaces, which order by (catalog id, natural key).
 */
export async function getAppsBySlugsWithTools(
	db: DbClient,
	requests: AppSurfaceRequest[],
): Promise<AppSurfaceResult[]> {
	const apps = coreTable(db, schemaApps);
	const providerInstallations = coreTable(db, schemaProviderInstallations);
	const appTools = coreTable(db, schemaAppTools);
	if (requests.length === 0) return [];

	return withTransientD1ReadRetry(
		`${requests.length} app surface(s) with tools`,
		async () => {
			// ── apps ──────────────────────────────────────────────────────────────
			// An entry with `appId` resolves by id; only entries without one fall
			// back to the slug lookup.
			const slugs = [
				...new Set(requests.filter((r) => !r.appId).map((r) => r.slug)),
			];
			const ids = [
				...new Set(
					requests.map((r) => r.appId).filter((id): id is string => !!id),
				),
			];
			const slugRows: Array<typeof schemaApps.$inferSelect> = [];
			if (slugs.length) {
				slugRows.push(
					...(await db
						.select()
						.from(apps)
						.where(anyIds(db, apps.slug, slugs))),
				);
			}
			const idRows: Array<typeof schemaApps.$inferSelect> = [];
			if (ids.length) {
				idRows.push(
					...(await db
						.select()
						.from(apps)
						.where(anyIds(db, apps.id, ids))),
				);
			}
			const appBySlug = new Map(slugRows.map((app) => [app.slug, app]));
			const appById = new Map(idRows.map((app) => [app.id, app]));

			const requestedApp = (request: AppSurfaceRequest) =>
				request.appId
					? appById.get(request.appId)
					: (slugRows.find(
							(app) =>
								app.slug === request.slug &&
								app.organizationId === request.hostOrganizationId,
						) ?? appBySlug.get(request.slug));

			// Ownership facts for every source whose target sits outside its host.
			const orgIds = new Set<string>();
			for (const request of requests) {
				const target = requestedApp(request);
				if (!target || !request.hostOrganizationId) continue;
				if (target.organizationId === request.hostOrganizationId) continue;
				orgIds.add(target.organizationId);
				orgIds.add(request.hostOrganizationId);
			}
			const trust = orgIds.size ? await getInstallationTrustPolicy(db) : null;
			const providerGrants = new Set<string>();
			if (orgIds.size) {
				const grants = await db
					.select({
						providerOrganizationId:
							providerInstallations.providerOrganizationId,
						customerOrganizationId:
							providerInstallations.customerOrganizationId,
					})
					.from(providerInstallations)
					.where(
						and(
							eq(providerInstallations.status, "active"),
							anyIds(db, providerInstallations.providerOrganizationId, [
								...orgIds,
							]),
						),
					);
				for (const row of grants) {
					if (!orgIds.has(row.customerOrganizationId)) continue;
					providerGrants.add(
						`${row.providerOrganizationId}:${row.customerOrganizationId}`,
					);
				}
			}

			// Positionally parallel to `requests`. An id entry without a host, or
			// whose target the ownership rule refuses, is unresolved (`null`) —
			// never silently re-resolved by its slug.
			const resolvedApps = requests.map((request) => {
				const target = requestedApp(request);
				if (!target) return null;
				if (!request.hostOrganizationId) return request.appId ? null : target;
				return aggregateSourceAllowed(
					request.hostOrganizationId,
					target.organizationId,
					trust,
					providerGrants,
				)
					? target
					: null;
			});
			const appRows = [
				...new Map(
					resolvedApps
						.filter(
							(app): app is typeof schemaApps.$inferSelect => app !== null,
						)
						.map((app) => [app.id, app]),
				).values(),
			];

			// ── tools, grouped by identical tool selection ────────────────────────
			// Requests overwhelmingly share the empty selection, so this is normally
			// a single statement per selection group.
			const selectionGroups = new Map<
				string,
				{ options: ToolSelectionOptions; appIds: string[] }
			>();
			for (const [index, request] of requests.entries()) {
				const app = resolvedApps[index];
				if (!app) continue;
				const options: ToolSelectionOptions = {
					toolIds: request.toolIds,
					endpointPrefixes: request.endpointPrefixes,
					projection: request.projection,
				};
				const signature = appSurfaceKey("", options);
				const group = selectionGroups.get(signature) ?? { options, appIds: [] };
				if (!group.appIds.includes(app.id)) group.appIds.push(app.id);
				selectionGroups.set(signature, group);
			}

			const definitionApps = appRows.filter((app) =>
				requests.some(
					(request, index) =>
						request.projection !== "contract" &&
						resolvedApps[index]?.id === app.id,
				),
			);
			const catalogAppIds = [
				...new Set(
					definitionApps
						.map((app) => app.catalogAppId)
						.filter((id): id is string => Boolean(id)),
				),
			];
			const loadTools = async () => {
				const bySelection = new Map<
					string,
					Map<
						string,
						Array<
							typeof schemaAppTools.$inferSelect & { inputSchemaChars?: number }
						>
					>
				>();
				const seenBySelection = new Map<string, Set<string>>();
				const reads = [...selectionGroups].flatMap(([signature, group]) => {
					bySelection.set(
						signature,
						new Map(group.appIds.map((id) => [id, []])),
					);
					seenBySelection.set(signature, new Set());
					const conditions = buildToolSelectionConditions(db, group.options);
					return [
						{
							signature,
							query: db
								.select(
									group.options.projection === "contract"
										? {
												...getColumns(appTools),
												inputSchemaChars:
													sql<number>`${coreStore(db) === "postgres" ? sql`length(regexp_replace(${appTools.inputSchema}::text, ${String.raw`("(?:[^"\\]|\\.)*")|\s+`}, ${String.raw`\1`}, 'g'))` : sql`length(${appTools.inputSchema})`}`
														.mapWith(Number)
														.as("input_schema_chars"),
												inputSchema: (coreStore(db) === "postgres"
													? sql`'{"type":"object"}'::jsonb`
													: sql`'{"type":"object"}'`
												)
													.mapWith(appTools.inputSchema)
													.as("input_schema"),
												outputSchema: sql<null>`null`.as("output_schema"),
												outputTemplate: sql<null>`null`.as("output_template"),
												icons: sql<null>`null`.as("icons"),
												reviewDiff: sql<null>`null`.as("review_diff"),
											}
										: getColumns(appTools),
								)
								.from(appTools)
								.where(
									and(anyIds(db, appTools.appId, group.appIds), ...conditions),
								)
								.orderBy(
									sql`${appTools.sortOrder} ASC NULLS FIRST`,
									sql`${appTools.createdAt} ASC NULLS FIRST`,
								),
						},
					];
				});
				// All selection groups share one batch round trip.
				if (reads.length) {
					const results = await db.batch(
						batchNonEmpty(reads.map((read) => read.query)),
					);
					for (const [index, rows] of results.entries()) {
						const { signature } = reads[index]!;
						const seen = seenBySelection.get(signature)!;
						const byApp = bySelection.get(signature)!;
						for (const row of rows) {
							if (seen.has(row.id)) continue;
							seen.add(row.id);
							byApp.get(row.appId)?.push(row);
						}
					}
				}
				for (const byApp of bySelection.values())
					for (const rows of byApp.values()) rows.sort(compareAppToolOrder);
				return bySelection;
			};
			const [toolsBySelection, cspDomains, catalogSurfaces] = await Promise.all(
				[
					loadTools(),
					getAppSurfaceCspDomains(
						db,
						definitionApps.map((app) => app.id),
					),
					getCatalogMcpSurfacesForApps(db, catalogAppIds),
				],
			);
			const toolCspByToolId = new Map<
				string,
				Array<typeof schemaAppToolCspDomains.$inferSelect>
			>();
			for (const row of cspDomains) {
				const list = toolCspByToolId.get(row.appToolId) ?? [];
				list.push(row);
				toolCspByToolId.set(row.appToolId, list);
			}

			return Promise.all(
				requests.map(async (request, index) => {
					const app = resolvedApps[index];
					if (!app) return null;
					const signature = appSurfaceKey("", {
						toolIds: request.toolIds,
						endpointPrefixes: request.endpointPrefixes,
						projection: request.projection,
					});
					const tools = toolsBySelection.get(signature)?.get(app.id) ?? [];
					const toolsWithCsp = tools.map((tool) => ({
						...tool,
						toolCspDomains: (toolCspByToolId.get(tool.id) ?? []).map(
							(domain) => ({
								toolId: tool.toolId,
								domainType: domain.domainType,
								domainUrl: domain.domainUrl,
								active: domain.active ?? true,
							}),
						),
					}));
					return {
						app,
						tools: await filterAppConnectionResourceTools(
							db,
							app,
							toolsWithCsp,
						),
						...(catalogSurfaces.get(app.catalogAppId ?? "") ??
							emptyCatalogMcpSurface()),
					};
				}),
			);
		},
	);
}

/**
 * Get app by domain
 * Checks both primaryDomain (e.g., "tedix.dev") and customMcpDomain (e.g., "mcp.tedix.dev")
 * Custom MCP domains allow apps to use their own TLD for AI app submissions
 */
export async function getAppByDomain(db: DbClient, domain: string) {
	const apps = coreTable(db, schemaApps);
	const rows = await db
		.select()
		.from(apps)
		.where(or(eq(apps.primaryDomain, domain), eq(apps.customMcpDomain, domain)))
		.limit(1);
	return rows[0] ?? undefined;
}

/**
 * List all apps with pagination
 */
export async function listApps(
	db: DbClient,
	opts?: { limit?: number; offset?: number },
) {
	const apps = coreTable(db, schemaApps);
	return db
		.select()
		.from(apps)
		.orderBy(desc(apps.createdAt))
		.limit(opts?.limit ?? 50)
		.offset(opts?.offset ?? 0);
}

/**
 * List apps by visibility
 * Used by TedixMcpAgent to get public apps for cross-app search
 */
/**
 * Create a new app
 */
export async function createApp(
	db: DbClient,
	data: Omit<NewApp, "id" | "createdAt" | "updatedAt">,
) {
	const apps = coreTable(db, schemaApps);
	const id = crypto.randomUUID();
	const now = new Date().toISOString();

	await db.insert(apps).values({
		...data,
		id,
		createdAt: now,
		updatedAt: now,
	});

	return getAppById(db, id);
}

export async function createAppWithId(db: DbClient, data: NewApp) {
	const apps = coreTable(db, schemaApps);
	await db.insert(apps).values(data);
	return getAppById(db, data.id);
}

/**
 * Update an app
 */
export async function updateApp(
	db: DbClient,
	id: string,
	data: Partial<Omit<NewApp, "id" | "createdAt">>,
) {
	const apps = coreTable(db, schemaApps);
	const now = new Date().toISOString();

	await db
		.update(apps)
		.set({
			...data,
			updatedAt: now,
		})
		.where(eq(apps.id, id));

	return getAppById(db, id);
}

/**
 * Upsert an app (create or update if exists by domain)
 * This handles race conditions when multiple sources try to create the same app
 *
 * Delete an app
 * @returns true if deletion was successful (no error thrown)
 */
/**
 * Delete an app and, in the same batch, remove every `aggregateApps` /
 * `inactiveAggregateApps` entry that links to it from the other apps of its
 * organization (by id, or by slug for entries written before ids were stored).
 * Links from other organizations are left alone.
 */
export async function deleteApp(db: DbClient, id: string): Promise<boolean> {
	const apps = coreTable(db, schemaApps);
	const [target] = await db
		.select({
			id: apps.id,
			organizationId: apps.organizationId,
			slug: apps.slug,
		})
		.from(apps)
		.where(eq(apps.id, id))
		.limit(1);
	const remove = db.delete(apps).where(eq(apps.id, id));
	if (!target) {
		await remove;
		return true;
	}
	const matches = aggregateAppEntryMatchesSql(db, {
		appId: target.id,
		slug: target.slug,
	});
	const now = new Date().toISOString();
	const scrub = (path: string) => {
		const keys = path.slice(2).split(".");
		const array = aggregateArrayRead(db, apps.metadata, keys);
		const filtered = aggregateArrayCollect(db, array, sql`not ${matches}`);
		return db
			.update(apps)
			.set({
				metadata:
					coreStore(db) === "postgres"
						? sql`jsonb_set(${apps.metadata}, ${pgTextArray(keys)}::text[], ${filtered}, true)`
						: sql`json_set(${apps.metadata}, ${path}, json(${filtered}))`,
				updatedAt: now,
			})
			.where(
				and(
					eq(apps.organizationId, target.organizationId),
					sql`${apps.id} != ${target.id}`,
					sql`${jsonType(db, apps.metadata, keys)} = 'array'`,
					exists(
						db
							.select({ one: sql`1` })
							.from(aggregateArrayRows(db, array))
							.where(matches),
					),
				),
			);
	};
	await db.batch([
		scrub("$.mcpConfig.aggregateApps"),
		scrub("$.mcpConfig.inactiveAggregateApps"),
		remove,
	]);
	return true;
}

/**
 * Parse app metadata from JSON
 */
function coerceOptionalBoolean(value: unknown): boolean | undefined {
	if (value === 0) return false;
	if (value === 1) return true;
	if (typeof value === "boolean") return value;
	return undefined;
}

function normalizeAppMetadataBooleans(metadata: AppMetadata): AppMetadata {
	const capabilities = metadata.capabilities;
	if (capabilities) {
		const checkoutEnabled = coerceOptionalBoolean(
			capabilities.checkout?.enabled,
		);
		if (checkoutEnabled !== undefined && capabilities.checkout) {
			capabilities.checkout.enabled = checkoutEnabled;
		}
		const nativePayments = coerceOptionalBoolean(
			capabilities.checkout?.nativePayments,
		);
		if (nativePayments !== undefined && capabilities.checkout) {
			capabilities.checkout.nativePayments = nativePayments;
		}
		const cartEnabled = coerceOptionalBoolean(capabilities.cart?.enabled);
		if (cartEnabled !== undefined && capabilities.cart) {
			capabilities.cart.enabled = cartEnabled;
		}
		const persistCart = coerceOptionalBoolean(capabilities.cart?.persistCart);
		if (persistCart !== undefined && capabilities.cart) {
			capabilities.cart.persistCart = persistCart;
		}
		const wishlistEnabled = coerceOptionalBoolean(
			capabilities.wishlist?.enabled,
		);
		if (wishlistEnabled !== undefined && capabilities.wishlist) {
			capabilities.wishlist.enabled = wishlistEnabled;
		}
		const compareEnabled = coerceOptionalBoolean(capabilities.compare?.enabled);
		if (compareEnabled !== undefined && capabilities.compare) {
			capabilities.compare.enabled = compareEnabled;
		}
		const mapEnabled = coerceOptionalBoolean(capabilities.map?.enabled);
		if (mapEnabled !== undefined && capabilities.map) {
			capabilities.map.enabled = mapEnabled;
		}
		const externalCtaEnabled = coerceOptionalBoolean(
			capabilities.externalCta?.enabled,
		);
		if (externalCtaEnabled !== undefined && capabilities.externalCta) {
			capabilities.externalCta.enabled = externalCtaEnabled;
		}
		const externalOpenInNewTab = coerceOptionalBoolean(
			capabilities.externalCta?.openInNewTab,
		);
		if (externalOpenInNewTab !== undefined && capabilities.externalCta) {
			capabilities.externalCta.openInNewTab = externalOpenInNewTab;
		}
	}

	const blogEnabled = coerceOptionalBoolean(metadata.blogConfig?.enabled);
	if (blogEnabled !== undefined && metadata.blogConfig) {
		metadata.blogConfig.enabled = blogEnabled;
	}
	const sitemapEnabled = coerceOptionalBoolean(
		metadata.blogConfig?.sitemapEnabled,
	);
	if (sitemapEnabled !== undefined && metadata.blogConfig) {
		metadata.blogConfig.sitemapEnabled = sitemapEnabled;
	}
	const rssEnabled = coerceOptionalBoolean(metadata.blogConfig?.rssEnabled);
	if (rssEnabled !== undefined && metadata.blogConfig) {
		metadata.blogConfig.rssEnabled = rssEnabled;
	}
	const imageGenEnabled = coerceOptionalBoolean(
		metadata.blogConfig?.imageGeneration?.enabled,
	);
	if (imageGenEnabled !== undefined && metadata.blogConfig?.imageGeneration) {
		metadata.blogConfig.imageGeneration.enabled = imageGenEnabled;
	}

	const generateAnswers = coerceOptionalBoolean(
		metadata.contentConfig?.generateAnswers,
	);
	if (generateAnswers !== undefined && metadata.contentConfig) {
		metadata.contentConfig.generateAnswers = generateAnswers;
	}

	return metadata;
}

export function getAppMetadataJson(app: {
	metadata?: unknown;
}): AppMetadata | null {
	if (!app.metadata) return null;

	try {
		// Drizzle mode: "json" auto-deserializes; handle legacy string case defensively
		const metadata =
			typeof app.metadata === "string"
				? (JSON.parse(app.metadata) as AppMetadata)
				: (app.metadata as AppMetadata);
		if (!metadata) return null;
		return normalizeAppMetadataBooleans(metadata);
	} catch {
		return null;
	}
}

/**
 * Get widget config from app metadata
 */
export async function getWidgetConfig(
	db: DbClient,
	appId: string,
): Promise<WidgetConfig | null> {
	const app = await getAppById(db, appId);
	if (!app?.metadata) return null;

	const metadata = getAppMetadataJson(app);
	return metadata?.widgetConfig || null;
}

/**
 * Update app metadata (partial merge)
 */
export async function updateAppMetadata(
	db: DbClient,
	appId: string,
	metadata: Partial<AppMetadata>,
) {
	const app = await getAppById(db, appId);
	if (!app) throw new Error(`App not found: ${appId}`);

	const existingMetadata = getAppMetadataJson(app) || {};
	const mergedMetadata = {
		...existingMetadata,
		...metadata,
	};

	return updateApp(db, appId, {
		metadata: mergedMetadata as AppMetadata,
	});
}

function aggregateArrayRead(
	db: DbClient,
	metadata: SQLWrapper,
	path: readonly string[],
) {
	const value = jsonRead(db, metadata, path, "json");
	return coreStore(db) === "postgres"
		? sql`coalesce(nullif(${value}, 'null'::jsonb), '[]'::jsonb)`
		: sql`coalesce(${value}, json('[]'))`;
}

function aggregateArrayRows(db: DbClient, array: SQL) {
	return coreStore(db) === "postgres"
		? sql`jsonb_array_elements(CASE WHEN jsonb_typeof(${array}) = 'array' THEN ${array} ELSE '[]'::jsonb END) WITH ORDINALITY AS aggregate_entry(value, position)`
		: sql`json_each(${array}) AS aggregate_entry`;
}

function aggregateArrayCollect(
	db: DbClient,
	array: SQL,
	where: SQL,
	value?: SQL,
) {
	return coreStore(db) === "postgres"
		? sql`(select coalesce(jsonb_agg(${value ?? sql`value`} ORDER BY position), '[]'::jsonb) from ${aggregateArrayRows(db, array)} where ${where})`
		: sql`(select coalesce(json_group_array(${value ?? sql`json(value)`}), json('[]')) from ${aggregateArrayRows(db, array)} where ${where})`;
}

function aggregateArrayAppend(db: DbClient, left: SQL, right: SQL) {
	return coreStore(db) === "postgres"
		? sql`(${left} || ${right})`
		: sql`(select json_group_array(json(value)) from (select value from json_each(${left}) union all select value from json_each(${right})))`;
}

function aggregateArraySize(db: DbClient, array: SQL) {
	return coreStore(db) === "postgres"
		? sql`jsonb_array_length(${array})`
		: sql`json_array_length(${array})`;
}

/**
 * Atomically change only one gateway member; preserve all other metadata.
 *
 * Entries are matched by app id (slug for entries written before ids were
 * stored). Enabling stamps the member's current `{ appId, slug }` onto its
 * entry, so a renamed app stays linked and old slug-only entries gain an id.
 */
export async function setAppGatewayMembership(
	db: DbClient,
	organizationId: string,
	gatewayId: string,
	member: { appId: string; slug: string },
	enabled: boolean,
) {
	const apps = coreTable(db, schemaApps);
	const { appId, slug } = member;
	const matches = aggregateAppEntryMatchesSql(db, member);
	const pg = coreStore(db) === "postgres";
	const members = aggregateArrayRead(db, apps.metadata, [
		"mcpConfig",
		"aggregateApps",
	]);
	const inactive = aggregateArrayRead(db, apps.metadata, [
		"mcpConfig",
		"inactiveAggregateApps",
	]);
	const stamp = pg
		? sql`value || jsonb_build_object('appId', ${appId}::text, 'slug', ${slug}::text)`
		: sql`json_set(json(value), '$.appId', ${appId}, '$.slug', ${slug})`;
	const activeMatches = aggregateArrayCollect(db, members, matches);
	const savedMatches = aggregateArrayCollect(db, inactive, matches, stamp);
	const stampedMembers = aggregateArrayCollect(
		db,
		members,
		sql`true`,
		sql`case when ${matches} then ${stamp} else ${pg ? sql`value` : sql`json(value)`} end`,
	);
	const filtered = aggregateArrayCollect(db, members, sql`not ${matches}`);
	const inactiveFiltered = aggregateArrayCollect(
		db,
		inactive,
		sql`not ${matches}`,
	);
	const fresh = pg
		? sql`jsonb_build_array(jsonb_build_object('appId', ${appId}::text, 'slug', ${slug}::text))`
		: sql`json_array(json_object('appId', ${appId}, 'slug', ${slug}))`;
	const restored = sql`case when ${aggregateArraySize(db, savedMatches)} > 0 then ${savedMatches} else ${fresh} end`;
	const next = enabled
		? sql`case when ${aggregateArraySize(db, activeMatches)} > 0 then ${stampedMembers} else ${aggregateArrayAppend(db, members, restored)} end`
		: filtered;
	const nextInactive = enabled
		? inactiveFiltered
		: sql`case when ${aggregateArraySize(db, activeMatches)} = 0 then ${inactive} else ${aggregateArrayAppend(db, inactiveFiltered, activeMatches)} end`;
	const metadata = pg
		? sql`jsonb_set(coalesce(${apps.metadata}, '{}'::jsonb), '{mcpConfig}', coalesce(nullif(${apps.metadata}->'mcpConfig', 'null'::jsonb), '{}'::jsonb) || jsonb_build_object('aggregateApps', ${next}, 'inactiveAggregateApps', ${nextInactive}), true)`
		: sql`json_set(coalesce(${apps.metadata}, '{}'), '$.mcpConfig.aggregateApps', json(${next}), '$.mcpConfig.inactiveAggregateApps', json(${nextInactive}))`;
	return db
		.update(apps)
		.set({
			metadata,
			updatedAt: new Date().toISOString(),
		})
		.where(and(eq(apps.id, gatewayId), eq(apps.organizationId, organizationId)))
		.returning({ id: apps.id });
}

/** Source identity follows the same aggregate ownership rule as discovery and binding. */
export async function getAggregateConnectionSourceTool(
	db: DbClient,
	input: { organizationId: string; appId: string; toolId: string },
) {
	const apps = coreTable(db, schemaApps);
	const appTools = coreTable(db, schemaAppTools);
	const [source] = await db
		.select({
			organizationId: apps.organizationId,
			visibility: apps.visibility,
		})
		.from(apps)
		.where(eq(apps.id, input.appId))
		.limit(1);
	if (
		!source ||
		source.visibility === "disabled" ||
		!(await isAggregateSourceAllowed(
			db,
			input.organizationId,
			source.organizationId,
		))
	)
		return undefined;
	const [tool] = await db
		.select()
		.from(appTools)
		.where(
			and(eq(appTools.appId, input.appId), eq(appTools.toolId, input.toolId)),
		)
		.limit(1);
	return tool;
}
