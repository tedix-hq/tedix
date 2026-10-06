import { describe, expect, it, vi } from "vite-plus/test";
import {
	coerceParkedApprovalDelegationRoute,
	finalizeKernelRouteDecision,
	runKernel,
	constrainUnavailableDelegation,
	renderDelegationResponse,
	renderRouteResponse,
} from "./index";
import type { KernelRouteDecision } from "./route-schema";
import type { KernelWriteProposalDeclined } from "./write-proposal";
import { renderWriteDeclined } from "./write-proposal";

/**
 * Pure-router contract: renderRouteResponse for a delegate_tedi route must
 * never promise kernel-side provider execution.
 */
describe("renderRouteResponse — pure-router delegation", () => {
	it("tool-read request naming a tedi renders as delegate_tedi (no false fetch promise)", () => {
		const route: KernelRouteDecision = {
			routeKind: "delegate_tedi",
			rationale: "CTO tedi owns the github connection.",
			risk: "low",
			confidence: 0.88,
			effortClass: "single_read",
			answer: null,
			targetTediId: "tedi-cto",
			targetTediLabel: "CTO",
			toolIntent: null,
			workflowHint: null,
			clarifyingQuestion: null,
			evidenceExpectation: null,
		};
		const msg = renderRouteResponse(route, null);
		const unavailable = constrainUnavailableDelegation(route, false);
		expect(unavailable).toMatchObject({
			routeKind: "answer_in_home",
			targetTediId: null,
			toolIntent: null,
		});
		expect(renderRouteResponse(unavailable)).toContain("does not run tedis");
		expect(constrainUnavailableDelegation(route, true)).toBe(route);
		expect(constrainUnavailableDelegation(route, undefined)).toBe(route);
		expect(
			constrainUnavailableDelegation(
				{ ...route, routeKind: "suggest_handoff" },
				false,
			).routeKind,
		).toBe("answer_in_home");
		// Must mention the tedi, never promise kernel-side execution.
		expect(msg).toContain("CTO");
		expect(msg).not.toContain("I'll fetch");
		expect(msg).not.toContain("confirm and I'll");
		expect(msg).not.toContain("delegating to CTO now");
	});

	it("delegate_tedi without a named tedi still gives an actionable response", () => {
		const route: KernelRouteDecision = {
			routeKind: "delegate_tedi",
			rationale: "A tedi should handle this live read.",
			risk: "low",
			confidence: 0.7,
			effortClass: "single_read",
			answer: null,
			targetTediId: null,
			targetTediLabel: null,
			toolIntent: null,
			workflowHint: null,
			clarifyingQuestion: null,
			evidenceExpectation: null,
		};
		const msg = renderRouteResponse(route, null);
		expect(msg).not.toContain("I'll fetch");
		expect(msg).not.toContain("confirm and I'll");
		// Falls back to the generic delegate message.
		expect(msg.length).toBeGreaterThan(0);
	});
});

