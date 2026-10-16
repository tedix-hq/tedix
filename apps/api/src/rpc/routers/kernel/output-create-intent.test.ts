import { describe, expect, it } from "vite-plus/test";
import {
	cardVerdictFollowUp,
	cardVerdictWriteDecision,
	explicitOutputCreateKind,
	explicitOutputEditKind,
	explicitOutputWriteDecision,
	outputWriteApp,
	routeExplicitOutputCreate,
} from "./output-create-intent";
import type { KernelRouteDecision } from "./route-schema";
import { canonicalWriteToolName } from "./write-proposal";

describe("card verdict follow-ups", () => {
	const sheet = "11111111-2222-4333-8444-555555555555";
	const shown = `### Your next card — #1 · Post idea\n**Draft:** Hello from Ada Example.\n*Verified through os.get_os_output, output \`${sheet}\`, revision 3.*`;

	it("resolves a bare verdict to the card the previous answer showed", () => {
		expect(cardVerdictFollowUp("mark it useful: great angle", shown)).toEqual({
			outputId: sheet,
			sheetTitle: null,
			card: "1",
			verdict: "useful",
			reason: "great angle",
		});
		const titled =
			"## Next card: #1 — Post idea\n\n**Sheet:** Social cards 2026-01-02 08:15  \n**Source:** [Example](https://example.com)\n\nNothing was changed.";
		expect(cardVerdictFollowUp("mark it useful", titled)).toMatchObject({
			outputId: null,
			sheetTitle: "Social cards 2026-01-02 08:15",
			card: "1",
		});
		expect(
			cardVerdictWriteDecision(
				cardVerdictFollowUp("mark it useful", titled),
				"tedix",
			)?.rationale,
		).toContain('titled "Social cards 2026-01-02 08:15"');
		expect(
			cardVerdictFollowUp("Mark that card not useful - wrong person", shown),
		).toMatchObject({ verdict: "not useful", reason: "wrong person" });
		expect(cardVerdictFollowUp("useful", shown)?.reason).toBe("");
	});

	it("leaves other requests and unclear references to the router", () => {
		expect(
			cardVerdictFollowUp("useful links for onboarding?", shown),
		).toBeNull();
		expect(
			cardVerdictFollowUp("mark it useful", "no sheet here #1"),
		).toBeNull();
		expect(
			cardVerdictFollowUp("mark it useful", `${shown}\nAlso card #2.`),
		).toBeNull();
		expect(cardVerdictFollowUp("mark it useful", null)).toBeNull();
	});

	it("routes to a range write on that sheet with the row in the rationale", () => {
		const decision = cardVerdictWriteDecision(
			cardVerdictFollowUp("mark it useful: great angle", shown),
			"tedix",
		);
		expect(decision).toMatchObject({
			routeKind: "propose_tool_write",
			targetTediId: null,
			toolIntent: { appSlug: "tedix", capability: "sheets.set_range" },
		});
		expect(decision?.rationale).toContain(sheet);
		expect(decision?.rationale).toContain("card #1");
		expect(cardVerdictWriteDecision(null, "tedix")).toBeNull();
	});
});

function answerRoute(
	overrides: Partial<KernelRouteDecision> = {},
): KernelRouteDecision {
	return {
		routeKind: "answer_in_home",
		answer: "Slide 1: Welcome. Slide 2: Menu. Slide 3: Hours.",
		rationale: "Outline the deck.",
		risk: "low",
		confidence: 0.7,
		effortClass: "single_read",
		targetTediId: null,
		targetTediLabel: null,
		targetActivityId: null,
		plannedToolIds: [],
		toolIntent: null,
		workflowHint: null,
		clarifyingQuestion: null,
		evidenceExpectation: null,
		...overrides,
	};
}

