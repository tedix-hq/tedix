import { kernelRuntimeEvents } from "@tedix/db/schema";
import { describe, expect, it, vi } from "vite-plus/test";
import { recordHomePhaseEvent } from "./kernel/home-live-events";

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
	return { db, inserted };
}

const BASE = {
	organizationId: "org-1",
	conversationId: "home:main",
	runId: "run-abc",
	createdAt: "2026-09-01T00:00:00.000Z",
} as const;

describe("recordHomePhaseEvent", () => {
	it("persists a message.phase row with the phase data in payload (OS strips unknown top-level keys)", async () => {
		const { db, inserted } = makeMockContext();
		await recordHomePhaseEvent({ db } as never, {
			...BASE,
			sequence: 1,
			phase: "planning",
			detail: "Planning route",
		});
		expect(inserted).toHaveLength(1);
		expect(inserted[0]).toMatchObject({
			kind: "message.phase",
			runId: "run-abc",
			conversationId: "home:main",
			sequence: 1,
			createdAt: BASE.createdAt,
			payload: {
				phase: "planning",
				detail: "Planning route",
				at: BASE.createdAt,
			},
		});
		expect(inserted[0]?.id).toBe(
			"home:org-1:event:message.phase:home:main:run-abc:phase:1",
		);
	});

	it("omits detail when absent and is fail-soft when the DB throws", async () => {
		const { db, inserted } = makeMockContext();
		await recordHomePhaseEvent({ db } as never, {
			...BASE,
			sequence: 2,
			phase: "delegating",
		});
		expect(inserted[0]?.payload).not.toHaveProperty("detail");
		const privateText = "private-phase-detail-7919";
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await expect(
				recordHomePhaseEvent(
					{
						db: {
							insert() {
								throw new Error(`D1 unavailable for ${privateText}`);
							},
						},
					} as never,
					{
						...BASE,
						runId: privateText,
						detail: privateText,
						sequence: 3,
						phase: "finalizing",
					},
				),
			).resolves.toBeUndefined();
			expect(warnSpy).toHaveBeenCalledWith({
				component: "kernel.home_live_events",
				event: "phase_insert_failed",
				error: { type: "Error" },
				phase: "finalizing",
			});
			expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(privateText);
		} finally {
			warnSpy.mockRestore();
		}
	});
});
