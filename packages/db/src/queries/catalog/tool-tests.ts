/**
 * App Catalog Queries — Tool test operations.
 * Split from catalog.ts (mechanical move; bodies unchanged).
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, count, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import {
	appCatalog,
	appCatalogMcpTools,
	appCatalogToolTests,
	type CatalogMcpTool,
	type CatalogToolTest,
	type ToolTestErrorClass,
	type ToolTestInputSource,
	type ToolTestType,
} from "../../schema/catalog";
import type { Database } from "./tool-source-policy";

// =============================================================================
// TOOL TEST OPERATIONS
// =============================================================================

/**
 * Input for inserting a tool test result
 */
export interface InsertToolTestInput {
	catalogAppId: string;
	toolName: string;
	testType: ToolTestType;
	inputSource: ToolTestInputSource;
	success: boolean;
	latencyMs?: number;
	errorMessage?: string;
	errorClass?: ToolTestErrorClass;
	inputUsed?: Record<string, JsonValue>;
	outputReceived?: Record<string, JsonValue>;
	outputValid?: boolean;
	// AI eval specific
	aiModel?: string;
	aiPromptUsed?: string;
	aiToolSelectionCorrect?: boolean;
	aiOutputQualityScore?: number;
	aiTokensUsed?: number;
}

const TOOL_TEST_OUTPUT_PREVIEW_LIMIT = 10_000;

export function createToolTestOutputPreview(
	outputReceived: Record<string, JsonValue> | undefined,
): Record<string, JsonValue> | undefined {
	if (!outputReceived) return undefined;

	const outputStr = JSON.stringify(outputReceived);
	if (outputStr.length <= TOOL_TEST_OUTPUT_PREVIEW_LIMIT) {
		return outputReceived;
	}

	return {
		_truncated: true,
		_originalLength: outputStr.length,
		_preview: outputStr.slice(0, TOOL_TEST_OUTPUT_PREVIEW_LIMIT),
	};
}

/**
 * Insert a tool test result
 */
export async function insertToolTest(
	db: Database,
	input: InsertToolTestInput,
): Promise<CatalogToolTest> {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();

	// Truncate output to a safe JSON preview if needed.
	const outputReceived = createToolTestOutputPreview(input.outputReceived);

	await db.insert(appCatalogToolTests).values({
		id,
		catalogAppId: input.catalogAppId,
		toolName: input.toolName,
		testedAt: now,
		testType: input.testType,
		inputSource: input.inputSource,
		success: input.success,
		latencyMs: input.latencyMs ?? null,
		errorMessage: input.errorMessage ?? null,
		errorClass: input.errorClass ?? null,
		inputUsed: input.inputUsed ?? null,
		outputReceived: outputReceived ?? null,
		outputValid: input.outputValid ?? null,
		aiModel: input.aiModel ?? null,
		aiPromptUsed: input.aiPromptUsed ?? null,
		aiToolSelectionCorrect: input.aiToolSelectionCorrect ?? null,
		aiOutputQualityScore: input.aiOutputQualityScore ?? null,
		aiTokensUsed: input.aiTokensUsed ?? null,
	});

	const result = await db
		.select()
		.from(appCatalogToolTests)
		.where(eq(appCatalogToolTests.id, id))
		.limit(1);

	const created = result[0];
	if (!created) throw new Error(`Failed to create catalog tool test: ${id}`);
	return created;
}

/**
 * Options for getting tool tests
 */
export interface GetToolTestsOptions {
	limit?: number;
	offset?: number;
	testType?: ToolTestType;
	successOnly?: boolean;
	days?: number;
}

/**
 * Get tool test history for a specific tool
 */
