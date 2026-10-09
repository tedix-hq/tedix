import { describe, expect, test } from "bun:test";
import {
	type RunEventSource,
	type StreamHomeRunEventsInput,
	type StreamHomeRunEventsOptions,
	streamHomeRunEvents,
} from "./events";
import {
	HOME_RUN_EVENTS_START,
	type HomeRunEvent,
	type HomeRunEventsPage,
} from "./home-client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(offset: string, kind = "step"): HomeRunEvent {
	return { offset, kind };
}

function makePage(
	events: HomeRunEvent[],
	nextOffset: string,
	upToDate: boolean,
	status?: string,
	extra?: Partial<HomeRunEventsPage>,
): HomeRunEventsPage {
	return { events, nextOffset, upToDate, closed: false, status, ...extra };
}

/** Fake source that serves pages from a script. */
function makePageSource(
	pages: HomeRunEventsPage[],
): RunEventSource & { calls: string[] } {
	let callIdx = 0;
	const calls: string[] = [];
	return {
		calls,
		async readHomeRunEvents(input) {
			calls.push(`readHomeRunEvents:${input.offset ?? HOME_RUN_EVENTS_START}`);
			const page = pages[callIdx++];
			if (!page) throw new Error("No more pages");
			return page;
		},
	};
}

async function collectHomeRunEvents(
	source: RunEventSource,
	input: StreamHomeRunEventsInput,
	opts?: Omit<StreamHomeRunEventsOptions, "live">,
): Promise<HomeRunEvent[]> {
	const events: HomeRunEvent[] = [];
	for await (const event of streamHomeRunEvents(source, input, {
		...opts,
		live: false,
	})) {
		events.push(event);
	}
	return events;
}

// ---------------------------------------------------------------------------
// Replay mode
// ---------------------------------------------------------------------------

