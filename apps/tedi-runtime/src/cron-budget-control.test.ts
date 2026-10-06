import assert from "node:assert/strict";
import {
	budgetExhaustedWorkflowResult,
	buildCronBudgetSuppression,
	cronBudgetSuppressionSnapshot,
	cronSuppressionReason,
	isBackgroundBudgetHardExhausted,
	isAdmissionBudgetExhausted,
	isBudgetExhaustedWorkflowResult,
	isInferenceBudgetExhaustedError,
	nextUtcDayStartMs,
	shouldSuppressCronForBudget,
} from "./cron-budget-control";
import type { InferenceBudgetUsage } from "./inference-budget-store-do";

const usage: InferenceBudgetUsage = {
	admissionClass: "background",
	backgroundMessageLimit: 90,
	backgroundTokenLimit: 900_000,
	dailyMessageLimit: 100,
	dailyTokenLimit: 1_000_000,
	day: "2026-07-22",
	operatorMessageReserve: 10,
	operatorTokenReserve: 100_000,
	governedLearningMessageReserve: 10,
	governedLearningTokenReserve: 100_000,
	governedLearningMessageLimit: 90,
	governedLearningTokenLimit: 900_000,
	admissionMessageLimit: 90,
	admissionTokenLimit: 900_000,
	remainingMessages: 10,
	remainingTokens: 100_000,
	usedMessages: 90,
	usedTokens: 900_000,
};
const now = Date.parse("2026-07-22T17:30:00.000Z");

assert.equal(nextUtcDayStartMs(now), Date.parse("2026-07-23T00:00:00.000Z"));
assert.equal(isBackgroundBudgetHardExhausted(usage), true);

const error = new Error(
	"Inference daily budget exhausted for 2026-07-22 (900000/1000000 tokens)",
);
assert.equal(isInferenceBudgetExhaustedError(error), true);
assert.equal(
	isInferenceBudgetExhaustedError(new Error("transient 503")),
	false,
);
const result = budgetExhaustedWorkflowResult(error);
assert.equal(isBudgetExhaustedWorkflowResult(result), true);
assert.equal(isBudgetExhaustedWorkflowResult({ stopReason: "error" }), false);

const suppression = buildCronBudgetSuppression(usage, error.message, now);
assert.deepEqual(cronBudgetSuppressionSnapshot(suppression), {
	admissionClass: "background",
	day: "2026-07-22",
	usedTokens: 900_000,
	tokenLimit: 900_000,
	remainingTokens: 0,
	usedMessages: 90,
	messageLimit: 90,
	remainingMessages: 0,
});
assert.equal(shouldSuppressCronForBudget(suppression, usage, now + 1), true);
assert.equal(
	shouldSuppressCronForBudget(suppression, usage, suppression.resetAtMs),
	false,
	"the next UTC accounting day automatically reopens the scheduler",
);
assert.equal(
	shouldSuppressCronForBudget(
		suppression,
		{ ...usage, backgroundTokenLimit: 1_100_000 },
		now + 1,
	),
	false,
	"an operator budget increase reopens immediately",
);
assert.equal(
	shouldSuppressCronForBudget(
		suppression,
		{ ...usage, usedTokens: usage.usedTokens - 1 },
		now + 1,
	),
	false,
	"a downward usage correction reopens immediately",
);

console.log("cron-budget-control tests passed");

const unlimited = {
	...usage,
	backgroundTokenLimit: -1,
	backgroundMessageLimit: -1,
	admissionTokenLimit: -1,
	admissionMessageLimit: -1,
};
assert.equal(isBackgroundBudgetHardExhausted(unlimited), false);
assert.equal(isAdmissionBudgetExhausted(unlimited), false);
assert.equal(
	isAdmissionBudgetExhausted({
		...unlimited,
		admissionMessageLimit: usage.usedMessages,
	}),
	true,
);
assert.equal(
	isBackgroundBudgetHardExhausted({
		...unlimited,
		backgroundTokenLimit: usage.usedTokens,
	}),
	true,
);
assert.equal(
	shouldSuppressCronForBudget(suppression, unlimited, now + 1),
	false,
	"removing an individual ceiling reopens a previously suppressed cron",
);
const unlimitedSnapshot = cronBudgetSuppressionSnapshot(
	buildCronBudgetSuppression(unlimited, "test", now),
);
assert.equal(unlimitedSnapshot.remainingTokens, -1);
assert.equal(unlimitedSnapshot.remainingMessages, -1);

// A billing-policy denial (inactive entitlement / exhausted capacity) is as
// deterministic as a daily-budget stop: both suppress later cron fires.
assert.equal(
	cronSuppressionReason({
		text: "blocked",
		stopReason: "billing_policy_denied",
		error: "Inference blocked by billing policy: entitlement_inactive",
		billingCode: "entitlement_inactive",
	}),
	"Inference blocked by billing policy: entitlement_inactive",
);
assert.equal(
	cronSuppressionReason(budgetExhaustedWorkflowResult(error)),
	error.message,
);
assert.equal(
	cronSuppressionReason({
		text: "boom",
		stopReason: "runtime_error",
		error: "boom",
	}),
	null,
	"a transient runtime fault never suppresses scheduled work",
);
