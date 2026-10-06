/**
 * Tedi Objectives & Tasks Router
 * Mission directives and execution log
 *
 * REST Endpoints:
 * POST   /tedi-objectives                        - Create objective (authenticated + org scoped)
 * GET    /tedi-objectives                        - List objectives (authenticated + org scoped)
 * GET    /tedi-objectives/{id}                   - Get objective (authenticated + org scoped)
 * PATCH  /tedi-objectives/{id}                   - Update objective (authenticated + org scoped)
 * DELETE /tedi-objectives/{id}                   - Delete objective (authenticated + org scoped)
 * POST   /tedi-objectives/tasks                  - Create task (authenticated + org scoped)
 * GET    /tedi-objectives/tasks                  - List tasks (authenticated + org scoped)
 * PATCH  /tedi-objectives/tasks/{id}             - Update task (authenticated + org scoped)
 * DELETE /tedi-objectives/tasks/{id}             - Delete task (authenticated + org scoped)
 * GET    /tedi-objectives/tasks/active/{tediId}  - Get active tasks (authenticated + org scoped)
 */

import { implement } from "@orpc/server";
import {
	DEFAULT_STANDING_OBJECTIVE_GATE_CONFIG,
	tediObjectivesContract,
} from "@tedix/api-contract/contracts/tedi-objectives";
import { getPurposeCharterById } from "@tedix/db/queries/organization-purpose";
import {
	createObjective,
	createTask,
	deleteObjective,
	deleteTask,
	getActiveTasks,
	getObjectiveById,
	getTaskById,
	listObjectives,
	listTasks,
	updateObjective,
	updateTask,
} from "@tedix/db/queries/tedi-objectives";
import { getTediById } from "@tedix/db/queries/tedis";
import { toJsonRecord } from "@tedix/db/utils/json";
import { cascadeCompleteChildTasks } from "../../services/mission-os";
import { requireOrgId } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	skipOutputValidation,
	withAuth,
} from "../orpc";
import { hasEarnedDelegationGovernanceAuthority } from "./earned-delegation-access";

function optionalJsonRecord(
	value: Record<string, unknown> | undefined,
): ReturnType<typeof toJsonRecord> | undefined {
	return value === undefined ? undefined : toJsonRecord(value);
}

const objectivesOs = implement(tediObjectivesContract).$context<BaseContext>();
const authOs = objectivesOs.use(withAuth);

function canMutateObjectiveAuthority(context: BaseContext): boolean {
	return hasEarnedDelegationGovernanceAuthority(context);
}

const SAFE_UNTRUSTED_GATE = {
	...DEFAULT_STANDING_OBJECTIVE_GATE_CONFIG,
	autonomyLevel: "supervised" as const,
	gateType: "always" as const,
	currentStreak: 0,
	lastGraduatedAt: null,
};

function getOrganizationId(context: BaseContext): string | null {
	return context.organizationId ?? null;
}

async function assertObjectiveAccess(
	context: BaseContext,
	objectiveId: string,
): Promise<NonNullable<Awaited<ReturnType<typeof getObjectiveById>>>> {
	const objective = await getObjectiveById(context.db, objectiveId);
	if (!objective) {
		throw createError(ErrorCodes.NOT_FOUND, "Objective not found");
	}

	const orgId = requireOrgId(context);
	if (objective.orgId !== orgId) {
		throw createError(ErrorCodes.FORBIDDEN, "Access denied to this objective");
	}

	return objective;
}

async function assertTaskAccess(
	context: BaseContext,
	taskId: string,
): Promise<NonNullable<Awaited<ReturnType<typeof getTaskById>>>> {
	const task = await getTaskById(context.db, taskId);
	if (!task) {
		throw createError(ErrorCodes.NOT_FOUND, "Task not found");
	}

	const orgId = requireOrgId(context);
	if (task.orgId !== orgId) {
		throw createError(ErrorCodes.FORBIDDEN, "Access denied to this task");
	}

	return task;
}

async function assertTediAccess(
	context: BaseContext,
	tediId: string,
	inputOrgId?: string,
): Promise<{ tediId: string; orgId: string }> {
	const tedi = await getTediById(context.db, tediId);
	if (!tedi) {
		throw createError(ErrorCodes.NOT_FOUND, "Tedi not found");
	}

	const contextOrgId = getOrganizationId(context);
	const orgId = contextOrgId ?? inputOrgId;
	if (!orgId) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Organization scope is required for tedi access",
		);
	}

	if (tedi.organizationId !== orgId) {
		throw createError(ErrorCodes.FORBIDDEN, "Access denied to this tedi");
	}

	return { tediId: tedi.id, orgId: tedi.organizationId };
}

