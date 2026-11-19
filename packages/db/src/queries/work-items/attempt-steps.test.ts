import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	workAttemptMessages,
	workAttemptSteps,
	workAttempts,
	workItems,
} from "../../schema/work-items";
import {
	appendWorkAttemptSteps,
	listWorkAttemptSteps,
	sendWorkAttemptMessage,
} from "./attempt-steps";

const start = "2026-10-01T00:00:00.000Z";
const during = "2026-10-01T00:01:00.000Z";
const expiry = "2026-10-01T00:05:00.000Z";
const runner = {
	orgId: "org",
	workItemId: "work",
	attemptId: "attempt",
	executor: { type: "external_agent" as const, id: "agent" },
	sessionId: "session",
	externalSessionKey: "codex:session",
	at: during,
};
const owner = { type: "user" as const, id: "owner" };
const step = (seq: number, text = `step ${seq}`) => ({
	seq,
	at: 1_000 + seq,
	kind: "message" as const,
	text,
});
const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
async function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(workItems, workAttempts, workAttemptSteps, workAttemptMessages),
	);
	const db = createDbQueryClient(createD1Facade(sqlite));
	await db.insert(workItems).values({
		id: "work",
		orgId: "org",
		title: "Run log fixture",
		disposition: "accepted",
		createdAt: start,
	});
	await db.insert(workAttempts).values({
		id: "attempt",
		orgId: "org",
		workItemId: "work",
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
	return { db, sqlite };
}

describe("run steps and steering messages", () => {
	it("stores each seq once, so a retried report adds nothing", async () => {
		const { db } = await fixture();
		// More than one insert chunk, to cover the bound-parameter split.
		const steps = Array.from({ length: 30 }, (_, index) => step(index));
		await expect(
			appendWorkAttemptSteps(db, { ...runner, steps }),
		).resolves.toEqual({ accepted: 30, pending: [] });
		await expect(
			appendWorkAttemptSteps(db, {
				...runner,
				steps: [step(29, "changed"), step(30)],
			}),
		).resolves.toMatchObject({ accepted: 1 });
		const listed = await listWorkAttemptSteps(db, {
			orgId: "org",
			workItemId: "work",
			afterSeq: 28,
			at: during,
		});
		expect(listed.steps.map(({ seq, text }) => [seq, text])).toEqual([
			[29, "step 29"],
			[30, "step 30"],
		]);
	});

	it("returns a message until the runner reports it applied", async () => {
		const { db } = await fixture();
		const followUp = await sendWorkAttemptMessage(db, {
			orgId: "org",
			workItemId: "work",
			kind: "follow_up",
			body: "Also update the guide",
			sender: owner,
			at: "2026-10-01T00:00:30.000Z",
		});
		const stop = await sendWorkAttemptMessage(db, {
			orgId: "org",
			workItemId: "work",
			kind: "stop",
			body: "",
			sender: owner,
			at: "2026-10-01T00:00:40.000Z",
		});
		const first = await appendWorkAttemptSteps(db, { ...runner, steps: [] });
		expect(first.pending.map((message) => message.id)).toEqual([
			followUp!.id,
			stop!.id,
		]);
		expect(first.pending[0]).toMatchObject({
			deliveredAt: during,
			appliedAt: null,
			senderId: "owner",
		});
		// The first answer may have been lost: the next report gets both again,
		// and the time of the first hand-over is kept.
		const retry = await appendWorkAttemptSteps(db, {
			...runner,
			steps: [],
			at: "2026-10-01T00:01:30.000Z",
		});
		expect(retry.pending).toEqual(first.pending);
		// A message acknowledged in a report is not part of that report's answer.
		const second = await appendWorkAttemptSteps(db, {
			...runner,
			steps: [step(0)],
			appliedMessageIds: [followUp!.id],
			at: "2026-10-01T00:02:00.000Z",
		});
		expect(second.accepted).toBe(1);
		expect(second.pending.map((message) => message.id)).toEqual([stop!.id]);
		const third = await appendWorkAttemptSteps(db, {
			...runner,
			steps: [],
			appliedMessageIds: [stop!.id],
			at: "2026-10-01T00:02:30.000Z",
		});
		expect(third).toEqual({ accepted: 0, pending: [] });
		const { messages } = await listWorkAttemptSteps(db, {
			orgId: "org",
			workItemId: "work",
			at: during,
		});
		expect(
			messages.map(({ kind, deliveredAt, appliedAt }) => ({
				kind,
				deliveredAt,
				appliedAt,
			})),
		).toEqual([
			{
				kind: "follow_up",
				deliveredAt: during,
				appliedAt: "2026-10-01T00:02:00.000Z",
			},
			{
				kind: "stop",
				deliveredAt: during,
				appliedAt: "2026-10-01T00:02:30.000Z",
			},
		]);
	});

	it("carries unapplied messages to the same session's next Attempt after an interruption", async () => {
		const { db, sqlite } = await fixture();
		const send = (body: string, at: string) =>
			sendWorkAttemptMessage(db, {
				orgId: "org",
				workItemId: "work",
				kind: "follow_up",
				body,
				sender: owner,
				at,
			});
		const applied = await send("Applied before the interruption", start);
		const waiting = await send(
			"Received, not applied",
			"2026-10-01T00:00:10.000Z",
		);
		const unseen = await send("Never received", "2026-10-01T00:00:50.000Z");
		await appendWorkAttemptSteps(db, {
			...runner,
			steps: [],
			appliedMessageIds: [applied!.id],
			at: "2026-10-01T00:00:20.000Z",
		});
		const successor = (id: string, session: string, attemptNumber: number) =>
			db.insert(workAttempts).values({
				id,
				orgId: "org",
				workItemId: "work",
				executorType: "external_agent",
				executorId: "agent",
				executorSessionId: "session",
				externalSessionKey: session,
				runtimeState: "running",
				attemptNumber,
				startedAt: during,
				heartbeatAt: during,
				expiresAt: expiry,
			});
		const resumed = { ...runner, attemptId: "resumed" };
		const end = (id: string, outcome: string) =>
			sqlite.exec(
				`UPDATE work_attempts SET runtime_state='${outcome === "expired" ? "expired" : "finished"}', outcome='${outcome}', finished_at='${during}' WHERE id='${id}'`,
			);

		// A run that ended on its own verdict hands nothing on.
		end("attempt", "cancelled");
		await successor("resumed", "codex:session", 2);
		await expect(
			appendWorkAttemptSteps(db, { ...resumed, steps: [] }),
		).resolves.toEqual({ accepted: 0, pending: [] });

		// An interrupted run does, to the same agent session only.
		sqlite.exec(
			"UPDATE work_attempts SET outcome='expired' WHERE id='attempt'",
		);
		end("resumed", "failed");
		await successor("other", "codex:other-session", 3);
		await expect(
			appendWorkAttemptSteps(db, {
				...runner,
				attemptId: "other",
				externalSessionKey: "codex:other-session",
				steps: [],
			}),
		).resolves.toEqual({ accepted: 0, pending: [] });
		end("other", "failed");
		await successor("again", "codex:session", 4);
		const again = { ...runner, attemptId: "again" };
		const carried = await appendWorkAttemptSteps(db, { ...again, steps: [] });
		expect(carried.pending.map((message) => message.id)).toEqual([
			waiting!.id,
			unseen!.id,
		]);
		// Reporting them under the new Attempt settles them for good.
		await expect(
			appendWorkAttemptSteps(db, {
				...again,
				steps: [],
				appliedMessageIds: [waiting!.id, unseen!.id],
			}),
		).resolves.toEqual({ accepted: 0, pending: [] });
		expect(
			(await db.select().from(workAttemptMessages)).filter(
				(message) => message.appliedAt === null,
			),
		).toEqual([]);
	});

	it.each([
		"expired lease",
		"superseded",
		"wrong session",
		"other executor",
		"other organization",
		"settled",
	])(
		"refuses a report from a stale or foreign Attempt: %s",
		async (scenario) => {
			const { db, sqlite } = await fixture();
			await sendWorkAttemptMessage(db, {
				orgId: "org",
				workItemId: "work",
				kind: "stop",
				body: "",
				sender: owner,
				at: start,
			});
			let caller: typeof runner = runner;
			if (scenario === "expired lease") caller = { ...runner, at: expiry };
			if (scenario === "wrong session")
				caller = { ...runner, sessionId: "other" };
			if (scenario === "other executor")
				caller = { ...runner, executor: { ...runner.executor, id: "other" } };
			if (scenario === "other organization")
				caller = { ...runner, orgId: "other" };
			if (scenario === "settled")
				sqlite.exec(
					`UPDATE work_attempts SET runtime_state='finished', outcome='succeeded', finished_at='${start}'`,
				);
			if (scenario === "superseded") {
				sqlite.exec("DROP INDEX uniq_work_attempt_active");
				await db.insert(workAttempts).values({
					id: "successor",
					orgId: "org",
					workItemId: "work",
					executorType: "external_agent",
					executorId: "other",
					executorSessionId: "other-session",
					externalSessionKey: "codex:other",
					runtimeState: "running",
					attemptNumber: 2,
					startedAt: start,
					heartbeatAt: start,
					expiresAt: expiry,
				});
			}
			await expect(
				appendWorkAttemptSteps(db, { ...caller, steps: [step(0)] }),
			).rejects.toMatchObject({ code: "STALE_ATTEMPT" });
			expect(await db.select().from(workAttemptSteps)).toEqual([]);
			// The refused caller must not have collected the waiting stop.
			expect(await db.select().from(workAttemptMessages)).toMatchObject([
				{ deliveredAt: null },
			]);
		},
	);

	it("lists the newest Attempt by default and says whether it is live", async () => {
		const { db, sqlite } = await fixture();
		await appendWorkAttemptSteps(db, { ...runner, steps: [step(0, "first")] });
		const read = (attemptId?: string, at = during) =>
			listWorkAttemptSteps(db, {
				orgId: "org",
				workItemId: "work",
				attemptId,
				at,
			});
		await expect(read()).resolves.toMatchObject({
			attemptId: "attempt",
			live: true,
		});
		await expect(read(undefined, expiry)).resolves.toMatchObject({
			live: false,
		});
		sqlite.exec(
			`UPDATE work_attempts SET runtime_state='finished', outcome='succeeded', finished_at='${during}'`,
		);
		await expect(read()).resolves.toMatchObject({ live: false });
		await expect(
			sendWorkAttemptMessage(db, {
				orgId: "org",
				workItemId: "work",
				kind: "follow_up",
				body: "Too late",
				sender: owner,
				at: during,
			}),
		).resolves.toBeNull();
		await db.insert(workAttempts).values({
			id: "second",
			orgId: "org",
			workItemId: "work",
			executorType: "external_agent",
			executorId: "agent",
			executorSessionId: "session-2",
			externalSessionKey: "codex:session-2",
			runtimeState: "running",
			attemptNumber: 2,
			startedAt: during,
			heartbeatAt: during,
			expiresAt: expiry,
		});
		await expect(read()).resolves.toMatchObject({
			attemptId: "second",
			live: true,
			steps: [],
		});
		await expect(read("attempt")).resolves.toMatchObject({
			attemptId: "attempt",
			live: false,
			steps: [{ text: "first" }],
		});
		await expect(
			listWorkAttemptSteps(db, {
				orgId: "other",
				workItemId: "work",
				at: during,
			}),
		).resolves.toEqual({
			attemptId: null,
			live: false,
			steps: [],
			messages: [],
		});
		await expect(read("missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});
