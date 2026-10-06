import { DatabaseSync } from "node:sqlite";
import { createDbClient, type DbClient } from "@tedix/db/client";
import { admitSubmission } from "@tedix/db/queries/runtime-submissions/admission";
import { startAttempt } from "@tedix/db/queries/runtime-submissions/attempts";
import { requestSubmissionAbort } from "@tedix/db/queries/runtime-submissions/phase-transitions";
import {
	getSubmissionById,
	listAttemptsBySubmission,
} from "@tedix/db/queries/runtime-submissions/read-models";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	decideKernelRedrive,
	claimKernelExecutionPolicy,
	assertKernelExecutionPolicyClaim,
	decideKernelSubmissionRecovery,
	decideTediSubmissionRecovery,
	isPendingSkillWorkflowAdmission,
	kernelRunStatusToSubmissionOutcome,
	kernelSubmissionId,
	parseDbTimestampMs,
	requestRunAbort,
	requeueTediSubmissionInPlace,
	runEventKindToSubmissionOutcome,
	submissionLivenessFloorMs,
	type TediRequeueDeps,
} from "./runtime-submission-bridge";

describe("runtime-submission-bridge", () => {
	it("atomically prevents an idempotency retry from upgrading observe-only", async () => {
		const { db } = executorDb();
		const args = {
			runId: "observe-run",
			organizationId: "org-1",
			conversationId: "conversation-1",
			idempotencyKey: "observe-run",
		};
		await claimKernelExecutionPolicy(db, {
			...args,
			executionPolicy: "observe_only",
		});
		await expect(
			claimKernelExecutionPolicy(db, { ...args, executionPolicy: "normal" }),
		).rejects.toThrow(/execution policy conflicts/);
	});

	it("rejects a lost-policy redrive against a persisted observe-only claim", async () => {
		const { db } = executorDb();
		const args = {
			runId: "lost-policy-run",
			organizationId: "org-1",
			conversationId: "conversation-1",
		};
		await claimKernelExecutionPolicy(db, {
			...args,
			executionPolicy: "observe_only",
		});
		await expect(
			assertKernelExecutionPolicyClaim(db, {
				...args,
				executionPolicy: "normal",
			}),
		).rejects.toThrow(/missing or conflicting/);
	});

	it("rejects a legacy row whose ownership identity is missing", async () => {
		const { db, sqlite } = executorDb();
		const args = {
			runId: "anonymous-run",
			organizationId: "org-1",
			conversationId: "conversation-1",
		};
		await claimKernelExecutionPolicy(db, {
			...args,
			executionPolicy: "normal",
		});
		sqlite
			.prepare(
				"UPDATE runtime_submissions SET conversation_id = NULL WHERE id = ?",
			)
			.run(kernelSubmissionId(args.runId));
		await expect(
			assertKernelExecutionPolicyClaim(db, {
				...args,
				executionPolicy: "normal",
			}),
		).rejects.toThrow(/missing or conflicting/);
	});

	it("preserves the winning policy under concurrent conflicting claims", async () => {
		const { db } = executorDb();
		const args = {
			runId: "race-run",
			organizationId: "org-1",
			conversationId: "conversation-1",
		};
		const outcomes = await Promise.allSettled([
			claimKernelExecutionPolicy(db, {
				...args,
				executionPolicy: "observe_only",
			}),
			claimKernelExecutionPolicy(db, { ...args, executionPolicy: "normal" }),
		]);
		expect(
			outcomes.filter((outcome) => outcome.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			outcomes.filter((outcome) => outcome.status === "rejected"),
		).toHaveLength(1);
	});
	it("derives a deterministic submission id per run", () => {
		expect(kernelSubmissionId("run-123")).toBe("sub:run-123");
	});

	it("maps terminal run statuses to submission outcomes", () => {
		expect(kernelRunStatusToSubmissionOutcome("completed")).toBe("settled");
		expect(kernelRunStatusToSubmissionOutcome("failed")).toBe("failed");
		expect(kernelRunStatusToSubmissionOutcome("canceled")).toBe("canceled");
	});

	it("leaves non-terminal run statuses unsettled", () => {
		expect(kernelRunStatusToSubmissionOutcome("running")).toBeNull();
		expect(kernelRunStatusToSubmissionOutcome("queued")).toBeNull();
		expect(kernelRunStatusToSubmissionOutcome("requires_approval")).toBeNull();
	});

	it("treats pre-engine workflow admission markers as recoverable", () => {
		expect(
			isPendingSkillWorkflowAdmission({
				status: "failed",
				error: "WORKFLOW_ADMISSION_PENDING: engine create not observed",
			}),
		).toBe(true);
		expect(
			isPendingSkillWorkflowAdmission({
				status: "failed",
				error: "WORKFLOW_ADMISSION_CREATE_FAILED: transport timeout",
			}),
		).toBe(true);
		expect(
			isPendingSkillWorkflowAdmission({
				status: "failed",
				error: "workflow step failed",
			}),
		).toBe(false);
	});

	it("maps terminal tedi run EVENT kinds to submission outcomes", () => {
		expect(runEventKindToSubmissionOutcome("run.completed")).toBe("settled");
		expect(runEventKindToSubmissionOutcome("run.failed")).toBe("failed");
		expect(runEventKindToSubmissionOutcome("run.canceled")).toBe("canceled");
		expect(runEventKindToSubmissionOutcome("run.started")).toBeNull();
		expect(runEventKindToSubmissionOutcome("message.delta")).toBeNull();
	});

	it("normalizes D1 + ISO timestamps to UTC epoch ms (timezone-independent)", () => {
		// D1 "YYYY-MM-DD HH:MM:SS" (UTC, no zone) == the same instant as its ISO form.
		expect(parseDbTimestampMs("2026-06-17 16:52:19")).toBe(
			Date.parse("2026-06-17T16:52:19Z"),
		);
		expect(parseDbTimestampMs("2026-06-17T16:52:19.000Z")).toBe(
			Date.parse("2026-06-17T16:52:19.000Z"),
		);
		expect(Number.isNaN(parseDbTimestampMs(null))).toBe(true);
		expect(Number.isNaN(parseDbTimestampMs(undefined))).toBe(true);
	});

	describe("decideKernelSubmissionRecovery", () => {
		const now = Date.parse("2026-06-18T12:00:00Z");
		const lease = 15 * 60_000; // 15 min
		const silentParent = {
			runStatus: "running",
			lastSignalMs: now - lease - 60_000,
			nowMs: now,
			crashLeaseMs: lease,
		};

		it.each(["queued", "running", "streaming", "requires_approval"])(
			"keeps a silent delegated parent alive on fresh %s child evidence",
			(status) => {
				expect(
					decideKernelSubmissionRecovery({
						...silentParent,
						childRun: {
							status,
							latestEventAt: new Date(now - 120_000).toISOString(),
						},
					}),
				).toBeNull();
			},
		);

		it.each([
			null,
			undefined,
			"invalid",
			123,
			new Date(now - lease - 1).toISOString(),
			new Date(now + 1).toISOString(),
		])(
			"does not extend liveness from missing, stale or future child time %s",
			(latestEventAt) => {
				expect(
					decideKernelSubmissionRecovery({
						...silentParent,
						childRun: { status: "running", latestEventAt },
					}),
				).toBe("failed");
			},
		);

		it.each(["completed", "failed", "canceled", "unknown"])(
			"does not treat a fresh %s child summary as ongoing execution",
			(status) => {
				expect(
					decideKernelSubmissionRecovery({
						...silentParent,
						childRun: { status, latestEventAt: new Date(now).toISOString() },
					}),
				).toBe("failed");
			},
		);

		it("keeps terminal parent and operator abort precedence over fresh child evidence", () => {
			const input = {
				...silentParent,
				childRun: {
					status: "running",
					latestEventAt: new Date(now).toISOString(),
				},
				abortRequestedAt: new Date(now).toISOString(),
			};
			expect(decideKernelSubmissionRecovery(input)).toBe("canceled");
			for (const [runStatus, outcome] of [
				["completed", "settled"],
				["failed", "failed"],
				["canceled", "canceled"],
			])
				expect(
					decideKernelSubmissionRecovery({ ...input, runStatus: runStatus! }),
				).toBe(outcome);
		});

		it("settles a stranded terminal run (completed/failed/canceled) — already-terminal case", () => {
			expect(
				decideKernelSubmissionRecovery({
					runStatus: "completed",
					lastSignalMs: now,
					nowMs: now,
					crashLeaseMs: lease,
				}),
			).toBe("settled");
			expect(
				decideKernelSubmissionRecovery({
					runStatus: "failed",
					lastSignalMs: now,
					nowMs: now,
					crashLeaseMs: lease,
				}),
			).toBe("failed");
			expect(
				decideKernelSubmissionRecovery({
					runStatus: "canceled",
					lastSignalMs: now,
					nowMs: now,
					crashLeaseMs: lease,
				}),
			).toBe("canceled");
		});

		it("terminalizes a crashed run — running, silent past lease", () => {
			expect(
				decideKernelSubmissionRecovery({
					runStatus: "running",
					lastSignalMs: now - lease - 60_000,
					nowMs: now,
					crashLeaseMs: lease,
				}),
			).toBe("failed");
		});

		it("terminalizes a crashed run — queued, silent past lease", () => {
			expect(
				decideKernelSubmissionRecovery({
					runStatus: "queued",
					lastSignalMs: now - lease - 1,
					nowMs: now,
					crashLeaseMs: lease,
				}),
			).toBe("failed");
		});

		it("leaves a live running run (recent activity inside the lease)", () => {
			expect(
				decideKernelSubmissionRecovery({
					runStatus: "running",
					lastSignalMs: now - 60_000,
					nowMs: now,
					crashLeaseMs: lease,
				}),
			).toBeNull();
		});

		it("never terminalizes a requires_approval run — even when very old", () => {
			expect(
				decideKernelSubmissionRecovery({
					runStatus: "requires_approval",
					lastSignalMs: now - 24 * 60 * 60_000,
					nowMs: now,
					crashLeaseMs: lease,
				}),
			).toBeNull();
		});

		it("leaves a running run with an unparseable liveness signal (never falsely terminalize)", () => {
			expect(
				decideKernelSubmissionRecovery({
					runStatus: "running",
					lastSignalMs: Number.NaN,
					nowMs: now,
					crashLeaseMs: lease,
				}),
			).toBeNull();
		});
	});

	describe("decideKernelRedrive", () => {
		const now = Date.parse("2026-06-18T12:00:00Z");
		const lease = 15 * 60_000;
		const crashed = {
			lastSignalMs: now - lease - 60_000,
			nowMs: now,
			crashLeaseMs: lease,
		};

		it("re-drives a crashed turn with NO route + NO delegation (provably pre-side-effect)", () => {
			expect(
				decideKernelRedrive({
					runStatus: "running",
					kernelRoute: null,
					delegatedTediId: null,
					childRunId: null,
					attemptCount: 0,
					maxRetry: 10,
					...crashed,
				}),
			).toBe("redrive");
		});

		it("FAILS (never re-drives) a crashed turn that already decided a route", () => {
			expect(
				decideKernelRedrive({
					runStatus: "running",
					kernelRoute: "delegate_tedi",
					delegatedTediId: null,
					childRunId: null,
					...crashed,
				}),
			).toBe("failed");
		});

		it("FAILS a crashed turn that already dispatched a delegation (child columns set)", () => {
			expect(
				decideKernelRedrive({
					runStatus: "running",
					kernelRoute: null,
					delegatedTediId: "tedi-cto",
					childRunId: "run-child",
					...crashed,
				}),
			).toBe("failed");
		});

		it("FAILS conservatively when kernelRoute is undefined/absent (no affirmative proof)", () => {
			expect(
				decideKernelRedrive({
					runStatus: "running",
					// kernelRoute omitted → undefined, not an affirmative null stamp
					delegatedTediId: null,
					childRunId: null,
					...crashed,
				}),
			).toBe("failed");
		});

		it("FAILS once the durable re-drive budget is spent (attemptCount >= maxRetry)", () => {
			expect(
				decideKernelRedrive({
					runStatus: "running",
					kernelRoute: null,
					delegatedTediId: null,
					childRunId: null,
					attemptCount: 10,
					maxRetry: 10,
					...crashed,
				}),
			).toBe("failed");
		});

		it("leaves a live turn within the lease (never re-drive a slow turn)", () => {
			expect(
				decideKernelRedrive({
					runStatus: "running",
					kernelRoute: null,
					delegatedTediId: null,
					childRunId: null,
					lastSignalMs: now - 60_000,
					nowMs: now,
					crashLeaseMs: lease,
				}),
			).toBeNull();
		});

		it("never touches a requires_approval (parked) run", () => {
			expect(
				decideKernelRedrive({
					runStatus: "requires_approval",
					kernelRoute: null,
					delegatedTediId: null,
					childRunId: null,
					...crashed,
				}),
			).toBeNull();
		});

		it("returns null for an already-terminal run (caller settles)", () => {
			expect(
				decideKernelRedrive({
					runStatus: "completed",
					kernelRoute: null,
					delegatedTediId: null,
					childRunId: null,
					...crashed,
				}),
			).toBeNull();
		});

		it("re-drives a queued (not-yet-started) crashed turn too", () => {
			expect(
				decideKernelRedrive({
					runStatus: "queued",
					kernelRoute: null,
					delegatedTediId: null,
					childRunId: null,
					...crashed,
				}),
			).toBe("redrive");
		});

		it("never falsely terminalizes on an unparseable liveness signal", () => {
			expect(
				decideKernelRedrive({
					runStatus: "running",
					kernelRoute: null,
					delegatedTediId: null,
					childRunId: null,
					lastSignalMs: Number.NaN,
					nowMs: now,
					crashLeaseMs: lease,
				}),
			).toBeNull();
		});
	});

	describe("submissionLivenessFloorMs", () => {
		it("takes the max of the latest event and the submission updatedAt", () => {
			expect(
				submissionLivenessFloorMs(
					"2026-06-18T12:00:00Z",
					"2026-06-18T12:05:00Z",
				),
			).toBe(Date.parse("2026-06-18T12:05:00Z"));
			// A just-requeued row: updatedAt bumped, latest event still pre-crash —
			// the floor must follow updatedAt or the next pass re-requeues it.
			expect(
				submissionLivenessFloorMs(
					"2026-06-18T10:00:00Z",
					"2026-06-18 12:05:00",
				),
			).toBe(Date.parse("2026-06-18T12:05:00Z"));
			expect(
				submissionLivenessFloorMs(
					"2026-06-18T12:05:00Z",
					"2026-06-18T10:00:00Z",
				),
			).toBe(Date.parse("2026-06-18T12:05:00Z"));
		});

		it("ignores an unparseable side and returns NaN only when both are unusable", () => {
			expect(submissionLivenessFloorMs(null, "2026-06-18T12:00:00Z")).toBe(
				Date.parse("2026-06-18T12:00:00Z"),
			);
			expect(submissionLivenessFloorMs("2026-06-18T12:00:00Z", null)).toBe(
				Date.parse("2026-06-18T12:00:00Z"),
			);
			expect(Number.isNaN(submissionLivenessFloorMs(null, null))).toBe(true);
			expect(Number.isNaN(submissionLivenessFloorMs(undefined, "junk"))).toBe(
				true,
			);
		});
	});

	describe("requestRunAbort fail-soft", () => {
		it("returns requested:false instead of throwing when the ledger is unreachable (a cancel must never break on the stamp)", async () => {
			const throwingDb = {
				select() {
					throw new Error("D1 transport down");
				},
				update() {
					throw new Error("D1 transport down");
				},
			} as unknown as DbClient;
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				await expect(
					requestRunAbort(throwingDb, {
						runId: "tedi-1:mcp:turn-1",
						organizationId: "org-1",
						reason: "operator cancel",
					}),
				).resolves.toEqual({ requested: false });
			} finally {
				warn.mockRestore();
			}
		});
	});

	describe("decideTediSubmissionRecovery", () => {
		const now = Date.parse("2026-06-18T12:00:00Z");
		const lease = 30 * 60_000;

		it("settles a missed-settle orphan from its terminal run event", () => {
			expect(
				decideTediSubmissionRecovery({
					terminalEventKind: "run.failed",
					lastSignalMs: now,
					nowMs: now,
					crashLeaseMs: lease,
				}),
			).toBe("failed");
			expect(
				decideTediSubmissionRecovery({
					terminalEventKind: "run.completed",
					lastSignalMs: now,
					nowMs: now,
					crashLeaseMs: lease,
				}),
			).toBe("settled");
		});

		it("terminalizes a crashed run (no terminal event, last signal past the lease)", () => {
			expect(
				decideTediSubmissionRecovery({
					terminalEventKind: null,
					lastSignalMs: now - lease - 60_000,
					nowMs: now,
					crashLeaseMs: lease,
				}),
			).toBe("failed");
		});

		it("leaves a live run (no terminal event, recent activity inside the lease)", () => {
			expect(
				decideTediSubmissionRecovery({
					terminalEventKind: null,
					lastSignalMs: now - 60_000,
					nowMs: now,
					crashLeaseMs: lease,
				}),
			).toBeNull();
		});

		it("leaves a run with an unparseable last signal (never falsely terminalize)", () => {
			expect(
				decideTediSubmissionRecovery({
					terminalEventKind: null,
					lastSignalMs: Number.NaN,
					nowMs: now,
					crashLeaseMs: lease,
				}),
			).toBeNull();
		});

		const crashed = {
			terminalEventKind: null,
			lastSignalMs: now - lease - 60_000,
			nowMs: now,
			crashLeaseMs: lease,
		};

		it("REQUEUES a crash with affirmative pre-input evidence (phase admitted + input never applied)", () => {
			expect(
				decideTediSubmissionRecovery({
					...crashed,
					phase: "admitted",
					inputAppliedAt: null,
					attemptCount: 1,
					maxRetry: 10,
				}),
			).toBe("requeue");
		});

		it("FAILS (never requeues) a NULL-phase legacy row — absence of data is not safety", () => {
			expect(
				decideTediSubmissionRecovery({
					...crashed,
					phase: null,
					inputAppliedAt: null,
				}),
			).toBe("failed");
		});

		it("FAILS once input was applied or the phase advanced past admitted", () => {
			expect(
				decideTediSubmissionRecovery({
					...crashed,
					phase: "admitted",
					inputAppliedAt: "2026-06-18T11:00:00Z",
				}),
			).toBe("failed");
			expect(
				decideTediSubmissionRecovery({
					...crashed,
					phase: "provider_started",
					inputAppliedAt: null,
				}),
			).toBe("failed");
		});

		it("budget beats requeue: a spent durable budget hard-fails even a requeue-safe phase", () => {
			expect(
				decideTediSubmissionRecovery({
					...crashed,
					phase: "admitted",
					inputAppliedAt: null,
					attemptCount: 10,
					maxRetry: 10,
				}),
			).toBe("failed");
		});

		describe("durable abort precedence (completed → abort → budget → timeout)", () => {
			it("terminal event beats abort: completed work wins", () => {
				expect(
					decideTediSubmissionRecovery({
						terminalEventKind: "run.completed",
						abortRequestedAt: "2026-06-18T11:59:00Z",
						lastSignalMs: now,
						nowMs: now,
						crashLeaseMs: lease,
					}),
				).toBe("settled");
			});

			it("abort beats the lease: canceled even while the turn looks live", () => {
				expect(
					decideTediSubmissionRecovery({
						terminalEventKind: null,
						abortRequestedAt: "2026-06-18T11:59:00Z",
						lastSignalMs: now - 60_000,
						nowMs: now,
						crashLeaseMs: lease,
					}),
				).toBe("canceled");
			});

			it("abort beats the budget: canceled, never budget-failed", () => {
				expect(
					decideTediSubmissionRecovery({
						...crashed,
						abortRequestedAt: "2026-06-18T11:59:00Z",
						attemptCount: 10,
						maxRetry: 10,
					}),
				).toBe("canceled");
			});

			it("abort blocks requeue: a requeue-safe crash with a stamp is canceled instead", () => {
				expect(
					decideTediSubmissionRecovery({
						...crashed,
						phase: "admitted",
						inputAppliedAt: null,
						abortRequestedAt: "2026-06-18T11:59:00Z",
					}),
				).toBe("canceled");
			});

			it("legacy pin: abortRequestedAt null/absent decides exactly as before", () => {
				const table: Array<
					[
						Parameters<typeof decideTediSubmissionRecovery>[0],
						ReturnType<typeof decideTediSubmissionRecovery>,
					]
				> = [
					[
						{
							terminalEventKind: "run.failed",
							lastSignalMs: now,
							nowMs: now,
							crashLeaseMs: lease,
						},
						"failed",
					],
					[
						{
							terminalEventKind: null,
							lastSignalMs: now - 60_000,
							nowMs: now,
							crashLeaseMs: lease,
						},
						null,
					],
					[
						{
							terminalEventKind: null,
							lastSignalMs: Number.NaN,
							nowMs: now,
							crashLeaseMs: lease,
						},
						null,
					],
					[{ ...crashed, phase: null }, "failed"],
					[{ ...crashed, phase: "admitted", inputAppliedAt: null }, "requeue"],
					[
						{
							...crashed,
							phase: "admitted",
							inputAppliedAt: null,
							attemptCount: 10,
							maxRetry: 10,
						},
						"failed",
					],
					[{ ...crashed, phase: "tool_request_recorded" }, "failed"],
				];
				for (const [args, expected] of table) {
					expect(decideTediSubmissionRecovery(args)).toBe(expected);
					expect(
						decideTediSubmissionRecovery({ ...args, abortRequestedAt: null }),
					).toBe(expected);
				}
			});
		});
	});

	describe("durable abort on the kernel deciders", () => {
		const now = Date.parse("2026-06-18T12:00:00Z");
		const lease = 15 * 60_000;

		it("terminal run status beats abort (completed work wins)", () => {
			expect(
				decideKernelSubmissionRecovery({
					runStatus: "completed",
					abortRequestedAt: "2026-06-18T11:59:00Z",
					lastSignalMs: now,
					nowMs: now,
					crashLeaseMs: lease,
				}),
			).toBe("settled");
		});

		it("abort cancels a running run even inside the lease", () => {
			expect(
				decideKernelSubmissionRecovery({
					runStatus: "running",
					abortRequestedAt: "2026-06-18T11:59:00Z",
					lastSignalMs: now - 60_000,
					nowMs: now,
					crashLeaseMs: lease,
				}),
			).toBe("canceled");
		});

		it("a PARKED run with a durable abort stamp is canceled (recorded operator intent)", () => {
			expect(
				decideKernelSubmissionRecovery({
					runStatus: "requires_approval",
					abortRequestedAt: "2026-06-18T11:59:00Z",
					lastSignalMs: now - 24 * 60 * 60_000,
					nowMs: now,
					crashLeaseMs: lease,
				}),
			).toBe("canceled");
		});

		it("a PARKED run WITHOUT a stamp stays untouchable (pinned invariant)", () => {
			expect(
				decideKernelSubmissionRecovery({
					runStatus: "requires_approval",
					abortRequestedAt: null,
					lastSignalMs: now - 24 * 60 * 60_000,
					nowMs: now,
					crashLeaseMs: lease,
				}),
			).toBeNull();
		});

		it("abort blocks a kernel redrive (do-not-redrive; the outer canceled governs the settle)", () => {
			const crashed = {
				runStatus: "running",
				kernelRoute: null,
				delegatedTediId: null,
				childRunId: null,
				lastSignalMs: now - lease - 60_000,
				nowMs: now,
				crashLeaseMs: lease,
			};
			expect(
				decideKernelRedrive({
					...crashed,
					abortRequestedAt: "2026-06-18T11:59:00Z",
				}),
			).toBe("failed");
			// Legacy pin: without a stamp the same crash still re-drives.
			expect(decideKernelRedrive({ ...crashed })).toBe("redrive");
			expect(decideKernelRedrive({ ...crashed, abortRequestedAt: null })).toBe(
				"redrive",
			);
		});
	});
});

