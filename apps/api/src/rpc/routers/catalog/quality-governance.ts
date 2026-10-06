import { AUTHZ, ErrorCodes, createError, withAuthorization } from "../../orpc";
import { CatalogProxyAppToolMutationError } from "@tedix/db/queries/catalog/tool-source-policy";
import type { ConnectionCredentialProfile } from "@tedix/api-contract/schemas/connections";
import { auditActor, emitAuditEvent } from "../../audit-helpers";
import {
	backfillCatalogToolProvenance,
	projectCatalogToolsFromBaseApp,
} from "@tedix/db/queries/catalog/mcp-tools";
import { createAppWithId, updateApp } from "@tedix/db/queries/app-records";
import { getAppBySlugForOrg } from "@tedix/db/queries/apps";
import {
	getCatalogAppBySlug,
	updateCatalogApp,
} from "@tedix/db/queries/catalog/get-app";
import {
	getCatalogAppChanges,
	getRecentCatalogChanges,
} from "@tedix/db/queries/catalog/change-tracking";
import { getLatestDriftReports } from "@tedix/db/queries/catalog/drift-reports";
import {
	getLatestToolTests,
	getToolTestStats,
	getToolTestsForApp,
	getToolsNeedingTest,
} from "@tedix/db/queries/catalog/tool-tests";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import { isPlatformPrincipal } from "@tedix/auth/types";
import {
	previewOpenApiToolImport,
	executeOpenApiToolImport,
} from "../../../services/openapi-tool-import";
import { propagateTools } from "@tedix/db/queries/catalog/fork-propagation";
import { publishMcpListChangedEventsSoon } from "../../../lib/mcp-subscriptions";
import { requireCatalogOperatorAccess } from "../catalog-operator-access";
import { runCatalogIntegrityMaintenance } from "@tedix/db/queries/catalog/maintenance-reports";
import { syncCatalogAppFromStore } from "@tedix/db/queries/catalog/upsert-sync";
import { syncCatalogToolsToApp } from "@tedix/db/queries/catalog/sync-tools-to-app";
import { toJsonRecord } from "@tedix/db/utils/json";
import { upsertConnectionProviderWithId } from "@tedix/auth/connections";
import {
	TenantMcpInstallResult,
	tenantCatalogOs,
	fleetCatalogOs,
	queueOpenApiSyncWorkflow,
	requireOpenApiImportAccess,
	sanitizeNamespace,
} from "./policy-quality";
import {
	CATALOG_APP_INVENTORY_METHODS,
	TenantOpenApiImportOverrides,
	installTenantMcpAppFromCatalog,
	openApiSyncMetadataFromInput,
	propagationChangedAppIds,
	resolveTenantMcpTargetAggregator,
	tenantOpenApiConnectionProviderPlan,
	tenantOpenApiImportInput,
} from "./install-scan";

