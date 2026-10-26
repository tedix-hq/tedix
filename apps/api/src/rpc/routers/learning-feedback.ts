import { archiveCorrectedAgentLessons } from "@tedix/db/queries/memory-graph/agent-lessons";
import { implement } from "@orpc/server";
import {
	recordDecisionExposure,
	readDecisionInstrumentation,
	readDecisionCalibration,
} from "../../services/decision-instrumentation";
import { readDecisionLearning } from "../../services/decision-learning";
import { setDecisionLearningConfig } from "@tedix/db/queries/decision-learning";
import { learningFeedbackContract } from "@tedix/api-contract/contracts/learning-feedback";
import { DecisionCardPresentationSchema } from "@tedix/api-contract/schemas/decision-card-presentation";
import type {
	LearningScopeKind,
	LearningSubjectKind,
} from "@tedix/api-contract/schemas/learning-feedback";
import {
	analyzeRecurringLearningIssues,
	getLearningFeedbackSummary,
	LearningFeedbackIdempotencyConflictError,
	summarizeLearningFeedback,
	validateLearningMeasurementPair,
} from "@tedix/db/queries/learning-feedback";
import { getTediById } from "@tedix/db/queries/tedis";
import { toJsonRecord } from "@tedix/db/utils/json";
import {
	attributeLearningFeedback,
	getLearningAttributionById,
	getLearningAttributionsForEvents,
	getLearningImprovementProposal,
	getLearningInteractionsByIds,
	getLearningMeasurementsByIds,
	listLearningImprovementProposals,
	listLearningInteractions,
	proposeLearningImprovement,
	recordLearningInteraction,
	recordLearningMeasurement,
	updateLearningImprovementProposal,
} from "../../services/learning-feedback-persistence";
import { requireOrgId } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
	withAuthorization,
	userHoldsPermission,
} from "../orpc";

const learningFeedbackOs = implement(
	learningFeedbackContract,
).$context<BaseContext>();
const authed = learningFeedbackOs.use(withAuth);

export function resolveLearningActor(
	context: Pick<
		BaseContext,
		| "authType"
		| "user"
		| "tediId"
		| "descopeUserId"
		| "serviceAccount"
		| "apiKey"
	>,
): {
	actorType: "user" | "tedi" | "service" | "api_key" | "unknown";
	actorId: string | null;
} {
	if (context.authType === "service-binding" && context.descopeUserId) {
		return { actorType: "user", actorId: context.descopeUserId };
	}
	if (context.authType === "user") {
		return {
			actorType: "user",
			actorId: typeof context.user?.sub === "string" ? context.user.sub : null,
		};
	}
	if (context.authType === "tedi") {
		return {
			actorType: "tedi",
			actorId: context.tediId ?? context.descopeUserId ?? null,
		};
	}
	if (context.authType === "apikey") {
		return { actorType: "api_key", actorId: context.apiKey?.id ?? null };
	}
	if (context.authType === "service-binding" || context.authType === "m2m") {
		return {
			actorType: "service",
			actorId: context.serviceAccount?.clientId ?? null,
		};
	}
	return { actorType: "unknown", actorId: null };
}

export function canAccessLearningEvent(
	actorId: string | null,
	event: { scopeKind: LearningScopeKind; scopeId: string },
): boolean {
	return event.scopeKind !== "personal" || event.scopeId === actorId;
}

async function withIdempotencyConflict<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (error instanceof LearningFeedbackIdempotencyConflictError) {
			throw createError(ErrorCodes.CONFLICT, error.message);
		}
		throw error;
	}
}

export function resolveLearningScope(input: {
	kind: LearningScopeKind;
	requestedId?: string;
	organizationId: string;
	actorId: string | null;
	tediId?: string;
}): string {
	switch (input.kind) {
		case "personal":
			if (!input.actorId) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Personal learning scope requires an authenticated actor identity",
				);
			}
			return input.actorId;
		case "tedi":
			if (!input.tediId) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Tedi learning scope requires a tediId",
				);
			}
			if (input.requestedId && input.requestedId !== input.tediId) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Tedi learning scope id must match the selected tedi",
				);
			}
			return input.tediId;
		case "organization":
			return input.organizationId;
		case "project":
		case "workflow":
			if (!input.requestedId) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					`${input.kind} learning scope requires an id`,
				);
			}
			return input.requestedId;
	}
}

