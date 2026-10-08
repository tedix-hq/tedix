import assert from "node:assert/strict";
import { GOVERNED_LEARNING_SCHEDULES } from "@tedix/api-contract/utils/governed-learning";
import {
	estimateInferenceTokens,
	facetTurnBudgetClass,
	inferenceBudgetAdmissionClass,
	inferenceSource,
	trustedInstructionOriginForInject,
} from "./inference-guardrails";

assert.equal(
	inferenceSource("agent:main:cron:brain-consolidation", "cron"),
	"cron:brain-consolidation",
);
assert.equal(inferenceSource("agent:main:ci-smoke-123", "mcp"), "ci");
assert.equal(inferenceSource("home:run:123", "mcp"), "home");
assert.equal(inferenceSource("telegram:42", "chat"), "telegram");
assert.equal(inferenceSource("agent:main:main", "operator"), "operator");
assert.equal(estimateInferenceTokens("123456"), 2);
assert.equal(estimateInferenceTokens({ text: "12345" }) > 1, true);
assert.equal(
	inferenceBudgetAdmissionClass({ trustedInstructionOrigin: "cron" }),
	"background",
);
assert.equal(
	inferenceBudgetAdmissionClass({ callerTrust: "foreign" }),
	"background",
	"a foreign MCP caller never draws the operator reserve",
);
assert.equal(
	inferenceBudgetAdmissionClass({ callerTrust: "tedi" }),
	"operator",
);
const assignmentWakeOrigin = trustedInstructionOriginForInject({
	source: "work_item_assignment_inbox",
});
assert.equal(assignmentWakeOrigin, "cron");
assert.equal(
	inferenceBudgetAdmissionClass({
		trustedInstructionOrigin: assignmentWakeOrigin,
		sessionKey: "agent:main:cron:work-item-assignment-inbox",
	}),
	"background",
);
assert.equal(
	inferenceSource("agent:main:cron:work-item-assignment-inbox", "mcp"),
	"cron:work-item-assignment-inbox",
);
assert.equal(
	trustedInstructionOriginForInject({
		source: "kernel_delegation",
	}),
	undefined,
);
assert.equal(trustedInstructionOriginForInject(undefined), undefined);
const automationId = "5eed0030-0000-4000-8000-000000000030";
for (const { name: schedule } of GOVERNED_LEARNING_SCHEDULES) {
	assert.equal(
		inferenceBudgetAdmissionClass({
			sessionKey: `${schedule}:${automationId}`,
		}),
		"governed_learning",
		`${schedule} deterministic workflow must retain learning capacity without consuming operator reserve`,
	);
}
assert.equal(
	inferenceBudgetAdmissionClass({
		sessionKey: `agent:main:grounding-review_${automationId}`,
	}),
	"governed_learning",
);
for (const sessionKey of [
	undefined,
	"home:run:123",
	"agent:main:delegation-f8101011",
	"grounding-review",
	"grounding-review:operator-notes",
]) {
	assert.equal(
		inferenceBudgetAdmissionClass({ sessionKey }),
		"operator",
		`${sessionKey ?? "missing session"} must preserve operator capacity`,
	);
}

// ── Budget class is INDEPENDENT of the spend lane ────────────────────────────
// An assignment wake
// selects the background spend lane via `trustedInstructionOrigin: "cron"`, and
// that must NOT also hand it the maintenance cycle's 4-round cap and
// Code-Mode-only tool surface, or the turn runs with zero tool calls because
// the Work Item needs tools the cron projection removes.
assert.equal(
	facetTurnBudgetClass({
		trustedInstructionOrigin: "cron",
		workItemId: "5eed0018-0000-4000-8000-000000000018",
	}),
	"wake",
	"a cron-origin turn carrying a Work Item is WORK, not a maintenance cycle",
);
assert.equal(
	facetTurnBudgetClass({ trustedInstructionOrigin: "cron" }),
	"maintenance_cycle",
	"a scheduled cycle carries no Work Item and keeps the tight cron budget",
);
assert.equal(
	facetTurnBudgetClass({
		trustedInstructionOrigin: "cron",
		workItemId: null,
	}),
	"maintenance_cycle",
	"an explicitly null Work Item is still a maintenance cycle",
);
assert.equal(
	facetTurnBudgetClass({ workItemId: "5eed0018" }),
	"interactive",
	"a Work Item alone does not make an untrusted turn a wake",
);
assert.equal(
	facetTurnBudgetClass({}),
	"interactive",
	"ordinary turns are unaffected",
);
// Both wake and maintenance stay on the SAME background spend lane — the split
// is about rounds and tools only, so cost governance is unchanged.
for (const workItemId of [undefined, "5eed0018"]) {
	assert.equal(
		inferenceBudgetAdmissionClass({
			trustedInstructionOrigin: "cron",
			...(workItemId ? { sessionKey: "agent:main:cron:work-item-inbox" } : {}),
		}),
		"background",
		"splitting the budget class must not move either turn off the background lane",
	);
}

console.log("inference-guardrails tests passed");
