import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import {
	kernelConversations,
	kernelRuntimeEvents,
	kernelRuntimeRuns,
} from "../schema/cognitive-runtime";
import {
	runtimeSubmissionAttempts,
	runtimeSubmissions,
} from "../schema/runtime-submissions";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { getKernelConversation } from "./kernel-conversations";
import {
	KernelRuntimeEventConflictError,
	listKernelRuntimeEvents,
} from "./kernel-runtime-events";
import {
	getKernelRuntimeRun,
	openKernelRuntimeTurn,
} from "./kernel-runtime-runs";
import { admitSubmission } from "./runtime-submissions/admission";
import { startAttempt } from "./runtime-submissions/attempts";
import { getSubmissionById } from "./runtime-submissions/read-models";

const CREATED_AT = "2026-10-11T10:00:00.000Z";

function setup() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(
			kernelRuntimeRuns,
			kernelRuntimeEvents,
			kernelConversations,
			runtimeSubmissions,
			runtimeSubmissionAttempts,
		),
	);
	return createDbClient(createD1Facade(sqlite));
}

function turnParams(options?: {
	causeEventId?: string;
	replay?: boolean;
	attemptId?: string;
}) {
	return {
		run: {
			id: "run-1",
			organizationId: "org-1",
			conversationId: "home:topic",
			status: "running" as const,
			createdAt: CREATED_AT,
			updatedAt: CREATED_AT,
		},
		events: [
			{
				id: "evt-received",
				organizationId: "org-1",
				kind: "message.received" as const,
				conversationId: "home:topic",
				runId: "run-1",
				messageId: "run-1:input",
				payload: { role: "user", content: "hello" },
				createdAt: CREATED_AT,
			},
			{
				id: "evt-started",
				organizationId: "org-1",
				kind: "run.started" as const,
				conversationId: "home:topic",
				runId: "run-1",
				messageId: "run-1:input",
				causeEventId: options?.causeEventId ?? "evt-received",
				payload: { status: "running" },
				createdAt: CREATED_AT,
			},
		] as const,
		conversation: options?.replay
			? null
			: {
					organizationId: "org-1",
					conversationId: "home:topic",
					channel: "home",
					createdAt: CREATED_AT,
					provisionalTitle: "hello",
				},
		submission: options?.attemptId
			? {
					attempt: {
						submissionId: "sub:run-1",
						organizationId: "org-1",
						attemptId: options.attemptId,
					},
					admittedEvent: {
						id: "evt-submission-admitted",
						organizationId: "org-1",
						kind: "submission.admitted" as const,
						conversationId: "home:topic",
						runId: "run-1",
						payload: { submissionId: "sub:run-1" },
						createdAt: CREATED_AT,
					},
				}
			: null,
	};
}

function admitRunSubmission(db: ReturnType<typeof setup>) {
	return admitSubmission(db, {
		id: "sub:run-1",
		organizationId: "org-1",
		subjectKind: "kernel",
		subjectId: "kernel:org-1",
		sourceKind: "home",
		conversationId: "home:topic",
		runId: "run-1",
	});
}

describe("openKernelRuntimeTurn", () => {
	it("lands the index bump, both events and the run row in one batch", async () => {
		const db = setup();
		const result = await openKernelRuntimeTurn(db, turnParams());
		expect(result.events.map((event) => event.inserted)).toEqual([true, true]);
		const rows = await listKernelRuntimeEvents(db, {
			runId: "run-1",
			order: "asc",
		});
		expect(rows.map((row) => [row.kind, row.causeEventId])).toEqual([
			["message.received", null],
			["run.started", "evt-received"],
		]);
		expect((await getKernelRuntimeRun(db, { id: "run-1" }))?.status).toBe(
			"running",
		);
		const conversation = await getKernelConversation(db, {
			organizationId: "org-1",
			conversationId: "home:topic",
		});
		expect(conversation?.messageCount).toBe(1);
		expect(conversation?.title).toBe("hello");
	});

	it("resolves a replay to the existing rows without a second index bump", async () => {
		const db = setup();
		await openKernelRuntimeTurn(db, turnParams());
		const replay = await openKernelRuntimeTurn(
			db,
			turnParams({ replay: true }),
		);
		expect(replay.events.map((event) => event.inserted)).toEqual([
			false,
			false,
		]);
		expect(replay.events[1]?.row.causeEventId).toBe("evt-received");
		expect((await listKernelRuntimeEvents(db, { runId: "run-1" })).length).toBe(
			2,
		);
		expect(
			(
				await getKernelConversation(db, {
					organizationId: "org-1",
					conversationId: "home:topic",
				})
			)?.messageCount,
		).toBe(1);
	});

	it("rejects a run.started whose cause row does not exist", async () => {
		const db = setup();
		await expect(
			openKernelRuntimeTurn(db, turnParams({ causeEventId: "evt-missing" })),
		).rejects.toBeInstanceOf(KernelRuntimeEventConflictError);
	});

	it("opens the first submission attempt and its receipt in the same batch", async () => {
		const db = setup();
		await admitRunSubmission(db);
		await openKernelRuntimeTurn(db, turnParams({ attemptId: "attempt-1" }));
		const submission = await getSubmissionById(db, "sub:run-1", "org-1");
		expect(submission).toMatchObject({
			status: "running",
			attemptCount: 1,
			currentAttemptId: "attempt-1",
		});
		const kinds = (await listKernelRuntimeEvents(db, { runId: "run-1" })).map(
			(row) => row.kind,
		);
		expect(kinds).toContain("submission.admitted");
	});

	it("leaves a submission another start already attempted untouched", async () => {
		const db = setup();
		await admitRunSubmission(db);
		const winner = await startAttempt(db, {
			submissionId: "sub:run-1",
			organizationId: "org-1",
		});
		await openKernelRuntimeTurn(db, turnParams({ attemptId: "attempt-late" }));
		const submission = await getSubmissionById(db, "sub:run-1", "org-1");
		expect(submission).toMatchObject({
			status: "running",
			attemptCount: 1,
			currentAttemptId: winner.attempt?.id,
		});
		const attempts = await db.select().from(runtimeSubmissionAttempts);
		expect(attempts.map((attempt) => attempt.id)).toEqual([winner.attempt?.id]);
	});
});
