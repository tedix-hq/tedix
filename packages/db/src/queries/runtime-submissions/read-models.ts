/** Submission and attempt read models, including recovery queues. */

import { and, desc, eq, lt } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	type RuntimeSubmission,
	type RuntimeSubmissionAttempt,
	runtimeSubmissionAttempts,
	runtimeSubmissions,
} from "../../schema/runtime-submissions";

export type { RuntimeSubmission, RuntimeSubmissionAttempt };

export async function getSubmissionById(
	db: DbClient,
	id: string,
	organizationId: string,
): Promise<RuntimeSubmission | undefined> {
	const rows = await db
		.select()
		.from(runtimeSubmissions)
		.where(
			and(
				eq(runtimeSubmissions.id, id),
				eq(runtimeSubmissions.organizationId, organizationId),
			),
		)
		.limit(1);
	return rows[0];
}

export async function getSubmissionByIdempotencyKey(
	db: DbClient,
	organizationId: string,
	idempotencyKey: string,
): Promise<RuntimeSubmission | undefined> {
	const rows = await db
		.select()
		.from(runtimeSubmissions)
		.where(
			and(
				eq(runtimeSubmissions.organizationId, organizationId),
				eq(runtimeSubmissions.idempotencyKey, idempotencyKey),
			),
		)
		.limit(1);
	return rows[0];
}

export async function listSubmissionsByRun(
	db: DbClient,
	organizationId: string,
	runId: string,
): Promise<RuntimeSubmission[]> {
	return db
		.select()
		.from(runtimeSubmissions)
		.where(
			and(
				eq(runtimeSubmissions.organizationId, organizationId),
				eq(runtimeSubmissions.runId, runId),
			),
		)
		.orderBy(desc(runtimeSubmissions.createdAt));
}

export async function listAttemptsBySubmission(
	db: DbClient,
	submissionId: string,
): Promise<RuntimeSubmissionAttempt[]> {
	return db
		.select()
		.from(runtimeSubmissionAttempts)
		.where(eq(runtimeSubmissionAttempts.submissionId, submissionId))
		.orderBy(runtimeSubmissionAttempts.attemptNo);
}

/**
 * Submissions still marked running past a freshness threshold — recovery
 * candidates for the kernel reconciliation sweep (kernel-do.ts). Org-scoped,
 * all subjects; the sweep dispatches by subjectKind.
 */
export async function listStaleRunningSubmissions(
	db: DbClient,
	organizationId: string,
	olderThanIso: string,
	limit = 50,
): Promise<RuntimeSubmission[]> {
	return db
		.select()
		.from(runtimeSubmissions)
		.where(
			and(
				eq(runtimeSubmissions.organizationId, organizationId),
				eq(runtimeSubmissions.status, "running"),
				lt(runtimeSubmissions.updatedAt, olderThanIso),
			),
		)
		.orderBy(runtimeSubmissions.updatedAt)
		.limit(limit);
}

/**
 * Submissions stuck in the non-terminal `reserved` latch past a freshness
 * threshold — the runtime won the settle CAS (Step A) but died before committing
 * the finalize (Step B). The kernel reserved sweep re-drives Step B from each
 * row's recorded `metadata.reservedOutcome`. Org-scoped, all subjects; the sweep
 * dispatches by subjectKind. Mirrors listStaleRunningSubmissions.
 */
export async function listPendingReservedSubmissions(
	db: DbClient,
	organizationId: string,
	olderThanIso: string,
	limit = 50,
): Promise<RuntimeSubmission[]> {
	return db
		.select()
		.from(runtimeSubmissions)
		.where(
			and(
				eq(runtimeSubmissions.organizationId, organizationId),
				eq(runtimeSubmissions.status, "reserved"),
				lt(runtimeSubmissions.updatedAt, olderThanIso),
			),
		)
		.orderBy(runtimeSubmissions.updatedAt)
		.limit(limit);
}