// =============================================================================
// requeueTediSubmissionInPlace — the tedi requeue executor, run against a REAL
// in-memory SQLite via the production createDbClient path (the same
// node:sqlite facade pattern as kernel/plan-dependencies.test.ts), with the
// runtime dependencies (loadTedi / inject) faked. This proves the executor's
// ledger effects (latch, fenced settles, running row) end to end.
// =============================================================================

const EXECUTOR_DDL = `
CREATE TABLE runtime_submissions (
	id TEXT PRIMARY KEY NOT NULL,
	organization_id TEXT NOT NULL,
	subject_kind TEXT NOT NULL,
	subject_id TEXT NOT NULL,
	tedi_id TEXT,
	conversation_id TEXT,
	run_id TEXT,
	idempotency_key TEXT,
	source_kind TEXT NOT NULL,
	source_provider TEXT,
	source_delivery_id TEXT,
	status TEXT NOT NULL DEFAULT 'admitted',
	current_attempt_id TEXT,
	attempt_count INTEGER NOT NULL DEFAULT 0,
	runtime_backend TEXT,
	metadata TEXT,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	settled_at TEXT,
	timeout_at TEXT,
	phase TEXT,
	input_applied_at TEXT,
	abort_requested_at TEXT,
	max_retry INTEGER NOT NULL DEFAULT 10
);
CREATE UNIQUE INDEX uniq_runtime_submissions_delivery
	ON runtime_submissions (organization_id, source_provider, source_delivery_id);
CREATE TABLE runtime_submission_attempts (
	id TEXT PRIMARY KEY NOT NULL,
	submission_id TEXT NOT NULL,
	organization_id TEXT NOT NULL,
	attempt_no INTEGER NOT NULL,
	status TEXT NOT NULL DEFAULT 'started',
	runtime_backend TEXT,
	runtime_external_id TEXT,
	error TEXT,
	metadata TEXT,
	started_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	heartbeat_at TEXT,
	completed_at TEXT
);
CREATE UNIQUE INDEX uniq_runtime_submission_attempts_no
	ON runtime_submission_attempts (submission_id, attempt_no);
CREATE TABLE tedi_runtime_events (
	id TEXT PRIMARY KEY NOT NULL,
	organization_id TEXT NOT NULL,
	tedi_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	conversation_id TEXT,
	run_id TEXT,
	payload TEXT,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
`;

