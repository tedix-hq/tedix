/**
 * Supplied-output cases for planner parsing, normalization and failure handling.
 * These fixtures do not measure a model's ability to choose the correct route.
 */

import type { KernelContext } from "../../src/rpc/routers/kernel/context-assembly";
import type { KernelRouteDecision } from "../../src/rpc/routers/kernel/route-schema";

// ---------------------------------------------------------------------------
// Shared context fixtures — mirrors the fake org state in kernel-runtime.test.ts
// ---------------------------------------------------------------------------

const BASE_TEDIS: KernelContext["tedis"] = [
	{ id: "tedi-cpo", slug: "cpo", name: "CPO", role: "product" },
	{ id: "tedi-echo", slug: "echo", name: "Echo", role: "communications" },
	{ id: "tedi-cto", slug: "cto", name: "CTO", role: "engineering" },
];

const BASE_APPS: KernelContext["apps"] = [
	{ slug: "gmail", name: "Gmail", capabilities: ["email.read", "email.send"] },
	{
		slug: "pagerduty",
		name: "PagerDuty",
		capabilities: ["incidents.read", "incidents.acknowledge"],
	},
	{
		slug: "market-data",
		name: "Market Data",
		capabilities: ["prices.read", "filings.read", "news.read"],
	},
	{
		slug: "globex",
		name: "Globex",
		capabilities: ["invoices.list", "invoices.create"],
	},
	{
		slug: "github",
		name: "GitHub",
		capabilities: ["repos.list", "issues.list"],
	},
];

const BASE_WORKFLOWS: KernelContext["workflows"] = [
	{ slug: "customer-onboarding", title: "Customer onboarding" },
	{ slug: "incident-commander", title: "Incident commander" },
	{ slug: "equity-research", title: "Equity research" },
];

const BASE_WORK_ITEMS: KernelContext["workItems"] = [
	{ id: "wi-1", title: "Validate Q2 launch criteria", status: "in_progress" },
	{ id: "wi-2", title: "Review customer support backlog", status: "accepted" },
];

const BASE_FACTS: KernelContext["facts"] = [
	{
		text: "The organization is running an EU-focused SaaS product.",
		confidence: 0.95,
	},
	{
		text: "CPO is responsible for product roadmap decisions.",
		confidence: 0.9,
	},
];

const EMPTY_CONTEXT: KernelContext = {
	tedis: [],
	apps: [],
	workflows: [],
	workItems: [],
	facts: [],
	rationale: [],
	speaker: null,
	history: [],
};

const FULL_CONTEXT: KernelContext = {
	tedis: BASE_TEDIS,
	apps: BASE_APPS,
	workflows: BASE_WORKFLOWS,
	workItems: BASE_WORK_ITEMS,
	facts: BASE_FACTS,
	rationale: [
		{
			action: "Delegated Q1 roadmap review to CPO",
			category: "delegation",
			outcome: "completed",
		},
	],
	speaker: {
		role: "owner",
		email: "owner@example.com",
		approvalAuthority: true,
	},
	history: [],
};

// ---------------------------------------------------------------------------
// Fixture shape
// ---------------------------------------------------------------------------