describe("approval-held delegation routing", () => {
	const answerRoute: KernelRouteDecision = {
		routeKind: "answer_in_home",
		rationale: "Prepare a work order in Home.",
		risk: "low",
		confidence: 0.9,
		effortClass: "single_read",
		answer: "Prepared for approval — not dispatched.",
		targetTediId: null,
		targetTediLabel: null,
		toolIntent: null,
		workflowHint: null,
		clarifyingQuestion: null,
		evidenceExpectation: null,
	};

	it("coerces a parked approval work order into a machine-readable delegation", () => {
		const route = coerceParkedApprovalDelegationRoute(
			answerRoute,
			"Prepare a CTO delegation work order. Do not dispatch CTO yet; park this for operator approval first.",
			[
				{ id: "tedi-cto", slug: "cto", name: "CTO" },
				{ id: "tedi-cpo", slug: "cpo", name: "CPO" },
			],
		);

		expect(route).toMatchObject({
			routeKind: "delegate_tedi",
			targetTediId: "tedi-cto",
			targetTediLabel: "CTO",
			answer: null,
		});
	});

	it("coerces parked approval write detours into machine-readable delegation", () => {
		const route = coerceParkedApprovalDelegationRoute(
			{
				...answerRoute,
				routeKind: "propose_tool_write",
				answer: "I will stage this as a pending CTO approval-gated work order.",
				risk: "medium",
				toolIntent: {
					appSlug: "tedix",
					capability: "work_items.create_pending_delegation",
					connectionStatus: "unknown",
				},
			},
			"Prepare a CTO delegation work order. Do not dispatch CTO yet; park this for operator approval first.",
			[{ id: "tedi-cto", slug: "cto", name: "CTO" }],
		);

		expect(route).toMatchObject({
			routeKind: "delegate_tedi",
			targetTediId: "tedi-cto",
			targetTediLabel: "CTO",
			answer: null,
			toolIntent: null,
		});
	});

	it("leaves ordinary answers alone", () => {
		const route = coerceParkedApprovalDelegationRoute(
			answerRoute,
			"Explain how approval works for delegations.",
			[{ id: "tedi-cto", slug: "cto", name: "CTO" }],
		);

		expect(route).toBe(answerRoute);
	});

	it("needs-approval delegation copy does not imply dispatch already happened", () => {
		const msg = renderDelegationResponse(
			{
				...answerRoute,
				routeKind: "delegate_tedi",
				targetTediId: "tedi-cto",
				targetTediLabel: "CTO",
				answer: null,
			},
			{
				workOrder: {
					objective: "Review the CLI",
					outputContract: "Return one finding",
					toolGuidance: [],
					boundaries: [],
					sourceContent: "Review the CLI",
					targetTediId: "tedi-cto",
					targetTediLabel: "CTO",
				},
				decision: {
					mode: "needs_approval",
					canAutoDispatch: false,
					reason: "speaker lacks approval authority",
				},
			},
		);

		expect(msg).toContain("not dispatched yet");
		expect(msg).toContain("approve this Home run");
		expect(msg).not.toContain("delegating to CTO now");
	});

	it("names the agent approver when the hold is routed to one", () => {
		const msg = renderDelegationResponse(
			{
				...answerRoute,
				routeKind: "delegate_tedi",
				targetTediId: "tedi-cpo",
				targetTediLabel: "CPO",
				answer: null,
			},
			{
				workOrder: {
					objective: "Review the roadmap",
					outputContract: "Return one finding",
					toolGuidance: [],
					boundaries: [],
					sourceContent: "Review the roadmap",
					targetTediId: "tedi-cpo",
					targetTediLabel: "CPO",
				},
				decision: {
					mode: "needs_approval",
					approvalRoute: "agent",
					canAutoDispatch: false,
					reason: "route classified as high risk",
				},
				approver: { tediId: "tedi-cto", label: "CTO" },
			} as unknown as Parameters<typeof renderDelegationResponse>[1],
		);

		expect(msg).toContain("not dispatched yet");
		expect(msg).toContain("routed the decision to CTO");
		expect(msg).toContain("only if CTO declines");
		expect(msg).not.toContain("approve this Home run");
	});
});

/**
 * renderWriteDeclined must be HONEST per stage — the operator must never see
 * the planner's optimistic "Confirm and I'll prepare it for approval" text when
 * the write was internally declined and nothing was created or sent.
 */
const OPTIMISTIC_PROMISE = "Confirm and I'll prepare it for approval";

function writeRoute(
	appSlug = "globex",
	capability = "create_invoice",
): { toolIntent: { appSlug: string; capability: string } } {
	return { toolIntent: { appSlug, capability } };
}

