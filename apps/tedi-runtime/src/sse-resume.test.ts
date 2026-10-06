/**
 * Gate proof for the SSE resumability contract. Verifies the no-loss / no-duplicate reconnect guarantee, monotonic
 * event ids, the runid-mismatch fresh-stream fallback, the bounded window, and
 * the terminal grace — the same resume bar the multiplexed WS island was built
 * to satisfy, now met by browser-native `Last-Event-ID`.
 */
import assert from "node:assert/strict";
import { formatSseFrame, parseLastEventId, SseRunBuffer } from "./sse-resume";

const RUN = "tedi-1:chat:req-abc";

// Event-id line format: `id: {runId}:{seq}` then the data line.
{
	const wire = formatSseFrame(RUN, 3, { kind: "delta", text: "hi" });
	assert.equal(wire, `id: ${RUN}:3\ndata: {"kind":"delta","text":"hi"}\n\n`);
}

// parseLastEventId splits on the LAST colon (runId itself contains colons).
{
	assert.deepEqual(parseLastEventId(`${RUN}:7`), { runId: RUN, seq: 7 });
	assert.equal(parseLastEventId(null), null);
	assert.equal(parseLastEventId(""), null);
	assert.equal(parseLastEventId(`${RUN}:`), null); // no seq
	assert.equal(parseLastEventId(`${RUN}:x`), null); // non-numeric
	assert.equal(parseLastEventId("noseq"), null);
}

// append assigns monotonic seqs starting at 0; ids never repeat.
{
	const buf = new SseRunBuffer(RUN);
	assert.equal(buf.append({ kind: "delta", text: "a" }), 0);
	assert.equal(buf.append({ kind: "delta", text: "b" }), 1);
	assert.equal(buf.append({ kind: "delta", text: "c" }), 2);
}

// Core contract: reconnect at seq N replays exactly N+1.. — no loss, no dup.
{
	const buf = new SseRunBuffer(RUN);
	for (const t of ["a", "b", "c", "d"]) buf.append({ kind: "delta", text: t });
	// Client last saw seq 1 ("b"); reconnect must deliver exactly "c","d".
	const res = buf.resolve(parseLastEventId(`${RUN}:1`));
	assert.equal(res.mode, "replay");
	if (res.mode !== "replay") throw new Error("unreachable");
	assert.deepEqual(
		res.frames.map((f) => [
			f.seq,
			(f.frame as unknown as { text: string }).text,
		]),
		[
			[2, "c"],
			[3, "d"],
		],
	);
	// Concatenating seen-prefix + replay reconstructs the full stream once, in
	// order — the no-loss/no-dup property stated as an equality.
	const seenPrefix = ["a", "b"];
	const replayed = res.frames.map(
		(f) => (f.frame as unknown as { text: string }).text,
	);
	assert.deepEqual([...seenPrefix, ...replayed], ["a", "b", "c", "d"]);
}

// Reconnect exactly at the tail replays nothing (already caught up).
{
	const buf = new SseRunBuffer(RUN);
	for (const t of ["a", "b"]) buf.append({ kind: "delta", text: t });
	const res = buf.resolve(parseLastEventId(`${RUN}:1`));
	assert.equal(res.mode, "replay");
	if (res.mode !== "replay") throw new Error("unreachable");
	assert.equal(res.frames.length, 0);
}

// Late reconnect after `done` replays the tail INCLUDING the terminal frame.
{
	const buf = new SseRunBuffer(RUN);
	buf.append({ kind: "delta", text: "x" });
	buf.append({ kind: "done", text: "x" });
	const res = buf.resolve(parseLastEventId(`${RUN}:0`));
	assert.equal(res.mode, "replay");
	if (res.mode !== "replay") throw new Error("unreachable");
	assert.equal(res.frames.length, 1);
	assert.equal(res.frames[0]?.frame.kind, "done");
	assert.equal(res.terminated, true);
}

// A reconnect carrying a DIFFERENT runId (a new turn started) is fresh, not a
// bogus replay against the wrong run.
{
	const buf = new SseRunBuffer(RUN);
	buf.append({ kind: "delta", text: "a" });
	const res = buf.resolve(parseLastEventId("tedi-1:chat:OTHER:0"));
	assert.equal(res.mode, "fresh");
	if (res.mode !== "fresh") throw new Error("unreachable");
	assert.equal(res.reason, "runid-mismatch");
}

// No Last-Event-ID → fresh stream (first connect).
{
	const buf = new SseRunBuffer(RUN);
	assert.equal(buf.resolve(null).mode, "fresh");
}

// Bounded window: overflow drops OLDEST deltas, seq stays monotonic, and a
// client behind the retained head is forced fresh (never handed a gap).
{
	const buf = new SseRunBuffer(RUN, 3); // keep only 3 frames
	for (const t of ["a", "b", "c", "d", "e"])
		buf.append({ kind: "delta", text: t });
	// Retained: seqs 2,3,4 ("c","d","e"); earliest seq = 2.
	assert.equal(buf.earliestSeq, 2);
	// Client at seq 4 is caught up → clean replay (nothing).
	const caughtUp = buf.resolve(parseLastEventId(`${RUN}:4`));
	assert.equal(caughtUp.mode, "replay");
	// Client at seq 0 is behind the retained head → fresh (a replay would skip 1).
	const behind = buf.resolve(parseLastEventId(`${RUN}:0`));
	assert.equal(behind.mode, "fresh");
	if (behind.mode !== "fresh") throw new Error("unreachable");
	assert.equal(behind.reason, "no-buffer");
}

// Terminal grace: not expired immediately, expired after the window.
{
	const buf = new SseRunBuffer(RUN);
	const t0 = 1_000_000;
	buf.append({ kind: "done", text: "x" }, t0);
	assert.equal(buf.isTerminated, true);
	assert.equal(buf.isExpired(t0, 30_000), false);
	assert.equal(buf.isExpired(t0 + 30_000, 30_000), true);
}

console.log("sse-resume OK");