function d1Facade(db: DatabaseSync): D1Database {
	const wrap = (sql: string) => {
		const stmt = db.prepare(sql);
		let bound: Array<null | number | bigint | string | Uint8Array> = [];
		const ps = {
			bind: (...vals: unknown[]) => {
				bound = vals as Array<null | number | bigint | string | Uint8Array>;
				return ps;
			},
			all: async () => ({
				results: stmt.all(...bound),
				success: true,
				meta: {},
			}),
			run: async () => {
				const r = stmt.run(...bound);
				return {
					success: true,
					meta: {
						changes: Number(r.changes),
						last_row_id: Number(r.lastInsertRowid),
						duration: 0,
					},
				};
			},
			first: async (col?: string) => {
				const row = stmt.get(...bound) as Record<string, unknown> | undefined;
				return col ? (row?.[col] ?? null) : (row ?? null);
			},
			raw: async () =>
				(stmt.all(...bound) as Array<Record<string, unknown>>).map((r) =>
					Object.values(r),
				),
		};
		return ps;
	};
	return {
		prepare: wrap,
		batch: async (stmts: Array<{ all: () => Promise<unknown> }>) =>
			Promise.all(stmts.map((s) => s.all())),
		exec: async (sql: string) => {
			db.exec(sql);
			return { count: 0, duration: 0 };
		},
		dump: async () => new ArrayBuffer(0),
	} as unknown as D1Database;
}

