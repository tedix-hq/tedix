import { describe, expect, it } from "vite-plus/test";
import { explicitOutputCreateKind } from "./output-create-intent";

describe("explicitOutputCreateKind", () => {
	it.each([
		["Create a 3-slide deck about Blue Harbor Bakery", "presentation"],
		["Draft a short document about our refund policy.", "document"],
		[
			'Create a short OS document titled "Review" in the existing workspace 11111111-2222-4333-8444-555555555555.',
			"document",
		],
		["write a doc summarizing this thread", "document"],
		["Make me a new spreadsheet of supplier prices", "sheet"],
		[
			"Hey, could you please create a new deck: quarterly review",
			"presentation",
		],
	] as const)("%s → %s", (content, kind) => {
		expect(explicitOutputCreateKind(content)).toBe(kind);
	});

	it.each([
		"How do I create a deck?",
		"Create a Google Slides deck about the launch",
		"Create a Google document in the OS workspace",
		"Create a work item to review the deck",
		"Create a new slide about pricing",
		"Create a new sheet in the budget workbook",
		"Summarize the deck",
		"Create a plan for the offsite and then a deck",
		"",
	])("%s → null", (content) => {
		expect(explicitOutputCreateKind(content)).toBeNull();
	});

	it("reads only the request line, not appended terminal context", () => {
		expect(
			explicitOutputCreateKind(
				"Create a deck about Contoso\n\nLocal terminal context: cwd=/tmp, Google Drive mounted",
			),
		).toBe("presentation");
	});
});
