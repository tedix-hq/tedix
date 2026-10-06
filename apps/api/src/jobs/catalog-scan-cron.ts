/// <reference path="../../worker-configuration.d.ts" />
/**
 * Catalog / MCP scan cron dispatches (hourly MCP scan, 6am UTC tool testing + quality
 * scores, 7am UTC content sync, every-6h active-provider scan + drift + OpenAPI
 * sync).
 */

const ACTIVE_PROVIDER_CATALOG_SLUGS = [
	"cloudflare",
	"cms",
	"descope",
	"firecrawl",
	"github",
	"google-calendar",
	"google-chat",
	"google-drive",
	"google-gmail",
	"neo4j-aura-mcp",
	"notion",
	"peec",
	"promptwatch",
	"tavily",
	"todoist",
] as const;

// Bounded-concurrent batches sustain roughly 33 scans/minute in production.
// Admit the contract maximum of 200 rows per hourly workflow so a cold fleet
// recovers faster without launching overlapping workflows against the same
// unreserved rows. The workflow still processes sequential five-row steps,
// which bounds outbound concurrency at five.
export const MCP_SCAN_HOURLY_LIMIT = 200;

export async function runMcpScan(
	env: CloudflareEnv,
	runId: string,
): Promise<Record<string, number>> {
	console.log(`[Scheduled] Starting McpScanWorkflow (${runId})`);
	const instance = await env.MCP_SCAN_WORKFLOW.create({
		id: `scan-${runId}`,
		params: { limit: MCP_SCAN_HOURLY_LIMIT, maxAgeHours: 24 },
	});
	console.log(`[Scheduled] McpScanWorkflow started: ${instance.id}`);
	return { workflowsDispatched: 1 };
}

export async function runToolTestAndQualityScores(
	env: CloudflareEnv,
	runId: string,
): Promise<Record<string, number>> {
	console.log(`[Scheduled] Starting McpToolTestWorkflow (${runId})`);
	const instance = await env.TOOL_TEST_WORKFLOW.create({
		id: `tooltest-${runId}`,
	});
	console.log(`[Scheduled] McpToolTestWorkflow started: ${instance.id}`);

	// Calculate quality scores (runs after MCP scan from 5am should be complete)
	let appsScored = 0;
	try {
		const { createDbClient } = await import("@tedix/db/client");
		const { calculateAndUpdateScores } =
			await import("@tedix/db/queries/catalog/quality-scores");
		const db = createDbClient(env.DB);
		appsScored = await calculateAndUpdateScores(db, 100);
		console.log(`[Scheduled] Quality scores updated for ${appsScored} apps`);
	} catch (scoreError) {
		console.error(`[Scheduled] Quality score calculation failed:`, scoreError);
		throw scoreError;
	}
	return { appsScored, workflowsDispatched: 1 };
}

export async function runContentSync(
	env: CloudflareEnv,
	runId: string,
): Promise<Record<string, number>> {
	console.log(`[Scheduled] Starting ContentSyncWorkflow (${runId})`);
	const instance = await env.CONTENT_SYNC_WORKFLOW.create({
		id: `content-sync-${runId}`,
		params: { force: false },
	});
	console.log(`[Scheduled] ContentSyncWorkflow started: ${instance.id}`);
	return { workflowsDispatched: 1 };
}

export async function runActiveProviderScanAndDrift(
	env: CloudflareEnv,
	runId: string,
): Promise<void> {
	const { createDbClient } = await import("@tedix/db/client");
	const { listApiSyncApps } = await import("@tedix/db/queries/apps");
	const { listActiveProviderCatalogApps } =
		await import("@tedix/db/queries/catalog/health-metrics");
	const db = createDbClient(env.DB);
	try {
		const activeProviders = await listActiveProviderCatalogApps(
			db,
			ACTIVE_PROVIDER_CATALOG_SLUGS,
		);

		if (activeProviders.length > 0) {
			const activeScan = await env.MCP_SCAN_WORKFLOW.create({
				id: `active-provider-scan-${runId}`,
				params: {
					catalogAppIds: activeProviders.map((app) => app.id),
					limit: activeProviders.length,
					maxAgeHours: 1,
				},
			});
			console.log(
				`[Scheduled] Active provider MCP scan started: ${activeScan.id} for ${activeProviders.map((app) => app.slug).join(",")}`,
			);
		}
	} catch (activeScanError) {
		console.error(
			`[Scheduled] Active provider MCP scan queueing failed:`,
			activeScanError,
		);
	}

	console.log(`[Scheduled] Starting CatalogDriftWorkflow (${runId})`);
	try {
		const driftWorkflow = await env.CATALOG_DRIFT_WORKFLOW.create({
			id: `catalog-drift-${runId}`,
			params: {
				source: "cron",
				limit: 50,
				autoSync: true,
			},
		});
		console.log(
			`[Scheduled] CatalogDriftWorkflow started: ${driftWorkflow.id}`,
		);
	} catch (driftError) {
		console.error(
			`[Scheduled] CatalogDriftWorkflow queueing failed:`,
			driftError,
		);
	}

	try {
		const openApiApps = await listApiSyncApps(db);

		for (const app of openApiApps) {
			await env.OPENAPI_SYNC_WORKFLOW.create({
				id: `openapi-sync-${app.slug}-${runId}`,
				params: { appId: app.id, dryRun: false },
			});
		}
		console.log(
			`[Scheduled] OpenAPI sync queued for ${openApiApps.length} apps`,
		);
	} catch (openApiSyncError) {
		console.error(
			`[Scheduled] OpenAPI sync queueing failed:`,
			openApiSyncError,
		);
	}
}
