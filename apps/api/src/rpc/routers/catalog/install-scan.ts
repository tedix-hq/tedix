import { type BaseContext, ErrorCodes, createError } from "../../orpc";
import type { ConnectionCredentialProfile } from "@tedix/api-contract/schemas/connections";
import {
	ConnectionTokenLookupError,
	type ConnectionProviderConfig,
} from "@tedix/auth/connections";
import type {
	CreateTenantOpenApiMcpAppInput,
	InstallTenantMcpAppsInput,
	InstallTenantMcpAppsOutput,
	OpenApiImportInput,
	UninstallTenantMcpAppInput,
	UninstallTenantMcpAppOutput,
} from "@tedix/api-contract/schemas/catalog";
import { JsonValueSchema } from "@tedix/api-contract/schemas/common";
import type { McpConfig } from "@tedix/db/schema/apps";
import {
	type ServiceBindingFetcher,
	serviceBindingFetchFn,
} from "../../../lib/mcp-client";
import { auditActor, emitAuditEvent } from "../../audit-helpers";
import {
	createAppCatalogSyncLog,
	updateAppCatalogSyncLog,
} from "@tedix/db/queries/catalog/sync-logs";
import { episodeTraceId } from "../../episode-trace";
import { getAppBySlugForOrg, getCatalogProxyApp } from "@tedix/db/queries/apps";
import {
	getCatalogAppById,
	getCatalogAppBySlug,
} from "@tedix/db/queries/catalog/get-app";
import { listCatalogApps } from "@tedix/db/queries/catalog/list-apps";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import { getTrustedMcpHostAppContext } from "../../mcp-host-context";
import { installFromCatalog } from "@tedix/db/queries/catalog/install";
import { parse as parseYaml } from "yaml";
import { propagateTools } from "@tedix/db/queries/catalog/fork-propagation";
import {
	purgeMcpAggregateCache,
	publishMcpCatalogInventoryEvents,
} from "../../../lib/mcp-subscriptions";
import {
	resolveDriftReport,
	saveDriftReport,
} from "@tedix/db/queries/catalog/drift-reports";
import { resolveTedixInternalScanHeaders as resolveFirstPartyScanHeaders } from "../../../lib/catalog-internal-scan";
import {
	syncCatalogMcpPrompts,
	syncCatalogMcpResourceTemplates,
	syncCatalogMcpResources,
	syncCatalogMcpTools,
} from "@tedix/db/queries/catalog/mcp-tools";
import { syncCatalogMcpSkills } from "@tedix/db/queries/catalog/mcp-skills";
import { toJsonRecord } from "@tedix/db/utils/json";
import { updateApp } from "@tedix/db/queries/app-records";
import { updateCatalogAppHealthMetrics } from "@tedix/db/queries/catalog/health-metrics";
import {
	detachAggregateAppEntries,
	CatalogAppRecord,
	TenantMcpInstallInput,
	TenantMcpInstallResult,
	calculateCatalogInstallability,
	getCatalogBaseApp,
	mcpConfigRecord,
	mergeNamespaceToolScopes,
	metadataRecord,
	readAggregateApps,
	readNamespaceToolScopes,
	removeNamespaceToolScopes,
	sanitizeNamespace,
	upsertAggregateAppEntry,
} from "./policy-quality";
import { tenantConnectionHandoffUrl } from "./tenant-install-handoff";
import {
	classifySuccessfulMcpScan,
	isScanListAuthoritative,
} from "../../../workflows/mcp-scan-diagnostics";

