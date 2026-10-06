import { describe, expect, test } from "bun:test";
import { InFlightRegistry } from "./inflight";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClock(startMs = 1_000_000): {
	now: () => number;
	advance: (ms: number) => void;
} {
	let t = startMs;
	return {
		now: () => t,
		advance: (ms: number) => {
			t += ms;
		},
	};
}

// ---------------------------------------------------------------------------
// InFlightRegistry: add / settle / remove
// ---------------------------------------------------------------------------

describe("InFlightRegistry: add / settle / remove", () => {
	test("add registers an entry and count increases", () => {
		const reg = new InFlightRegistry();
		expect(reg.count).toBe(0);

		reg.add({
			homeRunId: "run-1",
			label: "What is 2+2?",
			conversationId: "c1",
		});
		expect(reg.count).toBe(1);
	});

	test("list() returns unsettled entries sorted by startedAt ascending", () => {
		const clock = makeClock(1000);
		const reg = new InFlightRegistry({ now: clock.now });

		reg.add({ homeRunId: "run-1", label: "first", conversationId: "c1" });
		clock.advance(200);
		reg.add({ homeRunId: "run-2", label: "second", conversationId: "c1" });

		const entries = reg.list();
		expect(entries.map((e) => e.homeRunId)).toEqual(["run-1", "run-2"]);
	});

	test("settle() marks entry and returns it", () => {
		const reg = new InFlightRegistry();
		reg.add({ homeRunId: "run-1", label: "question", conversationId: "c1" });

		const settled = reg.settle("run-1");
		expect(settled).not.toBeUndefined();
		expect(settled?.homeRunId).toBe("run-1");
		expect(settled?.settled).toBe(true);
	});

	test("settle() removes from list() (entry is marked settled)", () => {
		const reg = new InFlightRegistry();
		reg.add({ homeRunId: "run-1", label: "q", conversationId: "c1" });
		expect(reg.count).toBe(1);

		reg.settle("run-1");
		// list() filters out settled entries
		expect(reg.count).toBe(0);
		expect(reg.list()).toHaveLength(0);
	});

	test("settle() double-settle guard: second call returns undefined", () => {
		const reg = new InFlightRegistry();
		reg.add({ homeRunId: "run-1", label: "q", conversationId: "c1" });

		const first = reg.settle("run-1");
		const second = reg.settle("run-1");

		expect(first).not.toBeUndefined();
		expect(second).toBeUndefined();
	});

	test("settle() on unknown id returns undefined", () => {
		const reg = new InFlightRegistry();
		expect(reg.settle("no-such-run")).toBeUndefined();
	});

	test("remove() deletes the entry from the map", () => {
		const reg = new InFlightRegistry();
		reg.add({ homeRunId: "run-1", label: "q", conversationId: "c1" });
		reg.settle("run-1");
		reg.remove("run-1");

		// After remove, settle again returns undefined (entry gone)
		expect(reg.settle("run-1")).toBeUndefined();
	});

	test("multiple runs: only unsettled appear in list()", () => {
		const clock = makeClock(0);
		const reg = new InFlightRegistry({ now: clock.now });

		reg.add({ homeRunId: "run-1", label: "a", conversationId: "c1" });
		clock.advance(10);
		reg.add({ homeRunId: "run-2", label: "b", conversationId: "c1" });
		clock.advance(10);
		reg.add({ homeRunId: "run-3", label: "c", conversationId: "c1" });

		reg.settle("run-2");

		const ids = reg.list().map((e) => e.homeRunId);
		expect(ids).toContain("run-1");
		expect(ids).toContain("run-3");
		expect(ids).not.toContain("run-2");
		expect(reg.count).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Label truncation (40 codepoints)
// ---------------------------------------------------------------------------

describe("InFlightRegistry: label truncation", () => {
	test("short label kept as-is", () => {
		const reg = new InFlightRegistry();
		const entry = reg.add({
			homeRunId: "r1",
			label: "short",
			conversationId: "c1",
		});
		expect(entry.label).toBe("short");
	});

	test("label > 40 codepoints is truncated with ellipsis", () => {
		const reg = new InFlightRegistry();
		// 41 'a' characters → should become 39 'a's + '…'
		const long = "a".repeat(41);
		const entry = reg.add({
			homeRunId: "r1",
			label: long,
			conversationId: "c1",
		});
		const points = [...entry.label];
		expect(points).toHaveLength(40);
		expect(entry.label.endsWith("…")).toBe(true);
	});

	test("exactly 40 codepoints is kept without truncation", () => {
		const reg = new InFlightRegistry();
		const exact = "b".repeat(40);
		const entry = reg.add({
			homeRunId: "r1",
			label: exact,
			conversationId: "c1",
		});
		expect([...entry.label]).toHaveLength(40);
		expect(entry.label).toBe(exact);
	});

	test("multibyte emoji counts as one codepoint each", () => {
		const reg = new InFlightRegistry();
		// 41 emoji = 41 codepoints → truncated
		const emojiLabel = "🔥".repeat(41);
		const entry = reg.add({
			homeRunId: "r1",
			label: emojiLabel,
			conversationId: "c1",
		});
		expect([...entry.label]).toHaveLength(40);
		expect(entry.label.endsWith("…")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Out-of-order delivery labeling
// ---------------------------------------------------------------------------

describe("InFlightRegistry: out-of-order delivery", () => {
	test("each entry keeps its own label independent of settle order", () => {
		const reg = new InFlightRegistry();
		reg.add({ homeRunId: "run-A", label: "query A", conversationId: "c1" });
		reg.add({ homeRunId: "run-B", label: "query B", conversationId: "c1" });
		reg.add({ homeRunId: "run-C", label: "query C", conversationId: "c1" });

		// Settle B first (out of order)
		const b = reg.settle("run-B");
		expect(b?.label).toBe("query B");
		expect(b?.homeRunId).toBe("run-B");

		// Then C
		const c = reg.settle("run-C");
		expect(c?.label).toBe("query C");

		// Then A
		const a = reg.settle("run-A");
		expect(a?.label).toBe("query A");
	});
});

// ---------------------------------------------------------------------------
// /runs listing: label + elapsed
// ---------------------------------------------------------------------------

describe("InFlightRegistry: /runs listing (elapsed)", () => {
	test("elapsed < 60s returns seconds with one decimal", () => {
		const clock = makeClock(0);
		const reg = new InFlightRegistry({ now: clock.now });
		const entry = reg.add({
			homeRunId: "r1",
			label: "q",
			conversationId: "c1",
		});
		clock.advance(1_234);
		expect(reg.elapsed(entry)).toBe("1.2s");
	});

	test("elapsed exactly 60s returns '1m'", () => {
		const clock = makeClock(0);
		const reg = new InFlightRegistry({ now: clock.now });
		const entry = reg.add({
			homeRunId: "r1",
			label: "q",
			conversationId: "c1",
		});
		clock.advance(60_000);
		expect(reg.elapsed(entry)).toBe("1m");
	});

	test("elapsed 2m5s returns '2m5s'", () => {
		const clock = makeClock(0);
		const reg = new InFlightRegistry({ now: clock.now });
		const entry = reg.add({
			homeRunId: "r1",
			label: "q",
			conversationId: "c1",
		});
		clock.advance(2 * 60_000 + 5_000);
		expect(reg.elapsed(entry)).toBe("2m5s");
	});

	test("elapsed 0ms returns '0.0s'", () => {
		const clock = makeClock(0);
		const reg = new InFlightRegistry({ now: clock.now });
		const entry = reg.add({
			homeRunId: "r1",
			label: "q",
			conversationId: "c1",
		});
		// No time advance
		expect(reg.elapsed(entry)).toBe("0.0s");
	});

	test("list() in /runs command shows all in-flight with labels", () => {
		const clock = makeClock(0);
		const reg = new InFlightRegistry({ now: clock.now });

		reg.add({ homeRunId: "run-1", label: "diana email", conversationId: "c1" });
		clock.advance(500);
		reg.add({
			homeRunId: "run-2",
			label: "summarize budget",
			conversationId: "c1",
		});

		const list = reg.list();
		expect(list).toHaveLength(2);
		expect(list[0]?.label).toBe("diana email");
		expect(list[1]?.label).toBe("summarize budget");
	});
});

// ---------------------------------------------------------------------------
// /wait: waitAll drains all in-flight
// ---------------------------------------------------------------------------

describe("InFlightRegistry: waitAll (/wait behavior)", () => {
	test("waitAll resolves immediately when no runs are in flight", async () => {
		const reg = new InFlightRegistry();
		// Should not hang
		await reg.waitAll({ pollIntervalMs: 1 });
	});

	test("waitAll waits until all runs are settled then resolves", async () => {
		const reg = new InFlightRegistry();
		reg.add({ homeRunId: "run-1", label: "q1", conversationId: "c1" });
		reg.add({ homeRunId: "run-2", label: "q2", conversationId: "c1" });

		let resolved = false;
		const waiting = reg.waitAll({ pollIntervalMs: 5 }).then(() => {
			resolved = true;
		});

		// Not yet settled
		expect(resolved).toBe(false);

		// Settle them asynchronously
		await new Promise((r) => setTimeout(r, 10));
		reg.settle("run-1");
		reg.remove("run-1");

		await new Promise((r) => setTimeout(r, 10));
		reg.settle("run-2");
		reg.remove("run-2");

		await waiting;
		expect(resolved).toBe(true);
	});

	test("waitAll respects abort signal", async () => {
		const reg = new InFlightRegistry();
		reg.add({ homeRunId: "run-1", label: "q", conversationId: "c1" });

		const ac = new AbortController();
		const waitPromise = reg.waitAll({ pollIntervalMs: 5, signal: ac.signal });

		// Abort immediately
		ac.abort();

		await expect(waitPromise).rejects.toThrow("waitAll aborted");
	});

	test("waitAll resolves after single run settles", async () => {
		const reg = new InFlightRegistry();
		reg.add({ homeRunId: "run-1", label: "q", conversationId: "c1" });

		let done = false;
		const waiting = reg.waitAll({ pollIntervalMs: 5 }).then(() => {
			done = true;
		});

		// Give the poller a cycle to see it's not empty
		await new Promise((r) => setTimeout(r, 15));
		expect(done).toBe(false);

		// Settle and remove
		reg.settle("run-1");
		reg.remove("run-1");

		await waiting;
		expect(done).toBe(true);
	});
});
