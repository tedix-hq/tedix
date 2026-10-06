import { and, eq, isNull, or } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	competencyObservations,
	delegationValueClaims,
	entrustableActivities,
} from "../../schema/earned-delegation";
import { harnessEvalRuns } from "../../schema/harness-versions";
import { workAttempts, workItems } from "../../schema/work-items";
import {
	advanceEvidenceRevision,
	EarnedDelegationError,
	hashSnapshot,
	requireScopedTedi,
} from "./authority-policy";

export async function recordCompetencyObservation(
	db: DbClient,
	input: {
		organizationId: string;
		tediId: string;
		executorType: "tedi" | "external_agent" | "service";
		executorId: string;
		evaluatorType: "user" | "api_key" | "certification_service";
		evaluatorId: string;
		activityId: string;
		clientObservationId: string;
		executionOpportunityId: string;
		workItemId?: string | null;
		sourceKind: string;
		sourceId: string;
		traceBundleId?: string | null;
		rationaleId?: string | null;
		environment: string;
		harness: string;
		harnessVersion: string;
		modelProvider: string;
		modelId: string;
		modelVersion: string;
		outcome: "success" | "partial" | "failure" | "unverified";
		complexity: number;
		nonTrivial: boolean;
		heldOut: boolean;
		calibrationScore: number;
		escalationQuality: number;
		learningTransfer: boolean;
		evidenceRefs: string[];
		classificationMethod: string;
		evaluationRunId?: string | null;
		proofVerifiedAt?: string | null;
		costMinorUnits?: number | null;
		costCurrency?: string | null;
		durationMs?: number | null;
		ownerReviewMinutes?: number | null;
		policyViolationSeverity?: number;
		confidence: number;
		metadata?: Record<string, unknown> | null;
		occurredAt: string;
		now: string;
	},
) {
	if (!input.evaluationRunId) {
		throw new EarnedDelegationError(
			"invalid_transition",
			"Validated observations require a canonical harness evaluation run",
		);
	}
	await requireScopedTedi(db, input.organizationId, input.tediId);
	const [activities, evaluationRuns] = await Promise.all([
		db
			.select()
			.from(entrustableActivities)
			.where(
				and(
					eq(entrustableActivities.id, input.activityId),
					eq(entrustableActivities.status, "active"),
					or(
						eq(entrustableActivities.organizationId, input.organizationId),
						isNull(entrustableActivities.organizationId),
					),
				),
			)
			.limit(1),
		db
			.select()
			.from(harnessEvalRuns)
			.where(
				and(
					eq(harnessEvalRuns.id, input.evaluationRunId),
					eq(harnessEvalRuns.tediId, input.tediId),
					or(
						eq(harnessEvalRuns.orgId, input.organizationId),
						isNull(harnessEvalRuns.orgId),
					),
				),
			)
			.limit(1),
	]);
	const activity = activities[0];
	const evaluationRun = evaluationRuns[0];
	if (!activity) {
		throw new EarnedDelegationError(
			"out_of_scope",
			"Entrustable activity is not active in this organization",
		);
	}
	if (!evaluationRun) {
		throw new EarnedDelegationError(
			"out_of_scope",
			"Evaluation run is not canonical for this tedi and organization",
		);
	}
	if (evaluationRun.createdAt > input.now) {
		throw new EarnedDelegationError(
			"invalid_transition",
			"Evaluation run cannot describe future work",
		);
	}
	const evaluationMetadata = evaluationRun.metadata ?? {};
	const trustedRecorder =
		evaluationMetadata.trustedForEarnedDelegation === true &&
		["user", "api_key", "service"].includes(
			typeof evaluationMetadata.recordedByPrincipalType === "string"
				? evaluationMetadata.recordedByPrincipalType
				: "",
		) &&
		typeof evaluationMetadata.recordedByPrincipalId === "string" &&
		evaluationMetadata.recordedByPrincipalId.length > 0;
	if (!trustedRecorder) {
		throw new EarnedDelegationError(
			"invalid_transition",
			"Evaluation run was not recorded by a trusted certification principal",
		);
	}
	const recorderType = evaluationMetadata.recordedByPrincipalType as
		| "user"
		| "api_key"
		| "service";
	const recorderId = evaluationMetadata.recordedByPrincipalId as string;
	const canonicalEvaluator =
		recorderType === "service"
			? {
					type: "certification_service" as const,
					id: recorderId,
				}
			: recorderType === "api_key"
				? {
						type: "api_key" as const,
						// All keys in one organization share a single evidence-author root,
						// so rotating keys cannot manufacture independent reviewers.
						id: `organization:${input.organizationId}`,
					}
				: { type: "user" as const, id: recorderId };
	if (
		evaluationMetadata.earnedDelegationActivityId !== activity.id ||
		evaluationMetadata.earnedDelegationActivityVersion !== activity.version ||
		evaluationMetadata.earnedDelegationRubricHash !== activity.rubricHash
	) {
		throw new EarnedDelegationError(
			"out_of_scope",
			"Evaluation run is not bound to this activity version and rubric",
		);
	}
	const boundedNumber = (key: string, fallback = 0) => {
		const value = evaluationMetadata[key];
		return typeof value === "number" && Number.isFinite(value)
			? Math.min(1, Math.max(0, value))
			: fallback;
	};
	const nonnegativeInteger = (
		key: string,
		maximum = Number.MAX_SAFE_INTEGER,
	) => {
		const value = evaluationMetadata[key];
		return typeof value === "number" &&
			Number.isSafeInteger(value) &&
			value >= 0 &&
			value <= maximum
			? value
			: null;
	};
	const nonnegativeNumber = (
		key: string,
		maximum = Number.MAX_SAFE_INTEGER,
	) => {
		const value = evaluationMetadata[key];
		return typeof value === "number" &&
			Number.isFinite(value) &&
			value >= 0 &&
			value <= maximum
			? value
			: null;
	};
	const nonemptyString = (key: string, maximumLength: number) => {
		const value = evaluationMetadata[key];
		return typeof value === "string" &&
			value.length > 0 &&
			value.length <= maximumLength
			? value
			: null;
	};
	const canonicalOutcome =
		evaluationRun.total <= 0
			? ("unverified" as const)
			: evaluationRun.failed === 0 && evaluationRun.eligible
				? ("success" as const)
				: evaluationRun.passed > 0
					? ("partial" as const)
					: ("failure" as const);
	const canonicalHeldOut = ["locked-test", "canary"].includes(
		evaluationRun.lane,
	);
	const canonicalNonTrivial = evaluationMetadata.nonTrivial === true;
	const canonicalEvidenceRefs = [`harness-eval-run:${evaluationRun.id}`];
	const canonicalExecutionOpportunityId = await hashSnapshot({
		organizationId: input.organizationId,
		tediId: input.tediId,
		evaluationRunId: evaluationRun.id,
	});
	const evaluationCostMinorUnits = nonnegativeInteger(
		"costMinorUnits",
		9_000_000_000,
	);
	const evaluationCostCurrency =
		typeof evaluationMetadata.costCurrency === "string" &&
		/^[A-Z]{3}$/.test(evaluationMetadata.costCurrency)
			? evaluationMetadata.costCurrency
			: null;
	const hasCompleteCost =
		evaluationCostMinorUnits !== null && evaluationCostCurrency !== null;
	const evaluationValueMinorUnits = nonnegativeInteger(
		"verifiedValueMinorUnits",
		9_000_000_000,
	);
	const evaluationValueCurrency =
		typeof evaluationMetadata.verifiedValueCurrency === "string" &&
		/^[A-Z]{3}$/.test(evaluationMetadata.verifiedValueCurrency)
			? evaluationMetadata.verifiedValueCurrency
			: null;
	const evaluationValueEventId = nonemptyString("verifiedValueEventId", 200);
	const evaluationValueEvidenceRef = nonemptyString(
		"verifiedValueEvidenceRef",
		500,
	);
	const hasCompleteValue =
		evaluationValueMinorUnits !== null &&
		evaluationValueCurrency !== null &&
		evaluationValueEventId !== null &&
		evaluationValueEvidenceRef !== null;
	const canonicalObservation = {
		executionOpportunityId: canonicalExecutionOpportunityId,
		sourceKind: "harness_eval_run",
		sourceId: evaluationRun.id,
		environment:
			typeof evaluationMetadata.environment === "string"
				? evaluationMetadata.environment
				: "evaluation",
		harness: "harness_eval_run",
		harnessVersion: evaluationRun.harnessVersionId,
		modelProvider:
			typeof evaluationMetadata.modelProvider === "string"
				? evaluationMetadata.modelProvider
				: "unknown",
		modelId:
			typeof evaluationMetadata.modelId === "string"
				? evaluationMetadata.modelId
				: "unknown",
		modelVersion:
			typeof evaluationMetadata.modelVersion === "string"
				? evaluationMetadata.modelVersion
				: "unknown",
		outcome: canonicalOutcome,
		complexity: boundedNumber("complexity"),
		nonTrivial: canonicalNonTrivial,
		heldOut: canonicalHeldOut,
		calibrationScore: boundedNumber("calibrationScore"),
		escalationQuality: boundedNumber("escalationQuality"),
		learningTransfer: evaluationMetadata.learningTransfer === true,
		evidenceRefs: canonicalEvidenceRefs,
		classificationMethod: `canonical_harness_eval_run:${evaluationRun.lane}`,
		evaluationRunId: evaluationRun.id,
		proofVerifiedAt: evaluationRun.createdAt,
		costMinorUnits: hasCompleteCost ? evaluationCostMinorUnits : null,
		costCurrency: hasCompleteCost ? evaluationCostCurrency : null,
		durationMs: nonnegativeInteger("durationMs"),
		ownerReviewMinutes: nonnegativeNumber("ownerReviewMinutes", 525_600),
		policyViolationSeverity: nonnegativeInteger("policyViolationSeverity") ?? 0,
		confidence: boundedNumber(
			"confidence",
			Math.min(1, Math.max(0, evaluationRun.meanScore)),
		),
		metadata: {
			...input.metadata,
			experienceClusterId: evaluationRun.taskSetId,
			evaluationLane: evaluationRun.lane,
			canonicalEvaluationRunId: evaluationRun.id,
			verifiedValueMinorUnits: hasCompleteValue
				? evaluationValueMinorUnits
				: null,
			verifiedValueCurrency: hasCompleteValue ? evaluationValueCurrency : null,
			verifiedValueEventId: hasCompleteValue ? evaluationValueEventId : null,
			verifiedValueEvidenceRef: hasCompleteValue
				? evaluationValueEvidenceRef
				: null,
		},
		occurredAt: evaluationRun.createdAt,
	};
	const inputHash = await hashSnapshot({
		organizationId: input.organizationId,
		tediId: input.tediId,
		executorType: input.executorType,
		executorId: input.executorId,
		evaluatorType: canonicalEvaluator.type,
		evaluatorId: canonicalEvaluator.id,
		activityId: input.activityId,
		clientObservationId: input.clientObservationId,
		workItemId: input.workItemId ?? null,
		...canonicalObservation,
	});
	const eligible =
		input.executorType === "tedi" &&
		input.executorId === input.tediId &&
		canonicalOutcome !== "unverified" &&
		canonicalNonTrivial &&
		canonicalHeldOut;
	let economicWorkCertified = false;
	if (input.workItemId) {
		const scopedWork = await db
			.select({
				id: workItems.id,
				status: workItems.disposition,
				metadata: workItems.metadata,
				completedAt: workItems.completedAt,
			})
			.from(workItems)
			.where(
				and(
					eq(workItems.id, input.workItemId),
					eq(workItems.orgId, input.organizationId),
				),
			)
			.limit(1);
		if (!scopedWork[0]) {
			throw new EarnedDelegationError(
				"out_of_scope",
				"Work Item evidence is outside this organization",
			);
		}
		if (hasCompleteValue) {
			const work = scopedWork[0];
			const proofCertifiedAt =
				work.metadata && typeof work.metadata.proofCertifiedAt === "string"
					? work.metadata.proofCertifiedAt
					: null;
			if (
				!eligible ||
				work.status !== "completed" ||
				!work.completedAt ||
				proofCertifiedAt !== work.completedAt
			) {
				throw new EarnedDelegationError(
					"ineligible",
					"Economic value requires proof-certified completed work executed by this tedi",
				);
			}
			const [executorCheckouts, legacyCheckouts] = await Promise.all([
				db
					.select({ id: workAttempts.id })
					.from(workAttempts)
					.where(
						and(
							eq(workAttempts.orgId, input.organizationId),
							eq(workAttempts.workItemId, input.workItemId),
							eq(workAttempts.executorType, "tedi"),
							eq(workAttempts.executorId, input.tediId),
							eq(workAttempts.runtimeState, "finished"),
							eq(workAttempts.finishedAt, work.completedAt),
						),
					)
					.limit(1),
				db
					.select({ id: workAttempts.id })
					.from(workAttempts)
					.where(
						and(
							eq(workAttempts.orgId, input.organizationId),
							eq(workAttempts.workItemId, input.workItemId),
							eq(workAttempts.executorId, input.tediId),
							eq(workAttempts.runtimeState, "finished"),
							eq(workAttempts.finishedAt, work.completedAt),
						),
					)
					.limit(1),
			]);
			if (!executorCheckouts[0] && !legacyCheckouts[0]) {
				throw new EarnedDelegationError(
					"ineligible",
					"Work Item completion is not attributed to this tedi",
				);
			}
			economicWorkCertified = true;
		}
	} else if (hasCompleteValue) {
		throw new EarnedDelegationError(
			"ineligible",
			"Economic value requires a proof-certified issued Work Item",
		);
	}
	const findExisting = () =>
		db
			.select()
			.from(competencyObservations)
			.where(
				and(
					eq(competencyObservations.organizationId, input.organizationId),
					eq(
						competencyObservations.clientObservationId,
						input.clientObservationId,
					),
				),
			)
			.limit(1);
	const assertIdempotent = (
		existing: typeof competencyObservations.$inferSelect,
	) => {
		if (existing.inputHash !== inputHash) {
			throw new EarnedDelegationError(
				"conflict",
				"Observation idempotency key was reused with different evidence",
			);
		}
		return existing;
	};
	const beforeInsert = await findExisting();
	if (beforeInsert[0]) return assertIdempotent(beforeInsert[0]);

	const observationId = crypto.randomUUID();
	const insertObservation = db
		.insert(competencyObservations)
		.values({
			id: observationId,
			organizationId: input.organizationId,
			tediId: input.tediId,
			executorType: input.executorType,
			executorId: input.executorId,
			activityId: input.activityId,
			clientObservationId: input.clientObservationId,
			inputHash,
			executionOpportunityId: canonicalObservation.executionOpportunityId,
			workItemId: input.workItemId ?? null,
			sourceKind: canonicalObservation.sourceKind,
			sourceId: canonicalObservation.sourceId,
			traceBundleId: input.traceBundleId ?? null,
			rationaleId: input.rationaleId ?? null,
			taskFamily: activity.taskFamily,
			riskLevel: activity.riskLevel,
			environment: canonicalObservation.environment,
			rubricVersion: activity.version,
			harness: canonicalObservation.harness,
			harnessVersion: canonicalObservation.harnessVersion,
			modelProvider: canonicalObservation.modelProvider,
			modelId: canonicalObservation.modelId,
			modelVersion: canonicalObservation.modelVersion,
			outcome: canonicalObservation.outcome,
			complexity: canonicalObservation.complexity,
			nonTrivial: canonicalObservation.nonTrivial,
			heldOut: canonicalObservation.heldOut,
			calibrationScore: canonicalObservation.calibrationScore,
			escalationQuality: canonicalObservation.escalationQuality,
			learningTransfer: canonicalObservation.learningTransfer,
			evidenceRefs: canonicalObservation.evidenceRefs,
			eligibilityStatus: eligible ? "eligible" : "ineligible",
			evaluatorType: canonicalEvaluator.type,
			evaluatorId: canonicalEvaluator.id,
			classificationMethod: canonicalObservation.classificationMethod,
			evaluationRunId: canonicalObservation.evaluationRunId,
			proofVerifiedAt: canonicalObservation.proofVerifiedAt,
			costMinorUnits: canonicalObservation.costMinorUnits,
			costCurrency: canonicalObservation.costCurrency,
			durationMs: canonicalObservation.durationMs,
			ownerReviewMinutes: canonicalObservation.ownerReviewMinutes,
			policyViolationSeverity: canonicalObservation.policyViolationSeverity,
			confidence: canonicalObservation.confidence,
			metadata: canonicalObservation.metadata,
			occurredAt: canonicalObservation.occurredAt,
			createdAt: input.now,
		})
		.returning();
	try {
		const evidenceRevision = advanceEvidenceRevision(db, {
			organizationId: input.organizationId,
			tediId: input.tediId,
			now: input.now,
		});
		const [rows] = economicWorkCertified
			? await db.batch([
					insertObservation,
					db.insert(delegationValueClaims).values({
						id: crypto.randomUUID(),
						organizationId: input.organizationId,
						tediId: input.tediId,
						observationId,
						workItemId: input.workItemId!,
						evaluationRunId: evaluationRun.id,
						executorType: "tedi",
						executorId: input.tediId,
						valueEventId: evaluationValueEventId!,
						valueEvidenceRef: evaluationValueEvidenceRef!,
						valueMinorUnits: evaluationValueMinorUnits!,
						currency: evaluationValueCurrency!,
						createdAt: input.now,
					}),
					evidenceRevision,
				])
			: await db.batch([insertObservation, evidenceRevision]);
		if (rows[0]) return rows[0];
	} catch (error) {
		const conflicted = await findExisting();
		if (conflicted[0]) return assertIdempotent(conflicted[0]);
		if (economicWorkCertified) {
			throw new EarnedDelegationError(
				"conflict",
				"Economic value event or accounting evidence is already attributed",
			);
		}
		throw error;
	}
	throw new EarnedDelegationError("conflict", "Observation write conflicted");
}
