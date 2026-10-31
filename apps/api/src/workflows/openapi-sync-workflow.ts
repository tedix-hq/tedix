/**
 * OpenApiSyncWorkflow
 *
 * Durable refresh path for external REST app_tools generated from OpenAPI
 * specs. Apps opt in through metadata.mcpConfig.openApiSync.
 */

import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import type {
	OpenApiImportInput,
	OpenApiImportResult,
} from "@tedix/api-contract/schemas/catalog";
import { createDbClient } from "@tedix/db/client";
import { getAppById } from "@tedix/db/queries/app-records";
import {
	getAppMetadataById,
	getLinkedOpenApiCatalogSnapshot,
	listApiSyncApps,
} from "@tedix/db/queries/apps";
import { projectCatalogToolsFromBaseApp } from "@tedix/db/queries/catalog/mcp-tools";
import { publishMcpListChangedEvents } from "../lib/mcp-subscriptions";
import { runGoogleDiscoveryToolImport } from "../services/google-discovery-tool-import";
import { executeOpenApiToolImport } from "../services/openapi-tool-import";

export type OpenApiSyncWorkflowInput = Partial<OpenApiImportInput> & {
	appIds?: string[];
	limit?: number;
	source?: "openapi" | "google-discovery";
};

async function projectLinkedOpenApiCatalogSnapshot(
	db: ReturnType<typeof createDbClient>,
	appId: string,
) {
	const linked = await getLinkedOpenApiCatalogSnapshot(db, appId);

	if (!linked?.catalogAppId || linked.toolSource !== "openapi") return null;
	return projectCatalogToolsFromBaseApp(db, linked.catalogAppId);
}

function parseMetadata(raw: unknown): { mcpConfig?: Record<string, unknown> } {
	if (!raw) return {};
	if (typeof raw === "object" && !Array.isArray(raw)) {
		return raw as { mcpConfig?: Record<string, unknown> };
	}
	if (typeof raw !== "string") return {};
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as { mcpConfig?: Record<string, unknown> })
			: {};
	} catch {
		return {};
	}
}

export class OpenApiSyncWorkflow extends WorkflowEntrypoint<
	CloudflareEnv,
	OpenApiSyncWorkflowInput
> {
	async run(
		event: WorkflowEvent<OpenApiSyncWorkflowInput>,
		step: WorkflowStep,
	) {
		const db = createDbClient(this.env.DB);
		const payload = event.payload ?? {};
		const appIds = await step.do("plan openapi app sync", async () => {
			const appIds = payload.appIds
				? payload.appIds
				: payload.appId
					? [payload.appId]
					: (
							await listApiSyncApps(db, {
								source: payload.source,
								limit: payload.limit,
							})
						).map((app) => app.id);

			return [...new Set(appIds)];
		});
		const results: OpenApiImportResult[] = [];
		const projections = [];
		for (const [index, appId] of appIds.entries()) {
			let result: OpenApiImportResult | undefined;
			try {
				result = await step.do(`import openapi app ${index}`, async () => {
					const appMetadata = await getAppMetadataById(db, appId);
					const mcpConfig = parseMetadata(appMetadata).mcpConfig;
					const useGoogleDiscovery =
						payload.source === "google-discovery" ||
						(payload.source !== "openapi" &&
							mcpConfig?.googleDiscoverySync &&
							typeof mcpConfig.googleDiscoverySync === "object" &&
							(mcpConfig.googleDiscoverySync as { enabled?: unknown })
								.enabled === true);
					return useGoogleDiscovery
						? ((await runGoogleDiscoveryToolImport(db, {
								appId,
								dryRun: payload.dryRun ?? false,
								limit: payload.limit,
							})) as unknown as OpenApiImportResult)
						: await executeOpenApiToolImport(
								db,
								payload.appId === appId
									? ({
											...payload,
											appId,
											dryRun: payload.dryRun ?? false,
										} as OpenApiImportInput)
									: {
											appId,
											dryRun: payload.dryRun ?? false,
										},
							);
				});
				if (!result.dryRun) {
					const projection = await step.do(`project openapi app ${index}`, () =>
						projectLinkedOpenApiCatalogSnapshot(db, appId),
					);
					if (projection) projections.push(projection);

					// Applied app_tools rewrites change tools/list and the derived
					// ui:// widget resources for live MCP subscribers.
					if (result.created + result.updated + result.deleted > 0) {
						await step.do(`notify openapi app ${index}`, async () => {
							const app = await getAppById(db, appId);
							if (!app)
								throw new Error(`Imported app ${appId} no longer exists`);
							await publishMcpListChangedEvents(
								this.env,
								{
									appId,
									appResolutionKeys: [
										`mcp-subdomain:${app.slug}`,
										...(app.customMcpDomain
											? [`custom:${app.customMcpDomain}`]
											: []),
									],
								},
								[
									"notifications/tools/list_changed",
									"notifications/resources/list_changed",
								],
							);
						});
					}
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				result = await step.do(
					`record failed openapi app ${index}`,
					async () =>
						({
							appId,
							dryRun: payload.dryRun ?? false,
							totalOperations: 0,
							planned: 0,
							created: 0,
							updated: 0,
							deleted: 0,
							inSync: 0,
							skipped: 0,
							...result,
							failed: (result?.failed ?? 0) + 1,
							items: [
								...(result?.items ?? []),
								{
									toolId: "*",
									operationId: null,
									method: "*",
									path: "*",
									status: "failed",
									message,
								},
							],
						}) satisfies OpenApiImportResult,
				);
			}
			results.push(result);
		}
		const failedApps = results.filter((result) => result.failed > 0).length;
		return {
			status:
				failedApps === 0
					? "succeeded"
					: failedApps === results.length
						? "failed"
						: "partial",
			failedApps,
			apps: results.length,
			created: results.reduce((sum, result) => sum + result.created, 0),
			updated: results.reduce((sum, result) => sum + result.updated, 0),
			deleted: results.reduce((sum, result) => sum + result.deleted, 0),
			inSync: results.reduce((sum, result) => sum + result.inSync, 0),
			failed: results.reduce((sum, result) => sum + result.failed, 0),
			projections: projections.map((projection) => ({
				catalogAppId: projection.catalogAppId,
				sourceAppId: projection.sourceAppId,
				activeTools: projection.activeTools,
				added: projection.added,
				updated: projection.updated,
				removed: projection.removed,
			})),
			results,
		};
	}
}
