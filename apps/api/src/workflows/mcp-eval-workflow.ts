import { generateText, jsonSchema, stepCountIs } from "ai";
import { kernelModel } from "../rpc/routers/kernel/llm";

/**
 * McpEvalWorkflow - Async LLM-powered MCP tool routing evaluation
 *
 * Flow:
 * 1. MCP Connect - Initialize MCP session via MCP_SERVICE binding
 * 2. Tool Discovery - List all available tools
 * 3. Test Generation - Build test suite (custom or auto-generated)
 * 4. LLM Evaluation - Run each test through its configured model and metered gateway
 * 5. Scoring - Calculate pass/fail rates and save results
 */

import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { createDbClient } from "@tedix/db/client";
import { getAppBySlug } from "@tedix/db/queries/app-records";
import { updateJobProgress, updateJobStatus } from "@tedix/db/queries/jobs";
import { toJsonValue } from "@tedix/db/utils/json";
import { MCP_MODERN_PROTOCOL_VERSION } from "@tedix/mcp-shared/protocol";

import { buildMcpHost, buildMcpUrl } from "../lib/mcp-client";

import { FirstPartyMcpError } from "../lib/first-party-mcp";
import { listMcpEvalTools, type McpEvalTool } from "./mcp-eval-client";

// =============================================================================
// Types
// =============================================================================

export interface McpEvalWorkflowParams {
	jobId: string;
	appSlug: string;
	model: string;
	customTests?: Array<{
		title: string;
		prompt: string;
		expectedTools: string[];
	}>;
}

type McpTool = McpEvalTool;

interface EvalTestCase {
	title: string;
	prompt: string;
	expectedTools: string[];
}

interface EvalTestResult {
	title: string;
	prompt: string;
	expectedTools: string[];
	calledTools: string[];
	passed: boolean;
	durationMs: number;
	error?: string;
}

// =============================================================================
// Metered model selection and tool evaluation
// =============================================================================

interface OpenAIToolDef {
	name: string;
	description: string;
	input_schema: Record<string, unknown>;
}

async function callLlmWithTools(
	env: CloudflareEnv,
	model: string,
	prompt: string,
	tools: OpenAIToolDef[],
	// The evaluated app's owning org (apps.organizationId is NOT NULL) --
	// threaded into the selected model transport's cf-aig-metadata so these calls
	// are billing-attributable instead of landing as bare "surface":"kernel"
	// with no orgId (which the tedi_call_costs org_id trigger now rejects).
	organizationId: string,
): Promise<{ calledTools: string[]; error?: string }> {
	const selected = kernelModel(
		env,
		{ modelRef: model },
		{ organizationId, source: "evaluation" },
	);
	if (!selected) throw new Error("Configured evaluation model is unavailable");
	const result = await generateText({
		model: selected.model,
		prompt,
		maxOutputTokens: 1024,
		stopWhen: stepCountIs(5),
		tools: Object.fromEntries(
			tools.map((tool) => [
				tool.name,
				{
					description: tool.description,
					inputSchema: jsonSchema(tool.input_schema),
					execute: async () => ({ status: "ok", data: "mock eval result" }),
				},
			]),
		),
	});
	return {
		calledTools: result.steps.flatMap((step) =>
			step.toolCalls.map((call) => call.toolName),
		),
	};
}

// =============================================================================
// Test Generation
// =============================================================================

function generateAutoTests(tools: McpTool[]): EvalTestCase[] {
	return tools.slice(0, 20).map((tool) => ({
		title: `route-to-${tool.name}`,
		prompt: tool.description
			? `${tool.description}. Use the ${tool.name} tool.`
			: `Use the ${tool.name} tool to perform its function.`,
		expectedTools: [tool.name],
	}));
}

export function buildMcpEvalTestSuite(
	tools: McpTool[],
	customTests?: McpEvalWorkflowParams["customTests"],
): { suite: EvalTestCase[]; source: "custom" | "auto-generated" } {
	return customTests && customTests.length > 0
		? { suite: customTests, source: "custom" }
		: { suite: generateAutoTests(tools), source: "auto-generated" };
}

// =============================================================================
// Workflow
// =============================================================================

export class McpEvalWorkflow extends WorkflowEntrypoint<
	CloudflareEnv,
	McpEvalWorkflowParams
