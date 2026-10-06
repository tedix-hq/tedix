/**
 * A streamed turn MUST terminate with `done` once the model turn succeeded.
 *
 * Without a `done` frame the embedded widget receives every delta but never
 * finalizes the turn. If `streamChatTurn` awaits the session-ledger
 * `appendTurn` between the last delta and the `done` emit, a slow or throwing
 * append replaces `done` with `{kind:"error"}` even though the answer is
 * already on the wire.
 *
 * Part A (behavioral): the finalization sequence, run against the real
 *   `ChatStreamHub`, with an `appendTurn` that throws — the primary sink still
 *   receives `done` carrying the full text and never an `error` frame, and the
 *   run is closed so a late resume replays the tail.
 * Part B: the same guarantees through the DO's real `streamChatTurn` pump —
 *   a failing assistant append or post-done effect never turns `done` into
 *   `error`, and the pump stays alive until the ledger mirror is enqueued.
 */
import assert from "node:assert/strict";
import { deriveIdempotencyKey } from "@tedix/tedi-session/session-repo";
import { chatTurnProbe } from "../test/tedi-do";
import { ChatStreamHub, type FrameSink } from "./chat-stream-hub";
import { finalizeSuccessfulChatStream } from "./chat-stream-finalization";
import type { SseFrame } from "./sse-resume";

const RUN = "tedi-7:chat:req-99";

function recordingSink(): FrameSink & {
	frames: () => SseFrame[];
	closed: boolean;
} {
	const chunks: string[] = [];
	const sink = {
		closed: false,
		write(c: string) {
			chunks.push(c);
		},
		close() {
			sink.closed = true;
		},
		frames() {
			return chunks
				.map((c) => c.match(/data: (.*)\n\n$/)?.[1] ?? "")
				.filter((s) => s.length > 0)
				.map((j) => JSON.parse(j) as SseFrame);
		},
	};
	return sink;
}

/** Mirrors the post-turn tail of `streamChatTurn` exactly (see Part B). */
async function finalizeTurn(
	hub: ChatStreamHub,
	appendTurn: () => Promise<void>,
	text: string,
): Promise<{ finalized: boolean; errorFrame: boolean }> {
	let finalized = false;
	try {
		hub.emit(RUN, { kind: "phase", phase: "finalizing" });
		await finalizeSuccessfulChatStream({
			hub,
			runId: RUN,
			text,
			sessionKey: "s",
			ts: 1,
			appendTurn,
		});
		finalized = true;
		return { finalized, errorFrame: false };
	} catch (err) {
		if (finalized) return { finalized, errorFrame: false };
		hub.emit(RUN, {
			kind: "error",
			message: err instanceof Error ? err.message : String(err),
		});
		hub.closeRun(RUN);
		return { finalized, errorFrame: true };
	}
}

// ── Part A1: a throwing appendTurn still yields `done` with the full text ──
{
	const hub = new ChatStreamHub();
	const primary = recordingSink();
	hub.openRun(RUN, primary);
	hub.emit(RUN, { kind: "delta", text: "Hola " });
	hub.emit(RUN, { kind: "delta", text: "mundo" });
	const logged: unknown[][] = [];
	const originalError = console.error;
	console.error = (...values: unknown[]) => {
		logged.push(values);
	};
	const outcome = await (async () => {
		try {
			return await finalizeTurn(
				hub,
				async () => {
					throw new Error("private-transcript-detail", {
						cause: new TypeError("private-session-detail"),
					});
				},
				"Hola mundo",
			);
		} finally {
			console.error = originalError;
		}
	})();
	assert.equal(outcome.finalized, true);
	assert.equal(outcome.errorFrame, false);
	const kinds = primary.frames().map((f) => f.kind);
	assert.deepEqual(kinds, ["delta", "delta", "phase", "done"]);
	const done = primary.frames().at(-1) as { kind: string; text?: string };
	assert.equal(done.text, "Hola mundo", "done must carry the final text");
	assert.equal(primary.closed, true, "closeRun must close the primary sink");
	assert.deepEqual(logged, [
		[
			{
				event: "chat_stream.append_turn_failed",
				exception: { type: "Error", cause: { type: "TypeError" } },
			},
		],
	]);
	assert(!JSON.stringify(logged).includes("private-"));
}