async function assertPurposeCharterAccess(
	context: BaseContext,
	purposeCharterId: string,
	orgId: string,
): Promise<void> {
	const charter = await getPurposeCharterById(context.db, purposeCharterId);
	if (!charter) {
		throw createError(ErrorCodes.BAD_REQUEST, "Purpose Charter not found");
	}
	if (charter.orgId !== orgId) {
		throw createError(ErrorCodes.FORBIDDEN, "Purpose Charter is out of scope");
	}
}

const createProcedure = authOs.create
	.use(AUTHZ.objectiveWrite)
	.handler(async ({ input, context }) => {
		const id = crypto.randomUUID();
		const access = await assertTediAccess(context, input.tediId, input.orgId);
		if (input.purposeCharterId) {
			await assertPurposeCharterAccess(
				context,
				input.purposeCharterId,
				access.orgId,
			);
		}

		const trustedAuthorityWriter = canMutateObjectiveAuthority(context);
		const objective = await createObjective(context.db, {
			id,
			tediId: access.tediId,
			orgId: access.orgId,
			purposeCharterId: input.purposeCharterId,
			title: input.title,
			description: input.description,
			approach: input.approach,
			successCriteria: input.successCriteria,
			constraints: input.constraints,
			type: input.type,
			riskLevel: input.riskLevel,
			priority: input.priority,
			linkedDomains: input.linkedDomains,
			gateConfig: optionalJsonRecord(
				trustedAuthorityWriter ? input.gateConfig : SAFE_UNTRUSTED_GATE,
			),
			budgetConfig: optionalJsonRecord(
				trustedAuthorityWriter ? input.budgetConfig : undefined,
			),
			createdAt: new Date().toISOString(),
		});

		return objective;
	});

const listProcedure = authOs.list
	.use(AUTHZ.objectiveRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);

		if (input?.tediId) {
			await assertTediAccess(context, input.tediId, orgId);
		}

		const limit = input?.limit ?? 50;
		const offset = input?.offset ?? 0;

		const { data, total } = await listObjectives(context.db, {
			orgId: orgId ?? undefined,
			tediId: input?.tediId,
			status: input?.status,
			type: input?.type,
			riskLevel: input?.riskLevel,
			limit,
			offset,
		});

		return {
			data,
			pagination: {
				limit,
				offset,
				total,
				hasMore: offset + limit < total,
			},
		};
	});

const getByIdProcedure = authOs.getById
	.use(AUTHZ.objectiveRead)
	.handler(async ({ input, context }) => {
		return assertObjectiveAccess(context, input.id);
	});

const updateProcedure = authOs.update
	.use(AUTHZ.objectiveWrite)
	.handler(async ({ input, context }) => {
		const existing = await assertObjectiveAccess(context, input.id);
		if (
			!canMutateObjectiveAuthority(context) &&
			(input.gateConfig !== undefined ||
				input.budgetConfig !== undefined ||
				input.riskLevel !== undefined)
		) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Only a user or organization API key may change objective authority, budget, or risk policy",
			);
		}
		if (input.purposeCharterId) {
			await assertPurposeCharterAccess(
				context,
				input.purposeCharterId,
				existing.orgId,
			);
		}

		const now = new Date().toISOString();
		const completedAt =
			input.status === "completed" || input.status === "failed"
				? now
				: undefined;

		const updated = await updateObjective(context.db, input.id, {
			purposeCharterId: input.purposeCharterId,
			title: input.title,
			description: input.description,
			approach: input.approach,
			successCriteria: input.successCriteria,
			constraints: input.constraints,
			status: input.status,
			riskLevel: input.riskLevel,
			priority: input.priority,
			linkedDomains: input.linkedDomains,
			gateConfig: optionalJsonRecord(input.gateConfig),
			budgetConfig: optionalJsonRecord(input.budgetConfig),
			progress: optionalJsonRecord(input.progress),
			updatedAt: now,
			completedAt,
		});

		if (!updated) {
			throw createError(ErrorCodes.BAD_REQUEST, "Failed to update objective");
		}

		if (input.status === "completed" || input.status === "failed") {
			try {
				await cascadeCompleteChildTasks(context.db, input.id, input.status);
			} catch (err) {
				console.error(
					`[Objectives] cascade failed for ${input.id}:`,
					err instanceof Error ? err.message : err,
				);
			}
		}

		return updated;
	});

