import assert from "node:assert/strict";
import {
	accountingStepPolicy,
	composeStoppedTurnText,
	finalReportInstruction,
	reservedFinalStepConfig,
	resolveFacetStepCeiling,
	stepCeilingReached,
	stoppedTurnNotice,
} from "./facet-turn-stop";

// A step ceiling is opt-in: only a stamped positive integer ends a turn.
for (const stamped of [null, undefined, 0, -1, 2.5, Number.NaN]) {
	assert.equal(
		resolveFacetStepCeiling(stamped),
		null,
		`${String(stamped)} must mean no step-count stop`,
	);
}
assert.equal(resolveFacetStepCeiling(5), 5);

// Without a ceiling the loop runs far past the old 40-round default.
assert.deepEqual(accountingStepPolicy(null), {});
assert.deepEqual(accountingStepPolicy(5), { maxSteps: 5 });
assert.equal(
	stepCeilingReached(60, null),
	false,
	"60 steps, no ceiling: run on",
);
assert.equal(stepCeilingReached(4, 5), false);
assert.equal(
	stepCeilingReached(5, 5),
	true,
	"a stamped ceiling of 5 stops at 5",
);

// The last permitted round is reserved tool-free only when a ceiling exists.
assert.equal(reservedFinalStepConfig(3, null), undefined);
assert.equal(reservedFinalStepConfig(3, 5), undefined);
assert.deepEqual(reservedFinalStepConfig(4, 5), { toolChoice: "none" });

// The forced report runs tools-off for exactly one round.
assert.match(
	finalReportInstruction("the step ceiling was reached"),
	/Do not call tools/,
);
assert.match(
	finalReportInstruction("x"),
	/what remains, and the single next step/,
);

// A stopped turn always settles with text: report + notice even when the loop
// produced nothing; Home can identify the structured stop notice.
const notice = stoppedTurnNotice("provider-call ceiling reached (5/5 steps)");
assert.equal(
	notice,
	"[Turn stopped early: provider-call ceiling reached (5/5 steps). Partial results above; remaining work was not attempted.]",
);
assert.equal(
	composeStoppedTurnText({
		assistantText: "",
		finalReport: "Done: read a.ts. Remaining: fix b.ts. Next: edit b.ts.",
		notice,
	}),
	`Done: read a.ts. Remaining: fix b.ts. Next: edit b.ts.\n\n${notice}`,
);
assert.equal(
	composeStoppedTurnText({ assistantText: "  ", finalReport: "", notice }),
	notice,
	"a failed report still leaves the notice",
);
assert.equal(
	composeStoppedTurnText({
		assistantText: "loop text",
		finalReport: "report",
		notice,
	}),
	`loop text\n\nreport\n\n${notice}`,
);

console.log("facet-turn-stop OK");
