import type { ListWorkAttemptStepsResult } from "@tedix/api-contract/schemas/work-attempt-steps";

/** The most steps one read returns; the contract's upper limit. */
export const WORK_RUN_STEP_PAGE = 500;
/**
 * One refresh reads at most this many pages. A longer run is finished by the
 * next refresh, which continues after the last step already held.
 */
const WORK_RUN_STEP_PAGES = 10;

type RunStepsPage = (input: {
	attemptId?: string;
	afterSeq?: number;
}) => Promise<ListWorkAttemptStepsResult>;

/**
 * Reads the newest run of a Work Item. Without `held` it reads the run from
 * its first step, page by page. With `held` it asks only for the steps after
 * the last one held and adds them; a refresh with nothing new keeps the held
 * list itself, so nothing that renders it changes. When the newest run is a
 * different Attempt, the held steps are dropped and the new run is read from
 * its start. Messages are returned whole by every read; the latest list wins.
 */
export async function readWorkRunSteps(
	readPage: RunStepsPage,
	held?: ListWorkAttemptStepsResult,
): Promise<ListWorkAttemptStepsResult> {
	const lastHeld = held?.attemptId ? held.steps.at(-1)?.seq : undefined;
	let latest = await readPage(
		lastHeld === undefined ? {} : { afterSeq: lastHeld },
	);
	const sameRun =
		Boolean(held?.attemptId) && latest.attemptId === held?.attemptId;
	let steps = sameRun ? held!.steps : [];
	if (!sameRun && lastHeld !== undefined && latest.attemptId)
		// A new run started: its first steps were skipped by `afterSeq`.
		latest = await readPage({ attemptId: latest.attemptId });
	const attemptId = latest.attemptId;
	for (let page = 1; ; page++) {
		const last = steps.at(-1)?.seq ?? -1;
		const fresh = latest.steps.filter((step) => step.seq > last);
		if (fresh.length) steps = [...steps, ...fresh];
		if (
			!attemptId ||
			latest.steps.length < WORK_RUN_STEP_PAGE ||
			!fresh.length ||
			page >= WORK_RUN_STEP_PAGES
		)
			break;
		latest = await readPage({ attemptId, afterSeq: steps.at(-1)!.seq });
	}
	return { ...latest, attemptId, steps };
}
