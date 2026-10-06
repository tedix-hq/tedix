/** Presentation bound only: full receipts/artifacts remain available to tools. */

import { asRecord } from "@tedix/api-contract/utils/is-record";
export const COMPUTER_EXECUTION_STREAM_CHARS = 4_000;

/** These are retained receipt/audit details, not additional command results. */
const EXECUTION_AUDIT_FIELDS = [
	"id",
	"processId",
	"process",
	"command",
	"context",
	"evidence",
	"roundTrip",
] as const;

function boundStreams(projected: Record<string, unknown>) {
	const omitted: Record<string, number> = {};
	for (const field of [
		"stdout",
		"stderr",
		"stdoutTail",
		"stderrTail",
	] as const) {
		const value = projected[field];
		if (
			typeof value !== "string" ||
			value.length <= COMPUTER_EXECUTION_STREAM_CHARS
		)
			continue;
		const half = COMPUTER_EXECUTION_STREAM_CHARS / 2;
		omitted[field] = value.length - COMPUTER_EXECUTION_STREAM_CHARS;
		projected[field] =
			`${value.slice(0, half)}\n[... ${omitted[field]} characters omitted from model preview ...]\n${value.slice(-half)}`;
	}
	if (Object.keys(omitted).length) {
		projected.modelPreview = {
			truncated: true,
			omittedCharacters: omitted,
			instruction:
				"This is a bounded preview, not the complete output. Inspect available artifact refs or use bounded read/grep on the retained command log/source files; artifact persistence failures remain reported in this receipt. Re-reading this execution returns the same preview; do not rerun the command just to recover output.",
		};
	}
	return projected;
}

function executionFields(
	receipt: Record<string, unknown>,
	executionId: string,
) {
	const projected = { ...receipt };
	for (const field of EXECUTION_AUDIT_FIELDS) {
		// Preserve conflicting identifiers as evidence rather than relabeling
		// a different job as this execution.
		if (
			(field === "id" || field === "processId") &&
			projected[field] !== undefined &&
			projected[field] !== executionId
		)
			continue;
		delete projected[field];
	}
	for (const stream of ["stdout", "stderr"] as const) {
		const tail = `${stream}Tail`;
		if (projected[stream] === undefined && typeof projected[tail] === "string")
			projected[stream] = projected[tail];
		if (projected[stream] === projected[tail]) delete projected[tail];
	}
	return projected;
}

/** Shared identity survives the persisted parent-to-facet tool descriptor. */
export function computerExecutionModelOutput({ output }: { output: unknown }) {
	const receipt = asRecord(output);
	if (!receipt) {
		return { type: "text" as const, value: JSON.stringify(output) ?? "null" };
	}
	// code_search, scratch exec and pre-dispatch refusals share this adapter.
	if (typeof receipt.executionId !== "string" || !receipt.executionId)
		return {
			type: "text" as const,
			value: JSON.stringify(boundStreams({ ...receipt })),
		};
	const projected = executionFields(receipt, receipt.executionId);
	// `running` is also an internal continuation flag. An unavailable observation
	// keeps that control flow intact without claiming process state to the model.
	if (receipt.observation === "unavailable" && receipt.terminal !== true) {
		delete projected.running;
		if (projected.status === "running") delete projected.status;
		projected.outcome = "unknown";
		projected.hint =
			"Execution state is currently unavailable. Keep this execution ID; do not repeat the command or poll. Yield while the existing completion tracking resolves it.";
	}
	const job = asRecord(receipt.job);
	if (job) {
		// /process/wait repeats its job at the root and under `job`. Remove
		// only duplicate values before stream truncation; failures can carry unique or
		// conflicting job details, which must remain alongside the root outcome.
		const details = executionFields(job, receipt.executionId);
		if (receipt.observation === "unavailable" && receipt.terminal !== true) {
			delete details.running;
			if (details.status === "running") delete details.status;
		}
		for (const [field, value] of Object.entries(details)) {
			if (
				Object.hasOwn(projected, field) &&
				JSON.stringify(value) === JSON.stringify(projected[field])
			)
				delete details[field];
		}
		if (Object.keys(details).length) projected.job = boundStreams(details);
		else delete projected.job;
	}
	return {
		type: "text" as const,
		value: JSON.stringify(boundStreams(projected)),
	};
}