const deleteProcedure = objectivesOs.delete
	.use(withAuth)
	.handler(async ({ input, context }) => {
		await assertObjectiveAccess(context, input.id);

		await deleteObjective(context.db, input.id, new Date().toISOString());
		return { success: true as const, deletedId: input.id };
	});

const createTaskProcedure = authOs.createTask
	.use(AUTHZ.objectiveWrite)
	.handler(async ({ input, context }) => {
		const id = crypto.randomUUID();
		const access = await assertTediAccess(context, input.tediId, input.orgId);

		if (input.objectiveId) {
			const objective = await assertObjectiveAccess(context, input.objectiveId);
			if (objective.tediId !== access.tediId) {
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Objective does not belong to this tedi",
				);
			}
		}

		const task = await createTask(context.db, {
			id,
			tediId: access.tediId,
			orgId: access.orgId,
			objectiveId: input.objectiveId,
			title: input.title,
			kind: input.kind,
			blocker: input.blocker,
			evidence: input.evidence,
			toolingUsed: input.toolingUsed,
			estimatedCost: optionalJsonRecord(input.estimatedCost),
			createdAt: new Date().toISOString(),
		});

		return task;
	});

const listTasksProcedure = authOs.listTasks
	.use(AUTHZ.objectiveRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);

		if (input?.tediId) {
			await assertTediAccess(context, input.tediId, orgId);
		}

		const limit = input?.limit ?? 50;
		const offset = input?.offset ?? 0;

		const { data, total } = await listTasks(context.db, {
			orgId: orgId ?? undefined,
			tediId: input?.tediId,
			objectiveId: input?.objectiveId,
			status: input?.status,
			kind: input?.kind,
			limit,
			offset,
		});

		return {
			data,
			pagination: {
				limit,
				offset,
				total,
				hasMore: offset + limit < total,
			},
		};
	});

const updateTaskProcedure = authOs.updateTask
	.use(AUTHZ.objectiveWrite)
	.handler(async ({ input, context }) => {
		await assertTaskAccess(context, input.id);

		const now = new Date().toISOString();
		const completedAt =
			input.status === "completed" ||
			input.status === "failed" ||
			input.status === "abandoned"
				? now
				: undefined;

		const updated = await updateTask(context.db, input.id, {
			objectiveId: input.objectiveId,
			kind: input.kind,
			status: input.status,
			blocker: input.blocker,
			evidence: input.evidence,
			toolingUsed: input.toolingUsed,
			estimatedCost: optionalJsonRecord(input.estimatedCost),
			result: input.result,
			actualCost: optionalJsonRecord(input.actualCost),
			budgetUsed: optionalJsonRecord(input.budgetUsed),
			failCount: input.failCount,
			updatedAt: now,
			completedAt,
		});

		if (!updated) {
			throw createError(ErrorCodes.BAD_REQUEST, "Failed to update task");
		}

		return updated;
	});

const deleteTaskProcedure = authOs.deleteTask
	.use(AUTHZ.objectiveWrite)
	.handler(async ({ input, context }) => {
		await assertTaskAccess(context, input.id);

		await deleteTask(context.db, input.id);
		return { success: true as const, deletedId: input.id };
	});

const getActiveTasksProcedure = authOs.getActiveTasks
	.use(AUTHZ.objectiveRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		await assertTediAccess(context, input.tediId, orgId);
		const data = await getActiveTasks(context.db, input.tediId);
		return { data };
	});

export const tediObjectivesContractRouter = objectivesOs.router({
	create: createProcedure,
	list: skipOutputValidation(listProcedure),
	getById: skipOutputValidation(getByIdProcedure),
	update: updateProcedure,
	delete: deleteProcedure,
	createTask: createTaskProcedure,
	listTasks: skipOutputValidation(listTasksProcedure),
	updateTask: updateTaskProcedure,
	deleteTask: deleteTaskProcedure,
	getActiveTasks: skipOutputValidation(getActiveTasksProcedure),
});
