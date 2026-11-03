import {
	RepositoryCandidateStateSchema,
	type RepositoryCandidateRoomRequestSchema,
} from "@tedix/api-contract/schemas/repository-candidate";
import {
	repositoryCandidateContentDigest,
	repositoryCandidateContentError,
} from "@tedix/api-contract/utils/repository-candidate";
import {
	getAuthoritativeWorkItemAttempt,
	getRecordedWorkItemAttempt,
	recordWorkAttemptRepositoryCandidate,
} from "@tedix/db/queries/work-items/attempts";
import { assertRepositoryCandidateAdmission } from "../../../services/work-repository-candidate-access";
import {
	hydrateRepositoryCandidate,
	liveRepositoryCandidateScope,
	recordedRepositoryCandidate,
	repositoryCandidateDescriptor,
	RepositoryCandidateError,
} from "../../../services/work-repository-draft";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	userHoldsPermission,
} from "../../orpc";
import {
	assertTediAccess,
	verifiedExternalAgent,
} from "../work-items-principal";
import {
	assertWorkItemAccess,
	authOs,
	requireOwnerAdminWorkItemAuthor,
	rethrowWorkItemWriteError,
} from "./policy-helpers";
import type { z } from "zod";

async function access(
	context: BaseContext,
	input: { id: string; attemptId: string },
	executorRequired: boolean,
) {
	const work = await assertWorkItemAccess(context, input.id);
	await requireOwnerAdminWorkItemAuthor(
		context,
		work.orgId,
		"Shared repository candidate",
	);
	if (!userHoldsPermission(context, "secrets:manage"))
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Shared repository candidates require secrets management authority",
		);
	let fence:
		| {
				executor: { type: "external_agent" | "tedi"; id: string };
				sessionId?: string;
				externalSessionKey?: string;
		  }
		| undefined;
	if (executorRequired) {
		const external = await verifiedExternalAgent(context, work.orgId);
		if (external)
			fence = {
				executor: external.executor,
				sessionId: external.executor.sessionId,
				externalSessionKey: external.externalSessionKey,
			};
		else if (context.tediId) {
			await assertTediAccess(context, context.tediId, work.orgId);
			fence = { executor: { type: "tedi", id: context.tediId } };
		} else
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Only the current verified executor can initialize, submit or seal this candidate",
			);
	}
	const scope = {
		orgId: work.orgId,
		workItemId: work.id,
		attemptId: input.attemptId,
	};
	const attempt = fence
		? await getAuthoritativeWorkItemAttempt(context.db, { ...scope, ...fence })
		: await getRecordedWorkItemAttempt(context.db, scope);
	if (!attempt)
		throw createError(ErrorCodes.NOT_FOUND, "Attempt not found for this Work");
	await assertRepositoryCandidateAdmission(context.db, work, attempt);
	return { work, attempt, fence };
}

async function room(
	context: BaseContext,
	request: z.infer<typeof RepositoryCandidateRoomRequestSchema>,
) {
	const binding = context.env.APP_DRAFT_ROOM;
	const response = await binding
		.get(binding.idFromName(request.descriptor.roomName))
		.fetch(
			new Request("https://collab.internal/__internal/repository-candidate", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(request),
			}),
		);
	if (!response.ok)
		throw createError(
			response.status === 409 ? ErrorCodes.CONFLICT : ErrorCodes.BAD_GATEWAY,
			"Shared repository candidate rejected this operation",
		);
	const parsed = RepositoryCandidateStateSchema.safeParse(
		await response.json(),
	);
	if (!parsed.success)
		throw createError(
			ErrorCodes.BAD_GATEWAY,
			"Shared repository candidate returned an invalid snapshot",
		);
	const state = parsed.data;
	if (
		state.snapshot.canonical.revisionId !== request.descriptor.baseRevision ||
		repositoryCandidateContentError(
			state.snapshot.files,
			request.descriptor.files.map((file) => file.path),
		) ||
		state.contentDigest !==
			(await repositoryCandidateContentDigest(state.snapshot.files))
	)
		throw createError(
			ErrorCodes.BAD_GATEWAY,
			"Shared repository candidate content does not match its descriptor or digest",
		);
	return {
		descriptor: request.descriptor,
		state,
		writtenToRepository: false as const,
	};
}

function actor(context: BaseContext, session?: string) {
	const key = session ?? context.tediId ?? context.user?.sub;
	if (!key)
		throw createError(ErrorCodes.FORBIDDEN, "Candidate actor is not verified");
	return {
		key,
		kind: session
			? ("external_agent" as const)
			: context.tediId
				? ("tedi" as const)
				: ("human" as const),
		displayName: session ? "Repository agent" : "Repository collaborator",
		role: "build" as const,
		verified: true as const,
	};
}

async function guarded<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		if (error instanceof RepositoryCandidateError)
			throw createError(ErrorCodes.CONFLICT, error.message);
		rethrowWorkItemWriteError(error);
	}
}

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
