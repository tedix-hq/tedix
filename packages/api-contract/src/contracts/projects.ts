import "@orpc/openapi/extensions/route";
/**
 * Projects Contract (work hierarchy v1)
 *
 * A thin org-scoped container at the top of the work hierarchy
 * project → epic → feature → story → work_item → task. Projects group typed
 * `work_items` rows (`work_items.projectId`) and expose a rollup. Work Items
 * stay the canonical coordination object — this is NOT a second board.
 *
 * D1 tables: projects (packages/db/src/schema/projects.ts). Projected MCP tool
 * ids are verb-first snake_case (create_project, list_projects,
 * get_project_rollup, ...) via PROJECT_TOOL_ID_OVERRIDES in
 * apps/api/src/services/tool-schema-sync.ts.
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	JsonValueSchema,
	PaginationMetaSchema,
	PaginationSchema,
} from "../schemas/common";
import {
	WorkItemAggregateDispositionSchema,
	WorkItemDispositionSchema,
	WorkFactoryOwnerTypeSchema,
	CredentialWorkActorTypeSchema,
} from "../schemas/work-items";

// =============================================================================
// SCHEMAS
// =============================================================================

export const ProjectStatusSchema = z.enum([
	"active",
	"paused",
	"archived",
	"done",
]);
export type ProjectStatusInput = z.infer<typeof ProjectStatusSchema>;

export const ProjectSchema = z.object({
	id: z.string(),
	orgId: z.string(),
	key: z.string(),
	name: z.string(),
	description: z.string().nullable(),
	status: ProjectStatusSchema,
	leadTediId: z.string().nullable(),
	ownerUserId: z.string().nullable(),
	objectiveId: z.string().nullable(),
	targetDate: z.string().nullable(),
	metadata: z.record(z.string(), JsonValueSchema).nullable(),
	createdAt: z.string(),
	updatedAt: z.string().nullable(),
	archivedAt: z.string().nullable(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const ProjectMilestoneLifecycleSchema = z.enum([
	"proposed",
	"planned",
	"active",
	"done",
	"cancelled",
]);

export const ProjectHealthSchema = z.enum([
	"on_track",
	"at_risk",
	"off_track",
	"paused",
]);

export const ProjectSprintStatusSchema = z.enum([
	"planned",
	"active",
	"completed",
	"cancelled",
]);

export const ProjectSprintSchema = z
	.object({
		id: z.uuid(),
		orgId: z.uuid(),
		projectId: z.uuid(),
		name: z.string().trim().min(1).max(200),
		goal: z
			.string()
			.max(2_000)
			.nullable()
			.describe("Null when the sprint has no stated goal."),
		status: ProjectSprintStatusSchema,
		startAt: z.iso.datetime(),
		endAt: z.iso.datetime(),
		createdAt: z.iso.datetime(),
		updatedAt: z.iso
			.datetime()
			.nullable()
			.describe("Null until the sprint is changed after creation."),
		version: z.number().int().positive(),
	})
	.strict();

const MilestoneTitleSchema = z.string().trim().min(1).max(500);
const MilestoneDescriptionSchema = z.string().max(10_000);
const MilestoneOwnerIdSchema = z.string().trim().min(1).max(300);
const MilestoneTargetSchema = z.iso.datetime();
const MilestoneProofSchema = z.string().max(2_000);
const MilestoneSortSchema = z.number().int();

export const ProjectMilestoneSchema = z
	.object({
		id: z.uuid(),
		orgId: z.uuid(),
		projectId: z.uuid(),
		title: MilestoneTitleSchema,
		description: MilestoneDescriptionSchema.nullable().describe(
			"Nullable because a milestone may be tracked before its narrative is authored.",
		),
		lifecycle: ProjectMilestoneLifecycleSchema,
		accountableOwnerType: WorkFactoryOwnerTypeSchema,
		accountableOwnerId: MilestoneOwnerIdSchema,
		targetAt: MilestoneTargetSchema.nullable().describe(
			"Nullable when the milestone has no committed target date.",
		),
		proofRef: MilestoneProofSchema.nullable().describe(
			"Nullable until completion proof is attached.",
		),
		completedAt: z.iso
			.datetime()
			.nullable()
			.describe("Set only when the milestone reaches the done lifecycle."),
		cancelledAt: z.iso
			.datetime()
			.nullable()
			.describe("Set only when the milestone is cancelled."),
		sortOrder: MilestoneSortSchema,
		createdAt: z.iso.datetime(),
		updatedAt: z.iso
			.datetime()
			.nullable()
			.describe("Nullable until the milestone is changed after creation."),
		version: z.number().int().positive(),
	})
	.strict();

export const ProjectMilestoneDependencySchema = z
	.object({
		id: z.uuid(),
		orgId: z.uuid(),
		fromMilestoneId: z.uuid(),
		toMilestoneId: z.uuid(),
		createdAt: z.iso.datetime(),
	})
	.strict();

export const ProjectMilestoneViewSchema = z
	.object({
		milestone: ProjectMilestoneSchema,
		workItems: z.array(
			z
				.object({
					id: z.uuid(),
					title: z.string(),
					disposition: WorkItemDispositionSchema,
				})
				.strict(),
		),
		dependencies: z.array(ProjectMilestoneDependencySchema),
		workItemsTruncated: z.boolean(),
		dependenciesTruncated: z.boolean(),
	})
	.strict();

export const ProjectHealthJudgmentSchema = z
	.object({
		id: z.uuid(),
		orgId: z.uuid(),
		projectId: z.uuid(),
		health: ProjectHealthSchema,
		summary: z.string().min(1).max(10_000),
		judgedByType: CredentialWorkActorTypeSchema,
		judgedById: z.string().min(1).max(300),
		observedAt: z.iso.datetime(),
		targetAt: z.iso
			.datetime()
			.nullable()
			.describe(
				"Nullable when the health judgment is not tied to a target date.",
			),
	})
	.strict();

const ProjectRollupSchema = z.object({
	projectId: z.string(),
	total: z.number(),
	byDisposition: z.record(z.string(), z.number()),
	byWorkKind: z.record(z.string(), z.number()),
	percentDone: z.number(),
	aggregateDisposition: WorkItemAggregateDispositionSchema,
	distinctExecutors: z.array(
		z.object({ type: z.enum(["tedi", "external_agent"]), id: z.string() }),
	),
	topLevelItems: z.array(
		z.object({
			id: z.string(),
			title: z.string(),
			disposition: WorkItemDispositionSchema,
		}),
	),
	/** True when the item cap stopped the scan before every row was counted. */
	truncated: z.boolean(),
});

