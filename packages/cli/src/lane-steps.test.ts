import { describe, expect, it } from "bun:test";
import { runStepToolMissing } from "./lane-heartbeat";
import {
	createRunStepLog,
	laneAgentSteps,
	RunStepsUnavailableError,
	type RunMessage,
} from "./lane-steps";

describe("run step summaries", () => {
	it("summarises Codex items without their output", () => {
		const completed = (item: Record<string, unknown>) =>
			laneAgentSteps("codex", { type: "item.completed", item });
		expect(
			completed({ type: "agent_message", text: "x".repeat(900) })[0],
		).toEqual({ kind: "message", text: "x".repeat(500) });
		expect(
			completed({
				type: "command_execution",
				command: `bun test ${"a".repeat(400)}`,
				aggregated_output: "private file contents",
				exit_code: 1,
			}),
		).toEqual([
			{
				kind: "command",
				text: `${`bun test ${"a".repeat(400)}`.slice(0, 300)} (exit 1)`,
			},
		]);
		expect(
			completed({
				type: "file_change",
				changes: [
					{ path: "src/a.ts", kind: "update", diff: "private" },
					{ path: "src/b.ts", kind: "add" },
				],
			}),
		).toEqual([{ kind: "file_change", text: "src/a.ts, src/b.ts" }]);
		expect(
			completed({
				type: "mcp_tool_call",
				server: "tedix",
				tool: "list_work_items",
				arguments: { secret: "private" },
				result: { rows: ["private"] },
			}),
		).toEqual([{ kind: "tool", text: "tedix.list_work_items" }]);
		expect(completed({ type: "error", message: "Model overloaded" })).toEqual([
			{ kind: "error", text: "Model overloaded" },
		]);
		expect(laneAgentSteps("codex", { type: "error", message: "Lost" })).toEqual(
			[{ kind: "error", text: "Lost" }],
		);
		// Shapes this runner does not know produce nothing.
		expect(completed({ type: "hologram", text: "new" })).toEqual([]);
		expect(laneAgentSteps("codex", { type: "item.started", item: {} })).toEqual(
			[],
		);
		expect(laneAgentSteps("codex", "noise")).toEqual([]);
	});

	it("summarises Claude messages and tool calls without tool results", () => {
		expect(
			laneAgentSteps("claude-code", {
				type: "assistant",
				message: {
					content: [
						{ type: "thinking", thinking: "private reasoning" },
						{ type: "text", text: "Reading the guide." },
						{
							type: "tool_use",
							name: "Bash",
							input: { command: "git status" },
						},
						{
							type: "tool_use",
							name: "Write",
							input: { file_path: "a.ts", content: "private file contents" },
						},
					],
				},
			}),
		).toEqual([
			{ kind: "message", text: "Reading the guide." },
			{ kind: "tool", text: "Bash: git status" },
			{ kind: "tool", text: "Write" },
		]);
		expect(
			laneAgentSteps("claude-code", {
				type: "user",
				message: {
					content: [{ type: "tool_result", content: "private output" }],
				},
			}),
		).toEqual([]);
		expect(
			laneAgentSteps("claude-code", {
				type: "result",
				is_error: true,
				result: "Credit balance is too low",
			}),
		).toEqual([{ kind: "error", text: "Credit balance is too low" }]);
		expect(
			laneAgentSteps("claude-code", { type: "result", is_error: false }),
		).toEqual([]);
	});

	it("masks secret shapes in step text", () => {
		const secret = `ghp_${"A1b2".repeat(9)}`;
		const [step] = laneAgentSteps("codex", {
			type: "item.completed",
			item: {
				type: "command_execution",
				command: `curl -H "Authorization: Bearer ${secret}" https://example.test`,
				exit_code: 0,
			},
		});
		expect(step!.kind).toBe("command");
		expect(step!.text).not.toContain(secret);
	});
});

