import type {
	SkillEntry,
	SkillRunSummary,
	SkillSchedule,
} from "@tedix/api-contract/schemas/cognitive";
import { WORKFLOW_SOURCE_PATH } from "@/lib/skill-anatomy";
import { normalizeD1Timestamp, shortDeadline } from "@/lib/time";

/*
 * Why a skill is a draft, read from what the skill page already loads: the
 * skill itself, its newest runs and its schedule. Nothing records "who turned
 * this off", so each reason states only what those records show. A failure
 * streak is the one automatic cause: a skill that is on is turned off after
 * this many failed runs in a row (SKILL_DEMOTION_CONSECUTIVE_FAILURES in
 * @tedix/db/queries/skill-lifecycle).
 */
export const FAILED_RUNS_BEFORE_TURN_OFF = 3;

/** Improvement proposals are working copies of another skill. */
const PROPOSAL_TAG = "workflow-improvement";

export type SkillDraftReasonKind =
	/** A proposed change to another skill. */
	| "proposal"
	/** The newest runs failed in a row, enough to turn a skill off. */
	| "failed_runs"
	/** It has never run. */
	| "never_run"
	/** This revision was saved after the latest run. */
	| "changed"
	/** This revision has run, without a failure streak, and is not on. */
	| "not_turned_on"
	/** The runs are not loaded, so no cause is claimed. */
	| "unknown";

export type SkillDraftRun = Pick<
	SkillRunSummary,
	"id" | "status" | "skillRevision" | "startedAt" | "completedAt"
>;

export type SkillDraftReason = {
	kind: SkillDraftReasonKind;
	title: string;
	/** What the records show, one plain sentence each. */
	why: string[];
	/** The newest failed run, when the newest finished run failed. */
	lastFailedRunId: string | null;
	/** Failed runs in a row at the top of the run history. */
	failedInARow: number;
	/** The newest run of this revision did not complete, so a test comes first. */
	testFirst: boolean;
	schedulePaused: boolean;
	next: string[];
};

const FINISHED = new Set(["completed", "failed", "canceled"]);

function runTime(run: SkillDraftRun): string | null {
	const at = run.completedAt ?? run.startedAt;
	return at ? shortDeadline(normalizeD1Timestamp(at)) : null;
}

const on = (time: string | null) => (time ? ` on ${time}` : "");

/** One readable line from a run error: no stack, no line breaks. */
export function plainRunError(error: string | null | undefined): string | null {
	const line = (error ?? "")
		.split("\n")
		.map((part) => part.trim())
		.find((part) => part.length > 0);
	const plain = (line ?? "")
		.replace(/^(?:Uncaught\s+)?(?:[A-Za-z]*Error):\s*/, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!plain) return null;
	return plain.length > 300 ? `${plain.slice(0, 299)}…` : plain;
}

/** The newest finished runs, for the trend beside the sampled rate. */
export function recentRunTrend(
	runs: Array<Pick<SkillRunSummary, "status">> | undefined,
	size = 5,
): { finished: number; completed: number; failed: number } | null {
	if (!runs) return null;
	const recent = runs.filter((run) => FINISHED.has(run.status)).slice(0, size);
	if (recent.length === 0) return null;
	return {
		finished: recent.length,
		completed: recent.filter((run) => run.status === "completed").length,
		failed: recent.filter((run) => run.status === "failed").length,
	};
}

