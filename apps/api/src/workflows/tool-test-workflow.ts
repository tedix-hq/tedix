/**
 * McpToolTestWorkflow - Cloudflare Workflow for testing MCP tools
 *
 * Orchestrates tool testing for apps in the catalog:
 * 1. Fetch tools that need testing from D1
 * 2. Generate test inputs (programmatic or AI-powered)
 * 3. Call each tool and capture results
 * 4. Store test results and update metrics
 * 5. Optionally run AI evaluations on outputs
 *
 * Runs daily at 6am UTC (after MCP scan at 5am)
 *
 * @see apps/api/src/lib/mcp-client.ts for tool execution
 * @see apps/api/src/lib/test-input-generator.ts for input generation
 * @see apps/api/src/lib/tool-evaluator.ts for AI evaluations
 */

import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import { getOrganizationBySlug } from "@tedix/db/queries/organizations";
import { executeJevJudgment } from "../services/jev-judgment";
import {
	scoreOutputQuality,
	OUTPUT_QUALITY_QUESTIONS,
} from "../services/jev-output-quality";
import type { KernelExecutionAttempt } from "../rpc/routers/kernel/gateway-attribution";
import { createDbClient } from "@tedix/db/client";
import { getCatalogAppById } from "@tedix/db/queries/catalog/get-app";
import { getCatalogMcpTools } from "@tedix/db/queries/catalog/mcp-tools";
import {
	getToolsNeedingTest,
	insertToolTest,
	updateToolTestMetrics,
} from "@tedix/db/queries/catalog/tool-tests";
import { toJsonRecord } from "@tedix/db/utils/json";
import { callMcpTool } from "../lib/mcp-client";
import {
	generateTestInput,
	truncateOutput,
	validateToolOutput,
} from "../lib/test-input-generator";
import { generateSmartTestInput } from "../lib/tool-evaluator";
import {
	groupToolTestTargets,
	splitToolTestsIntoBatches,
	TOOL_TEST_BATCH_SIZE,
	type ToolTestTarget,
} from "./tool-test-batching";

// =============================================================================
// Types
// =============================================================================

export interface McpToolTestWorkflowParams {
	/** Exact tools selected by an operator-triggered run. */
	tools?: ToolTestTarget[];
	/** Max tools to test in this run (default: 50) */
	limit?: number;
	/** Max age in hours before re-testing (default: 24) */
	maxAgeHours?: number;
	/** Timeout per tool test in ms (default: 15000) */
	timeout?: number;
	/** Test type: programmatic (free) or ai_eval (uses Workers AI) */
	testType?: "programmatic" | "ai_eval";
	/** Only test tools from healthy apps */
	healthyAppsOnly?: boolean;
}

/** Minimal tool info for testing - keeps step output small */
interface ToolTestInfo {
	id: string;
	catalogAppId: string;
	toolName: string;
	description: string | null;
	inputSchema: Record<string, unknown> | null;
	mcpEndpoint: string;
	appName: string;
}

interface BatchResult {
	batchIndex: number;
	tested: number;
	successful: number;
	failed: number;
	errors: string[];
}

// =============================================================================
// Workflow Implementation
// =============================================================================

export class McpToolTestWorkflow extends WorkflowEntrypoint<
	CloudflareEnv,
	McpToolTestWorkflowParams
