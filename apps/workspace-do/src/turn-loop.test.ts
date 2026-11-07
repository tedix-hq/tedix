import { describe, expect, test } from "bun:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { Context } from "@earendil-works/pi-ai";
import type { ModelPort } from "./model";
import { RUN_CODE_TOOL } from "./prompt";
import type { SandboxRunResult } from "./runtime";
import { runTurn } from "./turn-loop";

function fauxModel(core: ReturnType<typeof createFauxCore>): ModelPort {
	const model = core.getModel();
	return {
		id: "faux",
		contextWindow: 128_000,
		maxOutputTokens: 4_000,
		stream: (context: Context, options) =>
			core.streamSimple(
				model,
				// normalizeContext is what the real port does; faux accepts the same shape.
				{
					messages: [
						{
							role: "system",
							content: context.systemPrompt ?? "",
							toolsAdded: context.tools,
							timestamp: 0,
						},
						...context.messages,
					],
				} as never,
				{ signal: options?.signal },
			),
	};
}

describe("runTurn", () => {
	test("runs code, feeds the result back, answers; events are ordered", async () => {
		const core = createFauxCore({ tokensPerSecond: 0 });
		core.setResponses([
			fauxAssistantMessage(
				fauxToolCall(RUN_CODE_TOOL, {
					code: "export default async (env) => (await env.work.listOpen()).length",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxText("There are 3 open Work items.")),
		]);
		const ran: string[] = [];
		const events: string[] = [];
		const result = await runTurn(
			{
				model: fauxModel(core),
				runCode: async (code): Promise<SandboxRunResult> => {
					ran.push(code);
					return { ok: true, result: 3, logs: [], durationMs: 2 };
				},
				emit: (event) => events.push(event.type),
				summarize: async () => "n/a",
			},
			{
				turnId: "t1",
				systemPrompt: "sys",
				history: [],
				userText: "How many open items?",
			},
		);
		expect(result.text).toBe("There are 3 open Work items.");
		expect(result.stopReason).toBe("answered");
		expect(result.steps).toBe(2);
		expect(ran).toHaveLength(1);
		expect(result.appended.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
		expect(events.slice(0, 3)).toEqual([
			"step_started",
			"tool_call_started",
			"step_finished",
		]);
		expect(events).toContain("code_started");
		expect(events).toContain("code_finished");
		expect(events).toContain("text_delta");
	});

	test("an approval refusal ends the turn with approval_required", async () => {
		const core = createFauxCore({ tokensPerSecond: 0 });
		core.setResponses([
			fauxAssistantMessage(
				fauxToolCall(RUN_CODE_TOOL, {
					code: "export default async (env) => env.outputs.create({})",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxText("should not be reached")),
		]);
		const events: string[] = [];
		const result = await runTurn(
			{
				model: fauxModel(core),
				runCode: async () => ({
					ok: false,
					logs: [],
					error: "Approval required: approval_pending",
					durationMs: 1,
				}),
				emit: (event) => events.push(event.type),
				summarize: async () => "n/a",
			},
			{
				turnId: "t2",
				systemPrompt: "sys",
				history: [],
				userText: "Create a doc",
			},
		);
		expect(result.stopReason).toBe("approval_required");
		expect(events).toContain("approval_required");
		expect(core.getPendingResponseCount()).toBe(1);
	});

	test("compacts long history once and reports the summary", async () => {
		const core = createFauxCore({ tokensPerSecond: 0 });
		core.setResponses([fauxAssistantMessage(fauxText("ok"))]);
		const history = Array.from({ length: 60 }, (_, i) =>
			i % 2
				? fauxAssistantMessage(fauxText("x".repeat(9_000)))
				: { role: "user" as const, content: "x".repeat(9_000), timestamp: i },
		);
		let summarized = 0;
		const result = await runTurn(
			{
				model: {
					...fauxModel(core),
					contextWindow: 120_000,
					maxOutputTokens: 4_000,
				},
				runCode: async () => ({ ok: true, logs: [], durationMs: 0 }),
				emit: () => {},
				summarize: async () => {
					summarized += 1;
					return "summary";
				},
			},
			{ turnId: "t3", systemPrompt: "sys", history, userText: "hi" },
		);
		expect(summarized).toBe(1);
		expect(result.compaction?.summary).toBe("summary");
		expect(result.compaction?.droppedMessages).toBe(42);
	});
});
