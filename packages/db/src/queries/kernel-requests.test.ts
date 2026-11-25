import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { kernelRequests, kernelRequestEvents } from "../schema/kernel-requests";
import { workItems, workAttempts } from "../schema/work-items";
import { kernelRuntimeRuns } from "../schema/cognitive-runtime";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	getKernelRequest,
	listKernelRequestEvents,
	receiveKernelRequest,
	transitionKernelRequest,
	transitionKernelRequests,
	listDueKernelRequests,
	listDueKernelRequestsWithHomeRuns,
} from "./kernel-requests";

const now = "2026-10-17T10:00:00.000Z";
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(schemaDdl(kernelRequests));
	sqlite.exec(schemaDdl(kernelRequestEvents));
	sqlite.exec(schemaDdl(kernelRuntimeRuns, workItems, workAttempts));
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
		await receiveKernelRequest(db, {
			...intake,
			id: "request-two",
			sourceId: "run-two",
			lastEventId: "received-two",
		});
		await transitionKernelRequests(db, [
			{ ...transition, eventId: "stale-batch-writer" },
			{ ...transition, id: "request-two", eventId: "filed-two" },
		]);
		expect((await listKernelRequestEvents(db, scope)).map((e) => e.id)).toEqual(
			["received-one", "filed-one"],
		);
		expect(
			(await listKernelRequestEvents(db, { ...scope, id: "request-two" })).map(
				(e) => e.id,
			),
		).toEqual(["received-two", "filed-two"]);
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
	it("joins only scoped Home sources without dropping missing sources or changing the due page", async () => {
		const { db } = fixture();
		await receiveKernelRequest(db, intake);
		await db.insert(kernelRuntimeRuns).values({
			id: intake.sourceId,
			organizationId: "org-other",
			conversationId: "private-other",
			status: "completed",
			metadata: { privateField: "not-visible" },
			createdAt: now,
			updatedAt: now,
		});
		for (const [sourceKind, sourceId, nextDueAt] of [
			["home", "matching-run", now],
			["agent_session_request", "local-source", now],
			["home", "future-run", "2026-10-18T10:00:00.000Z"],
			["home", "closed-run", null],
		] as const)
			await db.insert(kernelRequests).values({
				...intake,
				id: sourceId,
				sourceKind,
				sourceId,
				nextDueAt,
				lastEventId: `${sourceId}:1`,
			});
		await db.insert(kernelRuntimeRuns).values({
			id: "matching-run",
			organizationId: scope.organizationId,
			conversationId: "conversation-one",
			status: "running",
			metadata: { workItemId: "work-one" },
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(workItems).values({
			id: "work-one",
			orgId: scope.organizationId,
			title: "Example work",
			createdAt: now,
		});
		for (const [id, orgId, startedAt] of [
			["attempt-a", scope.organizationId, now],
			["attempt-z", scope.organizationId, now],
			["attempt-other", "org-other", "2026-10-18T10:00:00.000Z"],
		] as const)
			await db.insert(workAttempts).values({
				id,
				orgId,
				workItemId: "work-one",
				executorType: "tedi",
				executorId: "example",
				attemptNumber: id === "attempt-a" ? 1 : 2,
				startedAt,
				heartbeatAt: startedAt,
				runtimeState: "finished",
				outcome: "succeeded",
			});
		const params = { organizationId: scope.organizationId, now, limit: 2 };
		const sources = await listDueKernelRequestsWithHomeRuns(db, params);
		expect(sources.map((s) => s.request)).toEqual(
			await listDueKernelRequests(db, params),
		);
		expect(sources[0]?.homeRun).toBeNull();
		expect(sources[0]?.work).toBeNull();
		expect(sources[0]?.attempt).toBeNull();
		expect(sources[1]?.work?.id).toBe("work-one");
		expect(sources[1]?.attempt).toEqual({
			id: "attempt-z",
			outcome: "succeeded",
		});
		expect(sources[1]?.homeRun).toMatchObject({
			id: "matching-run",
			organizationId: scope.organizationId,
			metadata: { workItemId: "work-one" },
		});
		const all = await listDueKernelRequestsWithHomeRuns(db, {
			...params,
			limit: 50,
		});
		expect(all.find((s) => s.request.id === scope.id)?.homeRun).toBeNull();
		expect(all).toHaveLength(3);
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