describe("renderWriteDeclined — each stage maps to an honest one-liner", () => {
	it("disabled: tells the operator the app isn't set up for writes, suggests delegation", () => {
		const msg = renderWriteDeclined(
			{ stage: "disabled" } satisfies KernelWriteProposalDeclined,
			writeRoute(),
		);
		expect(msg).toContain("globex");
		expect(msg).toContain("delegate");
		expect(msg).not.toContain(OPTIMISTIC_PROMISE);
	});

	it("no_provider: same delegation message as disabled", () => {
		const msg = renderWriteDeclined(
			{ stage: "no_provider" } satisfies KernelWriteProposalDeclined,
			writeRoute("github"),
		);
		expect(msg).toContain("github");
		expect(msg).toContain("delegate");
		expect(msg).not.toContain(OPTIMISTIC_PROMISE);
	});

	it("no_write_tools: same delegation message", () => {
		const msg = renderWriteDeclined(
			{ stage: "no_write_tools" } satisfies KernelWriteProposalDeclined,
			writeRoute("gmail"),
		);
		expect(msg).toContain("gmail");
		expect(msg).toContain("delegate");
		expect(msg).not.toContain(OPTIMISTIC_PROMISE);
	});

	it("planner_declined: asks for specifics, never promises", () => {
		const msg = renderWriteDeclined(
			{ stage: "planner_declined" } satisfies KernelWriteProposalDeclined,
			writeRoute("globex", "create_invoice"),
		);
		expect(msg).toContain("globex");
		expect(msg).toContain("write-capable");
		expect(msg).toContain("exact create_invoice call");
		expect(msg).toContain("nothing was created or sent");
		expect(msg).not.toContain(OPTIMISTIC_PROMISE);
	});

	it("validation_failed: asks for specifics, includes the capability verb", () => {
		const msg = renderWriteDeclined(
			{ stage: "validation_failed" } satisfies KernelWriteProposalDeclined,
			writeRoute("linear", "create_issue"),
		);
		expect(msg).toContain("linear");
		expect(msg).toContain("create_issue");
		expect(msg).not.toContain(OPTIMISTIC_PROMISE);
	});

	it("missing_inputs: asks for specifics", () => {
		const msg = renderWriteDeclined(
			{ stage: "missing_inputs" } satisfies KernelWriteProposalDeclined,
			writeRoute("globex"),
		);
		expect(msg).toContain("specifics");
		expect(msg).not.toContain(OPTIMISTIC_PROMISE);
	});

	it("error: safe generic — nothing was created or sent", () => {
		const msg = renderWriteDeclined(
			{
				stage: "error",
				detail: "timeout",
			} satisfies KernelWriteProposalDeclined,
			writeRoute("globex"),
		);
		expect(msg).toContain("globex");
		expect(msg).toContain("nothing was created or sent");
		expect(msg).not.toContain(OPTIMISTIC_PROMISE);
	});

	it("unknown stage: safe generic fallback", () => {
		// Cast to exercise the default branch with a hypothetical future stage.
		const msg = renderWriteDeclined(
			{ stage: "unknown_future_stage" as KernelWriteProposalDeclined["stage"] },
			writeRoute("globex"),
		);
		expect(msg).toContain("nothing was created or sent");
		expect(msg).not.toContain(OPTIMISTIC_PROMISE);
	});

	it("missing toolIntent: falls back to generic labels gracefully", () => {
		const msg = renderWriteDeclined({ stage: "disabled" }, {});
		expect(msg).toContain("that app");
		expect(msg).not.toContain(OPTIMISTIC_PROMISE);
	});
});

/**
 * renderRouteResponse — propose_tool_write: honest messaging contract.
 *
 * The propose_tool_write case must NOT firm-promise "Confirm and I'll prepare it
 * for approval" before the write-proposal planner has run. Instead:
 *   - without a decline: hedged phrasing ("I'll attempt…") so a planner decline
 *     doesn't contradict what the operator already read.
 *   - with writeDeclined: render the honest per-stage line from renderWriteDeclined.
 */
