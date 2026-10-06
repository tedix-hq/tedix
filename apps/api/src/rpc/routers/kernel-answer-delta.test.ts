import { kernelRuntimeEvents } from "@tedix/db/schema";
import { describe, expect, it, vi } from "vite-plus/test";
import { createAnswerDeltaBatcher } from "../../kernel/answer-delta-batcher";
import { recordHomeAnswerDelta } from "./kernel/home-live-events";

type EventInsert = typeof kernelRuntimeEvents.$inferInsert;

function makeMockContext() {
	const inserted: EventInsert[] = [];
	const db = {
		insert(table: unknown) {
			if (table !== kernelRuntimeEvents) throw new Error("unexpected table");
			let row: EventInsert | undefined;
			return {
				values(v: EventInsert) {
					row = v;
					inserted.push(v);
					return this;
				},
				onConflictDoNothing() {
					return this;
				},
				returning() {
					return row ? [row] : [];
				},
			};
		},
		select() {
			return {
				from() {
					return {
						where() {
							return { limit: () => [] };
						},
					};
				},
			};
		},
	};
	return { db, inserted } as unknown as {
		db: import("../orpc").BaseContext["db"];
		inserted: EventInsert[];
	};
}

const BASE = {
	organizationId: "org-1",
	conversationId: "home:main",
	runId: "run-abc",
	createdAt: "2026-06-20T00:00:00.000Z",
};

