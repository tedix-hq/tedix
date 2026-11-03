import { recordWorkAttemptRepositoryCandidate } from "@tedix/db/queries/work-items/attempts";
import {
	hydrateRepositoryCandidate,
	liveRepositoryCandidateScope,
	recordedRepositoryCandidate,
	repositoryCandidateDescriptor,
} from "../../../services/work-repository-draft";
import { AUTHZ, createError, ErrorCodes } from "../../orpc";
import { authOs } from "./policy-helpers";
import {
	candidateAccess as access,
	candidateRoom as room,
	candidateActor as actor,
	candidateGuarded as guarded,
} from "./repository-candidate-policy";

type InitArgs = Parameters<
	Parameters<typeof authOs.initializeRepositoryCandidate.handler>[0]
>[0];
export async function initializeRepositoryCandidate({
	context,
	input,
}: InitArgs) {
	return guarded(async () => {
		const first = await access(context, input, true);
		const repository = liveRepositoryCandidateScope(first.work, first.attempt);
		const existing = first.attempt.metadata.repositoryCandidate;
		if (existing) {
			const descriptor = recordedRepositoryCandidate(first.work, first.attempt);
			if (
				descriptor.baseRevision !== input.expectedBaseRevision ||
				JSON.stringify(descriptor.files.map((file) => file.path).sort()) !==
					JSON.stringify([...input.paths].sort())
			)
				throw createError(
					ErrorCodes.CONFLICT,
					"This Attempt already has a different frozen candidate selection",
				);
			const hydrated = await hydrateRepositoryCandidate({
				artifacts: context.env.ARTIFACTS,
				repository,
				baseRevision: descriptor.baseRevision,
				paths: descriptor.files.map((file) => file.path),
			});
			await access(context, input, true);
			return room(context, {
				operation: "initialize",
				descriptor,
				actor: actor(context, first.fence?.sessionId),
				files: hydrated.files,
			});
		}
		const hydrated = await hydrateRepositoryCandidate({
			artifacts: context.env.ARTIFACTS,
			repository,
			baseRevision: input.expectedBaseRevision,
			paths: input.paths,
		});
		const current = await access(context, input, true);
		let descriptor = await repositoryCandidateDescriptor({
			work: current.work,
			attempt: current.attempt,
			baseRevision: input.expectedBaseRevision,
			selected: hydrated.selected,
		});
		try {
			await recordWorkAttemptRepositoryCandidate(context.db, {
				orgId: current.work.orgId,
				workItemId: current.work.id,
				attemptId: current.attempt.id,
				...current.fence!,
				descriptor,
			});
		} catch (error) {
			const raced = await access(context, input, true);
			const winner = recordedRepositoryCandidate(raced.work, raced.attempt);
			if (
				winner.baseRevision !== descriptor.baseRevision ||
				winner.selectionDigest !== descriptor.selectionDigest
			)
				throw error;
			descriptor = winner;
		}
		return room(context, {
			operation: "initialize",
			descriptor,
			actor: actor(context, current.fence?.sessionId),
			files: hydrated.files,
		});
	});
}

type ReadArgs = Parameters<
	Parameters<typeof authOs.readRepositoryCandidate.handler>[0]
>[0];
export async function readRepositoryCandidate({ context, input }: ReadArgs) {
	return guarded(async () => {
		const current = await access(context, input, false);
		return room(context, {
			operation: "read",
			descriptor: recordedRepositoryCandidate(current.work, current.attempt),
			actor: actor(context),
		});
	});
}

type SubmitArgs = Parameters<
	Parameters<typeof authOs.submitRepositoryCandidate.handler>[0]
>[0];
export async function submitRepositoryCandidate({
	context,
	input,
}: SubmitArgs) {
	return guarded(async () => {
		const current = await access(context, input, true);
		return room(context, {
			operation: "submit",
			descriptor: recordedRepositoryCandidate(current.work, current.attempt),
			actor: actor(context, current.fence?.sessionId),
			submission: input.submission,
		});
	});
}

type SealArgs = Parameters<
	Parameters<typeof authOs.sealRepositoryCandidate.handler>[0]
>[0];
export async function sealRepositoryCandidate({ context, input }: SealArgs) {
	return guarded(async () => {
		const current = await access(context, input, true);
		const descriptor = recordedRepositoryCandidate(
			current.work,
			current.attempt,
		);
		await hydrateRepositoryCandidate({
			artifacts: context.env.ARTIFACTS,
			repository: liveRepositoryCandidateScope(current.work, current.attempt),
			baseRevision: descriptor.baseRevision,
			paths: descriptor.files.map((file) => file.path),
		});
		const renewed = await access(context, input, true);
		const result = await room(context, {
			operation: "seal",
			descriptor: recordedRepositoryCandidate(renewed.work, renewed.attempt),
			actor: actor(context, renewed.fence?.sessionId),
			expectedPosition: input.expectedPosition,
			expectedContentDigest: input.expectedContentDigest,
		});
		if (
			!result.state.sealed ||
			!result.state.seal ||
			JSON.stringify(result.state.seal.position) !==
				JSON.stringify(input.expectedPosition) ||
			result.state.seal.contentDigest !== input.expectedContentDigest ||
			result.state.contentDigest !== input.expectedContentDigest ||
			JSON.stringify(result.state.snapshot.position) !==
				JSON.stringify(input.expectedPosition)
		)
			throw createError(
				ErrorCodes.BAD_GATEWAY,
				"Candidate seal did not match the exact requested stream position and digest",
			);
		return result;
	});
}

export const initializeRepositoryCandidateProcedure =
	authOs.initializeRepositoryCandidate
		.use(AUTHZ.osAuthor)
		.use(AUTHZ.objectiveWrite)
		.handler(initializeRepositoryCandidate);
export const readRepositoryCandidateProcedure = authOs.readRepositoryCandidate
	.use(AUTHZ.osRead)
	.use(AUTHZ.objectiveRead)
	.handler(readRepositoryCandidate);
export const submitRepositoryCandidateProcedure =
	authOs.submitRepositoryCandidate
		.use(AUTHZ.osAuthor)
		.use(AUTHZ.objectiveWrite)
		.handler(submitRepositoryCandidate);
export const sealRepositoryCandidateProcedure = authOs.sealRepositoryCandidate
	.use(AUTHZ.osAuthor)
	.use(AUTHZ.objectiveWrite)
	.handler(sealRepositoryCandidate);
