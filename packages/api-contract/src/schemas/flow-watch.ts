import * as z from "zod";

/**
 * flow.watch: a durable, capped status watch that runs off the caller's
 * context. One platform-owned watch skill per organization performs the
 * checks; only the statuses listed in WATCH_CHECK_CALLABLES can be watched.
 */
export const FLOW_WATCH_LIMITS = {
	minEverySeconds: 15,
	maxChecks: 100,
	maxDeadlineSeconds: 24 * 60 * 60,
	maxOpenPerOrganization: 20,
	/** Consecutive failed checks before the watch ends with check_failed. */
	maxConsecutiveFailures: 3,
} as const;

/** The only checks a watch may run. Each maps to one server-owned read. */
export const WATCH_CHECK_CALLABLES = ["work.item_status"] as const;

export const WatchCheckCallableSchema = z.enum(WATCH_CHECK_CALLABLES);

const DURATION_UNITS: Record<string, number> = {
	s: 1,
	sec: 1,
	second: 1,
	seconds: 1,
	m: 60,
	min: 60,
	minute: 60,
	minutes: 60,
	h: 3600,
	hour: 3600,
	hours: 3600,
};

/** Seconds from `30`, `"30 s"`, `"5 minutes"` or `"2h"`; null when unreadable. */
export function parseWatchDurationSeconds(value: unknown): number | null {
	if (typeof value === "number")
		return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
	if (typeof value !== "string") return null;
	const match = value
		.trim()
		.toLowerCase()
		.match(/^(\d{1,6})\s*([a-z]+)?$/);
	if (!match) return null;
	const unit = DURATION_UNITS[match[2] ?? "s"];
	return unit ? Number(match[1]) * unit : null;
}

const WatchDurationSchema = z
	.union([z.number(), z.string().max(32)])
	.describe('Seconds as a number, or a string like "30 s", "5 minutes", "2h"');

const WatchScalarSchema = z.union([
	z.string().max(200),
	z.number(),
	z.boolean(),
]);

/**
 * A small JSON rule checked against each status result; no code runs on the
 * server. Exactly one of `in`, `eq` or `gte` is required.
 */
export const WatchUntilRuleSchema = z
	.object({
		path: z
			.string()
			.min(1)
			.max(64)
			.regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/)
			.describe('Dot path into the status result, e.g. "disposition"'),
		in: z.array(WatchScalarSchema).min(1).max(20).optional(),
		eq: WatchScalarSchema.optional(),
		gte: z.number().optional(),
	})
	.strict()
	.refine(
		(rule) =>
			[rule.in, rule.eq, rule.gte].filter((value) => value !== undefined)
				.length === 1,
		{ message: "until needs exactly one of in, eq or gte" },
	);

export type WatchUntilRule = z.infer<typeof WatchUntilRuleSchema>;

export const FlowWatchInputSchema = z
	.object({
		check: z
			.object({
				callable: WatchCheckCallableSchema,
				args: z.object({ workItemId: z.string().uuid() }).strict(),
			})
			.strict(),
		until: WatchUntilRuleSchema,
		every: WatchDurationSchema,
		maxChecks: z
			.number()
			.int()
			.min(1)
			.max(FLOW_WATCH_LIMITS.maxChecks)
			.optional(),
		deadline: WatchDurationSchema.optional(),
	})
	.strict();

export type FlowWatchInput = z.infer<typeof FlowWatchInputSchema>;

/** What the watch skill receives as params; the server derives every field. */
export const WorkItemWatchParamsSchema = z
	.object({
		workItemId: z.string().uuid(),
		until: WatchUntilRuleSchema,
		everySeconds: z
			.number()
			.int()
			.min(FLOW_WATCH_LIMITS.minEverySeconds)
			.max(FLOW_WATCH_LIMITS.maxDeadlineSeconds),
		maxChecks: z.number().int().min(1).max(FLOW_WATCH_LIMITS.maxChecks),
		deadlineAt: z.string().datetime(),
	})
	.strict();

export type WorkItemWatchParams = z.infer<typeof WorkItemWatchParamsSchema>;

/**
 * Normalize a flow.watch request into watch params. Throws a readable Error
 * when a cap or duration is out of range.
 */
export function normalizeFlowWatchInput(
	input: FlowWatchInput,
	now: Date,
): WorkItemWatchParams {
	const everySeconds = parseWatchDurationSeconds(input.every);
	if (everySeconds === null || everySeconds < FLOW_WATCH_LIMITS.minEverySeconds)
		throw new Error(
			`flow.watch every must be at least ${FLOW_WATCH_LIMITS.minEverySeconds} seconds`,
		);
	const maxChecks = input.maxChecks ?? FLOW_WATCH_LIMITS.maxChecks;
	const deadlineSeconds =
		input.deadline === undefined
			? Math.min(everySeconds * maxChecks, FLOW_WATCH_LIMITS.maxDeadlineSeconds)
			: parseWatchDurationSeconds(input.deadline);
	if (
		deadlineSeconds === null ||
		deadlineSeconds > FLOW_WATCH_LIMITS.maxDeadlineSeconds
	)
		throw new Error(
			"flow.watch deadline must be between 1 second and 24 hours",
		);
	if (everySeconds > deadlineSeconds)
		throw new Error("flow.watch every must not exceed the deadline");
	return {
		workItemId: input.check.args.workItemId,
		until: input.until,
		everySeconds,
		maxChecks,
		deadlineAt: new Date(now.getTime() + deadlineSeconds * 1000).toISOString(),
	};
}

export const StartWorkItemWatchInputSchema = z
	.object({
		tediId: z.string().optional(),
		watch: FlowWatchInputSchema,
		reason: z.string().max(500).optional(),
	})
	.strict();

export const WATCH_OUTCOMES = [
	"matched",
	"max_checks",
	"deadline",
	"check_failed",
] as const;

export const StartWorkItemWatchOutputSchema = z.object({
	runId: z.string(),
	status: z.string(),
	workItemId: z.string(),
	everySeconds: z.number(),
	maxChecks: z.number(),
	deadlineAt: z.string(),
});

export const CheckWorkItemWatchInputSchema = z
	.object({ tediId: z.string().optional() })
	.strict();

/** The only fields a Work Item check returns; they are what `until` reads. */
export const WorkItemWatchStatusSchema = z.object({
	workItemId: z.string(),
	disposition: z.string(),
	updatedAt: z.string().nullable(),
});

export type WorkItemWatchStatus = z.infer<typeof WorkItemWatchStatusSchema>;
