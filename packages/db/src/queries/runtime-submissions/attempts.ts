/** Attempt creation and operator-controlled restart epochs. */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import type { TediRuntimeBackend } from "../../schema/cognitive-runtime";
import {
	type RuntimeSubmission,
	type RuntimeSubmissionAttempt,
	runtimeSubmissionAttempts,
	runtimeSubmissions,
} from "../../schema/runtime-submissions";
import { toJsonRecord } from "../../utils/json";
import { getSubmissionById } from "./read-models";
import { isTerminalSubmissionStatus } from "./settlement";

export interface StartAttemptArgs {
	submissionId: string;
	organizationId: string;
	runtimeBackend?: TediRuntimeBackend | null;
	runtimeExternalId?: string | null;
	metadata?: Record<string, JsonValue> | null;
	/** True when reviving an interrupted attempt rather than a fresh start. */
	recovered?: boolean;
}

export interface StartAttemptResult {
	submission: RuntimeSubmission | undefined;
	attempt: RuntimeSubmissionAttempt | undefined;
}

export interface ReopenSubmissionForRestartArgs {
	submissionId: string;
	organizationId: string;
	/** Caller-stable workflow restart command identity. */
	restartId?: string | null;
	/** Runtime execution epoch reserved for this restart command. */
	executionEpoch?: number | null;
	runtimeBackend?: TediRuntimeBackend | null;
	runtimeExternalId?: string | null;
	timeoutAt?: string | null;
}

export interface ReopenSubmissionForRestartResult {
	reopened: boolean;
	alreadyRunning: boolean;
	submission: RuntimeSubmission | undefined;
	attempt: RuntimeSubmissionAttempt | undefined;
}

/**
 * Open a new attempt for a submission and mark it running. The attempt number
 * monotonically increases; the (submissionId, attemptNo) unique index makes a
 * duplicate start inert.
 */
export async function startAttempt(
	db: DbClient,
	args: StartAttemptArgs,
): Promise<StartAttemptResult> {
	const current = await getSubmissionById(
		db,
		args.submissionId,
		args.organizationId,
	);
	if (!current) return { submission: undefined, attempt: undefined };

	const attemptNo = (current.attemptCount ?? 0) + 1;
	const attemptId = crypto.randomUUID();
	const [attempt] = await db
		.insert(runtimeSubmissionAttempts)
		.values({
			id: attemptId,
			submissionId: args.submissionId,
			organizationId: args.organizationId,
			attemptNo,
			status: args.recovered ? "recovered" : "started",
			runtimeBackend: args.runtimeBackend ?? null,
			runtimeExternalId: args.runtimeExternalId ?? null,
			metadata: args.metadata ?? null,
		})
		.onConflictDoNothing()
		.returning();

	// Only point currentAttemptId at this caller's attempt if its insert actually
	// won (a lost onConflictDoNothing would otherwise dangle the pointer at a
	// discarded id). The status guard keeps a recovered/concurrent start from
	// resurrecting an already-terminal submission — preserving exactly-once.
	const attemptWon = attempt !== undefined;
	const [submission] = await db
		.update(runtimeSubmissions)
		.set({
			status: "running",
			...(attemptWon ? { currentAttemptId: attemptId } : {}),
			attemptCount: attemptNo,
			runtimeBackend: args.runtimeBackend ?? current.runtimeBackend ?? null,
			updatedAt: sql`(CURRENT_TIMESTAMP)`,
		})
		.where(
			and(
				eq(runtimeSubmissions.id, args.submissionId),
				eq(runtimeSubmissions.organizationId, args.organizationId),
				inArray(runtimeSubmissions.status, ["admitted", "running"]),
			),
		)
		.returning();

	return { submission, attempt };
}

/**
 * Open a new operator-restart epoch for an already-settled submission.
 *
 * The terminal attempt remains immutable in runtime_submission_attempts. A
 * CAS reopens only the parent submission, then startAttempt appends the next
 * monotonically numbered attempt. Concurrent restart callers cannot create two
 * epochs: only one terminal-to-admitted update wins; the loser observes the
 * winner's running row and returns alreadyRunning=true.
 */