export const createTenantOpenApiMcpAppProcedure =
	fleetCatalogOs.createTenantOpenApiMcpApp
		.use(withAuthorization(["apps:create", "apps:update"], "apps:write"))
		.handler(async ({ input, context }) => {
			const { db } = context;
			const dryRun = input.dryRun ?? true;
			const appSlug = input.appSlug.toLowerCase();
			const catalogSlug = (input.catalogSlug ?? appSlug).toLowerCase();
			const namespace =
				input.prefix ?? input.namespace ?? sanitizeNamespace(appSlug);
			const { orgId, targetAggregator } =
				await resolveTenantMcpTargetAggregator(
					context,
					input.targetAggregatorSlug,
				);
			const organization = await getOrganizationById(db, orgId);
			const tenantSuffix =
				organization?.slug ??
				targetAggregator.slug.replace(/-unified$/, "") ??
				orgId.slice(0, 8);
			const proxySlug = (
				input.proxySlug ?? `${appSlug}-${tenantSuffix}`
			).toLowerCase();
			const plannedCatalogId = crypto.randomUUID();
			const plannedBaseAppId = crypto.randomUUID();
			const connectionProviderPlan = tenantOpenApiConnectionProviderPlan(
				input,
				appSlug,
				tenantSuffix,
			);
			if (
				input.connectionProvider?.id &&
				connectionProviderPlan?.id === input.connectionProvider?.id &&
				!isPlatformPrincipal(context)
			) {
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Specifying an explicit connection-provider id is restricted to platform administrators.",
				);
			}
			const providerCredentialProfile = connectionProviderPlan?.config
				.credentialProfile as ConnectionCredentialProfile | undefined;
			let connectionProviderStatus: "planned" | "created" | "updated" | null =
				connectionProviderPlan && dryRun ? "planned" : null;
			const effectiveConnectionProviderId =
				input.connectionProviderId ?? connectionProviderPlan?.id;
			const openApiInputOverrides: TenantOpenApiImportOverrides = {
				connectionProviderId: effectiveConnectionProviderId,
				authScopes:
					input.authScopes ?? providerCredentialProfile?.defaultScopes,
				authHeader: input.authHeader ?? providerCredentialProfile?.authHeader,
				authTemplate:
					input.authTemplate ?? providerCredentialProfile?.authTemplate,
				authEncoding:
					input.authEncoding ?? providerCredentialProfile?.authEncoding,
			};
			const existingCatalog = await getCatalogAppBySlug(db, catalogSlug);
			let catalogApp = existingCatalog;
			let catalogCreated = false;
			if (!catalogApp && !dryRun) {
				const syncResult = await syncCatalogAppFromStore(db, {
					source: "tedi",
					sourceAppId: `tenant-openapi:${orgId}:${appSlug}`,
					name: input.name,
					description: input.description ?? null,
					modelDescription: input.description ?? null,
					baseUrl: null,
					connectorType: "MCP",
					distributionChannel: "INDIVIDUAL",
					developerType: "TRUSTED_PARTNER",
					status: "ENABLED",
					category: input.category ?? null,
					developer: input.developer ?? organization?.name ?? null,
					website: input.website ?? null,
					logoUrl: input.logoUrl ?? null,
					isDiscoverable: input.catalogDiscoverable ?? false,
					reviewStatus: "RELEASED",
					hasWrites: true,
					hasSync: true,
					authTypes: effectiveConnectionProviderId ? ["API_KEY"] : ["NONE"],
					rawData: toJsonRecord({
						tenantOpenApi: {
							organizationId: orgId,
							appSlug,
							targetAggregatorSlug: targetAggregator.slug,
							connectionProviderId: effectiveConnectionProviderId,
							createdBy: context.user?.sub ?? context.authType,
						},
					}),
				});
				if (!syncResult) {
					throw createError(
						ErrorCodes.INTERNAL_SERVER_ERROR,
						"Failed to create tenant OpenAPI catalog app",
					);
				}
				catalogApp = syncResult.app;
				catalogCreated = syncResult.created;
			}
			if (catalogApp && !dryRun) {
				const updated = await updateCatalogApp(db, catalogApp.id, {
					slug: catalogSlug,
					name: input.name,
					description: input.description ?? catalogApp.description,
					modelDescription: input.description ?? catalogApp.modelDescription,
					category: input.category ?? catalogApp.category,
					developer: input.developer ?? catalogApp.developer,
					website: input.website ?? catalogApp.website,
					logoUrl: input.logoUrl ?? catalogApp.logoUrl,
					isDiscoverable: input.catalogDiscoverable ?? false,
					toolSource: "openapi",
				});
				if (!updated) {
					throw createError(
						ErrorCodes.INTERNAL_SERVER_ERROR,
						"Failed to update tenant OpenAPI catalog app",
					);
				}
				catalogApp = updated;
			}
			const existingSlugOwner = await getAppBySlugForOrg(db, appSlug, orgId);
			if (
				existingSlugOwner &&
				(existingSlugOwner.organizationId !== orgId ||
					existingSlugOwner.sourceAppId)
			) {
				throw createError(
					ErrorCodes.CONFLICT,
					`App slug "${appSlug}" already exists`,
				);
			}
			if (
				existingSlugOwner?.catalogAppId &&
				catalogApp &&
				existingSlugOwner.catalogAppId !== catalogApp.id
			) {
				throw createError(
					ErrorCodes.CONFLICT,
					`App slug "${appSlug}" is already linked to another catalog app`,
				);
			}
			if (connectionProviderPlan && !dryRun) {
				connectionProviderStatus = (
					await upsertConnectionProviderWithId(
						connectionProviderPlan.id,
						connectionProviderPlan.config,
						context.env,
					)
				).status;
			}
			const effectiveConnectionProvider = input.connectionProviderId
				? {
						id: input.connectionProviderId,
						name: input.connectionProviderId,
						type: "api_key" as const,
						status: "existing" as const,
					}
				: connectionProviderPlan
					? {
							id: connectionProviderPlan.id,
							name: connectionProviderPlan.name,
							type: connectionProviderPlan.type,
							status: connectionProviderStatus ?? ("planned" as const),
						}
					: null;
			let baseApp = existingSlugOwner ?? null;
			const openApiInputForMetadata = tenantOpenApiImportInput(
				input,
				baseApp?.id ?? plannedBaseAppId,
				namespace,
				openApiInputOverrides,
			);
			const baseMetadata = openApiSyncMetadataFromInput(
				openApiInputForMetadata,
				baseApp?.metadata,
				providerCredentialProfile,
			);
			let baseCreated = false;
			if (!baseApp && !dryRun) {
				const now = new Date().toISOString();
				baseApp =
					(await createAppWithId(db, {
						id: plannedBaseAppId,
						organizationId: orgId,
						name: input.name,
						slug: appSlug,
						description: input.description ?? null,
						logoUrl: input.logoUrl ?? null,
						visibility: input.visibility,
						discoveryStatus: "pending",
						metadata: baseMetadata,
						catalogAppId: catalogApp?.id ?? null,
						sourceAppId: null,
						createdAt: now,
						updatedAt: now,
					})) ?? null;
				baseCreated = true;
			} else if (baseApp && !dryRun) {
				baseApp =
					(await updateApp(db, baseApp.id, {
						name: input.name,
						description: input.description ?? baseApp.description,
						logoUrl: input.logoUrl ?? baseApp.logoUrl,
						visibility: input.visibility,
						metadata: baseMetadata,
						catalogAppId: catalogApp?.id ?? baseApp.catalogAppId,
						updatedAt: new Date().toISOString(),
					})) ?? baseApp;
			}
			const effectiveCatalogApp = catalogApp ?? {
				id: plannedCatalogId,
				slug: catalogSlug,
				name: input.name,
				toolSource: "openapi",
				isDiscoverable: input.catalogDiscoverable ?? false,
			};
			const effectiveBaseApp = baseApp ?? {
				id: plannedBaseAppId,
				organizationId: orgId,
				name: input.name,
				slug: appSlug,
				catalogAppId: effectiveCatalogApp.id,
			};
			let openApiPreview = null;
			if (dryRun && baseApp) {
				openApiPreview = await previewOpenApiToolImport(db, {
					...tenantOpenApiImportInput(
						input,
						baseApp.id,
						namespace,
						openApiInputOverrides,
					),
					dryRun: true,
				});
			}

			// A new catalog row has no inventory until its generated base-app tools
			// are imported and projected. Do that first so the normal tenant-proxy
			// installer can enforce the same installability checks as every other app.
			if (!dryRun) {
				const initialImport = await executeOpenApiToolImport(db, {
					...tenantOpenApiImportInput(
						input,
						effectiveBaseApp.id,
						namespace,
						openApiInputOverrides,
					),
					dryRun: false,
				});
				if (initialImport.failed > 0) {
					throw createError(
						ErrorCodes.BAD_REQUEST,
						`OpenAPI import failed for tenant app "${appSlug}"`,
					);
				}
				await projectCatalogToolsFromBaseApp(db, effectiveCatalogApp.id);
			}
			const proxyInstall = dryRun
				? ({
						dryRun: true,
						created: true,
						attached: true,
						proxyApp: {
							id: null,
							organizationId: orgId,
							name: input.name,
							slug: proxySlug,
							visibility: input.visibility,
							sourceAppId: effectiveBaseApp.id,
							catalogAppId: effectiveCatalogApp.id,
						},
						targetAggregator: {
							id: targetAggregator.id,
							slug: targetAggregator.slug,
							organizationId: targetAggregator.organizationId,
						},
						baseApp: {
							id: effectiveBaseApp.id,
							slug: effectiveBaseApp.slug,
							name: effectiveBaseApp.name,
						},
						catalogApp: {
							id: effectiveCatalogApp.id,
							slug: effectiveCatalogApp.slug ?? effectiveCatalogApp.id,
							name: effectiveCatalogApp.name,
						},
						aggregateEntry: {
							slug: proxySlug,
							prefix: namespace,
							...(effectiveConnectionProviderId
								? {
										connectionProviderId: effectiveConnectionProviderId,
										connectionScope: input.connectionScope ?? "tenant",
									}
								: {}),
							...(openApiInputOverrides.authScopes?.length
								? {
										connectionScopes: openApiInputOverrides.authScopes,
									}
								: {}),
						},
						toolScopes: input.toolScopes,
						summary: `Dry run: would create proxy "${proxySlug}" and attach it to "${targetAggregator.slug}".`,
					} satisfies TenantMcpInstallResult)
				: await installTenantMcpAppFromCatalog(context, {
						catalogAppId: effectiveCatalogApp.id,
						targetAggregatorSlug: targetAggregator.slug,
						slug: proxySlug,
						name: input.name,
						description: input.description,
						visibility: input.visibility,
						prefix: namespace,
						connectionProviderId: effectiveConnectionProviderId,
						connectionScope: effectiveConnectionProviderId
							? (input.connectionScope ?? "tenant")
							: undefined,
						connectionScopes: openApiInputOverrides.authScopes,
						toolScopes: input.toolScopes,
						dryRun: false,
					});
			const openApiSync = dryRun
				? {
						appId: baseApp?.id ?? null,
						workflowId: null,
						status: "skipped" as const,
						message: baseApp
							? "Dry run: previewed OpenAPI import against existing base app."
							: "Dry run: base app does not exist yet, so OpenAPI import preview was skipped.",
					}
				: await queueOpenApiSyncWorkflow(context, {
						...tenantOpenApiImportInput(
							input,
							effectiveBaseApp.id,
							namespace,
							openApiInputOverrides,
						),
						dryRun: false,
					});
			if (!dryRun) {
				const actor = auditActor(context);
				await emitAuditEvent(db, {
					organizationId: orgId,
					actorId: actor.actorId,
					actorType: actor.actorType,
					action: "catalog.tenant_openapi_mcp_app.created",
					resourceType: "app",
					resourceId: effectiveBaseApp.id,
					metadata: {
						...actor.actorMetadata,
						catalogAppId: effectiveCatalogApp.id,
						catalogAppSlug: effectiveCatalogApp.slug,
						baseAppSlug: effectiveBaseApp.slug,
						proxyAppSlug: proxyInstall.proxyApp.slug,
						targetAggregatorSlug: targetAggregator.slug,
						connectionProviderId: effectiveConnectionProvider?.id,
						connectionProviderStatus: effectiveConnectionProvider?.status,
						openApiWorkflowId: openApiSync.workflowId,
					},
					ipAddress: context.headers.get("CF-Connecting-IP"),
					userAgent: context.headers.get("User-Agent"),
				});
			}
			return {
				dryRun,
				created: {
					catalogApp: catalogCreated || (!existingCatalog && dryRun),
					baseApp: baseCreated || (!existingSlugOwner && dryRun),
					proxyApp: proxyInstall.created,
					connectionProvider:
						effectiveConnectionProvider?.status === "created" ||
						effectiveConnectionProvider?.status === "planned",
				},
				connectionProvider: effectiveConnectionProvider,
				catalogApp: {
					id: effectiveCatalogApp.id,
					slug: effectiveCatalogApp.slug ?? catalogSlug,
					name: effectiveCatalogApp.name,
					source: "tedi" as const,
					toolSource: "openapi" as const,
					isDiscoverable: input.catalogDiscoverable ?? false,
				},
				baseApp: {
					id: effectiveBaseApp.id,
					organizationId: orgId,
					name: effectiveBaseApp.name,
					slug: effectiveBaseApp.slug,
					catalogAppId: effectiveCatalogApp.id,
				},
				proxyInstall,
				openApiPreview,
				openApiSync,
				summary: dryRun
					? `Dry run: would create or refresh tenant OpenAPI app "${appSlug}", catalog row "${catalogSlug}", proxy "${proxySlug}", and attach it to "${targetAggregator.slug}".`
					: `Created or refreshed tenant OpenAPI app "${appSlug}", queued OpenAPI sync, and attached proxy "${proxySlug}" to "${targetAggregator.slug}".`,
			};
		});

