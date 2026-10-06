import { describe, expect, it, vi } from "vite-plus/test";
import {
	groupToolTestTargets,
	splitToolTestsIntoBatches,
	TOOL_TEST_BATCH_SIZE,
} from "./tool-test-batching";

describe("groupToolTestTargets", () => {
	it("preserves exact app/tool pairs while deduplicating retries", () => {
		expect(
			groupToolTestTargets([
				{ catalogAppId: "app-a", toolName: "shared" },
				{ catalogAppId: "app-b", toolName: "shared" },
				{ catalogAppId: "app-a", toolName: "only-a" },
				{ catalogAppId: "app-a", toolName: "shared" },
			]),
		).toEqual([
			{ catalogAppId: "app-a", toolNames: ["shared", "only-a"] },
			{ catalogAppId: "app-b", toolNames: ["shared"] },
		]);
	});
});

describe("splitToolTestsIntoBatches", () => {
	it("splits work into independently retryable five-tool steps", () => {
		const tools = Array.from({ length: 12 }, (_, index) => index);

		expect(TOOL_TEST_BATCH_SIZE).toBe(5);
		expect(splitToolTestsIntoBatches(tools)).toEqual([
			[0, 1, 2, 3, 4],
			[5, 6, 7, 8, 9],
			[10, 11],
		]);
	});

	it("does not create empty batches", () => {
		expect(splitToolTestsIntoBatches([])).toEqual([]);
	});

	it("rejects invalid batch sizes", () => {
		expect(() => splitToolTestsIntoBatches([1], 0)).toThrow(
			"batchSize must be a positive integer",
		);
	});
});

// Exercise the real workflow scorer seam: generated inputs stay separate from judgments.
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));
const evaluationMocks = vi.hoisted(() => ({
	judge: vi.fn(),
	call: vi.fn(),
	generate: vi.fn(),
}));
vi.mock("@tedix/db/client", () => ({ createDbClient: () => ({}) }));
vi.mock("../services/jev-judgment", () => ({
	executeJevJudgment: evaluationMocks.judge,
}));
vi.mock("../lib/mcp-client", () => ({ callMcpTool: evaluationMocks.call }));
vi.mock("../lib/tool-evaluator", () => ({
	generateSmartTestInput: evaluationMocks.generate,
}));
import { McpToolTestWorkflow } from "./tool-test-workflow";
import type { KernelExecutionAttempt } from "../rpc/routers/kernel/gateway-attribution";

it("uses Jev by default for ai_eval and retains actual usage on rejected judgment", async () => {
	evaluationMocks.generate.mockResolvedValue({
		input: { id: "o1" },
		prompt: "generated",
		tokensUsed: 8,
	});
	evaluationMocks.call.mockResolvedValue({
		success: true,
		latencyMs: 1,
		output: { status: "shipped" },
	});
	evaluationMocks.judge.mockImplementation(
		async ({
			context,
		}: {
			context: { executionAttempts: KernelExecutionAttempt[] };
		}) => {
			context.executionAttempts.push({
				usage: { inputTokens: 100, outputTokens: 5 },
			} as KernelExecutionAttempt);
			return null;
		},
	);
	const workflow = Object.create(McpToolTestWorkflow.prototype);
	workflow.env = { DB: {}, AI: {}, AI_GATEWAY_LLM_ID: "gateway" };
	const result = await workflow.testTool(
		{
			id: "tool-id",
			toolName: "get_order",
			mcpEndpoint: "https://example.test/mcp",
		},
		1000,
		"ai_eval",
		"workflow-id",
		"platform-org",
	);
	expect(evaluationMocks.judge).toHaveBeenCalledWith(
		expect.objectContaining({
			source: "system:tool-output-quality",
			context: expect.objectContaining({
				organizationId: "platform-org",
				runId: "workflow-id",
				sessionKey: "tool-test:workflow-id:tool-id",
			}),
		}),
	);
	expect(result.aiOutputQualityScore).toBeUndefined();
	expect(result.aiTokensUsed).toBe(113);
	expect(result.success).toBe(true);
	expect(result.outputValid).toBe(true);
});

it("leaves programmatic tests free of semantic inference", async () => {
	evaluationMocks.judge.mockClear();
	evaluationMocks.generate.mockClear();
	evaluationMocks.call.mockResolvedValue({
		success: true,
		latencyMs: 1,
		output: { status: "ok" },
	});
	const workflow = Object.create(McpToolTestWorkflow.prototype);
	workflow.env = { DB: {}, AI: {} };
	await workflow.testTool(
		{
			id: "tool-id",
			toolName: "get_order",
			mcpEndpoint: "https://example.test/mcp",
		},
		1000,
		"programmatic",
		"workflow-id",
		null,
	);
	expect(evaluationMocks.judge).not.toHaveBeenCalled();
	expect(evaluationMocks.generate).not.toHaveBeenCalled();
});
