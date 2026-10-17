/**
 * "Runs on a schedule" for a Workspace: the skills linked to it by a
 * `tedix`/`skill` Workspace resource, with their run times, next run and last
 * finished run. Everything here is read-only and derived from D1 rows.
 */

import {
	type OsWorkspaceSchedule,
	type WorkspaceSkillRunsAt,
	WorkspaceSkillRunsAtSchema,
} from "@tedix/api-contract/schemas/os-workspace-schedules";
import { nextSkillScheduleFireAt } from "@tedix/api-contract/utils/skill-schedule";
import { parseSkillFrontmatter } from "@tedix/api-contract/utils/skill-manifest";
import type { ReportedSkillRunRow } from "@tedix/db/queries/skill-runs";

/** Result statuses of runs that did no work and are not shown as the last run. */
export const SKIPPED_RUN_RESULT_STATUSES = ["off_slot"] as const;

const DAY_MS = 86_400_000;
/** Enough fires to cover eight days of an hourly cron. */
const MAX_FIRES = 8 * 24 * 4;

function localClock(at: Date, timeZone: string): string {
	return new Intl.DateTimeFormat("en-GB", {
		timeZone,
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).format(at);
}

export function readRunsAt(
	metadata: Record<string, unknown>,
	skillContent?: string,
): WorkspaceSkillRunsAt | null {
	const declared = skillContent
		? parseSkillFrontmatter(skillContent)?.runsAt
		: undefined;
	const parsed = WorkspaceSkillRunsAtSchema.safeParse(
		metadata.runsAt ?? declared,
	);
	if (!parsed.success) return null;
	try {
		localClock(new Date(0), parsed.data.timeZone);
	} catch {
		return null;
	}
	return parsed.data;
}

/**
 * When a schedule runs: its next run and, for a cron that fires every day, the
 * next instant of each daily run time. With `runsAt`, a fire whose local time
 * is not one of its times is skipped, as the workflow skips it.
 */
export function scheduleRunTimes(
	cron: string,
	runsAt: WorkspaceSkillRunsAt | null,
	now: Date,
): { dailyTimes: string[]; nextRunAt: string | null } {
	const keeps = (at: Date) =>
		!runsAt || runsAt.times.includes(localClock(at, runsAt.timeZone));
	const daily = cron.trim().split(/\s+/).slice(2).join(" ") === "* * *";
	const horizon = now.getTime() + 8 * DAY_MS;
	const dailyTimes: string[] = [];
	let nextRunAt: string | null = null;
	let cursor: Date = now;
	try {
		for (let index = 0; index < MAX_FIRES; index++) {
			const fire = new Date(nextSkillScheduleFireAt(cron, cursor));
			if (fire.getTime() > horizon) break;
			cursor = fire;
			if (!keeps(fire)) continue;
			nextRunAt ??= fire.toISOString();
			if (!daily) break;
			if (fire.getTime() - now.getTime() >= DAY_MS) break;
			dailyTimes.push(fire.toISOString());
		}
	} catch {
		return { dailyTimes: [], nextRunAt: null };
	}
	return { dailyTimes, nextRunAt };
}

/** First line of a text, trimmed and cut to `max` characters. */
export function oneLine(text: string | null | undefined, max = 160) {
	const line = (text ?? "")
		.split("\n")
		.map((part) => part.trim())
		.find(Boolean);
	if (!line) return null;
	return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** The first sentence of a description, for a skill with no summary. */
function firstSentence(text: string | null | undefined): string | null {
	const line = oneLine(text, 400);
	if (!line) return null;
	return oneLine(line.split(/(?<=[.!?])\s/)[0], 160);
}

export function schedulePurpose(
	metadata: Record<string, unknown>,
	skill: { summary: string | null; description: string | null },
): string | null {
	const declared =
		typeof metadata.purpose === "string" ? oneLine(metadata.purpose) : null;
	return declared ?? oneLine(skill.summary) ?? firstSentence(skill.description);
}

export function reportedLastRun(
	run: ReportedSkillRunRow | undefined,
): OsWorkspaceSchedule["lastRun"] {
	if (!run || (run.status !== "completed" && run.status !== "failed"))
		return null;
	return {
		runId: run.id,
		status: run.status,
		startedAt: run.startedAt,
		completedAt: run.completedAt,
		cards:
			typeof run.cards === "number" && Number.isInteger(run.cards)
				? Math.max(run.cards, 0)
				: null,
		summary: oneLine(run.summary, 300),
		error: run.status === "failed" ? (oneLine(run.error, 300) ?? null) : null,
	};
}
