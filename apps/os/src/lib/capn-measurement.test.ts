import { describe, expect, it } from "vite-plus/test";
import {
	createTransportMetrics,
	DEFAULT_RING_CAPACITY,
	getSharedTransportMetrics,
	type TransportMetrics,
	type TransportMetricsGlobal,
} from "./capn-measurement";

/** Injectable clock: each `tick(ms)` advances; `now` hands the current instant. */
function fakeClock(start = 1_000) {
	let at = start;
	return {
		now: () => at,
		tick: (ms: number) => {
			at += ms;
		},
	};
}

function metricsWithClock(start = 1_000): {
	metrics: TransportMetrics;
	tick: (ms: number) => void;
} {
	const clock = fakeClock(start);
	return {
		metrics: createTransportMetrics({ now: clock.now }),
		tick: clock.tick,
	};
}

describe("first-token latency", () => {
	it("pairs enqueue → first assistant delta by run id, exactly once", () => {
		const { metrics, tick } = metricsWithClock();
		metrics.markEnqueued("capn", "run-1");
		tick(120);
		metrics.markFirstAssistantDelta("capn", "run-1");
		tick(50);
		// later deltas of the same run never re-record
		metrics.markFirstAssistantDelta("capn", "run-1");
		const summary = metrics.summary().capn.firstToken;
		expect(summary.count).toBe(1);
		expect(summary.lastMs).toBe(120);
		expect(summary.maxMs).toBe(120);
	});

	it("ignores deltas for runs that were never enqueue-armed (other tabs, history)", () => {
		const { metrics } = metricsWithClock();
		metrics.markFirstAssistantDelta("capn", "foreign-run");
		expect(metrics.summary().capn.firstToken.count).toBe(0);
		expect(metrics.samples()).toEqual([]);
	});

	it("a same-key retry re-arms the measurement", () => {
		const { metrics, tick } = metricsWithClock();
		metrics.markEnqueued("capn", "run-1");
		tick(10);
		metrics.markFirstAssistantDelta("capn", "run-1");
		metrics.markEnqueued("capn", "run-1"); // retry with the SAME key
		tick(30);
		metrics.markFirstAssistantDelta("capn", "run-1");
		const stat = metrics.summary().capn.firstToken;
		expect(stat.count).toBe(2);
		expect(stat.lastMs).toBe(30);
		expect(stat.meanMs).toBe(20);
	});
});

describe("send-to-visible latency", () => {
	it("pairs enqueue → visible by idempotency key", () => {
		const { metrics, tick } = metricsWithClock();
		metrics.markEnqueued("capn", "key-1");
		tick(45);
		metrics.markVisible("capn", "key-1");
		metrics.markVisible("capn", "key-1"); // repeat is a no-op
		const stat = metrics.summary().capn.sendToVisible;
		expect(stat.count).toBe(1);
		expect(stat.lastMs).toBe(45);
	});
});

describe("reconnect recovery", () => {
	it("measures outage start → next open, keeping the FIRST disconnect instant", () => {
		const { metrics, tick } = metricsWithClock();
		metrics.markDisconnected("capn");
		tick(500);
		metrics.markDisconnected("capn"); // backoff cycle repeats — not a new outage
		tick(700);
		metrics.markReconnected("capn");
		const stat = metrics.summary().capn.reconnectRecovery;
		expect(stat.count).toBe(1);
		expect(stat.lastMs).toBe(1200);
	});

	it("ignores an open without a preceding disconnect (initial connect)", () => {
		const { metrics } = metricsWithClock();
		metrics.markReconnected("capn");
		expect(metrics.summary().capn.reconnectRecovery.count).toBe(0);
	});
});

describe("duplicate / missing event accounting", () => {
	it("counts app-layer duplicates by event id", () => {
		const { metrics } = metricsWithClock();
		metrics.recordEventId("capn", "evt-1");
		metrics.recordEventId("capn", "evt-2");
		metrics.recordEventId("capn", "evt-1");
		expect(metrics.summary().capn.duplicateEvents).toBe(1);
	});

	it("counts wire duplicate offsets and computes missing offsets from the ledger span", () => {
		const { metrics } = metricsWithClock();
		for (const offset of [0, 1, 2, 2, 5]) {
			metrics.recordWireOffset("capn", "home:main", offset);
		}
		const summary = metrics.summary().capn;
		expect(summary.wireDuplicateOffsets).toBe(1);
		// span 0..5 = 6 slots, 4 distinct seen → offsets 3 and 4 missing
		expect(summary.wireMissingOffsets).toBe(2);
	});

	it("keeps ledgers per stream key and rejects malformed offsets", () => {
		const { metrics } = metricsWithClock();
		metrics.recordWireOffset("capn", "conv-a", 0);
		metrics.recordWireOffset("capn", "conv-b", 3);
		metrics.recordWireOffset("capn", "conv-b", -1);
		metrics.recordWireOffset("capn", "conv-b", 1.5);
		// two single-offset ledgers → no gaps, no duplicates
		const summary = metrics.summary().capn;
		expect(summary.wireMissingOffsets).toBe(0);
		expect(summary.wireDuplicateOffsets).toBe(0);
	});
});

