import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	workAttempts,
	workEvents,
	workItems,
	workAttemptSteps,
	workAttemptMessages,
	workItemComments,
} from "../../schema/work-items";
import {
	workBudgetReservations,
	workResourceReservations,
	workInteractions,
} from "../../schema/work-factory";
import { heartbeatWorkItemAttempt, settleWorkItemAttempt } from "./attempts";
import { completeWorkItem } from "./crud";
import {
	appendWorkAttemptSteps,
	listWorkAttemptSteps,
	sendWorkAttemptMessage,
} from "./attempt-steps";

const start = "2026-10-01T00:00:00.000Z";
const expiry = "2026-10-01T00:05:00.000Z";
const caller = {
	orgId: "org",
	workItemId: "work",
	attemptId: "attempt",
	executor: { type: "external_agent" as const, id: "agent" },
	sessionId: "session",
	externalSessionKey: "codex:session",
};
const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
async function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(
			workItems,
			workAttempts,
			workAttemptSteps,
			workAttemptMessages,
			workItemComments,
			workEvents,
			workBudgetReservations,
			workResourceReservations,
			workInteractions,
		),
	);
	const db = createDbQueryClient(createD1Facade(sqlite));
	await db.insert(workItems).values({
		id: "work",
		orgId: "org",
		title: "Lease fixture",
		disposition: "accepted",
		createdAt: start,
	});
	await db.insert(workAttempts).values({
		id: "attempt",
		orgId: "org",
		workItemId: "work",
		admissionId: "admission",
		executorType: "external_agent",
		executorId: "agent",
		executorSessionId: "session",
		externalSessionKey: "codex:session",
		runtimeState: "running",
		attemptNumber: 1,
		startedAt: start,
		heartbeatAt: start,
		expiresAt: expiry,
	});
	await db.insert(workResourceReservations).values({
		id: "resource",
		orgId: "org",
		workItemId: "work",
		admissionId: "admission",
		poolId: "pool",
		poolVersion: 1,
		resourceKey: "executor",
		quantity: 1,
		reservedAt: start,
		expiresAt: expiry,
	});
	await db.insert(workBudgetReservations).values({
		id: "budget",
		orgId: "org",
		workItemId: "work",
		admissionId: "admission",
		envelopeId: "envelope",
		envelopeVersion: 1,
		amountMicros: 1000,
		reservedAt: start,
		expiresAt: expiry,
	});
	return { db, sqlite };
}