export async function getToolTests(
	db: Database,
	catalogAppId: string,
	toolName: string,
	options: GetToolTestsOptions = {},
): Promise<CatalogToolTest[]> {
	const { limit = 100, offset = 0, testType, successOnly, days } = options;

	const conditions = [
		eq(appCatalogToolTests.catalogAppId, catalogAppId),
		eq(appCatalogToolTests.toolName, toolName),
	];

	if (testType) {
		conditions.push(eq(appCatalogToolTests.testType, testType));
	}

	if (successOnly) {
		conditions.push(eq(appCatalogToolTests.success, true));
	}

	if (days) {
		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		conditions.push(gte(appCatalogToolTests.testedAt, cutoff.toISOString()));
	}

	return db
		.select()
		.from(appCatalogToolTests)
		.where(and(...conditions))
		.orderBy(desc(appCatalogToolTests.testedAt))
		.limit(limit)
		.offset(offset);
}

/**
 * Update aggregated test metrics on the tool record
 * Call this after inserting a test to keep metrics current
 */
export async function updateToolTestMetrics(
	db: Database,
	catalogAppId: string,
	toolName: string,
): Promise<void> {
	// Get tests from last 30 days for success rate
	const thirtyDaysAgo = new Date(
		Date.now() - 30 * 24 * 60 * 60 * 1000,
	).toISOString();

	const recentTests = await db
		.select()
		.from(appCatalogToolTests)
		.where(
			and(
				eq(appCatalogToolTests.catalogAppId, catalogAppId),
				eq(appCatalogToolTests.toolName, toolName),
				gte(appCatalogToolTests.testedAt, thirtyDaysAgo),
			),
		)
		.orderBy(desc(appCatalogToolTests.testedAt));

	if (recentTests.length === 0) return;

	// Calculate metrics
	const successCount = recentTests.filter((t) => t.success).length;
	const successRate = successCount / recentTests.length;

	const latencies = recentTests
		.filter((t) => t.latencyMs !== null)
		.map((t) => t.latencyMs!);
	const avgLatencyMs =
		latencies.length > 0
			? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
			: null;

	// Get all-time test count
	const totalCountResult = await db
		.select({ count: count() })
		.from(appCatalogToolTests)
		.where(
			and(
				eq(appCatalogToolTests.catalogAppId, catalogAppId),
				eq(appCatalogToolTests.toolName, toolName),
			),
		);
	const testCount = totalCountResult[0]?.count ?? 0;

	// Get best example (most recent successful test with good output)
	const bestExample = recentTests.find(
		(t) => t.success && t.inputUsed && t.outputReceived && t.outputValid,
	);

	// Get most recent test
	const lastTest = recentTests[0];

	await db
		.update(appCatalogMcpTools)
		.set({
			lastTestedAt: lastTest?.testedAt ?? null,
			lastTestSuccess: lastTest?.success ?? null,
			testSuccessRate: successRate,
			avgLatencyMs,
			testCount,
			exampleInput: bestExample?.inputUsed ?? null,
			exampleOutput: bestExample?.outputReceived ?? null,
		})
		.where(
			and(
				eq(appCatalogMcpTools.catalogAppId, catalogAppId),
				eq(appCatalogMcpTools.toolName, toolName),
			),
		);
}

/**
 * Options for getting tools needing tests
 */
export interface GetToolsNeedingTestOptions {
	limit?: number;
	maxAgeHours?: number;
	healthyAppsOnly?: boolean;
	catalogAppIds?: string[];
	toolNames?: string[];
}

/**
 * Get tools that need testing
 * Prioritizes:
 * 1. Never tested tools
 * 2. Tools with oldest test dates
 * 3. Tools with low success rates (need re-validation)
 */