export interface RouteContractFixture {
	name: string;
	userText: string;
	context: KernelContext;
	/** Full decision the stub model emits — must be KernelRouteDecision-valid. */
	modelOutput: KernelRouteDecision | null;
	modelFailure?: "absent" | "throws";
	/** Fields on the RESULT that must match (subset of result). */
	expected: {
		routeKind?: KernelRouteDecision["routeKind"];
		risk?: KernelRouteDecision["risk"];
		effortClass?: KernelRouteDecision["effortClass"] | null;
		toolIntent?: Partial<NonNullable<KernelRouteDecision["toolIntent"]>> | null;
		targetTediId?: string | null;
		workflowHint?: string | null;
		clarifyingQuestion?: string | null;
		/** True: result must be null (fail-soft fixtures). */
		isNull?: true;
		/** routerVersion must be a 12-char hex string. */
		hasRouterVersion?: true;
	};
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export const ROUTE_CONTRACT_FIXTURES: RouteContractFixture[] = [
	// ─── (a) answer_in_home ────────────────────────────────────────────────
	{
		name: "a1-greeting-answered-in-home",
		userText: "What's the current product focus for the org?",
		context: FULL_CONTEXT,
		modelOutput: {
			routeKind: "answer_in_home",
			rationale:
				"The assembled facts state CPO owns product roadmap decisions and Q2 launch criteria is in-progress. Can answer from context.",
			risk: "low",
			confidence: 0.92,
			effortClass: "single_read",
			answer:
				"The org's current focus is the Q2 launch criteria validation, owned by CPO. No new product-direction change is recorded in the top facts.",
			targetTediId: null,
			targetTediLabel: null,
			toolIntent: null,
			workflowHint: null,
			clarifyingQuestion: null,
			evidenceExpectation: null,
		},
		expected: {
			routeKind: "answer_in_home",
			risk: "low",
			effortClass: "single_read",
			hasRouterVersion: true,
		},
	},
	{
		name: "a2-status-question-empty-context",
		userText: "What are you for and what should I do next from here?",
		context: EMPTY_CONTEXT,
		modelOutput: {
			routeKind: "answer_in_home",
			rationale:
				"General meta-question about Home's purpose; can answer from kernel knowledge.",
			risk: "low",
			confidence: 0.98,
			effortClass: "single_read",
			answer:
				"Home is the shared operating thread for the tenant — capture intent, route work to tedis, and review evidence without switching contexts.",
			targetTediId: null,
			targetTediLabel: null,
			toolIntent: null,
			workflowHint: null,
			clarifyingQuestion: null,
			evidenceExpectation: null,
		},
		expected: {
			routeKind: "answer_in_home",
			risk: "low",
			effortClass: "single_read",
			hasRouterVersion: true,
		},
	},
	{
		name: "a3-conversation-history-reference",
		userText: "What was the codename again?",
		context: {
			...EMPTY_CONTEXT,
			history: [
				{
					role: "user",
					content: "Remember the project codename is NIGHTHAWK-3.",
				},
				{
					role: "assistant",
					content: "Noted — codename NIGHTHAWK-3 recorded.",
				},
			],
		},
		modelOutput: {
			routeKind: "answer_in_home",
			rationale:
				"The conversation history contains the codename NIGHTHAWK-3 from a prior turn; pronoun resolved.",
			risk: "low",
			confidence: 0.97,
			effortClass: "single_read",
			answer: "The codename is NIGHTHAWK-3.",
			targetTediId: null,
			targetTediLabel: null,
			toolIntent: null,
			workflowHint: null,
			clarifyingQuestion: null,
			evidenceExpectation: null,
		},
		expected: {
			routeKind: "answer_in_home",
			risk: "low",
			effortClass: "single_read",
			hasRouterVersion: true,
		},
	},

	// ─── (b) delegate_tedi ─────────────────────────────────────────────────
	{
		name: "b1-delegate-to-cpo-product-decision",
		userText:
			"Ask the CPO to review the Q2 launch checklist and get it done by Friday.",
		context: FULL_CONTEXT,
		modelOutput: {
			routeKind: "delegate_tedi",
			rationale:
				"CPO is the org's product owner (fact: CPO owns roadmap). Q2 launch criteria is an active work item. Bounded task the kernel can track.",
			risk: "medium",
			confidence: 0.88,
			effortClass: "single_read",
			answer: null,
			targetTediId: "tedi-cpo",
			targetTediLabel: "CPO",
			toolIntent: null,
			workflowHint: null,
			clarifyingQuestion: null,
			evidenceExpectation: "CPO confirms launch checklist reviewed.",
		},
		expected: {
			routeKind: "delegate_tedi",
			risk: "medium",
			targetTediId: "tedi-cpo",
			hasRouterVersion: true,
		},
	},
	{
		name: "b2-delegate-to-cto-technical-analysis",
		userText:
			"Have the CTO analyse the GitHub repo structure and summarise it.",
		context: FULL_CONTEXT,
		modelOutput: {
			routeKind: "delegate_tedi",
			rationale:
				"CTO tedi owns technical domain; GitHub app is present. Bounded analysis task.",
			risk: "medium",
			confidence: 0.85,
			effortClass: "multi_hop_read",
			answer: null,
			targetTediId: "tedi-cto",
			targetTediLabel: "CTO",
			toolIntent: null,
			workflowHint: null,
			clarifyingQuestion: null,
			evidenceExpectation: "CTO returns repo structure summary.",
		},
		expected: {
			routeKind: "delegate_tedi",
			targetTediId: "tedi-cto",
			effortClass: "multi_hop_read",
			hasRouterVersion: true,
		},
	},

	// ─── (c) delegated provider reads ───────────────────────────────────────
	{
		name: "c1-read-gmail-inbox",
		userText: "Show me my unread emails from the last 24 hours.",
		context: FULL_CONTEXT,
		modelOutput: {
			routeKind: "delegate_tedi",
			rationale:
				"CTO owns the accountable provider-read execution for this fixture.",
			risk: "low",
			confidence: 0.9,
			effortClass: "single_read",
			answer: null,
			targetTediId: "tedi-cto",
			targetTediLabel: "CTO",
			toolIntent: null,
			workflowHint: null,
			clarifyingQuestion: null,
			evidenceExpectation: "List of unread Gmail messages from last 24 hours.",
		},
		expected: {
			routeKind: "delegate_tedi",
			risk: "low",
			effortClass: "single_read",
			targetTediId: "tedi-cto",
			hasRouterVersion: true,
		},
	},
	{
		name: "c2-read-invoices-from-globex",
		userText: "List all open invoices in Globex.",
		context: FULL_CONTEXT,
		modelOutput: {
			routeKind: "delegate_tedi",
			rationale:
				"CPO owns the accountable invoice-read execution for this fixture.",
			risk: "low",
			confidence: 0.93,
			effortClass: "single_read",
			answer: null,
			targetTediId: "tedi-cpo",
			targetTediLabel: "CPO",
			toolIntent: null,
			workflowHint: null,
			clarifyingQuestion: null,
			evidenceExpectation: "Globex open invoice list.",
		},
		expected: {
			routeKind: "delegate_tedi",
			risk: "low",
			targetTediId: "tedi-cpo",
			hasRouterVersion: true,
		},
	},

	// ─── (d) propose_tool_write ─────────────────────────────────────────────
	{
		name: "d1-write-send-email-via-gmail",
		userText: "Send an email to the board summarising our Q2 progress.",
		context: FULL_CONTEXT,
		modelOutput: {
			routeKind: "propose_tool_write",
			rationale:
				"Gmail app is present. Operator wants to SEND (write), not read. Must be a proposal — not direct execution.",
			risk: "medium",
			confidence: 0.87,
			effortClass: "single_read",
			answer: null,
			targetTediId: null,
			targetTediLabel: null,
			toolIntent: {
				appSlug: "gmail",
				capability: "email.send",
				connectionStatus: "unknown",
			},
			workflowHint: null,
			clarifyingQuestion: null,
			evidenceExpectation:
				"Draft email to board surfaced for operator approval before send.",
		},
		expected: {
			routeKind: "propose_tool_write",
			risk: "medium",
			toolIntent: { appSlug: "gmail", capability: "email.send" },
			hasRouterVersion: true,
		},
	},
	{
		name: "d2-write-create-invoice-globex",
		userText: "Create a new invoice for Acme Corp in Globex for €4500.",
		context: FULL_CONTEXT,
		modelOutput: {
			routeKind: "propose_tool_write",
			rationale:
				"Globex app present with invoices.create capability. Creating an invoice is a write — must be proposed, not executed.",
			risk: "high",
			confidence: 0.91,
			effortClass: "single_read",
			answer: null,
			targetTediId: null,
			targetTediLabel: null,
			toolIntent: {
				appSlug: "globex",
				capability: "invoices.create",
				connectionStatus: "unknown",
			},
			workflowHint: null,
			clarifyingQuestion: null,
			evidenceExpectation:
				"Invoice creation proposal surfaced for operator approval.",
		},
		expected: {
			routeKind: "propose_tool_write",
			risk: "high",
			toolIntent: { appSlug: "globex", capability: "invoices.create" },
			hasRouterVersion: true,
		},
	},

	// ─── (e) ask_human (ambiguous authority) ────────────────────────────────
	{
		name: "e1-ambiguous-tedi-authority",
		userText: "Delegate this to the right person.",
		context: FULL_CONTEXT,
		modelOutput: {
			routeKind: "ask_human",
			rationale:
				"Request is underspecified — 'this' is undefined and there is no active context to resolve it from. Cannot route confidently.",
			risk: "low",
			confidence: 0.35,
			effortClass: null,
			answer: null,
			targetTediId: null,
			targetTediLabel: null,
			toolIntent: null,
			workflowHint: null,
			clarifyingQuestion:
				"What specific task should I delegate, and to which tedi — CPO, Echo, or CTO?",
			evidenceExpectation: null,
		},
		expected: {
			routeKind: "ask_human",
			risk: "low",
			effortClass: null,
			hasRouterVersion: true,
		},
	},
	{
		name: "e2-no-apps-ambiguous-tool-request",
		userText: "Pull the latest data from our CRM.",
		context: {
			...EMPTY_CONTEXT,
			tedis: BASE_TEDIS,
		},
		modelOutput: {
			routeKind: "ask_human",
			rationale:
				"No accountable CRM tedi is available, so ask for clarification.",
			risk: "low",
			confidence: 0.4,
			effortClass: null,
			answer: null,
			targetTediId: null,
			targetTediLabel: null,
			toolIntent: null,
			workflowHint: null,
			clarifyingQuestion:
				"Which CRM integration should I use? No CRM app is connected in the current context.",
			evidenceExpectation: null,
		},
		expected: {
			routeKind: "ask_human",
			effortClass: null,
			hasRouterVersion: true,
		},
	},

	// ─── (f) work-item-ish, fan_out ─────────────────────────────────────────
	{
		name: "f1-multi-tedi-work-item-assignment",
		userText:
			"Split the Q2 launch work: CPO owns the checklist review, Echo validates the evidence gaps.",
		context: FULL_CONTEXT,
		modelOutput: {
			routeKind: "delegate_tedi",
			rationale:
				"Two independent bounded tasks across CPO and Echo — fan_out effort class. CPO owns product checklist; Echo handles evidence validation.",
			risk: "medium",
			confidence: 0.82,
			effortClass: "fan_out",
			answer: null,
			targetTediId: "tedi-cpo",
			targetTediLabel: "CPO",
			toolIntent: null,
			workflowHint: null,
			clarifyingQuestion: null,
			evidenceExpectation: "Both CPO and Echo return task completions.",
		},
		expected: {
			routeKind: "delegate_tedi",
			effortClass: "fan_out",
			targetTediId: "tedi-cpo",
			hasRouterVersion: true,
		},
	},
	{
		name: "f2-capture-work-item-intent",
		userText: "Track a new task: review the customer support backlog by EOD.",
		context: FULL_CONTEXT,
		modelOutput: {
			routeKind: "answer_in_home",
			rationale:
				"Operator wants to capture a new work item. Can acknowledge in Home and record the intent.",
			risk: "low",
			confidence: 0.88,
			effortClass: "single_read",
			answer:
				"Captured: 'Review customer support backlog by EOD' added as an active work item in Home.",
			targetTediId: null,
			targetTediLabel: null,
			toolIntent: null,
			workflowHint: null,
			clarifyingQuestion: null,
			evidenceExpectation: null,
		},
		expected: {
			routeKind: "answer_in_home",
			risk: "low",
			effortClass: "single_read",
			hasRouterVersion: true,
		},
	},

	// ─── (g) suggest_handoff — open-ended session ───────────────────────────
	{
		name: "g1-suggest-handoff-long-coding-session",
		userText:
			"I want to pair with the CTO on refactoring the gateway code for the next few hours.",
		context: FULL_CONTEXT,
		modelOutput: {
			routeKind: "suggest_handoff",
			rationale:
				"Open-ended coding pairing session the operator should drive directly. Not a bounded delegatable task. CTO tedi is the right body.",
			risk: "medium",
			confidence: 0.78,
			effortClass: "embodied",
			answer:
				"This looks like a long pairing session — open a direct session with the CTO tedi.",
			targetTediId: "tedi-cto",
			targetTediLabel: "CTO",
			toolIntent: null,
			workflowHint: null,
			clarifyingQuestion: null,
			evidenceExpectation: null,
		},
		expected: {
			routeKind: "suggest_handoff",
			effortClass: "embodied",
			targetTediId: "tedi-cto",
			hasRouterVersion: true,
		},
	},

	// ─── (h) run_workflow ───────────────────────────────────────────────────
	{
		name: "h1-run-customer-onboarding-workflow",
		userText:
			"Onboard the new customer Acme Corp — run the full onboarding flow.",
		context: FULL_CONTEXT,
		modelOutput: {
			routeKind: "run_workflow",
			rationale:
				"The request matches the standard customer-onboarding workflow slug.",
			risk: "medium",
			confidence: 0.85,
			effortClass: "multi_hop_read",
			answer: null,
			targetTediId: null,
			targetTediLabel: null,
			toolIntent: null,
			workflowHint: "customer-onboarding",
			clarifyingQuestion: null,
			evidenceExpectation: "Onboarding workflow triggered for Acme Corp.",
		},
		expected: {
			routeKind: "run_workflow",
			workflowHint: "customer-onboarding",
			hasRouterVersion: true,
		},
	},
	{
		name: "h2-workflow-incident-commander-approval-gate",
		userText:
			"PagerDuty says checkout-api has a high 5xx rate. Run the incident commander workflow and prepare a rollback PR, but do not merge without approval.",
		context: FULL_CONTEXT,
		modelOutput: {
			routeKind: "run_workflow",
			rationale:
				"The request matches the listed incident-commander workflow. The rollback/merge action is high risk and must be parked behind approval.",
			risk: "high",
			confidence: 0.86,
			effortClass: "embodied",
			answer: null,
			targetTediId: null,
			targetTediLabel: null,
			toolIntent: null,
			workflowHint: "incident-commander",
			clarifyingQuestion: null,
			evidenceExpectation:
				"Incident workflow records alert evidence, proposes a rollback PR, and parks merge behind approval.",
		},
		expected: {
			routeKind: "run_workflow",
			workflowHint: "incident-commander",
			effortClass: "embodied",
			hasRouterVersion: true,
		},
	},
	{
		name: "h3-workflow-equity-research-read-only",
		userText:
			"Run the equity research workflow for our paper portfolio: review today's market data, update portfolio notes, and only log a recommendation after a separate risk check.",
		context: FULL_CONTEXT,
		modelOutput: {
			routeKind: "run_workflow",
			rationale:
				"The request matches the listed equity-research workflow. Market data is read-only; portfolio notes are owned Tedix artifacts and require a separate risk-check before completion.",
			risk: "medium",
			confidence: 0.84,
			effortClass: "multi_hop_read",
			answer: null,
			targetTediId: null,
			targetTediLabel: null,
			toolIntent: null,
			workflowHint: "equity-research",
			clarifyingQuestion: null,
			evidenceExpectation:
				"Research workflow records market-data evidence, updates owned notes, and emits a risk-check result.",
		},
		expected: {
			routeKind: "run_workflow",
			workflowHint: "equity-research",
			effortClass: "multi_hop_read",
			hasRouterVersion: true,
		},
	},

	// ─── (i) fail-soft: model null ──────────────────────────────────────────
	{
		name: "i1-fail-soft-model-null",
		userText: "check my gmail messages",
		context: EMPTY_CONTEXT,
		modelFailure: "absent",
		modelOutput: null,
		expected: {
			isNull: true,
		},
	},

	// ─── (j) fail-soft: model throws ────────────────────────────────────────
	{
		name: "j1-fail-soft-model-throws",
		userText: "do something complex",
		context: EMPTY_CONTEXT,
		modelFailure: "throws",
		modelOutput: null,
		expected: {
			isNull: true,
		},
	},
];

const ERRONEOUS_ACTION: KernelRouteDecision = {
	routeKind: "delegate_tedi",
	rationale: "Route the request to CTO",
	risk: "high",
	confidence: 1,
	effortClass: "fan_out",
	answer: "Delegating to CTO now.",
	targetTediId: "tedi-cto",
	targetTediLabel: "CTO",
	targetActivityId: null,
	plannedToolIds: ["github.write"],
	toolIntent: null,
	workflowHint: null,
	clarifyingQuestion: null,
	evidenceExpectation: null,
};
for (const [name, userText] of [
	[
		"acknowledgment-only-overrides-delegate",
		"Acknowledge only. Do not delegate or create work.",
	],
	["direct-response-overrides-delegate", "Reply directly without delegation."],
	["acknowledgment-only-overrides-workflow", "Only acknowledge this request."],
] as const) {
	ROUTE_CONTRACT_FIXTURES.push({
		name,
		userText,
		context: FULL_CONTEXT,
		modelOutput: {
			...ERRONEOUS_ACTION,
			...(name.endsWith("workflow")
				? {
						routeKind: "run_workflow" as const,
						workflowHint: "incident-commander",
					}
				: {}),
		},
		expected: {
			routeKind: "answer_in_home",
			targetTediId: null,
			toolIntent: null,
			workflowHint: null,
			hasRouterVersion: true,
		},
	});
}
