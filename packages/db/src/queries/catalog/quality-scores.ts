/**
 * App Catalog Queries — Stale app detection + quality scores.
 * Split from catalog.ts (mechanical move; bodies unchanged).
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { appCatalog, appCatalogMcpTools } from "../../schema/catalog";
import { chunkForBoundParams } from "../../utils/batch";
import type { Database } from "./tool-source-policy";

// =============================================================================
// STALE APP DETECTION
// =============================================================================

// =============================================================================
// QUALITY SCORES
// =============================================================================

/**
 * Calculate quality scores for a single catalog app based on its tools and metadata.
 * Returns individual dimension scores (0-100) and a weighted overall score.
 */
function calculateScores(
	app: {
		mcpToolCount: number | null;
		mcpResourceCount: number | null;
		mcpPromptCount: number | null;
		developerType: string | null;
		hasWrites: boolean | null;
		hasInteractive: boolean | null;
		hasFileSearch: boolean | null;
		hasDeepResearch: boolean | null;
		healthStatus: string | null;
		healthUptimePercent: number | null;
		mcpServerVersion: string | null;
		mcpCapabilities: unknown;
	},
	tools: {
		toolName: string;
		description: string | null;
		inputSchema: unknown;
		annotations: unknown;
	}[],
) {
	// Schema Quality (0-100): How well-documented are the tools?
	let schemaQuality = 0;
	if (tools.length > 0) {
		let toolScoreSum = 0;
		for (const tool of tools) {
			let toolScore = 0;
			// Has description? (0-30)
			if (tool.description) {
				toolScore += Math.min(30, tool.description.length / 3); // 90+ chars = full marks
			}
			// Has input schema? (0-30)
			if (tool.inputSchema) {
				const schema = tool.inputSchema as Record<string, unknown> | null;
				const props = Object.keys(
					(schema?.properties as Record<string, unknown>) ?? schema ?? {},
				).length;
				toolScore += Math.min(30, props * 10); // 3+ params = full marks
			}
			// Has annotations? (0-20)
			if (
				tool.annotations &&
				Object.keys(tool.annotations as Record<string, unknown>).length > 0
			) {
				toolScore += 20;
			}
			// Has meaningful name? (0-20)
			if (tool.toolName?.includes("_") && tool.toolName.length > 5) {
				toolScore += 20; // snake_case with descriptive name
			} else if (tool.toolName && tool.toolName.length > 3) {
				toolScore += 10;
			}
			toolScoreSum += Math.min(100, toolScore);
		}
		schemaQuality = Math.round(toolScoreSum / tools.length);
	}

	// Capability Breadth (0-100): How many features does the server expose?
	const toolCount = app.mcpToolCount ?? 0;
	const resourceCount = app.mcpResourceCount ?? 0;
	const promptCount = app.mcpPromptCount ?? 0;
	const capabilityCount = [
		app.hasWrites,
		app.hasInteractive,
		app.hasFileSearch,
		app.hasDeepResearch,
	].filter(Boolean).length;

	let capabilityBreadth = 0;
	capabilityBreadth += Math.min(40, toolCount * 4); // 10+ tools = 40 pts
	capabilityBreadth += Math.min(20, resourceCount * 10); // 2+ resources = 20 pts
	capabilityBreadth += Math.min(15, promptCount * 15); // 1+ prompt = 15 pts
	capabilityBreadth += capabilityCount * 6.25; // 4 capabilities = 25 pts
	capabilityBreadth = Math.min(100, Math.round(capabilityBreadth));

	// Freshness (0-100): Is the server actively maintained?
	let freshness = 50; // Default: assume moderate freshness
	if (app.mcpServerVersion) {
		freshness += 20; // Has version = actively versioned
		// Semantic versioning bonus
		if (/^\d+\.\d+\.\d+/.test(app.mcpServerVersion)) freshness += 10;
	}
	if (app.healthStatus === "healthy") freshness += 20;
	freshness = Math.min(100, freshness);

	// Standards (0-100): MCP spec compliance
	let standards = 30; // Base: exists as MCP server
	if (app.mcpCapabilities) {
		const caps = app.mcpCapabilities as Record<string, unknown>;
		if (caps.tools) standards += 20;
		if (caps.resources) standards += 15;
		if (caps.prompts) standards += 15;
	}
	// Annotations on tools = spec compliance
	const toolsWithAnnotations = tools.filter(
		(t) =>
			t.annotations &&
			Object.keys(t.annotations as Record<string, unknown>).length > 0,
	).length;
	if (tools.length > 0) {
		standards += Math.round((toolsWithAnnotations / tools.length) * 20);
	}
	standards = Math.min(100, standards);

	// Trust (0-100): Developer reputation
	let trust = 30; // Base
	switch (app.developerType) {
		case "OAI":
			trust = 100;
			break;
		case "TRUSTED_PARTNER":
			trust = 80;
			break;
		case "THIRD_PARTY":
			trust = 50;
			break;
		default:
			trust = 30;
	}

	// Overall (weighted)
	const overall = Math.round(
		schemaQuality * 0.25 +
			capabilityBreadth * 0.25 +
			freshness * 0.2 +
			standards * 0.15 +
			trust * 0.15,
	);

	return {
		schemaQuality,
		capabilityBreadth,
		freshness,
		standards,
		trust,
		overall,
	};
}