export async function getToolsNeedingTest(
	db: Database,
	options: GetToolsNeedingTestOptions = {},
): Promise<CatalogMcpTool[]> {
	const {
		limit = 50,
		maxAgeHours = 24,
		healthyAppsOnly = true,
		catalogAppIds,
		toolNames,
	} = options;

	const cutoff = new Date(
		Date.now() - maxAgeHours * 60 * 60 * 1000,
	).toISOString();

	// Build conditions
	const conditions = [
		// Tool not removed
		isNull(appCatalogMcpTools.removedAt),
		// App is enabled
		eq(appCatalog.status, "ENABLED"),
		// Has MCP endpoint
		sql`${appCatalog.mcpEndpointNormalized} IS NOT NULL`,
	];

	if (healthyAppsOnly) {
		conditions.push(inArray(appCatalog.healthStatus, ["healthy", "degraded"]));
	}
	if (catalogAppIds && catalogAppIds.length > 0) {
		conditions.push(
			sql`${appCatalogMcpTools.catalogAppId} IN (SELECT value FROM json_each(${JSON.stringify(catalogAppIds)}))`,
		);
	}
	if (toolNames && toolNames.length > 0) {
		conditions.push(
			sql`${appCatalogMcpTools.toolName} IN (SELECT value FROM json_each(${JSON.stringify(toolNames)}))`,
		);
	}

	// Filter to tools needing test
	conditions.push(
		sql`(
			${appCatalogMcpTools.lastTestedAt} IS NULL
			OR ${appCatalogMcpTools.testCount} = 0
			OR ${appCatalogMcpTools.lastTestedAt} < ${cutoff}
			OR ${appCatalogMcpTools.testSuccessRate} < 0.5
		)`,
	);

	const results = await db
		.select({
			tool: appCatalogMcpTools,
		})
		.from(appCatalogMcpTools)
		.innerJoin(appCatalog, eq(appCatalogMcpTools.catalogAppId, appCatalog.id))
		.where(and(...conditions))
		.orderBy(
			// Prioritize: never tested > low success > oldest
			sql`CASE
				WHEN ${appCatalogMcpTools.testCount} = 0 OR ${appCatalogMcpTools.testCount} IS NULL THEN 0
				WHEN ${appCatalogMcpTools.testSuccessRate} < 0.5 THEN 1
				ELSE 2
			END`,
			appCatalogMcpTools.lastTestedAt,
		)
		.limit(limit);

	return results.map((r) => r.tool);
}

/**
 * Tool test statistics
 */
export interface ToolTestStats {
	totalTools: number;
	testedTools: number;
	untestedTools: number;
	totalTests: number;
	successfulTests: number;
	failedTests: number;
	overallSuccessRate: number;
	avgLatencyMs: number | null;
	testsByType: {
		programmatic: number;
		ai_eval: number;
	};
	testsByErrorClass: Record<string, number>;
}

/**
 * Get overall tool test statistics
 */
