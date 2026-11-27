import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { organizations } from "../schema/organizations";
import { runtimeSubmissions } from "../schema/runtime-submissions";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { createPGliteFacade } from "../test/pglite-facade";
import { admitSubmission } from "./runtime-submissions/admission";
import {
	buildStartFirstAttemptStatements,
	reopenSubmissionForOperatorRestart,
	startAttempt,
} from "./runtime-submissions/attempts";
import {
	advanceSubmissionPhase,
	requestSubmissionAbort,
	stampInputApplied,
} from "./runtime-submissions/phase-transitions";
import {
	getSubmissionById,
	listAttemptsBySubmission,
	listPendingReservedSubmissions,
} from "./runtime-submissions/read-models";
import { settleSubmission } from "./runtime-submissions/settlement";

const stores = ["d1", "postgres"] as const;

for (const store of stores) {
	describe(`runtime submissions core store: ${store}`, () => {
		let db: DbClient;
		let close: () => void | Promise<void>;
		beforeAll(async () => {
			if (store === "d1") {
				const sqlite = createMigratedSqlite();
				db = createDbClient(createD1Facade(sqlite, { maxBoundParams: 100 }));
				close = () => sqlite.close();
			} else {
				const fixture = await createPGliteFacade();
				db = fixture.db;
				close = fixture.close;
				for (const migration of readMigrationFiles({
					migrationsFolder: fileURLToPath(
						new URL("../../drizzle-pg", import.meta.url),
					),
				}))
					for (const ddl of migration.sql) await fixture.engine.exec(ddl);
			}
			await db.insert(coreTable(db, organizations)).values([
				{ id: "org", name: "Org", slug: "org" },
				{ id: "other", name: "Other", slug: "other" },
			]);
		}, 30_000);
		afterAll(async () => {
			await close?.();
		});

		const base = {
			organizationId: "org",
			subjectKind: "kernel" as const,
			subjectId: "kernel:org",
			sourceKind: "home" as const,
		};

		it("admits idempotently and opens a first attempt through the batch statements", async () => {
			const first = await admitSubmission(db, {
				id: "sub:admit-1",
				...base,
				conversationId: "conv-1",
			});
			expect(first.status).toBe("admitted");
			expect(first.phase).toBe("admitted");

			// Deterministic-id re-admit returns the existing row.
			const again = await admitSubmission(db, {
				id: "sub:admit-1",
				...base,
			});
			expect(again.id).toBe(first.id);
			expect(await getSubmissionById(db, first.id, "other")).toBeUndefined();

			// The unexecuted first-attempt statements compose into db.batch, the
			// same path openKernelRuntimeTurn uses.
			await db.batch(
				buildStartFirstAttemptStatements(db, {
					submissionId: first.id,
					organizationId: "org",
					attemptId: "attempt:first",
				}) as never,
			);
			const running = await getSubmissionById(db, first.id, "org");
			expect(running).toMatchObject({
				status: "running",
				currentAttemptId: "attempt:first",
				attemptCount: 1,
			});
			expect(await listAttemptsBySubmission(db, first.id)).toEqual([
				expect.objectContaining({
					id: "attempt:first",
					attemptNo: 1,
					status: "started",
				}),
			]);
		});

		it("advances the phase monotonically and stamps input/abort once", async () => {
			const sub = await admitSubmission(db, { id: "sub:phase", ...base });
			await startAttempt(db, { submissionId: sub.id, organizationId: "org" });

			expect(
				await advanceSubmissionPhase(db, {
					submissionId: sub.id,
					organizationId: "org",
					phase: "provider_started",
				}),
			).toEqual({ advanced: true });
			// Regression and duplicate events are inert.
			expect(
				await advanceSubmissionPhase(db, {
					submissionId: sub.id,
					organizationId: "org",
					phase: "admitted",
				}),
			).toEqual({ advanced: false });
			expect(
				await advanceSubmissionPhase(db, {
					submissionId: sub.id,
					organizationId: "org",
					phase: "tool_request_recorded",
				}),
			).toEqual({ advanced: true });
			expect((await getSubmissionById(db, sub.id, "org"))?.phase).toBe(
				"tool_request_recorded",
			);

			expect(
				await stampInputApplied(db, {
					submissionId: sub.id,
					organizationId: "org",
					appliedAtIso: "2026-11-27T00:00:00.000Z",
				}),
			).toEqual({ stamped: true });
			expect(
				await stampInputApplied(db, {
					submissionId: sub.id,
					organizationId: "org",
					appliedAtIso: "2026-11-27T00:01:00.000Z",
				}),
			).toEqual({ stamped: false });

			const abort = await requestSubmissionAbort(db, {
				submissionId: sub.id,
				organizationId: "org",
				reason: "operator cancel",
			});
			expect(abort.requested).toBe(true);
			expect(
				await requestSubmissionAbort(db, {
					submissionId: sub.id,
					organizationId: "org",
				}),
			).toMatchObject({ requested: false });
			expect(
				(await getSubmissionById(db, sub.id, "org"))?.metadata?.abortReason,
			).toBe("operator cancel");
		});

		it("settles exactly once and re-drives an abandoned reserved latch", async () => {
			const sub = await admitSubmission(db, {
				id: "sub:settle",
				...base,
				metadata: { workflowExecutionEpoch: 2 },
			});
			const { attempt } = await startAttempt(db, {
				submissionId: sub.id,
				organizationId: "org",
			});

			// The epoch fence refuses a mismatched settle before touching status.
			const fenced = await settleSubmission(db, {
				submissionId: sub.id,
				organizationId: "org",
				outcome: "settled",
				expectedWorkflowExecutionEpoch: 1,
			});
			expect(fenced.settled).toBe(false);
			expect(fenced.submission?.status).toBe("running");

			const first = await settleSubmission(db, {
				submissionId: sub.id,
				organizationId: "org",
				outcome: "settled",
				attemptId: attempt?.id,
				expectedWorkflowExecutionEpoch: 2,
			});
			expect(first.settled).toBe(true);
			expect(first.submission?.status).toBe("settled");
			expect(first.submission?.phase).toBe("committed");

			// Duplicate settle is inert even with a different outcome.
			const second = await settleSubmission(db, {
				submissionId: sub.id,
				organizationId: "org",
				outcome: "failed",
			});
			expect(second.settled).toBe(false);
			expect(second.submission?.status).toBe("settled");
			expect(
				(await listAttemptsBySubmission(db, sub.id)).map((row) => row.status),
			).toEqual(["settled"]);

			// Strand a second submission in the reserved latch — the mid-settle
			// crash state — then let the sweep path re-drive finalize.
			const stranded = await admitSubmission(db, {
				id: "sub:reserved",
				...base,
			});
			await startAttempt(db, {
				submissionId: stranded.id,
				organizationId: "org",
			});
			const submissions = coreTable(db, runtimeSubmissions);
			await db
				.update(submissions)
				.set({
					status: "reserved",
					metadata: { reservedOutcome: "failed" },
					updatedAt: "2000-01-01 00:00:00",
				})
				.where(eq(submissions.id, stranded.id));
			expect(
				(await listPendingReservedSubmissions(db, "org", "2026-01-01")).map(
					(row) => row.id,
				),
			).toContain(stranded.id);

			const redriven = await settleSubmission(db, {
				submissionId: stranded.id,
				organizationId: "org",
				outcome: "settled",
			});
			// The recorded reservedOutcome wins over the caller's outcome.
			expect(redriven.settled).toBe(true);
			expect(redriven.submission?.status).toBe("failed");
		});

		it("reopens a settled submission for an operator restart epoch", async () => {
			const sub = await admitSubmission(db, { id: "sub:restart", ...base });
			await startAttempt(db, { submissionId: sub.id, organizationId: "org" });
			await settleSubmission(db, {
				submissionId: sub.id,
				organizationId: "org",
				outcome: "settled",
			});

			const reopened = await reopenSubmissionForOperatorRestart(db, {
				submissionId: sub.id,
				organizationId: "org",
				restartId: "restart-1",
				executionEpoch: 1,
			});
			expect(reopened.reopened).toBe(true);
			expect(reopened.submission?.status).toBe("running");
			expect(reopened.attempt?.attemptNo).toBe(2);
			expect(reopened.submission?.metadata).toMatchObject({
				workflowRestartId: "restart-1",
				workflowExecutionEpoch: 1,
			});
			// The terminal attempt row stays immutable; the new epoch appends.
			const attempts = await listAttemptsBySubmission(db, sub.id);
			expect(attempts.map((row) => row.attemptNo)).toEqual([1, 2]);
			expect(attempts[0]?.status).toBe("settled");

			// Same restart identity deduplicates instead of opening epoch 3.
			const dupe = await reopenSubmissionForOperatorRestart(db, {
				submissionId: sub.id,
				organizationId: "org",
				restartId: "restart-1",
				executionEpoch: 1,
			});
			expect(dupe.reopened).toBe(false);
			expect(dupe.alreadyRunning).toBe(true);
			expect((await listAttemptsBySubmission(db, sub.id)).length).toBe(2);
		});
	});
}
