import { isBillingPolicyDeniedWorkflowResult } from "./billing-reservation-client";

export const CRON_BUDGET_SUPPRESSION_STORAGE_KEY =
	"governance:cron-budget-suppression";

/**
 * A durable pause on scheduled turns after a billing-policy denial (credits
 * used up, inactive subscription, ...). The pause lasts until the next UTC
 * day so a cron does not start turns that fail the same way every minute;
 * provider admission against the monthly credit pool stays the real gate.
 */
export interface CronBudgetSuppression {
	resetAtMs: number;
	reason: string;
}

/** The reason a finished cron turn should pause later fires, or null. */
export function cronSuppressionReason(result: unknown): string | null {
	return isBillingPolicyDeniedWorkflowResult(result) ? result.error : null;
}

export function nextUtcDayStartMs(nowMs: number): number {
	const now = new Date(nowMs);
	return Date.UTC(
		now.getUTCFullYear(),
		now.getUTCMonth(),
		now.getUTCDate() + 1,
	);
}

export function buildCronBudgetSuppression(
	reason: string,
	nowMs: number,
): CronBudgetSuppression {
	return { resetAtMs: nextUtcDayStartMs(nowMs), reason };
}

export function shouldSuppressCronForBudget(
	suppression: CronBudgetSuppression,
	nowMs: number,
): boolean {
	return (
		typeof suppression.resetAtMs === "number" &&
		typeof suppression.reason === "string" &&
		nowMs < suppression.resetAtMs
	);
}
