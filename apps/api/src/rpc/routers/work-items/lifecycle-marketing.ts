import { addWorkItemComment } from "@tedix/db/queries/work-items/comments";
import { updateWorkItemSpecification } from "@tedix/db/queries/work-items/crud";
import { getTedisByOrganization } from "@tedix/db/queries/tedis";
import { mentionedExecutor } from "../../../services/lane-dispatch-plan";
import { toJsonRecord } from "@tedix/db/utils/json";
import { verifiedWorkItemCommentAuthor } from "../work-items-principal";
import {
	assertWorkItemAccess,
	authOs,
	workItemStewardActor,
	requireOwnerAdminWorkItemAuthor,
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
			if (
				input.requestDelegation === true &&
				!workItem.metadata?.executor &&
				/\bdelegat(?:ed|ion)\b/i.test(input.body)
			) {
				const assignment =
					mentionedExecutor(input.body, []) ??
					mentionedExecutor(
						input.body,
						await getTedisByOrganization(context.db, workItem.orgId),
					);
				if (assignment) {
					const actor = await workItemStewardActor(
						context,
						workItem,
						"specification",
					);
					if (
						assignment.tediId &&
						assignment.tediId !== workItem.accountableOwnerId
					)
						await requireOwnerAdminWorkItemAuthor(
							context,
							workItem.orgId,
							"Tedi accountability assignment",
						);
					await updateWorkItemSpecification(context.db, {
						orgId: workItem.orgId,
						workItemId: workItem.id,
						actor,
						expectedWorkItemVersion: workItem.version,
						executor: assignment.executor,
						...(assignment.tediId
							? {
									accountableOwnerType: "tedi" as const,
									accountableOwnerId: assignment.tediId,
								}
							: {}),
					});
				}
			}
			const comment = await addWorkItemComment(context.db, {
				id: crypto.randomUUID(),
				workItemId: input.id,
				orgId: workItem.orgId,
				authorType: author.authorType,
				authorId: author.authorId,
				recordActivity: true,
				body: input.body,
				metadata:
					author.metadata === undefined
						? undefined
						: toJsonRecord(author.metadata),
				createdAt: new Date().toISOString(),
			});

			return comment;
		} catch (error) {
			rethrowWorkItemWriteError(error);
		}
	},
);