describe("recordHomeAnswerDelta", () => {
	it("inserts a message.delta event with correct shape", async () => {
		const { db, inserted } = makeMockContext();
		await recordHomeAnswerDelta({ db } as never, {
			...BASE,
			delta: "Hello world",
			sequence: 0,
		});
		expect(inserted).toHaveLength(1);
		const ev = inserted[0];
		expect(ev?.kind).toBe("message.delta");
		expect(ev?.organizationId).toBe("org-1");
		expect(ev?.conversationId).toBe("home:main");
		expect(ev?.runId).toBe("run-abc");
		expect(ev?.delta).toBe("Hello world");
		expect(ev?.sequence).toBe(0);
		expect(ev?.childRunId).toBeUndefined();
		expect(ev?.delegatedTediId).toBeUndefined();
	});

	it("sets correct payload metadata", async () => {
		const { db, inserted } = makeMockContext();
		await recordHomeAnswerDelta({ db } as never, {
			...BASE,
			delta: "chunk",
			sequence: 3,
		});
		const payload = inserted[0]?.payload as Record<string, unknown>;
		expect(payload?.role).toBe("assistant");
		expect(payload?.channel).toBe("home");
		const meta = payload?.metadata as Record<string, unknown>;
		expect(meta?.homeSubject).toBe(true);
		expect(meta?.homeRunId).toBe("run-abc");
		expect(meta?.source).toBe("kernelRuntime.answerStream");
	});

	it("produces an idempotent id scoped to the sequence", async () => {
		const { db, inserted } = makeMockContext();
		await recordHomeAnswerDelta({ db } as never, {
			...BASE,
			delta: "first",
			sequence: 0,
		});
		await recordHomeAnswerDelta({ db } as never, {
			...BASE,
			delta: "first",
			sequence: 0,
		});
		// Both calls produce the same id — DB onConflictDoNothing would deduplicate;
		// in the mock both land in inserted[] but the ids are equal.
		expect(inserted[0]?.id).toBe(inserted[1]?.id);

		// Different sequence → different id
		await recordHomeAnswerDelta({ db } as never, {
			...BASE,
			delta: "second",
			sequence: 1,
		});
		expect(inserted[2]?.id).not.toBe(inserted[0]?.id);
	});

	it("keeps re-driven deltas append-only in a distinct stream-attempt namespace", async () => {
		const { db, inserted } = makeMockContext();
		await recordHomeAnswerDelta({ db } as never, {
			...BASE,
			delta: "pre-crash partial",
			sequence: 0,
		});
		await recordHomeAnswerDelta({ db } as never, {
			...BASE,
			delta: "different re-streamed answer",
			sequence: 0,
			streamAttempt: 1,
		});
		await recordHomeAnswerDelta({ db } as never, {
			...BASE,
			delta: "same re-streamed answer replayed",
			sequence: 0,
			streamAttempt: 1,
		});

		expect(inserted).toHaveLength(3);
		expect(inserted[1]?.id).not.toBe(inserted[0]?.id);
		expect(inserted[2]?.id).toBe(inserted[1]?.id);
		expect(inserted[1]?.delta).toBe("different re-streamed answer");
		expect(inserted[1]?.runtimeMetadata).toMatchObject({ streamAttempt: 1 });
		expect(inserted[1]?.payload).toMatchObject({
			metadata: { streamAttempt: 1 },
		});
	});

	it("is fail-soft when the DB throws", async () => {
		const privateText = "private-answer-delta-7919";
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const db = {
			insert() {
				throw new Error(`D1 unavailable for ${privateText}`);
			},
		} as never;
		try {
			await expect(
				recordHomeAnswerDelta({ db } as never, {
					...BASE,
					runId: privateText,
					delta: privateText,
					sequence: 0,
				}),
			).resolves.toBeUndefined();
			expect(warnSpy).toHaveBeenCalledWith({
				component: "kernel.home_live_events",
				event: "answer_delta_insert_failed",
				error: { type: "Error" },
				sequence: 0,
			});
			expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(privateText);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("uses the provided createdAt timestamp", async () => {
		const { db, inserted } = makeMockContext();
		const createdAt = "2026-06-20T12:34:56.789Z";
		await recordHomeAnswerDelta({ db } as never, {
			...BASE,
			delta: "ts",
			sequence: 0,
			createdAt,
		});
		expect(inserted[0]?.createdAt).toBe(createdAt);
	});

	// Integration: the DO's startTurnProgress wires createAnswerDeltaBatcher's
	// `persist` to recordHomeAnswerDelta. This proves durability lands at the
	// immediate-first + BATCH cadence — the first token lands without delay,
	// while later token deltas inside one flush window collapse to one D1 row.
	it("persists the first delta immediately, then one D1 write per flush window", async () => {
		const { db, inserted } = makeMockContext();
		const timers: Array<{ fn: () => void; cleared: boolean }> = [];
		const batcher = createAnswerDeltaBatcher({
			flushIntervalMs: 1_000,
			setTimer: (fn) => {
				const entry = { fn, cleared: false };
				timers.push(entry);
				return entry;
			},
			clearTimer: (handle) => {
				(handle as { cleared: boolean }).cleared = true;
			},
			persist: (chunk, sequence) => {
				void recordHomeAnswerDelta({ db } as never, {
					...BASE,
					delta: chunk,
					sequence,
					createdAt: BASE.createdAt,
				});
			},
		});
		const fireTimer = () => {
			const pending = timers.filter((t) => !t.cleared).pop();
			if (!pending) throw new Error("no pending timer");
			pending.fn();
		};

		// The first token flushes immediately; four later deltas coalesce into the
		// first timed window rather than writing per token.
		for (const token of ["He", "llo", " ", "wor", "ld"]) batcher.push(token);
		fireTimer();
		expect(inserted).toHaveLength(2);
		expect(inserted[0]?.delta).toBe("He");
		expect(inserted[0]?.sequence).toBe(0);
		expect(inserted[1]?.delta).toBe("llo world");
		expect(inserted[1]?.sequence).toBe(1);

		// A second window advances the sequence and writes exactly once more.
		batcher.push("!");
		fireTimer();
		expect(inserted).toHaveLength(3);
		expect(inserted[2]?.sequence).toBe(2);

		// end() drops the trailing partial (message.completed is canonical) — no
		// extra write mis-ordered after commit.
		batcher.push("dropped");
		batcher.end();
		expect(inserted).toHaveLength(3);
	});
});