describe("run step log", () => {
	const message = (id: string, kind: RunMessage["kind"] = "follow_up") => ({
		id,
		kind,
		body: "Also cover pricing.",
		senderType: "user",
		senderId: "fictional-owner",
		createdAt: "2026-11-19T10:00:00.000Z",
	});

	it("keeps unsent steps after a failed send and delivers each message once", async () => {
		const calls: Array<{ seqs: number[]; applied: string[] }> = [];
		const replies: unknown[] = [
			new Error("Gateway unavailable"),
			{ accepted: 2, pending: [message("m1"), { id: 7 }, { kind: "other" }] },
			{ accepted: 1, pending: [message("m1")] },
		];
		const received: RunMessage[] = [];
		const logged: string[] = [];
		const log = createRunStepLog({
			send: async (steps, applied) => {
				calls.push({ seqs: steps.map((step) => step.seq), applied });
				const reply = replies.shift();
				if (reply instanceof Error) throw reply;
				return reply;
			},
			onMessage: (received_) => received.push(received_),
			log: (event) => logged.push(event),
		});
		log.add("started", "Started codex with model test-model");
		log.add("message", "Reading the guide.");
		log.add("message", "   ");
		await log.flush();
		await log.flush();
		log.applied(["m1"]);
		log.add("finished", "Agent run ended: succeeded");
		await log.flush();
		expect(calls).toEqual([
			{ seqs: [0, 1], applied: [] },
			{ seqs: [0, 1], applied: [] },
			{ seqs: [2], applied: ["m1"] },
		]);
		expect(received.map((row) => row.id)).toEqual(["m1"]);
		expect(logged).toEqual(["run-steps-failed"]);
	});

	it("drops the oldest steps past 500 and sends at most 50 at a time", async () => {
		const sizes: number[] = [];
		let first: number | undefined;
		const log = createRunStepLog({
			send: async (steps) => {
				first ??= steps[0]?.seq;
				sizes.push(steps.length);
				return { accepted: steps.length, pending: [] };
			},
			onMessage: () => {},
			log: () => {},
		});
		for (let n = 0; n < 520; n++) log.add("message", `Step ${n}`);
		await log.flush();
		expect(first).toBe(20);
		expect(sizes).toEqual(Array(10).fill(50));
	});

	it("sends new steps every 5 seconds and asks for messages every 15 when idle", async () => {
		let at = 0;
		const sentAt: number[] = [];
		const log = createRunStepLog({
			send: async (steps) => {
				sentAt.push(at);
				return { accepted: steps.length, pending: [] };
			},
			onMessage: () => {},
			log: () => {},
			now: () => at,
		});
		log.add("started", "Started");
		for (; at <= 60_000; at += 5_000) {
			if (at === 20_000 || at === 25_000) log.add("message", "Working");
			await log.tick();
		}
		expect(sentAt).toEqual([0, 15_000, 20_000, 25_000, 40_000, 55_000]);
	});

	it("spreads sends so several runs stay under the shared call budget", async () => {
		let at = 0;
		let sends = 0;
		const logs = Array.from({ length: 5 }, () =>
			createRunStepLog({
				send: async (steps) => {
					sends++;
					return { accepted: steps.length, pending: [] };
				},
				onMessage: () => {},
				log: () => {},
				runs: () => 5,
				now: () => at,
			}),
		);
		for (; at < 60_000; at += 5_000)
			for (const log of logs) {
				log.add("message", "Working");
				await log.tick();
			}
		expect(sends).toBe(20);
	});

	it("backs off when rate limited, logs once per wait and resets on success", async () => {
		let at = 0;
		let limited = true;
		const sentAt: number[] = [];
		const logged: Array<{ at: number; event: string }> = [];
		const log = createRunStepLog({
			send: async (steps) => {
				sentAt.push(at);
				if (limited)
					throw new Error(
						"MCP tool error: Tool rate limit exceeded for bounded_write",
					);
				return { accepted: steps.length, pending: [] };
			},
			onMessage: () => {},
			log: (event) => logged.push({ at, event }),
			now: () => at,
		});
		log.add("started", "Started");
		for (; at < 240_000; at += 5_000) {
			// A turn-end send inside a wait is tried but not logged again.
			if (at === 15_000) await log.flush(true);
			if (at === 230_000) limited = false;
			await log.tick();
		}
		expect(sentAt).toEqual([
			0, 10_000, 15_000, 55_000, 115_000, 175_000, 235_000,
		]);
		expect(logged).toEqual(
			[0, 10_000, 55_000, 115_000, 175_000].map((at) => ({
				at,
				event: "run-steps-failed",
			})),
		);
		// After the success the run is back to one send every 5 seconds.
		log.add("message", "Working");
		at = 240_000;
		await log.tick();
		expect(sentAt.at(-1)).toBe(240_000);
	});

	it("stops sending for the run once the server has no step tool", async () => {
		let calls = 0;
		const logged: string[] = [];
		const log = createRunStepLog({
			send: async () => {
				calls++;
				throw new RunStepsUnavailableError("absent or ambiguous");
			},
			onMessage: () => {},
			log: (event) => logged.push(event),
		});
		log.add("started", "Started");
		await log.flush();
		log.add("message", "More");
		await log.flush(true);
		expect(calls).toBe(1);
		expect(logged).toEqual(["run-steps-unavailable"]);
	});

	it("stops sending once the Attempt is stale", async () => {
		let calls = 0;
		const logged: string[] = [];
		const log = createRunStepLog({
			send: async () => {
				calls++;
				throw new Error("CONFLICT: STALE_ATTEMPT");
			},
			onMessage: () => {},
			log: (event) => logged.push(event),
		});
		log.add("started", "Started");
		await log.flush();
		log.add("message", "More");
		await log.flush(true);
		expect(calls).toBe(1);
		expect(logged).toEqual(["run-steps-stopped"]);
	});

	it("tells a missing step tool from a failure worth retrying", () => {
		for (const text of [
			"Unknown typed Work endpoint",
			"Native Work callable work.append_work_attempt_steps is absent or ambiguous",
			"Work native descriptor is denied, ineligible or has no current schema provenance",
			"Native Work endpoint mismatch",
		])
			expect(runStepToolMissing(text)).toBe(true);
		for (const text of [
			"Work native command deadline exceeded",
			"fetch failed",
			"CONFLICT: STALE_ATTEMPT",
		])
			expect(runStepToolMissing(text)).toBe(false);
	});
});