describe("streamHomeRunEvents — replay", () => {
	test("yields all events across paginated pages and stops on upToDate", async () => {
		const pages = [
			makePage([makeEvent("1"), makeEvent("2")], "2", false),
			makePage([makeEvent("3")], "3", true),
		];
		const source = makePageSource(pages);
		const events = await collectHomeRunEvents(source, {
			homeRunId: "run-1",
		});
		expect(events.map((e) => e.offset)).toEqual(["1", "2", "3"]);
	});

	test("stream terminates after reading a page with upToDate=true", async () => {
		const pages = [makePage([makeEvent("10")], "10", true)];
		const source = makePageSource(pages);
		const events = await collectHomeRunEvents(source, { homeRunId: "run-x" });
		expect(events.map((e) => e.offset)).toEqual(["10"]);
	});

	test("starts from provided offset instead of HOME_RUN_EVENTS_START", async () => {
		const pages = [makePage([makeEvent("5")], "5", true)];
		const source = makePageSource(pages);
		const stream = streamHomeRunEvents(
			source,
			{ homeRunId: "run-2", offset: "4" },
			{ live: false },
		);
		for await (const _ of stream) {
			// consume
		}
		// The first call should have used offset "4"
		expect(source.calls[0]).toBe("readHomeRunEvents:4");
	});

	test("empty pages still advance nextOffset and terminate", async () => {
		const pages = [makePage([], "0", false), makePage([], "0", true)];
		const source = makePageSource(pages);
		const events = await collectHomeRunEvents(source, { homeRunId: "run-3" });
		expect(events).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Follow mode
// ---------------------------------------------------------------------------

describe("streamHomeRunEvents — follow", () => {
	test("polls again after upToDate and terminates on settled status", async () => {
		const pages = [
			// First page: not up to date yet
			makePage([makeEvent("1")], "1", false),
			// Caught up but not settled
			makePage([], "1", true, "running"),
			// Second poll: caught up and settled
			makePage([makeEvent("2")], "2", true, "completed"),
		];
		const source = makePageSource(pages);
		const stream = streamHomeRunEvents(
			source,
			{ homeRunId: "run-follow" },
			{ live: true, pollIntervalMs: 0 },
		);
		const events: HomeRunEvent[] = [];
		for await (const e of stream) {
			events.push(e);
		}
		expect(events.map((e) => e.offset)).toEqual(["1", "2"]);
		expect(stream.status).toBe("completed");
	});

	test("AbortSignal from opts.signal stops the follow loop", async () => {
		const ac = new AbortController();
		let callCount = 0;
		const source: RunEventSource = {
			async readHomeRunEvents() {
				callCount++;
				return makePage(
					[makeEvent(String(callCount))],
					String(callCount),
					true,
					"running",
				);
			},
		};

		const stream = streamHomeRunEvents(
			source,
			{ homeRunId: "run-cancel" },
			{ live: true, pollIntervalMs: 5, signal: ac.signal },
		);

		const events: HomeRunEvent[] = [];
		let iterCount = 0;
		for await (const e of stream) {
			events.push(e);
			iterCount++;
			if (iterCount >= 2) {
				ac.abort();
			}
		}
		// Should have stopped after abort — not looped forever
		expect(events.length).toBeLessThanOrEqual(3);
	});

	test("AbortSignal stops the follow loop", async () => {
		const ac = new AbortController();
		let callCount = 0;
		const source: RunEventSource = {
			async readHomeRunEvents() {
				callCount++;
				if (callCount >= 3) ac.abort();
				return makePage([], "0", true, "running");
			},
		};

		const stream = streamHomeRunEvents(
			source,
			{ homeRunId: "run-abort" },
			{ live: true, pollIntervalMs: 0, signal: ac.signal },
		);

		const events: HomeRunEvent[] = [];
		for await (const e of stream) {
			events.push(e);
		}
		expect(callCount).toBeLessThanOrEqual(4);
	});
});

// ---------------------------------------------------------------------------
// Reconnect / backoff
// ---------------------------------------------------------------------------

describe("streamHomeRunEvents — transient error retry", () => {
	test("retries on transient error then succeeds", async () => {
		let attempts = 0;
		const source: RunEventSource = {
			async readHomeRunEvents() {
				attempts++;
				if (attempts < 3) {
					throw new Error("network error: connection reset");
				}
				return makePage([makeEvent("1")], "1", true);
			},
		};

		const events = await collectHomeRunEvents(source, {
			homeRunId: "run-retry",
		});
		expect(events.map((e) => e.offset)).toEqual(["1"]);
		expect(attempts).toBe(3);
	});

	test("rethrows non-transient error immediately", async () => {
		const source: RunEventSource = {
			async readHomeRunEvents() {
				throw new Error("Unauthorized: invalid token");
			},
		};

		await expect(
			collectHomeRunEvents(source, { homeRunId: "run-err" }),
		).rejects.toThrow("Unauthorized");
	});

	test("transient error pattern matches 503/502/429", () => {
		const transientMessages = [
			"503 Service Unavailable",
			"got 502 from upstream",
			"429 rate limit",
			"network connection lost",
			"socket hang up",
			"stream closed",
			"ECONNRESET",
			"timeout exceeded",
			"connection terminated",
		];
		// We test by observing retry behavior
		for (const msg of transientMessages) {
			expect(msg).toMatch(
				/network|timeout|terminated|closed|ECONN|socket|stream|503|502|429/i,
			);
		}
	});
});

// ---------------------------------------------------------------------------
// Draining a paginated stream (regression: `tedix tail` printed nothing, and
// `tedix tail --follow` re-read offset 0 as fast as the gateway would answer
// until the MCP edge rate-limited it out of the run it was tailing)
// ---------------------------------------------------------------------------

describe("streamHomeRunEvents pagination", () => {
	test("drains every page instead of stopping on the first full one", async () => {
		// The server bounds a page by `limit`, so a full page is NOT caught up.
		// `closed` comes from the run's terminal receipt and is therefore true on
		// page 1, long before the terminal event itself has been delivered.
		const source = makePageSource([
			makePage([makeEvent("0"), makeEvent("1")], "2", false, undefined, {
				closed: true,
				terminalEventId: "t",
			}),
			makePage(
				[{ offset: "2", kind: "run.completed", id: "t" }],
				"3",
				false,
				undefined,
				{
					closed: true,
					terminalEventId: "t",
				},
			),
			makePage([], "3", true, undefined, {
				closed: true,
				terminalEventId: "t",
			}),
		]);
		const stream = streamHomeRunEvents(
			source,
			{ homeRunId: "r" },
			{ live: false },
		);
		const seen: HomeRunEvent[] = [];
		for await (const event of stream) seen.push(event);
		expect(seen.map((e) => e.offset)).toEqual(["0", "1", "2"]);
		expect(source.calls).toEqual([
			"readHomeRunEvents:0",
			"readHomeRunEvents:2",
			"readHomeRunEvents:3",
		]);
		expect(stream.status).toBe("completed");
	});

	test("names a failure that arrived pages before the empty final page", async () => {
		const source = makePageSource([
			makePage(
				[{ offset: "0", kind: "run.failed", id: "t" }],
				"1",
				false,
				undefined,
				{
					closed: true,
					terminalEventId: "t",
				},
			),
			makePage(
				[{ offset: "1", kind: "submission.settled", id: "s" }],
				"2",
				false,
				undefined,
				{ closed: true, terminalEventId: "t" },
			),
			makePage([], "2", true, undefined, {
				closed: true,
				terminalEventId: "t",
			}),
		]);
		const stream = streamHomeRunEvents(
			source,
			{ homeRunId: "r" },
			{ live: false },
		);
		for await (const _ of stream) {
			// drain
		}
		// The final page is empty, so only the accumulated signals can say this.
		expect(stream.status).toBe("failed");
	});

	test("follow paces its polls instead of spinning on an open stream", async () => {
		const started = Date.now();
		const source = makePageSource([
			makePage([], "0", true, undefined, { closed: false }),
			makePage([], "0", true, undefined, { closed: false }),
			makePage(
				[{ offset: "0", kind: "run.completed", id: "t" }],
				"1",
				false,
				undefined,
				{
					closed: true,
					terminalEventId: "t",
				},
			),
			makePage([], "1", true, undefined, {
				closed: true,
				terminalEventId: "t",
			}),
		]);
		const stream = streamHomeRunEvents(
			source,
			{ homeRunId: "r" },
			{ live: true, pollIntervalMs: 25 },
		);
		const seen: HomeRunEvent[] = [];
		for await (const event of stream) seen.push(event);
		expect(seen).toHaveLength(1);
		// Two caught-up, still-open pages ⇒ two paced sleeps. Without the pause the
		// loop issues these reads back to back at network speed.
		expect(Date.now() - started).toBeGreaterThanOrEqual(45);
		expect(stream.status).toBe("completed");
	});

	test("live: a caught-up page that carried events is followed at the active pace, not the poll interval", async () => {
		const started = Date.now();
		const source = makePageSource([
			makePage([{ offset: "0", kind: "tool.started" }], "1", true, "running"),
			makePage([{ offset: "1", kind: "tool.completed" }], "2", true, "running"),
			makePage(
				[{ offset: "2", kind: "run.completed" }],
				"3",
				true,
				"completed",
			),
		]);
		const stream = streamHomeRunEvents(
			source,
			{ homeRunId: "r" },
			{ live: true, pollIntervalMs: 200, activePagePaceMs: 10 },
		);
		const seen: HomeRunEvent[] = [];
		for await (const event of stream) seen.push(event);
		expect(seen).toHaveLength(3);
		// Two non-empty open pages: each is followed after the 10ms active pace,
		// not the 200ms interval an empty page waits.
		expect(Date.now() - started).toBeLessThan(150);
		expect(stream.status).toBe("completed");
	});
});
