import { AUTHZ, ErrorCodes, createError, withAuthorization } from "../../orpc";
import { getAppsNeedingEnrichment } from "@tedix/db/queries/catalog/enrichment";
import {
	getCatalogAppById,
	getCatalogAppBySlug,
	updateCatalogAppScanConnection,
} from "@tedix/db/queries/catalog/get-app";
import {
	getCatalogAppsNeedingScan,
	getCatalogScanBacklogSummary,
} from "@tedix/db/queries/catalog/health-metrics";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import { installFromCatalog } from "@tedix/db/queries/catalog/install";
import { isPlatformPrincipal } from "@tedix/auth/types";
import { requireCatalogOperatorAccess } from "../catalog-operator-access";
import {
	calculateCatalogInstallability,
	tenantCatalogOs,
	fleetCatalogOs,
	getCatalogBaseApp,
} from "./policy-quality";
import {
	installTenantMcpAppFromCatalog,
	installTenantMcpAppsFromCatalog,
	uninstallTenantMcpAppFromAggregator,
} from "./install-scan";

/**
 * Trigger MCP scan workflow
 * POST /catalog/scan
 */
/**
 * Bind a catalog app's scanner to a connection provider + org credential.
 *
 * Without this, an auth-gated upstream is scanned anonymously: `tools/list`
 * 401s, so the catalog holds only registry-derived tool NAMES with empty
 * inputSchemas — and every tedi consuming that app has to guess call shapes.
 * `resolveVaultToken()` in McpScanWorkflow already knows how to borrow a Token
 * Vault credential; it just needs these two columns populated.
 */
export const setScanConnectionCatalog = fleetCatalogOs.setScanConnection
	.use(AUTHZ.catalogWrite)
	.handler(async ({ input, context }) => {
		const { db } = context;

		// `app_catalog` is global: this makes a shared row scan with ONE org's
		// credential, so it is a platform decision, not a tenant one.
		if (!isPlatformPrincipal(context)) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Binding a catalog scanner to an organization credential requires platform-admin authority",
			);
		}
		if (!input.catalogAppId && !input.catalogAppSlug) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Provide catalogAppId or catalogAppSlug",
			);
		}
		const catalogApp = input.catalogAppId
			? await getCatalogAppById(db, input.catalogAppId)
			: await getCatalogAppBySlug(db, input.catalogAppSlug as string);
		if (!catalogApp) {
			throw createError(ErrorCodes.NOT_FOUND, "Catalog app not found");
		}
		if (!catalogApp.slug) {
			throw createError(
				ErrorCodes.CONFLICT,
				"Catalog app must have a slug before configuring scan credentials",
			);
		}
		const org = await getOrganizationById(db, input.organizationId);
		if (!org) {
			throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
		}
		const connectionHeader = input.connectionHeader ?? "Authorization";
		const connectionTemplate = input.connectionTemplate ?? "Bearer {token}";
		await updateCatalogAppScanConnection(db, catalogApp.id, {
			connectionId: input.connectionId,
			connectionHeader,
			connectionTemplate,
			organizationId: input.organizationId,
		});
		console.log(
			`[Catalog] Scan connection bound: app=${catalogApp.slug} connectionId=${input.connectionId} org=${org.slug}`,
		);
		return {
			updated: true,
			catalogAppId: catalogApp.id,
			catalogAppSlug: catalogApp.slug,
			connectionId: input.connectionId,
			organizationId: input.organizationId,
			connectionHeader,
			connectionTemplate,
		};
	});

