import { isBillingPolicyDeniedWorkflowResult } from "./billing-reservation-client";
import type { InferenceBudgetUsage } from "./inference-budget-store-do";

export const BUDGET_EXHAUSTED_STOP_REASON = "budget_exhausted";
export const CRON_BUDGET_SUPPRESSION_STORAGE_KEY =
	"governance:cron-budget-suppression";

const BUDGET_EXHAUSTED_MESSAGE = "Inference daily budget exhausted for ";

export interface CronBudgetSuppression {
	day: string;
	resetAtMs: number;
	backgroundMessageLimit: number;
	backgroundTokenLimit: number;
	usedMessages: number;
	usedTokens: number;
	reason: string;
}

export interface CronBudgetSuppressionSnapshot {
	admissionClass: "background";
	day: string;
	usedTokens: number;
	tokenLimit: number;
	remainingTokens: number;
	usedMessages: number;
	messageLimit: number;
	remainingMessages: number;
}

export interface BudgetExhaustedWorkflowResult {
	text: "";
	stopReason: typeof BUDGET_EXHAUSTED_STOP_REASON;
	error: string;
}

function errorMessage(error: unknown): string {
	try {
		if (error instanceof Error) return error.message;
		if (
			error &&
			typeof error === "object" &&
			typeof (error as { message?: unknown }).message === "string"
		) {
			return (error as { message: string }).message;
		}
		return String(error);
	} catch {
		return "Inference daily budget exhausted";
	}
}

/** Budget rejection is an expected governance stop, not a transient runtime fault. */
export function isInferenceBudgetExhaustedError(error: unknown): boolean {
	return errorMessage(error).includes(BUDGET_EXHAUSTED_MESSAGE);
}

export function budgetExhaustedWorkflowResult(
	error: unknown,
): BudgetExhaustedWorkflowResult {
	return {
		text: "",
		stopReason: BUDGET_EXHAUSTED_STOP_REASON,
		error: errorMessage(error),
	};
}

export function isBudgetExhaustedWorkflowResult(
	result: unknown,
): result is BudgetExhaustedWorkflowResult {
	if (!result || typeof result !== "object") return false;
	const value = result as Record<string, unknown>;
	return (
		value.stopReason === BUDGET_EXHAUSTED_STOP_REASON &&
		typeof value.error === "string"
	);
}

/**
 * A daily-budget stop or a billing-policy denial (inactive entitlement,
 * exhausted capacity, ...) is deterministic for the rest of the UTC day, so a
 * cron turn that ends in either suppresses later scheduled fires instead of
 * starting turns that fail the same way.
 */
export function cronSuppressionReason(result: unknown): string | null {
	if (
		isBudgetExhaustedWorkflowResult(result) ||
		isBillingPolicyDeniedWorkflowResult(result)
	)
		return result.error;
	return null;
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
	usage: InferenceBudgetUsage,
	reason: string,
	nowMs: number,
): CronBudgetSuppression {
	return {
		day: usage.day,
		resetAtMs: nextUtcDayStartMs(nowMs),
		backgroundMessageLimit: usage.backgroundMessageLimit,
		backgroundTokenLimit: usage.backgroundTokenLimit,
		usedMessages: usage.usedMessages,
		usedTokens: usage.usedTokens,
		reason,
	};
}

/** Operator-safe quantitative context for a typed suppressed cron outcome. */
export function cronBudgetSuppressionSnapshot(
	suppression: CronBudgetSuppression,
): CronBudgetSuppressionSnapshot {
	return {
		admissionClass: "background",
		day: suppression.day,
		usedTokens: suppression.usedTokens,
		tokenLimit: suppression.backgroundTokenLimit,
		remainingTokens: remainingBudget(
			suppression.backgroundTokenLimit,
			suppression.usedTokens,
		),
		usedMessages: suppression.usedMessages,
		messageLimit: suppression.backgroundMessageLimit,
		remainingMessages: remainingBudget(
			suppression.backgroundMessageLimit,
			suppression.usedMessages,
		),
	};
}

function remainingBudget(limit: number, used: number): number {
	return limit === -1 ? -1 : Math.max(0, limit - used);
}

export function isAdmissionBudgetExhausted(
	usage: InferenceBudgetUsage,
): boolean {
	return (
		budgetReached(usage.admissionMessageLimit, usage.usedMessages) ||
		budgetReached(usage.admissionTokenLimit, usage.usedTokens)
	);
}

function budgetReached(limit: number, used: number): boolean {
	return limit !== -1 && used >= limit;
}

function limitIncreased(previous: number, current: number): boolean {
	return previous !== -1 && (current === -1 || current > previous);
}

/** A zero remaining background lane can be rejected before another Workflow exists. */
export function isBackgroundBudgetHardExhausted(
	usage: InferenceBudgetUsage,
): boolean {
	return (
		budgetReached(usage.backgroundMessageLimit, usage.usedMessages) ||
		budgetReached(usage.backgroundTokenLimit, usage.usedTokens)
	);
}

/**
 * Keep a budget stop active only for the same UTC accounting window. Raising
 * either background ceiling, or a downward usage correction, immediately
 * reopens the lane instead of forcing an operator to wait until midnight.
 */
export function shouldSuppressCronForBudget(
	suppression: CronBudgetSuppression,
	usage: InferenceBudgetUsage,
	nowMs: number,
): boolean {
	if (suppression.day !== usage.day || nowMs >= suppression.resetAtMs)
		return false;
	if (
		limitIncreased(
			suppression.backgroundMessageLimit,
			usage.backgroundMessageLimit,
		) ||
		limitIncreased(suppression.backgroundTokenLimit, usage.backgroundTokenLimit)
	) {
		return false;
	}
	if (
		usage.usedMessages < suppression.usedMessages ||
		usage.usedTokens < suppression.usedTokens
	) {
		return false;
	}
	return true;
}