// =============================================================================
// CHANGELOG PROCEDURE IMPLEMENTATIONS
// =============================================================================

/**
 * Get changelog for a specific app
 * GET /catalog/apps/:id/changelog
 */

// =============================================================================
// CHANGELOG PROCEDURE IMPLEMENTATIONS
// =============================================================================

/**
 * Get changelog for a specific app
 * GET /catalog/apps/:id/changelog
 */
export const getAppChangelogCatalog = fleetCatalogOs.getAppChangelog
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { id, limit = 50 } = input;
		const changes = await getCatalogAppChanges(db, id, limit);
		return {
			changes: changes.map((c) => ({
				id: c.id,
				catalogAppId: c.catalogAppId,
				changeType: c.changeType as
					| "added"
					| "removed"
					| "updated"
					| "version_bump",
				fieldName: c.fieldName ?? null,
				oldValue: c.oldValue ?? null,
				newValue: c.newValue ?? null,
				versionBefore: c.versionBefore ?? null,
				versionAfter: c.versionAfter ?? null,
				detectedAt: c.detectedAt,
				syncLogId: c.syncLogId ?? null,
			})),
			total: changes.length,
		};
	});

/**
 * Get recent changes across all apps
 * GET /catalog/changes/recent
 */

/**
 * Get recent changes across all apps
 * GET /catalog/changes/recent
 */