// ── Part A2: a slow appendTurn cannot precede the deltas or drop `done` ──
{
	const hub = new ChatStreamHub();
	const primary = recordingSink();
	hub.openRun(RUN, primary);
	hub.emit(RUN, { kind: "delta", text: "x" });
	await finalizeTurn(
		hub,
		() => new Promise((resolve) => setTimeout(resolve, 20)),
		"x",
	);
	assert.deepEqual(
		primary.frames().map((f) => f.kind),
		["delta", "phase", "done"],
	);
}

// ── Part A3: a client that dropped before `done` still gets it on resume ──
{
	const hub = new ChatStreamHub();
	hub.openRun(RUN, recordingSink());
	hub.emit(RUN, { kind: "delta", text: "a" }); // seq 0
	await finalizeTurn(
		hub,
		async () => {
			throw new Error("append failed");
		},
		"a",
	);
	const late = recordingSink();
	const res = hub.attach(RUN, late, { runId: RUN, seq: 0 });
	assert.equal(res.outcome, "replayed-terminated");
	assert.deepEqual(
		late.frames().map((f) => f.kind),
		["phase", "done"],
		"resume after a failed append replays the terminal tail, never an error",
	);
}

// ── Part B: the DO's stream pump ──
const answer = {
	async facetTurn(input: { onDelta: (text: string) => void }) {
		input.onDelta("the answer");
		return { assistantText: "the answer" };
	},
};

{
	// A throwing assistant append still ends the stream with `done`.
	const probe = chatTurnProbe(answer);
	probe.agent.sessionHarness.appendTurn = async (
		_sessionKey: string,
		turn: { role: string },
	) => {
		if (turn.role === "assistant") throw new Error("assistant append failed");
		return true;
	};
	const { frames } = await probe.run({ text: "question" });
	assert.deepEqual(frames.at(-1), {
		kind: "done",
		text: "the answer",
		sessionKey: "main",
		ts: frames.at(-1)?.ts,
	});
	assert.equal(frames.filter((frame) => frame.kind === "error").length, 0);
}

{
	// The assistant row is keyed to the run so a redelivered turn dedups.
	const probe = chatTurnProbe(answer);
	await probe.run({ text: "question", clientRequestId: "req-9" });
	assert.deepEqual(
		probe.appended.map((entry) => entry.key),
		[
			deriveIdempotencyKey("tedi-1:chat:req-9", "user"),
			deriveIdempotencyKey("tedi-1:chat:req-9", "assistant"),
		],
	);
}

{
	// A post-done failure is logged, never sent as an `error` after `done`.
	const probe = chatTurnProbe({
		...answer,
		fields: {
			enqueueCompaction() {
				throw new Error("compaction unavailable");
			},
		},
	});
	const { frames } = await probe.run({ text: "question" });
	assert.equal(frames.at(-1)?.kind, "done");
	assert.equal(frames.filter((frame) => frame.kind === "error").length, 0);
}

{
	// After `done` closes the response, the pump (held by waitUntil) must still
	// wait for the canonical ledger enqueue rather than leave only a user row.
	const events: string[] = [];
	const probe = chatTurnProbe({
		...answer,
		fields: {
			async queue(callback: string) {
				await new Promise((resolve) => setTimeout(resolve, 10));
				events.push(`accepted:${callback}`);
				return "queued";
			},
		},
	});
	const { frames } = await probe.run({ text: "question" });
	assert.equal(frames.at(-1)?.kind, "done");
	assert.deepEqual(events, ["accepted:onLedgerMirror"]);
}
console.log("chat-stream-done-finalization OK");
