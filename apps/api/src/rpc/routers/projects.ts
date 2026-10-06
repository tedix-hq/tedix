/**
 * Projects Router (work hierarchy v1)
 *
 * Org-scoped project container at the top of the work hierarchy
 * project → epic → feature → story → work_item → task. Work Items stay the
 * canonical coordination object; a project just groups them (via
 * `work_items.projectId`) and exposes a rollup.
 *
 * REST Endpoints:
 * POST   /projects              - Create project (org scoped, unique key)
 * PATCH  /projects/{id}         - Update project
 * POST   /projects/{id}/archive - Soft-archive project (audit-preserving)
 * GET    /projects              - List projects (flat, status-filtered)
 * GET    /projects/{id}         - Get project
 * GET    /projects/{id}/rollup  - Project rollup (status/type counts + headline items)
 */

import { implement } from "@orpc/server";
import {
	ProjectHealthJudgmentSchema,
	ProjectMilestoneDependencySchema,
	ProjectMilestoneSchema,
	projectsContract,
} from "@tedix/api-contract/contracts/projects";
import {
	recordWorkProjectHealthJudgment,
	listWorkProjectHealthJudgments,
} from "@tedix/db/queries/work-items/health";
import {
	addWorkMilestoneDependency,
	createWorkMilestone,
	getWorkMilestone,
	linkWorkItemToMilestone,
	listWorkMilestoneViews,
	updateWorkMilestone,
} from "@tedix/db/queries/work-items/milestones";
import {
	assignWorkItemToSprint,
	createWorkSprint,
	listWorkSprints,
} from "@tedix/db/queries/work-items/sprints";
import {
	archiveProject,
	createProject,
	getProjectById,
	getProjectByKey,
	getProjectRollup,
	listProjects,
	ProjectPurposeError,
	updateProject,
} from "@tedix/db/queries/projects";
import { getObjectiveById } from "@tedix/db/queries/tedi-objectives";
import { getTediById } from "@tedix/db/queries/tedis";
import type { Project } from "@tedix/db/schema/projects";
import { toJsonRecord } from "@tedix/db/utils/json";
import { requireOrgIdOrInput } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	skipOutputValidation,
	withAuth,
} from "../orpc";
import { verifiedActiveWorkActor } from "./work-items-principal";
import {
	rethrowWorkControlError,
	verifiedWorkFactoryMutator,
} from "./work-items/policy-helpers";

const projectsOs = implement(projectsContract).$context<BaseContext>();
const authOs = projectsOs.use(withAuth);

async function assertProjectAccess(
	context: BaseContext,
	projectId: string,
): Promise<Project> {
	const project = await getProjectById(context.db, projectId);
	if (!project) {
		throw createError(ErrorCodes.NOT_FOUND, "Project not found");
	}
	const orgId = requireOrgIdOrInput(context);
	if (project.orgId !== orgId) {
		throw createError(ErrorCodes.FORBIDDEN, "Access denied to this project");
	}
	return project;
}

/** Cross-org guard for an optional lead tedi reference. */
async function assertLeadTediInOrg(
	context: BaseContext,
	orgId: string,
	leadTediId: string,
): Promise<void> {
	const tedi = await getTediById(context.db, leadTediId);
	if (!tedi) {
		throw createError(ErrorCodes.BAD_REQUEST, "Lead tedi not found");
	}
	if (tedi.organizationId !== orgId) {
		throw createError(ErrorCodes.FORBIDDEN, "Lead tedi is out of scope");
	}
}

/** Cross-org guard for an optional objective reference. */
async function assertObjectiveInOrg(
	context: BaseContext,
	orgId: string,
	objectiveId: string,
): Promise<void> {
	const objective = await getObjectiveById(context.db, objectiveId);
	if (!objective) {
		throw createError(ErrorCodes.BAD_REQUEST, "Objective not found");
	}
	if (objective.orgId !== orgId) {
		throw createError(ErrorCodes.FORBIDDEN, "Objective is out of scope");
	}
}

