import { describe, expect, it } from "vite-plus/test";
import {
	guardKernelRouteDecision,
	hasExplicitDelegationIntent,
	mentionsTedixInternalState,
	requiresLiveConnectionState,
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
		"have the CTO do a security review",
		"let the CMO handle the launch copy",
		"create a task for the CTO to rotate the keys",
		"open a work item to track the migration",
		"kick off the weekly report",
		"start a job to reindex the catalog",
		"run this as a background job",
		"hand off the invoice reconciliation to finance",
		"Delega esto al CTO",
		"asigna la revisión al CFO",
		"encarga al CMO la campaña",
		"que el CTO se encargue de la migración",
		"crea una tarea para el CTO",
		"abre un elemento de trabajo para el cierre",
		"lanza el trabajo de reindexado",
		"ejecuta esto como un trabajo",
	])("matches an explicit ask: %s", (content) => {
		expect(hasExplicitDelegationIntent(content)).toBe(true);
	});

	it.each([
		"List my 3 most recently updated work items as a markdown table with title, status, and updated date.",
		"what work items are open?",
		"show me the work orders from last week",
		"which tedis do we have?",
		"summarize the active objectives",
		"how many skills does the CTO have",
		"muéstrame los elementos de trabajo abiertos",
		"cuáles son los objetivos activos",
		"what changed today?",
		"Do not use tools, delegate, create work or outputs, or change any data.",
		"Reply directly without delegation.",
		"Never hand this off to another tedi.",
		"No delegation; answer inline.",
		"Never hand this off to another tedi.",
		"",
	])("does NOT match a read: %s", (content) => {
		expect(hasExplicitDelegationIntent(content)).toBe(false);
	});
});

describe("mentionsTedixInternalState", () => {
	it("recognises the assembled-context nouns in English and Spanish", () => {
		expect(mentionsTedixInternalState("list my work items")).toBe(true);
		expect(mentionsTedixInternalState("which workflows exist")).toBe(true);
		expect(mentionsTedixInternalState("cuántas habilidades tiene")).toBe(true);
		expect(mentionsTedixInternalState("give me recent commits")).toBe(false);
		expect(mentionsTedixInternalState("check my email")).toBe(false);
	});
});

describe("requiresLiveConnectionState", () => {
	it.each([
		"what MCP apps are connected in my gateway?",
		"show offline applications",
		"check connection status",
	])("recognises live connection reads: %s", (content) => {
		expect(requiresLiveConnectionState(content)).toBe(true);
	});

	it("does not classify an ordinary catalog read as live connection state", () => {
		expect(requiresLiveConnectionState("which apps are available?")).toBe(
			false,
		);
	});
});

describe("guardKernelRouteDecision", () => {
	it("downgrades a low-risk single-read delegate_tedi over internal state to answer_in_home, preserving answer", () => {
		const guarded = guardKernelRouteDecision(
			"List my 3 most recently updated work items as a markdown table",
			decision({ answer: "| title | status |" }),
		);
		expect(guarded.routeKind).toBe("answer_in_home");
		expect(guarded.answer).toBe("| title | status |");
		expect(guarded.explicitDelegationIntent).toBe(false);
		expect(guarded.targetTediId).toBeNull();
		expect(guarded.targetTediLabel).toBeNull();
		expect(guarded.plannedToolIds).toEqual([]);
		expect(guarded.rationale).toContain("kernel guard");
	});

	it("treats a null effort class like single_read", () => {
		const guarded = guardKernelRouteDecision(
			"which tedis do we have?",
			decision({ effortClass: null }),
		);
		expect(guarded.routeKind).toBe("answer_in_home");
	});

	it("clears a delegation promise when the guard cancels dispatch", () => {
		const guarded = guardKernelRouteDecision(
			"list my work items",
			decision({ answer: "I’ll have the CEO check your work items." }),
		);
		expect(guarded.routeKind).toBe("answer_in_home");
		expect(guarded.answer).toBeNull();
	});

	it("keeps delegate_tedi when the operator explicitly asked for delegation", () => {
		const guarded = guardKernelRouteDecision(
			"delegate the work item review to the CTO",
			decision(),
		);
		expect(guarded.routeKind).toBe("delegate_tedi");
		expect(guarded.explicitDelegationIntent).toBe(true);
		expect(guarded.targetTediId).toBe("tedi-ceo");
	});

	it("keeps delegate_tedi for a live provider read (no internal-state noun)", () => {
		const guarded = guardKernelRouteDecision(
			"give me the last 5 github commits from cto",
			decision({ targetTediId: "tedi-cto" }),
		);
		expect(guarded.routeKind).toBe("delegate_tedi");
		expect(guarded.explicitDelegationIntent).toBe(false);
	});

	it("keeps delegation for a live gateway connection read", () => {
		const guarded = guardKernelRouteDecision(
			"what mcp apps are connected in my gateway?",
			decision({
				answer:
					"I’ll have the CTO check the gateway’s live MCP connection status.",
				targetTediId: "tedi-cto",
				targetTediLabel: "CTO",
			}),
		);
		expect(guarded.routeKind).toBe("delegate_tedi");
		expect(guarded.targetTediId).toBe("tedi-cto");
	});

	it("keeps delegate_tedi when the planner selected provider tools", () => {
		const guarded = guardKernelRouteDecision(
			"list my work items",
			decision({ plannedToolIds: ["github.list_commits"] }),
		);
		expect(guarded.routeKind).toBe("delegate_tedi");
	});

	it("keeps delegate_tedi for medium/high risk or multi-hop effort", () => {
		expect(
			guardKernelRouteDecision(
				"list my work items",
				decision({ risk: "medium" }),
			).routeKind,
		).toBe("delegate_tedi");
		expect(
			guardKernelRouteDecision(
				"list my work items",
				decision({ effortClass: "multi_hop_read" }),
			).routeKind,
		).toBe("delegate_tedi");
	});

	it("only stamps intent on non-delegation routes", () => {
		const guarded = guardKernelRouteDecision(
			"assign this to the CTO",
			decision({ routeKind: "ask_human", clarifyingQuestion: "Which?" }),
		);
		expect(guarded.routeKind).toBe("ask_human");
		expect(guarded.explicitDelegationIntent).toBe(true);
	});
});

