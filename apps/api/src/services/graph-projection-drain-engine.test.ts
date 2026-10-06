import type { GraphProjectionOutboxEvent } from "@tedix/db/schema/graph-projection";
import type { SyncEvent } from "../integrations/graph-db/types";
import { describe, expect, it, vi } from "vite-plus/test";

const queryMocks = vi.hoisted(() => ({
	advanceGraphProjectionCursor: vi.fn(),
	getGraphProjectionCursor: vi.fn(),
	readGraphProjectionBatch: vi.fn(),
	recordGraphProjectionFailure: vi.fn(),
	renewGraphProjectionLease: vi.fn(),
}));

vi.mock("@tedix/db/queries/graph-projection", async () => {
	const actual = await vi.importActual<
		typeof import("@tedix/db/queries/graph-projection")
	>("@tedix/db/queries/graph-projection");
	return { ...actual, ...queryMocks };
});

import {
	GraphProjectionHydrationError,
	type GraphProjectionStepRunner,
	runGraphProjectionDrain,
} from "./graph-projection-drain-engine";

const DB = {} as never;

function outbox(sequence: number): GraphProjectionOutboxEvent {
	return {
		sequence,
		eventId: `event-${sequence}`,
		organizationId: "org-1",
		entityKind: "fact",
		entityId: `fact-${sequence}`,
		operation: "upsert",
		payload: null,
		schemaVersion: 1,
		attemptCount: 0,
		nextAttemptAt: null,
		lastError: null,
		poisonedAt: null,
		createdAt: "2026-07-27T00:00:00.000Z",
	};
}

function syncEvent(sequence: number): SyncEvent {
	return {
		op: "upsert_fact",
		id: `fact-${sequence}`,
		orgId: "org-1",
		timestamp: 0,
		payload: { id: `fact-${sequence}`, orgId: "org-1" } as never,
	};
}

/** Batches served in order, then an empty read. */
function serveBatches(batches: GraphProjectionOutboxEvent[][]): void {
	vi.clearAllMocks();
	queryMocks.getGraphProjectionCursor.mockResolvedValue(0);
	queryMocks.renewGraphProjectionLease.mockResolvedValue(true);
	queryMocks.advanceGraphProjectionCursor.mockResolvedValue(true);
	queryMocks.recordGraphProjectionFailure.mockResolvedValue(undefined);
	const queue = [...batches];
	queryMocks.readGraphProjectionBatch.mockImplementation(async () =>
		queue.length > 0 ? queue.shift()! : [],
	);
}

function engineInput(overrides: Record<string, unknown> = {}) {
	return {
		db: DB,
		organizationId: "org-1",
		leaseToken: "token-a",
		maxBatches: 5,
		hydrate: async (events: GraphProjectionOutboxEvent[]) =>
			events.map((event) => syncEvent(event.sequence)),
		project: async () => undefined,
		...overrides,
	};
}

/**
 * A runner that behaves like Cloudflare Workflows at its worst: it records the
 * step name, round-trips the result through JSON, and re-runs the body once to
 * stand in for a replay of a step whose result was not durably recorded.
 */
function replayingRunner(names: string[]): GraphProjectionStepRunner {
	return async <T>(
		name: string,
		_options: unknown,
		body: () => Promise<T>,
	): Promise<T> => {
		names.push(name);
		await body();
		return JSON.parse(JSON.stringify((await body()) ?? null)) as T;
	};
}