export const getRecentChangesCatalog = fleetCatalogOs.getRecentChanges
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { limit = 100, changeType } = input;
		const changes = await getRecentCatalogChanges(db, {
			limit,
			changeType,
		});
		return {
			changes: changes.map((c) => ({
				id: c.id,
				catalogAppId: c.catalogAppId,
				changeType: c.changeType as
					| "added"
					| "removed"
					| "updated"
					| "version_bump",
				fieldName: c.fieldName ?? null,
				oldValue: c.oldValue ?? null,
				newValue: c.newValue ?? null,
				versionBefore: c.versionBefore ?? null,
				versionAfter: c.versionAfter ?? null,
				detectedAt: c.detectedAt,
				syncLogId: c.syncLogId ?? null,
			})),
			total: changes.length,
		};
	});

// =============================================================================
// TOOL TESTING PROCEDURE IMPLEMENTATIONS
// =============================================================================

/**
 * Get tool test statistics
 * GET /catalog/tool-test-stats
 */

// =============================================================================
// TOOL TESTING PROCEDURE IMPLEMENTATIONS
// =============================================================================

/**
 * Get tool test statistics
 * GET /catalog/tool-test-stats
 */
export const getToolTestStatsCatalog = fleetCatalogOs.getToolTestStats
	.use(AUTHZ.appsRead)
	.handler(async ({ context }) => {
		const { db } = context;
		return getToolTestStats(db);
	});

