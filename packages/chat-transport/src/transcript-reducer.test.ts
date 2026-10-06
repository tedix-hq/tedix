import { describe, expect, it } from "vite-plus/test";
import {
	createTranscriptState,
	openTurnIdleMs,
	reduceTranscript,
	type TranscriptState,
} from "./transcript-reducer";

const chunk = (body: Record<string, unknown>, at: number) =>
	({
		type: "frame",
		event: { kind: "chunk", body: JSON.stringify(body) },
		at,
	}) as const;

function streamedTurn(): TranscriptState {
	let state = createTranscriptState("conv-1");
	state = reduceTranscript(state, { type: "user", text: "hi", at: 1 });
	state = reduceTranscript(state, { type: "assistant_start", id: "a1", at: 2 });
	state = reduceTranscript(state, {
		type: "frame",
		event: { kind: "phase", phase: "using_tool", detail: "search_orders" },
		at: 3,
	});
	state = reduceTranscript(
		state,
		chunk(
			{ type: "tool-input-start", toolCallId: "c1", toolName: "search_orders" },
			4,
		),
	);
	state = reduceTranscript(
		state,
		chunk(
			{
				type: "tool-input-available",
				toolCallId: "c1",
				toolName: "search_orders",
				input: { q: "x" },
			},
			5,
		),
	);
	state = reduceTranscript(
		state,
		chunk(
			{ type: "tool-input-start", toolCallId: "c2", toolName: "get_customer" },
			6,
		),
	);
	state = reduceTranscript(
		state,
		chunk(
			{ type: "tool-output-available", toolCallId: "c1", output: { rows: 2 } },
			7,
		),
	);
	state = reduceTranscript(state, {
		type: "frame",
		event: { kind: "delta", text: "Hel" },
		at: 8,
	});
	state = reduceTranscript(state, {
		type: "frame",
		event: { kind: "delta", text: "lo" },
		at: 9,
	});
	return state;
}

