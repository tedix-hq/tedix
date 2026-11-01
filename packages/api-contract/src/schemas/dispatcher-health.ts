import * as z from "zod";

const BoundedIdSchema = z.string().trim().min(1).max(128);

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
