import type { KernelExecutionAttempt } from "./gateway-attribution";
import type { KernelRouteUsage } from "./route-planner";

/** Aggregate provider receipts once; route counters are not an extra execution. */
export function aggregateTurnUsage(
	routeUsage: KernelRouteUsage | null | undefined,
	executionAttempts: readonly KernelExecutionAttempt[],
): KernelRouteUsage | null {
	const unique = new Map<string, KernelExecutionAttempt>();
	for (const attempt of [
		...(routeUsage?.attempts ?? []),
		...executionAttempts,
	]) {
		const previous = unique.get(attempt.executionId);
		// A later callback can carry the same admission before usage is populated.
		unique.set(attempt.executionId, {
			...attempt,
			usage: attempt.usage ?? previous?.usage,
		});
	}
	const attempts = [...unique.values()];
	if (!attempts.length) return routeUsage ?? null;
	const sum = (
		field:
			| "inputTokens"
			| "outputTokens"
			| "cacheReadTokens"
			| "cacheWriteTokens",
	): number | null => {
		let total = 0;
		for (const attempt of attempts) {
			const value = attempt.usage?.[field];
			if (
				typeof value !== "number" ||
				!Number.isSafeInteger(value) ||
				value < 0
			)
				return null;
			total += value;
			if (!Number.isSafeInteger(total)) return null;
		}
		return total;
	};
	const inputTokens = sum("inputTokens");
	const outputTokens = sum("outputTokens");
	const cacheReadTokens = sum("cacheReadTokens");
	const cacheWriteTokens = sum("cacheWriteTokens");
	const only = attempts.length === 1 ? attempts[0]! : null;
	const providers = new Set(
		attempts.map((attempt) => attempt.identity.provider),
	);
	const models = new Set(
		attempts.map((attempt) => attempt.identity.requestModel),
	);
	return {
		attempts,
		attemptCount: attempts.length,
		executionId: only?.executionId ?? null,
		pricingIdentity: only?.identity ?? null,
		occurredAt: only?.occurredAt ?? null,
		complete: [
			inputTokens,
			outputTokens,
			cacheReadTokens,
			cacheWriteTokens,
		].every((value) => value !== null),
		provider: providers.size === 1 ? attempts[0]!.identity.provider : null,
		model:
			providers.size === 1 && models.size === 1
				? attempts[0]!.identity.requestModel
				: null,
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		// Attempt receipts do not expose reasoning counts; don't label a subtotal as a total.
		reasoningTokens:
			only && only.executionId === routeUsage?.executionId
				? routeUsage.reasoningTokens
				: null,
	};
}
