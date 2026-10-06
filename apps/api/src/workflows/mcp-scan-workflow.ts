/**
 * McpScanWorkflow - Cloudflare Workflow for daily MCP scans
 *
 * Orchestrates scans for apps in the catalog:
 * 1. Fetch apps needing scans from D1
 * 2. Connect directly to MCP servers using the lib/mcp-client
 * 3. Update catalog app health metrics
 * 4. Insert health history records
 * 5. Sync discovered MCP tools, resources, resource templates, and prompts
 *
 * Uses direct MCP client instead of Agents SDK to avoid:
 * - State management issues from workflow context
 * - "Missing namespace or room headers" errors
 * - "Server state never appeared after connection" issues
 *
 * @see https://developers.cloudflare.com/workflows/
 * @see apps/api/src/lib/mcp-client.ts for the direct MCP client
 */

import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import { createDbClient } from "@tedix/db/client";
import { listBaseAppsForCatalogApp } from "@tedix/db/queries/apps";
import {
	resolveDriftReport,
	saveDriftReport,
} from "@tedix/db/queries/catalog/drift-reports";
import { hashMcpEndpoint } from "@tedix/db/queries/catalog/endpoint-normalization";
import { insertCatalogHealthHistory } from "@tedix/db/queries/catalog/health-history";
import {
	getCatalogAppsNeedingScan,
	getCatalogScanBacklogSummary,
	type McpScanResult,
	updateCatalogAppHealthMetrics,
} from "@tedix/db/queries/catalog/health-metrics";
import {
	projectCatalogToolsFromBaseApp,
	syncCatalogMcpPrompts,
	syncCatalogMcpResources,
	syncCatalogMcpResourceTemplates,
	syncCatalogMcpTools,
} from "@tedix/db/queries/catalog/mcp-tools";
import { syncCatalogMcpSkills } from "@tedix/db/queries/catalog/mcp-skills";
import { syncCatalogToolsToApp } from "@tedix/db/queries/catalog/sync-tools-to-app";
import {
	isTedixHostedMcpEndpoint,
	shouldProjectCatalogToolsFromBaseApp,
} from "@tedix/db/queries/catalog/tool-source-policy";
import {
	completeWorkflowRunRecord,
	createWorkflowRunRecord,
} from "@tedix/db/queries/workflow-runs";
import type {
	CatalogToolSource,
	ErrorClass,
	HealthStatus,
	TransportType,
} from "@tedix/db/schema/catalog";
import { toJsonRecord } from "@tedix/db/utils/json";
import {
	getOrCreateCatalogVectorClient,
	upsertCatalogApp,
} from "@tedix/db/vector/catalog";
import {
	isTedixControlMcpEndpoint,
	isTedixTenantMcpEndpoint,
	resolveTedixInternalScanHeaders,
} from "../lib/catalog-internal-scan";
import { connectMcpServer, type McpSkillManifest } from "../lib/mcp-client";
import { publishMcpCatalogInventoryEvents } from "../lib/mcp-subscriptions";
import { exchangeScanClientCredentials } from "./mcp-scan-auth";
import {
	runMcpScanBatchConcurrently,
	summarizeMcpScanThroughput,
} from "./mcp-scan-concurrency";
import {
	classifySuccessfulMcpScan,
	getMcpScanWorkflowListTruncation,
	isScanListAuthoritative,
	MCP_SCAN_WORKFLOW_LIST_LIMITS,
	type McpScanInventoryList,
	type McpScanListTruncation,
} from "./mcp-scan-diagnostics";
import { isRecord } from "@tedix/api-contract/utils/is-record";

// ============================================================================
// Types
// ============================================================================

export interface McpScanWorkflowParams {
	/** Max apps to scan in this run (default: 50) */
	limit?: number;
	/** Max age in hours before re-scanning (default: 24) */
	maxAgeHours?: number;
	/** Timeout per scan in ms (default: 30000) */
	timeout?: number;
	/** Force rescan specific apps regardless of age */
	catalogAppIds?: string[];
}

/** Minimal app info needed for scanning - keeps step output small */
interface AppScanInfo {
	id: string;
	name: string;
	baseUrl: string | null;
	mcpEndpointNormalized: string;
	mcpEndpointHash: string;
	toolSource: CatalogToolSource;
	healthStatus?: HealthStatus | null;
	scanAuthHeaders?: string | null; // Encrypted auth headers (snapshot, may expire)
	scanConnectionId?: string | null; // Vault connection ID for fresh token resolution
	scanConnectionHeader?: string | null;
	scanConnectionTemplate?: string | null;
	scanOrganizationId?: string | null;
	// When set, exchange the vault-resolved `client_id:client_secret` for a fresh
	// Bearer at this OAuth2 token endpoint (client_credentials) before templating.
	scanClientCredentialsTokenUrl?: string | null;
	// Existing protocol feature values (for preserving across failed scans)
	protocolVersion?: string | null;
	supportsResources?: boolean | null;
	supportsPrompts?: boolean | null;
	supportsSampling?: boolean | null;
	supportsRoots?: boolean | null;
}

function internalScanHeaders(
	app: AppScanInfo,
	env: CloudflareEnv,
): Record<string, string> | undefined {
	const token = (env as CloudflareEnv & { PLATFORM_SERVICE_TOKEN?: string })
		.PLATFORM_SERVICE_TOKEN;
	const headers = resolveTedixInternalScanHeaders({
		endpoint: app.mcpEndpointNormalized,
		platformServiceToken: token,
	});
	if (
		!headers &&
		!token &&
		isTedixControlMcpEndpoint(app.mcpEndpointNormalized)
	) {
		console.warn(
			`[MCP Scan] Tedix control-plane scan requested for ${app.name}, but PLATFORM_SERVICE_TOKEN is not configured`,
		);
	}
	return headers;
}