export async function installTenantMcpAppFromCatalog(
	context: BaseContext,
	input: TenantMcpInstallInput,
): Promise<TenantMcpInstallResult> {
	const { db } = context;
	const {
		catalogAppId,
		catalogAppSlug,
		targetAggregatorSlug,
		slug,
		name,
		description,
		visibility,
		prefix,
		connectionProviderId,
		connectionScope,
		connectionScopes,
		organizationQueryParam,
		toolScopes,
		dryRun,
	} = input;
	const {
		appId: hostAppId,
		appOrgId: hostAppOrgId,
		appSlug: hostAppSlug,
	} = getTrustedMcpHostAppContext(context);
	const orgId = hostAppOrgId ?? context.organizationId;
	if (!orgId) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Organization context required to install a tenant MCP app",
		);
	}
	const catalogApp = catalogAppId
		? await getCatalogAppById(db, catalogAppId)
		: await getCatalogAppBySlug(db, catalogAppSlug as string);
	if (!catalogApp) {
		throw createError(ErrorCodes.NOT_FOUND, "Catalog app not found");
	}
	const preflightInstallability = calculateCatalogInstallability(catalogApp);
	if (
		preflightInstallability.state === "disabled" ||
		preflightInstallability.state === "listing_only" ||
		preflightInstallability.state === "service_connector" ||
		preflightInstallability.state === "needs_mcp_endpoint"
	) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			`Catalog app "${catalogApp.name}" is not installable: ${preflightInstallability.reason}`,
		);
	}
	const targetAggregator = await getAppBySlugForOrg(
		db,
		targetAggregatorSlug,
		orgId,
	);
	if (!targetAggregator) {
		throw createError(ErrorCodes.NOT_FOUND, "Target aggregator app not found");
	}
	if (
		hostAppId &&
		targetAggregator.id !== hostAppId &&
		targetAggregator.slug !== hostAppSlug
	) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Target aggregator must be the MCP host app",
		);
	}
	if (targetAggregator.organizationId !== orgId) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Target aggregator must belong to the caller's organization",
		);
	}
	const baseApp = await getCatalogBaseApp(db, catalogApp.id);
	const materializedBaseApp = false;
	if (!baseApp) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			`Catalog app "${catalogApp.name}" is not prepared for tenant install. A platform catalog operator must materialize its shared base app first.`,
		);
	}
	const installability = calculateCatalogInstallability(catalogApp, baseApp);
	if (!installability.installable) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			`Catalog app "${catalogApp.name}" is not installable: ${installability.reason}`,
		);
	}
	const organization = await getOrganizationById(db, orgId);
	const tenantSuffix =
		organization?.slug ??
		targetAggregator.slug.replace(/-unified$/, "") ??
		orgId.slice(0, 8);
	const proxySlug = (slug ?? `${baseApp.slug}-${tenantSuffix}`).toLowerCase();
	const namespace = prefix ?? sanitizeNamespace(proxySlug);
	const existingProxy = await getCatalogProxyApp(db, {
		organizationId: orgId,
		catalogAppId: catalogApp.id,
		sourceAppId: baseApp.id,
	});
	const existingSlugOwner = await getAppBySlugForOrg(db, proxySlug, orgId);
	if (
		existingSlugOwner &&
		(!existingProxy || existingSlugOwner.id !== existingProxy.id)
	) {
		throw createError(
			ErrorCodes.CONFLICT,
			`App slug "${proxySlug}" already exists`,
		);
	}
	let proxyApp = existingProxy ?? null;
	if (!proxyApp && !dryRun) {
		const result = await installFromCatalog(db, {
			catalogAppId: catalogApp.id,
			organizationId: orgId,
			slug: proxySlug,
			name,
			description,
			visibility,
			connectionProviderId,
			connectionScope,
			connectionScopes,
		});
		proxyApp = result.app ?? null;
	}
	if (!proxyApp && !dryRun) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			"Failed to create proxy app",
		);
	}
	const proxySummary = {
		id: proxyApp?.id ?? null,
		organizationId: orgId,
		name: proxyApp?.name ?? name ?? catalogApp.name,
		slug: proxyApp?.slug ?? proxySlug,
		visibility: proxyApp?.visibility ?? visibility,
		sourceAppId: baseApp.id,
		catalogAppId: catalogApp.id,
	};
	const connectionSourceConfig = mcpConfigRecord(
		metadataRecord((proxyApp ?? baseApp).metadata),
	);
	const inheritedProviderId =
		typeof connectionSourceConfig.connectionProviderId === "string"
			? connectionSourceConfig.connectionProviderId
			: undefined;
	const inheritedScope =
		connectionSourceConfig.connectionScope === "tenant" ||
		connectionSourceConfig.connectionScope === "user" ||
		connectionSourceConfig.connectionScope === "hybrid"
			? connectionSourceConfig.connectionScope
			: undefined;
	const inheritedScopes = Array.isArray(connectionSourceConfig.connectionScopes)
		? connectionSourceConfig.connectionScopes.filter(
				(scope): scope is string => typeof scope === "string",
			)
		: undefined;
	const effectiveConnectionProviderId =
		connectionProviderId ?? inheritedProviderId;
	const effectiveConnectionScope = connectionScope ?? inheritedScope;
	const effectiveConnectionScopes = connectionScopes ?? inheritedScopes;
	const aggregateEntry = {
		slug: proxySummary.slug,
		...(proxySummary.id ? { appId: proxySummary.id } : {}),
		prefix: namespace,
		...(organizationQueryParam && organization?.slug
			? {
					forwardedQueryParams: {
						[organizationQueryParam]: organization.slug,
					},
				}
			: {}),
		...(effectiveConnectionProviderId
			? {
					connectionProviderId: effectiveConnectionProviderId,
				}
			: {}),
		...(effectiveConnectionScope
			? {
					connectionScope: effectiveConnectionScope,
				}
			: {}),
		...(effectiveConnectionScopes?.length
			? {
					connectionScopes: effectiveConnectionScopes,
				}
			: {}),
	};
	const metadata = metadataRecord(targetAggregator.metadata);
	const mcpConfig = mcpConfigRecord(metadata);
	const { entries: aggregateApps, attached } = upsertAggregateAppEntry(
		readAggregateApps(mcpConfig),
		aggregateEntry,
	);
	const nextMcpConfig: McpConfig = {
		...mcpConfig,
		aggregateApps,
		toolScopes: mergeNamespaceToolScopes(mcpConfig, namespace, toolScopes),
	};
	if (!dryRun) {
		if (proxyApp && connectionProviderId) {
			const proxyMetadata = metadataRecord(proxyApp.metadata);
			const proxyMcpConfig = mcpConfigRecord(proxyMetadata);
			await updateApp(db, proxyApp.id, {
				metadata: {
					...proxyMetadata,
					mcpConfig: {
						...proxyMcpConfig,
						authMode:
							typeof proxyMcpConfig.authMode === "string"
								? proxyMcpConfig.authMode
								: "authenticated",
						connectionProviderId,
						connectionScope:
							connectionScope ??
							(proxyMcpConfig.connectionScope as
								| "tenant"
								| "user"
								| "hybrid"
								| undefined) ??
							"tenant",
						...(connectionScopes?.length
							? {
									connectionScopes,
								}
							: {}),
					},
				},
				updatedAt: new Date().toISOString(),
			});
		}
		await updateApp(db, targetAggregator.id, {
			metadata: {
				...metadata,
				mcpConfig: nextMcpConfig,
			},
			updatedAt: new Date().toISOString(),
		});
		await purgeMcpAggregateCache(context.env, "tenant-catalog-install");
		const serviceBindingTediId =
			context.headers.get("X-Tedix-Tedi-Id") ??
			context.headers.get("x-tedix-tedi-id");
		const traceId = episodeTraceId(context.headers);
		const mcpExecutionId =
			context.headers.get("X-Tedix-Mcp-Execution-Id") ??
			context.headers.get("x-tedix-mcp-execution-id");
		const mcpToolId =
			context.headers.get("X-Tedix-Mcp-Tool-Id") ??
			context.headers.get("x-tedix-mcp-tool-id");
		const actor =
			context.authType === "service-binding"
				? {
						actorId: serviceBindingTediId ?? "service-binding",
						actorType: serviceBindingTediId
							? ("tedi" as const)
							: ("service" as const),
						actorMetadata: {
							source: context.authType,
							tediId: serviceBindingTediId,
							delegatedBy: "service-binding",
						},
					}
				: auditActor(context);
		await emitAuditEvent(db, {
			organizationId: orgId,
			actorId: actor.actorId,
			actorType: actor.actorType,
			action: "catalog.tenant_mcp_app.installed",
			resourceType: "app",
			resourceId: targetAggregator.id,
			metadata: {
				...actor.actorMetadata,
				catalogAppId: catalogApp.id,
				catalogAppSlug: catalogApp.slug,
				baseAppId: baseApp.id,
				baseAppSlug: baseApp.slug,
				materializedBaseApp,
				proxyAppId: proxyApp?.id,
				proxyAppSlug: proxySummary.slug,
				aggregateEntry,
				toolScopes,
				traceId,
				mcpExecutionId,
				mcpToolId,
				hostAppId,
				hostAppSlug,
			},
			ipAddress: context.headers.get("CF-Connecting-IP"),
			userAgent: context.headers.get("User-Agent"),
		});
	}

	// Hand-off: installing wires the proxy + provider binding, but an OAuth
	// provider needs a one-time HUMAN consent before its tools resolve a
	// credential — the install cannot mint that (authorization_code requires the
	// resource owner). So an operator that installs an unconnected app leaves a
	// dead namespace with no signal. Detect a missing TENANT credential (for
	// tenant/hybrid-scoped providers) and return the exact hand-off URL: a
	// deep-link to the connections page's Connect button, NOT a pre-minted
	// authorize URL. The button does `sdk.outbound.connect(..., tenantLevel:true)`
	// in the human's session → a TENANT-scoped grant directly; a server-minted
	// mgmt-endpoint URL is user-scoped (tenantId is dropped) and would need a
	// separate promote step. The deep-link IS the button, so it matches exactly.
	let requiresConnection = false;
	let connectUrl: string | null = null;
	let connectionMessage: string | null = null;
	const bindProviderId = aggregateEntry.connectionProviderId;
	const bindScope = aggregateEntry.connectionScope;
	if (bindProviderId && (bindScope === "tenant" || bindScope === "hybrid")) {
		const org = await getOrganizationById(context.db, orgId);
		let tenantConnected = false;
		if (org?.descopeTenantId && context.env.DESCOPE_MANAGEMENT_KEY) {
			try {
				const { getManagementClient } = await import("@tedix/auth/client");
				const { fetchTenantConnectionToken } =
					await import("@tedix/auth/connections");
				const descopeClient = getManagementClient({
					DESCOPE_PROJECT_ID: context.env.DESCOPE_PROJECT_ID,
					DESCOPE_MANAGEMENT_KEY: context.env.DESCOPE_MANAGEMENT_KEY,
					DESCOPE_BASE_URL: context.env.DESCOPE_BASE_URL,
				});
				const token = await fetchTenantConnectionToken(
					descopeClient,
					bindProviderId,
					org.descopeTenantId,
				);
				tenantConnected = Boolean(token);
			} catch {
				// Treat a lookup failure as "unknown" — surface the hand-off rather
				// than silently claiming it's connected.
				tenantConnected = false;
			}
		}
		if (!tenantConnected && org?.slug) {
			requiresConnection = true;
			connectUrl = tenantConnectionHandoffUrl({
				environment: context.env.ENVIRONMENT,
				organizationSlug: org.slug,
				providerId: bindProviderId,
			});
			connectionMessage = `${catalogApp.name} is installed but needs a one-time connection before its tools work. Open ${connectUrl} and click Connect under Organization connections to authorize it for this tenant.`;
		}
	}
	return {
		dryRun,
		created: !existingProxy,
		attached,
		requiresConnection,
		connectUrl,
		connectionMessage,
		proxyApp: proxySummary,
		targetAggregator: {
			id: targetAggregator.id,
			slug: targetAggregator.slug,
			organizationId: targetAggregator.organizationId,
		},
		baseApp: {
			id: baseApp.id,
			slug: baseApp.slug,
			name: baseApp.name,
		},
		catalogApp: {
			id: catalogApp.id,
			slug: catalogApp.slug ?? catalogApp.id,
			name: catalogApp.name,
		},
		aggregateEntry,
		toolScopes,
		summary: dryRun
			? `Dry run: would ${existingProxy ? "reuse" : "create"} proxy "${proxySummary.slug}" and ${attached ? "attach it to" : "refresh it in"} "${targetAggregator.slug}".`
			: `${existingProxy ? "Reused" : "Created"} proxy "${proxySummary.slug}" and ${attached ? "attached it to" : "refreshed it in"} "${targetAggregator.slug}".`,
	};
}

