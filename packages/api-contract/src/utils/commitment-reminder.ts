/**
 * A personal tedi files "Follow up: <Work title>" when an accepted commitment
 * sits idle or passes its due date. These reminders are not decisions: the
 * Decisions deck folds them into one Reminders row and keeps them out of the
 * For-you count.
 */
export const COMMITMENT_REMINDER_SOURCE = "commitment_followup";

/** Work events after which a reminder no longer describes the Work's state. */
export const COMMITMENT_REMINDER_CLOSING_EVENTS = [
	"work.accepted",
	"work.completed",
	"work.cancelled",
	"work.steward_closeout",
	"attempt.started",
	"attempt.settled",
] as const;

export function isCommitmentReminder(
	metadata: Readonly<Record<string, unknown>> | null | undefined,
): boolean {
	return metadata?.source === COMMITMENT_REMINDER_SOURCE;
}