type ScanTool = NonNullable<McpScanResult["tools"]>[number];
type ScanResource = NonNullable<McpScanResult["resources"]>[number];
type ScanResourceTemplate = NonNullable<
	McpScanResult["resourceTemplates"]
>[number];

type ScanResultWithCompleteness = McpScanResult & {
	skills?: McpSkillManifest[];
	listsTruncated?: McpScanListTruncation;
};

interface BatchResult {
	batchIndex: number;
	durationMs: number;
	checked: number;
	healthy: number;
	unhealthy: number;
	blocked: number;
	errors: string[];
}

interface CatalogBaseAppRow {
	id: string;
	name: string;
	metadata: unknown;
}

function parseMetadata(metadata: unknown): Record<string, unknown> | null {
	if (typeof metadata === "string") {
		try {
			const parsed = JSON.parse(metadata);
			return parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: null;
		} catch {
			return null;
		}
	}
	return metadata && typeof metadata === "object" && !Array.isArray(metadata)
		? (metadata as Record<string, unknown>)
		: null;
}

function catalogBaseAppAutoSyncEnabled(metadata: unknown): boolean {
	const parsed = parseMetadata(metadata);
	const mcpConfig =
		parsed?.mcpConfig && typeof parsed.mcpConfig === "object"
			? (parsed.mcpConfig as Record<string, unknown>)
			: null;
	return mcpConfig?.autoSync !== false;
}

