/**
 * Factory procedures of the projects router: `create_factory` and
 * `inspect_factory_health`. The build orchestration lives in
 * services/factory-builder.ts; this module binds it to D1 and to the existing
 * skill authoring path, so the lane skill passes the same validation and
 * lifecycle gate as `record_skills`.
 */

import { implement } from "@orpc/server";
import { projectsContract } from "@tedix/api-contract/contracts/projects";
import { getSkillEntry } from "@tedix/db/queries/cognitive/skill-crud";
import {
	listFactoryHealth,
	loadFactoryBuildState,
} from "@tedix/db/queries/factories";
import { getOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";
import {
	createProject,
	getProjectById,
	ProjectPurposeError,
	updateProject,
} from "@tedix/db/queries/projects";
import { getSkillSchedule } from "@tedix/db/queries/skill-schedules";
import { createObjective } from "@tedix/db/queries/tedi-objectives";
import {
	getTediByIdForOrganization,
	getTediBySlug,
	getTedisByOrganization,
} from "@tedix/db/queries/tedis";
import { createWorkItem } from "@tedix/db/queries/work-items/crud";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	buildFactory,
	FactoryBuildError,
	type FactoryStore,
} from "../../services/factory-builder";
import { requireOrgIdOrInput } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";
import { isLifecycleOverrideAuthority } from "./cognitive-shared";
import { updateSkillEntryGated } from "./cognitive-skill-governance";
import {
	createSkillFromInput,
	syncSkillScheduleProjection,
	validatedSkillSchedule,
} from "./cognitive-skill-shared";

