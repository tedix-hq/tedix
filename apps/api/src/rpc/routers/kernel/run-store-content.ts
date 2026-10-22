import type { TediRunStatus } from "@tedix/api-contract/schemas/cognitive-runtime";
import {
	type DelegatedStopClassification,
	hasDelegatedOutput,
	stripSyntheticMarkers,
} from "./delegated-stop";
import { type DelegationAttemptResult } from "./delegation-work-item";
import { validateDelegationOutput } from "./output-schema-validate";

/**
 * Proof-verdict chip for a delegation attempt — carried as METADATA
 * (`metadata.delegationProof` on the completion message AND on the parent
 * Home run row), never concatenated into the assistant body: the body stays
 * what the tedi wrote and the OS renders the verdict as a chip. The OS maps
 * `verdict` words: verified/proven/passed → success, unverified/partial/
 * inconclusive → warning, failed/refuted/rejected → error. `reason` keeps the
 * exact ledger failure reason for diagnostics. `null` when the attempt has
 * not reached a verdict (non-terminal, or no disposition available).
 */
export type HomeDelegationProofMetadata = {
	verdict: "verified" | "unverified" | "failed";
	note?: string;
	reason?: NonNullable<DelegationAttemptResult["failureReason"]>;
};

export function homeDelegationProofMetadata(
	result: DelegationAttemptResult | null | undefined,
	status: TediRunStatus,
): HomeDelegationProofMetadata | null {
	// Only a COMPLETED child carries a proof verdict worth a chip; a failed or
	// canceled child already states its outcome in the message body.
	if (!result || status !== "completed") return null;
	if (result.outcome === "succeeded") {
		// Result references are telemetry, not independent verification of the task.
		return null;
	}
	if (result.outcome !== "failed") return null;
	switch (result.failureReason) {
		case "completed_without_proof":
			return {
				verdict: "unverified",
				reason: result.failureReason,
				note: "No durable execution evidence (commit, PR, or artifact) was recorded for this attempt — the Work Item remains accepted and can be re-dispatched.",
			};
		case "unverified_execution_evidence":
			return {
				verdict: "unverified",
				reason: result.failureReason,
				note: "Execution evidence for this attempt could not be verified (runtime telemetry is incomplete) — the Work Item remains accepted pending verification.",
			};
		case null:
			return null;
		default:
			return { verdict: "failed", reason: result.failureReason };
	}
}

/**
 * Output-schema task mode (opt-in Tedix result-contract pattern): when a caller
 * supplied an output schema on the work order AND the delegation completed,
 * validate the relayed content against it. The verdict is MESSAGE METADATA
 * (`metadata.outputContract`) — the raw answer is never rewritten, relay-first
 * stays intact. `null` on success (no "contract met" affirmation) and whenever
 * there is nothing to validate, matching `homeDelegationProofMetadata`.
 */
export type HomeDelegationOutputContractMetadata = {
	met: false;
	errors: string[];
};

export function homeDelegationOutputContractMetadata(
	outputSchema: Record<string, unknown> | null | undefined,
	status: TediRunStatus,
	content: string,
): HomeDelegationOutputContractMetadata | null {
	if (!outputSchema || status !== "completed" || !content.trim()) return null;
	const result = validateDelegationOutput(content, outputSchema);
	if (result.valid) return null;
	return { met: false, errors: result.errors };
}

/**
 * The verdict metadata block for a delegation completion message — spread
 * into `payload.metadata` next to the relayed content. Empty when neither
 * verdict applies, so a clean completion carries no extra keys.
 */
export function homeDelegationVerdictMetadata(input: {
	disposition?: DelegationAttemptResult | null;
	outputSchema?: Record<string, unknown> | null;
	status: TediRunStatus;
	/** The operator-facing content the output contract validates (synthesis or the child's final message). */
	validatedContent: string | null;
}): {
	delegationProof?: HomeDelegationProofMetadata;
	outputContract?: HomeDelegationOutputContractMetadata;
} {
	const delegationProof = homeDelegationProofMetadata(
		input.disposition,
		input.status,
	);
	const outputContract = input.validatedContent
		? homeDelegationOutputContractMetadata(
				input.outputSchema,
				input.status,
				input.validatedContent,
			)
		: null;
	return {
		...(delegationProof ? { delegationProof } : {}),
		...(outputContract ? { outputContract } : {}),
	};
}

const TURN_FAILURE_NOTICE_PREFIX =
	/^This turn ended without a reply\b[^]*?\bReason:\s*/;

/**
 * Plain-English reading of a runtime failure reason, with the one next step
 * the operator can take. Each entry names a runtime error family the
 * delegated turn can die with (`runtime-error-settlement.ts`, the billing
 * admission denial, the residency gate). Tenant-free by construction: only
 * the reason's own detail (a tool name, a run id) is echoed back.
 */
