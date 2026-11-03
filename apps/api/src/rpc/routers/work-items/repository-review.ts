import { getRecordedWorkItemAttempt } from "@tedix/db/queries/work-items/attempts";
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
} from "./policy-helpers";
import {
	readWorkRepositoryReview,
	RepositoryReviewUnavailable,
} from "../../../services/work-repository-review";

type ReviewArgs = Parameters<
	Parameters<typeof authOs.reviewAttemptRepository.handler>[0]
>[0];

export async function reviewAttemptRepository({ input, context }: ReviewArgs) {
	const work = await assertWorkItemAccess(context, input.id);
	await requireOwnerAdminWorkItemAuthor(
		context,
		work.orgId,
		"Raw repository review",
	);
	if (!userHoldsPermission(context, "secrets:manage"))
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Raw repository review requires secrets management authority",
		);
	const attempt = await getRecordedWorkItemAttempt(context.db, {
		orgId: work.orgId,
		workItemId: work.id,
		attemptId: input.attemptId,
	});
	if (!attempt) throw createError(ErrorCodes.NOT_FOUND, "Attempt not found");
	try {
		return await readWorkRepositoryReview({
			artifacts: context.env.ARTIFACTS,
			attempt,
			input,
		});
	} catch (error) {
		if (error instanceof RepositoryReviewUnavailable)
			throw createError(ErrorCodes.CONFLICT, error.message);
		throw createError(
			ErrorCodes.BAD_GATEWAY,
			"Repository review is unavailable",
		);
	}
}

export const reviewAttemptRepositoryProcedure = authOs.reviewAttemptRepository
	.use(AUTHZ.osRead)
	.use(AUTHZ.objectiveRead)
	.handler(reviewAttemptRepository);
