/// <reference path="../../worker-configuration.d.ts" />
/**
 * Catalog / MCP scan cron dispatches. The daily MCP scan includes configured
 * providers, drift checks and OpenAPI sync; tool tests and content sync keep
 * their own schedules.
 */

import { loadCatalogMaintenancePolicy } from "../lib/catalog-sync-source";

// Bounded-concurrent batches sustain roughly 33 scans/minute in production.
// Admit up to 200 backlog rows alongside the published provider cohort,
// deduplicated within one workflow. Sequential five-row steps remain,
// which bounds outbound concurrency at five.
const MCP_SCAN_LIMIT = 200;

export async function runMcpScan(
	env: CloudflareEnv,
	runId: string,
): Promise<Record<string, number>> {
	const { PlatformCronPathError } = await import("./platform-cron-receipts");
	const errors: unknown[] = [];
	const counts = { workflowsDispatched: 0 };
	let frequentProviderSlugs: string[] = [];
	try {
		const { coreDb } = await import("@tedix/db/core-store/scope");
		const policy = await loadCatalogMaintenancePolicy(coreDb(env));
		frequentProviderSlugs = policy.frequentProviderSlugs;
	} catch (error) {
		errors.push(error);
	}
	try {
		console.log(`[Scheduled] Starting McpScanWorkflow (${runId})`);
		const instance = await env.MCP_SCAN_WORKFLOW.create({
			id: `scan-${runId}`,
			params: {
				limit: MCP_SCAN_LIMIT,
				maxAgeHours: 24,
				frequentProviderSlugs,
			},
		});
		counts.workflowsDispatched++;
		console.log(`[Scheduled] McpScanWorkflow started: ${instance.id}`);
	} catch (error) {
		errors.push(error);
	}
	await runCatalogDriftAndSync(env, runId);
	if (errors.length)
		throw new PlatformCronPathError(
			errors,
			"Catalog scan dispatch failed",
			counts,
		);
	return counts;
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
		const { coreDb } = await import("@tedix/db/core-store/scope");
		const { calculateAndUpdateScores } =
			await import("@tedix/db/queries/catalog/quality-scores");
		const db = coreDb(env);
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

async function runCatalogDriftAndSync(
	env: CloudflareEnv,
	runId: string,
): Promise<void> {
	const { coreDb } = await import("@tedix/db/core-store/scope");
	const { listApiSyncApps } = await import("@tedix/db/queries/apps");
	const db = coreDb(env);

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
