import { and, desc, eq } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import {
	skillRunEffectObservations,
	type SkillRunEffectObservation,
} from "../schema/skill-run-effects";

export interface RecordSkillRunEffectObservationParams {
	id: string;
	organizationId: string;
	skillRunId: string;
	workItemId: string | null;
	source: "human_attestation";
	observerUserId: string;
	observedState: SkillRunEffectObservation["observedState"];
	evidenceRef: string;
	effectNote: string;
	observedAt: string;
	createdAt: string;
}

/**
 * Append-only human observation. An identical user/evidence reference is an
 * idempotent retry; changing its meaning requires a distinct evidence ref.
 */
export async function recordSkillRunEffectObservation(
	db: DbQueryClient,
	input: RecordSkillRunEffectObservationParams,
): Promise<SkillRunEffectObservation> {
	const inserted = await db
		.insert(skillRunEffectObservations)
		.values(input)
		.onConflictDoNothing()
		.returning();
	if (inserted[0]) return inserted[0];
	const [existing] = await db
		.select()
		.from(skillRunEffectObservations)
		.where(
			and(
				eq(skillRunEffectObservations.organizationId, input.organizationId),
				eq(skillRunEffectObservations.skillRunId, input.skillRunId),
				eq(skillRunEffectObservations.observerUserId, input.observerUserId),
				eq(skillRunEffectObservations.evidenceRef, input.evidenceRef),
			),
		)
		.limit(1);
	if (
		!existing ||
		existing.workItemId !== input.workItemId ||
		existing.observedState !== input.observedState ||
		existing.effectNote !== input.effectNote
	)
		throw new Error(
			"Effect observation reference already has different content",
		);
	return existing;
}

/** A capped exact-run read; overflow must be treated as unknown by assessors. */
export async function listSkillRunEffectObservations(
	db: DbQueryClient,
	input: { organizationId: string; skillRunId: string; limit?: number },
): Promise<{ rows: SkillRunEffectObservation[]; truncated: boolean }> {
	const limit = Math.min(Math.max(input.limit ?? 5, 1), 10);
	const rows = await db
		.select()
		.from(skillRunEffectObservations)
		.where(
			and(
				eq(skillRunEffectObservations.organizationId, input.organizationId),
				eq(skillRunEffectObservations.skillRunId, input.skillRunId),
			),
		)
		.orderBy(
			desc(skillRunEffectObservations.createdAt),
			desc(skillRunEffectObservations.id),
		)
		.limit(limit + 1);
	return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}
