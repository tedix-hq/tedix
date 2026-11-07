import type * as z from "zod";
import type { WorkInteractionInboxRowSchema } from "@tedix/api-contract/schemas/work-interactions";
import { isCommitmentReminder } from "@tedix/api-contract/utils/commitment-reminder";

type InboxRow = z.infer<typeof WorkInteractionInboxRowSchema>;

/**
 * Open automatic follow-up reminders, newest first. A reminder whose Work is
 * already finished or cancelled is left out; the server closes it shortly.
 */
export function openCommitmentReminders(rows: readonly InboxRow[]) {
	return rows
		.filter(
			(row) =>
				row.effectiveState === "open" &&
				row.canRespond &&
				isCommitmentReminder(row.request.metadata) &&
				row.workItem?.disposition !== "completed" &&
				row.workItem?.disposition !== "cancelled",
		)
		.sort(
			(a, b) =>
				b.request.requestedAt.localeCompare(a.request.requestedAt) ||
				b.request.id.localeCompare(a.request.id),
		);
}