function catalogQuerySlug(query: string): string {
	return query
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

type CatalogInstallCandidate = {
	keywordsForDiscovery: string[] | null;
	keywordsForTriggering: string[] | null;
};

/**
 * Prefer an operator-maintained exact catalog alias over broad prose matches.
 * A query such as "outlook" can occur incidentally in many descriptions; the
 * canonical Microsoft entry declares it as a discovery keyword and must win
 * even when the lexical SQL rank places a generic prose hit first.
 */
export function selectCatalogInstallCandidate<
	T extends CatalogInstallCandidate,
>(query: string, candidates: readonly T[]): T | null {
	const normalizedQuery = query.trim().toLowerCase();
	const exactAlias = candidates.find((candidate) =>
		[
			...(candidate.keywordsForDiscovery ?? []),
			...(candidate.keywordsForTriggering ?? []),
		].some((keyword) => keyword.trim().toLowerCase() === normalizedQuery),
	);
	return exactAlias ?? candidates[0] ?? null;
}

async function resolveCatalogInstallQuery(
	db: BaseContext["db"],
	query: string,
) {
	const exact = await getCatalogAppBySlug(db, catalogQuerySlug(query));
	if (exact) return exact;
	const { apps } = await listCatalogApps(db, {
		search: query,
		sortBy: "relevance",
		limit: 25,
		offset: 0,
	});
	return selectCatalogInstallCandidate(query, apps);
}

function installBlockReason(error: unknown): string {
	if (error instanceof Error && error.message.trim()) return error.message;
	return "This catalog app could not be installed.";
}

/**
 * Resolve product-language catalog queries and install every prepared result.
 * Each entry is preflighted before its mutation so an unprepared app produces a
 * precise per-app blocker without preventing independent ready apps.
 */
export async function installTenantMcpAppsFromCatalog(
	context: BaseContext,
	input: InstallTenantMcpAppsInput,
): Promise<InstallTenantMcpAppsOutput> {
	const queries = [
		...new Map(
			input.catalogAppQueries.map((query) => [
				query.trim().toLowerCase(),
				query,
			]),
		).values(),
	];
	const results: InstallTenantMcpAppsOutput["results"] = [];

	for (const query of queries) {
		const catalogApp = await resolveCatalogInstallQuery(context.db, query);
		if (!catalogApp) {
			results.push({
				query,
				status: "not_found",
				catalogAppId: null,
				catalogAppSlug: null,
				catalogAppName: null,
				proxySlug: null,
				requiresConnection: false,
				connectUrl: null,
				reason: `No released catalog app matched "${query}".`,
			});
			continue;
		}

		try {
			const result = await installTenantMcpAppFromCatalog(context, {
				catalogAppId: catalogApp.id,
				targetAggregatorSlug: input.targetAggregatorSlug,
				visibility: "private",
				toolScopes: ["mcp:content.write"],
				dryRun: input.dryRun,
			});
			results.push({
				query,
				status: input.dryRun ? "would_install" : "installed",
				catalogAppId: result.catalogApp.id,
				catalogAppSlug: result.catalogApp.slug,
				catalogAppName: result.catalogApp.name,
				proxySlug: result.proxyApp.slug,
				requiresConnection: result.requiresConnection ?? false,
				connectUrl: result.connectUrl ?? null,
				reason: result.connectionMessage ?? null,
			});
		} catch (error) {
			results.push({
				query,
				status: "blocked",
				catalogAppId: catalogApp.id,
				catalogAppSlug: catalogApp.slug,
				catalogAppName: catalogApp.name,
				proxySlug: null,
				requiresConnection: false,
				connectUrl: null,
				reason: installBlockReason(error),
			});
		}
	}

	const installedCount = results.filter((result) =>
		input.dryRun
			? result.status === "would_install"
			: result.status === "installed",
	).length;
	const blockedCount = results.length - installedCount;
	const action = input.dryRun ? "ready to install" : "installed";
	return {
		dryRun: input.dryRun,
		installedCount,
		blockedCount,
		results,
		summary: `${installedCount} catalog app${installedCount === 1 ? "" : "s"} ${action}; ${blockedCount} blocked or not found.`,
	};
}

export async function uninstallTenantMcpAppFromAggregator(
	context: BaseContext,
	input: UninstallTenantMcpAppInput,
): Promise<UninstallTenantMcpAppOutput> {
	const { orgId, targetAggregator } = await resolveTenantMcpTargetAggregator(
		context,
		input.targetAggregatorSlug,
	);
	const slug = input.slug?.toLowerCase();
	const metadata = metadataRecord(targetAggregator.metadata);
	const mcpConfig = mcpConfigRecord(metadata);
	// Resolve the slug to the org's app so an entry linked by id still matches
	// after that app was renamed.
	const linkedApp = slug
		? await getAppBySlugForOrg(context.db, slug, orgId)
		: null;
	const { aggregateEntry, remainingAggregateApps } = detachAggregateAppEntries(
		readAggregateApps(mcpConfig),
		{ appId: linkedApp?.id, slug, prefix: input.prefix },
	);
	const scopeKeys = aggregateEntry
		? [
				aggregateEntry.prefix,
				input.prefix,
				sanitizeNamespace(aggregateEntry.slug),
				aggregateEntry.slug,
			].filter((value): value is string => typeof value === "string")
		: [];
	const { toolScopes, removedKeys } =
		input.removeToolScopes && aggregateEntry
			? removeNamespaceToolScopes(mcpConfig, scopeKeys)
			: {
					toolScopes: readNamespaceToolScopes(mcpConfig),
					removedKeys: [],
				};
	if (aggregateEntry && !input.dryRun) {
		await updateApp(context.db, targetAggregator.id, {
			metadata: {
				...metadata,
				mcpConfig: {
					...mcpConfig,
					aggregateApps: remainingAggregateApps,
					toolScopes,
				},
			},
			updatedAt: new Date().toISOString(),
		});
		await purgeMcpAggregateCache(context.env, "tenant-catalog-uninstall");
		const serviceBindingTediId =
			context.headers.get("X-Tedix-Tedi-Id") ??
			context.headers.get("x-tedix-tedi-id");
		const traceId = episodeTraceId(context.headers);
		const mcpExecutionId =
			context.headers.get("X-Tedix-Mcp-Execution-Id") ??
			context.headers.get("x-tedix-mcp-execution-id");
		const mcpToolId =
			context.headers.get("X-Tedix-Mcp-Tool-Id") ??
			context.headers.get("x-tedix-mcp-tool-id");
		const actor =
			context.authType === "service-binding"
				? {
						actorId: serviceBindingTediId ?? "service-binding",
						actorType: serviceBindingTediId
							? ("tedi" as const)
							: ("service" as const),
						actorMetadata: {
							source: context.authType,
							tediId: serviceBindingTediId,
							delegatedBy: "service-binding",
						},
					}
				: auditActor(context);
		await emitAuditEvent(context.db, {
			organizationId: orgId,
			actorId: actor.actorId,
			actorType: actor.actorType,
			action: "catalog.tenant_mcp_app.uninstalled",
			resourceType: "app",
			resourceId: targetAggregator.id,
			metadata: {
				...actor.actorMetadata,
				aggregateEntry,
				removedToolScopeKeys: removedKeys,
				traceId,
				mcpExecutionId,
				mcpToolId,
			},
			ipAddress: context.headers.get("CF-Connecting-IP"),
			userAgent: context.headers.get("User-Agent"),
		});
	}
	return {
		dryRun: input.dryRun,
		detached: Boolean(aggregateEntry),
		targetAggregator: {
			id: targetAggregator.id,
			slug: targetAggregator.slug,
			organizationId: targetAggregator.organizationId,
		},
		aggregateEntry,
		removedToolScopeKeys: removedKeys,
		remainingAggregateApps,
		summary: aggregateEntry
			? input.dryRun
				? `Dry run: would detach "${aggregateEntry.slug}" from "${targetAggregator.slug}".`
				: `Detached "${aggregateEntry.slug}" from "${targetAggregator.slug}".`
			: `No matching aggregate app was installed on "${targetAggregator.slug}".`,
	};
}

export function parseOpenApiSpecText(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed) {
		throw createError(ErrorCodes.BAD_REQUEST, "specText must not be empty");
	}
	try {
		return trimmed.startsWith("{") || trimmed.startsWith("[")
			? JSON.parse(trimmed)
			: parseYaml(trimmed);
	} catch (error) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			`Failed to parse OpenAPI specText: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export function parseOpenApiSpecJson(text: string): OpenApiImportInput["spec"] {
	return JsonValueSchema.parse(parseOpenApiSpecText(text));
}

export function sanitizeConnectionProviderIdPart(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export function generatedTenantOpenApiProviderId(input: {
	appSlug: string;
	tenantSuffix: string;
	type: "oauth" | "api_key";
}): string {
	const suffix = sanitizeConnectionProviderIdPart(input.tenantSuffix) || "org";
	const kind = input.type === "oauth" ? "oauth" : "key";
	const maxDescopeAppIdLength = 30;
	const suffixAndKind = input.type === "oauth" ? `-${suffix}-${kind}` : "-key";
	const appIdBudget = Math.max(1, maxDescopeAppIdLength - suffixAndKind.length);
	const appIdPart =
		sanitizeConnectionProviderIdPart(input.appSlug)
			.slice(0, appIdBudget)
			.replace(/[-_]+$/g, "") || "openapi";
	const providerId = `${appIdPart}${suffixAndKind}`;
	return (
		providerId.slice(0, maxDescopeAppIdLength).replace(/[-_]+$/g, "") ||
		`${kind}-provider`
	);
}

export type TenantOpenApiConnectionProviderPlan = {
	id: string;
	name: string;
	type: "oauth" | "api_key";
	config: ConnectionProviderConfig;
};

export function defaultTenantOpenApiCredentialProfile(input: {
	name: string;
	authHeader?: string;
	authTemplate?: string;
	authEncoding?: "base64";
	authScopes?: string[];
	type: "oauth" | "api_key";
	credentialProfile?: ConnectionCredentialProfile;
}): ConnectionCredentialProfile {
	const existing = input.credentialProfile ?? {};
	const authHeader = existing.authHeader ?? input.authHeader ?? "Authorization";
	const authTemplate =
		existing.authTemplate ?? input.authTemplate ?? "Bearer {token}";
	return {
		...(input.type === "api_key"
			? {
					inputFields: existing.inputFields ?? [
						{
							name: "apiKey",
							label: `${input.name} key`,
							type: "password" as const,
							required: true,
						},
					],
					tokenTemplate: existing.tokenTemplate ?? "{apiKey}",
				}
			: {}),
		...existing,
		authHeader,
		authTemplate,
		authEncoding: existing.authEncoding ?? input.authEncoding,
		defaultScopes:
			existing.defaultScopes ??
			(input.authScopes?.length ? input.authScopes : undefined),
		helpText:
			existing.helpText ??
			`Store a tenant-scoped credential for generated ${input.name} OpenAPI tools.`,
	};
}

export function tenantOpenApiConnectionProviderPlan(
	input: CreateTenantOpenApiMcpAppInput,
	appSlug: string,
	tenantSuffix: string,
): TenantOpenApiConnectionProviderPlan | null {
	if (input.connectionProviderId) return null;
	const shouldProvision =
		Boolean(input.connectionProvider) ||
		Boolean(input.authHeader) ||
		Boolean(input.authTemplate) ||
		Boolean(input.authScopes?.length);
	if (!shouldProvision) return null;
	const provider = input.connectionProvider;
	const type = provider?.type ?? "api_key";
	const id =
		provider?.id ??
		generatedTenantOpenApiProviderId({
			appSlug,
			tenantSuffix,
			type,
		});
	const name = provider?.name ?? `${input.name} Credentials`;
	const credentialProfile = defaultTenantOpenApiCredentialProfile({
		name: input.name,
		authHeader: input.authHeader,
		authTemplate: input.authTemplate,
		authEncoding: input.authEncoding,
		authScopes: input.authScopes,
		type,
		credentialProfile: provider?.credentialProfile,
	});
	return {
		id,
		name,
		type,
		config: {
			name,
			type,
			description:
				provider?.description ??
				`Credentials for the ${input.name} tenant-owned OpenAPI app.`,
			logo: provider?.logo ?? input.logoUrl,
			clientId: provider?.clientId,
			clientSecret: provider?.clientSecret,
			authorizationUrl: provider?.authorizationUrl,
			authorizationUrlParams: provider?.authorizationUrlParams,
			tokenUrl: provider?.tokenUrl,
			tokenUrlParams: provider?.tokenUrlParams,
			revocationUrl: provider?.revocationUrl,
			discoveryUrl: provider?.discoveryUrl,
			pkce: provider?.pkce,
			defaultScopes:
				provider?.defaultScopes ??
				credentialProfile.defaultScopes ??
				input.authScopes,
			defaultRedirectUrl: provider?.defaultRedirectUrl,
			callbackDomain: provider?.callbackDomain,
			accessType: provider?.accessType,
			prompt: provider?.prompt,
			useDcr: provider?.useDcr,
			dcrUrl: provider?.dcrUrl,
			credentialProfile,
		},
	};
}

export type TenantOpenApiImportOverrides = Partial<
	Pick<
		OpenApiImportInput,
		| "connectionProviderId"
		| "authHeader"
		| "authTemplate"
		| "authEncoding"
		| "authScopes"
	>
>;

export async function resolveTenantMcpTargetAggregator(
	context: BaseContext,
	targetAggregatorSlug: string,
) {
	const {
		appId: hostAppId,
		appOrgId: hostAppOrgId,
		appSlug: hostAppSlug,
	} = getTrustedMcpHostAppContext(context);
	const orgId = hostAppOrgId ?? context.organizationId;
	if (!orgId) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Organization context required to create a tenant OpenAPI MCP app",
		);
	}
	const targetAggregator = await getAppBySlugForOrg(
		context.db,
		targetAggregatorSlug,
		orgId,
	);
	if (!targetAggregator) {
		throw createError(ErrorCodes.NOT_FOUND, "Target aggregator app not found");
	}
	if (
		hostAppId &&
		targetAggregator.id !== hostAppId &&
		targetAggregator.slug !== hostAppSlug
	) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Target aggregator must be the MCP host app",
		);
	}
	if (targetAggregator.organizationId !== orgId) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Target aggregator must belong to the caller's organization",
		);
	}
	return {
		orgId,
		targetAggregator,
	};
}

export function openApiSyncMetadataFromInput(
	input: OpenApiImportInput,
	existingMetadata: unknown,
	credentialProfile?: ConnectionCredentialProfile,
): Record<string, unknown> {
	const metadata = metadataRecord(existingMetadata);
	const mcpConfig = mcpConfigRecord(metadata);
	const nextMcpConfig = {
		...mcpConfig,
	};
	delete nextMcpConfig.connectionLabel;
	return {
		...metadata,
		mcpConfig: {
			...nextMcpConfig,
			authMode:
				typeof nextMcpConfig.authMode === "string"
					? nextMcpConfig.authMode
					: "authenticated",
			openApiSync: {
				enabled: true,
				spec: input.spec,
				specUrl: input.specUrl,
				baseUrl: input.baseUrl,
				namespace: input.namespace,
				connectionProviderId: input.connectionProviderId,
				connectionScope: input.connectionScope ?? "tenant",
				authScopes: input.authScopes,
				authHeader: input.authHeader,
				authTemplate: input.authTemplate,
				authEncoding: input.authEncoding,
				staticHeaders: input.staticHeaders,
				includeOperationIds: input.includeOperationIds,
				includePathPrefixes: input.includePathPrefixes,
				excludePathPrefixes: input.excludePathPrefixes,
				stripPathPrefixes: input.stripPathPrefixes,
				widgetDefaults: input.widgetDefaults,
				widgetOverrides: input.widgetOverrides,
				replaceExisting: input.replaceExisting !== false,
				...(credentialProfile
					? {
							credentialProfile,
						}
					: {}),
			},
			...(input.connectionProviderId && credentialProfile
				? {
						credentialProfile,
					}
				: {}),
		},
	};
}

export function tenantOpenApiImportInput(
	input: CreateTenantOpenApiMcpAppInput,
	appId: string,
	namespace: string,
	overrides: TenantOpenApiImportOverrides = {},
): OpenApiImportInput {
	const specFromText =
		input.specText ?? (typeof input.spec === "string" ? input.spec : undefined);
	const spec = specFromText ? parseOpenApiSpecJson(specFromText) : input.spec;
	const credentialProfile =
		input.connectionProvider?.credentialProfile ?? undefined;
	return {
		appId,
		specUrl: input.specUrl,
		spec,
		baseUrl: input.baseUrl,
		namespace: input.namespace ?? input.prefix ?? namespace,
		connectionProviderId:
			overrides.connectionProviderId ?? input.connectionProviderId,
		connectionScope: input.connectionScope ?? "tenant",
		authScopes:
			overrides.authScopes ??
			input.authScopes ??
			credentialProfile?.defaultScopes,
		authHeader:
			overrides.authHeader ?? input.authHeader ?? credentialProfile?.authHeader,
		authTemplate:
			overrides.authTemplate ??
			input.authTemplate ??
			credentialProfile?.authTemplate,
		authEncoding:
			overrides.authEncoding ??
			input.authEncoding ??
			credentialProfile?.authEncoding,
		staticHeaders: input.staticHeaders,
		includeOperationIds: input.includeOperationIds,
		includePathPrefixes: input.includePathPrefixes,
		excludePathPrefixes: input.excludePathPrefixes,
		stripPathPrefixes: input.stripPathPrefixes,
		widgetDefaults: input.widgetDefaults,
		widgetOverrides: input.widgetOverrides,
		replaceExisting: input.replaceExisting,
		dryRun: false,
	};
}

export // =============================================================================
// TEMPLATE PROPAGATION
// =============================================================================

/**
 * Catalog-driven app_tools rewrites can add/remove/change tool rows, the
 * derived ui:// widget resources, and prompt-type rows in one pass, so
 * affected apps get all three list_changed notifications.
 */
const CATALOG_APP_INVENTORY_METHODS = [
	"notifications/tools/list_changed",
	"notifications/prompts/list_changed",
	"notifications/resources/list_changed",
] as const;

export const PROPAGATION_MUTATING_ACTIONS = new Set([
	"created",
	"updated_schema",
	"updated_description",
	"updated_metadata",
]);

/** Distinct fork app ids actually mutated by a (non-dry-run) propagation. */

export /** Distinct fork app ids actually mutated by a (non-dry-run) propagation. */
function propagationChangedAppIds(
	result: Awaited<ReturnType<typeof propagateTools>>,
): string[] {
	if (result.dryRun) return [];
	return [
		...new Set(
			result.results
				.filter((item) => PROPAGATION_MUTATING_ACTIONS.has(item.action))
				.map((item) => item.targetAppId),
		),
	];
}

/**
 * Propagate tools from a base app to explicit custom forks.
 * POST /catalog/propagate-tools
 *
 * NOTE: Do not target tenant/project proxy apps. Proxies keep zero app_tools rows
 * and inherit through aggregateApps.
 */

export function isCmsControlMcpEndpoint(
	endpoint: string | null | undefined,
): boolean {
	if (!endpoint) return false;
	try {
		const url = new URL(endpoint);
		return (
			url.protocol === "https:" &&
			url.hostname === "builder.tedix.dev" &&
			url.pathname.replace(/\/+$/, "") === "/mcp"
		);
	} catch {
		return false;
	}
}

export function resolveTedixInternalScanHeaders(
	catalogApp: CatalogAppRecord,
	env: CloudflareEnv,
	endpointOverride?: string | null,
): Record<string, string> | undefined {
	const endpoint =
		endpointOverride ?? catalogApp.mcpEndpointNormalized ?? catalogApp.baseUrl;
	const token = (
		env as CloudflareEnv & {
			PLATFORM_SERVICE_TOKEN?: string;
		}
	).PLATFORM_SERVICE_TOKEN;
	return resolveFirstPartyScanHeaders({
		endpoint,
		platformServiceToken: token,
	});
}

export function resolveCatalogScanFetchFn(
	context: BaseContext,
	endpoint: string,
): ((url: string, init?: RequestInit) => Promise<Response>) | undefined {
	if (!isCmsControlMcpEndpoint(endpoint)) return undefined;
	const fetcher = (
		context.env as CloudflareEnv & {
			CMS?: ServiceBindingFetcher;
		}
	).CMS;
	return fetcher ? serviceBindingFetchFn(fetcher) : undefined;
}

export async function resolveCatalogScanHeaders(
	context: BaseContext,
	catalogApp: CatalogAppRecord,
	endpointOverride?: string | null,
): Promise<Record<string, string> | undefined> {
	const { db } = context;
	let lookupFailure: ConnectionTokenLookupError | undefined;
	if (catalogApp.scanConnectionId && catalogApp.scanOrganizationId) {
		const connectionId = catalogApp.scanConnectionId;
		const header = catalogApp.scanConnectionHeader || "Authorization";
		const template = catalogApp.scanConnectionTemplate || "{token}";
		let resolvedToken: string | undefined;
		if (context.env.DESCOPE_MANAGEMENT_KEY) {
			const { getManagementClient } = await import("@tedix/auth/client");
			const { fetchConnectionToken, fetchTenantConnectionToken } =
				await import("@tedix/auth/connections");
			const { getMembersByOrganization } =
				await import("@tedix/db/queries/organization-members");
			const { getOrganizationById } =
				await import("@tedix/db/queries/organizations");
			const descopeClient = getManagementClient({
				DESCOPE_PROJECT_ID: context.env.DESCOPE_PROJECT_ID,
				DESCOPE_MANAGEMENT_KEY: context.env.DESCOPE_MANAGEMENT_KEY,
				DESCOPE_BASE_URL: context.env.DESCOPE_BASE_URL,
			});
			const org = await getOrganizationById(db, catalogApp.scanOrganizationId);
			const owners = await getMembersByOrganization(
				db,
				catalogApp.scanOrganizationId,
				{
					role: "owner",
					status: "active",
					limit: 3,
				},
			);
			const admins =
				owners.length === 0
					? await getMembersByOrganization(db, catalogApp.scanOrganizationId, {
							role: "admin",
							status: "active",
							limit: 3,
						})
					: [];
			for (const member of [...owners, ...admins]) {
				try {
					const userResult = await fetchConnectionToken(
						descopeClient,
						connectionId,
						member.descopeUserId,
					);
					if (userResult?.accessToken) {
						resolvedToken = userResult.accessToken;
						break;
					}
				} catch (error) {
					lookupFailure =
						error instanceof ConnectionTokenLookupError
							? error
							: new ConnectionTokenLookupError();
				}
			}
			if (!resolvedToken && org?.descopeTenantId) {
				try {
					const tenantResult = await fetchTenantConnectionToken(
						descopeClient,
						connectionId,
						org.descopeTenantId,
					);
					resolvedToken = tenantResult?.accessToken;
				} catch (error) {
					lookupFailure =
						error instanceof ConnectionTokenLookupError
							? error
							: new ConnectionTokenLookupError();
				}
			}
		}
		if (resolvedToken) {
			return {
				[header]: template.replace("{token}", resolvedToken),
			};
		}
	}
	if (catalogApp.scanAuthHeaders && context.env.SECRETS_MASTER_KEY) {
		try {
			const { decryptCatalogAppSecret } =
				await import("@tedix/db/utils/secrets-encryption");
			const decrypted = await decryptCatalogAppSecret(
				context.env.SECRETS_MASTER_KEY,
				catalogApp.id,
				catalogApp.scanAuthHeaders,
			);
			return JSON.parse(decrypted) as Record<string, string>;
		} catch (error) {
			console.warn(
				`[Catalog] Failed to decrypt scan auth headers for ${catalogApp.slug ?? catalogApp.id}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	const internalHeaders = resolveTedixInternalScanHeaders(
		catalogApp,
		context.env,
		endpointOverride,
	);
	if (internalHeaders) return internalHeaders;
	if (lookupFailure)
		throw createError(ErrorCodes.SERVICE_UNAVAILABLE, lookupFailure.message);
	return undefined;
}