export async function reopenSubmissionForOperatorRestart(
	db: DbClient,
	args: ReopenSubmissionForRestartArgs,
): Promise<ReopenSubmissionForRestartResult> {
	const current = await getSubmissionById(
		db,
		args.submissionId,
		args.organizationId,
	);
	if (!current) {
		return {
			reopened: false,
			alreadyRunning: false,
			submission: undefined,
			attempt: undefined,
		};
	}
	const currentMetadata = current.metadata ?? {};
	const hasRestartIdentity =
		typeof args.restartId === "string" &&
		args.restartId.length > 0 &&
		Number.isInteger(args.executionEpoch) &&
		(args.executionEpoch as number) >= 0;
	const sameRestartIdentity =
		hasRestartIdentity &&
		currentMetadata.workflowRestartId === args.restartId &&
		currentMetadata.workflowExecutionEpoch === args.executionEpoch;
	const active = current.status === "admitted" || current.status === "running";

	if (sameRestartIdentity) {
		// Repair only this exact command's narrow parent-CAS -> attempt-insert
		// crash window. A retry after the attempt was opened (or after the run
		// already settled again) is a pure deduplicated success.
		if (active && !current.currentAttemptId) {
			const started = await startAttempt(db, {
				submissionId: args.submissionId,
				organizationId: args.organizationId,
				runtimeBackend: args.runtimeBackend ?? current.runtimeBackend ?? null,
				runtimeExternalId: args.runtimeExternalId ?? current.runId ?? null,
				metadata: toJsonRecord({
					kind: "operator_restart_recovery",
					workflowRestartId: args.restartId,
					workflowExecutionEpoch: args.executionEpoch,
				}),
			});
			if (started.attempt) {
				return {
					reopened: true,
					alreadyRunning: false,
					submission: started.submission,
					attempt: started.attempt,
				};
			}
		}
		return {
			reopened: false,
			alreadyRunning: true,
			submission: current,
			attempt: undefined,
		};
	}

	if (active && !hasRestartIdentity) {
		// Recover the narrow crash window after the terminal parent row was reopened
		// but before its new attempt was appended. A retry completes that epoch
		// instead of treating an attempt-less parent as healthy running work.
		if (!current.currentAttemptId) {
			const started = await startAttempt(db, {
				submissionId: args.submissionId,
				organizationId: args.organizationId,
				runtimeBackend: args.runtimeBackend ?? current.runtimeBackend ?? null,
				runtimeExternalId: args.runtimeExternalId ?? current.runId ?? null,
				metadata: { kind: "operator_restart_recovery" },
			});
			if (started.attempt) {
				return {
					reopened: true,
					alreadyRunning: false,
					submission: started.submission,
					attempt: started.attempt,
				};
			}
			const raced = await getSubmissionById(
				db,
				args.submissionId,
				args.organizationId,
			);
			return {
				reopened: false,
				alreadyRunning: Boolean(raced?.currentAttemptId),
				submission: raced,
				attempt: undefined,
			};
		}
		return {
			reopened: false,
			alreadyRunning: true,
			submission: current,
			attempt: undefined,
		};
	}
	if (!active && !isTerminalSubmissionStatus(current.status)) {
		return {
			reopened: false,
			alreadyRunning: false,
			submission: current,
			attempt: undefined,
		};
	}

	const restartedAt = new Date().toISOString();
	const restartMetadata = {
		...currentMetadata,
		restartEpoch: (current.attemptCount ?? 0) + 1,
		lastOperatorRestartAt: restartedAt,
		...(hasRestartIdentity
			? {
					workflowRestartId: args.restartId,
					workflowExecutionEpoch: args.executionEpoch,
				}
			: {}),
	};
	const [reopened] = await db
		.update(runtimeSubmissions)
		.set({
			status: "admitted",
			currentAttemptId: null,
			settledAt: null,
			phase: "admitted",
			inputAppliedAt: null,
			// A new operator-restart epoch is a NEW intent to run: the previous
			// epoch's abort stamp must not survive the reopen, or any abort-honoring
			// recovery path would cancel the restarted epoch on sight.
			abortRequestedAt: null,
			timeoutAt: args.timeoutAt ?? current.timeoutAt ?? null,
			metadata: restartMetadata,
			updatedAt: restartedAt,
		})
		.where(
			and(
				eq(runtimeSubmissions.id, args.submissionId),
				eq(runtimeSubmissions.organizationId, args.organizationId),
				eq(runtimeSubmissions.status, current.status),
				current.currentAttemptId
					? eq(runtimeSubmissions.currentAttemptId, current.currentAttemptId)
					: isNull(runtimeSubmissions.currentAttemptId),
			),
		)
		.returning();
	if (!reopened) {
		const raced = await getSubmissionById(
			db,
			args.submissionId,
			args.organizationId,
		);
		const racedMetadata = raced?.metadata ?? {};
		const racedSameRestart =
			hasRestartIdentity &&
			racedMetadata.workflowRestartId === args.restartId &&
			racedMetadata.workflowExecutionEpoch === args.executionEpoch;
		return {
			reopened: false,
			alreadyRunning: Boolean(
				racedSameRestart ||
				(!hasRestartIdentity &&
					(raced?.status === "admitted" || raced?.status === "running")),
			),
			submission: raced,
			attempt: undefined,
		};
	}
	if (active && current.currentAttemptId) {
		await db
			.update(runtimeSubmissionAttempts)
			.set({
				status: "canceled",
				error: args.restartId
					? `superseded by workflow restart ${args.restartId}`
					: "superseded by operator restart",
				completedAt: restartedAt,
			})
			.where(
				and(
					eq(runtimeSubmissionAttempts.id, current.currentAttemptId),
					inArray(runtimeSubmissionAttempts.status, ["started", "recovered"]),
				),
			);
	}

	const started = await startAttempt(db, {
		submissionId: args.submissionId,
		organizationId: args.organizationId,
		runtimeBackend: args.runtimeBackend ?? current.runtimeBackend ?? null,
		runtimeExternalId: args.runtimeExternalId ?? current.runId ?? null,
		metadata: {
			kind: "operator_restart",
			restartedAt,
			previousOutcome: current.status,
			...(hasRestartIdentity
				? {
						workflowRestartId: args.restartId,
						workflowExecutionEpoch: args.executionEpoch,
					}
				: {}),
		},
	});
	return {
		reopened: !!started.attempt,
		alreadyRunning: false,
		submission: started.submission ?? reopened,
		attempt: started.attempt,
	};
}
