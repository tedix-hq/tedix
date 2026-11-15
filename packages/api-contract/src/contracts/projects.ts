import "@orpc/openapi/extensions/route";
/**
 * Projects Contract
 *
 * A project groups an area or engagement. Epics group related Work Items, goals
 * state purpose, Attempts track execution, and requests carry questions or
 * decisions for people. Work Items remain the canonical coordination object;
 * projects group them through `work_items.projectId` and expose a rollup.
 *
 * D1 tables: projects (packages/db/src/schema/projects.ts). Projected MCP tool
 * ids are verb-first snake_case (create_project, list_projects,
 * get_project_rollup, ...) via WORK_HIERARCHY_TOOL_ID_OVERRIDES in
 * apps/api/src/services/tool-schema-overrides.ts.
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	ContinuityPageSchema,
	ProjectMetadataSchema,
} from "../schemas/work-attention";
import {
	JsonValueSchema,
	PaginationMetaSchema,
	PaginationSchema,
} from "../schemas/common";
import {
	WorkItemAggregateDispositionSchema,
	WorkItemDispositionSchema,
	WorkItemKindSchema,
	CredentialWorkActorTypeSchema,
} from "../schemas/work-items";
import {
	FactoryControlInputSchema,
	FactoryControlResultSchema,
	CreateFactoryInputSchema,
	CreateFactoryResultSchema,
	FactoryVerdictSchema,
	InspectFactoryHealthInputSchema,
	InspectFactoryHealthResultSchema,
} from "../schemas/factories";

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

export const ProjectHealthSchema = z.enum([
	"on_track",
	"at_risk",
	"off_track",
	"paused",
]);

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

export const ProjectPortfolioEntrySchema = z.object({
	project: ProjectSchema,
	leadTediName: z.string().nullable(),
	total: z.number(),
	byDisposition: z.record(z.string(), z.number()),
	/** Oldest accepted top-level item, else the oldest proposed one. */
	next: z.object({ id: z.string(), title: z.string() }).nullable(),
	health: ProjectHealthSchema.nullable(),
	/** Newest attempt heartbeat or agent-session report on the project. */
	lastActivityAt: z.string().nullable(),
});
export type ProjectPortfolioEntry = z.infer<typeof ProjectPortfolioEntrySchema>;

const ProjectPortfolioSchema = z.object({
	data: z.array(ProjectPortfolioEntrySchema),
});

export const FactoryScoreboardEntrySchema = z.object({
	kind: z.enum(["skill_loop", "blueprint"]),
	/** Skill id for a loop, Blueprint id for a Blueprint. */
	id: z.string(),
	name: z.string(),
	tediId: z.string().nullable(),
	tediName: z.string().nullable(),
	cron: z.string().nullable(),
	runs: z.number(),
	succeeded: z.number(),
	lastRunAt: z.string().nullable(),
	/** Outputs created or revised by this factory's runs. */
	outputs: z.number(),
	workClosed: z.number(),
	lastResult: z
		.object({
			kind: z.enum(["output", "work_item"]),
			id: z.string(),
			title: z.string(),
			at: z.string(),
		})
		.nullable(),
	/** The loop's schedule is turned off; always false for a Blueprint. */
	paused: z.boolean(),
	/** Successful runs but no Output or closed Work in the window; never paused. */
	idle: z.boolean(),
	/**
	 * A loop's inspect_factory_health verdict and its reason, so the portfolio
	 * and the CLI never disagree; null for a Blueprint.
	 */
	verdict: FactoryVerdictSchema.nullable(),
	verdictReason: z.string().nullable(),
});
export type FactoryScoreboardEntry = z.infer<
	typeof FactoryScoreboardEntrySchema
>;

