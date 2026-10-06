import { describe, expect, it } from "vite-plus/test";
import {
	createAnswerDeltaBatcher,
	DEFAULT_ANSWER_DELTA_FLUSH_INTERVAL_MS,
} from "./answer-delta-batcher";

function harness(flushIntervalMs?: number) {
	const flushed: Array<{ chunk: string; sequence: number }> = [];
	const timers: Array<{ fn: () => void; cleared: boolean }> = [];
	const batcher = createAnswerDeltaBatcher({
		persist: (chunk, sequence) => flushed.push({ chunk, sequence }),
		flushIntervalMs,
		setTimer: (fn) => {
			const entry = { fn, cleared: false };
			timers.push(entry);
			return entry;
		},
		clearTimer: (handle) => {
			(handle as { cleared: boolean }).cleared = true;
		},
	});
	return {
		batcher,
		flushed,
		timers,
		fireTimer: () => {
			const pending = timers.filter((t) => !t.cleared).pop();
			if (!pending) throw new Error("no pending timer");
			pending.fn();
		},
		pendingTimerCount: () => timers.filter((t) => !t.cleared).length,
	};
}

describe("createAnswerDeltaBatcher", () => {
	it("flushes the first delta immediately without scheduling a timer", () => {
		const h = harness();
		h.batcher.push("Hello ");
		expect(h.flushed).toEqual([{ chunk: "Hello ", sequence: 0 }]);
		expect(h.pendingTimerCount()).toBe(0);
	});

	it("coalesces pushes after the immediate first flush into one timed flush", () => {
		const h = harness();
		h.batcher.push("Hello ");
		h.batcher.push("world");
		h.batcher.push("!");
		expect(h.pendingTimerCount()).toBe(1);
		h.fireTimer();
		expect(h.flushed).toEqual([
			{ chunk: "Hello ", sequence: 0 },
			{ chunk: "world!", sequence: 1 },
		]);
	});

	it("increments sequence on each flush", () => {
		const h = harness();
		h.batcher.push("chunk 1");
		h.batcher.push("chunk 2");
		h.fireTimer();
		expect(h.flushed[0]).toEqual({ chunk: "chunk 1", sequence: 0 });
		expect(h.flushed[1]).toEqual({ chunk: "chunk 2", sequence: 1 });
	});

	it("end() cancels a post-first pending timer WITHOUT flushing it", () => {
		const h = harness();
		h.batcher.push("first");
		h.batcher.push("partial");
		expect(h.pendingTimerCount()).toBe(1);
		h.batcher.end();
		expect(h.pendingTimerCount()).toBe(0);
		// The immediate first delta remains, while the trailing partial is covered by
		// the terminal
		// message.completed, and a post-commit flush would mis-order after it.
		expect(h.flushed).toEqual([{ chunk: "first", sequence: 0 }]);
	});

	it("end() with no buffered delta emits nothing", () => {
		const h = harness();
		h.batcher.end();
		expect(h.flushed).toHaveLength(0);
	});

	it("end() after a timer flush drops the post-fire partial (no final flush)", () => {
		const h = harness();
		h.batcher.push("first");
		h.batcher.push("second");
		h.batcher.end();
		// Only the immediate first flush persisted; the timed "second" partial
		// is dropped (covered by message.completed).
		expect(h.flushed).toHaveLength(1);
		expect(h.flushed[0]).toEqual({ chunk: "first", sequence: 0 });
	});

	it("flush() persists the pending partial as the next sequence and cancels the timer", () => {
		const h = harness();
		h.batcher.push("first");
		h.batcher.push("rest of the ");
		h.batcher.push("answer");
		expect(h.pendingTimerCount()).toBe(1);
		h.batcher.flush();
		expect(h.pendingTimerCount()).toBe(0);
		expect(h.flushed).toEqual([
			{ chunk: "first", sequence: 0 },
			{ chunk: "rest of the answer", sequence: 1 },
		]);
		// The timer that would have carried the partial post-commit never fires
		// a duplicate row.
		h.batcher.end();
		expect(h.flushed).toHaveLength(2);
	});

	it("flush() with nothing pending emits nothing and arms no timer", () => {
		const h = harness();
		h.batcher.push("first");
		h.batcher.flush();
		h.batcher.flush();
		expect(h.flushed).toEqual([{ chunk: "first", sequence: 0 }]);
		expect(h.pendingTimerCount()).toBe(0);
	});

	it("flush() keeps the sequence monotonic across a timed flush", () => {
		const h = harness();
		h.batcher.push("a");
		h.batcher.push("b");
		h.fireTimer();
		h.batcher.push("c");
		h.batcher.flush();
		expect(h.flushed.map((f) => f.sequence)).toEqual([0, 1, 2]);
		expect(h.flushed[2]?.chunk).toBe("c");
	});

	it("flush() after end() is a no-op", () => {
		const h = harness();
		h.batcher.push("first");
		h.batcher.push("late partial");
		h.batcher.end();
		h.batcher.flush();
		expect(h.flushed).toEqual([{ chunk: "first", sequence: 0 }]);
	});

	it("ignores push() calls after end()", () => {
		const h = harness();
		h.batcher.end();
		h.batcher.push("late");
		expect(h.flushed).toHaveLength(0);
		expect(h.pendingTimerCount()).toBe(0);
	});

	it("ignores empty string push()", () => {
		const h = harness();
		h.batcher.push("");
		expect(h.pendingTimerCount()).toBe(0);
		h.batcher.end();
		expect(h.flushed).toHaveLength(0);
	});

	it("immediately flushes one delta and coalesces all later pushes into one timer", () => {
		const h = harness();
		for (let i = 0; i < 20; i++) h.batcher.push(`token${i} `);
		expect(h.pendingTimerCount()).toBe(1);
		expect(h.flushed).toEqual([{ chunk: "token0 ", sequence: 0 }]);
		h.fireTimer();
		expect(h.flushed).toHaveLength(2);
		expect(h.flushed[1]?.chunk).toContain("token1 ");
		expect(h.flushed[1]?.chunk).toContain("token19 ");
	});

	it("default flushIntervalMs is 1000 (1s window)", () => {
		expect(DEFAULT_ANSWER_DELTA_FLUSH_INTERVAL_MS).toBe(1_000);
	});
});
