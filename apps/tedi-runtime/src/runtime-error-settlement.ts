/** Deterministic run fences cannot heal by replaying the same durable run. */
import {
	isProviderErrorWorkflowResult,
	type ProviderErrorWorkflowResult,
} from "./provider-error-settlement";

import {
	isBillingPolicyDeniedWorkflowResult,
	type BillingPolicyDeniedWorkflowResult,
} from "./billing-reservation-client";

export interface RuntimeErrorWorkflowResult {
	text: string;
	stopReason: "runtime_error";
	error: string;
}

export function runtimeErrorWorkflowResult(
	error: unknown,
): RuntimeErrorWorkflowResult | null {
	const message = error instanceof Error ? error.message : String(error);
	if (
		message !== "cron_tool_failure" &&
		message !== "Durable provider-call ceiling reached" &&
		message !==
			"Interrupted tool effects require reconciliation before recovery" &&
		!message.startsWith("delegated_work_authority_lost: ") &&
		!message.startsWith("Chat inference denied for stopped run: ") &&
		!message.startsWith("Chat inference denied for canceled or stopped run: ")
	)
		return null;
	return {
		text: "",
		stopReason: "runtime_error",
		error: message.slice(0, 512),
	};
}

/** Native Workflow completion may carry a logical failure, never success. */
export function isTerminalFailureWorkflowResult(
	result: unknown,
): result is
	| RuntimeErrorWorkflowResult
	| ProviderErrorWorkflowResult
	| BillingPolicyDeniedWorkflowResult {
	if (!result || typeof result !== "object") return false;
	const value = result as Record<string, unknown>;
	return (
		typeof value.text === "string" &&
		typeof value.error === "string" &&
		(value.stopReason === "runtime_error" ||
			isProviderErrorWorkflowResult(result) ||
			isBillingPolicyDeniedWorkflowResult(result))
	);
}
