import { purgeMcpAggregateCache } from "../../../lib/mcp-subscriptions";
import {
	getBySlugCatalog,
	getCategoriesCatalog,
	getHealthSummaryCatalog,
	getStatsCatalog,
	getSyncLogsCatalog,
	listCatalog,
} from "./discovery-sync";
import {
	AUTHZ,
	ErrorCodes,
	createError,
	skipOutputValidation,
	withAuthorization,
} from "../../orpc";
import type { ReconcileCatalogAppStage } from "@tedix/api-contract/schemas/catalog";
import { createBaseAppFromCatalog } from "@tedix/db/queries/catalog/create-base-app";
import { validateUrl } from "@tedix/ssrf-guard";
import {
	deleteCatalogApp,
	generateUniqueCatalogAppSlug,
	getCatalogAppById,
	getCatalogAppBySlug,
	updateCatalogApp,
	updateCatalogStoreListing,
} from "@tedix/db/queries/catalog/get-app";
import { getCatalogAppBySlugWithRelations } from "@tedix/db/queries/catalog/list-with-relations";
import {
	hashMcpEndpoint,
	normalizeMcpEndpoint,
} from "@tedix/db/queries/catalog/endpoint-normalization";
import { mergeCatalogApps } from "@tedix/db/queries/catalog/merge";
import {
	applyCatalogPlainSlugReassignment,
	planCatalogPlainSlugReassignment,
} from "@tedix/db/queries/catalog/vendor-siblings";
import { isPlatformPrincipal } from "@tedix/auth/types";
import { previewOpenApiToolImport } from "../../../services/openapi-tool-import";
import {
	projectCatalogToolsFromBaseApp,
	syncCatalogMcpPrompts,
	syncCatalogMcpResourceTemplates,
	syncCatalogMcpResources,
	syncCatalogMcpTools,
} from "@tedix/db/queries/catalog/mcp-tools";
import { propagateTools } from "@tedix/db/queries/catalog/fork-propagation";
import {
	publishMcpCatalogInventoryEvents,
	publishMcpListChangedEventsSoon,
} from "../../../lib/mcp-subscriptions";
import { requireCatalogOperatorAccess } from "../catalog-operator-access";
import { resolveDriftReport } from "@tedix/db/queries/catalog/drift-reports";
import { resolveTedixInternalScanHeaders as resolveFirstPartyScanHeaders } from "../../../lib/catalog-internal-scan";
import { syncCatalogAppFromStore } from "@tedix/db/queries/catalog/upsert-sync";
import { syncCatalogToolsToApp } from "@tedix/db/queries/catalog/sync-tools-to-app";
import { toJsonRecord } from "@tedix/db/utils/json";
import { updateCatalogAppHealthMetrics } from "@tedix/db/queries/catalog/health-metrics";
import {
	getAppChangelogCatalog,
	getDriftReportsCatalog,
	getRecentChangesCatalog,
	getToolTestStatsCatalog,
	getToolTestsCatalog,
} from "./quality-governance";
import {
	calculateCatalogInstallability,
	calculateCatalogQuality,
	calculateDiscoverability,
	fleetCatalogOs,
	getCatalogBaseApp,
	hasAggregateAppOverlay,
	normalizeOutputJsonSchema,
	normalizeToolJsonSchema,
	publicCategories,
	publicCategory,
	publicLogoUrl,
	pushReconcileStage,
	queueOpenApiSyncWorkflow,
	sanitizePublicText,
	stageData,
	summarizeBaseApp,
} from "./policy-quality";
import {
	CATALOG_APP_INVENTORY_METHODS,
	propagationChangedAppIds,
	runClaudeRegistrySync,
	scanUpstreamCatalogAppNow,
} from "./install-scan";

export // =============================================================================
// RECONCILE CATALOG APP (one-shot lifecycle)
// =============================================================================

