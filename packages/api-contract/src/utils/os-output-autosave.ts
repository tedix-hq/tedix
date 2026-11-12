import {
	OS_OUTPUT_AUTOSAVE_BURST_GAP_MS,
	OS_OUTPUT_AUTOSAVE_NOTE,
} from "./os-output-limits";

interface AutosaveRevision {
	note: string | null;
	createdByKind: string;
	createdById: string;
	skillRunId: string | null;
	createdAt: string;
}

/** Whether two consecutive stored revisions belong to one person's editing burst. */
export function continuesOutputAutosaveBurst(
	previous: AutosaveRevision | undefined,
	current: AutosaveRevision,
): boolean {
	const gap = previous
		? Date.parse(current.createdAt) - Date.parse(previous.createdAt)
		: NaN;
	return Boolean(
		previous &&
		current.createdByKind === "user" &&
		previous.createdByKind === current.createdByKind &&
		previous.createdById === current.createdById &&
		!previous.skillRunId &&
		!current.skillRunId &&
		previous.note?.startsWith(OS_OUTPUT_AUTOSAVE_NOTE) &&
		current.note?.startsWith(OS_OUTPUT_AUTOSAVE_NOTE) &&
		gap >= 0 &&
		gap < OS_OUTPUT_AUTOSAVE_BURST_GAP_MS,
	);
}
