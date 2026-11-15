/**
 * Projects Router
 *
 * An organization-scoped project groups an area or engagement. Work Items stay
 * the canonical coordination object; a project groups them through
 * `work_items.projectId` and exposes a rollup.
 *
 * REST Endpoints:
 * POST   /projects              - Create project (org scoped, unique key)
 * PATCH  /projects/{id}         - Update project
 * POST   /projects/{id}/archive - Soft-archive project (audit-preserving)
 * GET    /projects              - List projects (flat, status-filtered)
 * GET    /projects/{id}         - Get project
 * GET    /projects/{id}/rollup  - Project rollup (status/type counts + headline items)
 * GET    /projects/portfolio    - Every project with its card counts, next item, health
 * GET    /projects/factory-scoreboard - Each loop and Blueprint with 7-day runs, Outputs, Work
 * POST   /projects/factories     - Build a factory from a goal (project-factories.ts)
 * GET    /projects/factory-health - One verdict per factory (project-factories.ts)
 */

import { implement } from "@orpc/server";
import { excludedAgentReviewProjectId } from "../../services/agent-review-access";
import { projectMetadataForUpdate } from "../../lib/project-metadata";
import {
	ProjectHealthJudgmentSchema,
	projectsContract,
} from "@tedix/api-contract/contracts/projects";
import {
	recordWorkProjectHealthJudgment,
	listWorkProjectHealthJudgments,
} from "@tedix/db/queries/work-items/health";
import { FACTORY_HEALTH_DEFAULT_RUNS } from "@tedix/api-contract/schemas/factories";
import { listFactoryHealth } from "@tedix/db/queries/factories";
import { listFactoryScoreboard } from "@tedix/db/queries/factory-scoreboard";
import {
	archiveProject,
	createProject,
	getProjectById,
	getProjectByKey,
	getProjectRollup,
	listProjectPortfolio,
	listProjects,
	ProjectPurposeError,
	updateProject,
} from "@tedix/db/queries/projects";
import { getObjectiveById } from "@tedix/db/queries/tedi-objectives";
import { getTediById } from "@tedix/db/queries/tedis";
import {
	pauseFactoryProcedure,
	resumeFactoryProcedure,
	archiveFactoryProcedure,
	createFactoryProcedure,
	inspectFactoryHealthProcedure,
} from "./project-factories";
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
import { getTodayProjectTotals } from "@tedix/db/queries/today-project";
import { assertSpecificationContributorGrant } from "./work-items/specification-policy";

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
		await assertSpecificationContributorGrant(
			context,
			orgId,
			undefined,
			input.metadata?.workSpecificationContributors,
		);

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
			metadata: projectMetadataForUpdate(
				null,
				input.metadata === undefined ? undefined : toJsonRecord(input.metadata),
			),
			createdAt: new Date().toISOString(),
		});
	});

