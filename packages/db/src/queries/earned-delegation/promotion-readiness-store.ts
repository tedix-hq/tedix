import type { EvidencePolicy } from "@tedix/api-contract/schemas/earned-delegation";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { DbClient } from "../../client";
import { chunkForBoundParams } from "../../utils/batch";
import {
	competencyObservationAttestations,
	competencyObservations,
} from "../../schema/earned-delegation";
import {
	EarnedDelegationError,
	readEvidenceRevision,
} from "./authority-policy";
import {
	evaluatePromotionReadiness,
	type PromotionReadiness,
} from "./promotion-readiness";

export async function loadPromotionReadiness(
	db: DbClient,
	input: {
		organizationId: string;
		tediId: string;
		activityId?: string | null;
		policy: EvidencePolicy;
		requiredEnvironments?: string[];
		now: string;
	},
): Promise<{ readiness: PromotionReadiness; evidenceRevision: number }> {
	const conditions = [
		eq(competencyObservations.organizationId, input.organizationId),
		eq(competencyObservations.tediId, input.tediId),
	];
	if (input.activityId) {
		conditions.push(eq(competencyObservations.activityId, input.activityId));
	}
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const beforeRevision = await readEvidenceRevision(db, input);
		const observations = await db
			.select()
			.from(competencyObservations)
			.where(and(...conditions))
			.orderBy(desc(competencyObservations.occurredAt));
		const attestations: (typeof competencyObservationAttestations.$inferSelect)[] =
			[];
		// D1 caps bound parameters at 100 per statement; chunk the id IN() list.
		for (const chunk of chunkForBoundParams(
			observations.map((observation) => observation.id),
			50,
		)) {
			attestations.push(
				...(await db
					.select()
					.from(competencyObservationAttestations)
					.where(
						and(
							eq(
								competencyObservationAttestations.organizationId,
								input.organizationId,
							),
							inArray(competencyObservationAttestations.observationId, chunk),
						),
					)),
			);
		}
		const afterRevision = await readEvidenceRevision(db, input);
		if (beforeRevision === afterRevision) {
			return {
				readiness: evaluatePromotionReadiness({
					policy: input.policy,
					observations,
					attestations,
					requiredEnvironments: input.requiredEnvironments,
					now: input.now,
				}),
				evidenceRevision: afterRevision,
			};
		}
	}
	throw new EarnedDelegationError(
		"conflict",
		"Certification evidence changed repeatedly while readiness was evaluated",
	);
}
