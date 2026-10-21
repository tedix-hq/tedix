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
	if (
		input.status === "failed" &&
		/^This turn ended without a reply\b/.test(finalMessage ?? "")
	) {
		return "I couldn't finish this request. Nothing was produced. Please try again.";
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