describe("graph projection drain engine", () => {
	it("advances the cursor batch by batch until the outbox is drained", async () => {
		serveBatches([[outbox(1), outbox(2)], [outbox(3)]]);
		const projected: string[][] = [];

		const run = await runGraphProjectionDrain(
			engineInput({
				project: async (events: SyncEvent[]) => {
					projected.push(events.map((item) => String(item.id)));
				},
			}),
		);

		expect(projected).toEqual([["fact-1", "fact-2"], ["fact-3"]]);
		expect(
			queryMocks.advanceGraphProjectionCursor.mock.calls.map((call) => [
				call[3],
				call[4],
			]),
		).toEqual([
			[2, { expectedCursor: 0 }],
			[3, { expectedCursor: 2 }],
		]);
		expect(run).toMatchObject({
			cursorBefore: 0,
			cursor: 3,
			processed: 3,
			highWaterSequence: 3,
			stop: { kind: "drained" },
		});
	});

	it("stops at the caller's batch budget with the backlog intact", async () => {
		serveBatches([[outbox(1)], [outbox(2)], [outbox(3)]]);

		const run = await runGraphProjectionDrain(engineInput({ maxBatches: 2 }));

		expect(run.stop).toEqual({ kind: "batch_budget" });
		expect(run.cursor).toBe(2);
		expect(queryMocks.readGraphProjectionBatch).toHaveBeenCalledTimes(2);
	});

	it("never advances past an event the phased write did not commit", async () => {
		const events = [outbox(1), outbox(2)];
		serveBatches([events]);
		const writeError = new Error("Neo4j transaction failed");

		const run = await runGraphProjectionDrain(
			engineInput({
				project: async () => {
					throw writeError;
				},
			}),
		);

		expect(run.stop).toMatchObject({
			kind: "projection_failed",
			failedSequence: 1,
		});
		expect(run.cursor).toBe(0);
		expect(queryMocks.advanceGraphProjectionCursor).not.toHaveBeenCalled();
		// The whole coalesced batch is retained: the Neo4j API reports no
		// per-row failure, so guessing which row failed would drop the others.
		expect(queryMocks.recordGraphProjectionFailure).toHaveBeenCalledTimes(2);
	});

	it("does not write or advance when the lease is no longer ours", async () => {
		serveBatches([[outbox(1)]]);
		queryMocks.renewGraphProjectionLease.mockResolvedValue(false);
		const project = vi.fn(async () => undefined);

		const run = await runGraphProjectionDrain(engineInput({ project }));

		expect(run.stop).toEqual({ kind: "lease_lost", phase: "project" });
		expect(project).not.toHaveBeenCalled();
		expect(queryMocks.advanceGraphProjectionCursor).not.toHaveBeenCalled();
		// A coordination failure must never consume an event's poison budget.
		expect(queryMocks.recordGraphProjectionFailure).not.toHaveBeenCalled();
	});

	it("renews with the caller's lease token and duration at every fence", async () => {
		serveBatches([[outbox(1)]]);

		await runGraphProjectionDrain(
			engineInput({ leaseToken: "token-b", leaseMs: 300_000 }),
		);

		expect(queryMocks.renewGraphProjectionLease.mock.calls).toEqual([
			[DB, "org-1", "token-b", 300_000],
			[DB, "org-1", "token-b", 300_000],
		]);
		expect(queryMocks.advanceGraphProjectionCursor).toHaveBeenCalledWith(
			DB,
			"org-1",
			"token-b",
			1,
			{ expectedCursor: 0 },
		);
	});

	it("reports a fenced checkpoint instead of advancing", async () => {
		serveBatches([[outbox(1)]]);
		queryMocks.advanceGraphProjectionCursor.mockResolvedValue(false);

		const run = await runGraphProjectionDrain(engineInput());

		expect(run.stop).toEqual({ kind: "cursor_fenced", throughSequence: 1 });
		expect(run.cursor).toBe(0);
	});

	it("stops on the head still waiting out its retry backoff", async () => {
		const waiting = outbox(1);
		waiting.attemptCount = 1;
		waiting.nextAttemptAt = "2026-07-27T00:05:00.000Z";
		serveBatches([[waiting]]);

		const run = await runGraphProjectionDrain(
			engineInput({ now: () => Date.parse("2026-07-27T00:00:00.000Z") }),
		);

		expect(run.stop).toEqual({ kind: "retry_backoff", headSequence: 1 });
		expect(run.highWaterSequence).toBe(1);
		expect(queryMocks.advanceGraphProjectionCursor).not.toHaveBeenCalled();
	});

	it("reports acknowledged poison as a degraded reason while still advancing", async () => {
		const poisoned = outbox(1);
		poisoned.poisonedAt = "2026-07-27T00:00:00.000Z";
		serveBatches([[poisoned, outbox(2)]]);
		const project = vi.fn(async () => undefined);

		const run = await runGraphProjectionDrain(engineInput({ project }));

		expect(run.degradedReason).toBe("skipped_poison_events:1");
		expect(run.cursor).toBe(2);
		expect(run.processed).toBe(1);
	});

	it("attributes a hydration failure to the events the hydrator names", async () => {
		const events = [outbox(1), outbox(2)];
		serveBatches([events]);
		const cause = new Error("canonical row unavailable");

		const run = await runGraphProjectionDrain(
			engineInput({
				hydrate: async () => {
					throw new GraphProjectionHydrationError(cause, [events[1]!]);
				},
			}),
		);

		expect(run.stop).toMatchObject({
			kind: "hydration_failed",
			error: cause,
			failedSequence: 2,
		});
		expect(queryMocks.recordGraphProjectionFailure).toHaveBeenCalledTimes(1);
		expect(queryMocks.recordGraphProjectionFailure).toHaveBeenCalledWith(
			DB,
			events[1],
			cause,
		);
	});

	it("retains the whole batch when the hydrator cannot name an offender", async () => {
		serveBatches([[outbox(1), outbox(2)]]);

		const run = await runGraphProjectionDrain(
			engineInput({
				hydrate: async () => {
					throw new Error("batched hydration failed");
				},
			}),
		);

		expect(run.stop).toMatchObject({
			kind: "hydration_failed",
			failedSequence: 1,
		});
		expect(queryMocks.recordGraphProjectionFailure).toHaveBeenCalledTimes(2);
	});

	it("calls back exactly once so the caller can publish readiness and release", async () => {
		serveBatches([[outbox(1)]]);
		const onAbort = vi.fn(async () => undefined);

		await runGraphProjectionDrain(
			engineInput({
				onAbort,
				project: async () => {
					throw new Error("Neo4j transaction failed");
				},
			}),
		);

		expect(onAbort).toHaveBeenCalledTimes(1);
		expect(onAbort.mock.calls[0]![0]).toMatchObject({
			kind: "projection_failed",
		});
		// The watermark handed to the caller is the cursor that is actually
		// persisted, never the sequence the failed batch was reaching for.
		expect(onAbort.mock.calls[0]![1]).toEqual({ cursor: 0 });
	});

	it("does not call back on a clean drain, so the caller keeps its lease", async () => {
		serveBatches([[outbox(1)]]);
		const onAbort = vi.fn(async () => undefined);

		const run = await runGraphProjectionDrain(engineInput({ onAbort }));

		expect(run.stop).toEqual({ kind: "drained" });
		expect(onAbort).not.toHaveBeenCalled();
	});

	it("survives a durable runner that replays every step body", async () => {
		// Each unit of drain work must be re-runnable: Workflows may execute a
		// step body again when its result was not durably recorded. The cursor
		// must end in the same place it would after a clean run.
		serveBatches([]);
		let persistedCursor = 0;
		const rows = [outbox(1), outbox(2)];
		// Re-reading is what a replayed step actually does, so the outbox answers
		// from the persisted cursor rather than from a one-shot queue.
		queryMocks.readGraphProjectionBatch.mockImplementation(
			async (_db: unknown, _org: string, afterSequence: number) =>
				rows.filter((row) => row.sequence > afterSequence),
		);
		queryMocks.getGraphProjectionCursor.mockImplementation(
			async () => persistedCursor,
		);
		queryMocks.advanceGraphProjectionCursor.mockImplementation(
			async (
				_db: unknown,
				_org: string,
				_token: string,
				sequence: number,
				options: { expectedCursor: number },
			) => {
				// The real CAS admits the expected cursor or the sequence it is
				// advancing to, which is what makes a replay report its own outcome.
				if (
					persistedCursor !== options.expectedCursor &&
					persistedCursor !== sequence
				) {
					return false;
				}
				persistedCursor = sequence;
				return true;
			},
		);
		const names: string[] = [];

		const run = await runGraphProjectionDrain(
			engineInput({ runStep: replayingRunner(names) }),
		);

		expect(run.stop).toEqual({ kind: "drained" });
		expect(run.cursor).toBe(2);
		expect(persistedCursor).toBe(2);
		expect(names).toEqual([
			"read-initial-cursor",
			"plan-0",
			"hydrate-0-2",
			"project-0-2",
			"checkpoint-2",
			"plan-2",
		]);
	});
});
