import {
	addWorkCaseDependency,
	createWorkCase,
	getWorkCase,
	linkWorkItemToCase,
	listWorkCaseDependencies,
	listWorkCaseItems,
	listWorkCases,
	updateWorkCase,
} from "@tedix/db/queries/work-items/cases";
import {
	WorkCaseDependencySchema,
	WorkCaseItemSchema,
	WorkCaseSchema,
} from "@tedix/api-contract/schemas/work-items";
import { requireOrgId } from "../../org-scope";
import { AUTHZ, withAuthorization } from "../../orpc";
import {
	authOs,
	rethrowWorkControlError,
	verifiedWorkFactoryMutator,
} from "./policy-helpers";

const caseReadOs = authOs.use(AUTHZ.messagingRead);
const caseWriteOs = authOs.use(
	withAuthorization(
		{
			handlerOwnedUserAuthorization:
				"Case handlers derive owner/admin or active agent mutation authority from the authenticated credential and bind every write to its organization",
		},
		"mcp:messaging.write",
	),
);

function rethrowCaseError(error: unknown): never {
	return rethrowWorkControlError(error, { transitionConflict: true });
}

function caseOutput(row: Awaited<ReturnType<typeof getWorkCase>>) {
	return WorkCaseSchema.parse({
		id: row.id,
		orgId: row.orgId,
		projectId: row.projectId,
		objectiveId: row.objectiveId,
		kind: row.kind,
		title: row.title,
		description: row.description,
		stage: row.stage,
		accountableOwnerType: row.accountableOwnerType,
		accountableOwnerId: row.accountableOwnerId,
		openedAt: row.openedAt,
		targetResolutionAt: row.targetResolutionAt,
		closedAt: row.closedAt,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		version: row.version,
	});
}

function caseItemOutput(
	row: Awaited<ReturnType<typeof listWorkCaseItems>>["data"][number],
) {
	return WorkCaseItemSchema.parse({
		id: row.id,
		orgId: row.orgId,
		caseId: row.caseId,
		workItemId: row.workItemId,
		rationale: row.rationale,
		discoveredAt: row.discoveredAt,
	});
}

function caseDependencyOutput(
	row: Awaited<ReturnType<typeof listWorkCaseDependencies>>["data"][number],
) {
	return WorkCaseDependencySchema.parse({
		id: row.id,
		orgId: row.orgId,
		fromCaseId: row.prerequisiteCaseId,
		toCaseId: row.dependentCaseId,
		createdAt: row.createdAt,
	});
}

export const createCaseProcedure = caseWriteOs.createCase.handler(
	async ({ input, context }) => {
		const orgId = requireOrgId(context);
		await verifiedWorkFactoryMutator(context, orgId);
		const now = new Date().toISOString();
		try {
			return caseOutput(
				await createWorkCase(context.db, {
					id: crypto.randomUUID(),
					orgId,
					projectId: input.projectId,
					objectiveId: input.objectiveId,
					kind: input.kind,
					title: input.title,
					description: input.description,
					stage: input.stage,
					accountableOwnerType: input.accountableOwnerType,
					accountableOwnerId: input.accountableOwnerId,
					openedAt: input.openedAt ?? now,
					targetResolutionAt: input.targetResolutionAt,
					now,
				}),
			);
		} catch (error) {
			rethrowCaseError(error);
		}
	},
);

export const listCasesProcedure = caseReadOs.listCases.handler(
	async ({ input, context }) => {
		const limit = input?.limit ?? 50;
		const result = await listWorkCases(context.db, {
			orgId: requireOrgId(context),
			projectId: input?.projectId,
			stages: input?.stages,
			limit,
			cursor: input?.cursor
				? { createdAt: input.cursor.at, id: input.cursor.id }
				: undefined,
		});
		return {
			data: result.data.map(caseOutput),
			nextCursor: result.nextCursor
				? { at: result.nextCursor.createdAt, id: result.nextCursor.id }
				: null,
		};
	},
);

export const getCaseProcedure = caseReadOs.getCase.handler(
	async ({ input, context }) => {
		const orgId = requireOrgId(context);
		try {
			const workCase = await getWorkCase(context.db, {
				orgId,
				caseId: input.caseId,
			});
			const [items, dependencies] = await Promise.all([
				listWorkCaseItems(context.db, {
					orgId,
					caseId: workCase.id,
					cursor: input.itemCursor,
					limit: input.itemLimit,
				}),
				listWorkCaseDependencies(context.db, {
					orgId,
					caseId: workCase.id,
					cursor: input.dependencyCursor,
					limit: input.dependencyLimit,
				}),
			]);
			return {
				workCase: caseOutput(workCase),
				items: {
					data: items.data.map(caseItemOutput),
					nextCursor: items.nextCursor,
				},
				dependencies: {
					data: dependencies.data.map(caseDependencyOutput),
					nextCursor: dependencies.nextCursor,
				},
			};
		} catch (error) {
			rethrowCaseError(error);
		}
	},
);

export const updateCaseProcedure = caseWriteOs.updateCase.handler(
	async ({ input, context }) => {
		const orgId = requireOrgId(context);
		await verifiedWorkFactoryMutator(context, orgId);
		try {
			return caseOutput(
				await updateWorkCase(context.db, {
					...input,
					orgId,
					now: new Date().toISOString(),
				}),
			);
		} catch (error) {
			rethrowCaseError(error);
		}
	},
);

export const attachCaseWorkItemProcedure =
	caseWriteOs.attachCaseWorkItem.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		await verifiedWorkFactoryMutator(context, orgId);
		try {
			return caseItemOutput(
				await linkWorkItemToCase(context.db, {
					id: crypto.randomUUID(),
					orgId,
					caseId: input.caseId,
					workItemId: input.workItemId,
					rationale: input.rationale,
					discoveredAt: new Date().toISOString(),
				}),
			);
		} catch (error) {
			rethrowCaseError(error);
		}
	});

export const addCaseDependencyProcedure = caseWriteOs.addCaseDependency.handler(
	async ({ input, context }) => {
		const orgId = requireOrgId(context);
		await verifiedWorkFactoryMutator(context, orgId);
		try {
			return caseDependencyOutput(
				await addWorkCaseDependency(context.db, {
					id: crypto.randomUUID(),
					orgId,
					prerequisiteCaseId: input.fromCaseId,
					dependentCaseId: input.toCaseId,
					now: new Date().toISOString(),
				}),
			);
		} catch (error) {
			rethrowCaseError(error);
		}
	},
);
