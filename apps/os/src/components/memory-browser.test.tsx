import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { AgentLessonEntry } from "@tedix/api-contract/schemas/agent-session-lessons";
import { MemoryRuleDetails } from "./memory-browser";

const lesson: AgentLessonEntry = {
	id: "fixture-rule",
	text: "Keep status updates concise.",
	addedAt: null,
	learnedFrom: { replies: 2, lastReplyAt: null, fromCaller: true },
	evidence: {
		version: 1,
		state: "live",
		supportCount: 2,
		sources: [
			{
				id: "correction-1",
				kind: "correction",
				quote: "Keep status updates concise.",
			},
			{
				id: "decision-2",
				kind: "decision",
				quote: "Include evidence when it matters.",
			},
		],
	},
};

describe("Memory rule evidence", () => {
	it("shows identical rule text once and keeps every source in a closed disclosure", () => {
		const html = renderToStaticMarkup(<MemoryRuleDetails lesson={lesson} />);
		const root = document.createElement("div");
		root.innerHTML = html;
		expect(
			root.textContent?.match(/Keep status updates concise\./g),
		).toHaveLength(1);
		expect(root.querySelector("[aria-expanded=false]")?.textContent).toContain(
			"Evidence",
		);
		// Expandable content stays mounted for source inspection and copying.
		expect(root.textContent).toContain("correction-1");
		expect(root.textContent).toContain("decision-2");
		expect(root.textContent).toContain("Include evidence when it matters.");
	});
	it("only deduplicates whitespace differences, retaining distinct wording", () => {
		const html = renderToStaticMarkup(
			<MemoryRuleDetails
				lesson={{
					...lesson,
					evidence: {
						...lesson.evidence!,
						sources: [
							{
								id: "same",
								kind: "correction",
								quote: " Keep status\nupdates concise. ",
							},
							{
								id: "different",
								kind: "decision",
								quote: "Keep status updates Concise.",
							},
						],
					},
				}}
			/>,
		);
		expect(html).not.toContain("Keep status\nupdates concise.");
		expect(html).toContain("Keep status updates Concise.");
	});
	it("explains missing sources and decision history", () => {
		const html = renderToStaticMarkup(
			<MemoryRuleDetails
				lesson={{ ...lesson, evidence: null, learnedFrom: null }}
			/>,
		);
		expect(html).toContain("No source quotes recorded.");
		expect(html).toContain("No decision history recorded.");
	});
});