> {
	async run(event: WorkflowEvent<McpEvalWorkflowParams>, step: WorkflowStep) {
		const { jobId, appSlug, model, customTests } = event.payload;
		const db = createDbClient(this.env.DB);
		const overallStart = Date.now();

		// Step 1: Mark job as running
		await step.do(
			"mark-running",
			{ retries: { limit: 2, delay: "2 seconds" }, timeout: "10 seconds" },
			async () => {
				await updateJobStatus(db, jobId, "running");
				await updateJobProgress(db, jobId, {
					stage: "connecting",
					message: "Connecting to MCP server...",
					progress: 0,
				});
			},
		);

		// Step 2: Connect to MCP and list tools
		const rawTools = await step.do(
			"mcp-connect-and-list-tools",
			{ retries: { limit: 2, delay: "5 seconds" } },
			async () => {
				const mcpBaseUrl = this.env.MCP_URL;
				if (!mcpBaseUrl) throw new NonRetryableError("MCP_URL not configured");

				const mcpService = this.env.MCP_SERVICE;
				if (!mcpService)
					throw new NonRetryableError("MCP_SERVICE binding not available");

				const mcpUrl = buildMcpUrl(mcpBaseUrl);
				const mcpHost = buildMcpHost(appSlug, mcpBaseUrl);

				let foundTools: McpTool[];
				try {
					foundTools = await listMcpEvalTools({
						fetch: (url, init) => mcpService.fetch(url, init),
						mcpUrl,
						mcpHost,
					});
				} catch (error) {
					if (
						error instanceof FirstPartyMcpError &&
						error.kind === "unsupported_protocol"
					) {
						throw new NonRetryableError(
							`Tedix MCP host does not advertise required protocol ${MCP_MODERN_PROTOCOL_VERSION}`,
						);
					}
					throw error;
				}
				if (foundTools.length === 0)
					throw new Error("No tools found on MCP server");

				return foundTools;
			},
		);
		const tools = rawTools as McpTool[];

		// Step 3: Build test suite (custom tests or tool-derived tests)
		const rawTests = await step.do(
			"build-test-suite",
			async (): Promise<EvalTestCase[]> => {
				const { suite, source } = buildMcpEvalTestSuite(tools, customTests);

				await updateJobProgress(db, jobId, {
					stage: "evaluating",
					message: `Running ${suite.length} ${source} tests with ${model}...`,
					progress: 10,
					testsCompleted: 0,
					totalTests: suite.length,
				});

				return suite;
			},
		);
		const tests = rawTests as EvalTestCase[];

		// Step 4: Run each test (1 at a time for LLM).
		// Build OpenAI tool definitions
		const openaiTools: OpenAIToolDef[] = tools.map((t) => ({
			name: t.name,
			description: t.description || `Tool: ${t.name}`,
			input_schema: t.inputSchema || { type: "object", properties: {} },
		}));

		// The evaluated app's owning org (apps.organizationId is NOT NULL) --
		// threaded into the selected model transport below for billing attribution.
		const evaluatedApp = await getAppBySlug(db, appSlug);
		const organizationId = evaluatedApp?.organizationId;
		if (!organizationId) {
			throw new NonRetryableError(
				`Cannot bill MCP evaluation for missing app: ${appSlug}`,
			);
		}

		const results: EvalTestResult[] = [];

		for (let i = 0; i < tests.length; i++) {
			const test = tests[i]!;
			const rawTestResult = await step.do(
				`eval-test-${i}-${test.title.slice(0, 30)}`,
				{ retries: { limit: 1, delay: "3 seconds" } },
				async (): Promise<EvalTestResult> => {
					const start = Date.now();
					try {
						const { calledTools, error } = await callLlmWithTools(
							this.env,
							model,
							test.prompt,
							openaiTools,
							organizationId,
						);

						const passed = test.expectedTools.every((t) =>
							calledTools.includes(t),
						);

						return {
							title: test.title,
							prompt: test.prompt,
							expectedTools: test.expectedTools,
							calledTools,
							passed,
							durationMs: Date.now() - start,
							error,
						};
					} catch (err) {
						return {
							title: test.title,
							prompt: test.prompt,
							expectedTools: test.expectedTools,
							calledTools: [],
							passed: false,
							durationMs: Date.now() - start,
							error: err instanceof Error ? err.message : String(err),
						};
					}
				},
			);
			const testResult = rawTestResult as EvalTestResult;

			results.push(testResult);

			// Update progress every test
			await step.do(
				`progress-${i}`,
				{ retries: { limit: 1, delay: "1 second" }, timeout: "10 seconds" },
				async () => {
					await updateJobProgress(db, jobId, {
						stage: "evaluating",
						message: `Test ${i + 1}/${tests.length}: ${testResult.passed ? "PASS" : "FAIL"} - ${test.title}`,
						progress: Math.round(10 + ((i + 1) / tests.length) * 80),
						testsCompleted: i + 1,
						totalTests: tests.length,
					});
				},
			);
		}

		// Step 5: Score and save results
		await step.do(
			"save-results",
			{ retries: { limit: 2, delay: "2 seconds" }, timeout: "30 seconds" },
			async () => {
				const passed = results.filter((r) => r.passed).length;
				const failed = results.filter((r) => !r.passed).length;
				const totalDurationMs = Date.now() - overallStart;
				const score =
					results.length > 0 ? Math.round((passed / results.length) * 100) : 0;

				await updateJobStatus(db, jobId, "completed", {
					result: {
						appSlug,
						model,
						totalTests: results.length,
						passed,
						failed,
						score,
						durationMs: totalDurationMs,
						tests: toJsonValue(results),
					},
				});
			},
		);
	}
}
