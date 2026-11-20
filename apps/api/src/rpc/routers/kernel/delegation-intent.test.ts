import { describe, expect, it } from "vite-plus/test";
import {
	guardKernelRouteDecision,
	hasExplicitDelegationIntent,
} from "./delegation-intent";
import type { KernelRouteDecision } from "./route-schema";

function decision(
	overrides: Partial<KernelRouteDecision> = {},
): KernelRouteDecision {
	return {
		routeKind: "delegate_tedi",
		rationale: "CEO owns work items",
		risk: "low",
		confidence: 0.8,
		effortClass: "single_read",
		answer: null,
		targetTediId: "tedi-ceo",
		targetTediLabel: "CEO",
		targetActivityId: null,
		plannedToolIds: [],
		toolIntent: null,
		workflowHint: null,
		clarifyingQuestion: null,
		evidenceExpectation: null,
		...overrides,
	};
}

describe("hasExplicitDelegationIntent", () => {
	it.each([
		"delegate this to the CTO",
		"Please assign the roadmap review to the CFO",
		"let the CMO handle the launch copy",
		"create a task for the CTO to rotate the keys",
		"open a work item to track the migration",
		"start a job to reindex the catalog",
		"hand off the invoice reconciliation to finance",
		"Delega esto al CTO",
		"asigna la revisión al CFO",
		"que el CTO se encargue de la migración",
		"crea una tarea para el CTO",
		"lanza el trabajo de reindexado",
	])("matches an explicit ask: %s", (content) => {
		expect(hasExplicitDelegationIntent(content)).toBe(true);
	});

	it.each([
		"List my 3 most recently updated work items as a markdown table with title, status, and updated date.",
		"which tedis do we have?",
		"muéstrame los elementos de trabajo abiertos",
		'Create a short OS document titled "Review". Draft a five-step checklist for reviewing an internal handoff. Return the OS output link.',
		"Summarize the handoff checklist",
		"Do not use tools, delegate, create work or outputs, or change any data.",
		"Reply directly without delegation.",
		"Never hand this off to another tedi.",
		"No delegation; answer inline.",
		"",
	])("does NOT match a read: %s", (content) => {
		expect(hasExplicitDelegationIntent(content)).toBe(false);
	});
});

describe("guardKernelRouteDecision", () => {
	it("only stamps intent on non-delegation routes", () => {
		const guarded = guardKernelRouteDecision(
			"assign this to the CTO",
			decision({ routeKind: "ask_human", clarifyingQuestion: "Which?" }),
		);
		expect(guarded.routeKind).toBe("ask_human");
		expect(guarded.explicitDelegationIntent).toBe(true);
	});
});

describe("undispatched delegation promises", () => {
	const request =
		"Ask the Research tedi to read https://os.example.com/outputs/11111111-1111-4111-8111-111111111111 and answer its questions (read-only).";
	const promise =
		"I'll ask Research to read the document and answer the questions.";
	it("drops the promise when the operator did not ask for a handoff", () => {
		const result = guardKernelRouteDecision(
			"What does the evaluation research say?",
			decision({ routeKind: "answer_in_home", answer: promise }),
		);
		expect(result.routeKind).toBe("answer_in_home");
		expect(result.answer).toBeNull();
	});
	it.each([
		"ask the Research tedi to read the output",
		"tell CFO to review it",
	])("treats an ask-to-read as explicit delegation: %s", (content) => {
		expect(hasExplicitDelegationIntent(content)).toBe(true);
	});
	it.each(["let me read the output first", "how do I get the sync to run?"])(
		"keeps ordinary phrasing as no delegation: %s",
		(content) => {
			expect(hasExplicitDelegationIntent(content)).toBe(false);
		},
	);
});
