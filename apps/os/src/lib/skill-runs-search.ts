import type {
	SkillRunStatus,
	SkillRunSummary,
	SkillRunTrigger,
} from "@tedix/api-contract/schemas/cognitive";
import * as z from "zod";
import { plainRunError } from "@/lib/skill-draft-reason";
import { normalizeD1Timestamp } from "@/lib/time";

export const SKILL_RUN_RANGES = ["day", "week", "month"] as const;
export type SkillRunRange = (typeof SKILL_RUN_RANGES)[number];

export const skillRunsSearchSchema = z.object({
	status: z
		.enum(["queued", "running", "paused", "completed", "failed", "canceled"])
		.optional()
		.catch(undefined),
	trigger: z
		.enum(["scheduled", "manual", "agent", "test"])
		.optional()
		.catch(undefined),
	revision: z.coerce.number().int().positive().optional().catch(undefined),
	range: z.enum(SKILL_RUN_RANGES).optional().catch(undefined),
	page: z.coerce.number().int().min(2).optional().catch(undefined),
});

export type SkillRunsSearch = z.infer<typeof skillRunsSearchSchema>;

/** Runs shown on one page of the log. */
export const SKILL_RUN_PAGE_SIZE = 50;

const RANGE_HOURS: Record<SkillRunRange, number> = {
	day: 24,
	week: 24 * 7,
	month: 24 * 30,
};

/**
 * The earliest start time a range admits, cut to the minute so the route
 * loader and the page ask for the same list.
 */
export function skillRunRangeStart(
	range: SkillRunRange | undefined,
	now: Date = new Date(),
): string | undefined {
	if (!range) return undefined;
	const minute = Math.floor(now.getTime() / 60_000) * 60_000;
	return new Date(minute - RANGE_HOURS[range] * 3_600_000).toISOString();
}

export type SkillRunLogFilter = {
	status?: SkillRunStatus;
	trigger?: SkillRunTrigger;
	skillRevision?: number;
	startedAfter?: string;
	offset?: number;
};

/** The read behind one page of the log; an unfiltered first page adds nothing. */
export function skillRunLogFilter(
	search: SkillRunsSearch,
	now: Date = new Date(),
): SkillRunLogFilter {
	const startedAfter = skillRunRangeStart(search.range, now);
	return {
		...(search.status ? { status: search.status } : {}),
		...(search.trigger ? { trigger: search.trigger } : {}),
		...(search.revision ? { skillRevision: search.revision } : {}),
		...(startedAfter ? { startedAfter } : {}),
		...(search.page && search.page > 1
			? { offset: (search.page - 1) * SKILL_RUN_PAGE_SIZE }
			: {}),
	};
}

export function hasSkillRunFilter(search: SkillRunsSearch): boolean {
	return Boolean(
		search.status || search.trigger || search.revision || search.range,
	);
}

export function hasActiveSkillRun(
	runs: readonly { status: SkillRunStatus }[],
): boolean {
	return runs.some((run) =>
		["queued", "running", "paused"].includes(run.status),
	);
}

export const SKILL_RUN_TRIGGER_LABELS: Record<SkillRunTrigger, string> = {
	scheduled: "Scheduled",
	manual: "Manual",
	agent: "Agent or app",
	test: "Test",
};

/** A run still queued or running this long after it started is flagged. */
export const STUCK_AFTER_HOURS = 6;

/**
 * Queued or running long after it started. A paused run is waiting on a
 * person or an event, so it is never flagged.
 */
export function isStuckSkillRun(
	run: Pick<SkillRunSummary, "status" | "startedAt">,
	now: Date = new Date(),
): boolean {
	if (run.status !== "queued" && run.status !== "running") return false;
	if (!run.startedAt) return false;
	const started = Date.parse(normalizeD1Timestamp(run.startedAt));
	if (Number.isNaN(started)) return false;
	return now.getTime() - started >= STUCK_AFTER_HOURS * 3_600_000;
}

const OUTCOME_LABELS: Record<
	NonNullable<SkillRunSummary["outcome"]>,
	string
> = {
	delivered: "Delivered",
	progressed: "Made progress",
	blocked: "Blocked",
	no_action: "Nothing to do",
};

export type SkillRunResultLine = {
	text: string;
	tone: "default" | "error" | "warning" | "secondary";
};

type SkillRunResultInput = Pick<
	SkillRunSummary,
	| "status"
	| "startedAt"
	| "trigger"
	| "errorPreview"
	| "resultSummary"
	| "outcome"
>;

/**
 * The one line a row says about how a run went: the error for a failed run,
 * the result's own summary for a completed one, and whether a test passed.
 */
export function skillRunResultLine(
	run: SkillRunResultInput,
	now: Date = new Date(),
): SkillRunResultLine | null {
	const test = run.trigger === "test";
	if (run.status === "failed") {
		const reason =
			plainRunError(run.errorPreview) ?? "No error reason was recorded.";
		return {
			text: test ? `Test not passed: ${reason}` : reason,
			tone: "error",
		};
	}
	if (run.status === "completed") {
		const summary =
			run.resultSummary?.replace(/\s+/g, " ").trim() ||
			(run.outcome ? OUTCOME_LABELS[run.outcome] : "");
		if (test)
			return {
				text: summary ? `Test passed: ${summary}` : "Test passed",
				tone: "default",
			};
		return summary ? { text: summary, tone: "default" } : null;
	}
	if (run.status === "canceled")
		return test ? { text: "Test canceled", tone: "secondary" } : null;
	if (isStuckSkillRun(run, now))
		return {
			text: `Started more than ${STUCK_AFTER_HOURS} hours ago and has not finished.`,
			tone: "warning",
		};
	if (run.status === "paused")
		return { text: "Waiting for a person or an event.", tone: "secondary" };
	return test ? { text: "Test in progress", tone: "secondary" } : null;
}