async function resolveAccessibleTediId(
	context: BaseContext,
	requestedTediId?: string,
): Promise<string | undefined> {
	const tediId = requestedTediId ?? context.tediId;
	if (!tediId) return undefined;
	if (context.tediId && context.tediId !== tediId) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Cannot record feedback for another tedi",
		);
	}
	const tedi = await getTediById(context.db, tediId);
	if (!tedi) throw createError(ErrorCodes.NOT_FOUND, "Tedi not found");
	if (tedi.organizationId !== requireOrgId(context)) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Tedi belongs to another organization",
		);
	}
	return tediId;
}

export function isHumanLearningReviewer(
	context: Pick<BaseContext, "authType" | "user">,
): boolean {
	return context.authType === "user" && Boolean(context.user?.sub);
}

export function learningScopeCanNominateSubject(input: {
	scopeKind: LearningScopeKind;
	scopeId: string;
	tediId: string | null;
	subjectKind: LearningSubjectKind;
	subjectId: string;
	actorType: ReturnType<typeof resolveLearningActor>["actorType"];
	actorId: string | null;
}): boolean {
	switch (input.scopeKind) {
		case "personal":
			return (
				input.actorType === "user" &&
				input.actorId === input.scopeId &&
				input.subjectKind === "memory_fact"
			);
		case "tedi":
			return input.tediId !== null && input.scopeId === input.tediId;
		case "workflow":
			return (
				input.subjectKind === "workflow" && input.subjectId === input.scopeId
			);
		case "organization":
			return input.actorType === "user";
		case "project":
			return false;
	}
}

const recordInteraction = authed.recordInteraction
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"A person may record their own personal signals; other scopes retain tedi update permission",
			},
			"tedis:write",
		),
	)
	.handler(async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		const actor = resolveLearningActor(context);
		if (
			context.authType === "user" &&
			input.scope.kind !== "personal" &&
			!userHoldsPermission(context, "tedis:update")
		)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Shared learning requires tedi update permission",
			);
		const tediId = await resolveAccessibleTediId(context, input.tediId);
		const scopeId = resolveLearningScope({
			kind: input.scope.kind,
			requestedId: input.scope.id,
			organizationId,
			actorId: actor.actorId,
			tediId,
		});
		return withIdempotencyConflict(() =>
			recordLearningInteraction(context.db, {
				organizationId,
				...actor,
				tediId,
				clientEventId: input.clientEventId,
				signalClass: input.signalClass,
				eventKind: input.eventKind,
				scopeKind: input.scope.kind,
				scopeId,
				issueKey: input.issueKey,
				surface: input.surface,
				targetType: input.targetType,
				targetId: input.targetId,
				threadId: input.threadId,
				runId: input.runId,
				metadata:
					input.metadata === undefined
						? undefined
						: toJsonRecord({
								...input.metadata,
								preferenceSource: null,
								preferenceSentence: null,
								preferenceEvidenceEventId: null,
								learningCorrection: false,
								serverObserved: false,
							}),
				occurredAt: input.occurredAt ?? new Date().toISOString(),
			}),
		);
	});

const listInteractions = authed.listInteractions
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		const actor = resolveLearningActor(context);
		const tediId = await resolveAccessibleTediId(context, input.tediId);
		const events = await listLearningInteractions(context.db, {
			organizationId,
			tediId,
			personalScopeId: actor.actorId,
			eventKind: input.eventKind,
			scopeKind: input.scopeKind,
			scopeId: input.scopeId,
			issueKey: input.issueKey,
			surfaces: input.surfaces,
			since: input.since,
			until: input.until,
			limit: input.limit,
		});
		return { events };
	});