const reconcileCatalogAppProcedure = fleetCatalogOs.reconcileApp
	.use(AUTHZ.catalogWrite)
	.handler(async ({ input, context }) => {
		requireCatalogOperatorAccess(context);
		const { db } = context;
		const dryRun = input.dryRun ?? true;
		const catalogApp = input.catalogAppId
			? await getCatalogAppById(db, input.catalogAppId)
			: input.slug
				? await getCatalogAppBySlug(db, input.slug)
				: null;
		if (!catalogApp) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				input.catalogAppId
					? `Catalog app not found: ${input.catalogAppId}`
					: `Catalog app not found for slug: ${input.slug ?? "(missing)"}`,
			);
		}
		if (!catalogApp.slug) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Catalog app ${catalogApp.id} must have a slug before reconciliation`,
			);
		}
		if (!catalogApp.toolSource) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Catalog app ${catalogApp.slug} must declare tool_source before reconciliation`,
			);
		}
		const stages: ReconcileCatalogAppStage[] = [];
		let baseApp = await getCatalogBaseApp(db, catalogApp.id, input.baseAppId);
		if (input.baseAppId && !baseApp) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				`Base/custom app not found: ${input.baseAppId}`,
			);
		}
		if (baseApp && hasAggregateAppOverlay(baseApp)) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Refusing to reconcile proxy app "${baseApp.name}" (${baseApp.id}). Proxy apps keep zero app_tools rows and inherit through mcpConfig.aggregateApps; reconcile the platform base app or an explicit custom fork instead.`,
			);
		}
		pushReconcileStage(
			stages,
			"resolve",
			"completed",
			baseApp
				? `Resolved catalog app ${catalogApp.slug} and base app ${baseApp.slug}.`
				: `Resolved catalog app ${catalogApp.slug}; no linked base app found.`,
			stageData({
				catalogAppId: catalogApp.id,
				slug: catalogApp.slug,
				toolSource: catalogApp.toolSource,
				baseAppId: baseApp?.id,
				baseAppSlug: baseApp?.slug,
			}),
		);
		if (catalogApp.toolSource === "openapi") {
			if (!baseApp) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					`OpenAPI catalog app ${catalogApp.slug} needs baseAppId or a linked base app`,
				);
			}
			if (dryRun) {
				const result = await previewOpenApiToolImport(db, {
					appId: baseApp.id,
					dryRun: true,
				});
				pushReconcileStage(
					stages,
					"openapi_import",
					"would_run",
					`Would import OpenAPI tools for ${baseApp.slug}: ${result.planned} planned, ${result.inSync} in sync, ${result.failed} failed.`,
					stageData({
						totalOperations: result.totalOperations,
						planned: result.planned,
						inSync: result.inSync,
						failed: result.failed,
					}),
				);
				pushReconcileStage(
					stages,
					"catalog_projection",
					"would_run",
					`Would project generated base-app tools from ${baseApp.slug} into the catalog snapshot after OpenAPI sync.`,
				);
			} else {
				const queued = await queueOpenApiSyncWorkflow(context, {
					appId: baseApp.id,
					dryRun: false,
				});
				pushReconcileStage(
					stages,
					"openapi_import",
					"completed",
					`Queued OpenApiSyncWorkflow for ${baseApp.slug}.`,
					stageData({
						workflowId: queued.workflowId,
					}),
				);
				pushReconcileStage(
					stages,
					"catalog_projection",
					"completed",
					`Catalog projection will run inside OpenApiSyncWorkflow after generated tools are refreshed.`,
					stageData({
						workflowId: queued.workflowId,
					}),
				);
			}
		} else if (catalogApp.toolSource === "tedix_app") {
			if (!baseApp) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					`Tedix-owned catalog app ${catalogApp.slug} needs baseAppId or a linked base app`,
				);
			}
			if (dryRun) {
				pushReconcileStage(
					stages,
					"catalog_projection",
					"would_run",
					`Would project enabled base-app tools from ${baseApp.slug} into the catalog snapshot.`,
				);
			} else {
				const projection = await projectCatalogToolsFromBaseApp(
					db,
					catalogApp.id,
				);
				pushReconcileStage(
					stages,
					"catalog_projection",
					"completed",
					projection.summary,
					stageData({
						activeTools: projection.activeTools,
						added: projection.added,
						updated: projection.updated,
						removed: projection.removed,
					}),
				);
			}
		} else {
			const mcpServerUrl =
				input.mcpServerUrl ??
				catalogApp.mcpEndpointNormalized ??
				catalogApp.baseUrl ??
				null;
			if (!mcpServerUrl) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					`Upstream MCP catalog app ${catalogApp.slug} needs mcpServerUrl or a stored MCP endpoint`,
				);
			}
			if (dryRun) {
				pushReconcileStage(
					stages,
					"upstream_scan",
					"would_run",
					`Would scan upstream MCP endpoint ${mcpServerUrl}.`,
				);
			} else {
				const drift = await scanUpstreamCatalogAppNow(
					context,
					catalogApp,
					mcpServerUrl,
				);
				pushReconcileStage(
					stages,
					"upstream_scan",
					"completed",
					`Scanned upstream MCP endpoint: ${drift.addedTools} added, ${drift.changedTools} changed, ${drift.removedTools} removed, ${drift.resourceCount} resources, ${drift.resourceTemplateCount} resource templates, ${drift.promptCount} prompts.`,
					stageData({
						addedTools: drift.addedTools,
						changedTools: drift.changedTools,
						removedTools: drift.removedTools,
						resourceCount: drift.resourceCount,
						resourceTemplateCount: drift.resourceTemplateCount,
						promptCount: drift.promptCount,
						healthStatus: drift.healthStatus,
					}),
				);
			}
			if (!baseApp && input.organizationId) {
				if (dryRun) {
					pushReconcileStage(
						stages,
						"catalog_to_app",
						"would_run",
						`Would create a linked base app for ${catalogApp.slug} in organization ${input.organizationId}.`,
					);
				} else {
					const created = await createBaseAppFromCatalog(db, {
						catalogAppId: catalogApp.id,
						organizationId: input.organizationId,
						connectionProviderId: input.connectionProviderId,
						connectionScope: input.connectionScope,
						connectionScopes: input.connectionScopes,
						dryRun: false,
					});
					await purgeMcpAggregateCache(
						context.env,
						"catalog.reconcile_app base creation",
					);
					baseApp = {
						id: created.app.id,
						slug: created.app.slug,
						name: created.app.name,
						organizationId: created.app.organizationId,
						metadata: {},
					};
					pushReconcileStage(
						stages,
						"catalog_to_app",
						"completed",
						`Created linked base app ${baseApp.slug} and synced ${created.sync.results.length} tools.`,
						stageData({
							baseAppId: baseApp.id,
							baseAppSlug: baseApp.slug,
							toolResults: created.sync.results.length,
						}),
					);
				}
			} else if (baseApp) {
				const sync = await syncCatalogToolsToApp(db, {
					catalogAppId: catalogApp.id,
					appId: baseApp.id,
					mcpServerUrl,
					connectionProviderId: input.connectionProviderId,
					connectionScope: input.connectionScope,
					connectionScopes: input.connectionScopes,
					dryRun,
					disableRemoved: true,
				});
				if (!dryRun) {
					await purgeMcpAggregateCache(
						context.env,
						"catalog.reconcile_app schema sync",
					);
					await resolveDriftReport(db, catalogApp.id);
					publishMcpListChangedEventsSoon(
						context.waitUntil,
						context.env,
						{
							appId: baseApp.id,
						},
						CATALOG_APP_INVENTORY_METHODS,
					);
				}
				pushReconcileStage(
					stages,
					"catalog_to_app",
					dryRun ? "would_run" : "completed",
					sync.summary,
					stageData({
						resultCount: sync.results.length,
					}),
				);
			} else {
				pushReconcileStage(
					stages,
					"catalog_to_app",
					"skipped",
					"No linked base app found; pass organizationId to create one or baseAppId to reconcile an existing app.",
				);
			}
		}
		if (input.customForkAppIds.length === 0) {
			pushReconcileStage(
				stages,
				"custom_fork_propagation",
				"skipped",
				"No custom fork app IDs supplied for propagation.",
			);
		} else if (!baseApp) {
			pushReconcileStage(
				stages,
				"custom_fork_propagation",
				"skipped",
				"Custom fork propagation needs a resolved base app.",
			);
		} else {
			const propagation = await propagateTools(db, {
				sourceAppId: baseApp.id,
				appIds: input.customForkAppIds,
				applyTypes: [
					"schema_changed",
					"description_changed",
					"metadata_changed",
					"new_tool",
					"removed_tool",
				],
				preserveFields: [
					"auth.scopes",
					"auth.scope",
					"auth.credentialScope",
					"auth.credentialPreference",
					"auth.connectionId",
					"baseUrl",
				],
				dryRun,
			});
			const propagationAppIds = propagationChangedAppIds(propagation);
			if (!dryRun && propagationAppIds.length > 0) {
				await purgeMcpAggregateCache(
					context.env,
					"catalog.reconcile_app fork propagation",
				);
				publishMcpListChangedEventsSoon(
					context.waitUntil,
					context.env,
					{
						appIds: propagationAppIds,
					},
					CATALOG_APP_INVENTORY_METHODS,
				);
			}
			pushReconcileStage(
				stages,
				"custom_fork_propagation",
				dryRun ? "would_run" : "completed",
				propagation.summary,
				stageData({
					targetApps: input.customForkAppIds.length,
					resultCount: propagation.results.length,
				}),
			);
		}
		const completed = stages.filter(
			(stage) => stage.status === "completed",
		).length;
		const wouldRun = stages.filter(
			(stage) => stage.status === "would_run",
		).length;
		const skipped = stages.filter((stage) => stage.status === "skipped").length;
		return {
			catalogAppId: catalogApp.id,
			catalogAppName: catalogApp.name,
			catalogAppSlug: catalogApp.slug,
			toolSource: catalogApp.toolSource,
			dryRun,
			baseApp: summarizeBaseApp(baseApp),
			stages,
			summary: `${catalogApp.slug}: ${completed} completed, ${wouldRun} would run, ${skipped} skipped.`,
		};
	});

export const createBaseAppFromCatalogProcedure =
	fleetCatalogOs.createBaseAppFromCatalog
		.use(withAuthorization("apps:create", "catalog:manage"))
		.handler(async ({ input, context }) => {
			requireCatalogOperatorAccess(context);
			const { db } = context;
			const result = await createBaseAppFromCatalog(db, input);
			return {
				app: {
					id: result.app.id,
					slug: result.app.slug,
					name: result.app.name,
					organizationId: result.app.organizationId,
				},
				created: result.created,
				sync: result.sync,
			};
		});

// =============================================================================
// CREATE FROM MCP ENDPOINT
// =============================================================================

/**
 * Create a catalog app by connecting to an MCP endpoint directly.
 * Discovers tools/resources/prompts and creates catalog entry with source "official".
 * POST /catalog/create-from-endpoint
 */

export const createFromEndpointCatalog = fleetCatalogOs.createFromEndpoint
	.use(withAuthorization("apps:create", "catalog:manage"))
	.handler(async ({ input, context }) => {
		requireCatalogOperatorAccess(context);
		const { db } = context;
		const { connectMcpServer } = await import("../../../lib/mcp-client");
		const { insertCatalogHealthHistory } =
			await import("@tedix/db/queries/catalog/health-history");
		const { updateCatalogAppSlug } =
			await import("@tedix/db/queries/catalog/get-app");
		const {
			mcpEndpointUrl,
			name,
			description,
			category,
			developer,
			website,
			logoUrl,
			authType,
			authHeaders: rawAuthHeaders,
			connectionId,
			connectionHeader,
			connectionTemplate,
		} = input;
		// Tedix-served MCP endpoints (`builder.tedix.dev/mcp`, tenant
		// `{slug}.mcp.tedix.dev`) are legitimate catalog sources; local names and
		// private/loopback/metadata IPs in every textual form are not.
		if (
			validateUrl(mcpEndpointUrl, { allowHttp: true, allowTedixHosts: true })
		) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Private or loopback URLs are not allowed",
			);
		}

		// Resolve auth headers from Descope AIH Token Vault if connectionId provided.
		// Resolution chain: caller user credential → tenant credential.
		const firstPartyAuthHeaders = resolveFirstPartyScanHeaders({
			endpoint: mcpEndpointUrl,
			platformServiceToken: (
				context.env as CloudflareEnv & {
					PLATFORM_SERVICE_TOKEN?: string;
				}
			).PLATFORM_SERVICE_TOKEN,
		});
		let authHeaders = rawAuthHeaders ?? firstPartyAuthHeaders;
		if (connectionId && !authHeaders && context.organizationId) {
			let resolvedToken: string | undefined;
			let resolvedVia = "";
			if (context.env.DESCOPE_MANAGEMENT_KEY) {
				const { getManagementClient } = await import("@tedix/auth/client");
				const { fetchConnectionToken, fetchTenantConnectionToken } =
					await import("@tedix/auth/connections");
				const { getOrganizationById } =
					await import("@tedix/db/queries/organizations");
				const descopeClient = getManagementClient({
					DESCOPE_PROJECT_ID: context.env.DESCOPE_PROJECT_ID,
					DESCOPE_MANAGEMENT_KEY: context.env.DESCOPE_MANAGEMENT_KEY,
					DESCOPE_BASE_URL: context.env.DESCOPE_BASE_URL,
				});
				const callerUserId = context.user?.sub;
				if (callerUserId) {
					try {
						const userResult = await fetchConnectionToken(
							descopeClient,
							connectionId,
							callerUserId,
						);
						if (userResult?.accessToken) {
							resolvedToken = userResult.accessToken;
							resolvedVia = "descope-user";
						}
					} catch {
						/* non-fatal */
					}
				}
				if (!resolvedToken) {
					const org = await getOrganizationById(db, context.organizationId);
					if (org?.descopeTenantId) {
						try {
							const tenantResult = await fetchTenantConnectionToken(
								descopeClient,
								connectionId,
								org.descopeTenantId,
							);
							if (tenantResult?.accessToken) {
								resolvedToken = tenantResult.accessToken;
								resolvedVia = "descope-tenant";
							}
						} catch {
							/* non-fatal */
						}
					}
				}
			}
			if (resolvedToken) {
				const header = connectionHeader || "Authorization";
				const template = connectionTemplate || "{token}";
				authHeaders = {
					[header]: template.replace("{token}", resolvedToken),
				};
				console.log(
					`[Catalog] Resolved connectionId="${connectionId}" via ${resolvedVia}, header=${header}`,
				);
			} else {
				console.error(
					`[Catalog] connectionId="${connectionId}" not found. orgId=${context.organizationId}, userId=${context.user?.sub ?? "none"}, authType=${context.authType}`,
				);
				throw createError(
					ErrorCodes.NOT_FOUND,
					`No connection found for "${connectionId}" in org ${context.organizationId}. Store it via connections API. (authType=${context.authType}, userId=${context.user?.sub ?? "none"})`,
				);
			}
		}

		// 1. Connect to the MCP server and discover capabilities
		// For internal *.mcp.tedix.dev URLs, use the MCP_SERVICE
		// service binding to avoid Cloudflare HTTP 522 errors (same-account loopback).
		// The service binding is called with MCP_URL as the base, and the original
		// hostname is forwarded via X-Tedix-Host for slug-based routing.
		const isInternalMcpUrl = (() => {
			try {
				const { hostname } = new URL(mcpEndpointUrl);
				return /^[^.]+\.mcp\.tedix\.dev$/.test(hostname);
			} catch {
				return false;
			}
		})();
		let fetchFn:
			| ((url: string, init?: RequestInit) => Promise<Response>)
			| undefined;
		if (isInternalMcpUrl && context.env.MCP_SERVICE && context.env.MCP_URL) {
			const mcpHost = new URL(mcpEndpointUrl).hostname;
			const mcpService = context.env.MCP_SERVICE;
			fetchFn = (url: string, init?: RequestInit) => {
				// Preserve the path/query from the client request but use the service base
				const reqUrl = new URL(url);
				const svcUrl = new URL(context.env.MCP_URL!);
				svcUrl.pathname = reqUrl.pathname;
				svcUrl.search = reqUrl.search;
				return mcpService.fetch(svcUrl.toString(), {
					...init,
					headers: {
						...(init?.headers as Record<string, string> | undefined),
						"X-Tedix-Host": mcpHost,
					},
				});
			};
		}
		const connectionResult = await connectMcpServer(mcpEndpointUrl, {
			timeout: 30000,
			fetchFn,
			headers: authHeaders,
		});

		// Allow auth-required results — we still create the catalog entry
		const isUnreachable =
			!connectionResult.success &&
			!connectionResult.requiresAuth &&
			!connectionResult.serverInfo;
		if (isUnreachable) {
			throw new Error(
				`Failed to connect to MCP server at ${mcpEndpointUrl}: ${connectionResult.error || "Unknown error"}`,
			);
		}
		const serverInfo = connectionResult.serverInfo;
		const serverName = name || serverInfo?.name || "Unknown MCP Server";
		const now = new Date().toISOString();

		// 2. Upsert via syncCatalogAppFromStore (handles dedup by endpoint hash)
		const syncResult = await syncCatalogAppFromStore(db, {
			source: "official",
			sourceAppId: mcpEndpointUrl,
			name: serverName,
			description: description || serverInfo?.instructions || undefined,
			modelDescription: serverInfo?.instructions || undefined,
			baseUrl: mcpEndpointUrl,
			connectorType: "MCP",
			distributionChannel: "INDIVIDUAL",
			developerType: "THIRD_PARTY",
			status: "ENABLED",
			category: category || undefined,
			developer: developer || undefined,
			website: website || undefined,
			logoUrl: logoUrl || undefined,
			isDiscoverable: true,
			reviewStatus: "RELEASED",
			authTypes: authType ? [authType] : ["NONE"],
			version: serverInfo?.version || undefined,
			rawData: toJsonRecord({
				serverInfo: {
					name: serverInfo?.name,
					version: serverInfo?.version,
					protocolVersion: serverInfo?.protocolVersion,
					capabilities: serverInfo?.capabilities,
				},
				submittedAt: now,
				submittedBy: context.user?.sub || "system",
			}),
		});
		if (!syncResult) {
			throw new Error("Failed to create catalog entry");
		}
		const catalogApp = syncResult.app;

		// 3. Generate slug if newly created and missing
		if (syncResult.created && !catalogApp.slug) {
			const slug = await generateUniqueCatalogAppSlug(db, serverName, {
				storeSourceId: mcpEndpointUrl,
				baseUrl: mcpEndpointUrl,
			});
			await updateCatalogAppSlug(db, catalogApp.id, slug);
			(catalogApp as Record<string, unknown>).slug = slug;
		}

		// 4. Sync discovered MCP tools
		const tools = serverInfo?.tools || [];
		if (serverInfo) {
			await syncCatalogMcpTools(
				db,
				catalogApp.id,
				tools.map((t) => ({
					name: t.name,
					description: t.description,
					inputSchema: normalizeToolJsonSchema(t.inputSchema),
					annotations: t.annotations,
				})),
			);
			const resourceSync = await syncCatalogMcpResources(
				db,
				catalogApp.id,
				serverInfo.resources?.map((resource) => ({
					...resource,
					_meta:
						resource._meta === undefined
							? undefined
							: toJsonRecord(resource._meta),
				})) ?? [],
			);
			const templateSync = await syncCatalogMcpResourceTemplates(
				db,
				catalogApp.id,
				serverInfo.resourceTemplates?.map((template) => ({
					...template,
					_meta:
						template._meta === undefined
							? undefined
							: toJsonRecord(template._meta),
				})) ?? [],
			);
			const promptSync = await syncCatalogMcpPrompts(
				db,
				catalogApp.id,
				serverInfo.prompts ?? [],
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

		// 5. Determine health status
		type HealthStatus =
			| "healthy"
			| "degraded"
			| "unhealthy"
			| "requires_auth"
			| "blocked"
			| "unsupported"
			| "unknown";
		const healthStatus: HealthStatus = connectionResult.success
			? connectionResult.partialAuth
				? "requires_auth"
				: "healthy"
			: connectionResult.requiresAuth
				? "requires_auth"
				: "unhealthy";

		// 6. Build scan result and update health metrics + history
		const scanResult = {
			checkedAt: now,
			status: healthStatus,
			connectTimeMs: connectionResult.connectTimeMs,
			totalTimeMs: connectionResult.totalTimeMs,
			transportUsed: connectionResult.transport,
			serverVersion: serverInfo?.version,
			toolCount: tools.length,
			resourceCount: serverInfo?.resources?.length || 0,
			promptCount: serverInfo?.prompts?.length || 0,
			errorMessage: connectionResult.error,
			authState: connectionResult.requiresAuth
				? ("required" as const)
				: ("none" as const),
			capabilities: serverInfo?.capabilities as
				| Record<string, unknown>
				| undefined,
			instructions: serverInfo?.instructions,
		};
		await updateCatalogAppHealthMetrics(db, catalogApp.id, scanResult);
		await insertCatalogHealthHistory(db, {
			catalogAppId: catalogApp.id,
			checkedAt: now,
			status: healthStatus,
			connectTimeMs: connectionResult.connectTimeMs,
			totalTimeMs: connectionResult.totalTimeMs,
			transportUsed: connectionResult.transport,
			serverVersion: serverInfo?.version ?? null,
			toolCount: tools.length,
			resourceCount: serverInfo?.resources?.length || 0,
			promptCount: serverInfo?.prompts?.length || 0,
			errorMessage: connectionResult.error ?? null,
			authState: connectionResult.requiresAuth ? "required" : "none",
		});

		// 7. Persist encrypted auth headers for periodic re-scans
		if (
			authHeaders &&
			authHeaders !== firstPartyAuthHeaders &&
			Object.keys(authHeaders).length > 0
		) {
			const masterKey = context.env.SECRETS_MASTER_KEY;
			if (masterKey) {
				const { encryptCatalogAppSecret } =
					await import("@tedix/db/utils/secrets-encryption");
				const encrypted = await encryptCatalogAppSecret(
					masterKey,
					catalogApp.id,
					JSON.stringify(authHeaders),
				);
				const { updateCatalogAppScanAuth } =
					await import("@tedix/db/queries/catalog/get-app");
				await updateCatalogAppScanAuth(db, catalogApp.id, encrypted);
			}
		}

		// 8. Persist vault connection reference for fresh token resolution during periodic scans.
		// This survives token expiry — the scan workflow resolves a fresh token each time.
		if (connectionId && context.organizationId) {
			const { updateCatalogAppScanConnection } =
				await import("@tedix/db/queries/catalog/get-app");
			await updateCatalogAppScanConnection(db, catalogApp.id, {
				connectionId,
				connectionHeader: connectionHeader || "Authorization",
				connectionTemplate: connectionTemplate || "{token}",
				organizationId: context.organizationId,
			});
		}
		return {
			catalogApp: {
				id: catalogApp.id,
				slug: catalogApp.slug,
				name: catalogApp.name,
				mcpEndpointNormalized: catalogApp.mcpEndpointNormalized,
			},
			created: syncResult.created,
			toolsDiscovered: tools.length,
			resourcesDiscovered: serverInfo?.resources?.length || 0,
			promptsDiscovered: serverInfo?.prompts?.length || 0,
			transport: connectionResult.transport,
			serverName: serverInfo?.name || null,
			serverVersion: serverInfo?.version || null,
			healthStatus,
			connectTimeMs: connectionResult.connectTimeMs,
		};
	});

// =============================================================================
// CLAUDE REGISTRY SYNC
// =============================================================================

export const syncClaudeRegistryCatalog = fleetCatalogOs.syncClaudeRegistry
	.use(AUTHZ.catalogWrite)
	.handler(async ({ context }) => {
		requireCatalogOperatorAccess(context);
		const { db, env } = context;
		return runClaudeRegistrySync(db, env);
	});

// =============================================================================
// UPDATE / DELETE CATALOG APP
// =============================================================================

export // =============================================================================
// UPDATE / DELETE CATALOG APP
// =============================================================================

const updateCatalogAppProcedure = fleetCatalogOs.updateApp
	.use(AUTHZ.catalogWrite)
	.handler(async ({ input, context }) => {
		requireCatalogOperatorAccess(context);
		const { db } = context;
		const { id, ...fields } = input;
		const updateData: Record<string, unknown> = {};
		if (fields.slug !== undefined) updateData.slug = fields.slug;
		if (fields.name !== undefined) updateData.name = fields.name;
		if (fields.description !== undefined)
			updateData.description = fields.description;
		if (fields.modelDescription !== undefined)
			updateData.modelDescription = fields.modelDescription;
		if (fields.seoDescription !== undefined)
			updateData.seoDescription = fields.seoDescription;
		if (fields.status !== undefined) updateData.status = fields.status;
		if (fields.category !== undefined) updateData.category = fields.category;
		if (fields.developer !== undefined) updateData.developer = fields.developer;
		if (fields.website !== undefined) updateData.website = fields.website;
		if (fields.privacyPolicy !== undefined)
			updateData.privacyPolicy = fields.privacyPolicy;
		if (fields.termsOfService !== undefined)
			updateData.termsOfService = fields.termsOfService;
		if (fields.logoUrl !== undefined) updateData.logoUrl = fields.logoUrl;
		if (fields.logoUrlDark !== undefined)
			updateData.logoUrlDark = fields.logoUrlDark;
		if (fields.connectorType !== undefined)
			updateData.connectorType = fields.connectorType;
		if (fields.developerType !== undefined)
			updateData.developerType = fields.developerType;
		if (fields.keywordsForDiscovery !== undefined)
			updateData.keywordsForDiscovery = fields.keywordsForDiscovery;
		if (fields.keywordsForTriggering !== undefined)
			updateData.keywordsForTriggering = fields.keywordsForTriggering;
		if (fields.isDiscoverable !== undefined)
			updateData.isDiscoverable = fields.isDiscoverable;
		if (fields.toolSource !== undefined)
			updateData.toolSource = fields.toolSource;
		if (fields.authTypes !== undefined) updateData.authTypes = fields.authTypes;
		if (fields.baseUrl !== undefined) {
			updateData.baseUrl = fields.baseUrl;
			const normalized = normalizeMcpEndpoint(fields.baseUrl);
			if (normalized) {
				updateData.mcpEndpointNormalized = normalized;
				updateData.mcpEndpointHash = await hashMcpEndpoint(normalized);
			}
		}
		if (fields.scanConnectionId !== undefined)
			updateData.scanConnectionId = fields.scanConnectionId;
		if (fields.scanOrganizationId !== undefined)
			updateData.scanOrganizationId = fields.scanOrganizationId;
		if (fields.scanConnectionHeader !== undefined)
			updateData.scanConnectionHeader = fields.scanConnectionHeader;
		if (fields.scanConnectionTemplate !== undefined)
			updateData.scanConnectionTemplate = fields.scanConnectionTemplate;
		if (fields.examplePrompts !== undefined) {
			const { getCatalogAppById } =
				await import("@tedix/db/queries/catalog/get-app");
			const existing = await getCatalogAppById(db, id);
			const richContent =
				(existing?.richContent as Record<string, unknown>) ?? {};
			updateData.richContent = {
				...richContent,
				examplePrompts: fields.examplePrompts.map((p) => ({
					raw: p,
					cleanPrompt: p,
					appMention: "",
				})),
			};
		}
		if (Object.keys(updateData).length === 0) {
			throw createError(ErrorCodes.BAD_REQUEST, "No fields to update");
		}
		const updated = await updateCatalogApp(db, id, updateData);
		if (!updated) {
			throw createError(ErrorCodes.NOT_FOUND, `Catalog app ${id} not found`);
		}
		if (!updated.slug) return null;
		const result = await getCatalogAppBySlugWithRelations(db, updated.slug);
		if (!result) return null;
		const primaryListing =
			result.storeListings.find((listing) => listing.source === "official") ??
			result.storeListings.find((listing) => listing.source === "tedix") ??
			result.storeListings.find((listing) => listing.source === "chatgpt") ??
			result.storeListings.find((listing) => listing.source === "claude") ??
			result.storeListings[0] ??
			null;
		const baseApp = await getCatalogBaseApp(db, result.id);
		return {
			id: result.id,
			slug: result.slug,
			name: result.name,
			description: sanitizePublicText(result.description),
			modelDescription: sanitizePublicText(result.modelDescription),
			baseUrl: result.baseUrl,
			mcpEndpointNormalized: result.mcpEndpointNormalized,
			toolSource: result.toolSource ?? null,
			connectorType: result.connectorType,
			distributionChannel: result.distributionChannel,
			developerType: result.developerType,
			status: result.status,
			category: publicCategory(result.category),
			developer: result.developer,
			website: result.website,
			privacyPolicy: result.privacyPolicy,
			termsOfService: result.termsOfService,
			logoUrl: publicLogoUrl(result.logoUrl),
			svgLogo: null,
			logoUrlDark: publicLogoUrl(result.logoUrlDark),
			screenshots: result.screenshots ?? null,
			keywordsForDiscovery: result.keywordsForDiscovery,
			keywordsForTriggering: result.keywordsForTriggering,
			hasWrites: result.hasWrites,
			hasInteractive: result.hasInteractive,
			hasFileSearch: result.hasFileSearch,
			hasDeepResearch: result.hasDeepResearch,
			hasSync: result.hasSync,
			authTypes: result.authTypes,
			mcpServerName: result.mcpMetadata?.serverName ?? null,
			mcpServerVersion: result.mcpMetadata?.serverVersion ?? null,
			mcpToolCount: result.mcpToolCount,
			mcpResourceCount: result.mcpResourceCount,
			mcpPromptCount: result.mcpPromptCount,
			mcpLastScannedAt:
				result.mcpMetadata?.lastScannedAt ??
				result.healthData?.lastCheckedAt ??
				null,
			mcpInstructions: result.mcpMetadata?.instructions ?? null,
			healthStatus: result.healthStatus,
			healthLastCheckedAt: result.healthData?.lastCheckedAt ?? null,
			healthConnectTimeMs: result.healthData?.connectTimeMs ?? null,
			healthUptimePercent: result.healthData?.uptimePercent ?? null,
			healthErrorMessage: result.healthData?.errorMessage ?? null,
			screenshotUrl: result.richContent?.screenshotUrl ?? null,
			enrichedDescription: sanitizePublicText(
				result.richContent?.enrichedDescription,
			),
			seoDescription: sanitizePublicText(result.seoDescription),
			socialLinks: result.richContent?.socialLinks ?? null,
			examplePrompts: result.richContent?.examplePrompts ?? null,
			categories: publicCategories(result.categories),
			enrichedAt: result.richContent?.enrichedAt ?? null,
			discoverability: calculateDiscoverability(result),
			quality: calculateCatalogQuality(result, primaryListing),
			installability: calculateCatalogInstallability(result, baseApp),
			lastSyncedAt: result.lastSyncedAt,
			createdAt: result.createdAt,
			updatedAt: result.updatedAt,
			sourceCreatedAt: result.sourceCreatedAt,
			storeListings: result.storeListings.map(
				(l: (typeof result.storeListings)[number]) => ({
					id: l.id,
					source: l.source,
					sourceAppId: l.sourceAppId,
					regions: l.regions,
					storeUrl: l.storeUrl,
					reviewStatus: l.reviewStatus,
					authRequired: l.authRequired,
					storeLogoUrl: publicLogoUrl(l.storeLogoUrl),
					storeDescription: sanitizePublicText(l.storeDescription),
					lastSyncedAt: l.lastSyncedAt,
				}),
			),
			tools: result.tools.map((t: (typeof result.tools)[number]) => ({
				id: t.id,
				toolName: t.toolName,
				title: t.title,
				description: sanitizePublicText(t.description),
				inputSchema: normalizeToolJsonSchema(t.inputSchema),
				outputSchema: normalizeOutputJsonSchema(t.outputSchema),
				icons: t.icons,
				executionTaskSupport: t.executionTaskSupport,
				annotations: t.annotations,
				meta: t.meta,
				detectedAt: t.detectedAt,
				lastSeenAt: t.lastSeenAt,
				removedAt: t.removedAt,
				lastTestedAt: t.lastTestedAt ?? null,
				testSuccessRate: t.testSuccessRate ?? null,
				avgLatencyMs: t.avgLatencyMs ?? null,
				testCount: t.testCount ?? null,
				exampleInput: t.exampleInput ?? null,
				exampleOutput: t.exampleOutput ?? null,
			})),
		};
	});

export const updateCatalogStoreListingProcedure =
	fleetCatalogOs.updateStoreListing
		.use(AUTHZ.catalogWrite)
		.handler(async ({ input, context }) => {
			requireCatalogOperatorAccess(context);
			const { db } = context;
			const { id, ...fields } = input;
			const updateData: Parameters<typeof updateCatalogStoreListing>[2] = {};
			if (fields.source !== undefined) updateData.source = fields.source;
			if (fields.sourceAppId !== undefined)
				updateData.sourceAppId = fields.sourceAppId;
			if (fields.regions !== undefined) updateData.regions = fields.regions;
			if (fields.storeUrl !== undefined) updateData.storeUrl = fields.storeUrl;
			if (fields.reviewStatus !== undefined)
				updateData.reviewStatus = fields.reviewStatus;
			if (fields.authRequired !== undefined)
				updateData.authRequired = fields.authRequired ?? false;
			if (fields.storeLogoUrl !== undefined)
				updateData.storeLogoUrl = fields.storeLogoUrl;
			if (fields.storeDescription !== undefined)
				updateData.storeDescription = fields.storeDescription;
			if (fields.popularityScore !== undefined)
				updateData.popularityScore = fields.popularityScore;
			if (fields.trendingScore !== undefined)
				updateData.trendingScore = fields.trendingScore;
			if (fields.rank !== undefined) updateData.rank = fields.rank;
			if (fields.worksWith !== undefined)
				updateData.worksWith = fields.worksWith;
			if (fields.lastSyncedAt !== undefined)
				updateData.lastSyncedAt = fields.lastSyncedAt;
			if (Object.keys(updateData).length === 0) {
				throw createError(ErrorCodes.BAD_REQUEST, "No fields to update");
			}
			const updated = await updateCatalogStoreListing(db, id, updateData);
			if (!updated) {
				throw createError(
					ErrorCodes.NOT_FOUND,
					`Catalog store listing ${id} not found`,
				);
			}
			return {
				id: updated.id,
				source: updated.source,
				sourceAppId: updated.sourceAppId,
				regions: updated.regions,
				storeUrl: updated.storeUrl,
				reviewStatus: updated.reviewStatus,
				authRequired: updated.authRequired,
				storeLogoUrl: publicLogoUrl(updated.storeLogoUrl),
				storeDescription: sanitizePublicText(updated.storeDescription),
				lastSyncedAt: updated.lastSyncedAt,
			};
		});

export const deleteCatalogAppProcedure = fleetCatalogOs.deleteApp
	.use(AUTHZ.catalogWrite)
	.handler(async ({ input, context }) => {
		requireCatalogOperatorAccess(context);
		const { db } = context;
		const result = await deleteCatalogApp(db, input.id);
		if (!result.deleted) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				`Catalog app ${input.id} not found`,
			);
		}
		return {
			success: true,
			id: input.id,
			name: result.name,
		};
	});

export const mergeCatalogAppsProcedure = fleetCatalogOs.mergeApps
	.use(AUTHZ.catalogWrite)
	.handler(async ({ input, context }) => {
		requireCatalogOperatorAccess(context);
		const { db } = context;
		try {
			return await mergeCatalogApps(db, {
				fromCatalogAppId: input.fromCatalogAppId,
				intoCatalogAppId: input.intoCatalogAppId,
				dryRun: input.dryRun,
			});
		} catch (error) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				error instanceof Error ? error.message : "Failed to merge catalog apps",
			);
		}
	});

/**
 * Give a plain vendor slug to the best-ranked same-vendor catalog row.
 * `app_catalog` is global and its slug is inherited by every base app,
 * connection provider and Code Mode namespace, so this is a platform decision.
 */
export const reassignCatalogPlainSlugProcedure =
	fleetCatalogOs.reassignPlainSlug
		.use(AUTHZ.catalogWrite)
		.handler(async ({ input, context }) => {
			requireCatalogOperatorAccess(context);
			if (!isPlatformPrincipal(context)) {
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Reassigning a catalog slug requires platform-admin authority",
				);
			}
			const { db } = context;
			const plan = await planCatalogPlainSlugReassignment(db, {
				slug: input.slug,
				classifyInstallability: (app, baseApp) =>
					calculateCatalogInstallability(app, baseApp).state,
			});
			if (!plan) {
				throw createError(ErrorCodes.NOT_FOUND, "Catalog app not found");
			}
			const apply = !input.dryRun && plan.action === "reassign";
			if (apply) await applyCatalogPlainSlugReassignment(db, plan);
			return { ...plan, dryRun: input.dryRun, applied: apply };
		});

// =============================================================================
// ROUTER EXPORT
// =============================================================================

/**
 * Contract-based router using os.router() pattern
 */

export const listRoute = skipOutputValidation(listCatalog);

export const getBySlugRoute = skipOutputValidation(getBySlugCatalog);

export const getCategoriesRoute = skipOutputValidation(getCategoriesCatalog);

export const getStatsRoute = skipOutputValidation(getStatsCatalog);

export const getHealthSummaryRoute = skipOutputValidation(
	getHealthSummaryCatalog,
);

export const getSyncLogsRoute = skipOutputValidation(getSyncLogsCatalog);

export const getAppChangelogRoute = skipOutputValidation(
	getAppChangelogCatalog,
);

export const getRecentChangesRoute = skipOutputValidation(
	getRecentChangesCatalog,
);

export const getToolTestsRoute = skipOutputValidation(getToolTestsCatalog);

export const getToolTestStatsRoute = skipOutputValidation(
	getToolTestStatsCatalog,
);

export const getDriftReportsRoute = skipOutputValidation(
	getDriftReportsCatalog,
);
