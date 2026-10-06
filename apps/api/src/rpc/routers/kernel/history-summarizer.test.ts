/**
 * The production history-summarizer seam.
 *
 * `compactKernelHistory` has always accepted a summarizer; until this module
 * existed nothing in production passed one, so every live Home compaction
 * emitted the extractive digest. These pin the three properties that make the
 * wiring safe to run inside turn assembly:
 *
 *   - the model path actually produces a `source: "model"` checkpoint,
 *   - a failing model degrades to the extractive digest and NEVER propagates
 *     (a throw here would take the operator's whole turn down),
 *   - a null model produces no summarizer at all, so compaction keeps its
 *     pre-existing behavior exactly.
 */

import type { LanguageModel } from "ai";
import { describe, expect, it, vi } from "vite-plus/test";

const mockGenerateText = vi.fn();
// Kernel inference goes through the traced AI SDK namespace
// (`src/lib/traced-ai.ts`) — mocking "ai" would leave the wrapper calling the
// real SDK and emit no spans.
vi.mock("../../../lib/traced-ai", () => ({
	tracedAi: {
		generateText: (...args: unknown[]) => mockGenerateText(...args),
	},
}));

const mockKernelModel = vi.fn();
vi.mock("./llm", () => ({
	kernelModel: (...args: unknown[]) => mockKernelModel(...args),
}));

import type { TediSessionMessage } from "@tedix/tedi-session/session-harness";
import { compactKernelHistory } from "./context-compaction";
import {
	createKernelHistorySummarizer,
	HISTORY_SUMMARY_FUNCTION_ID,
	HISTORY_SUMMARY_SOURCE,
	historySummaryOutputTokens,
} from "./history-summarizer";

const FAKE_MODEL = { modelId: "kernel-test" } as unknown as LanguageModel;
const BUDGET = { historyBudgetChars: 4_000, retainTargetChars: 1_200 };
const GATEWAY = {
	organizationId: "org-summarize",
	runId: "run-1",
	sessionKey: "home:long",
};

function transcript(turns: number, chars = 60): TediSessionMessage[] {
	const messages: TediSessionMessage[] = [];
	for (let i = 0; i < turns; i++) {
		messages.push({ role: "user", content: `ask-${i} ${"a".repeat(chars)}` });
		messages.push({
			role: "assistant",
			content: `reply-${i} ${"b".repeat(chars)}`,
		});
	}
	return messages;
}

function resetMocks() {
	mockGenerateText.mockReset();
	mockKernelModel.mockReset();
}

describe("historySummaryOutputTokens", () => {
	it("scales with the checkpoint ceiling and never goes below a usable floor", () => {
		expect(historySummaryOutputTokens(1_200)).toBe(428);
		expect(historySummaryOutputTokens(8)).toBe(256);
	});
});