/**
 * Calculate and update quality scores for catalog apps.
 * Called after MCP scan completes (has fresh tool/health data).
 */
export async function calculateAndUpdateScores(
	db: Database,
	limit = 50,
): Promise<number> {
	// Get apps that have been scanned (have tool data)
	const apps = await db
		.select({
			id: appCatalog.id,
			connectorType: appCatalog.connectorType,
			developerType: appCatalog.developerType,
			mcpToolCount: appCatalog.mcpToolCount,
			mcpResourceCount: appCatalog.mcpResourceCount,
			mcpPromptCount: appCatalog.mcpPromptCount,
			mcpMetadata: appCatalog.mcpMetadata,
			healthStatus: appCatalog.healthStatus,
			healthData: appCatalog.healthData,
			scores: appCatalog.scores,
			hasWrites: appCatalog.hasWrites,
			hasInteractive: appCatalog.hasInteractive,
			hasFileSearch: appCatalog.hasFileSearch,
			hasDeepResearch: appCatalog.hasDeepResearch,
			updatedAt: appCatalog.updatedAt,
		})
		.from(appCatalog)
		.where(
			and(
				eq(appCatalog.connectorType, "MCP"),
				eq(appCatalog.isDiscoverable, true),
				sql`${appCatalog.mcpToolCount} > 0`, // Only score apps we've actually scanned
			),
		)
		.orderBy(
			// Prioritize: never scored > oldest scores
			sql`CASE WHEN json_extract(${appCatalog.scores}, '$.lastCalculatedAt') IS NULL THEN 0 ELSE 1 END`,
			sql`json_extract(${appCatalog.scores}, '$.lastCalculatedAt')`,
		)
		.limit(limit);

	if (apps.length === 0) return 0;

	// Batch-fetch all tools for all apps (eliminates N+1), chunked because D1
	// caps bound parameters at 100 per statement.
	const selectToolsChunk = (chunk: string[]) =>
		db
			.select({
				catalogAppId: appCatalogMcpTools.catalogAppId,
				toolName: appCatalogMcpTools.toolName,
				description: appCatalogMcpTools.description,
				inputSchema: appCatalogMcpTools.inputSchema,
				annotations: appCatalogMcpTools.annotations,
			})
			.from(appCatalogMcpTools)
			.where(
				and(
					inArray(appCatalogMcpTools.catalogAppId, chunk),
					isNull(appCatalogMcpTools.removedAt),
				),
			);
	const allTools: Awaited<ReturnType<typeof selectToolsChunk>> = [];
	for (const chunk of chunkForBoundParams(
		apps.map((a) => a.id),
		50,
	)) {
		allTools.push(...(await selectToolsChunk(chunk)));
	}

	// Group tools by catalogAppId
	const toolsByAppId = new Map<string, typeof allTools>();
	for (const tool of allTools) {
		const existing = toolsByAppId.get(tool.catalogAppId);
		if (existing) {
			existing.push(tool);
		} else {
			toolsByAppId.set(tool.catalogAppId, [tool]);
		}
	}

	let updated = 0;

	for (const app of apps) {
		const tools = toolsByAppId.get(app.id) ?? [];

		// Extract values from JSON blobs for calculateScores
		const scoreInput = {
			mcpToolCount: app.mcpToolCount,
			mcpResourceCount: app.mcpResourceCount,
			mcpPromptCount: app.mcpPromptCount,
			developerType: app.developerType,
			hasWrites: app.hasWrites,
			hasInteractive: app.hasInteractive,
			hasFileSearch: app.hasFileSearch,
			hasDeepResearch: app.hasDeepResearch,
			healthStatus: app.healthStatus,
			healthUptimePercent: app.healthData?.uptimePercent ?? null,
			mcpServerVersion: app.mcpMetadata?.serverVersion ?? null,
			mcpCapabilities: app.mcpMetadata?.capabilities ?? null,
		};

		const scores = calculateScores(scoreInput, tools);

		await db
			.update(appCatalog)
			.set({
				scores: {
					...app.scores,
					schemaQuality: scores.schemaQuality,
					capabilityBreadth: scores.capabilityBreadth,
					freshness: scores.freshness,
					standards: scores.standards,
					trust: scores.trust,
					overall: scores.overall,
					lastCalculatedAt: new Date().toISOString(),
				},
			})
			.where(eq(appCatalog.id, app.id));

		updated++;
	}

	return updated;
}