describe("reduceTranscript", () => {
	it("is pure and builds turns from user, phase, chunk, and delta frames", () => {
		const before = createTranscriptState("conv-1");
		const state = streamedTurn();
		expect(before.turns).toEqual([]);
		expect(state.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
		const turn = state.turns[1]!;
		expect(turn.text).toBe("Hello");
		expect(turn.phase).toBe("using_tool");
		expect(turn.phaseDetail).toBe("search_orders");
		expect(turn.finalized).toBe(false);
		expect(turn.activities.map((a) => [a.id, a.toolName, a.status])).toEqual([
			["c1", "search_orders", "completed"],
			["c2", "get_customer", "running"],
		]);
		expect(turn.activities[0]?.args).toEqual({ q: "x" });
		expect(turn.activities[0]?.result).toEqual({ rows: 2 });
		expect(turn.activities[0]?.startedAt).toBe(4);
		expect(turn.activities[0]?.finishedAt).toBe(7);
		expect(turn.lastFrameAt).toBe(9);
	});

	it("finalizes on done, keeps the longer streamed prefix, and settles running tools", () => {
		let state = streamedTurn();
		state = reduceTranscript(state, {
			type: "frame",
			event: { kind: "done", text: "Hel" },
			at: 10,
		});
		const turn = state.turns[1]!;
		expect(turn.finalized).toBe(true);
		expect(turn.finalizedBy).toBe("done");
		expect(turn.text).toBe("Hello");
		expect(turn.phase).toBeUndefined();
		expect(turn.activities[1]?.status).toBe("completed");
		// Frames after finalization are ignored.
		const after = reduceTranscript(state, {
			type: "frame",
			event: { kind: "delta", text: "!" },
		});
		expect(after).toBe(state);
	});

	it("prefers the terminal text when it is not a prefix extension", () => {
		let state = streamedTurn();
		state = reduceTranscript(state, {
			type: "frame",
			event: { kind: "done", text: "Hello world" },
		});
		expect(state.turns[1]?.text).toBe("Hello world");
	});

	it("records error frames, tool errors, and local finalization", () => {
		let state = streamedTurn();
		state = reduceTranscript(
			state,
			chunk(
				{ type: "tool-output-error", toolCallId: "c2", errorText: "boom" },
				10,
			),
		);
		expect(state.turns[1]?.activities[1]).toMatchObject({
			status: "error",
			error: "boom",
		});
		const failed = reduceTranscript(state, {
			type: "frame",
			event: { kind: "error", message: "nope" },
		});
		expect(failed.turns[1]).toMatchObject({
			finalized: true,
			finalizedBy: "error",
			error: "nope",
		});
		const local = reduceTranscript(state, {
			type: "fail",
			message: "Subscription ended before completion",
			at: 50,
		});
		expect(local.turns[1]).toMatchObject({
			finalized: true,
			finalizedBy: "error",
			text: "Hello",
		});
		expect(openTurnIdleMs(state, 30)).toBe(20);
		expect(openTurnIdleMs(local, 30)).toBeNull();
	});

	it("accumulates reasoning and ignores text-delta chunks", () => {
		let state = streamedTurn();
		state = reduceTranscript(
			state,
			chunk({ type: "reasoning-delta", delta: "thinking " }, 10),
		);
		state = reduceTranscript(
			state,
			chunk({ type: "reasoning-delta", delta: "more" }, 11),
		);
		state = reduceTranscript(
			state,
			chunk({ type: "text-delta", delta: "DUP" }, 12),
		);
		expect(state.turns[1]?.reasoning).toBe("thinking more");
		expect(state.turns[1]?.text).toBe("Hello");
	});

	it("matches a completion to a running tool by name when the id is missing", () => {
		let state = createTranscriptState();
		state = reduceTranscript(state, { type: "assistant_start" });
		state = reduceTranscript(
			state,
			chunk({ type: "tool-input-start", toolName: "list_skills" }, 1),
		);
		state = reduceTranscript(
			state,
			chunk(
				{ type: "tool-output-available", toolName: "list_skills", output: 1 },
				2,
			),
		);
		expect(state.turns[0]?.activities).toHaveLength(1);
		expect(state.turns[0]?.activities[0]).toMatchObject({
			status: "completed",
			result: 1,
		});
	});

	it("appends history turns as finalized", () => {
		const state = reduceTranscript(createTranscriptState(), {
			type: "history",
			turns: [
				{ role: "user", text: "q" },
				{ role: "assistant", text: "a" },
			],
		});
		expect(state.turns.every((turn) => turn.finalized)).toBe(true);
	});
});

describe("structured tool failure outcomes", () => {
	it.each([
		{
			ok: false,
			error: "BAD_REQUEST",
			completionEvidence: { status: "failed" },
		},
		{ isError: true, content: [{ type: "text", text: "Unavailable" }] },
		{ completionEvidence: { status: "failed" } },
	])("keeps a failed result failed after the turn finishes: %j", (output) => {
		let state = streamedTurn();
		state = reduceTranscript(
			state,
			chunk({ type: "tool-output-available", toolCallId: "c1", output }, 20),
		);
		state = reduceTranscript(state, {
			type: "frame",
			event: { kind: "done" },
			at: 21,
		});
		expect(state.turns[1]?.activities[0]).toMatchObject({
			status: "error",
			result: output,
		});
	});
	it("does not interpret a nested business record as a tool failure", () => {
		const output = { ok: true, data: { ok: false, status: "failed" } };
		const state = reduceTranscript(
			streamedTurn(),
			chunk({ type: "tool-output-available", toolCallId: "c1", output }, 20),
		);
		expect(state.turns[1]?.activities[0]).toMatchObject({
			status: "completed",
			result: output,
		});
	});
});

it("fails an unfinished tool on watchdog failure without inventing a completed result", () => {
	const state = reduceTranscript(streamedTurn(), {
		type: "fail",
		message: "Subscription ended before completion",
		at: 30,
	});
	expect(state.turns[1]).toMatchObject({
		finalized: true,
		finalizedBy: "error",
	});
	expect(state.turns[1]?.activities[0]?.status).toBe("completed");
	expect(state.turns[1]?.activities[1]).toMatchObject({
		status: "error",
		error: "Subscription ended before completion",
	});
});