export const triggerScanCatalog = fleetCatalogOs.triggerScan
	.use(AUTHZ.catalogWrite)
	.handler(async ({ input, context }) => {
		requireCatalogOperatorAccess(context);
		const { db, env } = context;
		const { limit, maxAgeHours, catalogAppIds } = input;
		if (catalogAppIds && catalogAppIds.length > 0) {
			try {
				const workflow = (
					env as {
						MCP_SCAN_WORKFLOW?: Workflow;
					}
				).MCP_SCAN_WORKFLOW;
				if (!workflow) {
					console.warn("[Catalog] MCP_SCAN_WORKFLOW binding not available");
					return {
						success: true,
						appsQueued: catalogAppIds.length,
						workflowInstanceId: undefined,
						message: `${catalogAppIds.length} apps need scans but workflow binding not available`,
					};
				}
				const instance = await workflow.create({
					params: {
						limit: Math.max(limit, catalogAppIds.length),
						maxAgeHours,
						catalogAppIds,
					},
				});
				console.log(
					`[Catalog] MCP scan workflow started: ${instance.id} for ${catalogAppIds.length} targeted apps`,
				);
				return {
					success: true,
					appsQueued: catalogAppIds.length,
					workflowInstanceId: instance.id,
					message: `MCP scan workflow started for ${catalogAppIds.length} apps`,
				};
			} catch (error) {
				console.error("[Catalog] Failed to start MCP scan workflow:", error);
				return {
					success: false,
					appsQueued: 0,
					workflowInstanceId: undefined,
					message: `Failed to start MCP scan workflow: ${error instanceof Error ? error.message : "Unknown error"}`,
				};
			}
		}

		// Get apps needing scans
		const appsNeedingScan = await getCatalogAppsNeedingScan(db, {
			limit,
			maxAgeHours,
			catalogAppIds,
		});
		if (appsNeedingScan.length === 0) {
			const scanBacklog = await getCatalogScanBacklogSummary(db, {
				maxAgeHours,
			});
			return {
				success: true,
				appsQueued: 0,
				workflowInstanceId: undefined,
				message: `No actionable apps need scans at this time; ${scanBacklog.skippedRequiresAuth} auth-gated and ${scanBacklog.skippedBlocked} blocked app(s) are intentionally skipped until their weekly cadence or auth state changes`,
			};
		}

		// Trigger the MCP Scan Workflow
		try {
			// Note: This binding may not exist yet - it's optional
			const workflow = (
				env as {
					MCP_SCAN_WORKFLOW?: Workflow;
				}
			).MCP_SCAN_WORKFLOW;
			if (!workflow) {
				console.warn("[Catalog] MCP_SCAN_WORKFLOW binding not available");
				return {
					success: true,
					appsQueued: appsNeedingScan.length,
					workflowInstanceId: undefined,
					message: `${appsNeedingScan.length} apps need scans but workflow binding not available`,
				};
			}
			const instance = await workflow.create({
				params: {
					limit: appsNeedingScan.length,
					maxAgeHours,
					catalogAppIds: appsNeedingScan.map((app) => app.id),
				},
			});
			console.log(
				`[Catalog] MCP scan workflow started: ${instance.id} for ${appsNeedingScan.length} apps`,
			);
			return {
				success: true,
				appsQueued: appsNeedingScan.length,
				workflowInstanceId: instance.id,
				message: `MCP scan workflow started for ${appsNeedingScan.length} apps`,
			};
		} catch (error) {
			console.error("[Catalog] Failed to start MCP scan workflow:", error);
			return {
				success: false,
				appsQueued: 0,
				workflowInstanceId: undefined,
				message: `Failed to start MCP scan workflow: ${error instanceof Error ? error.message : "Unknown error"}`,
			};
		}
	});

/**
 * Trigger enrichment workflow
 * POST /catalog/enrich
 */

/**
 * Trigger enrichment workflow
 * POST /catalog/enrich
 */
export const triggerEnrichCatalog = fleetCatalogOs.triggerEnrich
	.use(AUTHZ.catalogWrite)
	.handler(async ({ input, context }) => {
		requireCatalogOperatorAccess(context);
		const { db, env } = context;
		const { limit, appIds, forceBranding, mode, drainAll, maxChainDepth } =
			input;

		// If specific app IDs provided, use those; otherwise get apps needing enrichment
		let appsToEnrich: {
			id: string;
		}[] = [];
		if (appIds && appIds.length > 0) {
			appsToEnrich = appIds.map((id: string) => ({
				id,
			}));
		} else {
			const apps = await getAppsNeedingEnrichment(db, limit, 168, {
				forceBranding,
				mode,
			});
			appsToEnrich = apps.map((app) => ({
				id: app.id,
			}));
		}
		if (appsToEnrich.length === 0) {
			return {
				success: true,
				appsQueued: 0,
				workflowInstanceId: undefined,
				message: "No apps need enrichment at this time",
			};
		}

		// Trigger the Cloudflare Workflow
		try {
			const workflow = env.CATALOG_ENRICHMENT_WORKFLOW;
			if (!workflow) {
				console.warn(
					"[Catalog] CATALOG_ENRICHMENT_WORKFLOW binding not available",
				);
				return {
					success: true,
					appsQueued: appsToEnrich.length,
					workflowInstanceId: undefined,
					message: `${appsToEnrich.length} apps need enrichment but workflow binding not available`,
				};
			}
			const instance = await workflow.create({
				params: {
					limit,
					appIds: appsToEnrich.map((app) => app.id),
					drainAll,
					chainDepth: 0,
					maxChainDepth,
					forceBranding,
					mode,
				},
			});
			console.log(
				`[Catalog] Enrichment workflow started: ${instance.id} for ${appsToEnrich.length} apps`,
			);
			return {
				success: true,
				appsQueued: appsToEnrich.length,
				workflowInstanceId: instance.id,
				message: `Enrichment workflow started for ${appsToEnrich.length} apps`,
			};
		} catch (error) {
			console.error("[Catalog] Failed to start enrichment workflow:", error);
			return {
				success: false,
				appsQueued: 0,
				workflowInstanceId: undefined,
				message: `Failed to start enrichment workflow: ${error instanceof Error ? error.message : "Unknown error"}`,
			};
		}
	});