describe("explicitOutputCreateKind", () => {
	it.each([
		["Create a 3-slide deck about Blue Harbor Bakery", "presentation"],
		["create a 3 slide deck about the spring menu", "presentation"],
		["Please make a slide deck on onboarding", "presentation"],
		["Can you build a presentation for the Northwind kickoff?", "presentation"],
		["Draft a short document about our refund policy.", "document"],
		["write a doc summarizing this thread", "document"],
		["Make me a new spreadsheet of supplier prices", "sheet"],
		["Generate a sheet with five columns", "sheet"],
		[
			"Hey, could you please create a new deck: quarterly review",
			"presentation",
		],
	] as const)("%s → %s", (content, kind) => {
		expect(explicitOutputCreateKind(content)).toBe(kind);
	});

	it.each([
		"How do I create a deck?",
		"What makes a good presentation?",
		"Create a Google Slides deck about the launch",
		"Make a Notion doc for the team",
		"Create a work item to review the deck",
		"Make the deck shorter",
		"Create a new slide about pricing",
		"Add a sheet to the budget",
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

describe("outputWriteApp", () => {
	it("prefers the Code Mode gateway that also installs catalog apps", () => {
		expect(
			outputWriteApp([
				{ slug: "globex-mail" },
				{ slug: "acme-tools", codeMode: true },
				{
					slug: "acme-unified",
					codeMode: true,
					capabilities: ["catalog.install"],
				},
			]),
		).toBe("acme-unified");
		expect(outputWriteApp([{ slug: "acme-tools", codeMode: true }])).toBe(
			"acme-tools",
		);
	});

	it("returns null without a Code Mode gateway", () => {
		expect(outputWriteApp([{ slug: "globex-mail" }])).toBeNull();
	});
});

describe("routeExplicitOutputCreate", () => {
	it("turns a prose outline into a write the canonical primitive serves", () => {
		const route = routeExplicitOutputCreate(
			answerRoute(),
			"presentation",
			"acme-unified",
		);
		expect(route).toMatchObject({
			routeKind: "propose_tool_write",
			answer: null,
			risk: "medium",
			toolIntent: {
				appSlug: "acme-unified",
				capability: "presentations.create",
			},
		});
		expect(
			canonicalWriteToolName(
				route.toolIntent?.capability,
				"Create a 3-slide deck about Blue Harbor Bakery",
			),
		).toBe("os.create_os_output");
	});

	it.each([
		["document", "documents.create"],
		["sheet", "sheets.create"],
	] as const)("maps %s to %s", (kind, capability) => {
		expect(
			routeExplicitOutputCreate(answerRoute(), kind, "acme-unified").toolIntent
				?.capability,
		).toBe(capability);
	});

	it("leaves other routes and missing inputs alone", () => {
		const write = answerRoute({
			routeKind: "propose_tool_write",
			answer: null,
			toolIntent: {
				appSlug: "acme-unified",
				capability: "outputs.create",
				connectionStatus: "connected",
			},
		});
		expect(
			routeExplicitOutputCreate(write, "presentation", "acme-unified"),
		).toBe(write);
		const ask = answerRoute({ routeKind: "ask_human" });
		expect(routeExplicitOutputCreate(ask, "presentation", "acme-unified")).toBe(
			ask,
		);
		const answer = answerRoute();
		expect(routeExplicitOutputCreate(answer, null, "acme-unified")).toBe(
			answer,
		);
		expect(routeExplicitOutputCreate(answer, "presentation", null)).toBe(
			answer,
		);
	});
});

const EDIT_ID = "00000000-1111-4111-8111-000000000001";
describe("explicitOutputEditKind", () => {
	it.each([
		[
			`Append a paragraph saying hello to document ${EDIT_ID}`,
			"document",
			"os.patch_os_document",
		],
		[
			`Update cell B2 to 15 in sheet ${EDIT_ID}`,
			"sheet",
			"os.set_os_sheet_range",
		],
		[
			`Change the first slide title in presentation ${EDIT_ID}`,
			"presentation",
			"os.patch_os_slides",
		],
	] as const)(
		"%s keeps the canonical edit primitive",
		(content, kind, tool) => {
			expect(explicitOutputEditKind(content)).toBe(kind);
			const decision = explicitOutputWriteDecision(
				kind,
				"acme-unified",
				"edit",
			);
			expect(decision?.routeKind).toBe("propose_tool_write");
			expect(
				canonicalWriteToolName(decision?.toolIntent?.capability, content),
			).toBe(tool);
		},
	);
	it.each([
		"How do I update cell B2?",
		"Update cell B2 in the budget sheet",
		`Update cell B2 in Google sheet ${EDIT_ID}`,
		`Change first slide title in PowerPoint presentation ${EDIT_ID}`,
		`Summarize document ${EDIT_ID}`,
		`Delete presentation ${EDIT_ID}`,
		`Update the permissions of document ${EDIT_ID}`,
		"Append a paragraph to a work item",
	])("%s needs model routing", (content) => {
		expect(explicitOutputEditKind(content)).toBeNull();
	});
	it("does not redirect an external presentation patch into Tedix", () => {
		expect(
			canonicalWriteToolName(
				"presentations.patch",
				"Update PowerPoint presentation",
			),
		).toBeNull();
	});
});