interface PublicMcpManifest {
	url: string;
	name?: string;
	version?: string;
	protocolVersion?: string;
	description?: string;
	tools: ScanTool[];
	resources: ScanResource[];
	prompts: NonNullable<McpScanResult["prompts"]>;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

function manifestUrlCandidates(endpoint: string): string[] {
	const candidates = new Set<string>();
	const endpointUrl = new URL(endpoint);
	candidates.add(new URL("/.well-known/mcp.json", endpointUrl.origin).href);

	if (endpointUrl.pathname !== "/") {
		const pathBase = new URL(endpointUrl.href);
		if (!pathBase.pathname.endsWith("/")) {
			pathBase.pathname = `${pathBase.pathname}/`;
		}
		candidates.add(new URL(".well-known/mcp.json", pathBase).href);
	}

	return Array.from(candidates);
}

function parsePublicMcpManifest(
	url: string,
	payload: unknown,
): PublicMcpManifest | null {
	if (!isRecord(payload)) return null;

	const rawTools = Array.isArray(payload.tools) ? payload.tools : [];
	const tools = rawTools.filter(isRecord).reduce<ScanTool[]>((acc, tool) => {
		const name = stringValue(tool.name);
		if (!name) return acc;
		const inputSchema = isRecord(tool.inputSchema)
			? tool.inputSchema
			: undefined;
		const outputSchema = isRecord(tool.outputSchema)
			? tool.outputSchema
			: undefined;
		acc.push({
			name,
			title: stringValue(tool.title),
			description: stringValue(tool.description),
			inputSchema,
			outputSchema,
			_meta: {
				"com.tedix/source": "mcp-manifest",
				"com.tedix/manifestUrl": url,
			},
		});
		return acc;
	}, []);

	const rawResources = Array.isArray(payload.resources)
		? payload.resources
		: [];
	const resources = rawResources
		.filter(isRecord)
		.reduce<ScanResource[]>((acc, resource) => {
			const uri = stringValue(resource.uri);
			if (!uri) return acc;
			acc.push({
				uri,
				name: stringValue(resource.name),
				title: stringValue(resource.title),
				description: stringValue(resource.description),
				mimeType: stringValue(resource.mimeType),
				_meta: {
					"com.tedix/source": "mcp-manifest",
					"com.tedix/manifestUrl": url,
				},
			});
			return acc;
		}, []);

	const rawPrompts = Array.isArray(payload.prompts) ? payload.prompts : [];
	const prompts = rawPrompts
		.filter(isRecord)
		.reduce<NonNullable<McpScanResult["prompts"]>>((acc, prompt) => {
			const name = stringValue(prompt.name);
			if (!name) return acc;
			const rawArguments = Array.isArray(prompt.arguments)
				? prompt.arguments
				: [];
			acc.push({
				name,
				description: stringValue(prompt.description),
				arguments: rawArguments.filter(isRecord).map((argument) => ({
					name: stringValue(argument.name) ?? "argument",
					description: stringValue(argument.description),
					required:
						typeof argument.required === "boolean"
							? argument.required
							: undefined,
				})),
			});
			return acc;
		}, []);

	if (tools.length === 0 && resources.length === 0 && prompts.length === 0) {
		return null;
	}

	return {
		url,
		name: stringValue(payload.name),
		version: stringValue(payload.version),
		protocolVersion:
			stringValue(payload.mcp_version) ?? stringValue(payload.protocolVersion),
		description: stringValue(payload.description),
		tools,
		resources,
		prompts,
	};
}

async function fetchPublicMcpManifest(
	endpoint: string,
	timeoutMs: number,
): Promise<PublicMcpManifest | null> {
	const manifestTimeoutMs = Math.min(timeoutMs, 5000);
	for (const url of manifestUrlCandidates(endpoint)) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), manifestTimeoutMs);
		try {
			const response = await fetch(url, {
				headers: {
					Accept: "application/json",
					"User-Agent": "tedix-mcp-scanner/1.0",
				},
				signal: controller.signal,
			});
			if (!response.ok) continue;
			const manifest = parsePublicMcpManifest(url, await response.json());
			if (manifest) return manifest;
		} catch (error) {
			console.warn(
				`[MCP Scan] Failed to read public MCP manifest at ${url}: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			clearTimeout(timeout);
		}
	}
	return null;
}

function scanResultFromPublicManifest(
	base: Omit<McpScanResult, "capabilities" | "instructions">,
	manifest: PublicMcpManifest,
): McpScanResult {
	return {
		...base,
		serverName: manifest.name,
		serverVersion: manifest.version,
		capabilities: {
			manifestUrl: manifest.url,
			manifestDeclared: true,
		},
		instructions: manifest.description,
		toolCount: manifest.tools.length,
		resourceCount: manifest.resources.length,
		promptCount: manifest.prompts.length,
		resourceTemplateCount: 0,
		tools: manifest.tools,
		resources: manifest.resources,
		resourceTemplates: [],
		prompts: manifest.prompts,
		protocolVersion: manifest.protocolVersion,
		supportsResources: manifest.resources.length > 0,
		supportsPrompts: manifest.prompts.length > 0,
	};
}

// ============================================================================
// Workflow Implementation
// ============================================================================

export class McpScanWorkflow extends WorkflowEntrypoint<
	CloudflareEnv,
	McpScanWorkflowParams
> {
	/** Maximum concurrent endpoint work; workflow batches remain sequential. */
	private readonly BATCH_SIZE = 5;

	async run(event: WorkflowEvent<McpScanWorkflowParams>, step: WorkflowStep) {
		const payload = event.payload ?? {};
		const {
			limit = 25,
			maxAgeHours = 24,
			timeout = 30000,
			catalogAppIds,
		} = payload;

		console.log(
			`[MCP Scan] Starting workflow: limit=${limit}, maxAgeHours=${maxAgeHours}, timeout=${timeout}ms` +
				(catalogAppIds?.length
					? `, catalogAppIds=${catalogAppIds.length}`
					: ""),
		);

		const db = createDbClient(this.env.DB);
		const ledgerId = await step.do("record workflow start", async () => {
			const ledger = await createWorkflowRunRecord(db, {
				workflowType: "mcp_scan",
				workflowId: event.instanceId,
				trigger: catalogAppIds?.length ? "operator" : "cron",
				target:
					catalogAppIds?.length === 1
						? catalogAppIds[0]
						: catalogAppIds?.length
							? `${catalogAppIds.length} catalog apps`
							: null,
			});
			return ledger.id;
		});

		try {
			// Step 1: Fetch apps needing scans (minimal fields to avoid 1MiB limit)
			const appsJson = await step.do(
				"fetch-apps-needing-scan",
				{
					retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
					timeout: "2 minutes",
				},
				async () => {
					const fullApps = await getCatalogAppsNeedingScan(db, {
						limit,
						maxAgeHours,
						catalogAppIds,
					});

					// Extract only the fields needed for scanning (avoids 1MiB step output limit)
					// Compute missing endpoint hashes on the fly instead of silently dropping apps
					const minimalApps: AppScanInfo[] = [];
					for (const app of fullApps) {
						if (!app.mcpEndpointNormalized) continue;
						const hash =
							app.mcpEndpointHash ??
							(await hashMcpEndpoint(app.mcpEndpointNormalized));
						minimalApps.push({
							id: app.id,
							name: app.name,
							baseUrl: app.baseUrl ?? null,
							mcpEndpointNormalized: app.mcpEndpointNormalized,
							mcpEndpointHash: hash,
							toolSource: app.toolSource,
							healthStatus: app.healthStatus ?? null,
							scanAuthHeaders: app.scanAuthHeaders ?? null,
							scanConnectionId: app.scanConnectionId ?? null,
							scanConnectionHeader: app.scanConnectionHeader ?? null,
							scanConnectionTemplate: app.scanConnectionTemplate ?? null,
							scanOrganizationId: app.scanOrganizationId ?? null,
							scanClientCredentialsTokenUrl:
								app.scanClientCredentialsTokenUrl ?? null,
							protocolVersion: app.protocolVersion ?? null,
							supportsResources: app.supportsResources ?? null,
							supportsPrompts: app.supportsPrompts ?? null,
							supportsSampling: app.supportsSampling ?? null,
							supportsRoots: app.supportsRoots ?? null,
						});
					}

					console.log(
						`[MCP Scan] Found ${minimalApps.length} apps needing scan (${fullApps.length} total, filtered for valid endpoints)`,
					);
					return JSON.stringify(minimalApps);
				},
			);

			const apps = JSON.parse(appsJson as string) as AppScanInfo[];

			if (apps.length === 0) {
				const scanBacklog = await step.do("summarize-scan-backlog", async () =>
					getCatalogScanBacklogSummary(db, {
						maxAgeHours,
					}),
				);
				console.log(
					`[MCP Scan] No actionable apps need scans; stale=${scanBacklog.staleOver24h}, skipped auth=${scanBacklog.skippedRequiresAuth}, skipped blocked=${scanBacklog.skippedBlocked}`,
				);
				const result = {
					success: true,
					message: "No actionable apps need scans",
					appsChecked: 0,
					scanBacklog,
				};
				await step.do("record workflow completion", async () => {
					await completeWorkflowRunRecord(db, ledgerId, {
						status: "completed",
						totalCount: 0,
						successCount: 0,
						errorCount: 0,
						output: toJsonRecord(result),
					});
				});
				return result;
			}

			// Step 2: Process apps in batches
			const batches = this.splitIntoBatches(apps);
			const batchResults: BatchResult[] = [];

			console.log(
				`[MCP Scan] Processing ${batches.length} batches of up to ${this.BATCH_SIZE} apps`,
			);

			for (let i = 0; i < batches.length; i++) {
				const batch = batches[i];
				if (!batch || batch.length === 0) continue;

				const batchResult = await step.do(
					`scan-batch-${i}`,
					{
						retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
						timeout: "5 minutes",
					},
					async () => {
						return this.processBatch(i, batch, timeout);
					},
				);

				batchResults.push(batchResult as BatchResult);

				const result = batchResult as BatchResult;
				console.log(
					`[MCP Scan] Batch ${i + 1}/${batches.length}: ${result.checked} scanned, ${result.healthy} healthy, ${result.unhealthy} unhealthy, ${result.blocked} blocked`,
				);
			}

			// Aggregate results
			const totalChecked = batchResults.reduce((sum, r) => sum + r.checked, 0);
			const totalHealthy = batchResults.reduce((sum, r) => sum + r.healthy, 0);
			const totalUnhealthy = batchResults.reduce(
				(sum, r) => sum + r.unhealthy,
				0,
			);
			const totalBlocked = batchResults.reduce((sum, r) => sum + r.blocked, 0);
			const totalErrors = batchResults.reduce(
				(sum, r) => sum + r.errors.length,
				0,
			);
			const allErrors = batchResults.flatMap((r) => r.errors);
			const scanBacklog = await step.do(
				"summarize-scan-backlog-after-run",
				async () =>
					getCatalogScanBacklogSummary(db, {
						maxAgeHours,
					}),
			);

			console.log(
				`[MCP Scan] Workflow complete: ${totalChecked} scanned, ${totalHealthy} healthy, ${totalUnhealthy} unhealthy, ${totalBlocked} blocked, ${totalErrors} errors`,
			);

			const throughput = summarizeMcpScanThroughput({
				batchConcurrency: this.BATCH_SIZE,
				batchDurationsMs: batchResults.map((batch) => batch.durationMs),
				checked: totalChecked,
				dueNow: scanBacklog.dueNow,
			});
			const result = {
				success: true,
				appsChecked: totalChecked,
				healthy: totalHealthy,
				unhealthy: totalUnhealthy,
				blocked: totalBlocked,
				errors: totalErrors,
				errorDetails: allErrors.slice(0, 20), // Keep first 20 errors
				batches: batches.length,
				scanBacklog,
				throughput,
			};
			await step.do("record workflow completion", async () => {
				await completeWorkflowRunRecord(db, ledgerId, {
					status: "completed",
					totalCount: totalChecked,
					successCount: totalChecked - totalErrors,
					errorCount: totalErrors,
					output: toJsonRecord({
						summary: `${totalChecked} app(s) scanned: ${totalHealthy} healthy/degraded, ${totalUnhealthy} unhealthy, ${totalBlocked} blocked, ${totalErrors} error(s).`,
						healthy: totalHealthy,
						unhealthy: totalUnhealthy,
						blocked: totalBlocked,
						batches: batches.length,
						scanBacklog,
						throughput,
						errorDetails: allErrors.slice(0, 20),
					}),
				});
			});
			return result;
		} catch (error) {
			await step.do("record workflow failure", async () => {
				await completeWorkflowRunRecord(db, ledgerId, {
					status: "failed",
					error: error instanceof Error ? error.message : String(error),
				});
			});
			throw error;
		}
	}

	// ==========================================================================
	// Step Implementations
	// ==========================================================================

	/**
	 * Split apps into batches for rate limiting
	 */
	private splitIntoBatches(apps: AppScanInfo[]): AppScanInfo[][] {
		const batches: AppScanInfo[][] = [];
		for (let i = 0; i < apps.length; i += this.BATCH_SIZE) {
			batches.push(apps.slice(i, i + this.BATCH_SIZE));
		}
		return batches;
	}

	/**
	 * Process a batch of apps using direct MCP client
	 */
	private async processBatch(
		batchIndex: number,
		apps: AppScanInfo[],
		timeout: number,
	): Promise<BatchResult> {
		const startedAt = Date.now();
		const db = createDbClient(this.env.DB);
		let checked = 0;
		let healthy = 0;
		let unhealthy = 0;
		let blocked = 0;
		const errors: string[] = [];

		await runMcpScanBatchConcurrently(apps, async (app) => {
			try {
				// A runnable first-party MCP endpoint is the protocol and health source of
				// truth. The old projection shortcut retained its base-app inventory but
				// could never observe a protocol upgrade or successful authentication.
				// Non-hosted generated catalogs still project from their owning base app.
				const result = isTedixHostedMcpEndpoint(app.mcpEndpointNormalized)
					? await this.scanApp(app, timeout)
					: shouldProjectCatalogToolsFromBaseApp(app)
						? await this.projectApp(app, db)
						: await this.scanApp(app, timeout);

				// Update health metrics in D1
				await updateCatalogAppHealthMetrics(db, app.id, result);

				// Insert health history record
				await insertCatalogHealthHistory(db, {
					catalogAppId: app.id,
					checkedAt: result.checkedAt,
					status: result.status,
					connectTimeMs: result.connectTimeMs ?? null,
					totalTimeMs: result.totalTimeMs ?? null,
					transportUsed: result.transportUsed ?? null,
					authState: result.authState ?? null,
					serverVersion: result.serverVersion ?? null,
					toolCount: result.toolCount ?? null,
					resourceCount: result.resourceCount ?? null,
					promptCount: result.promptCount ?? null,
					errorMessage: result.errorMessage ?? null,
					errorClass: result.errorClass ?? null,
				});

				// Sync MCP tools/resources/prompts when a scan returned an
				// authoritative list. Empty arrays intentionally mark stale rows removed.
				//
				// ...but ONLY when the scan was actually authorized. A credential-starved
				// scan is not authoritative about inventory: when `initialize` succeeds and
				// `tools/list` 401s, the client returns `tools: []` (partialAuth), and the
				// "empty array = authoritative removal" rule above would read that as "the
				// server has no tools" and soft-remove EVERY row. `syncCatalogMcpTools`
				// also defaults to mode "full", which re-normalizes a missing inputSchema
				// to EMPTY_TOOL_INPUT_SCHEMA — so a degraded auth response can silently
				// replace good schemas with `{properties:{}}` for every org consuming this
				// global catalog app. Skip the write and leave the last known-good
				// inventory in place; health columns above still record `requires_auth`.
				const listsTruncated = (result as ScanResultWithCompleteness)
					.listsTruncated;
				const authoritative = (list: McpScanInventoryList) =>
					isScanListAuthoritative(result.status, list, listsTruncated);
				if (listsTruncated && Object.values(listsTruncated).some(Boolean)) {
					console.warn(
						`[McpScan] ${app.name} (${app.id}): one or more MCP lists were incomplete; preserving their last-known inventory.`,
					);
				}
				if (Array.isArray(result.tools) && authoritative("tools")) {
					const toolSync = await syncCatalogMcpTools(db, app.id, result.tools);
					if (toolSync.drifts.length > 0) {
						const parts: string[] = [];
						if (toolSync.added) parts.push(`${toolSync.added} added`);
						if (toolSync.removed) parts.push(`${toolSync.removed} removed`);
						if (toolSync.updated) parts.push(`${toolSync.updated} changed`);
						await saveDriftReport(db, {
							catalogAppId: app.id,
							catalogAppName: app.name,
							addedTools: toolSync.added,
							removedTools: toolSync.removed,
							changedTools: toolSync.updated,
							drifts: toolSync.drifts,
							summary: `Drift detected for ${app.name}: ${parts.join(", ")}`,
						});
						if (app.toolSource === "upstream_mcp") {
							await this.syncAutoSyncBaseApps(db, app);
						}
					} else {
						await resolveDriftReport(db, app.id);
					}
				}

				let resourceListChanged = false;
				let promptListChanged = false;
				// Same authority rule as tools: an auth-gated list is not evidence of
				// absence, so it must not soft-remove the existing inventory.
				if (Array.isArray(result.resources) && authoritative("resources")) {
					const resourceSync = await syncCatalogMcpResources(
						db,
						app.id,
						result.resources.map(({ _meta, ...resource }) => ({
							...resource,
							...(_meta == null ? {} : { _meta: toJsonRecord(_meta) }),
						})),
					);
					resourceListChanged =
						resourceSync.added > 0 ||
						resourceSync.updated > 0 ||
						resourceSync.removed > 0;
				}

				if (
					Array.isArray(result.resourceTemplates) &&
					authoritative("resourceTemplates")
				) {
					const templateSync = await syncCatalogMcpResourceTemplates(
						db,
						app.id,
						result.resourceTemplates.map(({ _meta, ...template }) => ({
							...template,
							...(_meta == null ? {} : { _meta: toJsonRecord(_meta) }),
						})),
					);
					resourceListChanged ||=
						templateSync.added > 0 ||
						templateSync.updated > 0 ||
						templateSync.removed > 0;
				}

				if (Array.isArray(result.prompts) && authoritative("prompts")) {
					const promptSync = await syncCatalogMcpPrompts(
						db,
						app.id,
						result.prompts,
					);
					promptListChanged =
						promptSync.added > 0 ||
						promptSync.updated > 0 ||
						promptSync.removed > 0;
				}
				// A skills/list response can be semantically partial even when cursor
				// pagination is exhausted. Persist observed manifests, never removals.
				const observedSkills = (result as ScanResultWithCompleteness).skills;
				if (Array.isArray(observedSkills)) {
					await syncCatalogMcpSkills(
						db,
						app.id,
						observedSkills.map((skill) => ({
							skillUri: skill.uri,
							frontmatter: toJsonRecord(skill.frontmatter),
							resources: skill.resources,
						})),
					);
				}
				await publishMcpCatalogInventoryEvents({
					db,
					env: this.env,
					catalogAppId: app.id,
					resourceListChanged,
					promptListChanged,
				});

				// Update vector index with latest health/tool metadata (best-effort)
				try {
					const vectorClient = await getOrCreateCatalogVectorClient(this.env);
					if (vectorClient) {
						await upsertCatalogApp(vectorClient, {
							id: app.id,
							name: app.name,
							healthStatus: result.status,
							mcpToolCount: result.toolCount ?? 0,
							mcpEndpointNormalized: app.mcpEndpointNormalized,
							connectorType: "MCP",
						});
					}
				} catch (vectorError) {
					// Non-critical — vector sync is best-effort
					console.warn(
						`[MCP Scan] Vector upsert failed for ${app.name}: ${vectorError instanceof Error ? vectorError.message : String(vectorError)}`,
					);
				}

				checked++;
				if (result.status === "healthy" || result.status === "degraded") {
					healthy++;
				} else if (result.status === "unhealthy") {
					unhealthy++;
				} else if (result.status === "blocked") {
					blocked++;
				}
			} catch (error) {
				const errorMessage = `App ${app.name} (${app.id}): ${error instanceof Error ? error.message : String(error)}`;
				errors.push(errorMessage);
				console.error(`[MCP Scan] ${errorMessage}`);
			}
		});

		return {
			batchIndex,
			durationMs: Date.now() - startedAt,
			checked,
			healthy,
			unhealthy,
			blocked,
			errors,
		};
	}

	private async syncAutoSyncBaseApps(
		db: ReturnType<typeof createDbClient>,
		app: AppScanInfo,
	): Promise<void> {
		const mcpServerUrl = app.mcpEndpointNormalized || app.baseUrl;
		if (!mcpServerUrl) return;

		const baseApps: CatalogBaseAppRow[] = await listBaseAppsForCatalogApp(
			db,
			app.id,
		);

		let synced = 0;
		for (const baseApp of baseApps) {
			if (!catalogBaseAppAutoSyncEnabled(baseApp.metadata)) continue;
			await syncCatalogToolsToApp(db, {
				catalogAppId: app.id,
				appId: baseApp.id,
				mcpServerUrl,
				dryRun: false,
				disableRemoved: true,
			});
			synced++;
		}

		if (synced > 0) {
			await resolveDriftReport(db, app.id);
			console.log(
				`[MCP Scan] Auto-synced ${synced} base app(s) for ${app.name}`,
			);
		}
	}

	/**
	 * Scan a single app's MCP server using the direct MCP client
	 *
	 * Uses the lib/mcp-client directly instead of going through the Agent DO.
	 * This provides:
	 * - Reliable operation from Workflow context
	 * - Full tool/resource/prompt schema extraction
	 * - Proper OAuth detection
	 */
	private async scanApp(
		app: AppScanInfo,
		timeout: number,
	): Promise<ScanResultWithCompleteness> {
		const endpoint = app.mcpEndpointNormalized;
		const checkedAt = new Date().toISOString();

		console.log(`[MCP Scan] Scanning: ${app.name} (${endpoint})`);

		try {
			// Resolve auth headers: prefer fresh vault token over static snapshot
			let authHeaders: Record<string, string> | undefined;

			if (app.scanConnectionId && app.scanOrganizationId) {
				// Vault-based resolution: Descope user credential → tenant credential
				try {
					authHeaders = await this.resolveVaultToken(app);
					if (authHeaders) {
						console.log(
							`[MCP Scan] Resolved fresh token for ${app.name} via vault (${app.scanConnectionId})`,
						);
					}
				} catch (e) {
					console.warn(
						`[MCP Scan] Vault token resolution failed for ${app.name}: ${e instanceof Error ? e.message : String(e)}`,
					);
				}
			}

			// Fallback: decrypt static auth headers snapshot
			if (!authHeaders && app.scanAuthHeaders && this.env.SECRETS_MASTER_KEY) {
				try {
					const { decryptCatalogAppSecret } =
						await import("@tedix/db/utils/secrets-encryption");
					const decrypted = await decryptCatalogAppSecret(
						this.env.SECRETS_MASTER_KEY,
						app.id,
						app.scanAuthHeaders,
					);
					authHeaders = JSON.parse(decrypted) as Record<string, string>;
				} catch (e) {
					console.warn(
						`[MCP Scan] Failed to decrypt auth headers for ${app.name}: ${e instanceof Error ? e.message : String(e)}`,
					);
				}
			}

			// First-party Tedix MCP references, such as CMS, are scanned with
			// platform service auth from Worker secrets instead of persisting tokens in D1.
			if (!authHeaders) {
				authHeaders = internalScanHeaders(app, this.env);
			}

			// Use direct MCP client
			const internalTenantFetch = isTedixTenantMcpEndpoint(endpoint)
				? this.env.MCP_SERVICE.fetch.bind(this.env.MCP_SERVICE)
				: undefined;
			const result = await connectMcpServer(endpoint, {
				timeout,
				headers: authHeaders,
				fetchFn: internalTenantFetch,
			});

			// If vault resolution succeeded, refresh the encrypted snapshot so it stays warm
			if (authHeaders && app.scanConnectionId && this.env.SECRETS_MASTER_KEY) {
				try {
					const { encryptCatalogAppSecret } =
						await import("@tedix/db/utils/secrets-encryption");
					const { updateCatalogAppScanAuth } =
						await import("@tedix/db/queries/catalog/get-app");
					const snapshotDb = createDbClient(this.env.DB);
					const encrypted = await encryptCatalogAppSecret(
						this.env.SECRETS_MASTER_KEY,
						app.id,
						JSON.stringify(authHeaders),
					);
					await updateCatalogAppScanAuth(snapshotDb, app.id, encrypted);
				} catch {
					// Non-critical — snapshot refresh is best-effort
				}
			}

			if (result.success && result.serverInfo) {
				// Successful connection (initialize worked)
				const serverInfo = result.serverInfo;
				const completeness = getMcpScanWorkflowListTruncation(
					{
						tools: serverInfo.tools.length,
						resources: serverInfo.resources.length,
						resourceTemplates: serverInfo.resourceTemplates.length,
						prompts: serverInfo.prompts.length,
						skills: serverInfo.skills.length,
					},
					serverInfo.listsTruncated,
				);
				const diagnostics = classifySuccessfulMcpScan({
					partialAuth: result.partialAuth,
					listsTruncated: completeness,
					connectTimeMs: result.connectTimeMs,
					methodErrors: serverInfo.methodErrors,
					toolCount: serverInfo.tools.length,
					resourceCount: serverInfo.resources.length,
					resourceTemplateCount: serverInfo.resourceTemplates.length,
					promptCount: serverInfo.prompts.length,
					skillCount: serverInfo.skills.length,
				});
				const status = diagnostics.status;

				// Extract MCP protocol feature support from server capabilities
				const caps = serverInfo.capabilities as
					| Record<string, unknown>
					| undefined;
				const protocolVersion = serverInfo.protocolVersion ?? undefined;
				const supportsResources =
					!!caps?.resources || serverInfo.resources.length > 0;
				const supportsPrompts =
					!!caps?.prompts || serverInfo.prompts.length > 0;
				const supportsSampling = !!caps?.sampling;
				const supportsRoots = !!caps?.roots;

				console.log(
					`[MCP Scan] Success: ${app.name} - ${status}, ` +
						`${serverInfo.tools.length} tools, ` +
						`${serverInfo.resources.length} resources, ` +
						`${serverInfo.prompts.length} prompts, ` +
						`protocol=${protocolVersion ?? "unknown"}` +
						diagnostics.logSuffix,
				);

				return {
					status,
					connectTimeMs: result.connectTimeMs,
					totalTimeMs: result.totalTimeMs,
					transportUsed: result.transport as TransportType,
					authState: diagnostics.authState,
					serverName: serverInfo.name,
					serverVersion: serverInfo.version,
					capabilities: serverInfo.capabilities as Record<string, unknown>,
					instructions: serverInfo.instructions,
					errorMessage: diagnostics.errorMessage,
					errorClass: diagnostics.errorClass,
					toolCount: completeness.tools ? undefined : serverInfo.tools.length,
					resourceCount: completeness.resources
						? undefined
						: serverInfo.resources.length,
					promptCount: completeness.prompts
						? undefined
						: serverInfo.prompts.length,
					resourceTemplateCount: completeness.resourceTemplates
						? undefined
						: serverInfo.resourceTemplates.length,
					tools: serverInfo.tools
						.slice(0, MCP_SCAN_WORKFLOW_LIST_LIMITS.tools)
						.map((t) => {
							const tool = t as typeof t & Partial<ScanTool>;
							return {
								name: tool.name,
								title: tool.title,
								description: tool.description,
								inputSchema: tool.inputSchema as
									| Record<string, unknown>
									| undefined,
								outputSchema: tool.outputSchema,
								icons: tool.icons,
								execution: tool.execution,
								_meta: tool._meta,
								annotations: tool.annotations,
							};
						}),
					resources: serverInfo.resources
						.slice(0, MCP_SCAN_WORKFLOW_LIST_LIMITS.resources)
						.map((r) => {
							const resource = r as typeof r & Partial<ScanResource>;
							return {
								uri: resource.uri,
								name: resource.name,
								title: resource.title,
								description: resource.description,
								mimeType: resource.mimeType,
								icons: resource.icons,
								annotations: resource.annotations,
								_meta: resource._meta,
							};
						}),
					resourceTemplates: serverInfo.resourceTemplates
						.slice(0, MCP_SCAN_WORKFLOW_LIST_LIMITS.resourceTemplates)
						.map((rt) => {
							const template = rt as typeof rt & Partial<ScanResourceTemplate>;
							return {
								name: template.name,
								title: template.title,
								uriTemplate: template.uriTemplate,
								description: template.description,
								mimeType: template.mimeType,
								icons: template.icons,
								annotations: template.annotations,
								_meta: template._meta,
							};
						}),
					prompts: serverInfo.prompts
						.slice(0, MCP_SCAN_WORKFLOW_LIST_LIMITS.prompts)
						.map((p) => ({
							name: p.name,
							description: p.description,
							arguments: p.arguments,
						})),
					skills: serverInfo.skills.slice(
						0,
						MCP_SCAN_WORKFLOW_LIST_LIMITS.skills,
					),
					protocolVersion,
					listsTruncated: completeness,
					supportsResources,
					supportsPrompts,
					supportsSampling,
					supportsRoots,
					checkedAt,
				};
			}

			// Handle WAF blocks distinctly from auth
			if (result.wafProvider) {
				const manifest = await fetchPublicMcpManifest(endpoint, timeout);
				if (manifest) {
					console.log(
						`[MCP Scan] WAF blocked: ${app.name}; using public manifest ${manifest.url} with ${manifest.tools.length} tools`,
					);
					return scanResultFromPublicManifest(
						{
							status: "blocked",
							connectTimeMs: result.connectTimeMs,
							totalTimeMs: result.totalTimeMs,
							transportUsed: result.transport as TransportType,
							authState: "none",
							errorMessage: `Blocked by ${result.wafProvider}`,
							errorClass: "waf" as ErrorClass,
							checkedAt,
						},
						manifest,
					);
				}

				console.log(
					`[MCP Scan] WAF blocked: ${app.name} (${result.wafProvider})`,
				);
				return {
					status: "blocked",
					connectTimeMs: result.connectTimeMs,
					totalTimeMs: result.totalTimeMs,
					transportUsed: result.transport as TransportType,
					authState: "none",
					errorMessage: `Blocked by ${result.wafProvider}`,
					errorClass: "waf" as ErrorClass,
					checkedAt,
				};
			}

			// Handle real auth requirement
			if (result.requiresAuth) {
				const manifest = await fetchPublicMcpManifest(endpoint, timeout);
				if (manifest) {
					console.log(
						`[MCP Scan] Auth required: ${app.name}; using public manifest ${manifest.url} with ${manifest.tools.length} tools`,
					);
					return scanResultFromPublicManifest(
						{
							status: "requires_auth",
							connectTimeMs: result.connectTimeMs,
							totalTimeMs: result.totalTimeMs,
							transportUsed: result.transport as TransportType,
							authState: "required",
							errorMessage: result.error,
							errorClass: "auth" as ErrorClass,
							checkedAt,
						},
						manifest,
					);
				}

				console.log(`[MCP Scan] Auth required: ${app.name}`);
				return {
					status: "requires_auth",
					connectTimeMs: result.connectTimeMs,
					totalTimeMs: result.totalTimeMs,
					transportUsed: result.transport as TransportType,
					authState: "required",
					errorMessage: result.error,
					errorClass: "auth" as ErrorClass,
					checkedAt,
				};
			}

			// Other errors
			const errorClass = this.classifyErrorCode(result.errorCode);
			const status = this.getStatusFromErrorClass(errorClass);

			console.log(
				`[MCP Scan] Failed: ${app.name} - ${status} (${errorClass}): ${result.error}`,
			);

			return {
				status,
				connectTimeMs: result.connectTimeMs,
				totalTimeMs: result.totalTimeMs,
				transportUsed: result.transport as TransportType,
				authState: "none",
				errorMessage: result.error,
				errorClass,
				checkedAt,
			};
		} catch (error) {
			// Unexpected error
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			const errorClass = this.classifyError(error);
			const status = this.getStatusFromErrorClass(errorClass);

			console.error(
				`[MCP Scan] Unexpected error for ${app.name}: ${errorMessage}`,
			);

			return {
				status,
				errorMessage,
				errorClass,
				authState: "none",
				checkedAt,
			};
		}
	}

	/**
	 * Project a Tedix-owned catalog entry directly from the linked base app.
	 */
	private async projectApp(
		app: AppScanInfo,
		db: ReturnType<typeof createDbClient>,
	): Promise<McpScanResult> {
		const startedAt = Date.now();
		const checkedAt = new Date().toISOString();
		console.log(
			`[MCP Scan] Projecting Tedix catalog app: ${app.name} (${app.toolSource})`,
		);

		const projection = await projectCatalogToolsFromBaseApp(db, app.id);
		const status =
			app.healthStatus === "healthy" || app.healthStatus === "degraded"
				? app.healthStatus
				: "requires_auth";

		return {
			status,
			totalTimeMs: Date.now() - startedAt,
			authState: status === "requires_auth" ? "required" : "none",
			serverName: projection.sourceAppSlug,
			toolCount: projection.activeTools,
			resourceCount: 0,
			promptCount: 0,
			resourceTemplateCount: 0,
			capabilities: { tools: { listChanged: true } },
			checkedAt,
		};
	}

	/**
	 * Resolve a fresh token from the vault for an app with scanConnectionId.
	 * Resolution chain: Descope user-scoped tokens from org owners/admins,
	 * then Descope tenant-scoped tokens.
	 */
	private async resolveVaultToken(
		app: AppScanInfo,
	): Promise<Record<string, string> | undefined> {
		const connectionId = app.scanConnectionId!;
		const orgId = app.scanOrganizationId!;
		const header = app.scanConnectionHeader || "Authorization";
		const template = app.scanConnectionTemplate || "{token}";

		const db = createDbClient(this.env.DB);
		let resolvedToken: string | undefined;

		if (this.env.DESCOPE_MANAGEMENT_KEY) {
			const { getManagementClient } = await import("@tedix/auth/client");
			const { fetchConnectionToken, fetchTenantConnectionToken } =
				await import("@tedix/auth/connections");
			const { getOrganizationById } =
				await import("@tedix/db/queries/organizations");
			const { getMembersByOrganization } =
				await import("@tedix/db/queries/organization-members");

			const descopeClient = getManagementClient({
				DESCOPE_PROJECT_ID: this.env.DESCOPE_PROJECT_ID,
				DESCOPE_MANAGEMENT_KEY: this.env.DESCOPE_MANAGEMENT_KEY,
				DESCOPE_BASE_URL: this.env.DESCOPE_BASE_URL,
			});

			const org = await getOrganizationById(db, orgId);

			// 1. Try user-scoped tokens from org owners/admins.
			if (!resolvedToken && org) {
				const owners = await getMembersByOrganization(db, orgId, {
					role: "owner",
					status: "active",
					limit: 3,
				});
				const admins =
					owners.length === 0
						? await getMembersByOrganization(db, orgId, {
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
					} catch {
						// Non-fatal — try next member
					}
				}
			}

			// 2. Fallback: Descope Token Vault (tenant-scoped)
			if (!resolvedToken && org?.descopeTenantId) {
				const tenantResult = await fetchTenantConnectionToken(
					descopeClient,
					connectionId,
					org.descopeTenantId,
				);
				if (tenantResult?.accessToken) {
					resolvedToken = tenantResult.accessToken;
				}
			}
		}

		if (!resolvedToken) return undefined;

		// M2M servers store a raw `client_id:client_secret`; exchange it for a fresh
		// short-lived Bearer before templating so re-scans never use a stale token.
		if (app.scanClientCredentialsTokenUrl) {
			const bearer = await exchangeScanClientCredentials(
				resolvedToken,
				app.scanClientCredentialsTokenUrl,
			);
			if (!bearer) {
				console.warn(
					`[MCP Scan] client_credentials exchange yielded no token for ${app.name} (${app.scanConnectionId})`,
				);
				return undefined;
			}
			resolvedToken = bearer;
		}

		return { [header]: template.replace("{token}", resolvedToken) };
	}

	/**
	 * Classify error code from MCP client result
	 */
	private classifyErrorCode(errorCode: string | undefined): ErrorClass {
		switch (errorCode) {
			case "TIMEOUT":
				return "timeout";
			case "DNS":
				return "dns";
			case "TLS":
				return "tls";
			case "AUTH_REQUIRED":
				return "auth";
			case "WAF_BLOCKED":
				return "waf";
			case "CONNECTION_REFUSED":
			case "BLOCKED":
				return "waf";
			case "INVALID_URL":
			case "INVALID_PROTOCOL":
				return "protocol";
			default:
				return "unknown";
		}
	}

	/**
	 * Get health status from error class
	 */
	private getStatusFromErrorClass(errorClass: ErrorClass): HealthStatus {
		switch (errorClass) {
			case "auth":
				return "requires_auth";
			case "waf":
				return "blocked";
			case "transport":
			case "protocol":
				return "unsupported";
			default:
				return "unhealthy";
		}
	}

	/**
	 * Classify error type for debugging and analytics
	 */
	private classifyError(
		error: unknown,
	):
		| "timeout"
		| "dns"
		| "tls"
		| "auth"
		| "waf"
		| "transport"
		| "protocol"
		| "unknown" {
		const msg = error instanceof Error ? error.message : String(error);
		const lower = msg.toLowerCase();

		if (
			msg.includes("timeout") ||
			msg.includes("ETIMEDOUT") ||
			msg.includes("aborted")
		) {
			return "timeout";
		}
		if (
			msg.includes("ENOTFOUND") ||
			msg.includes("DNS") ||
			msg.includes("getaddrinfo")
		) {
			return "dns";
		}
		if (
			msg.includes("certificate") ||
			msg.includes("TLS") ||
			msg.includes("SSL") ||
			msg.includes("CERT")
		) {
			return "tls";
		}
		if (
			lower.includes("cloudflare") ||
			lower.includes("cloudfront") ||
			lower.includes("akamai") ||
			lower.includes("captcha") ||
			lower.includes("bot") ||
			lower.includes("attention required") ||
			lower.includes("access denied") ||
			lower.includes("forbidden") ||
			lower.includes("blocked") ||
			lower.includes("ip allowlist") ||
			lower.includes("ip whitelist")
		) {
			return "waf";
		}
		if (
			msg.includes("401") ||
			msg.includes("403") ||
			lower.includes("unauthorized")
		) {
			return "auth";
		}
		if (msg.includes("transport")) {
			return "transport";
		}
		return "unknown";
	}
}
