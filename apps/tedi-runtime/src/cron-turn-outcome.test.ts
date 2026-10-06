/**
 * Regression: a cron turn whose tool work FAILED must re-drive, not seal
 * success. Tool errors are fail-soft (returned to the model as `{ error }`,
 * never thrown), so `turnError` is blind to them and assistant prose cannot be
 * allowed to paint their terminal status green.
 */
import assert from "node:assert/strict";
import {
	CRON_TURN_MAX_STEPS,
	cronTurnMaxSteps,
	facetToolResultIndicatesFailure,
	facetTurnFailureReason,
} from "./cron-turn-outcome";

// (1) A real LLM/facet stream error always fails, every origin.
assert.equal(
	facetTurnFailureReason({
		turnError: "stream aborted",
		assistantText: "",
		isCronTurn: true,
		hadToolError: false,
	}),
	"stream aborted",
	"turnError re-drives regardless of origin",
);

// (2) Prose succeeds only when mechanical tool evidence is clean.
assert.equal(
	facetTurnFailureReason({
		turnError: null,
		assistantText: "done",
		isCronTurn: false,
		hadToolError: false,
	}),
	null,
	"a user turn with prose succeeds",
);
assert.equal(
	facetTurnFailureReason({
		turnError: null,
		assistantText: "consolidated 4 facts",
		isCronTurn: true,
		hadToolError: true,
	}),
	"cron_tool_failure",
	"cron prose cannot paint an observed tool failure green",
);

// (3) A user turn that fell silent still soft-fails.
assert.equal(
	facetTurnFailureReason({
		turnError: null,
		assistantText: "",
		isCronTurn: false,
		hadToolError: false,
	}),
	"empty_assistant_message",
	"a silent user turn soft-fails",
);

// (4) Core rule: a silent cron turn whose tool work SUCCEEDED is success —
// its deliverable is the Code Mode work, not closing prose.
assert.equal(
	facetTurnFailureReason({
		turnError: null,
		assistantText: "",
		isCronTurn: true,
		hadToolError: false,
	}),
	null,
	"a silent cron turn with clean tool work seals success",
);

// (5) A silent cron turn whose tool work FAILED must NOT seal success — a
// 'dark cron' would otherwise record lastSuccess:true for a consolidation that
// never ran. It must re-drive.
assert.equal(
	facetTurnFailureReason({
		turnError: null,
		assistantText: "",
		isCronTurn: true,
		hadToolError: true,
	}),
	"cron_tool_failure",
	"a silent cron turn with a failed tool proxy call re-drives instead of sealing success",
);

// (c) TIMEOUT: a cron-origin turn runs under a tighter step ceiling so its one
// durable Workflow step cannot blow Cloudflare's 10-minute wall clock.
assert.ok(
	CRON_TURN_MAX_STEPS < 40,
	"the cron step cap is tighter than the interactive ceiling (40)",
);
// The cap floors an interactive policy down to the cron ceiling.
assert.equal(
	cronTurnMaxSteps(40),
	CRON_TURN_MAX_STEPS,
	"a 40-step interactive policy is capped to the cron ceiling",
);
// It never RAISES a policy that already stamps a tighter ceiling.
assert.equal(
	cronTurnMaxSteps(4),
	4,
	"a policy tighter than the cron cap is left untouched (Math.min)",
);
assert.equal(
	cronTurnMaxSteps(CRON_TURN_MAX_STEPS),
	CRON_TURN_MAX_STEPS,
	"a policy at exactly the cron cap is unchanged",
);
assert.equal(
	cronTurnMaxSteps(null),
	CRON_TURN_MAX_STEPS,
	"an ungoverned (null) interactive ceiling still gets the cron cap",
);

// A resolved tool promise can still be a mechanical failure. These are the
// envelopes returned by the fail-soft AI SDK and native MCP adapters.
assert.equal(
	facetToolResultIndicatesFailure({ ok: false, error: "sync failed" }),
	true,
	"fail-soft AI SDK tool envelopes remain mechanical failures",
);
assert.equal(
	facetToolResultIndicatesFailure({ isError: true, content: [] }),
	true,
	"native MCP error envelopes remain mechanical failures",
);
assert.equal(facetToolResultIndicatesFailure({ ok: true }), false);
assert.equal(facetToolResultIndicatesFailure({ result: null }), false);

console.log("cron-turn-outcome.test.ts: all assertions passed");

// Review/assignment wakes are real work, even with cron budget provenance.
for (const isCronTurn of [false, true]) {
	assert.equal(
		facetTurnFailureReason({
			turnError: null,
			assistantText: "",
			isCronTurn,
			workItemId: "review-item",
			hadToolError: false,
		}),
		"empty_assistant_message",
	);
	assert.equal(
		facetTurnFailureReason({
			turnError: null,
			assistantText: "Evidence rejected: missing independent proof",
			isCronTurn,
			workItemId: "review-item",
			hadToolError: false,
		}),
		null,
	);
}

// A rejected review is a completed review, not failed maintenance. Preserve
// its typed evidence decision and do not replay model/tool effects on the
// same run merely because an attempted Work completion returned a gate error.
for (const isCronTurn of [false, true]) {
	assert.equal(
		facetTurnFailureReason({
			turnError: null,
			assistantText: "Evidence rejected: missing proof",
			isCronTurn,
			workItemId: "review-item",
			hadToolError: true,
		}),
		null,
	);
	assert.equal(
		facetTurnFailureReason({
			turnError: null,
			assistantText: "",
			isCronTurn,
			workItemId: "review-item",
			hadToolError: true,
		}),
		"empty_assistant_message",
	);
	assert.equal(
		facetTurnFailureReason({
			turnError: "stream aborted",
			assistantText: "partial",
			isCronTurn,
			workItemId: "review-item",
			hadToolError: true,
		}),
		"stream aborted",
	);
}
