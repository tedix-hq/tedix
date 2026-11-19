import assert from "node:assert/strict";
import {
	buildCronBudgetSuppression,
	cronSuppressionReason,
	nextUtcDayStartMs,
	shouldSuppressCronForBudget,
} from "./cron-budget-control";

const now = Date.parse("2026-07-22T17:30:00.000Z");

assert.equal(nextUtcDayStartMs(now), Date.parse("2026-07-23T00:00:00.000Z"));

const reason =
	"Inference blocked by billing policy: monthly_credit_limit_reached";
const suppression = buildCronBudgetSuppression(reason, now);
assert.deepEqual(suppression, {
	resetAtMs: Date.parse("2026-07-23T00:00:00.000Z"),
	reason,
});
assert.equal(shouldSuppressCronForBudget(suppression, now + 1), true);
assert.equal(
	shouldSuppressCronForBudget(suppression, suppression.resetAtMs),
	false,
	"the pause lapses at the next UTC day",
);
assert.equal(
	shouldSuppressCronForBudget(
		{ resetAtMs: undefined, reason } as never,
		now + 1,
	),
	false,
	"a marker without its expiry never pauses scheduled work",
);

// A billing-policy denial is deterministic for the request: it pauses later
// cron fires instead of starting turns that fail the same way.
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
	cronSuppressionReason({
		text: "boom",
		stopReason: "runtime_error",
		error: "boom",
	}),
	null,
	"a transient runtime fault never suppresses scheduled work",
);

console.log("cron-budget-control tests passed");