/**
 * Optional explicit org target. Ignored whenever the caller's auth context
 * already carries an organization scope (user JWT, API key, forwarded MCP
 * context) — only service-binding callers without org context need it.
 */
const OrganizationIdInputSchema = z.uuid().optional();

// =============================================================================
// CONTRACT
// =============================================================================

export const projectsContract = oc
	.route({ tags: ["projects"], prefix: "/projects" })
	.errors(baseErrors)
	.router({
		create: oc
			.route({
				method: "POST",
				path: "" as `/${string}`,
				summary: "Create project",
				successStatus: 201,
			})
			.input(
				z.object({
					organizationId: OrganizationIdInputSchema,
					key: z
						.string()
						.min(1)
						.max(40)
						.regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
					name: z.string().min(1).max(200),
					description: z.string().max(5000).optional(),
					status: ProjectStatusSchema.optional(),
					leadTediId: z.uuid().optional(),
					ownerUserId: z.string().max(200).optional(),
					objectiveId: z.uuid().optional(),
					targetDate: z.string().max(100).optional(),
					metadata: z.record(z.string(), z.unknown()).optional(),
				}),
			)
			.output(ProjectSchema),

		update: oc
			.route({
				method: "PATCH",
				path: "/{id}",
				summary: "Update project",
			})
			.input(
				z.object({
					id: z.uuid(),
					name: z.string().min(1).max(200).optional(),
					description: z.string().max(5000).nullable().optional(),
					status: ProjectStatusSchema.optional(),
					leadTediId: z.uuid().nullable().optional(),
					ownerUserId: z.string().max(200).nullable().optional(),
					objectiveId: z.uuid().nullable().optional(),
					targetDate: z.string().max(100).nullable().optional(),
					metadata: z.record(z.string(), z.unknown()).optional(),
				}),
			)
			.output(ProjectSchema),

		archive: oc
			.route({
				method: "POST",
				path: "/{id}/archive",
				summary: "Archive project",
			})
			.input(z.object({ id: z.uuid() }))
			.output(ProjectSchema),

		list: oc
			.route({
				method: "GET",
				path: "" as `/${string}`,
				summary: "List projects",
			})
			.input(
				z
					.object({
						organizationId: OrganizationIdInputSchema,
						status: ProjectStatusSchema.optional(),
						search: z.string().trim().max(200).optional(),
					})
					.extend(PaginationSchema.shape)
					.optional(),
			)
			.output(
				z.object({
					data: z.array(ProjectSchema),
					pagination: PaginationMetaSchema,
				}),
			),

		get: oc
			.route({
				method: "GET",
				path: "/{id}",
				summary: "Get project",
			})
			.input(z.object({ id: z.uuid() }))
			.output(ProjectSchema),

		getRollup: oc
			.route({
				method: "GET",
				path: "/{id}/rollup",
				summary: "Get project rollup",
			})
			.input(z.object({ id: z.uuid() }))
			.output(ProjectRollupSchema),

		createMilestone: oc
			.route({
				method: "POST",
				path: "/{id}/milestones",
				summary: "Create project milestone",
				successStatus: 201,
			})
			.input(
				z
					.object({
						id: z.uuid(),
						title: MilestoneTitleSchema,
						description: MilestoneDescriptionSchema.optional().describe(
							"Optional narrative; omission creates a title-only milestone.",
						),
						lifecycle: ProjectMilestoneLifecycleSchema.exclude([
							"done",
							"cancelled",
						])
							.optional()
							.describe("Omit to create the milestone in proposed lifecycle."),
						accountableOwnerType: WorkFactoryOwnerTypeSchema,
						accountableOwnerId: MilestoneOwnerIdSchema,
						targetAt: MilestoneTargetSchema.optional().describe(
							"Optional target date; omission leaves scheduling open.",
						),
						proofRef: MilestoneProofSchema.optional().describe(
							"Optional proof reference, normally supplied when marking done.",
						),
						sortOrder: MilestoneSortSchema.optional().describe(
							"Optional explicit timeline position; the server assigns one when omitted.",
						),
					})
					.strict(),
			)
			.output(ProjectMilestoneSchema),

		listMilestones: oc
			.route({
				method: "GET",
				path: "/{id}/milestones",
				summary: "List project milestones",
			})
			.input(
				z
					.object({
						id: z.uuid(),
						lifecycle: ProjectMilestoneLifecycleSchema.optional().describe(
							"Optional lifecycle filter; omission returns every lifecycle.",
						),
						cursor: z
							.uuid()
							.optional()
							.describe(
								"Opaque continuation cursor; omit to start at the first timeline page.",
							),
						limit: z.number().int().min(1).max(100).default(50),
					})
					.strict(),
			)
			.output(
				z
					.object({
						data: z.array(ProjectMilestoneViewSchema),
						nextCursor: z
							.uuid()
							.nullable()
							.describe(
								"Null when the bounded milestone timeline has no further page.",
							),
					})
					.strict(),
			),

		createSprint: oc
			.route({
				method: "POST",
				path: "/{id}/sprints",
				summary: "Create project sprint",
				successStatus: 201,
			})
			.input(
				z
					.object({
						id: z.uuid(),
						name: z.string().trim().min(1).max(200),
						goal: z
							.string()
							.max(2_000)
							.optional()
							.describe("Omit when the sprint has no stated goal."),
						status: ProjectSprintStatusSchema.exclude([
							"completed",
							"cancelled",
						])
							.optional()
							.describe("Omit to create a planned sprint."),
						startAt: z.iso.datetime(),
						endAt: z.iso.datetime(),
					})
					.strict(),
			)
			.output(ProjectSprintSchema),

		listSprints: oc
			.route({
				method: "GET",
				path: "/{id}/sprints",
				summary: "List project sprints",
			})
			.input(z.object({ id: z.uuid() }).strict())
			.output(
				z
					.object({
						data: z.array(
							z
								.object({
									sprint: ProjectSprintSchema,
									workItemIds: z.array(z.uuid()),
								})
								.strict(),
						),
					})
					.strict(),
			),

		assignSprintWorkItem: oc
			.route({
				method: "POST",
				path: "/{id}/sprints/{sprintId}/work-items",
				summary: "Assign Work Item to sprint",
				successStatus: 201,
			})
			.input(
				z
					.object({ id: z.uuid(), sprintId: z.uuid(), workItemId: z.uuid() })
					.strict(),
			)
			.output(z.object({ sprintId: z.uuid(), workItemId: z.uuid() }).strict()),

		updateMilestone: oc
			.route({
				method: "PATCH",
				path: "/{id}/milestones/{milestoneId}",
				summary: "Update project milestone",
			})
			.input(
				z
					.object({
						id: z.uuid(),
						milestoneId: z.uuid(),
						expectedVersion: z.number().int().positive(),
						title: MilestoneTitleSchema.optional().describe(
							"Omit to preserve the current milestone title.",
						),
						description: MilestoneDescriptionSchema.nullable()
							.optional()
							.describe("Omit to preserve the narrative; null clears it."),
						lifecycle: ProjectMilestoneLifecycleSchema.optional().describe(
							"Omit to preserve the current lifecycle.",
						),
						accountableOwnerType:
							WorkFactoryOwnerTypeSchema.optional().describe(
								"Omit to preserve the accountable owner type.",
							),
						accountableOwnerId: MilestoneOwnerIdSchema.optional().describe(
							"Omit to preserve the accountable owner identity.",
						),
						targetAt: MilestoneTargetSchema.nullable()
							.optional()
							.describe("Omit to preserve the target date; null removes it."),
						proofRef: MilestoneProofSchema.nullable()
							.optional()
							.describe("Omit to preserve completion proof; null removes it."),
						sortOrder: MilestoneSortSchema.optional().describe(
							"Omit to preserve the current timeline position.",
						),
					})
					.strict(),
			)
			.output(ProjectMilestoneSchema),

		attachMilestoneWorkItem: oc
			.route({
				method: "POST",
				path: "/{id}/milestones/{milestoneId}/work-items",
				summary: "Link Work Item to milestone",
				successStatus: 201,
			})
			.input(
				z
					.object({ id: z.uuid(), milestoneId: z.uuid(), workItemId: z.uuid() })
					.strict(),
			)
			.output(
				z.object({ milestoneId: z.uuid(), workItemId: z.uuid() }).strict(),
			),

		addMilestoneDependency: oc
			.route({
				method: "POST",
				path: "/{id}/milestone-dependencies",
				summary: "Add milestone dependency",
				successStatus: 201,
			})
			.input(
				z
					.object({
						id: z.uuid(),
						fromMilestoneId: z.uuid(),
						toMilestoneId: z.uuid(),
					})
					.strict(),
			)
			.output(ProjectMilestoneDependencySchema),

		recordHealthJudgment: oc
			.route({
				method: "POST",
				path: "/{id}/health-judgments",
				summary: "Record project health judgment",
				successStatus: 201,
			})
			.input(
				z
					.object({
						id: z.uuid(),
						health: ProjectHealthSchema,
						summary: z.string().trim().min(1).max(10_000),
						targetAt: z.iso
							.datetime()
							.optional()
							.describe(
								"Optional target date that contextualizes this health judgment.",
							),
					})
					.strict(),
			)
			.output(ProjectHealthJudgmentSchema),

		listHealthJudgments: oc
			.route({
				method: "GET",
				path: "/{id}/health-judgments",
				summary: "List project health judgments",
			})
			.input(
				z
					.object({
						id: z.uuid(),
						limit: z
							.number()
							.int()
							.min(1)
							.max(100)
							.optional()
							.describe(
								"Optional bounded result limit; the server default applies when omitted.",
							),
					})
					.strict(),
			)
			.output(z.array(ProjectHealthJudgmentSchema)),
	});

export type ProjectsContract = typeof projectsContract;
