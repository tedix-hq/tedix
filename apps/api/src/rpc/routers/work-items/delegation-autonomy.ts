import { recordDelegationAutonomyFeedback } from "@tedix/db/queries/work-items/delegation-autonomy";
import { withAuthorization } from "../../orpc";
import {
	assertWorkItemAccess,
	authOs,
	requireOwnerAdminWorkItemAuthor,
} from "./policy-helpers";

export const recordDelegationAutonomyFeedbackProcedure =
	authOs.recordDelegationAutonomyFeedback
		.use(
			withAuthorization(
				{
					handlerOwnedUserAuthorization:
						"Autonomy corrections require a current organization owner/admin user; machine principals cannot change approval classes",
				},
				"mcp:work.write",
			),
		)
		.handler(async ({ input, context }) => {
			const item = await assertWorkItemAccess(context, input.id);
			const userId = await requireOwnerAdminWorkItemAuthor(
				context,
				item.orgId,
				"Delegation autonomy correction",
			);
			return recordDelegationAutonomyFeedback(context.db, {
				orgId: item.orgId,
				workItemId: item.id,
				eventId: input.eventId,
				userId,
				at: new Date().toISOString(),
			});
		});