const FAILURE_READINGS: ReadonlyArray<{
	match: RegExp;
	reason: (match: RegExpMatchArray) => string;
	nextStep: string;
}> = [
	{
		match: /^capability tool unavailable:\s*([^;]+)/i,
		reason: (m) =>
			`The plan asked for a tool the worker cannot use (${m[1]?.trim() ?? "unknown"}).`,
		nextStep: "Ask again in Home; it will plan the tools differently.",
	},
	{
		match: /^capability gap:\s*([^;]+)/i,
		reason: (m) =>
			`The worker is missing a capability this task needs (${m[1]?.trim() ?? "unknown"}).`,
		nextStep: "Ask again in Home; it will route the task differently.",
	},
	{
		match: /^Chat inference denied for (?:canceled or )?stopped run\b/i,
		reason: () => "The run was stopped before the worker could answer.",
		nextStep: "Send the request again to start a fresh run.",
	},
	{
		match: /^Delegation preflight failed:\s*(.+?)(?:;|$)/i,
		reason: (m) =>
			`The hand-off could not start: ${m[1]?.trim() ?? "unknown"}.`,
		nextStep:
			"Ask Home to retry with a worker that has access to the required source or tool.",
	},
	{
		match: /^delegated_work_authority_lost\b/i,
		reason: () => "The worker lost its hold on this Work Item mid-turn.",
		nextStep: "Send the request again to start a fresh run.",
	},
	{
		match:
			/(?:RESIDENCY_POLICY_UNAVAILABLE|residency_policy_unavailable|data residency setting could not be verified)/i,
		reason: () =>
			"The organization's data residency setting could not be read, so no model request was sent.",
		nextStep:
			"Try again; if it repeats, an administrator should check the residency setting.",
	},
	{
		match: /Inference blocked by billing policy:\s*(eu_[a-z_]+)/i,
		reason: () =>
			"This organization requires EU model processing and no verified EU provider route is configured.",
		nextStep: "An administrator must configure the EU provider and credential.",
	},
	{
		match: /Inference blocked by billing policy:\s*([a-z_]+)/i,
		reason: (m) =>
			`The billing policy blocked inference (${m[1] ?? "unknown"}).`,
		nextStep: "Check the organization's credits and plan, then try again.",
	},
	{
		match: /inference budget|budget exhausted/i,
		reason: () => "The daily inference budget is exhausted.",
		nextStep: "It will run again once the budget window resets.",
	},
	{
		match: /^Durable provider-call ceiling reached/i,
		reason: () => "The worker hit its per-run model-call limit.",
		nextStep: "Ask again with a narrower task.",
	},
];

/**
 * One operator-facing line for a delegated turn that failed before producing
 * anything: the real reason in plain English, once, plus the one next step.
 * `null` when the message is not a runtime failure notice.
 */
export function delegationFailureNotice(finalMessage: string): string | null {
	const trimmed = finalMessage.trim();
	const noticeMatch = TURN_FAILURE_NOTICE_PREFIX.exec(trimmed);
	const raw = noticeMatch ? trimmed.slice(noticeMatch[0].length) : trimmed;
	const reasonText = raw
		.replace(/^workflow errored before terminal:\s*/i, "")
		.replace(/\s+/g, " ")
		.trim();
	const reading = FAILURE_READINGS.find((entry) =>
		entry.match.test(reasonText),
	);
	if (reading) {
		const match = reasonText.match(reading.match) as RegExpMatchArray;
		return `I couldn't finish this request. ${reading.reason(match)} ${reading.nextStep}`;
	}
	if (!noticeMatch) return null;
	const clipped =
		reasonText.length > 200
			? `${reasonText.slice(0, 197).trimEnd()}...`
			: reasonText;
	return clipped && clipped !== "unknown error"
		? `I couldn't finish this request. The worker's turn failed before it produced anything: ${clipped}. Please try again.`
		: "I couldn't finish this request. Nothing was produced. Please try again.";
}

export function homeDelegationCompletionContent(input: {
	preview: string | null;
	synthesized?: string | null;
	finalMessage?: string | null;
	status: TediRunStatus;
	/** Runtime stop classification when the child was stopped early or reported partial. */
	stop?: Pick<DelegatedStopClassification, "detail" | "outcome"> | null;
}): string {
	// Proof and output-contract verdicts are NOT part of the body: they ride as
	// message metadata (`homeDelegationVerdictMetadata`) and the OS renders
	// the verdict as a chip. Runtime diagnostics do not belong in the reply.
	// When a full synthesis is available, use it directly — it's the operator-
	// facing interpreted answer, no wrapping needed.
	if (input.synthesized) return input.synthesized;
	// A runtime stop that left nothing but the `[Turn stopped early: …]` marker
	// is not a failed report and not a partial: the tedi produced no output.
	// Do not relay the marker as if it were the tedi's answer.
	if (
		input.stop?.outcome === "failed" &&
		input.status === "failed" &&
		!hasDelegatedOutput(input.finalMessage)
	) {
		return "I stopped before I had a result to share. Want me to try again?";
	}
	const finalMessage = input.finalMessage
		? stripSyntheticMarkers(input.finalMessage)
		: null;
	// A runtime failure notice carries the real reason after "Reason:"; the
	// operator reads it once, in plain English, with the one next step.
	if (
		input.status === "failed" &&
		input.stop?.outcome !== "partial" &&
		finalMessage
	) {
		const notice = delegationFailureNotice(finalMessage);
		if (notice) return notice;
	}
	// The child's own closing message is the next-best operator-facing answer:
	// show it as the result, not as wrapped "evidence".
	if (finalMessage) {
		switch (input.status) {
			case "completed":
				return finalMessage;
			case "failed":
				return input.stop?.outcome === "partial"
					? `Here's what I found so far:\n\n${finalMessage}\n\nWant me to continue?`
					: `I couldn't finish this request.\n\n${finalMessage}`;
			case "canceled":
				return `Stopped.\n\n${finalMessage}`;
			default:
				return finalMessage;
		}
	}
	const evidence = input.preview ? ` Latest evidence: ${input.preview}` : "";
	switch (input.status) {
		case "completed":
			return `The delegated tedi finished the assignment.${evidence}`;
		case "failed":
			return `The delegated tedi reported that the assignment failed.${evidence}`;
		case "canceled":
			return `The delegated tedi assignment was canceled.${evidence}`;
		default:
			return `The delegated tedi published an update.${evidence}`;
	}
}
