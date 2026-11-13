import { describe, expect, test } from "bun:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
	AssistantMessageEventStream,
	type AssistantMessage,
} from "@earendil-works/pi-ai";
import type { Context, Usage } from "@earendil-works/pi-ai";
import type { ModelPort } from "./model";
import { RUN_CODE_TOOL } from "./prompt";
import type { SandboxRunResult } from "./runtime";
import { closeOpenToolCalls, runTurn, type TurnProgress } from "./turn-loop";

function tokenUsage(
	input: number,
	output: number,
	cacheRead = 0,
	cacheWrite = 0,
): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

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
				summarize: async () => ({ summary: "n/a", usage: tokenUsage(0, 0) }),
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
		const calls = result.appended.filter(
			(message) => message.role === "assistant",
		);
		expect(calls).toHaveLength(2);
		expect(result.usage?.input).toBe(
			calls[0]!.usage.input + calls[1]!.usage.input,
		);
		expect(result.usage?.output).toBe(
			calls[0]!.usage.output + calls[1]!.usage.output,
		);
		expect(ran).toHaveLength(1);
		expect(result.appended.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
		expect(events.slice(0, 5)).toEqual([
			"model_started",
			"step_started",
			"tool_call_started",
			"usage_updated",
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
				summarize: async () => ({ summary: "n/a", usage: tokenUsage(0, 0) }),
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
					return { summary: "summary", usage: tokenUsage(17, 3, 4, 1) };
				},
			},
			{ turnId: "t3", systemPrompt: "sys", history, userText: "hi" },
		);
		expect(summarized).toBe(1);
		expect(result.compaction?.summary).toBe("summary");
		const answer = result.appended.find(
			(message) => message.role === "assistant",
		);
		expect(result.usage).toEqual({
			input: 17 + answer!.usage.input,
			output: 3 + answer!.usage.output,
			cacheRead: 4 + answer!.usage.cacheRead,
			cacheWrite: 1 + answer!.usage.cacheWrite,
			partial: false,
		});
		expect(result.compaction?.droppedMessages).toBe(42);
	});
});

function measuredModel(messages: AssistantMessage[]): ModelPort {
	return {
		id: "faux",
		contextWindow: 128_000,
		maxOutputTokens: 4000,
		stream() {
			const message = messages.shift();
			if (!message) throw new Error("No scripted response remains");
			const stream = new AssistantMessageEventStream();
			stream.end(message);
			return stream;
		},
	};
}

