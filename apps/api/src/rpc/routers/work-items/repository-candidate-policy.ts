import { durableObjectStubByName } from "@tedix/worker-kit/durable-objects";
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
} from "@tedix/db/queries/work-items/attempts";
import { assertRepositoryCandidateAdmission } from "../../../services/work-repository-candidate-access";
import { RepositoryCandidateError } from "../../../services/work-repository-draft";
import {
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
	requireOwnerAdminWorkItemAuthor,
	rethrowWorkItemWriteError,
} from "./policy-helpers";
import type { z } from "zod";
export async function candidateAccess(
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

export async function candidateRoom(
	context: BaseContext,
	request: z.infer<typeof RepositoryCandidateRoomRequestSchema>,
) {
	const binding = context.env.APP_DRAFT_ROOM;
	const response = await durableObjectStubByName(
		binding,
		context.env,
		request.descriptor.roomName,
	).fetch(
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

export function candidateActor(context: BaseContext, session?: string) {
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

export async function candidateGuarded<T>(
	operation: () => Promise<T>,
): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		if (error instanceof RepositoryCandidateError)
			throw createError(ErrorCodes.CONFLICT, error.message);
		rethrowWorkItemWriteError(error);
	}
}
