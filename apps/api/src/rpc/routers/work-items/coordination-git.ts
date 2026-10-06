import { listWorkItemAttempts } from "@tedix/db/queries/work-items/attempts";
import {
	addWorkItemCorroboration,
	listWorkItemCorroborations,
} from "@tedix/db/queries/work-items/comments";
import { upsertWorkItemProjection } from "@tedix/db/queries/work-items/crud";
import { addWorkItemRelation } from "@tedix/db/queries/work-items/relations";
import { toJsonRecord } from "@tedix/db/utils/json";
import { ErrorCodes, createError, skipOutputValidation } from "../../orpc";
import { corroborationPrincipal } from "../work-items-principal";
import {
	getByIdProcedure,
	getOrgGraphHealthProcedure,
	getWorkGraphHealthProcedure,
	listActivityProcedure,
	listProcedure,
	attachWorkItemSourceProcedure,
	listProjectionsProcedure,
	listWorkItemSourcesProcedure,
	reconcileWorkItemSourcesProcedure,
	listRelationsProcedure,
	runWorkGraphStewardProcedure,
} from "./creation-reads";
import {
	assertWorkItemAccess,
	authOs,
	rethrowWorkControlError,
} from "./policy-helpers";

export const corroborateProcedure = authOs.corroborate.handler(
	async ({ input, context }) => {
		const workItem = await assertWorkItemAccess(context, input.id);
		const principal = await corroborationPrincipal(context, workItem.orgId);
		const attempts = await listWorkItemAttempts(context.db, {
			orgId: workItem.orgId,
			workItemId: workItem.id,
		});
		const activeAttempt = attempts.data.find((attempt) =>
			["queued", "running", "waiting", "retrying"].includes(
				attempt.runtimeState,
			),
		);
		// Self-CORROBORATION is worthless: an executor agreeing with itself adds
		// no independent principal, which is the only thing this ledger counts.
		// Self-CONTRADICTION is the opposite — an executor saying "my settled
		// claim was wrong" is the cheapest true signal the detection plane can
		// receive, and refusing it would make honesty the one move the protocol
		// forbids.
		if (
			input.stance === "corroborates" &&
			activeAttempt &&
			activeAttempt.executorType === principal.type &&
			activeAttempt.executorId === principal.id
		) {
			throw createError(
				ErrorCodes.CONFLICT,
				"The active executor cannot corroborate its own Work Item; it may contradict it",
			);
		}
		try {
			const result = await addWorkItemCorroboration(context.db, {
				id: crypto.randomUUID(),
				workItemId: workItem.id,
				orgId: workItem.orgId,
				principalType: principal.type,
				principalId: principal.id,
				sessionId: principal.sessionId,
				evidenceRef: input.evidenceRef,
				stance: input.stance,
				body: input.body,
				occurredAt: new Date().toISOString(),
			});
			return result.corroboration;
		} catch (error) {
			rethrowWorkControlError(error);
		}
	},
);

export const listCorroborationsProcedure = authOs.listCorroborations.handler(
	async ({ input, context }) => {
		const workItem = await assertWorkItemAccess(context, input.id);
		return listWorkItemCorroborations(context.db, workItem.id);
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

export const upsertProjectionProcedure = authOs.upsertProjection.handler(
	async ({ input, context }) => {
		const workItem = await assertWorkItemAccess(context, input.id);
		return upsertWorkItemProjection(context.db, {
			id: crypto.randomUUID(),
			workItemId: input.id,
			orgId: workItem.orgId,
			provider: input.provider,
			direction: input.direction,
			status: input.status,
			externalId: input.externalId,
			externalUrl: input.externalUrl,
			externalProjectId: input.externalProjectId,
			externalSectionId: input.externalSectionId,
			lastSyncedAt: input.lastSyncedAt,
			lastError: input.lastError,
			syncCursor: input.syncCursor,
			providerState:
				input.providerState === undefined
					? undefined
					: toJsonRecord(input.providerState),
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

export const listProjectionsRoute = skipOutputValidation(
	listProjectionsProcedure,
);

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
