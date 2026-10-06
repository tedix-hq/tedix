import {
	listOrgWorkAttempts,
	listOrgWorkRecovery,
} from "@tedix/db/queries/work-items/projections";
import { listWorkItemReadinessProjection } from "@tedix/db/queries/work-items/readiness";
import { requireOrgId } from "../../org-scope";
import { withAuthorization } from "../../orpc";
import { authOs } from "./policy-helpers";

const projectionOs = authOs.use(
	withAuthorization(
		{
			handlerOwnedUserAuthorization:
				"Read-only Work factory projections are restricted to the caller's organization",
		},
		"mcp:messaging.read",
	),
);

export const listReadinessProjectionProcedure =
	projectionOs.listReadinessProjection.handler(async ({ input, context }) => {
		const page = await listWorkItemReadinessProjection(context.db, {
			orgId: requireOrgId(context),
			projectId: input?.projectId,
			workKind: input?.workKind,
			cursor: input?.cursor
				? { createdAt: input.cursor.at, id: input.cursor.id }
				: undefined,
			limit: input?.limit,
			observedAt: new Date().toISOString(),
		});
		return {
			...page,
			nextCursor: page.nextCursor
				? { at: page.nextCursor.createdAt, id: page.nextCursor.id }
				: null,
		};
	});

export const listAttemptProjectionProcedure =
	projectionOs.listAttemptProjection.handler(async ({ input, context }) =>
		listOrgWorkAttempts(context.db, {
			orgId: requireOrgId(context),
			projectId: input.projectId,
			workItemId: input.workItemId,
			runtimeStates: input.runtimeStates,
			outcomes: input.outcomes,
			executorType: input.executorType,
			cursor: input.cursor,
			limit: input.limit,
		}),
	);

export const listRecoveryProjectionProcedure =
	projectionOs.listRecoveryProjection.handler(async ({ input, context }) => {
		const observedAt = new Date().toISOString();
		return {
			...(await listOrgWorkRecovery(context.db, {
				orgId: requireOrgId(context),
				projectId: input.projectId,
				workKind: input.workKind,
				riskLevel: input.riskLevel,
				priority: input.priority,
				signal: input.signal,
				observedAt,
				cursor: input.cursor,
				limit: input.limit,
			})),
			observedAt,
		};
	});
