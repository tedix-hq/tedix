import assert from "node:assert/strict";
import {
	estimateInferenceTokens,
	facetTurnBudgetClass,
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
const assignmentWakeOrigin = trustedInstructionOriginForInject({
	source: "work_item_assignment_inbox",
});
assert.equal(assignmentWakeOrigin, "cron");
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
// ── Round budget follows the work, not the trusted origin ────────────────────
// An assignment wake carries `trustedInstructionOrigin: "cron"`, and that must
// NOT also hand it the maintenance cycle's 4-round cap and
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
console.log("inference-guardrails tests passed");
