import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLaneTranscript } from "./lane-telemetry";
import { LaneTelemetryInputSchema } from "@tedix/api-contract/schemas/work-agent-sessions";

async function transcript(
	rows: unknown[],
	executor: "codex" | "claude-code" = "codex",
) {
	const dir = mkdtempSync(join(tmpdir(), "lane-test-")),
		path = join(dir, "session.jsonl");
	writeFileSync(
		path,
		rows
			.map((row) =>
				JSON.stringify({
					timestamp: "2026-10-17T10:00:00Z",
					...(row as object),
				}),
			)
			.join("\n") + "\n{partial",
	);
	try {
		return await parseLaneTranscript(path, executor);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
const meta = {
	type: "session_meta",
	payload: {
		id: "example-session",
		cwd: "/fictional/repo",
		originator: "codex_exec",
	},
};
const tokens = (input: number) => ({
	type: "event_msg",
	payload: {
		type: "token_count",
		info: {
			total_token_usage: {
				input_tokens: input,
				cached_input_tokens: 20,
				output_tokens: 30,
				reasoning_output_tokens: 10,
				total_tokens: input + 30,
			},
		},
	},
});
describe("lane transcript observations", () => {
	it("uses the last cumulative usage, deduplicates calls and preserves unknown completion", async () => {
		const call = {
			type: "response_item",
			payload: {
				type: "function_call",
				name: "exec_command",
				call_id: "call-one",
			},
		};
		const parsed = await transcript([
			meta,
			{
				type: "turn_context",
				payload: { model: "example-model", effort: "medium" },
			},
			tokens(100),
			call,
			call,
			tokens(150),
		]);
		expect(parsed.telemetry.usage).toEqual({
			input: 150,
			cached: 20,
			output: 30,
			reasoning: 10,
		});
		expect(parsed.telemetry.tools).toEqual({ exec_command: 1 });
		expect(parsed.telemetry.finishedAt).toBeNull();
		expect(parsed.telemetry.outcome).toBeNull();
		expect(LaneTelemetryInputSchema.safeParse(parsed.telemetry).success).toBe(
			true,
		);
	});
	it("keeps a stopped turn stopped, and resets outcome when another turn starts", async () => {
		const stopped = { type: "event_msg", payload: { type: "turn_aborted" } };
		expect((await transcript([meta, stopped])).telemetry.outcome).toBe(
			"stopped",
		);
		expect(
			(
				await transcript([
					meta,
					stopped,
					{ type: "event_msg", payload: { type: "task_started" } },
				])
			).telemetry.outcome,
		).toBeNull();
	});
	it("does not count duplicated user envelopes as corrections", async () => {
		const parsed = await transcript([
			meta,
			{
				type: "response_item",
				payload: {
					type: "message",
					role: "user",
					content: [{ text: "Fix the fictional test" }],
				},
			},
			{
				type: "event_msg",
				payload: { type: "user_message", message: "Fix the fictional test" },
			},
			{
				type: "event_msg",
				payload: { type: "user_message", message: "Use the existing query" },
			},
			{
				type: "event_msg",
				payload: { type: "task_complete", last_agent_message: "Fixed" },
			},
		]);
		expect(parsed.telemetry.corrections).toEqual(["Use the existing query"]);
		expect(parsed.telemetry.finalMessage).toBe("Fixed");
	});
	it("combines Claude message fragments once and counts each tool id once", async () => {
		const msg = {
			id: "m1",
			model: "fictional-model",
			content: [{ type: "tool_use", id: "t1", name: "Read" }],
			usage: { input_tokens: 5, cache_read_input_tokens: 10, output_tokens: 2 },
		};
		const parsed = await transcript(
			[
				{ type: "assistant", sessionId: "claude-example", message: msg },
				{
					type: "assistant",
					sessionId: "claude-example",
					message: {
						...msg,
						content: [
							...msg.content,
							{ type: "tool_use", id: "t2", name: "Bash" },
						],
						usage: { ...msg.usage, output_tokens: 7 },
					},
				},
			],
			"claude-code",
		);
		expect(parsed.telemetry.usage).toEqual({
			input: 15,
			cached: 10,
			output: 7,
			reasoning: 0,
		});
		expect(parsed.telemetry.tools).toEqual({ Read: 1, Bash: 1 });
	});
	it("rejects token partitions that would double-count or under-price usage", async () => {
		const { telemetry } = await transcript([meta, tokens(100)]);
		expect(
			LaneTelemetryInputSchema.safeParse({
				...telemetry,
				usage: { input: 1, cached: 2, output: 1, reasoning: 0 },
			}).success,
		).toBe(false);
	});
});

it("deduplicates cumulative events while retaining every request for context-tier pricing", async () => {
	const usage = {
		input_tokens: 100,
		cached_input_tokens: 80,
		output_tokens: 10,
		reasoning_output_tokens: 5,
	};
	const event = (times: number) => ({
		type: "event_msg",
		payload: {
			type: "token_count",
			info: {
				last_token_usage: usage,
				total_token_usage: Object.fromEntries(
					Object.entries(usage).map(([k, v]) => [k, v * times]),
				),
			},
		},
	});
	const parsed = await transcript([
		meta,
		{ type: "turn_context", payload: { model: "fictional-model" } },
		event(1),
		event(1),
		event(2),
	]);
	expect(parsed.telemetry.usageSamples).toEqual(
		Array(2).fill({
			model: "fictional-model",
			input: 100,
			cached: 80,
			output: 10,
			reasoning: 5,
			cacheWrite: 0,
		}),
	);
});