/**
 * Get tool test history with filtering
 * GET /catalog/tool-tests
 */

/**
 * Get tool test history with filtering
 * GET /catalog/tool-tests
 */
export const getToolTestsCatalog = fleetCatalogOs.getToolTests
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const {
			catalogAppId,
			toolName,
			testType,
			successOnly,
			limit = 50,
			offset = 0,
		} = input;

		// If catalogAppId provided, get tests for that app
		// If toolName also provided, filter by tool name
		let tests: Awaited<ReturnType<typeof getToolTestsForApp>> = [];
		let total = 0;
		if (catalogAppId) {
			const allTests = await getToolTestsForApp(db, catalogAppId, {
				testType,
				successOnly,
				limit: 1000, // Get more for total count
			});

			// Filter by toolName if provided
			const filteredTests = toolName
				? allTests.filter((t) => t.toolName === toolName)
				: allTests;
			total = filteredTests.length;
			tests = filteredTests.slice(offset, offset + limit);
		} else {
			const latest = await getLatestToolTests(db, {
				testType,
				successOnly,
				toolName,
				limit,
				offset,
			});
			tests = latest.tests;
			total = latest.total;
		}
		return {
			tests: tests.map((test) => ({
				id: test.id,
				catalogAppId: test.catalogAppId,
				toolName: test.toolName,
				testedAt: test.testedAt,
				testType: test.testType as "programmatic" | "ai_eval",
				inputSource: test.inputSource as
					| "schema_generated"
					| "ai_generated"
					| "manual",
				success: test.success,
				latencyMs: test.latencyMs,
				errorMessage: test.errorMessage,
				errorClass: test.errorClass as
					| "validation"
					| "timeout"
					| "auth"
					| "server_error"
					| "unknown"
					| null,
				inputUsed: test.inputUsed as Record<string, unknown> | null,
				outputReceived: test.outputReceived as unknown,
				outputValid: test.outputValid,
				aiModel: test.aiModel,
				aiPromptUsed: test.aiPromptUsed,
				aiToolSelectionCorrect: test.aiToolSelectionCorrect,
				aiOutputQualityScore: test.aiOutputQualityScore,
				aiTokensUsed: test.aiTokensUsed,
			})),
			total,
			pagination: {
				limit,
				offset,
				hasMore: offset + limit < total,
			},
		};
	});

