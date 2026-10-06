/**
 * Gate proof (part 2): the live-attach fan-out. Proves the end-to-end
 * "drop mid-turn → reconnect → exact continuation" guarantee across the buffer
 * + subscriber hub — a mid-turn reconnect replays only what it missed and then
 * receives every subsequent live frame, with no loss and no duplicate.
 */
import assert from "node:assert/strict";
import { ChatStreamHub, type FrameSink } from "./chat-stream-hub";
import { parseLastEventId } from "./sse-resume";

const RUN = "tedi-1:chat:req-1";

/** A sink that records the data payloads it received, in order. */
function recordingSink(): FrameSink & {
	texts: () => string[];
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
		texts() {
			// Extract the `data:` json payloads' text/kind for assertions.
			return chunks
				.map((c) => {
					const m = c.match(/data: (.*)\n\n$/);
					return m?.[1] ?? "";
				})
				.filter((s): s is string => s.length > 0);
		},
	};
	return sink;
}

// End-to-end contract: primary streams a,b; client drops after b; a NEW
// sink reconnects with Last-Event-ID at b; it must replay nothing-yet-missed
// and then receive c,d live — full stream reconstructed exactly once.
{
	const hub = new ChatStreamHub();
	const primary = recordingSink();
	hub.openRun(RUN, primary);
	hub.emit(RUN, { kind: "delta", text: "a" }); // id seq 0
	hub.emit(RUN, { kind: "delta", text: "b" }); // id seq 1
	// Primary "drops": detach it. Client last saw seq 1.
	hub.detach(RUN, primary);

	const reconnect = recordingSink();
	const res = hub.attach(RUN, reconnect, parseLastEventId(`${RUN}:1`));
	assert.equal(res.outcome, "attached-live");
	// Nothing to replay (caught up at seq 1); now live frames arrive.
	hub.emit(RUN, { kind: "delta", text: "c" }); // seq 2
	hub.emit(RUN, { kind: "delta", text: "d" }); // seq 3
	hub.emit(RUN, { kind: "done", text: "abcd" }); // seq 4
	hub.closeRun(RUN);

	const primaryText = primary
		.texts()
		.map((j) => JSON.parse(j).text)
		.filter(Boolean);
	const reconnectText = reconnect
		.texts()
		.map((j) => JSON.parse(j).text)
		.filter(Boolean);
	// Primary saw a,b (+ possibly done "abcd"); reconnect saw c,d,(done abcd).
	assert.deepEqual(primaryText, ["a", "b"]);
	// Concatenation across the reconnect boundary = the full stream, once.
	assert.deepEqual(
		["a", "b", ...reconnectText.filter((t) => t !== "abcd")],
		["a", "b", "c", "d"],
	);
	assert.equal(reconnect.closed, true); // closed on terminal
}

// Reconnect DURING a turn, behind the tail: replays the missed deltas THEN
// continues live — the no-loss property when the drop straddles frames.
{
	const hub = new ChatStreamHub();
	const primary = recordingSink();
	hub.openRun(RUN, primary);
	hub.emit(RUN, { kind: "delta", text: "a" }); // 0
	hub.emit(RUN, { kind: "delta", text: "b" }); // 1  (primary got these)
	hub.detach(RUN, primary);
	hub.emit(RUN, { kind: "delta", text: "c" }); // 2  (missed while gone)
	// Reconnect at seq 1: must replay c (2), then live d.
	const reconnect = recordingSink();
	hub.attach(RUN, reconnect, parseLastEventId(`${RUN}:1`));
	hub.emit(RUN, { kind: "delta", text: "d" }); // 3 live
	const got = reconnect.texts().map((j) => JSON.parse(j).text);
	assert.deepEqual(got, ["c", "d"]); // replayed c, then live d — no loss, no dup
}

// Late reconnect after the run terminated (within grace): replays the tail
// including `done`, then closes — no live subscription.
{
	const hub = new ChatStreamHub();
	const primary = recordingSink();
	hub.openRun(RUN, primary);
	hub.emit(RUN, { kind: "delta", text: "x" }); // 0
	hub.emit(RUN, { kind: "done", text: "x" }); // 1
	hub.closeRun(RUN);
	const reconnect = recordingSink();
	const res = hub.attach(RUN, reconnect, parseLastEventId(`${RUN}:0`));
	assert.equal(res.outcome, "replayed-terminated");
	const kinds = reconnect.texts().map((j) => JSON.parse(j).kind);
	assert.deepEqual(kinds, ["done"]);
	assert.equal(reconnect.closed, true);
}

// Unknown / mismatched run → fresh (client restarts).
{
	const hub = new ChatStreamHub();
	const sink = recordingSink();
	assert.equal(
		hub.attach("no-such-run", sink, parseLastEventId(`no-such-run:0`)).outcome,
		"fresh",
	);
}

// Prune evicts a terminated run only after its grace window.
{
	const hub = new ChatStreamHub({ graceMs: 1000 });
	const primary = recordingSink();
	hub.openRun(RUN, primary);
	hub.emit(RUN, { kind: "done", text: "x" }, 100);
	hub.closeRun(RUN);
	hub.prune(500); // within grace
	assert.equal(hub.size, 1);
	hub.prune(1100); // past grace
	assert.equal(hub.size, 0);
}

console.log("chat-stream-hub OK");