describe("unknown outcomes and stub registry", () => {
	it("counts unknown enqueue outcomes with their key", () => {
		const { metrics } = metricsWithClock();
		metrics.recordUnknownOutcome("capn", "key-9");
		expect(metrics.summary().capn.unknownOutcomes).toBe(1);
		expect(metrics.samples()).toEqual([
			{
				at: 1000,
				lane: "capn",
				metric: "unknown_outcome",
				value: 1,
				key: "key-9",
			},
		]);
	});

	it("tracks live stubs, releases idempotently, and leaks only what outlives the session", () => {
		const { metrics } = metricsWithClock();
		const releaseRoot = metrics.trackStub("capn", "root");
		metrics.trackStub("capn", "conversation"); // never released → leak
		expect(metrics.liveStubCount("capn")).toBe(2);
		releaseRoot();
		releaseRoot(); // double-release is a no-op
		expect(metrics.liveStubCount("capn")).toBe(1);
		expect(metrics.markSessionClosed("capn")).toBe(1);
		expect(metrics.liveStubCount("capn")).toBe(0);
		const summary = metrics.summary().capn;
		expect(summary.leakedStubs).toBe(1);
		expect(summary.liveStubs).toBe(0);
		expect(
			metrics
				.samples()
				.filter((sample) => sample.metric === "leaked_stub")
				.map((sample) => sample.key),
		).toEqual(["conversation"]);
	});
});

describe("honesty counters", () => {
	it("counts failed establishes, so a lane that never connects is visible", () => {
		const metrics = createTransportMetrics();
		// reconnect_recovery_ms only samples on the reconnecting→open edge, so
		// a lane stuck in a connect→fail→backoff loop otherwise records NOTHING
		// and reads identically to a healthy one.
		metrics.recordConnectFailure("capn");
		metrics.recordConnectFailure("capn");
		expect(metrics.summary().capn.connectFailures).toBe(2);
		expect(metrics.summary().capn.reconnectRecovery.count).toBe(0);
	});

	it("keeps per-stream offset ledgers apart so run-local offsets do not fake gaps", () => {
		const metrics = createTransportMetrics();
		// Run-local offsets restart at 0. A conversation-keyed ledger sees
		// 0,1,0 as a duplicate; two run-keyed ledgers see two clean streams.
		metrics.recordWireOffset("capn", "home:main:run-1", 0);
		metrics.recordWireOffset("capn", "home:main:run-1", 1);
		metrics.recordWireOffset("capn", "home:main:run-2", 0);
		const summary = metrics.summary().capn;
		expect(summary.wireDuplicateOffsets).toBe(0);
		expect(summary.wireMissingOffsets).toBe(0);
	});
});

describe("sample ring", () => {
	it("is bounded: the oldest samples fall off past capacity", () => {
		const clock = fakeClock();
		const metrics = createTransportMetrics({ now: clock.now, ringCapacity: 3 });
		for (let index = 0; index < 5; index += 1) {
			metrics.recordUnknownOutcome("capn", `key-${index}`);
		}
		expect(metrics.samples().map((sample) => sample.key)).toEqual([
			"key-2",
			"key-3",
			"key-4",
		]);
		// counters keep the full total even after ring eviction
		expect(metrics.summary().capn.unknownOutcomes).toBe(5);
		expect(DEFAULT_RING_CAPACITY).toBeGreaterThan(3);
	});
});

describe("getSharedTransportMetrics", () => {
	it("returns null outside dev builds", () => {
		const target: TransportMetricsGlobal = {};
		expect(getSharedTransportMetrics(false, target)).toBeNull();
		expect(target.__tedixTransportMetrics).toBeUndefined();
	});

	it("installs once on the global and reuses the same instance", () => {
		const target: TransportMetricsGlobal = {};
		const first = getSharedTransportMetrics(true, target);
		const second = getSharedTransportMetrics(true, target);
		expect(first).not.toBeNull();
		expect(second).toBe(first);
		expect(target.__tedixTransportMetrics).toBe(first);
	});
});