/**
 * Trigger tool test workflow
 * POST /catalog/test-tools
 */

/**
 * Trigger tool test workflow
 * POST /catalog/test-tools
 */
export const triggerToolTestCatalog = fleetCatalogOs.triggerToolTest
	.use(AUTHZ.catalogWrite)
	.handler(async ({ input, context }) => {
		requireCatalogOperatorAccess(context);
		const { db, env } = context;
		const { limit, maxAgeHours, testType, timeout, appIds, toolNames } = input;

		// Get tools needing tests
		const toolsToTest = await getToolsNeedingTest(db, {
			limit,
			maxAgeHours,
			healthyAppsOnly: true,
			catalogAppIds: appIds,
			toolNames,
		});
		if (toolsToTest.length === 0) {
			return {
				success: true,
				toolsQueued: 0,
				workflowInstanceId: undefined,
				message: "No tools need testing at this time",
			};
		}

		// Trigger the Tool Test Workflow
		try {
			const workflow = (
				env as {
					TOOL_TEST_WORKFLOW?: Workflow;
				}
			).TOOL_TEST_WORKFLOW;
			if (!workflow) {
				console.warn("[Catalog] TOOL_TEST_WORKFLOW binding not available");
				return {
					success: true,
					toolsQueued: toolsToTest.length,
					workflowInstanceId: undefined,
					message: `${toolsToTest.length} tools need testing but workflow binding not available`,
				};
			}
			const instance = await workflow.create({
				params: {
					tools: toolsToTest.map((t) => ({
						catalogAppId: t.catalogAppId,
						toolName: t.toolName,
					})),
					testType,
					timeout,
				},
			});
			console.log(
				`[Catalog] Tool test workflow started: ${instance.id} for ${toolsToTest.length} tools`,
			);
			return {
				success: true,
				toolsQueued: toolsToTest.length,
				workflowInstanceId: instance.id,
				message: `Tool test workflow started for ${toolsToTest.length} tools (type: ${testType})`,
			};
		} catch (error) {
			console.error("[Catalog] Failed to start tool test workflow:", error);
			return {
				success: false,
				toolsQueued: 0,
				workflowInstanceId: undefined,
				message: `Failed to start tool test workflow: ${error instanceof Error ? error.message : "Unknown error"}`,
			};
		}
	});

// =============================================================================
// DRIFT REPORTS
// =============================================================================

export // =============================================================================
// DRIFT REPORTS
// =============================================================================

const getDriftReportsCatalog = fleetCatalogOs.getDriftReports
	.use(withAuthorization("apps:read", "catalog:manage"))
	.handler(async ({ input, context }) => {
		const { db } = context;
		const reports = await getLatestDriftReports(db, {
			catalogAppId: input.catalogAppId,
		});
		return {
			reports: reports.map((r) => ({
				id: r.id,
				catalogAppId: r.catalogAppId,
				catalogAppName: r.catalogAppName,
				addedTools: r.addedTools,
				removedTools: r.removedTools,
				changedTools: r.changedTools,
				summary: r.summary,
				checkedAt: r.checkedAt,
				resolvedAt: r.resolvedAt ?? null,
			})),
		};
	});