describe("Attempt lease write fences", () => {
	it.each(["unread", "delivered", "applied", "failed"])(
		"accounts for a %s follow-up when settlement wins the race with another turn",
		async (state) => {
			const { db } = await fixture();
			const at = "2026-10-01T00:01:00.000Z";
			await appendWorkAttemptSteps(db, {
				...caller,
				steps: [
					{ seq: 7, at: Date.parse(at), kind: "message", text: "Final answer" },
				],
				at,
			});
			const message = await sendWorkAttemptMessage(db, {
				orgId: caller.orgId,
				workItemId: caller.workItemId,
				kind: "follow_up",
				body: "Also check pricing",
				sender: { type: "user", id: "owner" },
				at,
			});
			expect(message).not.toBeNull();
			if (state !== "unread")
				await appendWorkAttemptSteps(db, {
					...caller,
					steps: [],
					...(state === "applied" ? { appliedMessageIds: [message!.id] } : {}),
					at,
				});
			await settleWorkItemAttempt(db, {
				...caller,
				outcome: state === "failed" ? "failed" : "succeeded",
				settledAt: at,
			});
			const log = await listWorkAttemptSteps(db, {
				orgId: caller.orgId,
				workItemId: caller.workItemId,
				at,
			});
			expect(log.live).toBe(false);
			expect(log.steps.map((step) => [step.seq, step.kind, step.text])).toEqual(
				[
					[7, "message", "Final answer"],
					...(state === "applied"
						? []
						: [
								[
									8,
									"error",
									"Follow-up not applied: the run ended before another turn could start.",
								],
							]),
				],
			);
			expect(log.messages[0]?.appliedAt !== null).toBe(state === "applied");
			expect(
				await sendWorkAttemptMessage(db, {
					orgId: caller.orgId,
					workItemId: caller.workItemId,
					kind: "follow_up",
					body: "Too late",
					sender: { type: "user", id: "owner" },
					at,
				}),
			).toBeNull();
		},
	);

	it.each(["at expiry", "after expiry", "superseded", "wrong session"])(
		"rejects heartbeat, settle and complete: %s",
		async (scenario) => {
			const { db, sqlite } = await fixture();
			let at = scenario === "at expiry" ? expiry : "2026-10-01T00:05:00.001Z";
			if (scenario === "superseded") {
				at = start;
				// Also exercise the fence if historical data retained an active predecessor.
				sqlite.exec("DROP INDEX uniq_work_attempt_active");
				await db.insert(workAttempts).values({
					id: "successor",
					orgId: "org",
					workItemId: "work",
					executorType: "external_agent",
					executorId: "other",
					runtimeState: "running",
					attemptNumber: 2,
					startedAt: at,
					heartbeatAt: at,
					expiresAt: expiry,
				});
			}
			const input =
				scenario === "wrong session"
					? { ...caller, sessionId: "other" }
					: caller;
			if (scenario === "wrong session") at = start;
			const before = await db.select().from(workAttempts);
			const resources = await db.select().from(workResourceReservations);
			const budgets = await db.select().from(workBudgetReservations);
			await expect(
				heartbeatWorkItemAttempt(db, {
					...input,
					heartbeatAt: at,
					leaseTtlMs: 300_000,
				}),
			).rejects.toMatchObject({ code: "STALE_ATTEMPT" });
			await expect(
				settleWorkItemAttempt(db, {
					...input,
					settledAt: at,
					outcome: "succeeded",
				}),
			).rejects.toMatchObject({ code: "STALE_ATTEMPT" });
			await expect(
				completeWorkItem(db, {
					orgId: "org",
					workItemId: "work",
					actor: {
						type: "external_agent",
						id: "agent",
						sessionId: input.sessionId,
					},
					completedAt: at,
				}),
			).rejects.toMatchObject({ code: "NOT_READY" });
			expect(await db.select().from(workAttempts)).toEqual(before);
			expect(await db.select().from(workResourceReservations)).toEqual(
				resources,
			);
			expect(await db.select().from(workBudgetReservations)).toEqual(budgets);
			expect(await db.select().from(workEvents)).toEqual([]);
			expect((await db.select().from(workItems))[0]?.disposition).toBe(
				"accepted",
			);
		},
	);
	it("settles inaccessible verification as finished without authorizing completion", async () => {
		const { db, sqlite } = await fixture();
		sqlite.exec(
			"UPDATE work_attempts SET attempt_number = 2 WHERE id = 'attempt'",
		);
		await db.insert(workAttempts).values({
			id: "earlier",
			orgId: "org",
			workItemId: "work",
			executorType: "human",
			executorId: "owner",
			attemptNumber: 1,
			startedAt: "2026-09-30T23:00:00.000Z",
			heartbeatAt: start,
			finishedAt: start,
			runtimeState: "expired",
			outcome: "expired",
		});
		const settled = await settleWorkItemAttempt(db, {
			...caller,
			settledAt: "2026-10-01T00:01:00.000Z",
			outcome: "landed_unverified",
			metadata: {
				runnerMetrics: {
					tokensIn: null,
					tokensOut: null,
					firstAdmittedAt: start,
					admissionCount: 99,
					executorId: "spoof",
				},
			},
		});
		expect(settled.attempt).toMatchObject({
			runtimeState: "finished",
			outcome: "landed_unverified",
			finishedAt: "2026-10-01T00:01:00.000Z",
			metadata: {
				runnerMetrics: {
					tokensIn: null,
					tokensOut: null,
					executorId: "agent",
					executorType: "external_agent",
					firstAdmittedAt: "2026-09-30T23:00:00.000Z",
					admissionCount: 2,
					wallTimeMs: 3_660_000,
				},
			},
		});
		expect((await db.select().from(workResourceReservations))[0]?.state).toBe(
			"released",
		);
		expect(
			(await db.select().from(workBudgetReservations))[0]?.consumedMicros,
		).toBe(1000);
		await expect(
			completeWorkItem(db, {
				orgId: "org",
				workItemId: "work",
				actor: { type: "external_agent", id: "agent", sessionId: "session" },
				completedAt: "2026-10-01T00:02:00.000Z",
			}),
		).rejects.toThrow();
		expect((await db.select().from(workItems))[0]?.disposition).toBe(
			"accepted",
		);
	});
	it("renews and settles a live Attempt, then completes after its lease deadline", async () => {
		const { db } = await fixture();
		const renewed = await heartbeatWorkItemAttempt(db, {
			...caller,
			heartbeatAt: "2026-10-01T00:04:00.000Z",
			leaseTtlMs: 300_000,
		});
		expect(renewed.expiresAt).toBe("2026-10-01T00:09:00.000Z");
		const settled = await settleWorkItemAttempt(db, {
			...caller,
			settledAt: "2026-10-01T00:08:00.000Z",
			outcome: "succeeded",
		});
		expect(settled.attempt.outcome).toBe("succeeded");
		expect(
			(
				await completeWorkItem(db, {
					orgId: "org",
					workItemId: "work",
					actor: { type: "external_agent", id: "agent", sessionId: "session" },
					completedAt: "2026-10-01T00:10:00.000Z",
				})
			).disposition,
		).toBe("completed");
	});
	it("atomically corrects a design classification only for the fenced implementation attempt", async () => {
		const { db, sqlite } = await fixture();
		sqlite.exec("UPDATE work_items SET work_kind='design' WHERE id='work'");
		await settleWorkItemAttempt(db, {
			...caller,
			settledAt: "2026-10-01T00:01:00.000Z",
			outcome: "succeeded",
		});
		const [before] = await db.select().from(workItems);
		const params = {
			orgId: "org",
			workItemId: "work",
			actor: {
				type: "external_agent" as const,
				id: "agent",
				sessionId: "session",
			},
			expectedWorkItemVersion: before!.version,
			completedAt: "2026-10-01T00:02:00.000Z",
		};
		await expect(
			completeWorkItem(db, {
				...params,
				reclassifiedImplementationAttemptId: "different",
			}),
		).rejects.toThrow();
		expect((await db.select().from(workItems))[0]).toMatchObject({
			workKind: "design",
			disposition: "accepted",
		});
		await expect(
			completeWorkItem(db, {
				...params,
				reclassifiedImplementationAttemptId: "attempt",
			}),
		).resolves.toMatchObject({ workKind: "coding", disposition: "completed" });
	});
	it("refuses completion from a success recorded after the lease expired", async () => {
		const { db, sqlite } = await fixture();
		sqlite
			.prepare(
				"UPDATE work_attempts SET runtime_state='finished',outcome='succeeded',finished_at=? WHERE id='attempt'",
			)
			.run(expiry);
		await expect(
			completeWorkItem(db, {
				orgId: "org",
				workItemId: "work",
				actor: { type: "external_agent", id: "agent", sessionId: "session" },
				completedAt: "2026-10-01T00:10:00.000Z",
			}),
		).rejects.toMatchObject({ code: "NOT_READY" });
	});
	it("refuses completion by the session of an older succeeded Attempt", async () => {
		const { db } = await fixture();
		await settleWorkItemAttempt(db, {
			...caller,
			settledAt: "2026-10-01T00:01:00.000Z",
			outcome: "succeeded",
		});
		await db.insert(workAttempts).values({
			id: "successor",
			orgId: "org",
			workItemId: "work",
			executorType: "external_agent",
			executorId: "other",
			runtimeState: "expired",
			outcome: "expired",
			attemptNumber: 2,
			startedAt: start,
			heartbeatAt: start,
			expiresAt: expiry,
		});
		await expect(
			completeWorkItem(db, {
				orgId: "org",
				workItemId: "work",
				actor: { type: "external_agent", id: "agent", sessionId: "session" },
				completedAt: "2026-10-01T00:10:00.000Z",
			}),
		).rejects.toMatchObject({ code: "NOT_READY" });
	});
});