export function skillDraftReason(input: {
	skill: Pick<
		SkillEntry,
		"lifecycleState" | "revision" | "revisionReasoning" | "tags" | "files"
	>;
	/** Newest first; undefined while the run history is not loaded. */
	runs: SkillDraftRun[] | undefined;
	schedules?: Array<Pick<SkillSchedule, "enabled">>;
	/** The error text of `lastFailedRunId`, once it is loaded. */
	lastError?: string | null;
	/** Owners and admins turn a skill on. */
	canTurnOn: boolean;
}): SkillDraftReason | null {
	const { skill, runs } = input;
	if (skill.lifecycleState !== "draft") return null;
	const executable = Boolean(skill.files?.[WORKFLOW_SOURCE_PATH]);
	const schedulePaused = (input.schedules ?? []).some(
		(schedule) => !schedule.enabled,
	);
	// Runs still going say nothing yet; canceled runs were stopped by someone.
	const settled = (runs ?? []).filter(
		(run) => run.status === "completed" || run.status === "failed",
	);
	let failedInARow = 0;
	for (const run of settled) {
		if (run.status !== "failed") break;
		failedInARow += 1;
	}
	const latest = settled[0];
	const latestAt = latest ? runTime(latest) : null;
	const lastFailedRunId = failedInARow > 0 ? (latest?.id ?? null) : null;
	const onThisRevision = settled.filter(
		(run) => run.skillRevision == null || run.skillRevision === skill.revision,
	);
	const testFirst =
		executable &&
		runs !== undefined &&
		onThisRevision[0]?.status !== "completed";
	const error = plainRunError(input.lastError);
	const errorLine = error ? [`Last error: ${error}`] : [];
	const note = plainRunError(skill.revisionReasoning);
	const noteLine = note
		? [`Note saved with revision ${skill.revision}: ${note}`]
		: [];
	const changedSinceRuns =
		settled.length > 0 && onThisRevision.length === 0
			? [
					`Revision ${skill.revision} was saved after those runs and has not run yet.`,
				]
			: [];

	let kind: SkillDraftReasonKind;
	let title: string;
	let why: string[];
	if (skill.tags?.includes(PROPOSAL_TAG)) {
		kind = "proposal";
		title = "Draft: a proposed change to another skill";
		why = [
			"This is a working copy with a suggested improvement. It stays a draft and never runs on a schedule.",
			...noteLine,
		];
	} else if (runs === undefined) {
		kind = "unknown";
		title = "This skill is a draft";
		why = ["A draft does not run on a schedule."];
	} else if (failedInARow >= FAILED_RUNS_BEFORE_TURN_OFF) {
		kind = "failed_runs";
		title = `Draft after ${failedInARow} failed runs in a row`;
		why = [
			`Its last ${failedInARow} runs failed${latestAt ? `, most recently on ${latestAt}` : ""}. Tedix turns a skill off after ${FAILED_RUNS_BEFORE_TURN_OFF} failed runs in a row and keeps it off until someone turns it back on.`,
			...errorLine,
			...changedSinceRuns,
		];
	} else if (settled.length === 0) {
		kind = "never_run";
		title = "Draft: not turned on yet";
		why = [
			runs.length > 0
				? "A new skill starts as a draft. No run of it has finished yet."
				: "A new skill starts as a draft. It has not run yet.",
			...noteLine,
		];
	} else if (onThisRevision.length === 0) {
		kind = "changed";
		title = `Draft since revision ${skill.revision} was saved`;
		why = [
			`Someone changed this skill or turned it off after its latest run${on(latestAt)}. A changed skill stays a draft until it is turned on again, and revision ${skill.revision} has not run yet.`,
			...noteLine,
		];
	} else {
		kind = "not_turned_on";
		title = "Draft: this version is not turned on";
		why = [
			latest?.status === "failed"
				? `Its latest run failed${on(latestAt)}. Tedix did not turn it off: that takes ${FAILED_RUNS_BEFORE_TURN_OFF} failed runs in a row.`
				: `Its latest run completed${on(latestAt)}, so failed runs are not the reason. It is new, or someone turned it off.`,
			...(latest?.status === "failed" ? errorLine : []),
			...noteLine,
		];
	}
	if (schedulePaused && kind !== "proposal")
		why.push("Its schedule is paused, so no scheduled runs start.");

	const next: string[] = [];
	if (kind === "proposal") {
		next.push(
			"Review it on the Versions tab of the skill it would change, and adopt it there if it is better.",
		);
	} else {
		if (lastFailedRunId)
			next.push("Open the failed run, see what went wrong and fix it.");
		if (!input.canTurnOn) {
			next.push("Ask an owner or admin to turn this skill back on.");
		} else if (executable) {
			next.push(
				testFirst
					? "Run a test. Tedix normally turns a skill on only after a test run of this version has passed."
					: "Run a test if this version has not passed one yet.",
			);
			next.push("Turn it back on.");
		} else {
			next.push("Turn it back on when its instructions are ready.");
		}
		if (schedulePaused)
			next.push(
				"Open the Settings tab and turn the schedule back on if it is still paused.",
			);
	}
	return {
		kind,
		title,
		why,
		lastFailedRunId,
		failedInARow,
		testFirst,
		schedulePaused,
		next,
	};
}