const attributeFeedback = authed.attributeFeedback
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		const actor = resolveLearningActor(context);
		const events = await getLearningInteractionsByIds(
			context.db,
			organizationId,
			input.feedbackEventIds,
		);
		if (events.length !== new Set(input.feedbackEventIds).size) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				"One or more learning feedback events were not found",
			);
		}
		if (events.some((event) => !canAccessLearningEvent(actor.actorId, event))) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Cannot attribute another actor's personal learning feedback",
			);
		}
		if (
			context.tediId &&
			events.some((event) => event.tediId !== context.tediId)
		) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Cannot attribute feedback recorded for another tedi",
			);
		}
		return withIdempotencyConflict(() =>
			attributeLearningFeedback(context.db, {
				organizationId,
				clientAttributionId: input.clientAttributionId,
				feedbackEventIds: [...new Set(input.feedbackEventIds)],
				subjectKind: input.subjectKind,
				subjectId: input.subjectId,
				changeKind: input.changeKind,
				rationale: input.rationale,
				evidenceRefs: input.evidenceRefs,
				metadata:
					input.metadata === undefined
						? undefined
						: toJsonRecord({
								...input.metadata,
								preferenceSource: null,
								preferenceSentence: null,
								preferenceEvidenceEventId: null,
								learningCorrection: false,
								serverObserved: false,
							}),
				occurredAt: input.occurredAt ?? new Date().toISOString(),
			}),
		);
	});

const recordMeasurement = authed.recordMeasurement
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		const actor = resolveLearningActor(context);
		const attribution = await getLearningAttributionById(
			context.db,
			organizationId,
			input.attributionId,
		);
		if (!attribution) {
			throw createError(ErrorCodes.NOT_FOUND, "Learning attribution not found");
		}
		const [event] = await getLearningInteractionsByIds(
			context.db,
			organizationId,
			[attribution.feedbackEventId],
		);
		if (!event || !canAccessLearningEvent(actor.actorId, event)) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Cannot measure another actor's personal learning feedback",
			);
		}
		if (context.tediId && event.tediId !== context.tediId) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Cannot measure feedback recorded for another tedi",
			);
		}
		return withIdempotencyConflict(() =>
			recordLearningMeasurement(context.db, {
				organizationId,
				clientMeasurementId: input.clientMeasurementId,
				attributionId: input.attributionId,
				windowKind: input.windowKind,
				windowStart: input.windowStart,
				windowEnd: input.windowEnd,
				opportunityCount: input.opportunityCount,
				recurrenceCount: input.recurrenceCount,
				successCount: input.successCount,
				metadata:
					input.metadata === undefined
						? undefined
						: toJsonRecord({
								...input.metadata,
								preferenceSource: null,
								preferenceSentence: null,
								preferenceEvidenceEventId: null,
								learningCorrection: false,
								serverObserved: false,
							}),
			}),
		);
	});

const getSummary = authed.getSummary
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const actor = resolveLearningActor(context);
		return getLearningFeedbackSummary(context.db, {
			organizationId: requireOrgId(context),
			tediId: context.tediId,
			personalScopeId: actor.actorId,
			subjectKind: input.subjectKind,
			subjectId: input.subjectId,
			issueKey: input.issueKey,
		});
	});

const analyzeRecurringIssues = authed.analyzeRecurringIssues
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		const actor = resolveLearningActor(context);
		const tediId = await resolveAccessibleTediId(context, input.tediId);
		return {
			minimumOccurrences: input.minimumOccurrences,
			issues: await analyzeRecurringLearningIssues(context.db, {
				organizationId,
				tediId,
				scopeKind: input.scopeKind,
				scopeId: input.scopeId,
				since: input.since,
				until: input.until,
				personalScopeId: actor.actorId,
				minimumOccurrences: input.minimumOccurrences,
				limit: input.limit,
			}),
		};
	});

const NEGATIVE_PROPOSAL_EVENT_KINDS = new Set([
	"edited",
	"ignored",
	"rejected",
	"retried",
	"undone",
	"manually_replaced",
	"completed_elsewhere",
]);