export async function scanUpstreamCatalogAppNow(
	context: BaseContext,
	catalogApp: CatalogAppRecord,
	mcpServerUrl: string,
): Promise<{
	addedTools: number;
	changedTools: number;
	removedTools: number;
	resourceCount: number;
	resourceTemplateCount: number;
	promptCount: number;
	healthStatus: string;
	driftReportSaved: boolean;
}> {
	const { db } = context;
	const { connectMcpServer } = await import("../../../lib/mcp-client");
	const { insertCatalogHealthHistory } =
		await import("@tedix/db/queries/catalog/health-history");
	const { updateCatalogAppScanAuth } =
		await import("@tedix/db/queries/catalog/get-app");
	const headers = await resolveCatalogScanHeaders(
		context,
		catalogApp,
		mcpServerUrl,
	);
	const result = await connectMcpServer(mcpServerUrl, {
		timeout: 30000,
		headers,
		fetchFn: resolveCatalogScanFetchFn(context, mcpServerUrl),
	});
	const now = new Date().toISOString();
	const serverInfo = result.serverInfo;
	const diagnostics =
		result.success && serverInfo
			? classifySuccessfulMcpScan({
					partialAuth: result.partialAuth,
					listsTruncated: serverInfo.listsTruncated,
					connectTimeMs: result.connectTimeMs,
					methodErrors: serverInfo.methodErrors,
					toolCount: serverInfo.tools.length,
					resourceCount: serverInfo.resources.length,
					resourceTemplateCount: serverInfo.resourceTemplates.length,
					promptCount: serverInfo.prompts.length,
					skillCount: serverInfo.skills.length,
				})
			: null;
	const healthStatus = result.success
		? (diagnostics?.status ?? "degraded")
		: result.requiresAuth
			? "requires_auth"
			: "unhealthy";
	const listIsAuthoritative = (
		list: "tools" | "resources" | "resourceTemplates" | "prompts",
	) =>
		result.success &&
		isScanListAuthoritative(healthStatus, list, serverInfo?.listsTruncated);
	const toolSync =
		serverInfo?.tools !== undefined && listIsAuthoritative("tools")
			? await syncCatalogMcpTools(db, catalogApp.id, serverInfo.tools)
			: {
					added: 0,
					updated: 0,
					removed: 0,
					drifts: [],
				};
	if (serverInfo) {
		const resourceSync = listIsAuthoritative("resources")
			? await syncCatalogMcpResources(
					db,
					catalogApp.id,
					serverInfo.resources?.map((resource) => ({
						...resource,
						_meta:
							resource._meta === undefined
								? undefined
								: toJsonRecord(resource._meta),
					})) ?? [],
				)
			: { added: 0, updated: 0, removed: 0 };
		const templateSync = listIsAuthoritative("resourceTemplates")
			? await syncCatalogMcpResourceTemplates(
					db,
					catalogApp.id,
					serverInfo.resourceTemplates?.map((template) => ({
						...template,
						_meta:
							template._meta === undefined
								? undefined
								: toJsonRecord(template._meta),
					})) ?? [],
				)
			: { added: 0, updated: 0, removed: 0 };
		const promptSync = listIsAuthoritative("prompts")
			? await syncCatalogMcpPrompts(db, catalogApp.id, serverInfo.prompts ?? [])
			: { added: 0, updated: 0, removed: 0 };
		// SEP-2640 permits an empty or partial skills/list independently of
		// cursor exhaustion. Upsert observed entries only; omission never removes.
		await syncCatalogMcpSkills(
			db,
			catalogApp.id,
			serverInfo.skills.map((skill) => ({
				skillUri: skill.uri,
				frontmatter: toJsonRecord(skill.frontmatter),
				resources: skill.resources,
			})),
		);
		context.waitUntil?.(
			publishMcpCatalogInventoryEvents({
				db,
				env: context.env,
				catalogAppId: catalogApp.id,
				resourceListChanged:
					resourceSync.added > 0 ||
					resourceSync.updated > 0 ||
					resourceSync.removed > 0 ||
					templateSync.added > 0 ||
					templateSync.updated > 0 ||
					templateSync.removed > 0,
				promptListChanged:
					promptSync.added > 0 ||
					promptSync.updated > 0 ||
					promptSync.removed > 0,
			}),
		);
	}
	const driftReportSaved = toolSync.drifts.length > 0;
	if (driftReportSaved) {
		const parts: string[] = [];
		if (toolSync.added) parts.push(`${toolSync.added} added`);
		if (toolSync.removed) parts.push(`${toolSync.removed} removed`);
		if (toolSync.updated) parts.push(`${toolSync.updated} changed`);
		await saveDriftReport(db, {
			catalogAppId: catalogApp.id,
			catalogAppName: catalogApp.name,
			addedTools: toolSync.added,
			removedTools: toolSync.removed,
			changedTools: toolSync.updated,
			drifts: toolSync.drifts,
			summary: `Drift detected for ${catalogApp.name}: ${parts.join(", ")}`,
		});
	} else if (listIsAuthoritative("tools")) {
		await resolveDriftReport(db, catalogApp.id);
	}
	await updateCatalogAppHealthMetrics(db, catalogApp.id, {
		checkedAt: now,
		status: healthStatus as
			| "healthy"
			| "degraded"
			| "requires_auth"
			| "unhealthy",
		connectTimeMs: result.connectTimeMs,
		totalTimeMs: result.totalTimeMs,
		transportUsed: result.transport,
		serverVersion: serverInfo?.version,
		toolCount: listIsAuthoritative("tools")
			? serverInfo?.tools.length
			: undefined,
		resourceCount: listIsAuthoritative("resources")
			? serverInfo?.resources.length
			: undefined,
		promptCount: listIsAuthoritative("prompts")
			? serverInfo?.prompts.length
			: undefined,
		capabilities: serverInfo?.capabilities as
			| Record<string, unknown>
			| undefined,
		instructions: serverInfo?.instructions,
		errorMessage: result.error,
		authState: result.requiresAuth ? "required" : "none",
	});
	await insertCatalogHealthHistory(db, {
		catalogAppId: catalogApp.id,
		checkedAt: now,
		status: healthStatus as
			| "healthy"
			| "degraded"
			| "requires_auth"
			| "unhealthy",
		connectTimeMs: result.connectTimeMs,
		totalTimeMs: result.totalTimeMs,
		transportUsed: result.transport,
		serverVersion: serverInfo?.version ?? null,
		toolCount: listIsAuthoritative("tools")
			? (serverInfo?.tools.length ?? null)
			: null,
		resourceCount: listIsAuthoritative("resources")
			? (serverInfo?.resources.length ?? null)
			: null,
		promptCount: listIsAuthoritative("prompts")
			? (serverInfo?.prompts.length ?? null)
			: null,
		errorMessage: result.error ?? null,
		authState: result.requiresAuth ? "required" : "none",
	});
	if (
		headers &&
		catalogApp.scanConnectionId &&
		context.env.SECRETS_MASTER_KEY
	) {
		try {
			const { encryptCatalogAppSecret } =
				await import("@tedix/db/utils/secrets-encryption");
			const encrypted = await encryptCatalogAppSecret(
				context.env.SECRETS_MASTER_KEY,
				catalogApp.id,
				JSON.stringify(headers),
			);
			await updateCatalogAppScanAuth(db, catalogApp.id, encrypted);
		} catch {
			// Snapshot refresh is best-effort.
		}
	}
	return {
		addedTools: toolSync.added,
		changedTools: toolSync.updated,
		removedTools: toolSync.removed,
		resourceCount: serverInfo?.resources.length ?? 0,
		resourceTemplateCount: serverInfo?.resourceTemplates.length ?? 0,
		promptCount: serverInfo?.prompts.length ?? 0,
		healthStatus,
		driftReportSaved,
	};
}