function proposeWriteRoute(
	appSlug = "globex",
	capability = "create_invoice",
): KernelRouteDecision {
	return {
		routeKind: "propose_tool_write",
		rationale: "Operator wants to create a Globex invoice.",
		risk: "medium",
		confidence: 0.85,
		effortClass: "single_read",
		answer: null,
		targetTediId: null,
		targetTediLabel: null,
		toolIntent: {
			appSlug,
			capability,
			connectionStatus: "connected",
		},
		workflowHint: null,
		clarifyingQuestion: null,
		evidenceExpectation: null,
	};
}

describe("renderRouteResponse — propose_tool_write: honest messaging", () => {
	// The old firm promise: "Confirm and I'll prepare it for approval" — no longer
	// acceptable in the default (no-decline) case because the write-proposal planner
	// runs AFTER this text is produced and may decline.
	const FIRM_PROMISE = "Confirm and I'll prepare it for approval";

	it("default (no decline): hedged text — describes the intent, does NOT firm-promise delivery", () => {
		const msg = renderRouteResponse(proposeWriteRoute());
		expect(msg).toContain("globex");
		expect(msg).toContain("create_invoice");
		// Must NOT promise "Confirm and I'll prepare it for approval" (the write may fail)
		expect(msg).not.toContain(FIRM_PROMISE);
		// Should be non-empty and contain the app label
		expect(msg.length).toBeGreaterThan(0);
	});

	it("default (no decline): still describes the intent clearly without requiring confirmation", () => {
		const msg = renderRouteResponse(proposeWriteRoute("gmail", "send_message"));
		expect(msg).toContain("gmail");
		expect(msg).toContain("send_message");
		expect(msg).not.toContain(FIRM_PROMISE);
	});

	it("with writeDeclined (planner_declined): renders honest decline, no firm promise", () => {
		const msg = renderRouteResponse(
			proposeWriteRoute("platform", "set_tedi_policy"),
			{
				stage: "planner_declined",
			} satisfies KernelWriteProposalDeclined,
		);
		expect(msg).toContain("platform");
		expect(msg).not.toContain(FIRM_PROMISE);
		// Honest: nothing was created or sent
		expect(msg).toContain("nothing was created or sent");
	});

	it("with writeDeclined (disabled): renders the delegation suggestion, no firm promise", () => {
		const msg = renderRouteResponse(proposeWriteRoute("globex"), {
			stage: "disabled",
		} satisfies KernelWriteProposalDeclined);
		expect(msg).toContain("globex");
		expect(msg).toContain("delegate");
		expect(msg).not.toContain(FIRM_PROMISE);
	});

	it("with writeDeclined (error): safe generic, mentions nothing was created", () => {
		const msg = renderRouteResponse(proposeWriteRoute("linear"), {
			stage: "error",
			detail: "timeout",
		} satisfies KernelWriteProposalDeclined);
		expect(msg).toContain("linear");
		expect(msg).toContain("nothing was created or sent");
		expect(msg).not.toContain(FIRM_PROMISE);
	});

	it("null writeDeclined still falls through to the hedged default (not a firm promise)", () => {
		const msg = renderRouteResponse(proposeWriteRoute("globex"), null);
		expect(msg).not.toContain(FIRM_PROMISE);
		expect(msg).toContain("globex");
	});
});

/**
 * route-planner SYSTEM_PROMPT: owned writes must guide the LLM to delegate
 * to the owning tedi rather than propose_tool_write.
 *
 * These tests inspect the SYSTEM_PROMPT text to ensure the owned-write
 * delegation rule is present and correctly scoped. They do NOT test the LLM's
 * routing decisions (those are non-deterministic) — they test the guidance
 * contract.
 */