> {
	async run(
		event: WorkflowEvent<McpToolTestWorkflowParams>,
		step: WorkflowStep,
	) {
		const {
			tools: explicitTargets,
			limit = 50,
			maxAgeHours = 24,
			timeout = 15000,
			testType = "programmatic",
			healthyAppsOnly = true,
		} = event.payload;

		console.log(
			`[Tool Test] Starting workflow: limit=${limit}, maxAgeHours=${maxAgeHours}, ` +
				`timeout=${timeout}ms, testType=${testType}, explicitTargets=${explicitTargets?.length ?? 0}`,
		);

		const db = createDbClient(this.env.DB);
		const platformOrgId =
			testType === "ai_eval"
				? await step.do(
						"resolve-quality-billing-org",
						async () => (await getOrganizationBySlug(db, "tedix"))?.id ?? null,
					)
				: null;

		// Step 1: Fetch tools needing tests (minimal fields)
		const toolsJson = await step.do(
			"fetch-tools-needing-test",
			{
				retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
				timeout: "2 minutes",
			},
			async () => {
				const targetGroups = explicitTargets?.length
					? groupToolTestTargets(explicitTargets)
					: [];
				const tools = targetGroups.length
					? (
							await Promise.all(
								targetGroups.map(async ({ catalogAppId, toolNames }) => {
									const requestedNames = new Set(toolNames);
									const appTools = await getCatalogMcpTools(db, catalogAppId);
									return appTools.filter((tool) =>
										requestedNames.has(tool.toolName),
									);
								}),
							)
						).flat()
					: await getToolsNeedingTest(db, {
							limit,
							maxAgeHours,
							healthyAppsOnly,
						});

				// Fetch app info for each tool to get endpoints
				const toolsWithEndpoints: ToolTestInfo[] = [];

				for (const tool of tools) {
					const app = await getCatalogAppById(db, tool.catalogAppId);
					if (app?.mcpEndpointNormalized) {
						toolsWithEndpoints.push({
							id: tool.id,
							catalogAppId: tool.catalogAppId,
							toolName: tool.toolName,
							description: tool.description,
							inputSchema: tool.inputSchema as Record<string, unknown> | null,
							mcpEndpoint: app.mcpEndpointNormalized,
							appName: app.name,
						});
					}
				}

				console.log(
					`[Tool Test] Found ${toolsWithEndpoints.length} tools to test ` +
						`(${tools.length} total, filtered for valid endpoints)`,
				);

				return JSON.stringify(toolsWithEndpoints);
			},
		);

		const tools = JSON.parse(toolsJson as string) as ToolTestInfo[];

		if (tools.length === 0) {
			console.log("[Tool Test] No tools need testing");
			return {
				success: true,
				message: "No tools need testing",
				toolsTested: 0,
			};
		}

		// Step 2: Process tools in batches
		const batches = splitToolTestsIntoBatches(tools);
		const batchResults: BatchResult[] = [];

		console.log(
			`[Tool Test] Processing ${batches.length} batches of up to ${TOOL_TEST_BATCH_SIZE} tools`,
		);

		for (let i = 0; i < batches.length; i++) {
			const batch = batches[i];
			if (!batch || batch.length === 0) continue;

			const batchResult = await step.do(
				`test-batch-${i}`,
				{
					retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
					timeout: "5 minutes",
				},
				async () => {
					return this.processBatch(
						i,
						batch,
						timeout,
						testType,
						event.instanceId,
						platformOrgId,
					);
				},
			);

			batchResults.push(batchResult as BatchResult);

			const result = batchResult as BatchResult;
			console.log(
				`[Tool Test] Batch ${i + 1}/${batches.length}: ${result.tested} tested, ` +
					`${result.successful} successful, ${result.failed} failed`,
			);
		}

		// Aggregate results
		const totalTested = batchResults.reduce((sum, r) => sum + r.tested, 0);
		const totalSuccessful = batchResults.reduce(
			(sum, r) => sum + r.successful,
			0,
		);
		const totalFailed = batchResults.reduce((sum, r) => sum + r.failed, 0);
		const totalErrors = batchResults.reduce(
			(sum, r) => sum + r.errors.length,
			0,
		);
		const allErrors = batchResults.flatMap((r) => r.errors);

		console.log(
			`[Tool Test] Workflow complete: ${totalTested} tested, ` +
				`${totalSuccessful} successful, ${totalFailed} failed, ${totalErrors} errors`,
		);

		return {
			success: true,
			toolsTested: totalTested,
			successful: totalSuccessful,
			failed: totalFailed,
			errors: totalErrors,
			errorDetails: allErrors.slice(0, 20),
			batches: batches.length,
			testType,
		};
	}

	// ==========================================================================
	// Helpers
	// ==========================================================================

	private async processBatch(
		batchIndex: number,
		tools: ToolTestInfo[],
		timeout: number,
		testType: "programmatic" | "ai_eval",
		workflowId: string,
		platformOrgId: string | null,
	): Promise<BatchResult> {
		const db = createDbClient(this.env.DB);
		let tested = 0;
		let successful = 0;
		let failed = 0;
		const errors: string[] = [];

		for (const tool of tools) {
			try {
				const result = await this.testTool(
					tool,
					timeout,
					testType,
					workflowId,
					platformOrgId,
				);

				// Insert test result
				await insertToolTest(db, {
					catalogAppId: tool.catalogAppId,
					toolName: tool.toolName,
					testType,
					inputSource:
						testType === "ai_eval" ? "ai_generated" : "schema_generated",
					success: result.success,
					latencyMs: result.latencyMs,
					errorMessage: result.errorMessage,
					errorClass: result.errorClass,
					inputUsed: toJsonRecord(result.inputUsed),
					outputReceived:
						result.outputReceived === undefined
							? undefined
							: toJsonRecord(result.outputReceived),
					outputValid: result.outputValid,
					aiModel: result.aiModel,
					aiPromptUsed: result.aiPromptUsed,
					aiOutputQualityScore: result.aiOutputQualityScore,
					aiTokensUsed: result.aiTokensUsed,
				});

				// Update metrics
				await updateToolTestMetrics(db, tool.catalogAppId, tool.toolName);

				tested++;
				if (result.success) {
					successful++;
				} else {
					failed++;
				}

				console.log(
					`[Tool Test] ${tool.appName}/${tool.toolName}: ` +
						`${result.success ? "✓" : "✗"} (${result.latencyMs}ms)`,
				);
			} catch (error) {
				const errorMessage = `${tool.appName}/${tool.toolName}: ${
					error instanceof Error ? error.message : String(error)
				}`;
				errors.push(errorMessage);
				console.error(`[Tool Test] ${errorMessage}`);
			}
		}

		return {
			batchIndex,
			tested,
			successful,
			failed,
			errors,
		};
	}

	private async testTool(
		tool: ToolTestInfo,
		timeout: number,
		testType: "programmatic" | "ai_eval",
		workflowId: string,
		platformOrgId: string | null,
	): Promise<{
		success: boolean;
		latencyMs: number;
		errorMessage?: string;
		errorClass?: "validation" | "timeout" | "auth" | "server_error" | "unknown";
		inputUsed: Record<string, unknown>;
		outputReceived: Record<string, unknown> | undefined;
		outputValid: boolean;
		aiModel?: string;
		aiPromptUsed?: string;
		aiOutputQualityScore?: number;
		aiTokensUsed?: number;
	}> {
		// Generate test input
		let testInput: Record<string, unknown>;
		let aiPrompt: string | undefined;
		let aiInputTokens = 0;

		if (testType === "ai_eval" && this.env.AI) {
			// Use AI to generate smart test input
			try {
				const aiResult = await generateSmartTestInput(
					this.env.AI as Parameters<typeof generateSmartTestInput>[0],
					{
						name: tool.toolName,
						description: tool.description || undefined,
						inputSchema: tool.inputSchema || undefined,
					},
					{ gatewayId: this.env.AI_GATEWAY_LLM_ID },
				);
				testInput = aiResult.input;
				aiPrompt = aiResult.prompt;
				aiInputTokens = aiResult.tokensUsed;
			} catch {
				// Fall back to programmatic
				testInput = generateTestInput(tool.inputSchema);
			}
		} else {
			// Programmatic input generation
			testInput = generateTestInput(tool.inputSchema);
		}

		// Call the tool
		const result = await callMcpTool(
			tool.mcpEndpoint,
			tool.toolName,
			testInput,
			{ timeout },
		);

		// Validate output
		const validation = validateToolOutput(result.output);

		// AI quality scoring (if enabled and tool succeeded)
		let aiQualityScore: number | undefined;
		let aiQualityTokens = 0;

		let qualityModel: string | undefined;
		if (testType === "ai_eval" && result.success) {
			const attempts: KernelExecutionAttempt[] = [];
			try {
				const qualityResult = await scoreOutputQuality(
					async (state) => {
						const db = createDbClient(this.env.DB);
						if (!platformOrgId) return { result: null, tokensUsed: 0 };
						const judgment = await executeJevJudgment({
							db,
							env: this.env,
							context: {
								organizationId: platformOrgId,
								runId: workflowId,
								sessionKey: `tool-test:${workflowId}:${tool.id}`,
								executionAttempts: attempts,
							},
							state,
							questions: OUTPUT_QUALITY_QUESTIONS,
							source: "system:tool-output-quality",
							billingSource: "system",
							sessionType: "unattributed",
							timeoutMs: 5000,
						});
						return {
							result: judgment,
							tokensUsed: attempts.reduce(
								(sum, attempt) =>
									sum +
									(attempt.usage?.inputTokens ?? 0) +
									(attempt.usage?.outputTokens ?? 0),
								0,
							),
						};
					},
					{ name: tool.toolName, description: tool.description || undefined },
					testInput,
					result.output,
				);
				aiQualityScore = qualityResult.qualityScore;
				qualityModel = qualityResult.model;
			} catch {
				console.warn("[Tool Test] Jev quality assessment unavailable");
			} finally {
				// Retain real reported paid usage even if answer validation/persistence failed.
				aiQualityTokens = attempts.reduce(
					(sum, attempt) =>
						sum +
						(attempt.usage?.inputTokens ?? 0) +
						(attempt.usage?.outputTokens ?? 0),
					0,
				);
			}
		}

		// Map MCP client error codes to test error classes
		const errorClass = this.mapErrorCode(result.errorCode);

		// Normalize output to Record<string, unknown> for storage
		let outputReceived: Record<string, unknown> | undefined;
		const truncatedOutput = truncateOutput(result.output, 10000);
		if (truncatedOutput !== null && truncatedOutput !== undefined) {
			if (
				typeof truncatedOutput === "object" &&
				!Array.isArray(truncatedOutput)
			) {
				outputReceived = truncatedOutput as Record<string, unknown>;
			} else {
				// Wrap primitive or array outputs
				outputReceived = { value: truncatedOutput };
			}
		}

		return {
			success: result.success,
			latencyMs: result.latencyMs,
			errorMessage: result.error,
			errorClass,
			inputUsed: testInput,
			outputReceived,
			outputValid: validation.valid,
			aiModel:
				qualityModel ??
				(aiPrompt ? "@cf/meta/llama-3.3-70b-instruct-fp8-fast" : undefined),
			aiPromptUsed: aiPrompt,
			aiOutputQualityScore: aiQualityScore,
			aiTokensUsed:
				aiInputTokens + aiQualityTokens > 0
					? aiInputTokens + aiQualityTokens
					: undefined,
		};
	}

	/**
	 * Map MCP client error codes to tool test error classes
	 */
	private mapErrorCode(
		errorCode: string | undefined,
	):
		| "validation"
		| "timeout"
		| "auth"
		| "server_error"
		| "unknown"
		| undefined {
		if (!errorCode) return undefined;

		switch (errorCode) {
			case "TIMEOUT":
				return "timeout";
			case "AUTH_REQUIRED":
				return "auth";
			case "INVALID_URL":
			case "INVALID_PROTOCOL":
				return "validation";
			case "CONNECTION_REFUSED":
			case "BLOCKED":
			case "DNS":
			case "TLS":
				return "server_error";
			default:
				return "unknown";
		}
	}
}