const proposeImprovement = authed.proposeImprovement
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		const evidenceEventIds = [...new Set(input.evidenceEventIds)];
		if (evidenceEventIds.length < 3) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Improvement proposals require at least three distinct evidence events",
			);
		}
		const events = await getLearningInteractionsByIds(
			context.db,
			organizationId,
			evidenceEventIds,
		);
		if (events.length !== evidenceEventIds.length) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				"One or more proposal evidence events were not found",
			);
		}
		const first = events[0]!;
		if (
			!first.issueKey ||
			events.some(
				(event) =>
					event.issueKey !== first.issueKey ||
					event.tediId !== first.tediId ||
					event.scopeKind !== first.scopeKind ||
					event.scopeId !== first.scopeId ||
					!NEGATIVE_PROPOSAL_EVENT_KINDS.has(event.eventKind),
			)
		) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Proposal evidence must be recurring negative events for one issue, tedi, and learning scope",
			);
		}
		if (context.tediId && first.tediId !== context.tediId) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Cannot propose an improvement from another tedi's evidence",
			);
		}
		const actor = resolveLearningActor(context);
		if (!canAccessLearningEvent(actor.actorId, first)) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Cannot propose from another actor's personal learning evidence",
			);
		}
		if (
			!learningScopeCanNominateSubject({
				scopeKind: first.scopeKind,
				scopeId: first.scopeId,
				tediId: first.tediId,
				subjectKind: input.subjectKind,
				subjectId: input.subjectId,
				actorType: actor.actorType,
				actorId: actor.actorId,
			})
		) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"This learning scope cannot nominate the requested subject; use a matching workflow/tedi scope or a signed-in human organization scope",
			);
		}
		return withIdempotencyConflict(() =>
			proposeLearningImprovement(context.db, {
				organizationId,
				clientProposalId: input.clientProposalId,
				tediId: first.tediId,
				scopeKind: first.scopeKind,
				scopeId: first.scopeId,
				issueKey: first.issueKey!,
				subjectKind: input.subjectKind,
				subjectId: input.subjectId,
				recommendation: input.recommendation,
				evidenceEventIds,
				proposedByType: actor.actorType,
				proposedById: actor.actorId,
			}),
		);
	});

const listImprovements = authed.listImprovements
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		const actor = resolveLearningActor(context);
		const tediId = await resolveAccessibleTediId(context, input.tediId);
		return {
			proposals: await listLearningImprovementProposals(context.db, {
				organizationId,
				tediId,
				issueKey: input.issueKey,
				status: input.status,
				personalScopeId: actor.actorId,
				limit: input.limit,
			}),
		};
	});

const evaluateImprovement = authed.evaluateImprovement
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		const proposal = await getLearningImprovementProposal(
			context.db,
			organizationId,
			input.proposalId,
		);
		if (!proposal) {
			throw createError(ErrorCodes.NOT_FOUND, "Learning proposal not found");
		}
		const actor = resolveLearningActor(context);
		if (!canAccessLearningEvent(actor.actorId, proposal)) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Cannot evaluate another actor's personal learning proposal",
			);
		}
		if (context.tediId && proposal.tediId !== context.tediId) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Cannot evaluate another tedi's learning proposal",
			);
		}
		if (
			proposal.status === "approved_for_handoff" ||
			proposal.status === "rejected"
		) {
			throw createError(
				ErrorCodes.CONFLICT,
				"Reviewed learning proposals cannot be re-evaluated",
			);
		}
		const evidenceEvents = await getLearningInteractionsByIds(
			context.db,
			organizationId,
			proposal.evidenceEventIds,
		);
		const evidenceAttributions = await getLearningAttributionsForEvents(
			context.db,
			{
				organizationId,
				feedbackEventIds: proposal.evidenceEventIds,
				subjectKind: proposal.subjectKind,
				subjectId: proposal.subjectId,
			},
		);
		if (
			new Set(
				evidenceAttributions.map((candidate) => candidate.feedbackEventId),
			).size !== proposal.evidenceEventIds.length
		) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Every proposal evidence event must be attributed to the evaluated subject",
			);
		}
		const measurements = await getLearningMeasurementsByIds(
			context.db,
			organizationId,
			[input.baselineMeasurementId, input.followupMeasurementId],
		);
		const baseline = measurements.find(
			(measurement) => measurement.id === input.baselineMeasurementId,
		);
		const followup = measurements.find(
			(measurement) => measurement.id === input.followupMeasurementId,
		);
		if (!baseline || !followup) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				"Baseline or follow-up learning measurement not found",
			);
		}
		const normalizedBaseline = {
			...baseline,
			metadata:
				baseline.metadata === null ? null : toJsonRecord(baseline.metadata),
		};
		const normalizedFollowup = {
			...followup,
			metadata:
				followup.metadata === null ? null : toJsonRecord(followup.metadata),
		};
		const pair = validateLearningMeasurementPair({
			baseline: normalizedBaseline,
			followup: normalizedFollowup,
			allowedAttributionIds: new Set(
				evidenceAttributions.map((candidate) => candidate.id),
			),
		});
		if (!pair.valid) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				pair.reason ?? "Invalid measurement pair",
			);
		}
		const eventById = new Map(
			evidenceEvents.map((event) => [event.id, event] as const),
		);
		const summary = summarizeLearningFeedback({
			subjectKind: proposal.subjectKind,
			subjectId: proposal.subjectId,
			issueKey: proposal.issueKey,
			attributions: evidenceAttributions.map((candidate) => ({
				...candidate,
				metadata:
					candidate.metadata === null ? null : toJsonRecord(candidate.metadata),
				eventKind: eventById.get(candidate.feedbackEventId)!.eventKind,
				issueKey: proposal.issueKey,
			})),
			measurements: [normalizedBaseline, normalizedFollowup],
		});
		const readyForHumanReview = pair.improved;
		const updated = await updateLearningImprovementProposal(context.db, {
			organizationId,
			id: proposal.id,
			status: readyForHumanReview ? "ready_for_review" : "evaluating",
			fromStatuses: ["proposed", "evaluating"],
			expectedUpdatedAt: proposal.updatedAt,
			attributionId: baseline.attributionId,
			baselineMeasurementId: baseline.id,
			followupMeasurementId: followup.id,
			evaluationNote: input.evaluationNote ?? null,
		});
		if (!updated) {
			throw createError(
				ErrorCodes.CONFLICT,
				"Learning proposal state changed during evaluation",
			);
		}
		return { proposal: updated, summary, readyForHumanReview };
	});