describe("route-planner SYSTEM_PROMPT — owned-write delegation guidance", async () => {
	const { SYSTEM_PROMPT } = await import("./route-planner");

	it("SYSTEM_PROMPT instructs the LLM to delegate owned writes to the owning tedi", () => {
		// The owned-write delegation rule must be present.
		expect(SYSTEM_PROMPT).toContain("delegate_tedi");
		// Must call out that propose_tool_write is reserved for NO-OWNER writes.
		expect(SYSTEM_PROMPT).toContain("NO tedi");
		// Must mention domain ownership for the write-delegation guidance.
		expect(SYSTEM_PROMPT).toContain("owns the domain");
	});

	it("SYSTEM_PROMPT gives a concrete example of owned write → delegate_tedi (platform/CTO for policy)", () => {
		// The guidance must give "make tedis autonomous" as an owned-write example
		// (or equivalent language) so the LLM knows platform policy is a tedi domain.
		expect(SYSTEM_PROMPT).toContain("autonomous");
		expect(SYSTEM_PROMPT).toContain("delegate_tedi");
	});

	it("SYSTEM_PROMPT retains owner routing for external provider and governance writes", () => {
		// Internal artifact actions do not remove external-domain ownership.
		expect(SYSTEM_PROMPT).toContain(
			"Reserve propose_tool_write ONLY for writes where NO tedi",
		);
	});

	it("SYSTEM_PROMPT teaches the canonical Work factory lifecycle", () => {
		expect(SYSTEM_PROMPT).toContain("business disposition");
		expect(SYSTEM_PROMPT).toContain("derived readiness");
		expect(SYSTEM_PROMPT).toContain("fenced execution attempts");
		expect(SYSTEM_PROMPT).toContain("claim-addressed evidence");
		expect(SYSTEM_PROMPT).not.toContain(
			"tracked unit of delegated work with status and approvals",
		);
	});
});

vi.mock("./context-assembly", async (importOriginal) => ({
	...(await importOriginal<typeof import("./context-assembly")>()),
	assembleHomeContext: vi.fn(),
}));
vi.mock("./route-planner", async (importOriginal) => ({
	...(await importOriginal<typeof import("./route-planner")>()),
	planKernelRoute: vi.fn(),
}));
vi.mock("./tedi-capabilities", async (importOriginal) => ({
	...(await importOriginal<typeof import("./tedi-capabilities")>()),
	readOrgDispatchPolicyLayer: vi.fn(),
}));

const blockedRoute: KernelRouteDecision = {
	routeKind: "delegate_tedi",
	rationale: "CTO owns this",
	risk: "high",
	confidence: 1,
	effortClass: "fan_out",
	answer: "I will delegate to CTO.",
	targetTediId: "tedi-cto",
	targetTediLabel: "CTO",
	targetActivityId: "activity",
	plannedToolIds: ["github.write"],
	toolIntent: null,
	workflowHint: null,
	clarifyingQuestion: null,
	evidenceExpectation: null,
};

