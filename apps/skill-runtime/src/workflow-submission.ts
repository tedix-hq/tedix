import { createDbClient } from "@tedix/db/client";
import { admitSubmission } from "@tedix/db/queries/runtime-submissions/admission";
import {
	reopenSubmissionForOperatorRestart,
	startAttempt,
} from "@tedix/db/queries/runtime-submissions/attempts";
import {
	getSubmissionById,
	type RuntimeSubmission,
} from "@tedix/db/queries/runtime-submissions/read-models";
import {
	isTerminalSubmissionStatus,
	type SubmissionSettleOutcome,
	settleSubmission,
} from "@tedix/db/queries/runtime-submissions/settlement";

type TerminalWorkflowStatus = "completed" | "failed" | "canceled";

export async function ensureWorkflowSubmissionStarted(args: {
	db: D1Database;
	runId: string;
	organizationId: string;
	tediId: string;
}): Promise<boolean> {
	const db = createDbClient(args.db);
	const submission = await admitSubmission(db, {
		id: `sub:${args.runId}`,
		organizationId: args.organizationId,
		subjectKind: "tedi",
		subjectId: args.tediId,
		sourceKind: "skill_workflow",
		tediId: args.tediId,
		runId: args.runId,
		idempotencyKey: args.runId,
		timeoutAt: new Date(Date.now() + 15 * 60_000).toISOString(),
		metadata: { workflowExecutionEpoch: 0 },
	});
	if (submission.status === "admitted" && submission.attemptCount === 0) {
		const started = await startAttempt(db, {
			submissionId: submission.id,
			organizationId: args.organizationId,
			runtimeExternalId: args.runId,
			metadata: {
				kind: "skill_workflow_admission",
				workflowExecutionEpoch: 0,
			},
		});
		return Boolean(started.attempt || started.submission);
	}
	return submission.status === "running";
}

export async function ensureWorkflowRestartSubmissionAttempt(args: {
	db: D1Database;
	runId: string;
	organizationId: string;
	restartId: string;
	executionEpoch: number;
}): Promise<boolean> {
	const result = await reopenSubmissionForOperatorRestart(
		createDbClient(args.db),
		{
			submissionId: `sub:${args.runId}`,
			organizationId: args.organizationId,
			restartId: args.restartId,
			executionEpoch: args.executionEpoch,
			runtimeExternalId: args.runId,
		},
	);
	return result.reopened || result.alreadyRunning;
}

/**
 * Materialize a verified no-start restart epoch in the submission ledger and
 * close it as canceled. Receipt rejection happens before this call, so a late
 * workflow factory cannot start the burned epoch; exact identity makes every
 * retry idempotent after either the reopen or settlement boundary.
 */
export async function settleAbortedWorkflowRestartSubmission(args: {
	db: D1Database;
	runId: string;
	organizationId: string;
	restartId: string;
	executionEpoch: number;
}): Promise<boolean> {
	const ready = await ensureWorkflowRestartSubmissionAttempt(args);
	if (!ready) return false;
	return settleWorkflowSubmissionBeforeTerminal({
		db: args.db,
		runId: args.runId,
		organizationId: args.organizationId,
		executionEpoch: args.executionEpoch,
		status: "canceled",
	});
}

function submissionOutcome(
	status: TerminalWorkflowStatus,
): SubmissionSettleOutcome {
	if (status === "completed") return "settled";
	if (status === "failed") return "failed";
	return "canceled";
}

export function workflowSubmissionOutcomeMatches(
	submissionStatus: string,
	workflowStatus: TerminalWorkflowStatus,
): boolean {
	return submissionStatus === submissionOutcome(workflowStatus);
}

function submissionEpochMatches(actual: unknown, expected: number): boolean {
	return expected === 0 ? actual == null || actual === 0 : actual === expected;
}

/**
 * Whether a durable operator abort belongs to the active skill-workflow epoch.
 *
 * The API writes this intent before its best-effort `/cancel` RPC. Reconciliation
 * is the delivery repair path when that RPC is lost: only an active
 * `skill_workflow` submission for this exact epoch may drive a native
 * termination. Terminal/reserved rows are deliberately excluded so completed
 * work and an in-progress settle always win.
 */
export function workflowSubmissionHasAbortIntent(
	submission:
		| Pick<
				RuntimeSubmission,
				"abortRequestedAt" | "metadata" | "sourceKind" | "status"
		  >
		| undefined,
	executionEpoch: number,
): boolean {
	if (submission?.sourceKind !== "skill_workflow") return false;
	if (
		submission.abortRequestedAt == null ||
		(submission.status !== "admitted" && submission.status !== "running")
	) {
		return false;
	}
	return submissionEpochMatches(
		submission.metadata?.workflowExecutionEpoch,
		executionEpoch,
	);
}

/** Read the active epoch's durable abort intent for skill-runtime recovery. */
export async function hasWorkflowSubmissionAbortIntent(args: {
	db: D1Database;
	runId: string;
	organizationId: string;
	executionEpoch: number;
}): Promise<boolean> {
	const submission = await getSubmissionById(
		createDbClient(args.db),
		`sub:${args.runId}`,
		args.organizationId,
	);
	return workflowSubmissionHasAbortIntent(submission, args.executionEpoch);
}

/**
 * Settle the matching durable submission before projecting a terminal
 * `skill_runs` state. False means the submission is missing, belongs to a
 * different execution epoch, or is still non-terminal; callers must leave the
 * run active so admission/restart repair can complete and retry safely.
 */
export async function settleWorkflowSubmissionBeforeTerminal(args: {
	db: D1Database;
	runId: string;
	organizationId: string;
	executionEpoch: number;
	status: string;
	error?: string | null;
}): Promise<boolean> {
	if (
		args.status !== "completed" &&
		args.status !== "failed" &&
		args.status !== "canceled"
	) {
		return false;
	}
	const terminalStatus: TerminalWorkflowStatus = args.status;
	const result = await settleSubmission(createDbClient(args.db), {
		submissionId: `sub:${args.runId}`,
		organizationId: args.organizationId,
		outcome: submissionOutcome(terminalStatus),
		error: terminalStatus === "failed" ? (args.error ?? null) : null,
		expectedWorkflowExecutionEpoch: args.executionEpoch,
	});
	const submission = result.submission;
	if (!submission) return false;
	if (
		!submissionEpochMatches(
			submission.metadata?.workflowExecutionEpoch,
			args.executionEpoch,
		)
	) {
		return false;
	}
	return (
		isTerminalSubmissionStatus(submission.status) &&
		workflowSubmissionOutcomeMatches(submission.status, terminalStatus)
	);
}
