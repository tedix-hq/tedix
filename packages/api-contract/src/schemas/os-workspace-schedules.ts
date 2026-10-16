import * as z from "zod";

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

/**
 * A scheduled skill that reads its owner's personal account: its manifest
 * declares a provider tool whose server-reviewed binding is a read of the
 * connected account (for example `google_gmail: [search_threads]`).
 */
export const OsWorkspaceSchedulePersonalReadSchema = z
	.object({
		providerId: z.string(),
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
				"The viewer's own active read-only grant for this skill and Workspace; null when there is none",
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
		cron: z.string().nullable().describe("The UTC cron the schedule fires on"),
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
	})
	.strict();
export type OsWorkspaceSchedule = z.infer<typeof OsWorkspaceScheduleSchema>;
