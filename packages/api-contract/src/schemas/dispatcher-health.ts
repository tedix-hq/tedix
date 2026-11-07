import * as z from "zod";

const BoundedIdSchema = z.string().trim().min(1).max(128);

const SupervisorWorkSchema = z.object({
	id: z.uuid(),
	title: z.string().min(1).max(200).optional(),
});

export const NativeProviderActivitySchema = z.object({
	state: z.enum([
		"provider_progress",
		"provider_waiting",
		"tool_pending",
		"tool_running",
		"approval_wait",
		"provider_stalled",
	]),
	observedAt: z.iso.datetime(),
	tool: z.string().trim().min(1).max(100).optional(),
});
export type NativeProviderActivity = z.infer<
	typeof NativeProviderActivitySchema
>;

export const SupervisorActivitySchema = z.object({
	current: z
		.array(
			SupervisorWorkSchema.extend({
				phase: z.enum(["starting", "working", "finishing"]),
				nativeActivity: NativeProviderActivitySchema.optional(),
			}),
		)
		.max(3),
	currentCount: z.number().int().min(0).max(10_000),
	waiting: z
		.array(
			SupervisorWorkSchema.extend({
				reason: z.enum([
					"retry",
					"confirmation",
					"reply",
					"completion",
					"held",
				]),
				retryAt: z.iso.datetime().nullable(),
			}),
		)
		.max(3),
	nextCheckAt: z.iso.datetime().nullable(),
	lastCompleted: SupervisorWorkSchema.extend({
		completedAt: z.iso.datetime(),
	}).nullable(),
});
export type SupervisorActivity = z.infer<typeof SupervisorActivitySchema>;

export const DispatcherReliabilitySchema = z
	.object({
		coverageStartedAt: z.iso.datetime(),
		windowStartedAt: z.iso.datetime(),
		observedAt: z.iso.datetime(),
		runners: z
			.array(
				z.object({
					runner: z.string().trim().min(1).max(64),
					held: z.number().int().min(0).max(10_000),
					supervisorKills: z.number().int().min(0).max(10_000),
				}),
			)
			.max(100),
	})
	.refine(
		(value) =>
			Date.parse(value.observedAt) - Date.parse(value.windowStartedAt) ===
				86_400_000 &&
			Date.parse(value.coverageStartedAt) <= Date.parse(value.observedAt),
		{
			message:
				"Reliability observations must describe a 24-hour window with valid coverage",
		},
	);
export type DispatcherReliability = z.infer<typeof DispatcherReliabilitySchema>;

export const DispatcherIdleSchema = z.object({
	observedAt: z.iso.datetime(),
	held: z.number().int().min(0).max(10000),
	waitingOnPerson: z.number().int().min(0).max(10000),
	noCoordinator: z.number().int().min(0).max(10000),
	other: z.number().int().min(0).max(10000),
	complete: z.boolean(),
});
export type DispatcherIdle = z.infer<typeof DispatcherIdleSchema>;

export const SupervisorDutyHealthSchema = z.object({
	id: z.string().trim().min(1).max(256),
	kind: z.enum(["service", "task"]),
	state: z.enum(["running", "waiting", "stopped", "failed", "unknown"]),
	observedAt: z.iso.datetime(),
	lastRunAt: z.iso.datetime().nullable(),
	lastExitAt: z.iso.datetime().nullable(),
	lastExitCode: z.number().int().nullable(),
	lastExecutor: z.string().min(1).max(64).nullable(),
	restartsLastHour: z.number().int().min(0).max(1000),
	retryAt: z.iso.datetime().nullable(),
	lastProblem: z.string().min(1).max(500).nullable(),
	problemSince: z.iso.datetime().nullable().optional(),
	activity: SupervisorActivitySchema.optional(),
	reliability: DispatcherReliabilitySchema.optional(),
	idle: DispatcherIdleSchema.optional(),
});
export type SupervisorDutyHealth = z.infer<typeof SupervisorDutyHealthSchema>;

export const DispatcherHealthTopReasonSchema = z.object({
	reason: z.string().trim().min(1).max(500),
	count: z.number().int().min(1).max(1_000_000),
});

export const ReportDispatcherHealthInputSchema = z
	.object({
		reporterId: BoundedIdSchema,
		executor: z.string().trim().min(1).max(64),
		lane: BoundedIdSchema,
		running: z.boolean(),
		observedAt: z.iso.datetime(),
		lastAdmissionAt: z.iso.datetime().nullable(),
		slotsInUse: z.number().int().min(0).max(10_000),
		slotsTotal: z.number().int().min(0).max(10_000),
		topReason: DispatcherHealthTopReasonSchema.nullable(),
		duty: SupervisorDutyHealthSchema.nullable().optional(),
	})
	.refine((value) => value.slotsInUse <= value.slotsTotal, {
		message: "slotsInUse must not exceed slotsTotal",
		path: ["slotsInUse"],
	});

export const DispatcherHealthReportSchema = z.object({
	reporterId: BoundedIdSchema,
	executor: z.string().trim().min(1).max(64),
	lane: BoundedIdSchema,
	running: z.boolean(),
	observedAt: z.iso.datetime(),
	reportedAt: z.iso.datetime(),
	lastAdmissionAt: z.iso.datetime().nullable(),
	slotsInUse: z.number().int().min(0).max(10_000),
	slotsTotal: z.number().int().min(0).max(10_000),
	topReason: DispatcherHealthTopReasonSchema.nullable(),
	duty: SupervisorDutyHealthSchema.nullable().optional(),
	ageSeconds: z.number().int().nonnegative(),
	staleAfterSeconds: z.number().int().positive(),
	stale: z.boolean(),
});

export const ListDispatcherHealthResultSchema = z.object({
	reportedAt: z.iso.datetime(),
	data: z.array(DispatcherHealthReportSchema),
});

export type ReportDispatcherHealthInput = z.infer<
	typeof ReportDispatcherHealthInputSchema
>;
export type DispatcherHealthReport = z.infer<
	typeof DispatcherHealthReportSchema
>;