const reviewImprovement = authed.reviewImprovement
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		if (!isHumanLearningReviewer(context)) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"A signed-in human operator must review learning improvements",
			);
		}
		const reviewerId = context.user?.sub;
		if (!reviewerId) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Human reviewer identity missing",
			);
		}
		const organizationId = requireOrgId(context);
		const proposal = await getLearningImprovementProposal(
			context.db,
			organizationId,
			input.proposalId,
		);
		if (!proposal) {
			throw createError(ErrorCodes.NOT_FOUND, "Learning proposal not found");
		}
		if (!canAccessLearningEvent(reviewerId, proposal)) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Cannot review another actor's personal learning proposal",
			);
		}
		if (
			proposal.status === "approved_for_handoff" ||
			proposal.status === "rejected"
		) {
			throw createError(
				ErrorCodes.CONFLICT,
				"Learning proposal was already reviewed",
			);
		}
		if (
			input.decision === "approve" &&
			proposal.status !== "ready_for_review"
		) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Approval requires measured improvement and certification evidence",
			);
		}
		const updated = await updateLearningImprovementProposal(context.db, {
			organizationId,
			id: proposal.id,
			status:
				input.decision === "approve" ? "approved_for_handoff" : "rejected",
			fromStatuses:
				input.decision === "approve"
					? ["ready_for_review"]
					: ["proposed", "evaluating", "ready_for_review"],
			expectedUpdatedAt: proposal.updatedAt,
			reviewReason: input.reason,
			reviewedById: reviewerId,
			reviewedAt: new Date().toISOString(),
		});
		if (!updated) {
			throw createError(
				ErrorCodes.CONFLICT,
				"Learning proposal state changed during human review",
			);
		}
		return {
			proposal: updated,
			requiresDownstreamCertificationAndPromotion: input.decision === "approve",
		};
	});

function requireLearningPerson(context: BaseContext) {
	const actor = resolveLearningActor(context);
	if (actor.actorType !== "user" || !actor.actorId)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"A person is required for their decision instrumentation",
		);
	return actor.actorId;
}
const recordExposure = authed.recordExposure
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"The person may report only their own recipient-fenced Decisions exposures",
			},
			"tedis:write",
		),
	)
	.handler(async ({ input, context }) => {
		try {
			return await recordDecisionExposure(context.db, {
				organizationId: requireOrgId(context),
				actorId: requireLearningPerson(context),
				mayReadApprovals: userHoldsPermission(context, "tedis:read"),
				input,
			});
		} catch (error) {
			if (
				error instanceof Error &&
				[
					"Invalid candidate inventory",
					"Decision source is unavailable to this person",
				].includes(error.message)
			)
				throw createError(ErrorCodes.BAD_REQUEST, error.message);
			if (
				error instanceof Error &&
				[
					"Card changed before exposure was recorded",
					"Exposure id was already used for different context",
				].includes(error.message)
			)
				throw createError(ErrorCodes.CONFLICT, error.message);
			throw error;
		}
	});
