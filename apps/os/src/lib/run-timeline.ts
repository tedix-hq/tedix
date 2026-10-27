import type {
	SkillWorkflowRunTimeline,
	SkillWorkflowTimelineEvent,
} from "@tedix/api-contract/schemas/cognitive";

function timestamp(value: string | null): number | null {
	const parsed = value === null ? NaN : Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

export function layoutRunTimeline(
	timeline: SkillWorkflowRunTimeline,
	now: number,
) {
	const live = ["queued", "running", "paused"].includes(timeline.run.status);
	const runEnd = timestamp(timeline.run.completedAt);
	const timed = timeline.events.flatMap((event) => {
		const start = timestamp(event.startedAt);
		if (start === null) return [];
		const end =
			timestamp(event.endedAt) ??
			(event.durationMs !== null
				? start + event.durationMs
				: event.outcome === "pending" && live
					? now
					: start);
		return [{ event, start, end: Math.max(start, end) }];
	});
	const starts = timed.map((entry) => entry.start);
	const ends = timed.map((entry) => entry.end);
	const runStart = timestamp(timeline.run.startedAt);
	if (runStart !== null) starts.push(runStart);
	if (runEnd !== null) ends.push(runEnd);
	if (live && runStart !== null) ends.push(now);
	const start = starts.length ? Math.min(...starts) : null;
	const end = ends.length ? Math.max(...ends) : start;
	const span = Math.max(1, (end ?? 0) - (start ?? 0));
	const lanes = timeline.lanes.map((lane) => {
		const tracks: number[] = [];
		const entries = timed
			.filter((entry) => entry.event.lane === lane.id)
			.sort((a, b) => a.start - b.start || a.end - b.end)
			.map((entry) => {
				let track = tracks.findIndex((end) => end < entry.start);
				if (track < 0) track = tracks.length;
				tracks[track] = entry.end;
				return {
					...entry,
					track,
					left: ((entry.start - (start ?? 0)) / span) * 100,
					width: ((entry.end - entry.start) / span) * 100,
				};
			});
		return { ...lane, entries, tracks: Math.max(1, tracks.length) };
	});
	return {
		start,
		end,
		span,
		lanes,
		untimed: timeline.events.filter(
			(event) => timestamp(event.startedAt) === null,
		),
	};
}

export function isTimelineWait(event: SkillWorkflowTimelineEvent) {
	return event.kind === "sleep" || event.kind === "wait";
}

export const RUN_OUTPUT_SAMPLE_LIMIT = 4_000;

export function outputSample(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	const text =
		typeof value === "string" ? value : JSON.stringify(value, null, 2);
	return text.length > RUN_OUTPUT_SAMPLE_LIMIT
		? `${text.slice(0, RUN_OUTPUT_SAMPLE_LIMIT)}\n… Sample truncated at ${RUN_OUTPUT_SAMPLE_LIMIT.toLocaleString()} characters.`
		: text;
}

export function parseRunReceipt(
	content: string | null | undefined,
): Record<string, unknown> {
	if (!content) return {};
	try {
		const value: unknown = JSON.parse(content);
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: { value };
	} catch {
		return { value: content };
	}
}
