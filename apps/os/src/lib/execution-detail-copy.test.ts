import { describe, expect, it } from "vite-plus/test";
import {
	delegatedResult,
	traceGapSentence,
	traceSummary,
} from "./execution-detail-copy";

const CHILD = "e142d015-799c-465b-a564-d3795e8e9f75:mcp:cfo-memory-check";
const name = (childRunId: string) => (childRunId === CHILD ? "CFO" : "Other");

describe("trace gap sentences", () => {
	it.each([
		["parent_not_terminal", "Still running."],
		[`child_not_terminal:${CHILD}`, "CFO's delegated run hasn't finished."],
		[
			"request_acceptance_unverified",
			"Result not yet checked against the request.",
		],
		[`wake_pending:${CHILD}`, "Waiting for Home to pick up CFO's result."],
		[
			`child_evidence_missing:${CHILD}`,
			"CFO's activity record is not available.",
		],
		["final_synthesis_missing", "Home hasn't written its final answer yet."],
		[
			`convergence_health:terminal_child_without_wake:${CHILD}`,
			"CFO finished, but Home was not notified.",
		],
		[
			"convergence_health:repeated_synthesis_failures",
			"Home failed several times to write the final answer.",
		],
		["something_new", "Some activity details are incomplete."],
	])("%s → %s", (gap, sentence) => {
		expect(traceGapSentence(gap, name)).toBe(sentence);
	});

	it("never prints a branch id", () => {
		for (const code of [
			"child_not_terminal",
			"child_evidence_truncated",
			"wake_pending",
		])
			expect(traceGapSentence(`${code}:${CHILD}`, name)).not.toContain(
				"e142d015",
			);
	});
});

describe("trace summary", () => {
	const trace = {
		complete: false,
		gaps: [
			"parent_not_terminal",
			`child_not_terminal:${CHILD}`,
			"request_acceptance_unverified",
		],
		branches: [],
		parentEventIds: ["a", "b"],
	};

	it("reads as in progress, not a warning, while the run is running", () => {
		expect(traceSummary(trace, "running", name)).toEqual({
			tone: "pending",
			title: "In progress",
			notes: [
				"CFO's delegated run hasn't finished.",
				"Result not yet checked against the request.",
			],
		});
	});

	it("warns about missing details once the run has finished", () => {
		const summary = traceSummary(
			{ ...trace, gaps: [`child_evidence_missing:${CHILD}`] },
			"completed",
			name,
		);
		expect(summary.tone).toBe("warning");
		expect(summary.notes).toEqual(["CFO's activity record is not available."]);
	});

	it("reports a complete trace with plain counts", () => {
		expect(
			traceSummary({ ...trace, complete: true, gaps: [] }, "completed", name),
		).toEqual({
			tone: "complete",
			title: "Activity fully recorded",
			notes: ["2 steps recorded."],
		});
	});
});

describe("delegated result", () => {
	const toolListing = JSON.stringify([
		{ callable: "memory.search_memory_graph", annotations: {} },
	]);
	const truncated = `Raw result: \`\`\`json\n${JSON.stringify({
		__tedix_truncated: true,
		originalChars: 8211,
		originalType: "array",
		preview: toolListing.slice(0, 30),
	})}\n\`\`\``;

	it("shows a working state, not intermediate output, while running", () => {
		expect(delegatedResult("running", truncated, "CFO")).toEqual({
			kind: "working",
			message: "Still working…",
		});
		expect(delegatedResult("requires_approval", null, "CFO").kind).toBe(
			"working",
		);
	});

	it("renders a prose answer as Markdown", () => {
		expect(delegatedResult("completed", "**Cash** is €12k.", "CFO")).toEqual({
			kind: "text",
			markdown: "**Cash** is €12k.",
		});
	});

	it("unwraps a truncated JSON envelope into an unescaped raw view", () => {
		const result = delegatedResult("completed", truncated, "CFO");
		expect(result).toMatchObject({
			kind: "structured",
			truncatedChars: 8211,
			raw: toolListing.slice(0, 30),
		});
		if (result.kind !== "structured") throw new Error("expected structured");
		expect(result.message).toBe(
			"CFO returned a large data result instead of a written answer.",
		);
		expect(result.raw).not.toContain('\\"');
	});

	it("pretty-prints complete structured output", () => {
		const result = delegatedResult(
			"completed",
			`Raw result: \`\`\`json\n${toolListing}\n\`\`\``,
			"CFO",
		);
		expect(result).toMatchObject({
			kind: "structured",
			raw: JSON.stringify(JSON.parse(toolListing), null, 2),
			truncatedChars: null,
		});
	});

	it("prefers an answer field inside structured output", () => {
		expect(
			delegatedResult(
				"completed",
				`Raw result: \`\`\`json\n{"answer":"Revenue is up 4%.","sources":[]}\n\`\`\``,
				"CFO",
			),
		).toEqual({ kind: "text", markdown: "Revenue is up 4%." });
	});

	it("explains an empty or failed result", () => {
		expect(delegatedResult("completed", " ", "CFO")).toEqual({
			kind: "empty",
			message: "CFO didn't return a written answer.",
		});
		expect(delegatedResult("failed", null, "CFO")).toEqual({
			kind: "empty",
			message: "CFO stopped without a result.",
		});
	});
});