const createProcedure = authOs.create
	.use(AUTHZ.objectiveWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgIdOrInput(context, input.organizationId);

		const existing = await getProjectByKey(context.db, orgId, input.key);
		if (existing) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Project key "${input.key}" already exists in this organization`,
			);
		}
		if (input.leadTediId) {
			await assertLeadTediInOrg(context, orgId, input.leadTediId);
		}
		if (input.objectiveId) {
			await assertObjectiveInOrg(context, orgId, input.objectiveId);
		}

		return createProject(context.db, {
			id: crypto.randomUUID(),
			orgId,
			key: input.key,
			name: input.name,
			description: input.description,
			status: input.status,
			leadTediId: input.leadTediId,
			ownerUserId: input.ownerUserId,
			objectiveId: input.objectiveId,
			targetDate: input.targetDate,
			metadata:
				input.metadata === undefined ? undefined : toJsonRecord(input.metadata),
			createdAt: new Date().toISOString(),
		});
	});

const updateProcedure = authOs.update
	.use(AUTHZ.objectiveWrite)
	.handler(async ({ input, context }) => {
		const existing = await assertProjectAccess(context, input.id);
		if (input.leadTediId) {
			await assertLeadTediInOrg(context, existing.orgId, input.leadTediId);
		}
		if (input.objectiveId) {
			await assertObjectiveInOrg(context, existing.orgId, input.objectiveId);
		}

		let updated: Awaited<ReturnType<typeof updateProject>>;
		try {
			updated = await updateProject(context.db, input.id, {
				name: input.name,
				description: input.description,
				status: input.status,
				leadTediId: input.leadTediId,
				ownerUserId: input.ownerUserId,
				objectiveId: input.objectiveId,
				targetDate: input.targetDate,
				metadata:
					input.metadata === undefined
						? undefined
						: toJsonRecord(input.metadata),
				updatedAt: new Date().toISOString(),
			});
		} catch (error) {
			if (error instanceof ProjectPurposeError) {
				throw createError(ErrorCodes.CONFLICT, error.message);
			}
			throw error;
		}
		if (!updated) {
			throw createError(ErrorCodes.BAD_REQUEST, "Failed to update project");
		}
		return updated;
	});

const archiveProcedure = authOs.archive
	.use(AUTHZ.objectiveWrite)
	.handler(async ({ input, context }) => {
		await assertProjectAccess(context, input.id);
		const archived = await archiveProject(
			context.db,
			input.id,
			new Date().toISOString(),
		);
		if (!archived) {
			throw createError(ErrorCodes.BAD_REQUEST, "Failed to archive project");
		}
		return archived;
	});

const listProcedure = authOs.list
	.use(AUTHZ.objectiveRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgIdOrInput(context, input?.organizationId);
		const limit = input?.limit ?? 50;
		const offset = input?.offset ?? 0;
		const { data, total } = await listProjects(context.db, {
			orgId,
			status: input?.status,
			search: input?.search,
			limit,
			offset,
		});
		return {
			data,
			pagination: { limit, offset, total, hasMore: offset + limit < total },
		};
	});

const getProcedure = authOs.get
	.use(AUTHZ.objectiveRead)
	.handler(async ({ input, context }) => {
		return assertProjectAccess(context, input.id);
	});

const getRollupProcedure = authOs.getRollup
	.use(AUTHZ.objectiveRead)
	.handler(async ({ input, context }) => {
		const project = await assertProjectAccess(context, input.id);
		const rollup = await getProjectRollup(context.db, {
			orgId: project.orgId,
			projectId: project.id,
		});
		return {
			...rollup,
			topLevelItems: rollup.topLevelItems.map(({ status, ...item }) => ({
				...item,
				disposition: status,
			})),
		};
	});

function rethrowMilestoneError(error: unknown): never {
	return rethrowWorkControlError(error, { transitionConflict: true });
}

function milestoneOutput(row: Awaited<ReturnType<typeof getWorkMilestone>>) {
	return ProjectMilestoneSchema.parse({
		id: row.id,
		orgId: row.orgId,
		projectId: row.projectId,
		title: row.title,
		description: row.description,
		lifecycle: row.status,
		accountableOwnerType: row.accountableOwnerType,
		accountableOwnerId: row.accountableOwnerId,
		targetAt: row.targetAt,
		proofRef: row.proofRef,
		completedAt: row.doneAt,
		cancelledAt: row.cancelledAt,
		sortOrder: row.sortOrder,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		version: row.version,
	});
}

function milestoneDependencyOutput(row: {
	id: string;
	orgId: string;
	prerequisiteMilestoneId: string;
	dependentMilestoneId: string;
	createdAt: string;
}) {
	return ProjectMilestoneDependencySchema.parse({
		id: row.id,
		orgId: row.orgId,
		fromMilestoneId: row.prerequisiteMilestoneId,
		toMilestoneId: row.dependentMilestoneId,
		createdAt: row.createdAt,
	});
}

async function assertMilestoneAccess(
	context: BaseContext,
	projectId: string,
	milestoneId: string,
) {
	const project = await assertProjectAccess(context, projectId);
	const milestone = await getWorkMilestone(context.db, {
		orgId: project.orgId,
		milestoneId,
	});
	if (!milestone) {
		throw createError(ErrorCodes.NOT_FOUND, "Milestone not found");
	}
	if (milestone.projectId !== project.id) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Milestone is outside this project",
		);
	}
	return { project, milestone };
}

const createMilestoneProcedure = authOs.createMilestone
	.use(AUTHZ.objectiveWrite)
	.handler(async ({ input, context }) => {
		const project = await assertProjectAccess(context, input.id);
		await verifiedWorkFactoryMutator(context, project.orgId);
		try {
			return milestoneOutput(
				await createWorkMilestone(context.db, {
					id: crypto.randomUUID(),
					orgId: project.orgId,
					projectId: project.id,
					title: input.title,
					description: input.description,
					status: input.lifecycle,
					accountableOwnerType: input.accountableOwnerType,
					accountableOwnerId: input.accountableOwnerId,
					targetAt: input.targetAt,
					proofRef: input.proofRef,
					sortOrder: input.sortOrder,
					now: new Date().toISOString(),
				}),
			);
		} catch (error) {
			rethrowMilestoneError(error);
		}
	});

const listMilestonesProcedure = authOs.listMilestones
	.use(AUTHZ.objectiveRead)
	.handler(async ({ input, context }) => {
		const project = await assertProjectAccess(context, input.id);
		const views = await listWorkMilestoneViews(context.db, {
			orgId: project.orgId,
			projectId: project.id,
			status: input.lifecycle,
			cursor: input.cursor,
			limit: input.limit,
		});
		return {
			data: views.data.map((view) => ({
				milestone: milestoneOutput(view.milestone),
				workItems: view.workItems,
				dependencies: view.dependencies.map(milestoneDependencyOutput),
				workItemsTruncated: view.workItemsTruncated,
				dependenciesTruncated: view.dependenciesTruncated,
			})),
			nextCursor: views.nextCursor,
		};
	});

const createSprintProcedure = authOs.createSprint
	.use(AUTHZ.objectiveWrite)
	.handler(async ({ input, context }) => {
		const project = await assertProjectAccess(context, input.id);
		await verifiedWorkFactoryMutator(context, project.orgId);
		try {
			return await createWorkSprint(context.db, {
				id: crypto.randomUUID(),
				orgId: project.orgId,
				projectId: project.id,
				name: input.name,
				goal: input.goal,
				status: input.status,
				startAt: input.startAt,
				endAt: input.endAt,
				now: new Date().toISOString(),
			});
		} catch (error) {
			rethrowWorkControlError(error);
		}
	});

const listSprintsProcedure = authOs.listSprints
	.use(AUTHZ.objectiveRead)
	.handler(async ({ input, context }) => {
		const project = await assertProjectAccess(context, input.id);
		return {
			data: await listWorkSprints(context.db, {
				orgId: project.orgId,
				projectId: project.id,
			}),
		};
	});

const assignSprintWorkItemProcedure = authOs.assignSprintWorkItem
	.use(AUTHZ.objectiveWrite)
	.handler(async ({ input, context }) => {
		const project = await assertProjectAccess(context, input.id);
		await verifiedWorkFactoryMutator(context, project.orgId);
		try {
			const row = await assignWorkItemToSprint(context.db, {
				orgId: project.orgId,
				sprintId: input.sprintId,
				workItemId: input.workItemId,
				now: new Date().toISOString(),
			});
			return { sprintId: row.sprintId, workItemId: row.workItemId };
		} catch (error) {
			rethrowWorkControlError(error);
		}
	});

const updateMilestoneProcedure = authOs.updateMilestone
	.use(AUTHZ.objectiveWrite)
	.handler(async ({ input, context }) => {
		const { project } = await assertMilestoneAccess(
			context,
			input.id,
			input.milestoneId,
		);
		await verifiedWorkFactoryMutator(context, project.orgId);
		try {
			return milestoneOutput(
				await updateWorkMilestone(context.db, {
					orgId: project.orgId,
					milestoneId: input.milestoneId,
					expectedVersion: input.expectedVersion,
					title: input.title,
					description: input.description,
					status: input.lifecycle,
					accountableOwnerType: input.accountableOwnerType,
					accountableOwnerId: input.accountableOwnerId,
					targetAt: input.targetAt,
					proofRef: input.proofRef,
					sortOrder: input.sortOrder,
					now: new Date().toISOString(),
				}),
			);
		} catch (error) {
			rethrowMilestoneError(error);
		}
	});

const attachMilestoneWorkItemProcedure = authOs.attachMilestoneWorkItem
	.use(AUTHZ.objectiveWrite)
	.handler(async ({ input, context }) => {
		const { project } = await assertMilestoneAccess(
			context,
			input.id,
			input.milestoneId,
		);
		await verifiedWorkFactoryMutator(context, project.orgId);
		try {
			await linkWorkItemToMilestone(context.db, {
				orgId: project.orgId,
				milestoneId: input.milestoneId,
				workItemId: input.workItemId,
				now: new Date().toISOString(),
			});
			return {
				milestoneId: input.milestoneId,
				workItemId: input.workItemId,
			};
		} catch (error) {
			rethrowMilestoneError(error);
		}
	});

const addMilestoneDependencyProcedure = authOs.addMilestoneDependency
	.use(AUTHZ.objectiveWrite)
	.handler(async ({ input, context }) => {
		const project = await assertProjectAccess(context, input.id);
		await verifiedWorkFactoryMutator(context, project.orgId);
		const [from, to] = await Promise.all([
			getWorkMilestone(context.db, {
				orgId: project.orgId,
				milestoneId: input.fromMilestoneId,
			}),
			getWorkMilestone(context.db, {
				orgId: project.orgId,
				milestoneId: input.toMilestoneId,
			}),
		]);
		if (from?.projectId !== project.id || to?.projectId !== project.id) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Both milestones must belong to this project",
			);
		}
		try {
			return milestoneDependencyOutput(
				await addWorkMilestoneDependency(context.db, {
					id: crypto.randomUUID(),
					orgId: project.orgId,
					prerequisiteMilestoneId: input.fromMilestoneId,
					dependentMilestoneId: input.toMilestoneId,
					now: new Date().toISOString(),
				}),
			);
		} catch (error) {
			rethrowMilestoneError(error);
		}
	});

const recordHealthJudgmentProcedure = authOs.recordHealthJudgment
	.use(AUTHZ.objectiveWrite)
	.handler(async ({ input, context }) => {
		const project = await assertProjectAccess(context, input.id);
		const actor = await verifiedWorkFactoryMutator(context, project.orgId);
		let row: Awaited<ReturnType<typeof recordWorkProjectHealthJudgment>>;
		try {
			row = await recordWorkProjectHealthJudgment(context.db, {
				id: crypto.randomUUID(),
				orgId: project.orgId,
				projectId: project.id,
				status: input.health,
				summary: input.summary,
				actorType: actor.type,
				actorId: actor.id,
				actorSessionId: actor.sessionId,
				externalSessionKey: actor.externalSessionKey,
				observedAt: new Date().toISOString(),
				targetAt: input.targetAt ?? project.targetDate,
			});
		} catch (error) {
			rethrowWorkControlError(error, { invalidPrincipal: "forbidden" });
		}
		return ProjectHealthJudgmentSchema.parse({
			id: row.id,
			orgId: row.orgId,
			projectId: row.projectId,
			health: row.status,
			summary: row.summary,
			judgedByType: row.actorType,
			judgedById: row.actorId,
			observedAt: row.observedAt,
			targetAt: row.targetAt,
		});
	});

const listHealthJudgmentsProcedure = authOs.listHealthJudgments
	.use(AUTHZ.objectiveRead)
	.handler(async ({ input, context }) => {
		const project = await assertProjectAccess(context, input.id);
		const rows = await listWorkProjectHealthJudgments(context.db, {
			orgId: project.orgId,
			projectId: project.id,
			limit: input.limit,
		});
		return rows.map((row) =>
			ProjectHealthJudgmentSchema.parse({
				id: row.id,
				orgId: row.orgId,
				projectId: row.projectId,
				health: row.status,
				summary: row.summary,
				judgedByType: row.actorType,
				judgedById: row.actorId,
				observedAt: row.observedAt,
				targetAt: row.targetAt,
			}),
		);
	});

export const projectsContractRouter = projectsOs.router({
	create: createProcedure,
	update: updateProcedure,
	archive: archiveProcedure,
	list: skipOutputValidation(listProcedure),
	get: getProcedure,
	getRollup: skipOutputValidation(getRollupProcedure),
	createMilestone: createMilestoneProcedure,
	listMilestones: listMilestonesProcedure,
	createSprint: createSprintProcedure,
	listSprints: listSprintsProcedure,
	assignSprintWorkItem: assignSprintWorkItemProcedure,
	updateMilestone: updateMilestoneProcedure,
	attachMilestoneWorkItem: attachMilestoneWorkItemProcedure,
	addMilestoneDependency: addMilestoneDependencyProcedure,
	recordHealthJudgment: recordHealthJudgmentProcedure,
	listHealthJudgments: listHealthJudgmentsProcedure,
});
