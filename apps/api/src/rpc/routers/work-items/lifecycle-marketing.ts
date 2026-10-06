import { addWorkItemComment } from "@tedix/db/queries/work-items/comments";
import { toJsonRecord } from "@tedix/db/utils/json";
import { verifiedWorkItemCommentAuthor } from "../work-items-principal";
import {
	assertWorkItemAccess,
	authOs,
	rethrowWorkItemWriteError,
} from "./policy-helpers";

export const addCommentProcedure = authOs.addComment.handler(
	async ({ input, context }) => {
		const workItem = await assertWorkItemAccess(context, input.id);
		try {
			const author = await verifiedWorkItemCommentAuthor(
				context,
				workItem.orgId,
				input.metadata,
			);
			return await addWorkItemComment(context.db, {
				id: crypto.randomUUID(),
				workItemId: input.id,
				orgId: workItem.orgId,
				authorType: author.authorType,
				authorId: author.authorId,
				body: input.body,
				metadata:
					author.metadata === undefined
						? undefined
						: toJsonRecord(author.metadata),
				createdAt: new Date().toISOString(),
			});
		} catch (error) {
			rethrowWorkItemWriteError(error);
		}
	},
);
