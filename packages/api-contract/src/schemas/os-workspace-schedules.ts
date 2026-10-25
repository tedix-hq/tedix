import * as z from "zod";
import { JsonValueSchema } from "./common";

/**
 * A Workspace resource with this provider and type says "this skill runs for
 * this Workspace": `providerResourceId` is the skill id and `name` is the name
 * people see. It is a link, never a credential, so it has no connection to
 * check and is not a connected source.
 */
export const WORKSPACE_SKILL_RESOURCE = {
	providerId: "tedix",
	resourceType: "skill",
} as const;

export function isWorkspaceSkillResource(resource: {
	providerId: string;
	resourceType: string;
}): boolean {
	return (
		resource.providerId === WORKSPACE_SKILL_RESOURCE.providerId &&
		resource.resourceType === WORKSPACE_SKILL_RESOURCE.resourceType
	);
}

/**
 * A Workspace resource saying "this tedi works for this Workspace":
 * `providerResourceId` is the tedi id. Linked with the skills it runs.
 */
export const WORKSPACE_TEDI_RESOURCE = {
	providerId: "tedix",
	resourceType: "tedi",
} as const;

/**
 * A Workspace resource saying "this Workspace's skills use this connection":
 * `providerResourceId` is the app slug whose tools a linked skill declares.
 * It is a reference, never a credential; the connection stays canonical.
 */
export const WORKSPACE_CONNECTION_RESOURCE = {
	providerId: "tedix",
	resourceType: "connection",
} as const;

/**
 * A tedix link row (skill, tedi or connection): a reference with no provider
 * object behind it, so it is never a connected source and needs no check.
 */
export function isWorkspaceLinkResource(resource: {
	providerId: string;
	resourceType: string;
}): boolean {
	return (
		resource.providerId === "tedix" &&
		(resource.resourceType === WORKSPACE_SKILL_RESOURCE.resourceType ||
			resource.resourceType === WORKSPACE_TEDI_RESOURCE.resourceType ||
			resource.resourceType === WORKSPACE_CONNECTION_RESOURCE.resourceType)
	);
}

/**
 * Optional `runsAt` metadata on a skill resource: the local times the skill's
 * workflow keeps. A UTC cron that must follow daylight saving fires at both
 * the summer and the winter hour, and the workflow skips the fire whose local
 * time is not one of these.
 */
export const WorkspaceSkillRunsAtSchema = z
	.object({
		timeZone: z.string().trim().min(1).max(64),
		times: z
			.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM"))
			.min(1)
			.max(24),
	})
	.strict();
export type WorkspaceSkillRunsAt = z.infer<typeof WorkspaceSkillRunsAtSchema>;

export const OsWorkspaceScheduleLastRunSchema = z
	.object({
		runId: z.string(),
		status: z.enum(["completed", "failed"]),
		startedAt: z.string().nullable(),
		completedAt: z.string().nullable(),
		cards: z
			.number()
			.int()
			.nonnegative()
			.nullable()
			.describe("The run result's `cards` count, when it reports one"),
		summary: z
			.string()
			.max(300)
			.nullable()
			.describe("The run result's one-line `summary`, when it has one"),
		error: z
			.string()
			.max(300)
			.nullable()
			.describe("First line of the failure, for a failed run"),
	})
	.strict();

export const PersonalAccessLevelSchema = z
	.enum(["none", "read", "organise"])
	.describe(
		"Access to a personal account: none; read; or organise, which adds labelling, archiving, marking read and drafting replies. No level sends, trashes or deletes",
	);
export type PersonalAccessLevelValue = z.infer<
	typeof PersonalAccessLevelSchema
>;

/**
 * A scheduled skill that reads its owner's personal account: its manifest
 * declares a provider tool whose server-reviewed binding is a read of the
 * connected account (for example `google_gmail: [search_threads]`).
 */
export const OsWorkspaceSchedulePersonalReadSchema = z
	.object({
		providerId: z.string(),
		workerName: z.string().optional(),
		providerName: z
			.string()
			.describe("The account's name people know, such as Gmail"),
		toolIds: z
			.array(z.string())
			.describe("The read-only tools the skill declares for this account"),
		grantId: z
			.string()
			.uuid()
			.nullable()
			.describe(
				"The viewer's own active grant for this skill and Workspace; null when there is none",
			),
		level: PersonalAccessLevelSchema.describe(
			"What that grant lets the skill do: none, read, or organise (read plus label, archive, mark read and draft; never send or delete)",
		),
		canAllow: z
			.boolean()
			.describe(
				"True for the Workspace's owner, the only person who can allow or stop the read",
			),
	})
	.strict();
export type OsWorkspaceSchedulePersonalRead = z.infer<
	typeof OsWorkspaceSchedulePersonalReadSchema
>;

export const AllowWorkspaceSchedulePersonalReadResultSchema = z
	.discriminatedUnion("status", [
		z.object({ status: z.literal("allowed"), grantId: z.string().uuid() }),
		z.object({
			status: z.literal("not_connected"),
			providerId: z.string(),
		}),
	])
	.describe(
		"allowed: the read-only grant now exists. not_connected: connect the account in Settings → Connections first",
	);