describe("final operator intent boundary", () => {
	it("clears a delegation reintroduced by approval-held coercion", () => {
		const result = finalizeKernelRouteDecision(
			{ ...blockedRoute, routeKind: "answer_in_home" },
			"Acknowledge only. Prepare a CTO delegation work order; park it for approval first.",
			[{ id: "tedi-cto", slug: "cto", name: "CTO" }],
		);
		expect(result).toMatchObject({
			routeKind: "answer_in_home",
			answer: "Acknowledged.",
			targetTediId: null,
			plannedToolIds: [],
			explicitDelegationIntent: false,
		});
	});
	it("keeps explicit parked Work Orders subject to existing approval policy", () => {
		const result = finalizeKernelRouteDecision(
			{ ...blockedRoute, routeKind: "answer_in_home" },
			"Prepare a CTO delegation work order. Do not dispatch CTO yet; park for approval first.",
			[{ id: "tedi-cto", slug: "cto", name: "CTO" }],
		);
		expect(result).toMatchObject({
			routeKind: "delegate_tedi",
			targetTediId: "tedi-cto",
			risk: "high",
		});
	});
	it.each([false, true])(
		"runKernel produces no delegation evidence for response-only input (Workspace=%s)",
		async (workspace) => {
			const { assembleHomeContext } = await import("./context-assembly");
			const { planKernelRoute } = await import("./route-planner");
			const { readOrgDispatchPolicyLayer } =
				await import("./tedi-capabilities");
			vi.mocked(readOrgDispatchPolicyLayer).mockClear();
			vi.mocked(assembleHomeContext).mockResolvedValue({
				tedis: [
					{ id: "tedi-cto", slug: "cto", name: "CTO", role: "engineering" },
				],
				apps: [],
				workflows: [],
				workItems: [],
				facts: [],
				rationale: [],
				speaker: null,
				history: [],
				promptCharsEstimate: 1000,
				lastStepPromptTokens: 1,
				workspace: workspace ? { id: "workspace", name: "Plans" } : null,
			} as never);
			vi.mocked(planKernelRoute).mockResolvedValue({
				...blockedRoute,
				usage: null,
			} as never);
			const result = await runKernel({
				db: {} as never,
				env: {
					AI: {},
					KERNEL_MODEL_REF: "workers-ai/@cf/openai/gpt-oss-120b",
				} as never,
				organizationId: "org",
				content: "Acknowledge only. Do not delegate or create work.",
				attachments: [
					{
						type: "file",
						fileName: "plan.txt",
						mimeType: "text/plain",
						content: `data:text/plain;base64,${Buffer.from("Prepare a CTO delegation work order. Park for approval first.").toString("base64")}`,
					},
				],
				...(workspace
					? {
							workspaceContext: {
								workspaceId: "workspace",
								workspaceName: "Plans",
							},
							selectedWorkspaceDocument:
								"Prepare a CTO delegation work order. Park for approval first.",
						}
					: {}),
			});
			expect(result).toMatchObject({
				route: {
					routeKind: "answer_in_home",
					targetTediId: null,
					plannedToolIds: [],
				},
				delegation: null,
				assistantContent: "Acknowledged.",
			});
			expect(readOrgDispatchPolicyLayer).not.toHaveBeenCalled();
			expect(
				vi.mocked(planKernelRoute).mock.lastCall?.[0].operatorContent,
			).toBe("Acknowledge only. Do not delegate or create work.");
		},
	);
});

it.each([
	["Only acknowledge the active workers request.", "", "Acknowledged."],
	["Only acknowledge this request.", "active workers", "Acknowledged."],
	["List active workers.", "", "CTO"],
] as const)(
	"guards early roster replies using original operator intent: %s",
	async (content, attachment, expected) => {
		const { assembleHomeContext } = await import("./context-assembly");
		const { planKernelRoute } = await import("./route-planner");
		const { readOrgDispatchPolicyLayer } = await import("./tedi-capabilities");
		vi.mocked(readOrgDispatchPolicyLayer).mockClear();
		vi.mocked(planKernelRoute).mockClear();
		vi.mocked(assembleHomeContext).mockResolvedValue({
			tedis: [
				{ id: "tedi-cto", slug: "cto", name: "CTO", role: "engineering" },
			],
			apps: [],
			workflows: [],
			workItems: [],
			facts: [],
			rationale: [],
			speaker: null,
			history: [],
			promptCharsEstimate: 1000,
			lastStepPromptTokens: 1,
		} as never);
		vi.mocked(planKernelRoute).mockResolvedValue({
			...blockedRoute,
			usage: null,
		} as never);
		const result = await runKernel({
			db: {} as never,
			env: {
				AI: {},
				KERNEL_MODEL_REF: "workers-ai/@cf/openai/gpt-oss-120b",
			} as never,
			organizationId: "org",
			content,
			...(attachment
				? {
						attachments: [
							{
								type: "file" as const,
								fileName: "roster.txt",
								mimeType: "text/plain",
								content: `data:text/plain;base64,${Buffer.from(attachment).toString("base64")}`,
							},
						],
					}
				: {}),
		});
		expect(result?.assistantContent).toContain(expected);
		expect(result?.delegation).toBeNull();
		expect(readOrgDispatchPolicyLayer).not.toHaveBeenCalled();
		if (attachment) expect(planKernelRoute).toHaveBeenCalledOnce();
		else expect(planKernelRoute).not.toHaveBeenCalled();
	},
);