export const backfillToolProvenanceCatalog =
	fleetCatalogOs.backfillToolProvenance
		.use(AUTHZ.catalogWrite)
		.handler(async ({ input, context }) => {
			requireCatalogOperatorAccess(context);
			return backfillCatalogToolProvenance(context.db, input);
		});

export const checkIntegrityCatalog = fleetCatalogOs.checkIntegrity
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		if (input.apply) {
			requireCatalogOperatorAccess(context);
		}
		return runCatalogIntegrityMaintenance(context.db, context.env.DB, input);
	});

// =============================================================================
// TEMPLATE PROPAGATION
// =============================================================================

/**
 * Catalog-driven app_tools rewrites can add/remove/change tool rows, the
 * derived ui:// widget resources, and prompt-type rows in one pass, so
 * affected apps get all three list_changed notifications.
 */

export /**
 * Propagate tools from a base app to explicit custom forks.
 * POST /catalog/propagate-tools
 *
 * NOTE: Do not target tenant/project proxy apps. Proxies keep zero app_tools rows
 * and inherit through aggregateApps.
 */
const propagateToolsCatalog = fleetCatalogOs.propagateTools
	.use(AUTHZ.catalogWrite)
	.handler(async ({ input, context }) => {
		requireCatalogOperatorAccess(context);
		const { db } = context;
		const { sourceAppId, appIds, applyTypes, preserveFields, dryRun } = input;
		let result: Awaited<ReturnType<typeof propagateTools>>;
		try {
			result = await propagateTools(db, {
				sourceAppId,
				appIds,
				applyTypes,
				preserveFields,
				dryRun,
			});
		} catch (error) {
			if (error instanceof CatalogProxyAppToolMutationError) {
				throw createError(ErrorCodes.BAD_REQUEST, error.message);
			}
			throw error;
		}
		const changedAppIds = propagationChangedAppIds(result);
		if (changedAppIds.length > 0) {
			publishMcpListChangedEventsSoon(
				context.waitUntil,
				context.env,
				{
					appIds: changedAppIds,
				},
				CATALOG_APP_INVENTORY_METHODS,
			);
		}
		return result;
	});

// =============================================================================
// FORK CATALOG TOOLS (catalog → base/custom app tool rows)
// =============================================================================

export // =============================================================================
// FORK CATALOG TOOLS (catalog → base/custom app tool rows)
// =============================================================================

const syncCatalogToolsToAppCatalog = fleetCatalogOs.syncCatalogToolsToApp
	.use(AUTHZ.catalogWrite)
	.handler(async ({ input, context }) => {
		requireCatalogOperatorAccess(context);
		const { db } = context;
		try {
			const result = await syncCatalogToolsToApp(db, input);
			if (!result.dryRun) {
				publishMcpListChangedEventsSoon(
					context.waitUntil,
					context.env,
					{
						appId: result.appId,
					},
					CATALOG_APP_INVENTORY_METHODS,
				);
			}
			return result;
		} catch (error) {
			if (error instanceof CatalogProxyAppToolMutationError) {
				throw createError(ErrorCodes.BAD_REQUEST, error.message);
			}
			throw error;
		}
	});

// =============================================================================
// OPENAPI IMPORT (catalog-owned REST projection)
// =============================================================================

export // =============================================================================
// OPENAPI IMPORT (catalog-owned REST projection)
// =============================================================================

const previewOpenApiImportCatalog = tenantCatalogOs.previewOpenApiImport
	.use(AUTHZ.catalogWrite)
	.handler(async ({ input, context }) => {
		await requireOpenApiImportAccess(context, input);
		return previewOpenApiToolImport(context.db, {
			...input,
			dryRun: true,
		});
	});

export const runOpenApiImportCatalog = fleetCatalogOs.runOpenApiImport
	.use(AUTHZ.catalogWrite)
	.handler(async ({ input, context }) => {
		await requireOpenApiImportAccess(context, input);
		return queueOpenApiSyncWorkflow(context, input);
	});

// =============================================================================
// RECONCILE CATALOG APP (one-shot lifecycle)
// =============================================================================
