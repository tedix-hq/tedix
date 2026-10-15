/**
 * Factory build and health schemas (`create_factory`, `inspect_factory_health`).
 *
 * A factory is a Work project and objective, an owner tedi, a scheduled lane
 * skill rendered from a Tedix-owned template, a standing health Work Item and
 * an optional Workspace. The project's `metadata.factory` records the binding.
 */

import * as z from "zod";

export const FactorySlugSchema = z
	.string()
	.trim()
	.min(2)
	.max(36)
	.regex(
		/^[a-z0-9][a-z0-9-]*[a-z0-9]$/,
		"lowercase letters, digits and dashes",
	);

/** Factories run at least daily; weekly cadences hide breakage. */
export const FactoryCadenceSchema = z.enum(["daily", "twice_daily"]);
export type FactoryCadence = z.infer<typeof FactoryCadenceSchema>;

export const FactoryTemplateSchema = z.enum(["report"]);
export type FactoryTemplate = z.infer<typeof FactoryTemplateSchema>;

export const CreateFactoryInputSchema = z
	.object({
		organizationId: z.uuid().optional(),
		goal: z
			.string()
			.trim()
			.min(10)
			.max(2000)
			.describe(
				"What the factory delivers, in one or two sentences. Becomes the objective, the project brief and the owner tedi's standing prompt.",
			),
		name: z
			.string()
			.trim()
			.min(2)
			.max(60)
			.optional()
			.describe(
				"Display name, e.g. 'Docs accuracy'. Defaults to the first words of the goal.",
			),
		slug: FactorySlugSchema.optional().describe(
			"Stable identity; re-running with the same slug changes nothing. Defaults to the name in kebab case.",
		),
		ownerTedi: z
			.string()
			.trim()
			.min(1)
			.max(200)
			.optional()
			.describe(
				'Owner tedi id, slug or name; it runs the lane\'s one turn. Omit it (or pass "home" or "default") for the organization\'s default tedi; when a tedi calls, omitting it means that tedi.',
			),
		cadence: FactoryCadenceSchema.default("daily"),
		template: FactoryTemplateSchema.default("report").describe(
			"report: gather the project's open Work, run one owner tedi turn, propose up to maxProposals deduplicated Work Items, then post a scorecard comment on the health item.",
		),
		maxProposals: z.number().int().min(0).max(10).default(3),
		workspaceId: z
			.uuid()
			.optional()
			.describe(
				"Optional Workspace the factory works in; recorded in the binding.",
			),
		projectKey: z
			.string()
			.min(1)
			.max(40)
			.regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
			.optional()
			.describe(
				"Link an existing project instead of the default key (the slug in upper case).",
			),
		dryRun: z
			.boolean()
			.default(false)
			.describe("Report what exists and what would be created; write nothing."),
	})
	.strict();
export type CreateFactoryInput = z.infer<typeof CreateFactoryInputSchema>;

export const FactoryBuildStepSchema = z.object({
	resource: z.enum([
		"objective",
		"project",
		"health_work_item",
		"skill",
		"schedule",
	]),
	action: z.enum(["created", "reused", "linked", "activated", "would_create"]),
	id: z.string().nullable(),
	note: z.string().optional(),
});

export const CreateFactoryResultSchema = z.object({
	slug: z.string(),
	name: z.string(),
	dryRun: z.boolean(),
	/** created: something was written; unchanged: every part already existed. */
	status: z.enum(["created", "unchanged", "planned"]),
	ownerTediId: z.string(),
	projectId: z.string().nullable(),
	projectKey: z.string(),
	objectiveId: z.string().nullable(),
	healthWorkItemId: z.string().nullable(),
	skillId: z.string().nullable(),
	skillSlug: z.string(),
	skillLifecycleState: z.string().nullable(),
	workspaceId: z.string().nullable(),
	cron: z.string(),
	/** Null while the lane skill is a draft (no schedule yet). */
	nextFireAt: z.string().nullable(),
	steps: z.array(FactoryBuildStepSchema),
	nextActions: z.array(z.string()),
});
export type CreateFactoryResult = z.infer<typeof CreateFactoryResultSchema>;

export const FactoryVerdictSchema = z.enum([
	"healthy",
	"idle",
	"failing",
	"not_firing",
	"paused",
	"pending",
]);

export const FactoryHealthRunSchema = z.object({
	runId: z.string(),
	status: z.string(),
	trigger: z.enum(["schedule", "manual"]),
	firedAt: z.string().nullable(),
	finishedAt: z.string().nullable(),
	error: z.string().nullable(),
	outputs: z.object({
		workItemsCreated: z.number(),
		comments: z.number(),
		/** Scorecard comments on the health item; not counted as delivery. */
		scorecards: z.number(),
		outputRevisions: z.number(),
	}),
	delivered: z.number(),
});

export const FactoryHealthSchema = z.object({
	slug: z.string(),
	name: z.string(),
	skillId: z.string(),
	lifecycleState: z.string().nullable(),
	ownerTediId: z.string().nullable(),
	ownerTediName: z.string().nullable(),
	projectId: z.string().nullable(),
	projectKey: z.string().nullable(),
	objectiveId: z.string().nullable(),
	healthWorkItemId: z.string().nullable(),
	workspaceId: z.string().nullable(),
	cron: z.string().nullable(),
	scheduleEnabled: z.boolean(),
	nextFireAt: z.string().nullable(),
	lastFiredAt: z.string().nullable(),
	scheduleError: z.string().nullable(),
	ranToday: z.boolean(),
	lastProofRun: z
		.object({
			runId: z.string(),
			status: z.string(),
			firedAt: z.string().nullable(),
			finishedAt: z.string().nullable(),
		})
		.nullable(),
	runs: z.array(FactoryHealthRunSchema),
	verdict: FactoryVerdictSchema,
	reason: z.string(),
});
export type FactoryHealth = z.infer<typeof FactoryHealthSchema>;

/** Runs a health verdict looks back over; the scoreboard uses the same. */
export const FACTORY_HEALTH_DEFAULT_RUNS = 7;

export const InspectFactoryHealthInputSchema = z
	.object({
		organizationId: z.uuid().optional(),
		factory: z
			.string()
			.trim()
			.min(1)
			.max(200)
			.optional()
			.describe(
				"Factory slug or lane skill id. Omit to list every factory with its verdict.",
			),
		runs: z.number().int().min(1).max(30).default(FACTORY_HEALTH_DEFAULT_RUNS),
	})
	.strict();

export const InspectFactoryHealthResultSchema = z.object({
	data: z.array(FactoryHealthSchema),
	checkedAt: z.string(),
});