const getCalibration = authed.getCalibration
	.use(AUTHZ.tedisRead)
	.handler(({ input, context }) =>
		readDecisionCalibration(context.db, {
			organizationId: requireOrgId(context),
			actorId: requireLearningPerson(context),
			classId: input.classId,
		}),
	);
const getInstrumentation = authed.getInstrumentation
	.use(AUTHZ.tedisRead)
	.handler(({ input, context }) =>
		readDecisionInstrumentation(context.db, {
			organizationId: requireOrgId(context),
			actorId: requireLearningPerson(context),
			cardId: input.cardId,
			limit: input.limit,
		}),
	);

const model = authed.model
	.use(AUTHZ.tedisRead)
	.handler(({ context }) =>
		readDecisionLearning(
			context.db,
			requireOrgId(context),
			resolveLearningActor(context).actorId,
		),
	);
const configure = authed.configure
	.use(withAuthorization("settings:manage", "mcp:settings.write"))
	.handler(({ input, context }) =>
		setDecisionLearningConfig(context.db, requireOrgId(context), input),
	);
const correct = authed.correct
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"Only the authenticated person may correct a personal signal they authored in this organization",
			},
			"tedis:write",
		),
	)
	.handler(async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		const actor = resolveLearningActor(context);
		if (actor.actorType !== "user" || !actor.actorId)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Only a person can correct their own learning",
			);
		const [event] = await getLearningInteractionsByIds(
			context.db,
			organizationId,
			[input.eventId],
		);
		if (
			!event ||
			event.scopeKind !== "personal" ||
			event.scopeId !== actor.actorId ||
			event.actorId !== actor.actorId ||
			event.metadata?.learningCorrection === true
		)
			throw createError(ErrorCodes.NOT_FOUND, "Learning signal not found");
		const recorded = await withIdempotencyConflict(() =>
			recordLearningInteraction(context.db, {
				organizationId,
				...actor,
				clientEventId: input.clientEventId,
				eventKind: "undone",
				scopeKind: "personal",
				scopeId: actor.actorId!,
				surface: "decision_learning",
				targetType: "learning_event",
				targetId: event.id,
				metadata: { learningCorrection: true, correctsEventId: event.id },
				occurredAt: new Date().toISOString(),
			}),
		);
		await archiveCorrectedAgentLessons(
			context.db,
			organizationId,
			actor.actorId,
			event.id,
			new Date().toISOString(),
		);
		return recorded;
	});

export const learningFeedbackContractRouter = learningFeedbackOs.router({
	cardContextPrompt: authed.cardContextPrompt
		.use(
			withAuthorization(
				{
					handlerOwnedUserAuthorization:
						"A person may report a visible, recipient-fenced card; sampling is personal and cannot grant approval",
				},
				"tedis:write",
			),
		)
		.handler(async ({ input, context }): Promise<{ ask: boolean }> => {
			requireLearningPerson(context);
			const { loadDeckProjection } =
				await import("../../services/attention-projection");
			const { sampleCardContext } =
				await import("../../services/card-context-feedback");
			const projection = await loadDeckProjection(context, input);
			const card = projection.cards.find((card) => card.id === input.cardId);
			const copy = DecisionCardPresentationSchema.safeParse(
				card?.interaction?.request.metadata.cardPresentation,
			).data;
			return {
				ask:
					card &&
					copy?.version === 2 &&
					copy.sourceFingerprint === input.sourceFingerprint
						? await sampleCardContext(
								context,
								card,
								projection.model.config.enabled,
							)
						: false,
			};
		}),
	cardContext: authed.cardContext
		.use(
			withAuthorization(
				{
					handlerOwnedUserAuthorization:
						"Only the person who received a sampled context question may answer it; the server derives the card class and personal learning scope",
				},
				"tedis:write",
			),
		)
		.handler(async ({ input, context }) => {
			const actorId = requireLearningPerson(context);
			const { recordCardContext } =
				await import("../../services/card-context-feedback");
			return recordCardContext(context, actorId, input);
		}),
	recordExposure,
	getCalibration,
	getInstrumentation,
	model,
	configure,
	correct,
	recordInteraction,
	listInteractions,
	attributeFeedback,
	recordMeasurement,
	getSummary,
	analyzeRecurringIssues,
	proposeImprovement,
	listImprovements,
	evaluateImprovement,
	reviewImprovement,
});

export type LearningFeedbackContractRouter =
	typeof learningFeedbackContractRouter;