const FactoryScoreboardSchema = z.object({
	data: z.array(FactoryScoreboardEntrySchema),
	/** Start of the 7-day window the counts cover. */
	since: z.string(),
});

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
			workKind: WorkItemKindSchema,
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
		getContinuity: oc
			.route({
				method: "GET",
				path: "/continuity",
				summary:
					"Read stalled recovery and cadence promises for the coordinator morning brief",
			})
			.input(z.object({ after: z.string().default("") }))
			.output(ContinuityPageSchema),
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
					metadata: ProjectMetadataSchema.optional(),
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
					metadata: ProjectMetadataSchema.optional(),
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
					.strict()
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
			.output(
				ProjectSchema.extend({
					objective: z
						.object({
							id: z.string(),
							title: z.string(),
							priority: z.number().int(),
						})
						.nullable(),
				}),
			),

		getRollup: oc
			.route({
				method: "GET",
				path: "/{id}/rollup",
				summary: "Get project rollup",
			})
			.input(z.object({ id: z.uuid() }))
			.output(ProjectRollupSchema),

		getPortfolio: oc
			.route({
				method: "GET",
				path: "/portfolio",
				summary: "Get project portfolio",
				description:
					"Every project with its Work counts, next item, latest health judgment and last activity, in one read.",
			})
			.input(
				z
					.object({
						organizationId: z.string().optional(),
					})
					.strict()
					.optional(),
			)
			.output(ProjectPortfolioSchema),

		getFactoryScoreboard: oc
			.route({
				method: "GET",
				path: "/factory-scoreboard",
				summary: "Get factory scoreboard",
				description:
					"Each scheduled skill loop and published Blueprint with its last 7 days of runs, Outputs and closed Work, its last real result, and for each loop the same verdict inspect_factory_health gives (healthy, idle, failing, not_firing, paused, pending).",
			})
			.input(
				z
					.object({
						organizationId: z.string().optional(),
					})
					.strict()
					.optional(),
			)
			.output(FactoryScoreboardSchema),

		createFactory: oc
			.route({
				method: "POST",
				path: "/factories",
				summary: "Create factory",
				description:
					"Create recurring work from chat (every morning, daily, inbox summaries). Call with dryRun true first, review owner/cadence/output/warnings, then propose the same arguments with dryRun false for approval. Build a factory from a goal in one call: the Work project and objective, a scheduled lane skill from a template (daily by default, or twice_daily or hourly with everyHours; off :00/:30), and a standing health Work Item. With output, each run also appends its summary to a Tedix document (a dated section) or sheet (a row). Idempotent by slug: re-running reuses what exists. A signed-in human or operator key activates the lane; an agent gets a draft plus the proof-run step.",
			})
			.input(CreateFactoryInputSchema)
			.output(CreateFactoryResultSchema),

		pauseFactory: oc
			.route({
				method: "POST",
				path: "/factories/pause",
				summary: "Pause factory",
				description:
					"Pause a recurring factory by slug. Turns off future scheduled runs through improve_skills, preserving its lane, cadence and Outputs. Use for 'pause that factory'. Does not cancel an in-flight run.",
			})
			.input(FactoryControlInputSchema)
			.output(FactoryControlResultSchema),
		resumeFactory: oc
			.route({
				method: "POST",
				path: "/factories/resume",
				summary: "Resume factory",
				description:
					"Resume a paused factory by slug through improve_skills. Restores its existing cadence; does not run it immediately. Archived lanes stay retired.",
			})
			.input(FactoryControlInputSchema)
			.output(FactoryControlResultSchema),
		archiveFactory: oc
			.route({
				method: "POST",
				path: "/factories/archive",
				summary: "Archive factory",
				description:
					"Retire a factory by slug through improve_skills and remove its schedule. Preserves Work, project, objective and Outputs for separate cleanup. Use for 'archive that factory'.",
			})
			.input(FactoryControlInputSchema)
			.output(FactoryControlResultSchema),

		inspectFactoryHealth: oc
			.route({
				method: "GET",
				path: "/factory-health",
				summary: "Inspect factory health",
				description:
					"Answer how is my factory doing, check inbox factory health or find a factory by slug. Returns a one-line reason and run ids for skill status. One verdict per factory (healthy, idle, failing, not_firing, paused, pending) with its last scheduled runs, what each delivered (Work created, comments, Output revisions), whether it ran today, its next fire time and its last proof run. Give a slug or skill id, or omit it to list every factory.",
			})
			.input(InspectFactoryHealthInputSchema)
			.output(InspectFactoryHealthResultSchema),

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

		getTodayTotals: oc
			.route({
				method: "GET",
				path: "/{id}/today-totals",
				summary: "Read project totals for the saved Today post",
				description:
					"Project receipts without private request text, optionally with the signed-in person's own complete Decisions count. Scheduled machine callers set includeDeckCount=false: needsYou is null and no person's Decisions are read.",
			})
			.input(
				z.strictObject({
					id: z.uuid(),
					personId: z.string().min(1).max(300),
					excludeOutputId: z.uuid(),
					timeZone: z.string().min(1).max(100).default("UTC"),
					gadgetId: z.uuid().optional(),
					includeDeckCount: z.boolean().default(true),
					since: z.iso.datetime(),
					until: z.iso.datetime(),
				}),
			)
			.output(
				z.object({
					needsYou: z.number().int().nonnegative().nullable(),
					decisions: z.number().int().nonnegative(),
					documents: z.number().int().nonnegative(),
					lastTouched: z.string().nullable(),
					receipts: z
						.array(
							z.object({
								id: z.string(),
								title: z.string(),
								at: z.string(),
								source: z.string(),
							}),
						)
						.max(1000),
					objective: z.string().nullable(),
				}),
			),

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
