/**
 * Resume-endpoint contract for Tedix OS SSE chat.
 *
 * Part A (behavioral): the exact `ChatStreamHub` calls `resumeChatStream` makes.
 *   - FIRST connect carries no `Last-Event-ID`; the endpoint synthesizes
 *     `{runId, seq:-1}` so the whole buffered stream (seq 0..) replays, then the
 *     sink goes live — a fresh EventSource sees every frame, none skipped.
 *   - RECONNECT carries the client's real `Last-Event-ID`; only the frames after
 *     it replay, then live continuation — no loss, no duplicate.
 *   - A run the hub never opened (evicted / unknown) resolves `fresh`, which the
 *     endpoint maps to a typed recoverable `error` frame (client re-sends).
 *
 * Part B: the DO route — GET resumes a run the turn pump fed through the hub,
 * replaying from seq 0 on first connect and after `Last-Event-ID` on reconnect.
 * Part C: the Worker edge forwards a GET resume to the DO with its query intact.
 */
import assert from "node:assert/strict";
import { chatTurnProbe, sseFrames } from "../test/tedi-do";
import { edgeFetch, tediRequest } from "../test/tedi-edge";
import { ChatStreamHub, type FrameSink } from "./chat-stream-hub";
import { parseLastEventId } from "./sse-resume";

const RUN = "tedi-7:chat:req-42";

function recordingSink(): FrameSink & {
	kinds: () => string[];
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
		kinds() {
			return chunks
				.map((c) => c.match(/data: (.*)\n\n$/)?.[1] ?? "")
				.filter((s) => s.length > 0)
				.map((j) => (JSON.parse(j) as { kind: string }).kind);
		},
	};
	return sink;
}

// The endpoint's first-connect synthesis (mirrors resumeChatStream exactly).
function firstConnectId(runId: string) {
	return parseLastEventId(null) ?? { runId, seq: -1 };
}

// ── Part A1: first connect (no header) replays the whole buffer, then live ──
{
	const hub = new ChatStreamHub();
	hub.openRun(RUN, recordingSink()); // primary (the POST turn's own sink)
	hub.emit(RUN, { kind: "delta", text: "a" });
	hub.emit(RUN, { kind: "delta", text: "b" });

	// A fresh EventSource GET arrives mid-turn with NO Last-Event-ID.
	const resume = recordingSink();
	const res = hub.attach(RUN, resume, firstConnectId(RUN));
	assert.equal(res.outcome, "attached-live");
	// It must have received BOTH already-buffered deltas (from seq 0), not zero.
	assert.deepEqual(resume.kinds(), ["delta", "delta"]);

	// ...then the live continuation reaches it too.
	hub.emit(RUN, { kind: "delta", text: "c" });
	hub.emit(RUN, { kind: "done", text: "abc" });
	assert.deepEqual(resume.kinds(), ["delta", "delta", "delta", "done"]);
}

// ── Part A2: reconnect with a real Last-Event-ID replays only the tail ──
{
	const hub = new ChatStreamHub();
	hub.openRun(RUN, recordingSink());
	// seqs: 0=delta a, 1=delta b, 2=delta c
	hub.emit(RUN, { kind: "delta", text: "a" });
	hub.emit(RUN, { kind: "delta", text: "b" });
	hub.emit(RUN, { kind: "delta", text: "c" });

	// Client last saw seq 1 (delta b); reconnect must replay only seq 2 onward.
	const resume = recordingSink();
	const res = hub.attach(RUN, resume, parseLastEventId(`${RUN}:1`));
	assert.equal(res.outcome, "attached-live");
	assert.deepEqual(resume.kinds(), ["delta"]); // only c, not a/b (no dup)

	hub.emit(RUN, { kind: "done", text: "abc" });
	assert.deepEqual(resume.kinds(), ["delta", "done"]); // + live done, no loss
}