// =============================================================================
// INSTALL FROM CATALOG PROCEDURE
// =============================================================================

/**
 * Install a catalog app as a personalized org-owned zero-tool proxy app.
 * POST /catalog/apps/:catalogAppId/install
 */

// =============================================================================
// INSTALL FROM CATALOG PROCEDURE
// =============================================================================

/**
 * Install a catalog app as a personalized org-owned zero-tool proxy app.
 * POST /catalog/apps/:catalogAppId/install
 */
export const installFromCatalogProcedure = fleetCatalogOs.installFromCatalog
	.use(AUTHZ.appsCreate)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const {
			catalogAppId,
			slug,
			name,
			description,
			visibility,
			connectionProviderId,
			connectionScope,
			connectionScopes,
		} = input;
		if (!context.organizationId) {
			throw new Error("Organization context required to install a catalog app");
		}
		const catalogApp = await getCatalogAppById(db, catalogAppId);
		if (!catalogApp) {
			throw createError(ErrorCodes.NOT_FOUND, "Catalog app not found");
		}
		const baseApp = await getCatalogBaseApp(db, catalogApp.id);
		const installability = calculateCatalogInstallability(catalogApp, baseApp);
		if (!installability.installable) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Catalog app "${catalogApp.name}" is not installable: ${installability.reason}`,
			);
		}
		const result = await installFromCatalog(db, {
			catalogAppId,
			organizationId: context.organizationId,
			slug,
			name,
			description,
			visibility,
			connectionProviderId,
			connectionScope,
			connectionScopes,
		});
		const app = result.app;
		if (!app) {
			throw new Error("Failed to create app from catalog entry");
		}
		console.log(
			`[Catalog] Installed proxy app ${app.id} (${app.slug}) from catalog ${result.catalogAppId} via base app ${result.sourceAppSlug} (${result.sourceAppId})`,
		);
		return {
			app: {
				id: app.id,
				organizationId: app.organizationId,
				name: app.name,
				slug: app.slug,
				description: app.description ?? null,
				logoUrl: app.logoUrl ?? null,
				visibility: app.visibility ?? null,
				discoveryStatus: app.discoveryStatus ?? null,
				createdAt: app.createdAt ?? null,
				updatedAt: app.updatedAt ?? null,
			},
			catalogAppId: result.catalogAppId,
			catalogAppName: result.catalogAppName,
		};
	});

export const installTenantMcpAppProcedure = tenantCatalogOs.installTenantMcpApp
	.use(withAuthorization(["apps:create", "apps:update"], "apps:write"))
	.handler(async ({ input, context }) => {
		return installTenantMcpAppFromCatalog(context, input);
	});

export const installTenantMcpAppsProcedure =
	tenantCatalogOs.installTenantMcpApps
		.use(withAuthorization(["apps:create", "apps:update"], "apps:write"))
		.handler(async ({ input, context }) => {
			return installTenantMcpAppsFromCatalog(context, input);
		});

export const uninstallTenantMcpAppProcedure =
	tenantCatalogOs.uninstallTenantMcpApp
		.use(AUTHZ.appsWrite)
		.handler(async ({ input, context }) => {
			return uninstallTenantMcpAppFromAggregator(context, input);
		});
