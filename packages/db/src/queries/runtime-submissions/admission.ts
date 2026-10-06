/** Durable admission with deterministic submission identity. */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { DbClient } from "../../client";
import type { TediRuntimeBackend } from "../../schema/cognitive-runtime";
import {
	type NewRuntimeSubmission,
	type RuntimeSubmission,
	type RuntimeSubmissionSourceKind,
	type RuntimeSubmissionSubjectKind,
	runtimeSubmissions,
} from "../../schema/runtime-submissions";
import { getSubmissionById } from "./read-models";

export interface AdmitSubmissionArgs {
	id?: string;
	organizationId: string;
	subjectKind: RuntimeSubmissionSubjectKind;
	subjectId: string;
	sourceKind: RuntimeSubmissionSourceKind;
	tediId?: string | null;
	conversationId?: string | null;
	runId?: string | null;
	idempotencyKey?: string | null;
	runtimeBackend?: TediRuntimeBackend | null;
	metadata?: Record<string, JsonValue> | null;
	/** Observer-readable wall-clock ceiling for this unit of work (ISO). */
	timeoutAt?: string | null;
	/**
	 * Durable cross-restart requeue budget. Bounds whole-turn re-executions in
	 * the recovery loop (attemptCount <= maxRetry).
	 * Omit to use the schema default (10); a requeue carries the prior value
	 * forward so the budget is per-logical-turn, not per-row.
	 */
	maxRetry?: number | null;
}

/**
 * Admit a unit of runtime work. Reusing a submission id within its organization
 * returns the existing submission instead of creating a second one.
 */
export async function admitSubmission(
	db: DbClient,
	args: AdmitSubmissionArgs,
): Promise<RuntimeSubmission> {
	const id = args.id ?? crypto.randomUUID();
	const values: NewRuntimeSubmission = {
		id,
		organizationId: args.organizationId,
		subjectKind: args.subjectKind,
		subjectId: args.subjectId,
		sourceKind: args.sourceKind,
		tediId: args.tediId ?? null,
		conversationId: args.conversationId ?? null,
		runId: args.runId ?? null,
		idempotencyKey: args.idempotencyKey ?? null,
		runtimeBackend: args.runtimeBackend ?? null,
		status: "admitted",
		attemptCount: 0,
		metadata: args.metadata ?? null,
		timeoutAt: args.timeoutAt ?? null,
		// Affirmative journal evidence recorded in the same write as admission: the
		// requeue gate demands phase === "admitted" as POSITIVE proof (a NULL phase
		// on a legacy/pre-migration row proves nothing and stays fail-conservative).
		// inputAppliedAt remains post-admit by definition — stamped exactly once on
		// the runtime's first run.started. Omit maxRetry to fall through to the
		// schema default (10) unless the caller overrides the durable requeue budget.
		phase: "admitted",
		...(args.maxRetry != null ? { maxRetry: args.maxRetry } : {}),
	};
	const [created] = await db
		.insert(runtimeSubmissions)
		.values(values)
		.onConflictDoNothing()
		.returning();
	if (created) return created;
	// Conflict → idempotent re-admit by the caller's deterministic submission id.
	const existingById = await getSubmissionById(db, id, args.organizationId);
	if (existingById) return existingById;
	throw new Error(`Failed to admit runtime submission: ${id}`);
}
