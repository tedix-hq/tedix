import assert from "node:assert/strict";
import {
	accountingStepPolicy,
	composeStoppedTurnText,
	finalReportInstruction,
	emptyTurnModelError,
	finalReportReason,
	reservedFinalStepConfig,
	resolveFacetStepCeiling,
	splitFinalReport,
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

// The forced report runs tools-off for exactly one round and asks for an
// operator part, a technical part, and a Blocked line when something is missing.
assert.match(
	finalReportInstruction("the step ceiling was reached"),
	/Do not call tools/,
);
assert.match(finalReportInstruction("x"), /---technical---/);
assert.match(finalReportInstruction("x"), /Blocked \(<kind>\)/);
assert.match(finalReportInstruction("x"), /missing_repository, missing_access/);
assert.match(
	finalReportInstruction("x"),
	/no tool names, file paths, ids or commands/,
);

// The report splits on the separator; without one it is all operator text.
assert.deepEqual(
	splitFinalReport(
		"Blocked (missing_repository): no repository is connected yet.\n\n---technical---\nopen_computer({ repository: true }) → repository_not_configured.\nNext: configure repoConfig.repoUrl.",
	),
	{
		operator: "Blocked (missing_repository): no repository is connected yet.",
		technical:
			"open_computer({ repository: true }) → repository_not_configured.\nNext: configure repoConfig.repoUrl.",
	},
);
assert.deepEqual(splitFinalReport("All done.\n--- Technical ---\n"), {
	operator: "All done.",
	technical: null,
});
assert.deepEqual(splitFinalReport("Done: read a.ts."), {
	operator: "Done: read a.ts.",
	technical: null,
});

// A stopped turn always settles with text: report + notice even when the loop
// produced nothing; Home can identify the structured stop notice. The
// technical part rides behind markers so it stays in evidence, not in chat.
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
	composeStoppedTurnText({
		assistantText: "",
		finalReport:
			"I checked two of five invoices.\n---technical---\nRead invoices 1-2 via list_invoices; remaining ids 3,4,5.",
		notice,
	}),
	`I checked two of five invoices.\n\n[technical-report]\nRead invoices 1-2 via list_invoices; remaining ids 3,4,5.\n[/technical-report]\n\n${notice}`,
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
assert.equal(
	composeStoppedTurnText({
		assistantText: "",
		finalReport:
			"Blocked (missing_access): I am not allowed to read that mailbox.",
		notice: null,
	}),
	"Blocked (missing_access): I am not allowed to read that mailbox.",
	"an empty-answer report without a stop has no notice",
);
assert.equal(
	composeStoppedTurnText({
		assistantText: "answer",
		finalReport: "",
		notice: null,
	}),
	"answer",
);

console.log("facet-turn-stop OK");

// An early stop keeps its own reason; an empty loop answer also gets a report.
assert.equal(
	finalReportReason({ stopReason: "budget", assistantText: "partial" }),
	"budget",
);
assert.equal(
	finalReportReason({ stopReason: null, assistantText: "  \n" }),
	"your last response contained no written answer",
	"an empty final answer gets one tools-off report instead of failing the turn",
);
assert.equal(
	finalReportReason({ stopReason: null, assistantText: "done" }),
	null,
);
console.log("PASS: final report covers early stops and empty answers");

// A loop whose last step errored surfaces the provider text instead of asking
// for a final report; prose or a clean finish keeps the normal path.
assert.equal(
	emptyTurnModelError({
		assistantText: "",
		lastModelError: "Paid inference requires private native origin capture",
	}),
	"Paid inference requires private native origin capture",
);
assert.equal(
	emptyTurnModelError({ assistantText: "done", lastModelError: "boom" }),
	null,
	"prose wins over a stale step error",
);
assert.equal(
	emptyTurnModelError({ assistantText: "", lastModelError: null }),
	null,
	"a clean empty finish still gets the tools-off final report",
);