const updateProcedure = authOs.update
	.use(AUTHZ.objectiveWrite)
	.handler(async ({ input, context }) => {
		const existing = await assertProjectAccess(context, input.id);
		await assertSpecificationContributorGrant(
			context,
			existing.orgId,
			existing.metadata?.workSpecificationContributors,
			input.metadata?.workSpecificationContributors,
		);
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
				metadata: projectMetadataForUpdate(
					existing.metadata,
					input.metadata === undefined
						? undefined
						: toJsonRecord(input.metadata),
				),
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
		const excludeProjectId = await excludedAgentReviewProjectId(context, orgId);
		const { data, total } = await listProjects(context.db, {
			orgId,
			...(excludeProjectId ? { excludeProjectId } : {}),
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
		const project = await assertProjectAccess(context, input.id);
		const objective = project.objectiveId
			? await getObjectiveById(context.db, project.objectiveId)
			: undefined;
		return {
			...project,
			objective:
				objective?.orgId === project.orgId
					? {
							id: objective.id,
							title: objective.title,
							priority: objective.priority,
						}
					: null,
		};
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

/**
 * A safety ceiling, not a page size: the Projects view promises every project.
 * At 100 it silently dropped every project past the hundredth key.
 */
export const PROJECT_PORTFOLIO_LIMIT = 1_000;

const getPortfolioProcedure = authOs.getPortfolio
	.use(AUTHZ.objectiveRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgIdOrInput(context, input?.organizationId);
		const excludeProjectId = await excludedAgentReviewProjectId(context, orgId);
		return listProjectPortfolio(context.db, {
			orgId,
			...(excludeProjectId ? { excludeProjectId } : {}),
			limit: PROJECT_PORTFOLIO_LIMIT,
		});
	});

const getFactoryScoreboardProcedure = authOs.getFactoryScoreboard
	.use(AUTHZ.objectiveRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgIdOrInput(context, input?.organizationId);
		const now = new Date();
		// Loops carry the inspect_factory_health verdict itself, computed over
		// the same run window, so the portfolio and the CLI cannot disagree.
		const [scoreboard, health] = await Promise.all([
			listFactoryScoreboard(context.db, { orgId, now }),
			listFactoryHealth(context.db, {
				orgId,
				now,
				runLimit: FACTORY_HEALTH_DEFAULT_RUNS,
			}),
		]);
		const verdicts = new Map(health.map((entry) => [entry.skillId, entry]));
		return {
			...scoreboard,
			data: scoreboard.data.map((entry) => {
				const loop =
					entry.kind === "skill_loop" ? verdicts.get(entry.id) : undefined;
				return {
					...entry,
					verdict: loop?.verdict ?? null,
					verdictReason: loop?.reason ?? null,
				};
			}),
		};
	});

/**
 * A judgment's target as an ISO datetime. It inherits the project's free-text
 * targetDate, so "2026-08-31" (stored for TEDIX-UNIFIED-OS) became a row the
 * output schema rejected: the write committed and the caller got a 500, and
 * every later list of that project failed too. A bare date means midnight UTC;
 * anything else unparseable has no target.
 */
export function judgmentTargetAt(
	value: string | null | undefined,
): string | null {
	if (!value) return null;
	if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00.000Z`;
	const time = Date.parse(value);
	return Number.isNaN(time) ? null : new Date(time).toISOString();
}

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
				targetAt: input.targetAt ?? judgmentTargetAt(project.targetDate),
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
			targetAt: judgmentTargetAt(row.targetAt),
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
				targetAt: judgmentTargetAt(row.targetAt),
			}),
		);
	});

const getContinuityProcedure = authOs.getContinuity
	.use(AUTHZ.objectiveRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgIdOrInput(context);
		const { readContinuity } = await import("../../lib/stall-attention");
		return readContinuity(
			context.db,
			orgId,
			new Date(),
			input.after,
			undefined,
			context.env.ENVIRONMENT,
		);
	});

const getTodayTotalsProcedure = authOs.getTodayTotals
	.use(AUTHZ.objectiveRead)
	.handler(async ({ input, context }) => {
		const project = await assertProjectAccess(context, input.id);
		if (
			Date.parse(input.until) <= Date.parse(input.since) ||
			Date.parse(input.until) - Date.parse(input.since) > 26 * 3600000
		)
			throw createError(ErrorCodes.BAD_REQUEST, "Choose one local day");
		let needsYou: number | null = null;
		if (input.includeDeckCount) {
			const person = await verifiedActiveWorkActor(context, project.orgId);
			if (person.type !== "user" || person.id !== input.personId)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Today attention totals require the signed-in person's own Decisions",
				);
			const { loadDeckProjection } =
				await import("../../services/attention-projection");
			const deck = await loadDeckProjection(context, {
				projectId: project.id,
				timeZone: input.timeZone,
				gadgetId: input.gadgetId,
				limit: 100,
			});
			if (!deck.complete)
				throw createError(
					ErrorCodes.SERVICE_UNAVAILABLE,
					"Decisions count is incomplete",
				);
			needsYou = deck.count;
		}
		const totals = await getTodayProjectTotals(context.db, {
			orgId: project.orgId,
			projectId: project.id,
			personId: input.personId,
			excludeOutputId: input.excludeOutputId,
			since: input.since,
			until: input.until,
		});
		const objective = project.objectiveId
			? await getObjectiveById(context.db, project.objectiveId)
			: null;
		const { receiptsJson, ...counts } = totals;
		return {
			...counts,
			needsYou,
			receipts: JSON.parse(receiptsJson),
			objective:
				objective?.orgId === project.orgId
					? (objective.description ?? objective.title)
					: null,
		};
	});

export const projectsContractRouter = projectsOs.router({
	getTodayTotals: getTodayTotalsProcedure,
	getContinuity: getContinuityProcedure,
	create: createProcedure,
	update: updateProcedure,
	archive: archiveProcedure,
	list: skipOutputValidation(listProcedure),
	get: getProcedure,
	getRollup: skipOutputValidation(getRollupProcedure),
	getPortfolio: skipOutputValidation(getPortfolioProcedure),
	getFactoryScoreboard: getFactoryScoreboardProcedure,
	createFactory: createFactoryProcedure,
	pauseFactory: pauseFactoryProcedure,
	resumeFactory: resumeFactoryProcedure,
	archiveFactory: archiveFactoryProcedure,
	inspectFactoryHealth: inspectFactoryHealthProcedure,
	recordHealthJudgment: recordHealthJudgmentProcedure,
	listHealthJudgments: listHealthJudgmentsProcedure,
});