export async function getToolTestStats(db: Database): Promise<ToolTestStats> {
	const [
		totalToolsResult,
		testedToolsResult,
		totalTestsResult,
		successfulTestsResult,
		avgLatencyResult,
		testsByTypeResult,
		testsByErrorResult,
	] = await Promise.all([
		// Total tools (not removed, from enabled apps)
		db
			.select({ count: count() })
			.from(appCatalogMcpTools)
			.innerJoin(appCatalog, eq(appCatalogMcpTools.catalogAppId, appCatalog.id))
			.where(
				and(
					isNull(appCatalogMcpTools.removedAt),
					eq(appCatalog.status, "ENABLED"),
				),
			),
		// Tested vs untested tools
		db
			.select({ count: count() })
			.from(appCatalogMcpTools)
			.innerJoin(appCatalog, eq(appCatalogMcpTools.catalogAppId, appCatalog.id))
			.where(
				and(
					isNull(appCatalogMcpTools.removedAt),
					eq(appCatalog.status, "ENABLED"),
					sql`${appCatalogMcpTools.testCount} > 0`,
				),
			),
		// Total tests
		db.select({ count: count() }).from(appCatalogToolTests),
		// Successful tests
		db
			.select({ count: count() })
			.from(appCatalogToolTests)
			.where(eq(appCatalogToolTests.success, true)),
		// Average latency
		db
			.select({
				avg: sql<number>`AVG(${appCatalogToolTests.latencyMs})`,
			})
			.from(appCatalogToolTests)
			.where(sql`${appCatalogToolTests.latencyMs} IS NOT NULL`),
		// Tests by type
		db
			.select({
				testType: appCatalogToolTests.testType,
				count: count(),
			})
			.from(appCatalogToolTests)
			.groupBy(appCatalogToolTests.testType),
		// Tests by error class (for failed tests)
		db
			.select({
				errorClass: appCatalogToolTests.errorClass,
				count: count(),
			})
			.from(appCatalogToolTests)
			.where(
				and(
					eq(appCatalogToolTests.success, false),
					sql`${appCatalogToolTests.errorClass} IS NOT NULL`,
				),
			)
			.groupBy(appCatalogToolTests.errorClass),
	]);

	const totalTools = totalToolsResult[0]?.count ?? 0;
	const testedTools = testedToolsResult[0]?.count ?? 0;
	const totalTests = totalTestsResult[0]?.count ?? 0;
	const successfulTests = successfulTestsResult[0]?.count ?? 0;

	const testsByType = {
		programmatic: 0,
		ai_eval: 0,
	};
	for (const row of testsByTypeResult) {
		if (row.testType === "programmatic") {
			testsByType.programmatic = row.count;
		} else if (row.testType === "ai_eval") {
			testsByType.ai_eval = row.count;
		}
	}

	const testsByErrorClass: Record<string, number> = {};
	for (const row of testsByErrorResult) {
		if (row.errorClass) {
			testsByErrorClass[row.errorClass] = row.count;
		}
	}

	return {
		totalTools,
		testedTools,
		untestedTools: totalTools - testedTools,
		totalTests,
		successfulTests,
		failedTests: totalTests - successfulTests,
		overallSuccessRate: totalTests > 0 ? successfulTests / totalTests : 0,
		avgLatencyMs: avgLatencyResult[0]?.avg
			? Math.round(avgLatencyResult[0].avg)
			: null,
		testsByType,
		testsByErrorClass,
	};
}

/**
 * Get tool tests for an entire app (all tools)
 */
export async function getToolTestsForApp(
	db: Database,
	catalogAppId: string,
	options: GetToolTestsOptions = {},
): Promise<CatalogToolTest[]> {
	const { limit = 100, offset = 0, testType, successOnly, days } = options;

	const conditions = [eq(appCatalogToolTests.catalogAppId, catalogAppId)];

	if (testType) {
		conditions.push(eq(appCatalogToolTests.testType, testType));
	}

	if (successOnly) {
		conditions.push(eq(appCatalogToolTests.success, true));
	}

	if (days) {
		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		conditions.push(gte(appCatalogToolTests.testedAt, cutoff.toISOString()));
	}

	return db
		.select()
		.from(appCatalogToolTests)
		.where(and(...conditions))
		.orderBy(desc(appCatalogToolTests.testedAt))
		.limit(limit)
		.offset(offset);
}

/**
 * Get latest tool tests globally across catalog apps.
 */
export async function getLatestToolTests(
	db: Database,
	options: GetToolTestsOptions & { toolName?: string } = {},
): Promise<{ tests: CatalogToolTest[]; total: number }> {
	const {
		limit = 100,
		offset = 0,
		testType,
		successOnly,
		days,
		toolName,
	} = options;

	const conditions = [];

	if (testType) {
		conditions.push(eq(appCatalogToolTests.testType, testType));
	}

	if (successOnly) {
		conditions.push(eq(appCatalogToolTests.success, true));
	}

	if (toolName) {
		conditions.push(eq(appCatalogToolTests.toolName, toolName));
	}

	if (days) {
		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		conditions.push(gte(appCatalogToolTests.testedAt, cutoff.toISOString()));
	}

	const where = conditions.length > 0 ? and(...conditions) : undefined;
	const [tests, totalRows] = await Promise.all([
		db
			.select()
			.from(appCatalogToolTests)
			.where(where)
			.orderBy(desc(appCatalogToolTests.testedAt))
			.limit(limit)
			.offset(offset),
		db.select({ value: count() }).from(appCatalogToolTests).where(where),
	]);

	return {
		tests,
		total: totalRows[0]?.value ?? 0,
	};
}