const factoriesOs = implement(projectsContract)
	.$context<BaseContext>()
	.use(withAuth);

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function factoryStore(context: BaseContext, orgId: string): FactoryStore {
	const db = context.db;
	return {
		canActivate: isLifecycleOverrideAuthority(context),
		load: (params) => loadFactoryBuildState(db, { orgId, ...params }),
		async resolveOwner(ref) {
			const live = <T extends { retiredAt?: string | null }>(
				tedi: T | undefined,
			) => (tedi && !tedi.retiredAt ? tedi : undefined);
			const byId = UUID_RE.test(ref)
				? live(await getTediByIdForOrganization(db, ref, orgId))
				: undefined;
			const bySlug = byId ?? live(await getTediBySlug(db, orgId, ref));
			if (bySlug) {
				return { id: bySlug.id, name: bySlug.displayName || bySlug.name };
			}
			const wanted = ref.trim().toLowerCase();
			const matches = (await getTedisByOrganization(db, orgId)).filter(
				(tedi) =>
					tedi.name.toLowerCase() === wanted ||
					(tedi.displayName ?? "").toLowerCase() === wanted,
			);
			const [only] = matches;
			return matches.length === 1 && only
				? { id: only.id, name: only.displayName || only.name }
				: null;
		},
		async workspaceExists(workspaceId) {
			return Boolean(
				await getOsWorkspace(db, { organizationId: orgId, workspaceId }),
			);
		},
		async createObjective(params) {
			const objective = await createObjective(db, {
				id: crypto.randomUUID(),
				orgId,
				tediId: params.ownerTediId,
				title: params.title,
				description: params.goal,
				successCriteria:
					"Runs at least daily, and each run delivers new Work, comments or Output revisions toward the goal.",
				type: "standing",
				createdAt: new Date().toISOString(),
			});
			return objective.id;
		},
		async createProject(params) {
			const project = await createProject(db, {
				id: crypto.randomUUID(),
				orgId,
				key: params.key,
				name: params.name,
				description: params.goal,
				leadTediId: params.ownerTediId,
				objectiveId: params.objectiveId,
				metadata: params.metadata,
				createdAt: new Date().toISOString(),
			});
			return { id: project.id, key: project.key };
		},
		async bindProject(params) {
			const project = await getProjectById(db, params.projectId);
			if (!project || project.orgId !== orgId) {
				throw createError(ErrorCodes.NOT_FOUND, "Factory project not found");
			}
			const metadata: Record<string, JsonValue> = {
				...(project.metadata ?? {}),
				...params.metadata,
			};
			const updatedAt = new Date().toISOString();
			try {
				await updateProject(db, project.id, {
					metadata,
					updatedAt,
					...(params.objectiveId ? { objectiveId: params.objectiveId } : {}),
				});
			} catch (error) {
				// Work already links the project, so its objective is fixed; the
				// binding still records the factory's own objective.
				if (!(error instanceof ProjectPurposeError) || !params.objectiveId) {
					throw error;
				}
				await updateProject(db, project.id, { metadata, updatedAt });
			}
		},
		async createHealthItem(params) {
			const item = await createWorkItem(db, {
				id: crypto.randomUUID(),
				orgId,
				title: params.title,
				description: params.description,
				workKind: "operations",
				priority: "medium",
				accountableOwnerType: "tedi",
				accountableOwnerId: params.ownerTediId,
				objectiveId: params.objectiveId,
				projectId: params.projectId,
				sourceIntentId: params.sourceIntentId,
				metadata: { factory: params.slug, role: "health" },
				createdAt: new Date().toISOString(),
			});
			return item.id;
		},
		async createLaneSkill(params) {
			const { entry } = await createSkillFromInput(context, orgId, {
				title: params.title,
				slug: params.slug,
				description: params.description,
				summary: params.summary,
				content: params.content,
				files: params.files,
				tediId: params.ownerTediId,
				audience: ["tedi"],
				tags: ["factory"],
				validate: "error",
				// Every lane from one template looks alike; that is not a duplicate.
				force: true,
			});
			return { id: entry.id, lifecycleState: entry.lifecycleState };
		},
		async activateLaneSkill(skillId) {
			const existing = await getSkillEntry(db, skillId, orgId);
			if (!existing) {
				throw createError(ErrorCodes.NOT_FOUND, "Lane skill not found");
			}
			// canActivate proved a signed-in human or operator key, the same
			// authority improve_skills requires for a forced activation.
			await updateSkillEntryGated(
				context,
				skillId,
				{ lifecycleState: "active", revision: existing.revision + 1 },
				{ force: true, forceAuthority: { kind: "operator" } },
			);
			const updated = await getSkillEntry(db, skillId, orgId);
			if (!updated) {
				throw createError(ErrorCodes.NOT_FOUND, "Lane skill not found");
			}
			await syncSkillScheduleProjection(
				context,
				updated,
				validatedSkillSchedule(updated.content, updated.tediId),
			);
			const schedule = await getSkillSchedule(db, skillId);
			return {
				lifecycleState: updated.lifecycleState,
				nextFireAt: schedule?.nextFireAt ?? null,
			};
		},
	};
}

export const createFactoryProcedure = factoriesOs.createFactory
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgIdOrInput(context, input.organizationId);
		try {
			return await buildFactory(factoryStore(context, orgId), input);
		} catch (error) {
			if (error instanceof FactoryBuildError) {
				throw createError(
					error.code === "CONFLICT"
						? ErrorCodes.CONFLICT
						: ErrorCodes.BAD_REQUEST,
					error.message,
				);
			}
			if (error instanceof ProjectPurposeError) {
				throw createError(ErrorCodes.CONFLICT, error.message);
			}
			throw error;
		}
	});

export const inspectFactoryHealthProcedure = factoriesOs.inspectFactoryHealth
	.use(AUTHZ.objectiveRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgIdOrInput(context, input.organizationId);
		const now = new Date();
		const all = await listFactoryHealth(context.db, {
			orgId,
			now,
			runLimit: input.runs,
		});
		const wanted = input.factory?.trim();
		const data = wanted
			? all.filter((entry) => entry.slug === wanted || entry.skillId === wanted)
			: all;
		if (wanted && data.length === 0) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				`No factory "${wanted}": it is neither a factory slug nor a scheduled skill id.`,
			);
		}
		return { data, checkedAt: now.toISOString() };
	});
