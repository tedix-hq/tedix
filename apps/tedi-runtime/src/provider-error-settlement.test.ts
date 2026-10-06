/**
 * A definitely non-retryable provider fault must SEAL, not burn the durable
 * `IDEMPOTENT_STEP_RETRY` budget (5 attempts from 15s) re-running the model on
 * a payload that is deterministic. Anything not positively recognized must stay
 * retryable so adopting this cannot stop a currently-recovering turn.
 */
import assert from "node:assert/strict";
import {
	isProviderErrorWorkflowResult,
	PROVIDER_ERROR_STOP_REASON,
	providerErrorWorkflowResult,
} from "./provider-error-settlement";

// (1) Terminal families seal immediately with an attributable family.
const auth = providerErrorWorkflowResult(
	new Error("Incorrect API key provided"),
);
assert.ok(auth, "a rejected key seals terminal");
assert.equal(auth.stopReason, PROVIDER_ERROR_STOP_REASON);
assert.equal(auth.providerErrorFamily, "auth");
assert.equal(
	auth.text,
	"",
	"a sealed provider fault carries no assistant prose",
);

assert.equal(
	providerErrorWorkflowResult(
		new Error("context_length_exceeded: 240000 > 200000"),
	)?.providerErrorFamily,
	"context_overflow",
	"the identical oversized payload cannot fit on a retry",
);
assert.equal(
	providerErrorWorkflowResult(new Error("insufficient_quota"))
		?.providerErrorFamily,
	"quota",
	"quota exhaustion is terminal for the accounting window",
);
assert.equal(
	providerErrorWorkflowResult(
		new Error(
			"The model `gpt-9` does not exist or you do not have access to it",
		),
	)?.providerErrorFamily,
	"not_found",
	"an unknown deployment is deterministic",
);

// (2) Transient faults return null so the durable retry policy still owns them.
for (const transient of [
	"fetch failed",
	"Error code: 429 - rate limit reached",
	"Error code: 524 - a timeout occurred",
	"The engine is currently overloaded",
	"socket hang up",
]) {
	assert.equal(
		providerErrorWorkflowResult(new Error(transient)),
		null,
		`transient must re-drive: ${transient}`,
	);
}

// (3) Conservative default: unrecognized errors keep today's retry behavior.
assert.equal(
	providerErrorWorkflowResult(new Error("weird upstream failure")),
	null,
	"an unrecognized error must not be sealed",
);
assert.equal(providerErrorWorkflowResult(null), null);
assert.equal(providerErrorWorkflowResult(undefined), null);

// (4) A quota-bearing 429 outranks the bare rate-limit reading.
assert.equal(
	providerErrorWorkflowResult(
		new Error(
			"Error code: 429 - {'message': 'You exceeded-quota for this org'}",
		),
	)?.providerErrorFamily,
	"quota",
	"a quota 429 is terminal, not a rate limit",
);

// (5) Persisted error text is capped so a provider HTML body cannot bloat rows.
const long = providerErrorWorkflowResult(
	new Error(`invalid_api_key ${"x".repeat(4000)}`),
);
assert.ok(
	long && long.error.length <= 512,
	"error text is capped at 512 chars",
);

// (6) Type guard round-trip.
assert.equal(isProviderErrorWorkflowResult(auth), true);
assert.equal(isProviderErrorWorkflowResult({ stopReason: "completed" }), false);
assert.equal(isProviderErrorWorkflowResult(null), false);

console.log("provider-error-settlement.test.ts: all assertions passed");
