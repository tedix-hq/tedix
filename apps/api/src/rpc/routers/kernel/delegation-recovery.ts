import type { BaseContext } from "../../orpc";
import { createError, ErrorCodes } from "../../orpc";
import { readChildRunEvidenceRows } from "./child-run-reads";

/** Parent status and elapsed time cannot prove the child has stopped. */
export async function requireDelegatedChildTerminalReceipt(
	context: BaseContext,
	input: {
		organizationId: string;
		delegatedTediId: string;
		childRunId: string | null;
	},
): Promise<void> {
	if (input.childRunId) {
		const evidence = await readChildRunEvidenceRows(context, {
			organizationId: input.organizationId,
			tediId: input.delegatedTediId,
			runId: input.childRunId,
			eventLimit: 25,
			artifactLimit: 0,
			includeMappedWorkstationRun: true,
		});
		if (
			evidence.eventReadAvailable &&
			evidence.eventRows.some((event) =>
				["run.completed", "run.failed", "run.canceled"].includes(event.kind),
			)
		)
			return;
	}
	throw createError(
		ErrorCodes.CONFLICT,
		"Retry blocked: the original delegated child may still execute. Obtain its canonical terminal receipt in the owning organization before retrying; a parent timeout or empty event list is not proof of a stop.",
	);
}
