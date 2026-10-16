import { describe, expect, it } from "vite-plus/test";
import {
	explicitOutputCreateKind,
	outputWriteApp,
	routeExplicitOutputCreate,
} from "./output-create-intent";
import type { KernelRouteDecision } from "./route-schema";
import { canonicalWriteToolName } from "./write-proposal";

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