export // =============================================================================
// CLAUDE REGISTRY SYNC
// =============================================================================

const CLAUDE_REGISTRY_BASE =
	"https://api.anthropic.com/mcp-registry/v0/servers?version=latest&limit=100&visibility=commercial";

/**
 * Fetch all servers from Claude MCP Registry with pagination.
 * The API uses `.metadata.nextCursor` for pagination (max 100 per page).
 */

/**
 * Fetch all servers from Claude MCP Registry with pagination.
 * The API uses `.metadata.nextCursor` for pagination (max 100 per page).
 */
export async function fetchClaudeRegistry(): Promise<{
	servers: unknown[];
	error?: string;
}> {
	const allServers: unknown[] = [];
	let cursor: string | undefined;
	const maxPages = 10; // safety limit

	for (let page = 0; page < maxPages; page++) {
		const url = cursor
			? `${CLAUDE_REGISTRY_BASE}&cursor=${encodeURIComponent(cursor)}`
			: CLAUDE_REGISTRY_BASE;
		const response = await fetch(url);
		if (!response.ok) {
			return {
				servers: allServers,
				error: `Claude Registry API returned ${response.status} on page ${page + 1}`,
			};
		}
		const data = (await response.json()) as {
			servers: unknown[];
			metadata?: {
				nextCursor?: string;
				count?: number;
			};
		};
		if (data.servers) {
			allServers.push(...data.servers);
		}
		cursor = data.metadata?.nextCursor ?? undefined;
		if (!cursor) break;
	}
	return {
		servers: allServers,
	};
}

