/**
 * Terminal settlement for definitely non-retryable provider faults.
 *
 * `IDEMPOTENT_STEP_RETRY` (`chat-turn-steps.ts`) gives every throw out of
 * `facet-turn` five attempts from 15s, exponential. That budget exists for
 * DEPLOY-WINDOW DO loss — it re-drives an idempotent step on a fresh isolate.
 * It is actively harmful for a deterministic provider fault: a rejected key, an
 * unknown deployment, a context-window overflow, or an exhausted org quota
 * re-runs the model four more times and seals the identical failure minutes
 * later, having spent four extra provider calls to learn nothing.
 *
 * This mirrors the existing precedent one line up in the same catch: daily
 * budget and billing-policy refusals already return TYPED TERMINAL RESULTS so
 * they cannot consume retries (`cron-budget-control.ts`,
 * `billing-reservation-client.ts`). Provider faults are the third member of
 * that family; the classifier lives in `@tedix/context-core/provider-error` so
 * inline facet turns and cron turns reach the same verdict.
 *
 * Conservative: `classifyProviderError` returns `retryable: true` for anything
 * it does not positively recognize, so an unmatched error still throws and
 * still gets the full durable retry budget.
 */

import {
	classifyProviderError,
	type ProviderErrorClass,
	providerErrorText,
} from "@tedix/context-core/provider-error";

/**
 * Terminal disposition for a provider fault. Joins the existing partial/terminal
 * stop-reason set (`budget_exhausted`, `step_ceiling`) so the
 * ledger carries it on `run.completed.payload.stopReason` and the kernel
 * run-set renders a real disposition instead of an empty completion.
 */
export const PROVIDER_ERROR_STOP_REASON = "provider_error";

export interface ProviderErrorWorkflowResult {
	text: "";
	stopReason: typeof PROVIDER_ERROR_STOP_REASON;
	error: string;
	/** Coarse family for telemetry/attribution (`auth`, `quota`, …). */
	providerErrorFamily: ProviderErrorClass;
}

/** Cap the persisted error text so a provider HTML body cannot bloat the row. */
const MAX_ERROR_TEXT = 512;

/**
 * Typed terminal result when `error` is definitely not worth another identical
 * request; `null` when the caller should rethrow and let the durable retry
 * policy own it.
 */
export function providerErrorWorkflowResult(
	error: unknown,
): ProviderErrorWorkflowResult | null {
	const verdict = classifyProviderError(error);
	// The facet already gave an empty loop answer one tools-off final report
	// (`facet-turn-stop.ts`); a turn that is still empty after that is
	// deterministic for this payload. Re-driving it burned the full retry
	// budget (~8 minutes) on delegated runs before they could seal `failed`.
	if (verdict.retryable && verdict.family !== "empty_response") return null;

	const text = providerErrorText(error).trim() || "provider call failed";
	return {
		text: "",
		stopReason: PROVIDER_ERROR_STOP_REASON,
		error: text.slice(0, MAX_ERROR_TEXT),
		providerErrorFamily: verdict.family,
	};
}

export function isProviderErrorWorkflowResult(
	result: unknown,
): result is ProviderErrorWorkflowResult {
	if (!result || typeof result !== "object") return false;
	const value = result as Record<string, unknown>;
	return (
		value.stopReason === PROVIDER_ERROR_STOP_REASON &&
		typeof value.error === "string"
	);
}
