import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { kernelRequests, kernelRequestEvents } from "../schema/kernel-requests";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	getKernelRequest,
	listKernelRequestEvents,
	receiveKernelRequest,
	transitionKernelRequest,
	listDueKernelRequests,
} from "./kernel-requests";

const now = "2026-10-17T10:00:00.000Z";
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(schemaDdl(kernelRequests));
	sqlite.exec(schemaDdl(kernelRequestEvents));
	return {
		sqlite,
		db: createDbQueryClient(createD1Facade(sqlite, { maxBoundParams: 100 })),
	};
}
const scope = {
	organizationId: "org-example",
	ownerUserId: "user-ada",
	id: "request-one",
};
const snapshot = {
	state: "received" as const,
	workItemId: null,
	attemptId: null,
	briefRevision: 0,
	checks: [],
	acceptanceKey: null,
	observations: [],
	outcome: null,
	delivery: null,
	learning: null,
};
const intake = {
	...scope,
	sourceKind: "home" as const,
	sourceId: "run-one",
	conversationId: "conversation-one",
	snapshot,
	nextOwner: "kernel",
	nextAction: "file",
	nextDueAt: now,
	lastEventId: "received-one",
	createdAt: now,
	updatedAt: now,
};

describe("kernel request persistence", () => {
	it("deduplicates intake by source and preserves its original owner and timer", async () => {
		const { db } = fixture();
		const first = await receiveKernelRequest(db, intake);
		const replay = await receiveKernelRequest(db, {
			...intake,
			id: "duplicate",
			lastEventId: "duplicate-event",
		});
		expect(replay).toEqual(first);
		expect(await listKernelRequestEvents(db, scope)).toHaveLength(1);
		expect(
			await listDueKernelRequests(db, {
				organizationId: scope.organizationId,
				now,
				limit: 50,
			}),
		).toHaveLength(1);
	});
	it("fences concurrent and replayed transitions with atomic event history", async () => {
		const { db } = fixture();
		await receiveKernelRequest(db, intake);
		const transition = {
			...scope,
			expectedVersion: 1,
			eventId: "filed-one",
			snapshot: {
				...snapshot,
				state: "filed" as const,
				workItemId: "work-one",
			},
			nextOwner: "kernel",
			nextAction: "brief",
			nextDueAt: now,
			now,
		};
		expect((await transitionKernelRequest(db, transition))?.version).toBe(2);
		expect(
			await transitionKernelRequest(db, { ...transition, eventId: "loser" }),
		).toBeUndefined();
		expect(await transitionKernelRequest(db, transition)).toBeUndefined();
		expect((await listKernelRequestEvents(db, scope)).map((e) => e.id)).toEqual(
			["received-one", "filed-one"],
		);
	});
	it("scopes reads, CAS, event history and due scans to the tenant and private owner", async () => {
		const { db } = fixture();
		await receiveKernelRequest(db, intake);
		for (const wrong of [
			{ ...scope, organizationId: "org-other" },
			{ ...scope, ownerUserId: "user-grace" },
		]) {
			expect(await getKernelRequest(db, wrong)).toBeUndefined();
			expect(await listKernelRequestEvents(db, wrong)).toEqual([]);
			expect(
				await transitionKernelRequest(db, {
					...wrong,
					expectedVersion: 1,
					eventId: "bad",
					snapshot,
					nextOwner: "kernel",
					nextAction: "file",
					nextDueAt: now,
					now,
				}),
			).toBeUndefined();
		}
		expect(
			await listDueKernelRequests(db, {
				organizationId: "org-other",
				now,
				limit: 50,
			}),
		).toEqual([]);
	});
	it("rejects ownerless and untimed nonterminal requests", async () => {
		const { db } = fixture();
		for (const patch of [
			{ nextOwner: "" },
			{ nextAction: "" },
			{ nextDueAt: null },
			{ nextDueAt: "invalid" },
		])
			await expect(
				receiveKernelRequest(db, { ...intake, ...patch }),
			).rejects.toThrow();
	});
	it("does not suppress event identity collisions from another request", async () => {
		const { db } = fixture();
		await receiveKernelRequest(db, intake);
		await receiveKernelRequest(db, {
			...intake,
			id: "request-two",
			sourceId: "run-two",
			lastEventId: "event-two",
		});
		await expect(
			transitionKernelRequest(db, {
				...scope,
				expectedVersion: 1,
				eventId: "event-two",
				snapshot,
				nextOwner: "kernel",
				nextAction: "file",
				nextDueAt: now,
				now,
			}),
		).rejects.toThrow();
		expect((await getKernelRequest(db, scope))?.version).toBe(1);
	});
	it("rolls back the state when appending the event fails", async () => {
		const { db, sqlite } = fixture();
		await receiveKernelRequest(db, intake);
		sqlite.exec(
			"CREATE TRIGGER reject_event BEFORE INSERT ON kernel_request_events BEGIN SELECT RAISE(ABORT,'simulated crash'); END",
		);
		await expect(
			transitionKernelRequest(db, {
				...scope,
				expectedVersion: 1,
				eventId: "crash",
				snapshot,
				nextOwner: "kernel",
				nextAction: "file",
				nextDueAt: now,
				now,
			}),
		).rejects.toThrow();
		expect((await getKernelRequest(db, scope))?.version).toBe(1);
	});
});