// ── Part A3: unknown/evicted run → fresh → the endpoint emits a recoverable error ──
{
	const hub = new ChatStreamHub();
	const resume = recordingSink();
	const res = hub.attach(
		"tedi-7:chat:gone",
		resume,
		firstConnectId("tedi-7:chat:gone"),
	);
	assert.equal(res.outcome, "fresh");
	// resumeChatStream maps `fresh` → a typed recoverable error frame + close;
	// assert the classification the endpoint keys on.
	assert.equal("reason" in res && typeof res.reason === "string", true);
}

// ── Part B: the DO resumes a streamed turn from its hub buffer ──
{
	const probe = chatTurnProbe({
		async facetTurn(input) {
			input.onDelta("Hel");
			input.onDelta("lo");
			return { assistantText: "Hello" };
		},
	});
	const { frames } = await probe.run({ text: "hi", clientRequestId: "req-42" });
	const runId = "tedi-1:chat:req-42";
	const deltas = frames.filter((frame) => frame.kind === "delta");
	assert.deepEqual(
		deltas.map((frame) => frame.text),
		["Hel", "lo"],
		"the turn pump emits deltas through the hub to the primary response",
	);
	assert.equal(frames.at(-1)?.kind, "done");

	const resume = async (headers: Record<string, string> = {}) => {
		const response = await probe.agent.onRequest(
			new Request(
				`https://do.internal/__internal/chat/stream?run_id=${encodeURIComponent(runId)}`,
				{ method: "GET", headers },
			),
		);
		assert.equal(response.status, 200);
		return sseFrames(await response.text());
	};
	// First connect: no Last-Event-ID replays the whole buffer from seq 0.
	assert.deepEqual(
		(await resume()).map((frame) => frame.kind),
		frames.map((frame) => frame.kind),
	);
	// Reconnect: only frames after the client's last seen seq.
	const lastSeq = frames.length - 2;
	assert.deepEqual(
		(await resume({ "Last-Event-ID": `${runId}:${lastSeq}` })).map(
			(frame) => frame.kind,
		),
		["done"],
	);
	// Unknown run: a typed recoverable error, never a hang.
	const unknown = await probe.agent.onRequest(
		new Request("https://do.internal/__internal/chat/stream?run_id=gone", {
			method: "GET",
		}),
	);
	const [error] = sseFrames(await unknown.text());
	assert.equal(error?.kind, "error");
	assert.equal(error?.recoverable, true);
}

// ── Part C: the edge gate forwards GET resume, not just POST ──
// A reconnecting EventSource reaches the DO's GET resume only if the Worker
// edge `/hooks/chat-stream` gate accepts GET and forwards the method with the
// query (run_id/last_event_id) and Last-Event-ID header preserved.
{
	const run = await edgeFetch(
		tediRequest("/hooks/chat-stream?run_id=r-1&last_event_id=r-1%3A3", {
			method: "GET",
			serviceBinding: true,
			headers: { "Last-Event-ID": "r-1:3" },
		}),
	);
	assert.equal(run.response.status, 200);
	const [forward] = run.forwarded;
	assert.ok(forward);
	assert.equal(forward.method, "GET");
	assert.equal(forward.body, null, "GET resume forwards no body");
	const forwardUrl = new URL(forward.url);
	assert.equal(forwardUrl.pathname, "/__internal/chat/stream");
	assert.equal(forwardUrl.searchParams.get("run_id"), "r-1");
	assert.equal(forwardUrl.searchParams.get("last_event_id"), "r-1:3");
	assert.equal(forward.headers.get("Last-Event-ID"), "r-1:3");

	const post = await edgeFetch(
		tediRequest("/hooks/chat-stream", {
			method: "POST",
			serviceBinding: true,
			body: JSON.stringify({ text: "hi" }),
		}),
	);
	assert.equal(post.forwarded[0]?.method, "POST");
	assert.deepEqual(await post.forwarded[0]?.json(), { text: "hi" });

	const publicCaller = await edgeFetch(
		tediRequest("/hooks/chat-stream?run_id=r-1", { method: "GET" }),
	);
	assert.equal(publicCaller.response.status, 403);
	assert.equal(publicCaller.forwarded.length, 0);
}

console.log("chat-stream-resume-endpoint OK");
