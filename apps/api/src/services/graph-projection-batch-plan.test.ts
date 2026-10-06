import type { GraphProjectionOutboxEvent } from "@tedix/db/schema/graph-projection";
import { describe, expect, it } from "vite-plus/test";
import {
	buildDurableGraphProjectionBatchPlan,
	type DurableGraphProjectionBatchPlan,
} from "./graph-projection-batch-plan";

function event(
	sequence: number,
	nextAttemptAt: string | null,
	poisonedAt: string | null = null,
): GraphProjectionOutboxEvent {
	return {
		sequence,
		eventId: `event-${sequence}`,
		organizationId: "org-1",
		entityKind: "fact",
		entityId: `fact-${sequence}`,
		operation: "upsert",
		payload: null,
		schemaVersion: 1,
		attemptCount: nextAttemptAt ? 1 : 0,
		nextAttemptAt,
		lastError: nextAttemptAt ? "retry" : null,
		poisonedAt,
		createdAt: "2026-07-27T00:00:00.000Z",
	};
}

describe("durable graph projection batch plan", () => {
	it("keeps the acknowledged prefix immutable when a delayed row becomes due during replay", () => {
		const fetched = [event(11, null), event(12, "2026-07-27T12:01:00.000Z")];
		const firstAttempt = buildDurableGraphProjectionBatchPlan(
			fetched,
			Date.parse("2026-07-27T12:00:00.000Z"),
		);
		expect(firstAttempt).toMatchObject({
			eligibleCount: 1,
			endSequence: 11,
		});

		// Cloudflare Workflows replays the persisted step result. A fresh
		// wall-clock evaluation would now include sequence 12, but the cached
		// plan used by hydrate/project/checkpoint remains sequence 11.
		const replayed = JSON.parse(
			JSON.stringify(firstAttempt),
		) as DurableGraphProjectionBatchPlan;
		const unsafeReevaluation = buildDurableGraphProjectionBatchPlan(
			fetched,
			Date.parse("2026-07-27T12:02:00.000Z"),
		);
		expect(replayed.endSequence).toBe(11);
		expect(replayed.coalesced.map((item) => item.sequence)).toEqual([11]);
		expect(unsafeReevaluation.endSequence).toBe(12);
	});

	it("advances past poisoned events instead of freezing the organization", () => {
		// A poisoned event has spent its retry budget, so nothing will ever make
		// it projectable. Stopping on it held one org's cursor at sequence
		// 350,799 for 37 days; because the retention prune only deletes rows at
		// or below the cursor, 934,288 rows behind it also became uncollectable.
		const poisoned = "2026-07-27T06:50:00.000Z";
		const plan = buildDurableGraphProjectionBatchPlan(
			[event(11, null, poisoned), event(12, null, poisoned), event(13, null)],
			Date.parse("2026-07-27T12:00:00.000Z"),
		);

		// The cursor moves past the poisoned pair and the healthy event still runs.
		expect(plan.endSequence).toBe(13);
		expect(plan.coalesced.map((item) => item.sequence)).toEqual([13]);
		expect(plan.eligibleCount).toBe(1);
		// Skipping is reported, so the organization reads as degraded.
		expect(plan.blockedReason).toBe("skipped_poison_events:2");
	});

	it("still stops at an event waiting out its retry backoff", () => {
		const plan = buildDurableGraphProjectionBatchPlan(
			[
				event(21, null, "2026-07-27T06:50:00.000Z"),
				event(22, "2026-07-27T12:05:00.000Z"),
				event(23, null),
			],
			Date.parse("2026-07-27T12:00:00.000Z"),
		);

		// Sequence 22 is due later and becomes the next head; 23 must not jump it.
		expect(plan.endSequence).toBe(21);
		expect(plan.coalesced).toEqual([]);
		expect(plan.blockedReason).toBe("skipped_poison_events:1");
		// The backlog high water covers the tail the cursor may not reach yet.
		expect(plan.headSequence).toBe(21);
		expect(plan.fetchedEndSequence).toBe(23);
	});

	it("reports an empty read as a drained outbox, not a blocked head", () => {
		const plan = buildDurableGraphProjectionBatchPlan(
			[],
			Date.parse("2026-07-27T12:00:00.000Z"),
		);

		// The drain engine tells "nothing to do" from "the head is waiting" by
		// whether anything was read at all.
		expect(plan).toEqual({
			coalesced: [],
			eligibleCount: 0,
			endSequence: null,
			blockedReason: null,
			headSequence: null,
			fetchedEndSequence: null,
		});
	});
});
