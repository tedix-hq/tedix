import type {
	SkillEntry,
	SkillWorkflowRevision,
} from "@tedix/api-contract/schemas/cognitive";
import { formatCount } from "@/lib/format";

const ID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
/** Notes the system writes when it tidies up unused drafts or pins files. */
const HOUSEKEEPING = [
	/^Removed \d+ workflow improvement cop(?:y|ies)\b/i,
	/^Baseline \S+; candidate \S+\.?$/i,
];

/**
 * One recorded change note as a person would say it: the reason someone gave,
 * without the ids and system phrasing wrapped around it. Null when nothing
 * readable is left.
 */
export function plainChangeMessage(
	line: string | null | undefined,
): string | null {
	let text = (line ?? "").trim();
	if (!text) return null;
	text =
		/^Workflow improvement \S+ activated by .+? after certified run \S+: (.*)$/i.exec(
			text,
		)?.[1] ?? text;
	text =
		/^Workflow improvement proposed from run \S+?(?: at baseline revision \d+)?\. (.*)$/i.exec(
			text,
		)?.[1] ?? text;
	if (/^(?:Switched on|Adopted) from the .+ after test run \S+$/i.test(text))
		return "Adopted after a passed test";
	const restored = /^Roll back to revision (\d+)\b/i.exec(text);
	if (restored) return `Restored revision ${restored[1]}`;
	const adopted =
		/^Activated into canonical skill \S+ revision (\d+)\.?$/i.exec(text);
	if (adopted) return `Adopted as revision ${adopted[1]}`;
	text = text
		.replace(/\s*\([^()]*\)/g, (group) => (group.match(ID) ? "" : group))
		.replace(ID, "")
		.replace(/\s{2,}/g, " ")
		.replace(/\s+([.,:;])/g, "$1")
		.trim();
	return text || null;
}

/**
 * Splits a skill's accumulated change notes into what people wrote and what
 * the system added while cleaning up. Both keep their recorded order.
 */
export function splitChangeNotes(reasoning: string | null | undefined): {
	messages: string[];
	housekeeping: string[];
} {
	const messages: string[] = [];
	const housekeeping: string[] = [];
	for (const raw of (reasoning ?? "").split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		if (HOUSEKEEPING.some((pattern) => pattern.test(line))) {
			housekeeping.push(line);
			continue;
		}
		const message = plainChangeMessage(line);
		if (message) messages.push(message);
	}
	return { messages, housekeeping };
}

export type SkillVersionRow = {
	key: string;
	revision: number | null;
	current: boolean;
	/** One line saying what changed, or null when nothing was recorded. */
	message: string | null;
	changedAt: string | null;
	changedLabel: "Adopted" | "Updated" | "First ran" | null;
	/** The passed test run this version was adopted on. */
	testRunId: string | null;
	/** Run records of this version; null when it has not run. */
	observed: SkillWorkflowRevision | null;
	/** A run of the next older version that ran, to compare against. */
	previousRunId: string | null;
	previousRevision: number | null;
};

/**
 * The version history, current version first, then newest to oldest. A
 * version appears when it has run, was adopted from a draft, or is current.
 */
export function skillVersionRows({
	current,
	revisions,
	drafts,
}: {
	/** Null while the skill's details are unknown: nothing is marked current. */
	current: Pick<
		SkillEntry,
		"revision" | "revisionReasoning" | "updatedAt"
	> | null;
	revisions: readonly SkillWorkflowRevision[];
	/** Drafts of this skill; only adopted ones describe a version. */
	drafts: readonly SkillEntry[];
}): SkillVersionRow[] {
	const observedByRevision = new Map<number, SkillWorkflowRevision>();
	const unnumbered: SkillWorkflowRevision[] = [];
	for (const revision of revisions) {
		if (revision.revision == null) unnumbered.push(revision);
		else if (!observedByRevision.has(revision.revision))
			observedByRevision.set(revision.revision, revision);
	}
	const adoptedByRevision = new Map<number, SkillEntry>();
	for (const draft of drafts) {
		const into = draft.improvementAdoption?.activatedIntoRevision;
		if (into != null && !adoptedByRevision.has(into))
			adoptedByRevision.set(into, draft);
	}
	const numbers = new Set([
		...observedByRevision.keys(),
		...adoptedByRevision.keys(),
	]);
	if (current) numbers.add(current.revision);
	const ran = [...observedByRevision.keys()].sort((a, b) => b - a);
	const rows = [...numbers]
		.sort((a, b) => b - a)
		.map((revision): SkillVersionRow => {
			const observed = observedByRevision.get(revision) ?? null;
			const draft = adoptedByRevision.get(revision);
			const adoption = draft?.improvementAdoption;
			const isCurrent = current?.revision === revision;
			const previous = ran.find((number) => number < revision);
			const changedAt =
				adoption?.adoptedAt ??
				(isCurrent ? current?.updatedAt : null) ??
				observed?.firstObservedAt ??
				null;
			return {
				key: `revision-${revision}`,
				revision,
				current: isCurrent,
				message:
					plainChangeMessage(draft?.revisionReasoning?.split("\n")[0]) ??
					plainChangeMessage(adoption?.reason) ??
					(isCurrent
						? (splitChangeNotes(current?.revisionReasoning).messages.at(-1) ??
							null)
						: null),
				changedAt,
				changedLabel: !changedAt
					? null
					: adoption?.adoptedAt
						? "Adopted"
						: isCurrent && current?.updatedAt
							? "Updated"
							: "First ran",
				testRunId: adoption?.certificationRunId ?? null,
				observed,
				previousRunId:
					observed && previous != null
						? observedByRevision.get(previous)!.runId
						: null,
				previousRevision: observed && previous != null ? previous : null,
			};
		});
	rows.sort((a, b) => Number(b.current) - Number(a.current));
	for (const observed of unnumbered)
		rows.push({
			key: `run-${observed.runId}`,
			revision: null,
			current: false,
			message: null,
			changedAt: observed.firstObservedAt ?? null,
			changedLabel: observed.firstObservedAt ? "First ran" : null,
			testRunId: null,
			observed,
			previousRunId: null,
			previousRevision: null,
		});
	return rows;
}

/** "2 runs · 100% completed", with failures named when there are any. */
export function skillVersionRunLine(
	observed: Pick<
		SkillWorkflowRevision,
		"observedRunCount" | "completedCount" | "failedCount" | "canceledCount"
	> | null,
): string {
	if (!observed) return "No runs yet";
	const runs = observed.observedRunCount;
	const completed = observed.completedCount ?? 0;
	const failed = observed.failedCount ?? 0;
	const finished = completed + failed + (observed.canceledCount ?? 0);
	const count = `${formatCount(runs)} ${runs === 1 ? "run" : "runs"}`;
	if (finished === 0) return `${count} · none finished yet`;
	return `${count} · ${Math.round((completed / finished) * 100)}% completed${
		failed > 0 ? ` · ${formatCount(failed)} failed` : ""
	}`;
}
