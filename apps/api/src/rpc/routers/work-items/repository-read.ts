import { WorkAttemptRepositorySchema } from "@tedix/api-contract/schemas/work-items";
import { getAuthoritativeWorkItemAttempt } from "@tedix/db/queries/work-items/attempts";
import {
	readWorkAttemptRepository,
	WorkAttemptRepositoryReadError,
} from "../../../services/work-artifacts-repository";
import {
	AUTHZ,
	createError,
	ErrorCodes,
	userHoldsPermission,
} from "../../orpc";
import {
	assertWorkItemAccess,
	authOs,
	requireOwnerAdminWorkItemAuthor,
	rethrowWorkItemWriteError,
} from "./policy-helpers";

type RepositoryReadHandlerArgs = Parameters<
	Parameters<typeof authOs.readAttemptRepository.handler>[0]
>[0];

/**
 * Immutable file/tree/history reads against an Attempt's recorded Artifacts
 * repository. Unlike the active-workstation inspection this works during and
 * after the Attempt, but it serves the same secret-bearing surface — the same
 * owner/admin + secrets-management gate applies.
 */
export async function readAttemptRepository({
	input,
	context,
}: RepositoryReadHandlerArgs) {
	const workItem = await assertWorkItemAccess(context, input.id);
	await requireOwnerAdminWorkItemAuthor(
		context,
		workItem.orgId,
		"Attempt repository review",
	);
	if (!userHoldsPermission(context, "secrets:manage"))
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Attempt repository review requires secrets management authority",
		);
	const attempt = await getAuthoritativeWorkItemAttempt(context.db, {
		orgId: workItem.orgId,
		workItemId: workItem.id,
		attemptId: input.attemptId,
	}).catch(rethrowWorkItemWriteError);
	const provenance = WorkAttemptRepositorySchema.safeParse(
		attempt.metadata?.repository,
	);
	if (
		!provenance.success ||
		provenance.data.status !== "ready" ||
		provenance.data.attemptId !== attempt.id ||
		provenance.data.workItemId !== workItem.id
	)
		throw createError(
			ErrorCodes.CONFLICT,
			"Attempt has no ready Artifacts repository",
		);
	try {
		return await readWorkAttemptRepository({
			artifacts: context.env.ARTIFACTS,
			repository: provenance.data,
			request: input,
		});
	} catch (error) {
		if (error instanceof WorkAttemptRepositoryReadError)
			throw createError(
				error.code === "not_found"
					? ErrorCodes.CONFLICT
					: ErrorCodes.BAD_GATEWAY,
				error.message,
			);
		throw error;
	}
}

export const readAttemptRepositoryProcedure = authOs.readAttemptRepository
	.use(AUTHZ.osRead)
	.use(AUTHZ.objectiveRead)
	.handler(readAttemptRepository);
