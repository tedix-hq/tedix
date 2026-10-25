vi.mock("@tedix/db/queries/data-residency", async (original) => ({
	...(await original<typeof import("@tedix/db/queries/data-residency")>()),
	getOrganizationResidencyPolicy: vi.fn().mockResolvedValue(null),
}));
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

const catalogMocks = vi.hoisted(() => ({
	getApp: vi.fn(),
	getTools: vi.fn(),
	getAppTools: vi.fn(),
}));
vi.mock("@tedix/db/queries/catalog/get-app", () => ({
	getCatalogAppById: catalogMocks.getApp,
}));
vi.mock("@tedix/db/queries/catalog/mcp-tools", () => ({
	getCatalogMcpTools: catalogMocks.getAppTools,
}));
vi.mock("@tedix/db/queries/catalog/tool-tests", () => ({
	getToolsNeedingTest: catalogMocks.getTools,
}));

it.each([false, true])(
	"resolves each app once per fetch, preserving tool order and filtering (explicit=%s)",
	async (explicit) => {
		const appIds = [
			"app-a",
			"missing",
			"app-b",
			"no-endpoint",
			"empty-endpoint",
		];
		const tools = Array.from({ length: 50 }, (_, index) => ({
			id: `tool-${index}`,
			catalogAppId: appIds[index % appIds.length]!,
			toolName: `get_item_${index}`,
			description: `Tool ${index}`,
			inputSchema: { type: "object" },
		}));
		catalogMocks.getTools.mockResolvedValue(tools);
		catalogMocks.getAppTools.mockImplementation(async (_db, id) =>
			tools.filter((tool) => tool.catalogAppId === id),
		);
		const workflow = Object.create(McpToolTestWorkflow.prototype);
		workflow.env = { DB: {} };
		workflow.processBatch = vi.fn().mockResolvedValue({
			tested: 0,
			successful: 0,
			failed: 0,
			errors: [],
		});
		for (const revision of [1, 2]) {
			catalogMocks.getApp.mockReset().mockImplementation(async (_db, id) => {
				if (id === "missing") return null;
				return {
					name: id,
					mcpEndpointNormalized:
						id === "no-endpoint"
							? null
							: id === "empty-endpoint"
								? ""
								: `https://${id}.example.test/mcp/${revision}`,
				};
			});
			const step = {
				do: vi.fn(async (_name, _options, callback) => callback()),
			};
			await workflow.run(
				{
					instanceId: "workflow-id",
					payload: explicit ? { tools } : {},
				},
				step,
			);
			expect(catalogMocks.getApp.mock.calls.map((call) => call[1])).toEqual(
				appIds,
			);
			const orderedTools = explicit
				? appIds.flatMap((id) =>
						tools.filter((tool) => tool.catalogAppId === id),
					)
				: tools;
			expect(JSON.parse(await step.do.mock.results[0]!.value)).toEqual(
				orderedTools
					.filter((tool) => ["app-a", "app-b"].includes(tool.catalogAppId))
					.map((tool) => ({
						...tool,
						appName: tool.catalogAppId,
						mcpEndpoint: `https://${tool.catalogAppId}.example.test/mcp/${revision}`,
					})),
			);
		}
	},
);

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