/**
 * Shared Claude MCP Registry sync logic.
 * Fetches Claude's public registry, saves to R2, and triggers a sync workflow.
 * Used by both `syncClaudeRegistry` and `triggerSync` (with source="claude").
 */

export /**
 * Shared Claude MCP Registry sync logic.
 * Fetches Claude's public registry, saves to R2, and triggers a sync workflow.
 * Used by both `syncClaudeRegistry` and `triggerSync` (with source="claude").
 */
async function runClaudeRegistrySync(
	db: Parameters<typeof createAppCatalogSyncLog>[0],
	env: CloudflareEnv,
): Promise<{
	success: boolean;
	serverCount: number;
	syncLogId?: string;
	workflowInstanceId?: string;
	message: string;
}> {
	// 1. Fetch Claude MCP Registry API (public, no auth, paginated)
	const { servers, error } = await fetchClaudeRegistry();
	if (error && servers.length === 0) {
		return {
			success: false,
			serverCount: 0,
			message: error,
		};
	}
	const registryData = {
		servers,
	};
	const serverCount = servers.length;
	if (serverCount === 0) {
		return {
			success: false,
			serverCount: 0,
			message: "Claude Registry returned 0 servers",
		};
	}

	// 2. Save to R2
	const r2Key = "catalog/claude/registry_servers.json";
	await env.R2_BUCKET.put(r2Key, JSON.stringify(registryData), {
		httpMetadata: {
			contentType: "application/json",
		},
		customMetadata: {
			source: "claude-registry-api",
			capturedAt: new Date().toISOString(),
			serverCount: String(serverCount),
		},
	});

	// 3. Trigger sync workflow
	const syncLog = await createAppCatalogSyncLog(db, {
		syncType: "r2",
		source: "claude" as const,
		startedAt: new Date().toISOString(),
		status: "running",
		details: {
			r2Path: "catalog/claude/",
			trigger: "sync-claude-registry",
			serverCount,
		},
	});
	try {
		const workflow = env.CATALOG_SYNC_WORKFLOW;
		if (!workflow) {
			return {
				success: true,
				serverCount,
				syncLogId: syncLog.id,
				message: `Saved ${serverCount} servers to R2 but workflow binding not available`,
			};
		}
		const instance = await workflow.create({
			params: {
				syncType: "r2" as const,
				r2Path: "catalog/claude/",
				syncLogId: syncLog.id,
			},
		});
		return {
			success: true,
			serverCount,
			syncLogId: syncLog.id,
			workflowInstanceId: instance.id,
			message: `Fetched ${serverCount} servers from Claude Registry, sync workflow started`,
		};
	} catch (error) {
		await updateAppCatalogSyncLog(db, syncLog.id, {
			status: "failed",
			completedAt: new Date().toISOString(),
			error:
				error instanceof Error ? error.message : "Failed to start workflow",
		});
		return {
			success: false,
			serverCount,
			syncLogId: syncLog.id,
			message: `Saved to R2 but workflow failed: ${error instanceof Error ? error.message : "Unknown error"}`,
		};
	}
}
