/**
 * Triage: a proposed Work Item is in triage, with or without a project. Accept
 * is the first exit (`acceptProcedure`); these are the other three, plus the
 * queues that show what still needs a decision.
 */
import {
	countTriageQueues,
	declineProposedWorkItem,
	listTriageQueue,
	markWorkItemDuplicate,
	snoozeProposedWorkItem,
} from "@tedix/db/queries/work-items/triage";
import { requireOrgId } from "../../org-scope";
import { createError, ErrorCodes, withAuthorization } from "../../orpc";
import {
	assertWorkItemAccess,
	authOs,
	rethrowWorkItemWriteError,
	workItemStewardActor,
} from "./policy-helpers";

const triageWriteOs = authOs.use(
	withAuthorization(
		{
			handlerOwnedUserAuthorization:
				"Each triage exit enforces organization scope plus the owner, admin or granted steward policy for the Work Item",
		},
		"mcp:messaging.write",
	),
);

const triageReadOs = authOs.use(
	withAuthorization(
		{
			handlerOwnedUserAuthorization:
				"The triage queues are scoped to the verified organization",
		},
		"mcp:work.read",
	),
);

export const declineProcedure = triageWriteOs.decline.handler(
	async ({ input, context }) => {
		const workItem = await assertWorkItemAccess(context, input.id);
		const actor = await workItemStewardActor(
			context,
			workItem,
			"cancellation",
			input.reason,
		);
		try {
			return await declineProposedWorkItem(context.db, {
				orgId: workItem.orgId,
				workItemId: workItem.id,
				actor,
				reason: input.reason,
				expectedWorkItemVersion: workItem.version,
			});
		} catch (error) {
			rethrowWorkItemWriteError(error);
		}
	},
);

export const markDuplicateProcedure = triageWriteOs.markDuplicate.handler(
	async ({ input, context }) => {
		const workItem = await assertWorkItemAccess(context, input.id);
		const original = await assertWorkItemAccess(
			context,
			input.duplicateOfWorkItemId,
		);
		if (original.id === workItem.id)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"A Work Item cannot duplicate itself",
			);
		const reason = input.reason ?? `Duplicate of "${original.title}"`;
		const actor = await workItemStewardActor(
			context,
			workItem,
			"cancellation",
			reason,
		);
		try {
			return await markWorkItemDuplicate(context.db, {
				orgId: workItem.orgId,
				workItemId: workItem.id,
				actor,
				relationId: crypto.randomUUID(),
				duplicateOfWorkItemId: original.id,
				reason,
				expectedWorkItemVersion: workItem.version,
			});
		} catch (error) {
			rethrowWorkItemWriteError(error);
		}
	},
);

export const snoozeProcedure = triageWriteOs.snooze.handler(
	async ({ input, context }) => {
		const workItem = await assertWorkItemAccess(context, input.id);
		const actor = await workItemStewardActor(
			context,
			workItem,
			"specification",
		);
		const now = new Date().toISOString();
		if (input.until !== null && Date.parse(input.until) <= Date.parse(now))
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"A snooze must end at a future time",
			);
		try {
			return await snoozeProposedWorkItem(context.db, {
				orgId: workItem.orgId,
				workItemId: workItem.id,
				actor,
				until: input.until,
				expectedWorkItemVersion: workItem.version,
				at: now,
			});
		} catch (error) {
			rethrowWorkItemWriteError(error);
		}
	},
);

export const listTriageProcedure = triageReadOs.listTriage.handler(
	async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const limit = input?.limit ?? 50;
		const offset = input?.offset ?? 0;
		const now = new Date().toISOString();
		const [{ data, total }, counts] = await Promise.all([
			listTriageQueue(context.db, {
				orgId,
				projectId: input?.projectId ?? null,
				now,
				limit,
				offset,
			}),
			countTriageQueues(context.db, { orgId, now }),
		]);
		return {
			data,
			pagination: {
				limit,
				offset,
				total,
				hasMore: offset + data.length < total,
			},
			queues: counts.queues,
			snoozed: counts.snoozed,
		};
	},
);