export const OsWorkspaceScheduleSchema = z
	.object({
		resourceId: z.string().uuid(),
		skillId: z.string(),
		name: z.string(),
		purpose: z.string().nullable(),
		enabled: z
			.boolean()
			.describe("False when the skill has no schedule or it is paused"),
		cron: z
			.string()
			.nullable()
			.describe(
				"The UTC cron the schedule fires on, also while paused; null when the skill has no schedule and runs only when asked",
			),
		dailyTimes: z
			.array(z.string())
			.describe(
				"For a daily schedule, the next instant of each daily run time, in order; empty otherwise",
			),
		nextRunAt: z
			.string()
			.nullable()
			.describe("Next run that does work; null when none is coming up"),
		lastRun: OsWorkspaceScheduleLastRunSchema.nullable().describe(
			"Latest finished run that did work; runs the workflow skipped because it was not one of its local times are left out",
		),
		personalRead: OsWorkspaceSchedulePersonalReadSchema.nullable().describe(
			"Set when the skill reads its owner's personal account; null otherwise",
		),
		tediName: z
			.string()
			.nullable()
			.describe("The tedi that runs the skill; null when it has no owner"),
		hasWorkflow: z
			.boolean()
			.describe(
				"True when the skill runs a workflow (scripts/workflow.ts); false when a tedi follows its instructions",
			),
	})
	.strict();
export type OsWorkspaceSchedule = z.infer<typeof OsWorkspaceScheduleSchema>;

export const LinkWorkspaceSkillInputSchema = z
	.object({
		workspaceId: z.string().uuid(),
		skillId: z
			.string()
			.min(1)
			.max(200)
			.describe("A skill in this organization"),
	})
	.strict();

export const LinkWorkspaceSkillResultSchema = z
	.object({
		resourceId: z.string().uuid(),
		created: z
			.boolean()
			.describe("False when the skill was already linked to the Workspace"),
	})
	.strict();

export const UnlinkWorkspaceSkillResultSchema = z
	.object({
		removed: z
			.boolean()
			.describe(
				"False when the skill was not linked; the skill and its schedule are unchanged either way",
			),
	})
	.strict();

export const WorkspaceSkillLinkReasonSchema = z
	.enum(["factory_project", "wrote_outputs"])
	.describe(
		"factory_project: the lane skill of a factory project bound or linked to the Workspace. wrote_outputs: its runs wrote the Workspace's Outputs",
	);

export const LinkWorkspaceFactorySkillsInputSchema = z
	.object({
		workspaceId: z.string().uuid(),
		dryRun: z
			.boolean()
			.default(true)
			.describe("True (the default) only reports what would be linked"),
	})
	.strict();

export const LinkWorkspaceFactorySkillsResultSchema = z
	.object({
		dryRun: z.boolean(),
		linkedTedis: z
			.number()
			.int()
			.nonnegative()
			.describe(
				"Tedis this call newly linked because a linked skill runs on them; 0 in a dry run",
			),
		linkedConnections: z
			.number()
			.int()
			.nonnegative()
			.describe(
				"Connections (apps) this call newly linked because a linked skill declares their tools; 0 in a dry run",
			),
		items: z.array(
			z
				.object({
					skillId: z.string(),
					name: z.string(),
					reason: WorkspaceSkillLinkReasonSchema,
					status: z
						.enum(["linked", "already_linked", "would_link"])
						.describe(
							"linked: this call linked it. already_linked: an active link existed. would_link: a dry run found it unlinked",
						),
				})
				.strict(),
		),
	})
	.strict();
export type LinkWorkspaceFactorySkillsResult = z.infer<
	typeof LinkWorkspaceFactorySkillsResultSchema
>;

export const SetWorkspacePersonalAccessResultSchema = z
	.object({
		level: PersonalAccessLevelSchema,
		skills: z
			.array(
				z
					.object({
						skillId: z.string(),
						grantId: z.string().uuid().nullable(),
						toolIds: z.array(z.string()),
					})
					.strict(),
			)
			.describe(
				"Each skill linked to the Workspace that uses this account, with its grant now (null: none) and the tools the grant covers",
			),
	})
	.strict();

const RUN_PARAMS_MAX_BYTES = 8_000;

export const RunWorkspaceSkillNowInputSchema = z
	.object({
		workspaceId: z.string().uuid(),
		skillId: z
			.string()
			.min(1)
			.max(200)
			.describe("A skill this Workspace links under Skills and schedules"),
		params: z
			.record(z.string(), JsonValueSchema)
			.refine(
				(value) => JSON.stringify(value).length <= RUN_PARAMS_MAX_BYTES,
				`Params must stay under ${RUN_PARAMS_MAX_BYTES} bytes`,
			)
			.describe("The run's params, as the skill's workflow reads them"),
		needs: PersonalAccessLevelSchema.exclude(["none"])
			.optional()
			.describe(
				"The access to the caller's personal account this run needs; without it the run does not start and the result is needs_access",
			),
		idempotencyKey: z
			.string()
			.uuid()
			.describe("One key per press; a repeat returns the same run"),
	})
	.strict();

export const RunWorkspaceSkillNowResultSchema = z.discriminatedUnion("status", [
	z.object({ status: z.literal("started"), runId: z.string() }).strict(),
	z
		.object({
			status: z.literal("needs_access"),
			level: PersonalAccessLevelSchema,
			providerName: z.string().nullable(),
			resourceId: z
				.string()
				.uuid()
				.nullable()
				.describe(
					"The caller's attached account to pass to setPersonalAccess; null when it is not attached to the Workspace yet",
				),
		})
		.strict()
		.describe(
			"The owner has not given this skill that access yet; they choose it on their account's row in the Workspace's Attached resources",
		),
]);