describe("createKernelHistorySummarizer", () => {
	it("returns undefined when no model is available", () => {
		resetMocks();
		mockKernelModel.mockReturnValue(null);
		expect(createKernelHistorySummarizer({}, GATEWAY)).toBeUndefined();
		expect(mockGenerateText).not.toHaveBeenCalled();
	});

	it("attributes the call to the compaction surface", async () => {
		resetMocks();
		mockKernelModel.mockReturnValue({
			model: FAKE_MODEL,
			pricingIdentity: null,
			attempts: [],
			forOperation() {
				return this;
			},
		});
		mockGenerateText.mockResolvedValue({ text: "## Goal\nfine" });

		const summarize = createKernelHistorySummarizer({}, GATEWAY);
		await summarize?.({
			systemPrompt: "SYSTEM",
			transcript: '<transcript untrusted="true"></transcript>',
			messages: [],
			maxChars: 1_200,
		});

		// Cost attribution (AI Gateway metadata, built inside kernelModel) and
		// span attribution must name the same surface.
		expect(mockKernelModel.mock.calls[0]?.[2]).toMatchObject({
			organizationId: "org-summarize",
			source: HISTORY_SUMMARY_SOURCE,
		});
		const call = mockGenerateText.mock.calls[0]?.[0] as {
			model: unknown;
			system: string;
			telemetry: { functionId: string };
			runtimeContext: Record<string, string>;
			abortSignal?: AbortSignal;
		};
		expect(call.model).toBe(FAKE_MODEL);
		expect(call.system).toBe("SYSTEM");
		expect(call.telemetry.functionId).toBe(HISTORY_SUMMARY_FUNCTION_ID);
		expect(call.runtimeContext).toMatchObject({
			agentId: "home-kernel",
			source: HISTORY_SUMMARY_SOURCE,
			orgId: "org-summarize",
			conversationId: "home:long",
		});
		expect(call.abortSignal).toBeInstanceOf(AbortSignal);
	});

	it("returns null instead of throwing when the model call fails", async () => {
		resetMocks();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		mockKernelModel.mockReturnValue({
			model: FAKE_MODEL,
			pricingIdentity: null,
			attempts: [],
			forOperation() {
				return this;
			},
		});
		mockGenerateText.mockRejectedValue(
			new Error("provider response included private transcript", {
				cause: new TypeError("secret bearer token"),
			}),
		);

		const summarize = createKernelHistorySummarizer({}, GATEWAY);
		await expect(
			summarize?.({
				systemPrompt: "SYSTEM",
				transcript: "t",
				messages: [],
				maxChars: 1_200,
			}),
		).resolves.toBeNull();
		const diagnostic = warn.mock.calls[0]?.[0];
		expect(warn).toHaveBeenCalledTimes(1);
		expect(diagnostic).toEqual({
			component: "kernel.history_compaction",
			event: "model_summarizer_failed",
			exception: { type: "Error", cause: { type: "TypeError" } },
		});
		expect(JSON.stringify(diagnostic)).not.toMatch(
			/provider response|private transcript|secret bearer|org-summarize|home:long/,
		);
		warn.mockRestore();
	});

	it("returns null on blank model output", async () => {
		resetMocks();
		mockKernelModel.mockReturnValue({
			model: FAKE_MODEL,
			pricingIdentity: null,
			attempts: [],
			forOperation() {
				return this;
			},
		});
		mockGenerateText.mockResolvedValue({ text: "   " });

		const summarize = createKernelHistorySummarizer({}, GATEWAY);
		await expect(
			summarize?.({
				systemPrompt: "SYSTEM",
				transcript: "t",
				messages: [],
				maxChars: 1_200,
			}),
		).resolves.toBeNull();
	});
});

describe("compaction through the production summarizer", () => {
	it("produces a model checkpoint on the happy path", async () => {
		resetMocks();
		mockKernelModel.mockReturnValue({
			model: FAKE_MODEL,
			pricingIdentity: null,
			attempts: [],
			forOperation() {
				return this;
			},
		});
		mockGenerateText.mockResolvedValue({
			text: "## Goal\nreconcile the ledger",
		});

		const summarize = createKernelHistorySummarizer({}, GATEWAY);
		expect(summarize).toBeDefined();
		const result = await compactKernelHistory(transcript(10), {
			...BUDGET,
			...(summarize ? { summarize } : {}),
		});

		expect(result?.checkpoint.source).toBe("model");
		expect(result?.checkpoint.summary).toContain("reconcile the ledger");
		// The prompt the model saw is the fenced, untrusted transcript.
		const call = mockGenerateText.mock.calls[0]?.[0] as {
			messages: Array<{ content: string }>;
		};
		expect(call.messages[0]?.content).toContain(
			'<transcript untrusted="true">',
		);
	});

	it("falls back to the extractive digest when the model throws", async () => {
		resetMocks();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		mockKernelModel.mockReturnValue({
			model: FAKE_MODEL,
			pricingIdentity: null,
			attempts: [],
			forOperation() {
				return this;
			},
		});
		mockGenerateText.mockRejectedValue(new Error("gateway timeout"));

		const summarize = createKernelHistorySummarizer({}, GATEWAY);
		const result = await compactKernelHistory(transcript(10), {
			...BUDGET,
			...(summarize ? { summarize } : {}),
		});
		warn.mockRestore();

		expect(result).not.toBeNull();
		expect(result?.checkpoint.source).toBe("extractive");
		expect(result?.checkpoint.summary).toContain("## Goal");
		expect(result?.replay.length).toBeGreaterThan(1);
	});

	it("keeps the extractive digest when no model is configured", async () => {
		resetMocks();
		mockKernelModel.mockReturnValue(null);

		const summarize = createKernelHistorySummarizer({}, GATEWAY);
		const result = await compactKernelHistory(transcript(10), {
			...BUDGET,
			...(summarize ? { summarize } : {}),
		});

		expect(summarize).toBeUndefined();
		expect(mockGenerateText).not.toHaveBeenCalled();
		expect(result?.checkpoint.source).toBe("extractive");
		expect(result?.checkpoint.summary).toContain("no model summary this turn");
	});
});