function executorDb(): { db: DbClient; sqlite: DatabaseSync } {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(EXECUTOR_DDL);
	return { db: createDbClient(d1Facade(sqlite)), sqlite };
}

describe("requeueTediSubmissionInPlace (real sqlite + faked runtime deps)", () => {
	const ORG = "org-1";
	const TEDI = "tedi-1";
	const RUN_ID = `${TEDI}:mcp:turn-key-1`;
	const SUB_ID = `sub:${RUN_ID}`;

	async function seedRunningSubmission(
		db: DbClient,
		opts: { maxRetry?: number } = {},
	) {
		await admitSubmission(db, {
			id: SUB_ID,
			organizationId: ORG,
			subjectKind: "tedi",
			subjectId: TEDI,
			sourceKind: "tedi_message",
			tediId: TEDI,
			runId: RUN_ID,
			...(opts.maxRetry != null ? { maxRetry: opts.maxRetry } : {}),
		});
		return startAttempt(db, { submissionId: SUB_ID, organizationId: ORG });
	}

	function seedInputEvent(sqlite: DatabaseSync) {
		sqlite
			.prepare(
				`INSERT INTO tedi_runtime_events
				 (id, organization_id, tedi_id, kind, conversation_id, run_id, payload, created_at)
				 VALUES (?, ?, ?, 'message.received', 'alpha:main', ?, ?, '2026-07-01T00:00:00.000Z')`,
			)
			.run(
				`${RUN_ID}:0`,
				ORG,
				TEDI,
				RUN_ID,
				JSON.stringify({
					role: "user",
					content: "hello world",
					attachments: [
						{
							content: "abc",
							mimeType: "text/plain",
							type: "file",
							fileName: "a.txt",
						},
					],
					metadata: { voiceTranscript: "vt" },
				}),
			);
	}

	function fakeDeps(overrides: Partial<TediRequeueDeps> = {}): TediRequeueDeps {
		return {
			loadTedi: vi.fn(async () => ({
				id: TEDI,
				organizationId: ORG,
				slug: "alpha",
			})),
			inject: vi.fn(async () => ({ success: true })),
			...overrides,
		};
	}

	it("requeues in place: recovered attempt + same clientRequestId + stripped session; row stays running", async () => {
		const { db, sqlite } = executorDb();
		const first = await seedRunningSubmission(db);
		seedInputEvent(sqlite);
		const submission = await getSubmissionById(db, SUB_ID, ORG);
		if (!submission) throw new Error("seed failed");
		const deps = fakeDeps();

		const result = await requeueTediSubmissionInPlace(db, deps, {
			submission,
			organizationId: ORG,
		});
		expect(result).toEqual({ requeued: true, reason: "requeued" });

		// The original input was re-injected under the SAME clientRequestId with
		// the ledger prefix stripped from the session key.
		expect(deps.inject).toHaveBeenCalledTimes(1);
		expect(deps.inject).toHaveBeenCalledWith({
			tedi: { slug: "alpha" },
			message: "hello world",
			session: "main",
			attachments: [
				{
					content: "abc",
					fileName: "a.txt",
					mimeType: "text/plain",
					type: "file",
				},
			],
			clientRequestId: "turn-key-1",
			metadata: { voiceTranscript: "vt" },
		});

		// In-place: same row, still running, with a monotonically appended
		// recovered attempt now owning the pointer — never a false terminal.
		const row = await getSubmissionById(db, SUB_ID, ORG);
		expect(row?.status).toBe("running");
		expect(row?.attemptCount).toBe(2);
		const attempts = await listAttemptsBySubmission(db, SUB_ID);
		expect(attempts.map((a) => a.status)).toEqual(["started", "recovered"]);
		expect(row?.currentAttemptId).toBe(attempts[1]?.id);
		expect(attempts[1]?.metadata).toMatchObject({
			kind: "crash_requeue",
			requeuedFromAttemptId: first.attempt?.id,
		});
	});

	it("lost latch: the losing executor injects nothing and settles nothing", async () => {
		const { db, sqlite } = executorDb();
		const first = await seedRunningSubmission(db);
		seedInputEvent(sqlite);
		const submission = await getSubmissionById(db, SUB_ID, ORG);
		if (!submission) throw new Error("seed failed");
		// A racing executor already appended attemptNo 2 (pointer not repointed).
		sqlite
			.prepare(
				`INSERT INTO runtime_submission_attempts
				 (id, submission_id, organization_id, attempt_no, status)
				 VALUES ('att-racer', ?, ?, 2, 'recovered')`,
			)
			.run(SUB_ID, ORG);
		const deps = fakeDeps();

		const result = await requeueTediSubmissionInPlace(db, deps, {
			submission,
			organizationId: ORG,
		});
		expect(result).toEqual({ requeued: false, reason: "lost_latch" });
		expect(deps.inject).not.toHaveBeenCalled();
		const row = await getSubmissionById(db, SUB_ID, ORG);
		expect(row?.status).toBe("running");
		expect(row?.currentAttemptId).toBe(first.attempt?.id);
	});

	it("abort pre-flight beats requeue: settles canceled through the attempt fence, no inject", async () => {
		const { db, sqlite } = executorDb();
		await seedRunningSubmission(db);
		seedInputEvent(sqlite);
		const stamp = await requestSubmissionAbort(db, {
			submissionId: SUB_ID,
			organizationId: ORG,
			reason: "operator cancel",
		});
		expect(stamp.requested).toBe(true);
		const submission = await getSubmissionById(db, SUB_ID, ORG);
		if (!submission) throw new Error("seed failed");
		const deps = fakeDeps();

		const result = await requeueTediSubmissionInPlace(db, deps, {
			submission,
			organizationId: ORG,
		});
		expect(result).toEqual({ requeued: false, reason: "aborted" });
		expect(deps.loadTedi).not.toHaveBeenCalled();
		expect(deps.inject).not.toHaveBeenCalled();
		const row = await getSubmissionById(db, SUB_ID, ORG);
		expect(row?.status).toBe("canceled");
		const attempts = await listAttemptsBySubmission(db, SUB_ID);
		expect(attempts[0]?.status).toBe("canceled");
		expect(attempts[0]?.error).toBe("operator abort honored at recovery");
	});

	it("budget re-check: a spent budget requeues nothing and settles nothing (next sweep fails it)", async () => {
		const { db, sqlite } = executorDb();
		await seedRunningSubmission(db, { maxRetry: 1 });
		seedInputEvent(sqlite);
		const submission = await getSubmissionById(db, SUB_ID, ORG);
		if (!submission) throw new Error("seed failed");
		expect(submission.attemptCount).toBe(1);
		const deps = fakeDeps();

		const result = await requeueTediSubmissionInPlace(db, deps, {
			submission,
			organizationId: ORG,
		});
		expect(result).toEqual({ requeued: false, reason: "budget_spent" });
		expect(deps.inject).not.toHaveBeenCalled();
		expect((await getSubmissionById(db, SUB_ID, ORG))?.status).toBe("running");
	});

	it("input missing: settles failed with the observed attempt pinned, no inject", async () => {
		const { db } = executorDb();
		const first = await seedRunningSubmission(db);
		// No message.received event seeded.
		const submission = await getSubmissionById(db, SUB_ID, ORG);
		if (!submission) throw new Error("seed failed");
		const deps = fakeDeps();

		const result = await requeueTediSubmissionInPlace(db, deps, {
			submission,
			organizationId: ORG,
		});
		expect(result).toEqual({ requeued: false, reason: "input_missing" });
		expect(deps.inject).not.toHaveBeenCalled();
		const row = await getSubmissionById(db, SUB_ID, ORG);
		expect(row?.status).toBe("failed");
		const attempts = await listAttemptsBySubmission(db, SUB_ID);
		expect(attempts.find((a) => a.id === first.attempt?.id)?.error).toContain(
			"requeue input unavailable",
		);
	});

	it("tedi missing or cross-org: settles failed without injecting", async () => {
		const { db, sqlite } = executorDb();
		await seedRunningSubmission(db);
		seedInputEvent(sqlite);
		const submission = await getSubmissionById(db, SUB_ID, ORG);
		if (!submission) throw new Error("seed failed");
		// getTediById is not org-scoped — a cross-org tedi must be rejected.
		const deps = fakeDeps({
			loadTedi: vi.fn(async () => ({
				id: TEDI,
				organizationId: "org-OTHER",
				slug: "alpha",
			})),
		});

		const result = await requeueTediSubmissionInPlace(db, deps, {
			submission,
			organizationId: ORG,
		});
		expect(result).toEqual({ requeued: false, reason: "tedi_missing" });
		expect(deps.inject).not.toHaveBeenCalled();
		expect((await getSubmissionById(db, SUB_ID, ORG))?.status).toBe("failed");
	});

	it("inject failure: settles failed against the NEWLY created attempt (fence holds)", async () => {
		const { db, sqlite } = executorDb();
		await seedRunningSubmission(db);
		seedInputEvent(sqlite);
		const submission = await getSubmissionById(db, SUB_ID, ORG);
		if (!submission) throw new Error("seed failed");
		const deps = fakeDeps({
			inject: vi.fn(async () => ({
				success: false,
				error: "gateway 503",
			})),
		});

		const result = await requeueTediSubmissionInPlace(db, deps, {
			submission,
			organizationId: ORG,
		});
		expect(result).toEqual({ requeued: false, reason: "inject_failed" });
		const row = await getSubmissionById(db, SUB_ID, ORG);
		expect(row?.status).toBe("failed");
		const attempts = await listAttemptsBySubmission(db, SUB_ID);
		expect(attempts.map((a) => a.status)).toEqual(["started", "failed"]);
		expect(attempts[1]?.error).toBe("gateway 503");
	});

	it("a throwing inject is treated as a failure, not an unhandled crash (fail-soft)", async () => {
		const { db, sqlite } = executorDb();
		await seedRunningSubmission(db);
		seedInputEvent(sqlite);
		const submission = await getSubmissionById(db, SUB_ID, ORG);
		if (!submission) throw new Error("seed failed");
		const deps = fakeDeps({
			inject: vi.fn(async () => {
				throw new Error("runtime unreachable");
			}),
		});

		const result = await requeueTediSubmissionInPlace(db, deps, {
			submission,
			organizationId: ORG,
		});
		expect(result).toEqual({ requeued: false, reason: "inject_failed" });
		const row = await getSubmissionById(db, SUB_ID, ORG);
		expect(row?.status).toBe("failed");
		const attempts = await listAttemptsBySubmission(db, SUB_ID);
		expect(attempts[1]?.error).toBe("runtime unreachable");
	});
});
