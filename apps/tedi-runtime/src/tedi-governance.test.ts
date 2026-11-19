import assert from "node:assert/strict";
import {
	resolveGovernedStepCeiling,
	resolveTediBudgets,
} from "./tedi-governance";
assert.equal(
	resolveTediBudgets(null).maxIterationsPerTask,
	-1,
	"a legacy null budget must not reinstate an individual iteration limit",
);
assert.equal(
	resolveTediBudgets({ maxIterationsPerTask: 12 }).maxIterationsPerTask,
	12,
	"an explicit per-tedi iteration override must remain authoritative",
);
assert.equal(
	"dailyTokenLimit" in resolveTediBudgets({ dailyTokenLimit: 5 }),
	false,
	"a stored daily token limit is dropped; usage limits are monthly credits",
);

assert.equal(
	resolveGovernedStepCeiling({ maxIterationsPerTask: 64, hardMaxSteps: 40 }),
	40,
	"an explicit ceiling above the runtime backstop is bounded by it",
);
assert.equal(
	resolveGovernedStepCeiling({ maxIterationsPerTask: 12, hardMaxSteps: 40 }),
	12,
	"an explicit per-tedi budget caps the loop below the runtime backstop",
);
assert.equal(
	resolveGovernedStepCeiling({ maxIterationsPerTask: -1, hardMaxSteps: 40 }),
	null,
	"an unlimited entitlement means no step-count stop, not the backstop",
);
assert.equal(
	resolveGovernedStepCeiling({ maxIterationsPerTask: null, hardMaxSteps: 40 }),
	null,
	"a missing governance value means no step-count stop",
);
assert.equal(
	resolveGovernedStepCeiling({ maxIterationsPerTask: 0, hardMaxSteps: 40 }),
	null,
	"a zero entitlement is not a one-round turn; it is ungoverned",
);

console.log("tedi governance shared-capacity default OK");
