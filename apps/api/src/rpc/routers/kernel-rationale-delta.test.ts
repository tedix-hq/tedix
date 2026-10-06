import { kernelRuntimeEvents } from "@tedix/db/schema";
import { describe, expect, it, vi } from "vite-plus/test";
import { createAnswerDeltaBatcher } from "../../kernel/answer-delta-batcher";
import { recordHomeRationaleDelta } from "./kernel/home-live-events";

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

describe("recordHomeRationaleDelta", () => {
	it("inserts a message.reasoning event on the PARENT run only", async () => {
		const { db, inserted } = makeMockContext();
		await recordHomeRationaleDelta({ db } as never, {
			...BASE,
			delta: "Routing to the GitHub-owning tedi",
			sequence: 0,
		});
		expect(inserted).toHaveLength(1);
		const ev = inserted[0];
		expect(ev?.kind).toBe("message.reasoning");
		expect(ev?.runId).toBe("run-abc");
		expect(ev?.delta).toBe("Routing to the GitHub-owning tedi");
		expect(ev?.sequence).toBe(0);
		// Never a child-ledger row: the child tool/answer stream is its own
		// ledger (`tedi_runtime_events`) and is untouched by this path.
		expect(ev?.childRunId).toBeUndefined();
		expect(ev?.delegatedTediId).toBeUndefined();
	});

	it("marks the row provisional and is NOT an assistant message", async () => {
		const { db, inserted } = makeMockContext();
		await recordHomeRationaleDelta({ db } as never, {
			...BASE,
			delta: "chunk",
			sequence: 2,
		});
		const payload = inserted[0]?.payload as Record<string, unknown>;
		expect(payload?.provisional).toBe(true);
		expect(payload?.channel).toBe("home");
		// No `role: assistant` — this row must never be mistaken for the answer.
		expect(payload?.role).toBeUndefined();
		const meta = payload?.metadata as Record<string, unknown>;
		expect(meta?.source).toBe("kernelRuntime.rationaleStream");
	});

	it("is idempotent by sequence", async () => {
		const { db, inserted } = makeMockContext();
		await recordHomeRationaleDelta({ db } as never, {
			...BASE,
			delta: "same",
			sequence: 0,
		});
		await recordHomeRationaleDelta({ db } as never, {
			...BASE,
			delta: "same",
			sequence: 0,
		});
		await recordHomeRationaleDelta({ db } as never, {
			...BASE,
			delta: "next",
			sequence: 1,
		});
		expect(inserted[0]?.id).toBe(inserted[1]?.id);
		expect(inserted[2]?.id).not.toBe(inserted[0]?.id);
	});

	it("never throws when the insert fails (fail-soft)", async () => {
		const privateText = "private-rationale-delta-7919";
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const db = {
			insert() {
				throw new Error(`D1 unavailable for ${privateText}`);
			},
		} as never;
		try {
			await expect(
				recordHomeRationaleDelta({ db } as never, {
					...BASE,
					runId: privateText,
					delta: privateText,
					sequence: 0,
				}),
			).resolves.toBeUndefined();
			expect(warnSpy).toHaveBeenCalledWith({
				component: "kernel.home_live_events",
				event: "rationale_delta_insert_failed",
				error: { type: "Error" },
				sequence: 0,
			});
			expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(privateText);
		} finally {
			warnSpy.mockRestore();
		}
	});
});

describe("rationale write amplification", () => {
	it("coalesces a token-by-token rationale into a handful of rows", async () => {
		// The DO pushes rationale deltas through the SAME batcher the answer
		// deltas use: first chunk immediate, then one flush per ~1s window.
		// `listKernelRuntimeEvents` pages by OFFSET, so rows_read grows
		// quadratically in rows-per-run — a per-token row would be a write storm.
		let now = 0;
		const timers: Array<{ fn: () => void; at: number }> = [];
		const rows: string[] = [];
		const batcher = createAnswerDeltaBatcher({
			flushIntervalMs: 1_000,
			now: () => now,
			setTimer: (fn, delayMs) => {
				const handle = { fn, at: now + delayMs };
				timers.push(handle);
				return handle;
			},
			clearTimer: (handle) => {
				const index = timers.indexOf(handle as (typeof timers)[number]);
				if (index >= 0) timers.splice(index, 1);
			},
			persist: (chunk) => rows.push(chunk),
		});
		const tokens = "The request is ambiguous between two projects".split(" ");
		for (const token of tokens) batcher.push(`${token} `);
		// One window elapses.
		now += 1_000;
		const due = timers.splice(0, timers.length);
		for (const timer of due) timer.fn();
		// 40+ tokens, TWO rows: the immediate first flush plus one window.
		expect(rows).toHaveLength(2);
		expect(rows.join("")).toBe(tokens.map((t) => `${t} `).join(""));
	});
});