describe("explicit response-only intent", () => {
	it.each([
		"Acknowledge only. Do not delegate or create work.",
		"Just acknowledge the request.",
		"Only acknowledge this.",
		"Reply directly without delegation.",
		"No delegation; answer inline.",
		"Never hand this off to another tedi.",
		"Do not use tools, delegate, create work or outputs, or change data.",
	])(
		"cancels model-selected delegation regardless of risk or tools: %s",
		(content) => {
			const result = guardKernelRouteDecision(
				content,
				decision({
					risk: "high",
					effortClass: "fan_out",
					plannedToolIds: ["github.write"],
					answer: "I will delegate to CTO.",
					targetActivityId: "activity",
				}),
			);
			expect(result).toMatchObject({
				routeKind: "answer_in_home",
				explicitDelegationIntent: false,
				targetTediId: null,
				targetTediLabel: null,
				targetActivityId: null,
				plannedToolIds: [],
				toolIntent: null,
				workflowHint: null,
				clarifyingQuestion: null,
				evidenceExpectation: null,
				risk: "high",
			});
			expect(result.answer).not.toContain("CTO");
		},
	);
	it.each([
		"delegate_tedi",
		"suggest_handoff",
		"propose_tool_write",
		"run_workflow",
		"ask_human",
		"answer_in_home",
	] as const)(
		"acknowledgment-only clears %s execution recommendations",
		(routeKind) => {
			const result = guardKernelRouteDecision(
				"Acknowledge only. Prepare a CTO work order, but no delegation.",
				decision({
					routeKind,
					toolIntent: {
						appSlug: "github",
						capability: "issues.create",
						connectionStatus: "connected",
					},
					workflowHint: "incident",
					clarifyingQuestion: "Approve?",
				}),
			);
			expect(result).toMatchObject({
				routeKind: "answer_in_home",
				answer: "Acknowledged.",
				toolIntent: null,
				workflowHint: null,
				clarifyingQuestion: null,
				explicitDelegationIntent: false,
			});
		},
	);
	it("preserves an explicit parked Work Order with a temporal delegation hold", () => {
		const result = guardKernelRouteDecision(
			"Prepare a CTO delegation work order. Do not delegate CTO yet; park for approval first.",
			decision(),
		);
		expect(result.routeKind).toBe("delegate_tedi");
	});
	it("does not mistake acknowledgment as an external provider action", () => {
		expect(
			guardKernelRouteDecision(
				"Acknowledge the incident in PagerDuty",
				decision(),
			).routeKind,
		).toBe("delegate_tedi");
	});
});

it.each([
	"Do not just acknowledge; delegate this to CTO.",
	"Do not just acknowledge, delegate this to CTO.",
	"Do not forget to delegate this to CTO.",
	"Do not only acknowledge; execute this as a job.",
	"Just acknowledge then delegate the review to CTO.",
	"Acknowledge then perform the requested delegation.",
])(
	"an acknowledgment preceding action does not cancel delegation: %s",
	(content) => {
		expect(guardKernelRouteDecision(content, decision()).routeKind).toBe(
			"delegate_tedi",
		);
	},
);

it.each([
	"A work item records an accepted outcome and its execution attempts.",
	"A work order describes the bounded task and required approval.",
])(
	"preserves a substantive direct explanation without delegation: %s",
	(answer) => {
		const result = guardKernelRouteDecision(
			"Explain what a work item is, without delegation.",
			decision({
				routeKind: "answer_in_home",
				answer,
				targetTediId: null,
				targetTediLabel: null,
				plannedToolIds: [],
			}),
		);
		expect(result.answer).toBe(answer);
		expect(result.explicitDelegationIntent).toBe(false);
	},
);
it.each(["I will delegate this to CTO.", "I’ll prepare a work order for CTO."])(
	"removes an actual first-person delegation promise: %s",
	(answer) => {
		expect(
			guardKernelRouteDecision(
				"Reply directly without delegation.",
				decision({ routeKind: "answer_in_home", answer }),
			).answer,
		).toBe("I’ll respond here without delegating.");
	},
);
