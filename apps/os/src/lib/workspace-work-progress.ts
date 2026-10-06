import type { WorkItem } from "@tedix/api-contract/schemas/work-items";

type Attempt = {
	workItemId: string;
	runtimeState: string;
	expiresAt: string | null;
	attemptNumber: number;
};

export const WORK_PROGRESS = [
	"proposed",
	"accepted",
	"queued",
	"running",
	"waiting",
	"retrying",
	"completed",
	"cancelled",
] as const;
export type WorkProgress = (typeof WORK_PROGRESS)[number];

export function workProgress(
	item: Pick<WorkItem, "id" | "disposition">,
	attempts: readonly Attempt[],
	now = Date.now(),
): WorkProgress {
	if (item.disposition !== "accepted") return item.disposition;
	const current = attempts
		.filter(
			(attempt) =>
				attempt.workItemId === item.id &&
				attempt.expiresAt !== null &&
				Date.parse(attempt.expiresAt) > now,
		)
		.reduce<Attempt | undefined>(
			(latest, attempt) =>
				!latest || attempt.attemptNumber > latest.attemptNumber
					? attempt
					: latest,
			undefined,
		);
	const state = current?.runtimeState;
	return state === "queued" ||
		state === "running" ||
		state === "waiting" ||
		state === "retrying"
		? state
		: "accepted";
}
