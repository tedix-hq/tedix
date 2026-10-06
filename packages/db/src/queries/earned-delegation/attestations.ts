import { and, eq } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	competencyObservationAttestations,
	competencyObservations,
} from "../../schema/earned-delegation";
import {
	advanceEvidenceRevision,
	EarnedDelegationError,
} from "./authority-policy";

export async function attestCompetencyObservation(
	db: DbClient,
	input: {
		organizationId: string;
		observationId: string;
		principalType:
			| "user"
			| "api_key"
			| "certification_service"
			| "external_agent";
		principalId: string;
		verdict: "supports" | "rejects";
		verificationMethod: string;
		authenticatedAt: string;
		now: string;
	},
) {
	const observations = await db
		.select()
		.from(competencyObservations)
		.where(
			and(
				eq(competencyObservations.id, input.observationId),
				eq(competencyObservations.organizationId, input.organizationId),
			),
		)
		.limit(1);
	const observation = observations[0];
	if (!observation)
		throw new EarnedDelegationError("not_found", "Observation not found");
	const independenceVerified =
		input.principalId !== observation.tediId &&
		input.principalId !== observation.executorId &&
		(input.principalType !== observation.evaluatorType ||
			input.principalId !== observation.evaluatorId);
	const findExisting = () =>
		db
			.select()
			.from(competencyObservationAttestations)
			.where(
				and(
					eq(
						competencyObservationAttestations.observationId,
						input.observationId,
					),
					eq(
						competencyObservationAttestations.principalType,
						input.principalType,
					),
					eq(competencyObservationAttestations.principalId, input.principalId),
				),
			)
			.limit(1);
	const assertIdempotent = (
		existing: typeof competencyObservationAttestations.$inferSelect,
	) => {
		if (
			existing.verdict !== input.verdict ||
			existing.verificationMethod !== input.verificationMethod
		) {
			throw new EarnedDelegationError(
				"conflict",
				"Attestation principal already submitted a different verdict",
			);
		}
		return existing;
	};
	const beforeInsert = await findExisting();
	if (beforeInsert[0]) return assertIdempotent(beforeInsert[0]);

	const insertAttestation = db
		.insert(competencyObservationAttestations)
		.values({
			id: crypto.randomUUID(),
			organizationId: input.organizationId,
			observationId: input.observationId,
			principalType: input.principalType,
			principalId: input.principalId,
			verdict: input.verdict,
			verificationMethod: input.verificationMethod,
			independenceVerified,
			authenticatedAt: input.authenticatedAt,
			createdAt: input.now,
		})
		.returning();
	try {
		const [rows] = await db.batch([
			insertAttestation,
			advanceEvidenceRevision(db, {
				organizationId: input.organizationId,
				tediId: observation.tediId,
				now: input.now,
			}),
		]);
		if (rows[0]) return rows[0];
	} catch (error) {
		const conflicted = await findExisting();
		if (conflicted[0]) return assertIdempotent(conflicted[0]);
		throw error;
	}
	throw new EarnedDelegationError("conflict", "Attestation write conflicted");
}
