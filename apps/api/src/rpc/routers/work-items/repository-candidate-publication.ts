import {
	getRecordedWorkItemAttempt,
	recordWorkAttemptRepositoryCandidatePublication,
	claimWorkAttemptRepositoryCandidatePublication,
} from "@tedix/db/queries/work-items/attempts";
import {
	recordRepositoryCandidatePublicationObservation,
	getRepositoryCandidatePublicationEffect,
} from "@tedix/db/queries/work-items/evidence";
import {
	applyRepositoryCandidatePublication,
	reconcileRepositoryCandidatePublication,
	repositoryCandidatePublicationRecord,
	type CandidatePublicationIO,
} from "../../../services/work-repository-candidate-publication";
import { recordedRepositoryCandidate } from "../../../services/work-repository-draft";
import {
	candidateAccess,
	candidateActor,
	candidateRoom,
	candidateGuarded,
} from "./repository-candidate-policy";
import {
	AUTHZ,
	createError,
	ErrorCodes,
	userHoldsPermission,
	type BaseContext,
} from "../../orpc";
import {
	assertTediAccess,
	verifiedExternalAgent,
} from "../work-items-principal";
import {
	assertWorkItemAccess,
	requireOwnerAdminWorkItemAuthor,
	authOs,
} from "./policy-helpers";

type PublicationObserver = Parameters<
	typeof recordRepositoryCandidatePublicationObservation
>[1]["observedBy"];
function io(
	context: BaseContext,
	input: { id: string; attemptId: string },
	initialObserver?: PublicationObserver,
): CandidatePublicationIO {
	let observedBy = initialObserver;
	return {
		artifacts: context.env.ARTIFACTS,
		waitUntil: context.waitUntil,
		authority: async () => {
			const scope = await candidateAccess(context, input, true);
			if (scope.fence)
				observedBy = {
					...scope.fence.executor,
					sessionId: scope.fence.sessionId,
					userId: context.userId ?? null,
				};
			return scope;
		},
		readCandidate: async (scope) =>
			(
				await candidateRoom(context, {
					operation: "read",
					descriptor: recordedRepositoryCandidate(scope.work, scope.attempt),
					actor: candidateActor(context, scope.fence?.sessionId),
				})
			).state,
		reserve: async (scope, record) => {
			if (!scope.fence)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Publication executor is not verified",
				);
			const row = await recordWorkAttemptRepositoryCandidatePublication(
				context.db,
				{
					orgId: scope.work.orgId,
					workItemId: scope.work.id,
					attemptId: scope.attempt.id,
					...scope.fence,
					record,
				},
			);
			return row ? repositoryCandidatePublicationRecord(row) : null;
		},
		claim: async (scope, preparationDigest) => {
			if (!scope.fence)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Publication executor is not verified",
				);
			const row = await claimWorkAttemptRepositoryCandidatePublication(
				context.db,
				{
					orgId: scope.work.orgId,
					workItemId: scope.work.id,
					attemptId: scope.attempt.id,
					...scope.fence,
					preparationDigest,
				},
			);
			return row ? repositoryCandidatePublicationRecord(row) : null;
		},
		observe: (preparation, observation) => {
			if (!observedBy)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Publication observer is not verified",
				);
			return recordRepositoryCandidatePublicationObservation(context.db, {
				preparation,
				observation,
				observedBy,
			});
		},
		priorEffect: (preparation) =>
			getRepositoryCandidatePublicationEffect(context.db, preparation),
		build: async (params) =>
			(
				await import("../../../services/repository-candidate-git")
			).buildCandidateCommit(params),
		send: async (params) =>
			(
				await import("../../../services/repository-candidate-git")
			).sendCandidateCommit(params),
	};
}

type ApplyArgs = Parameters<
	Parameters<typeof authOs.applyRepositoryCandidate.handler>[0]
>[0];
export async function applyRepositoryCandidate({ context, input }: ApplyArgs) {
	return candidateGuarded(() =>
		applyRepositoryCandidatePublication(io(context, input), input),
	);
}

type ReconcileArgs = Parameters<
	Parameters<typeof authOs.reconcileRepositoryCandidate.handler>[0]
>[0];
export async function reconcileRepositoryCandidate({
	context,
	input,
}: ReconcileArgs) {
	return candidateGuarded(async () => {
		const work = await assertWorkItemAccess(context, input.id);
		await requireOwnerAdminWorkItemAuthor(
			context,
			work.orgId,
			"Repository publication observation",
		);
		if (!userHoldsPermission(context, "secrets:manage"))
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Repository publication observation requires secrets management authority",
			);
		const external = await verifiedExternalAgent(context, work.orgId);
		if (!external) {
			if (!context.tediId)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Publication observation requires a verified native executor",
				);
			await assertTediAccess(context, context.tediId, work.orgId);
		}
		const attempt = await getRecordedWorkItemAttempt(context.db, {
			orgId: work.orgId,
			workItemId: work.id,
			attemptId: input.attemptId,
		});
		if (!attempt)
			throw createError(
				ErrorCodes.NOT_FOUND,
				"Attempt not found for this Work",
			);
		return reconcileRepositoryCandidatePublication(
			io(
				context,
				input,
				external
					? { ...external.executor, userId: context.userId ?? null }
					: {
							type: "tedi",
							id: context.tediId!,
							userId: context.userId ?? null,
						},
			),
			{
				work,
				attempt,
			},
		);
	});
}
export const applyRepositoryCandidateProcedure = authOs.applyRepositoryCandidate
	.use(AUTHZ.osAuthor)
	.use(AUTHZ.objectiveWrite)
	.handler(applyRepositoryCandidate);
export const reconcileRepositoryCandidateProcedure =
	authOs.reconcileRepositoryCandidate
		.use(AUTHZ.osAuthor)
		.use(AUTHZ.objectiveWrite)
		.handler(reconcileRepositoryCandidate);