function measuredMessage(
	content: Parameters<typeof fauxAssistantMessage>[0],
	input: number,
	output: number,
	cached: number,
) {
	return {
		...fauxAssistantMessage(content),
		usage: {
			input,
			output,
			cacheRead: cached,
			cacheWrite: 0,
			totalTokens: input + output + cached,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

test("turn totals include every model step and compaction without double-counting cache", async () => {
	const model = measuredModel([
		{
			...measuredMessage(
				fauxToolCall(RUN_CODE_TOOL, { code: "export default () => 1" }),
				100,
				10,
				40,
			),
			stopReason: "toolUse",
		},
		measuredMessage(fauxText("Done"), 200, 20, 60),
	]);
	const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
	const result = await runTurn(
		{
			model: { ...model, contextWindow: 1000 },
			runCode: async () => ({ ok: true, logs: [], result: 1, durationMs: 0 }),
			emit: (event) => events.push(event),
			summarize: async () => ({
				text: "Earlier context",
				usage: measuredMessage("summary", 50, 5, 10).usage,
			}),
		},
		{
			turnId: "totals",
			systemPrompt: "sys",
			history: Array.from({ length: 4 }, (_, i) => ({
				role: "user",
				content: "x".repeat(2000),
				timestamp: i,
			})),
			userText: "Go",
		},
	);
	expect(result.usage).toEqual({
		input: 350,
		output: 35,
		cacheRead: 110,
		cacheWrite: 0,
		partial: false,
	});
	expect(result.model).toBe("faux");
	expect(events.filter((event) => event.type === "usage_updated")).toHaveLength(
		3,
	);
});

test.each([true, false])(
	"SDK default zeroes are unknown; provider-reported zeroes are real (receipt=%s)",
	async (usageReported) => {
		const model = measuredModel([measuredMessage("Done", 0, 0, 0)]);
		const result = await runTurn(
			{
				model: {
					...model,
					responseMetadata: () => ({
						model: "provider-snapshot",
						usageReported,
					}),
				},
				runCode: async () => ({ ok: true, logs: [], durationMs: 0 }),
				emit: () => {},
				summarize: async () => ({ summary: "", usage: null }),
			},
			{ turnId: "zero", systemPrompt: "sys", history: [], userText: "Hi" },
		);
		expect(result.model).toBe("provider-snapshot");
		expect(result.usage).toEqual(
			usageReported
				? {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						partial: false,
					}
				: null,
		);
	},
);

test("a failed later request retains available usage as partial", async () => {
	const model = measuredModel([
		{
			...measuredMessage(
				fauxToolCall(RUN_CODE_TOOL, { code: "export default () => 1" }),
				100,
				10,
				40,
			),
			stopReason: "toolUse",
		},
		fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "Provider failed",
		}),
	]);
	const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
	await expect(
		runTurn(
			{
				model,
				runCode: async () => ({ ok: true, logs: [], durationMs: 0 }),
				emit: (event) => events.push(structuredClone(event)),
				summarize: async () => ({ summary: "", usage: null }),
			},
			{ turnId: "failed", systemPrompt: "sys", history: [], userText: "Hi" },
		),
	).rejects.toThrow("Provider failed");
	expect(
		events.filter((event) => event.type === "usage_updated").at(-1)?.data
			?.usage,
	).toEqual({
		inputTokens: 140,
		outputTokens: 10,
		cachedInputTokens: 40,
		partial: true,
	});
});

test("model transparency preserves the tool-step and output-token limits", async () => {
	const model = measuredModel(
		Array.from({ length: 24 }, () => ({
			...measuredMessage(
				fauxToolCall(RUN_CODE_TOOL, { code: "export default () => 1" }),
				10,
				2,
				0,
			),
			stopReason: "toolUse",
		})),
	);
	let calls = 0;
	let runs = 0;
	const result = await runTurn(
		{
			model: {
				...model,
				stream(context, options) {
					calls += 1;
					expect(options?.maxTokens).toBe(4000);
					return model.stream(context, options);
				},
			},
			runCode: async () => {
				runs += 1;
				return { ok: true, logs: [], durationMs: 0 };
			},
			emit: () => {},
			summarize: async () => ({ summary: "", usage: null }),
		},
		{ turnId: "limits", systemPrompt: "sys", history: [], userText: "Go" },
	);
	expect(calls).toBe(24);
	expect(runs).toBe(24);
	expect(result.stopReason).toBe("step_ceiling");
	expect(result.usage?.input).toBe(240);
});

describe("turn progress", () => {
	test("saves the user message and each finished step before a later failure", async () => {
		const core = createFauxCore({ tokensPerSecond: 0 });
		core.setResponses([
			fauxAssistantMessage(fauxToolCall(RUN_CODE_TOOL, { code: "write" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([], {
				stopReason: "error",
				errorMessage: "provider down",
			}),
		]);
		const saved: TurnProgress[] = [];
		await expect(
			runTurn(
				{
					model: fauxModel(core),
					runCode: async () => ({
						ok: true,
						result: 1,
						logs: [],
						durationMs: 0,
					}),
					emit: () => {},
					save: (progress) => {
						saved.push(progress);
					},
					summarize: async () => ({ summary: "", usage: null }),
				},
				{ turnId: "t", systemPrompt: "sys", history: [], userText: "Write it" },
			),
		).rejects.toThrow("provider down");
		expect(
			saved.flatMap((progress) => progress.messages.map((m) => m.role)),
		).toEqual(["user", "assistant", "toolResult"]);
	});

	test("a stop during a tool call keeps its result and runs no further calls", async () => {
		const core = createFauxCore({ tokensPerSecond: 0 });
		core.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(RUN_CODE_TOOL, { code: "first" }),
					fauxToolCall(RUN_CODE_TOOL, { code: "second" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxText("should not be reached")),
		]);
		const controller = new AbortController();
		const ran: string[] = [];
		const saved: TurnProgress[] = [];
		const result = await runTurn(
			{
				model: fauxModel(core),
				runCode: async (code) => {
					ran.push(code);
					controller.abort();
					return { ok: true, result: "written", logs: [], durationMs: 0 };
				},
				emit: () => {},
				save: (progress) => {
					saved.push(progress);
				},
				signal: controller.signal,
				summarize: async () => ({ summary: "", usage: null }),
			},
			{ turnId: "t", systemPrompt: "sys", history: [], userText: "Do both" },
		);
		expect(ran).toEqual(["first"]);
		expect(result.stopReason).toBe("aborted");
		const messages = saved.flatMap((progress) => progress.messages);
		expect(messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"toolResult",
		]);
		expect(JSON.stringify(messages[2])).toContain("written");
		expect(JSON.stringify(messages[3])).toContain(
			"Not run: the turn was stopped.",
		);
	});

	test("closes tool calls an interrupted turn left without a result", () => {
		const history = closeOpenToolCalls([
			{ role: "user", content: "Write it", timestamp: 1 },
			fauxAssistantMessage(
				[
					fauxToolCall(RUN_CODE_TOOL, { code: "a" }, { id: "call-a" }),
					fauxToolCall(RUN_CODE_TOOL, { code: "b" }, { id: "call-b" }),
				],
				{ stopReason: "toolUse" },
			),
			{
				role: "toolResult",
				toolCallId: "call-a",
				toolName: RUN_CODE_TOOL,
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: 2,
			},
			{ role: "user", content: "Continue", timestamp: 3 },
		]);
		expect(history.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"toolResult",
			"user",
		]);
		expect(history[3]).toMatchObject({
			role: "toolResult",
			toolCallId: "call-b",
			isError: true,
		});
	});
});
