import {
	setWorkItemParent,
	removeWorkItemRelation,
	addWorkItemRelation,
} from "@tedix/db/queries/work-items/relations";
import { toJsonRecord } from "@tedix/db/utils/json";
import { ErrorCodes, createError, skipOutputValidation } from "../../orpc";
import { verifiedActiveWorkActor } from "../work-items-principal";
import {
	getByIdProcedure,
	getOrgGraphHealthProcedure,
	getWorkGraphHealthProcedure,
	listActivityProcedure,
	listProcedure,
	attachWorkItemSourceProcedure,
	listWorkItemSourcesProcedure,
	reconcileWorkItemSourcesProcedure,
	listRelationsProcedure,
	runWorkGraphStewardProcedure,
} from "./creation-reads";
import {
	assertWorkItemAccess,
	requireOwnerAdminWorkItemAuthor,
	rethrowWorkItemWriteError,
	authOs,
} from "./policy-helpers";

async function relationActor(
	context: Parameters<typeof verifiedActiveWorkActor>[0],
	items: Awaited<ReturnType<typeof assertWorkItemAccess>>[],
) {
	const actor = await verifiedActiveWorkActor(context, items[0]!.orgId);
	if (
		items.some(
			(item) => item.stewardType === actor.type && item.stewardId === actor.id,
		)
	)
		return actor;
	await requireOwnerAdminWorkItemAuthor(
		context,
		items[0]!.orgId,
		"Changing Work hierarchy or relations",
	);
	return actor;
}

export const setParentProcedure = authOs.setParent.handler(
	async ({ input, context }) => {
		const item = await assertWorkItemAccess(context, input.id);
		const actor = await relationActor(context, [item]);
		if (input.parentWorkItemId)
			await assertWorkItemAccess(context, input.parentWorkItemId);
		try {
			return await setWorkItemParent(context.db, {
				orgId: item.orgId,
				workItemId: item.id,
				parentWorkItemId: input.parentWorkItemId,
				expectedWorkItemVersion: input.expectedWorkItemVersion ?? item.version,
				actor,
			});
		} catch (error) {
			rethrowWorkItemWriteError(error);
		}
	},
);

export const removeRelationProcedure = authOs.removeRelation.handler(
	async ({ input, context }) => {
		const item = await assertWorkItemAccess(context, input.workItemId);
		const related = await assertWorkItemAccess(
			context,
			input.relatedWorkItemId,
		);
		const actor = await relationActor(context, [item, related]);
		return removeWorkItemRelation(context.db, {
			...input,
			orgId: item.orgId,
			actor,
		});
	},
);

export const addRelationProcedure = authOs.addRelation.handler(
	async ({ input, context }) => {
		const workItem = await assertWorkItemAccess(context, input.id);
		const related = await assertWorkItemAccess(context, input.toWorkItemId);
		if (related.orgId !== workItem.orgId) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Related Work Item is out of scope",
			);
		}
		return addWorkItemRelation(context.db, {
			id: crypto.randomUUID(),
			orgId: workItem.orgId,
			fromWorkItemId: input.id,
			toWorkItemId: input.toWorkItemId,
			relationType: input.relationType,
			metadata:
				input.metadata === undefined ? undefined : toJsonRecord(input.metadata),
			createdAt: new Date().toISOString(),
		});
	},
);

export const listRoute = skipOutputValidation(listProcedure);

export const getByIdRoute = skipOutputValidation(getByIdProcedure);

export const getWorkGraphHealthRoute = skipOutputValidation(
	getWorkGraphHealthProcedure,
);

export const runWorkGraphStewardRoute = skipOutputValidation(
	runWorkGraphStewardProcedure,
);

export const getOrgGraphHealthRoute = skipOutputValidation(
	getOrgGraphHealthProcedure,
);

export const listRelationsRoute = skipOutputValidation(listRelationsProcedure);

export const attachWorkItemSourceRoute = skipOutputValidation(
	attachWorkItemSourceProcedure,
);

export const listWorkItemSourcesRoute = skipOutputValidation(
	listWorkItemSourcesProcedure,
);

export const reconcileWorkItemSourcesRoute = skipOutputValidation(
	reconcileWorkItemSourcesProcedure,
);

export const listActivityRoute = skipOutputValidation(listActivityProcedure);
