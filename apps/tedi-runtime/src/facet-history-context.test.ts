import assert from "node:assert/strict";
import {
	hydrateFacetHistory,
	type FacetHistoryInput,
	type FacetHistoryReport,
} from "./facet-history-context";
const input: FacetHistoryInput = {
	priorTurnCount: 0,
	sessionKey: "chat:test",
	runId: "run-history",
	text: "current question",
	userTs: 123,
};
const reports: FacetHistoryReport[] = [];
let reads = 0;
const read = async () => {
	reads++;
	return [
		{ role: "assistant", content: "PRIVATE_OLDER_ANSWER" },
		{ role: "user", content: "LATEST" },
	];
};
const rendered = "assistant: PRIVATE_OLDER_ANSWER\nuser: LATEST";
const result = await hydrateFacetHistory(input, read, 20, (report) =>
	reports.push(report),
);
assert.equal(
	result,
	`Prior turns in this conversation (context only):\n${rendered.slice(-20)}\n\n---\n\ncurrent question`,
);
assert.equal(reports[0]?.sourceCharacters, rendered.length);
assert.equal(reports[0]?.retainedCharacters, 20);
assert.equal(reports[0]?.droppedCharacters, rendered.length - 20);
assert.equal(reports[0]?.sourceMessages, 2);
assert.doesNotMatch(
	JSON.stringify(reports),
	/PRIVATE_OLDER_ANSWER|LATEST|current question/,
);
assert.equal(
	await hydrateFacetHistory(
		{ ...input, priorTurnCount: 1 },
		read,
		20,
		(report) => reports.push(report),
	),
	input.text,
);
assert.equal(
	reads,
	1,
	"later turns must use facet history without re-reading the harness",
);
assert.equal(reports.at(-1)?.status, "facet_history_owned");
assert.equal(
	reports.at(-1)?.sourceCharacters,
	null,
	"unread history is unknown, not empty",
);
assert.equal(
	await hydrateFacetHistory(
		input,
		async () => [],
		20,
		(report) => reports.push(report),
	),
	input.text,
);
assert.equal(reports.at(-1)?.status, "empty");
assert.equal(
	await hydrateFacetHistory(
		input,
		async () => {
			throw new Error("read failed");
		},
		20,
		(report) => reports.push(report),
	),
	input.text,
);
assert.equal(reports.at(-1)?.status, "read_failed");
assert.equal(
	await hydrateFacetHistory({ ...input, priorTurnCount: 1 }, read, 20, () => {
		throw new Error("telemetry failed");
	}),
	input.text,
);
console.log(
	"first facet history retains existing rendering/cap and reports content-free omissions OK",
);
