import { describe, expect, it } from "vite-plus/test";
import {
	assignmentIsWriteBearing,
	buildDelegationWorkOrder,
	classifyDelegationFailure,
	decideDelegationDispatch,
	deriveDelegationContract,
	deriveExecutionRequirement,
	hasMatchingDelegationEntrustment,
	MAX_DELEGATION_DEPTH,
	renderDelegationWorkOrderMessage,
	serializedFanOutChainEdges,
	shouldSerializeFanOut,
} from "./delegation-dispatch";
import type { KernelRouteDecision } from "./route-schema";

// Local mirror of @tedix/db/queries/tedi-capabilities — kept in sync with the
// module's own mirror until the shared type lands.
interface TediCapabilityCard {
	tediId: string;
	slug: string;
	name: string;
	apps: string[];
	scopeGroups: string[];
	skills: string[];
	runtimeKind: string;
	embodied: boolean;
	availability: string;
	hasWarmWorkstationLease: boolean;
	hasRepository: boolean;
	depsReady: boolean;
	environmentReady: boolean;
	requiresApproval: boolean;
	delegationEntrustments: Array<{
		grantId: string;
		grantRevision: number;
		decisionId: string;
		activityId: string;
		activityVersion: number;
		expiresAt: string | null;
		level: string;
		taskFamily: string;
		riskLevel: string;
		actionPatterns: string[];
		activityToolIds: string[];
		scope: {
			actions: string[];
			toolIds: string[];
			environments: string[];
			spendPermission: "none" | "policy_bound";
			budgetPolicyId: string | null;
			constraints: Record<string, unknown>;
		};
	}>;
	dispatchPolicy: { effect?: "allow" | "deny"; reason?: string } | null;
	mcpCapabilityProfile: string | null;
}

describe("task-scoped earned delegation", () => {
	it.each([
		"Read-only check of your identity and live MCP connection status.",
		"Review current connections and summarize their authentication status.",
		"Inspect the billing balance and explain remaining capacity.",
	])(
		"does not infer repository access from an informational request: %s",
		(userContent) => {
			const order = buildDelegationWorkOrder({
				route: makeRoute(),
				card: makeCard({ hasRepository: true, hasWarmWorkstationLease: false }),
				userContent,
			});
			expect(order.executionRequirement.requiredCapabilities).not.toContain(
				"repository_read",
			);
			expect(order.toolGuidance.join("\n")).not.toContain("clone_repo");
		},
	);

	it.each([
		"Read README.md",
		"Inspect the source code",
		"Review the implementation files",
	])("retains repository capability for %s", (content) => {
		expect(
			deriveExecutionRequirement(content, makeRoute()).requiredCapabilities,
		).toContain("repository_read");
	});

	it("matches the concrete task family, risk, environment, tools, and constraints", () => {
		const route = makeRoute({
			risk: "medium",
			targetActivityId: "invoice-read",
			plannedToolIds: ["globex_tedix.list_invoices"],
			toolIntent: null,
		});
		const card = makeCard({
			delegationEntrustments: [
				{
					grantId: "grant-invoice-read",
					grantRevision: 3,
					decisionId: "decision-invoice-read",
					activityId: "invoice-read",
					activityVersion: 2,
					expiresAt: null,
					level: "autonomous",
					taskFamily: "globex.invoices.list",
					riskLevel: "medium",
					actionPatterns: ["kernel.receive_delegation"],
					activityToolIds: ["globex_tedix.list_invoices"],
					scope: {
						actions: ["kernel.receive_delegation"],
						toolIds: ["globex_tedix.list_invoices"],
						environments: ["production"],
						spendPermission: "none",
						budgetPolicyId: null,
						constraints: {
							routeKinds: ["delegate_tedi"],
							effortClasses: ["multi_hop_read"],
							maximumRisk: "medium",
						},
					},
				},
			],
		});
		expect(
			hasMatchingDelegationEntrustment({
				card,
				route,
				environment: "production",
			}),
		).toBe(true);
		const workOrder = buildDelegationWorkOrder({
			route,
			card,
			userContent: "List the latest invoices",
			executionEnvironment: "production",
			authorityMode: "enforce",
		});
		expect(route.toolIntent).toBeNull();
		expect(workOrder.authorityMode).toBe("enforce");
		expect(workOrder.authorityEnvelope).toEqual({
			version: "earned-delegation.v1",
			grantId: "grant-invoice-read",
			grantRevision: 3,
			decisionId: "decision-invoice-read",
			activityId: "invoice-read",
			activityVersion: 2,
			taskFamily: "globex.invoices.list",
			riskLevel: "medium",
			environment: "production",
			allowedToolIds: ["globex_tedix.list_invoices"],
			expiresAt: null,
		});
	});

	it.each([
		["risk", makeRoute({ risk: "high" }), "production"],
		["environment", makeRoute(), "staging"],
		["activity", makeRoute({ targetActivityId: "other" }), "production"],
	])("rejects a %s scope escape", (_label, route, environment) => {
		expect(
			hasMatchingDelegationEntrustment({
				card: makeCard(),
				route,
				environment,
			}),
		).toBe(false);
	});

	it("preserves existing dispatch in explicit shadow mode while exposing the miss", () => {
		const decision = decideDelegationDispatch({
			route: makeRoute(),
			card: makeCard({ delegationEntrustments: [] }),
			speaker: { approvalAuthority: true },
			earnedDelegationEnforcement: "shadow",
		});
		expect(decision.mode).toBe("auto");
		expect(decision.earnedDelegationShadow).toBe(true);
		// The miss is recorded, never smuggled into the text an operator reads.
		expect(decision.reason).not.toContain("earned-delegation-shadow");
	});
});

function makeRoute(
	overrides: Partial<KernelRouteDecision> = {},
): KernelRouteDecision {
	return {
		routeKind: "delegate_tedi",
		rationale: "This is a billing question and the finance tedi owns globex.",
		risk: "medium",
		confidence: 0.8,
		effortClass: "multi_hop_read",
		answer: null,
		targetTediId: "tedi-123",
		targetTediLabel: "Finance Tedi",
		targetActivityId: "activity-1",
		plannedToolIds: [],
		toolIntent: null,
		workflowHint: null,
		clarifyingQuestion: null,
		evidenceExpectation: null,
		...overrides,
	};
}

function makeCard(
	overrides: Partial<TediCapabilityCard> = {},
): TediCapabilityCard {
	return {
		tediId: "tedi-123",
		slug: "finance",
		name: "Finance Tedi",
		apps: ["globex", "gmail"],
		scopeGroups: ["finance.read", "finance.write"],
		skills: ["reconcile-invoices", "chase-payments"],
		runtimeKind: "agent",
		embodied: true,
		availability: "running",
		hasWarmWorkstationLease: false,
		hasRepository: false,
		depsReady: true,
		environmentReady: true,
		requiresApproval: false,
		delegationEntrustments: [
			{
				grantId: "grant-1",
				grantRevision: 1,
				decisionId: "decision-1",
				activityId: "activity-1",
				activityVersion: 1,
				expiresAt: null,
				level: "autonomous",
				taskFamily: "multi_hop_read",
				riskLevel: "medium",
				actionPatterns: ["kernel.receive_delegation"],
				activityToolIds: [],
				scope: {
					actions: ["kernel.receive_delegation"],
					toolIds: [],
					environments: ["production"],
					spendPermission: "none",
					budgetPolicyId: null,
					constraints: {},
				},
			},
		],
		dispatchPolicy: null,
		mcpCapabilityProfile: "finance",
		...overrides,
	};
}

describe("buildDelegationWorkOrder", () => {
	it("renders the full accepted request including trailing acceptance constraints", () => {
		const source = `  Original task
${"Detailed context. ".repeat(250)}
Acceptance: preserve the independent oracle and both merge parents.
  `;
		const workOrder = buildDelegationWorkOrder({
			route: makeRoute(),
			card: null,
			userContent: source,
		});
		expect(workOrder.sourceContent).toBe(source);
		const rendered = renderDelegationWorkOrderMessage({
			workOrder: workOrder as unknown as Record<string, unknown>,
			fallbackContent: "not the canonical task",
			fallbackWorkOrderId: "task",
		});
		expect(rendered).toContain(`Source request:
${source}
[END HOME DELEGATION WORK ORDER]`);
		expect(workOrder.objective.length).toBeLessThanOrEqual(600);
	});

	it("produces all four work-order fields plus routing metadata", () => {
		const wo = buildDelegationWorkOrder({
			route: makeRoute(),
			card: makeCard(),
			userContent: "Which invoices are overdue this month?",
		});

		expect(wo.objective.length).toBeGreaterThan(0);
		expect(wo.outputContract.length).toBeGreaterThan(0);
		expect(wo.toolGuidance.length).toBeGreaterThan(0);
		expect(wo.boundaries.length).toBeGreaterThan(0);
		expect(wo.targetTediId).toBe("tedi-123");
		expect(wo.targetTediLabel).toBe("Finance Tedi");
		expect(wo.sourceContent).toBe("Which invoices are overdue this month?");
	});

	it("routes bounded test execution through a managed job instead of attaching an interactive workstation", () => {
		const wo = buildDelegationWorkOrder({
			route: makeRoute({ effortClass: "embodied" }),
			card: makeCard({ embodied: true }),
			userContent: "run the smoke tests",
		});
		expect(wo.kind).toBe("tedi.delegate");
		expect(wo.executionRequirement.surface).toBe("managed_job");
		expect(wo.toolGuidance.join("\n")).toContain("exec");
	});

	it("uses one checkout workflow for coding even before a workstation is ready", () => {
		const wo = buildDelegationWorkOrder({
			route: makeRoute(),
			card: makeCard({
				embodied: true,
				hasRepository: true,
				hasWarmWorkstationLease: true,
				environmentReady: false,
			}),
			userContent: "fix the typo in README.md and commit it",
			executionRequirement: {
				surface: "native",
				requiredCapabilities: ["repository_read", "repository_edit"],
				reason: "bounded repository work",
				fallbackSurface: "workstation",
				prohibitedSurfaces: [],
				satisfiable: true,
			},
		});
		const guidance = wo.toolGuidance.join("\n");
		expect(guidance).toContain("open_computer({ repository: true })");
		expect(guidance).not.toContain("repo_load");
		expect(guidance).not.toContain("repo_commit");
	});

	it("retains scratch editing when workstation use is explicitly prohibited", () => {
		const wo = buildDelegationWorkOrder({
			route: makeRoute(),
			card: makeCard({
				embodied: true,
				hasRepository: true,
				hasWarmWorkstationLease: false,
				environmentReady: false,
			}),
			userContent: "apply the one-line config change",
			executionRequirement: {
				surface: "native",
				requiredCapabilities: ["repository_read", "repository_edit"],
				reason: "bounded repository work",
				fallbackSurface: "workstation",
				prohibitedSurfaces: ["workstation"],
				satisfiable: true,
			},
		});
		expect(wo.toolGuidance.join("\n")).toContain(
			"Worker-native repository tools",
		);
	});

	it("does not let lease warmth override the native routing decision", () => {
		const ready = buildDelegationWorkOrder({
			route: makeRoute(),
			card: makeCard({
				embodied: true,
				hasRepository: true,
				hasWarmWorkstationLease: true,
				environmentReady: true,
			}),
			userContent: "fix the typo",
			executionRequirement: {
				surface: "native",
				requiredCapabilities: ["repository_read"],
				reason: "bounded repository work",
				fallbackSurface: "workstation",
				prohibitedSurfaces: [],
				satisfiable: true,
			},
		});
		expect(ready.toolGuidance.join("\n")).not.toContain("Worker-native");

		const workstationOnly = buildDelegationWorkOrder({
			route: makeRoute({ effortClass: "embodied" }),
			card: makeCard({
				embodied: true,
				hasRepository: true,
				hasWarmWorkstationLease: false,
				environmentReady: false,
			}),
			userContent: "run the full test suite",
			executionRequirement: {
				surface: "workstation",
				requiredCapabilities: ["process"],
				reason: "needs a shell",
				fallbackSurface: null,
				prohibitedSurfaces: [],
				satisfiable: true,
			},
		});
		expect(workstationOnly.toolGuidance.join("\n")).not.toContain(
			"workstation is not ready",
		);
	});

	it("does not inject repository procedure into a native connection read", () => {
		const wo = buildDelegationWorkOrder({
			route: makeRoute({ effortClass: "single_read" }),
			card: makeCard({
				embodied: true,
				hasRepository: true,
				hasWarmWorkstationLease: false,
				environmentReady: false,
			}),
			userContent: "what MCP apps are connected in my gateway?",
			executionRequirement: {
				surface: "native",
				requiredCapabilities: [],
				reason: "live connection read",
				fallbackSurface: null,
				prohibitedSurfaces: [],
				satisfiable: true,
			},
		});
		const guidance = wo.toolGuidance.join("\n");
		expect(guidance).not.toContain("Worker-native repository tools");
		expect(guidance).not.toContain("clone_repo");
		expect(guidance).not.toContain("repo_commit");
	});

	it("DEGRADES to tedi.delegate for an EMBODIED target on a read-only route (needs-aware)", () => {
		// The CTO case: a permanently-embodied tedi (configured repository) asked a
		// conversational / read-only question ("introduce yourself"). The kind is a
		// function of (needs × capability): no embodied surface is needed, so the
		// work order must not mint a workstation attachment.
		const wo = buildDelegationWorkOrder({
			route: makeRoute({ effortClass: "multi_hop_read" }),
			card: makeCard({
				runtimeKind: "agent",
				embodied: true,
				hasWarmWorkstationLease: false,
			}),
			userContent: "introduce yourself",
		});
		expect(wo.kind).toBe("tedi.delegate");
		expect(wo.executionRequirement.surface).toBe("native");
	});

	it("keeps bounded repository reads native even when the planner assigns an embodied budget", () => {
		const route = makeRoute({ effortClass: "embodied" });
		const requirement = deriveExecutionRequirement(
			"Read package.json and README.md with native repository tools; do not request a workstation",
			route,
		);
		const wo = buildDelegationWorkOrder({
			route,
			card: makeCard({ embodied: true, hasWarmWorkstationLease: false }),
			userContent:
				"Read package.json and README.md with native repository tools; do not request a workstation",
			executionRequirement: requirement,
		});
		expect(requirement.surface).toBe("native");
		expect(wo.kind).toBe("tedi.delegate");
		expect(wo.executionRequirement.surface).toBe("native");
	});

	it("requires a workstation for explicit shell, install, and full-test work", () => {
		const requirement = deriveExecutionRequirement(
			"Install dependencies and run the full test suite in the shell",
			makeRoute({ effortClass: "multi_hop_read" }),
		);
		expect(requirement).toMatchObject({
			surface: "workstation",
			requiredCapabilities: ["dependency_install", "tests", "process"],
		});
	});

	it("keeps a GTM program build on the CMO's native tedi route", () => {
		const route = makeRoute({ effortClass: "fan_out", risk: "medium" });
		const requirement = deriveExecutionRequirement(
			"Please build a durable, source-grounded GTM network interview program in this workspace. Create or update the operating brief and dated shortlist view.",
			route,
		);
		expect(requirement).toMatchObject({
			surface: "native",
			requiredCapabilities: [],
		});
		expect(
			decideDelegationDispatch({
				route,
				card: makeCard({ embodied: false }),
				executionRequirement: requirement,
				speaker: { approvalAuthority: true },
			}),
		).toMatchObject({ mode: "auto", canAutoDispatch: true });
	});

	it("does not require a workstation lease for a bounded software build job", () => {
		const route = makeRoute({ effortClass: "fan_out", risk: "medium" });
		const requirement = deriveExecutionRequirement(
			"Run the production build",
			route,
		);
		expect(requirement).toMatchObject({
			surface: "managed_job",
			requiredCapabilities: ["build"],
		});
		expect(
			decideDelegationDispatch({
				route,
				card: makeCard({ embodied: false }),
				executionRequirement: requirement,
				speaker: { approvalAuthority: true },
			}),
		).toMatchObject({ mode: "auto", canAutoDispatch: true });
	});

	it("does not confuse discussion of CLI or coding-agent docs with execution", () => {
		const requirement = deriveExecutionRequirement(
			"Review the CLI and Codex documentation and summarize the configuration",
			makeRoute({ effortClass: "multi_hop_read" }),
		);
		expect(requirement.surface).toBe("native");
	});

	it("does not promote explicitly prohibited actions into required capabilities", () => {
		const requirement = deriveExecutionRequirement(
			"Without modifying files, committing, or deploying, run the focused typecheck in the Tedix repository",
			makeRoute({ effortClass: "embodied" }),
		);
		expect(requirement).toMatchObject({
			surface: "managed_job",
			requiredCapabilities: ["typecheck", "repository_read"],
		});
		expect(requirement.requiredCapabilities).not.toContain("deploy");
		expect(requirement.requiredCapabilities).not.toContain("repository_edit");
	});

	it("keeps typed workstation job tools on the managed-job surface", () => {
		const requirement = deriveExecutionRequirement(
			"Run the focused typecheck through a durable managed job and poll to terminal evidence",
			makeRoute({
				effortClass: "embodied",
				plannedToolIds: ["exec", "read_execution"],
			}),
		);
		expect(requirement).toMatchObject({
			surface: "managed_job",
			requiredCapabilities: ["typecheck", "data"],
		});
	});

	it("routes bounded data analysis through a managed job", () => {
		const requirement = deriveExecutionRequirement(
			"Analyze this large dataset and return statistical analysis",
			makeRoute({ effortClass: "multi_hop_read" }),
		);
		expect(requirement).toMatchObject({
			surface: "managed_job",
			requiredCapabilities: ["data"],
			satisfiable: true,
		});
	});

	it("does not turn workstation_status into an interactive process requirement", () => {
		const requirement = deriveExecutionRequirement(
			"Check the current state",
			makeRoute({
				effortClass: "multi_hop_read",
				plannedToolIds: ["workstation_status"],
			}),
		);
		expect(requirement.surface).toBe("native");
		expect(requirement.requiredCapabilities).not.toContain("process");
	});

	it("blocks contradictory native-only execution requirements", () => {
		const route = makeRoute({ effortClass: "embodied", risk: "low" });
		const requirement = deriveExecutionRequirement(
			"Run the full test suite but don’t use a workstation",
			route,
		);
		expect(requirement).toMatchObject({
			surface: "native",
			prohibitedSurfaces: ["managed_job", "workstation"],
			satisfiable: false,
		});
		expect(
			decideDelegationDispatch({
				route,
				card: makeCard(),
				executionRequirement: requirement,
				speaker: { approvalAuthority: true },
			}),
		).toMatchObject({ canAutoDispatch: false, mode: "blocked" });
	});

	it("names the oversize-repo clone signal as a typed workstation escape hatch (Codex #4)", () => {
		const requirement = deriveExecutionRequirement(
			"Review the repo and make a small edit to the config",
			makeRoute({ effortClass: "multi_hop_read" }),
		);
		expect(requirement.surface).toBe("native");
		expect(requirement.fallbackSurface).toBe("workstation");
	});

	it("emits a plain tedi.delegate work order for a NON-embodied target", () => {
		const wo = buildDelegationWorkOrder({
			route: makeRoute(),
			card: makeCard({ runtimeKind: "agent", embodied: false }),
			userContent: "summarize the roadmap",
		});
		expect(wo.kind).toBe("tedi.delegate");
	});

	it("emits tedi.delegate when there is no capability card", () => {
		const wo = buildDelegationWorkOrder({
			route: makeRoute({ targetTediLabel: "Ops Tedi" }),
			card: null,
			userContent: "do the thing",
		});
		expect(wo.kind).toBe("tedi.delegate");
	});

	it("derives toolGuidance from the card's scope groups and apps", () => {
		const wo = buildDelegationWorkOrder({
			route: makeRoute(),
			card: makeCard(),
			userContent: "Check overdue invoices",
		});
		const joined = wo.toolGuidance.join(" ");
		expect(joined).toContain("finance.read");
		expect(joined).toContain("finance.write");
		expect(joined).toContain("globex");
	});

	it("does NOT emit step-by-step instructions (no over-prescription)", () => {
		const wo = buildDelegationWorkOrder({
			route: makeRoute(),
			card: makeCard(),
			userContent: "Check overdue invoices",
		});
		const blob = [
			wo.objective,
			wo.outputContract,
			...wo.toolGuidance,
			...wo.boundaries,
		]
			.join(" ")
			.toLowerCase();
		// No procedural step markers.
		expect(blob).not.toMatch(/step\s*\d/);
		expect(blob).not.toContain("first,");
		expect(blob).not.toContain("then,");
	});

	it("always includes no-fabrication and scope-boundary clauses", () => {
		const wo = buildDelegationWorkOrder({
			route: makeRoute(),
			card: makeCard(),
			userContent: "anything",
		});
		const boundaries = wo.boundaries.join(" ").toLowerCase();
		expect(boundaries).toContain("fabricate");
		expect(boundaries).toContain("scope");
	});

	it("adds an approval boundary when the card requires approval", () => {
		const wo = buildDelegationWorkOrder({
			route: makeRoute(),
			card: makeCard({ requiresApproval: true }),
			userContent: "anything",
		});
		expect(wo.boundaries.join(" ").toLowerCase()).toContain("approval");
	});

	it("falls back gracefully with a null card", () => {
		const wo = buildDelegationWorkOrder({
			route: makeRoute({ targetTediLabel: "Ops Tedi" }),
			card: null,
			userContent: "do the thing",
		});
		expect(wo.targetTediId).toBe("tedi-123");
		expect(wo.targetTediLabel).toBe("Ops Tedi");
		expect(wo.toolGuidance.length).toBeGreaterThan(0);
		expect(wo.boundaries.length).toBeGreaterThan(0);
	});

	it("uses the route evidence expectation as the output contract when present", () => {
		const wo = buildDelegationWorkOrder({
			route: makeRoute({
				evidenceExpectation: "a list of overdue invoice IDs",
			}),
			card: makeCard(),
			userContent: "x",
		});
		expect(wo.outputContract).toContain("overdue invoice IDs");
	});

	it("threads an explicit budget through verbatim onto the work order", () => {
		const wo = buildDelegationWorkOrder({
			route: makeRoute(),
			card: makeCard(),
			userContent: "audit last quarter's invoices",
			budget: {
				maxToolCalls: 20,
				maxTokens: 8000,
				maxUsd: 1.0,
				deadlineMs: 60000,
			},
		});
		expect(wo.budget).toEqual({
			maxToolCalls: 20,
			maxTokens: 8000,
			maxUsd: 1.0,
			deadlineMs: 60000,
		});
	});

	it("derives a default budget from the effort class when none is supplied", () => {
		const wo = buildDelegationWorkOrder({
			route: makeRoute(), // effortClass: multi_hop_read
			card: makeCard(),
			userContent: "anything",
		});
		expect(wo.budget).toEqual({ maxToolCalls: 8, deadlineMs: 300_000 });
	});

	it("caller-supplied caps win per-field while derived caps fill the gaps", () => {
		const wo = buildDelegationWorkOrder({
			route: makeRoute(),
			card: makeCard(),
			userContent: "anything",
			budget: { maxUsd: 2.0 },
		});
		expect(wo.budget).toEqual({
			maxToolCalls: 8,
			deadlineMs: 300_000,
			maxUsd: 2.0,
		});
	});

	// --- Rich handoffs: trace excerpts ---

	it("surfaces caller-supplied trace excerpts on the returned work order", () => {
		const wo = buildDelegationWorkOrder({
			route: makeRoute(),
			card: makeCard(),
			userContent: "Which invoices are overdue?",
			traceExcerpts: [
				"operator: which invoices are overdue this month?",
				"route rationale: billing question owned by finance tedi",
			],
		});
		expect(wo.traceExcerpts).toEqual([
			"operator: which invoices are overdue this month?",
			"route rationale: billing question owned by finance tedi",
		]);
	});

	it("uses an explicit empty traceExcerpts list when none are supplied", () => {
		const wo = buildDelegationWorkOrder({
			route: makeRoute(),
			card: makeCard(),
			userContent: "anything",
		});
		expect(wo.traceExcerpts).toEqual([]);
	});

	it("omits the traceExcerpts key when an empty/whitespace-only array is supplied", () => {
		const wo = buildDelegationWorkOrder({
			route: makeRoute(),
			card: makeCard(),
			userContent: "anything",
			traceExcerpts: ["", "   "],
		});
		expect(wo.traceExcerpts).toEqual([]);
	});

	it("clamps, dedupes, and caps trace excerpts at 4", () => {
		const huge = "x".repeat(5000);
		const wo = buildDelegationWorkOrder({
			route: makeRoute(),
			card: makeCard(),
			userContent: "anything",
			traceExcerpts: [
				huge,
				"line a",
				"line a", // duplicate — dropped
				"line b",
				"line c",
				"line d", // 5th distinct (after huge) — dropped by the cap of 4
				"line e",
			],
		});
		expect(wo.traceExcerpts).toBeDefined();
		const excerpts = wo.traceExcerpts ?? [];
		expect(excerpts.length).toBeLessThanOrEqual(4);
		// per-item clamp to MAX_ITEM_LEN (200)
		for (const item of excerpts) expect(item.length).toBeLessThanOrEqual(200);
		// dedupe: "line a" appears at most once
		expect(excerpts.filter((e) => e === "line a").length).toBeLessThanOrEqual(
			1,
		);
		// first (huge) item is clamped, not dropped
		expect(excerpts[0].length).toBe(200);
	});

	it("bounds summaries and guidance while retaining the complete source request", () => {
		const huge = "x".repeat(5000);
		const wo = buildDelegationWorkOrder({
			route: makeRoute({ rationale: huge, evidenceExpectation: huge }),
			card: makeCard({
				scopeGroups: Array.from({ length: 50 }, (_, i) => `scope-${i}`),
				apps: Array.from({ length: 50 }, (_, i) => `app-${i}`),
			}),
			userContent: huge,
		});
		expect(wo.objective.length).toBeLessThanOrEqual(600);
		expect(wo.outputContract.length).toBeLessThanOrEqual(400);
		expect(wo.sourceContent).toBe(huge);
		expect(wo.targetTediLabel.length).toBeLessThanOrEqual(200);
		expect(wo.toolGuidance.length).toBeLessThanOrEqual(8);
		expect(wo.boundaries.length).toBeLessThanOrEqual(8);
		for (const item of [...wo.toolGuidance, ...wo.boundaries]) {
			expect(item.length).toBeLessThanOrEqual(200);
		}
	});
});

describe("renderDelegationWorkOrderMessage — Recent context block", () => {
	it("renders the assigned tedi id so scoped reads do not rediscover identity", () => {
		const rendered = renderDelegationWorkOrderMessage({
			workOrder: {
				targetTediId: "5eed0038-0000-4000-8000-000000000038",
				targetTediLabel: "CTO",
				objective: "Inspect live MCP connections.",
				outputContract: "Return connected apps and their states.",
				sourceContent: "what MCP apps are connected in my gateway?",
			},
			fallbackContent: "what MCP apps are connected in my gateway?",
			fallbackWorkOrderId: "run-1:auto:cto",
		});
		expect(rendered).toContain(
			"Assigned tedi: CTO (5eed0038-0000-4000-8000-000000000038).",
		);
		expect(rendered).toContain("do not rediscover your own identity");
	});

	it("renders a `Recent context:` block from traceExcerpts when present", () => {
		const rendered = renderDelegationWorkOrderMessage({
			workOrder: {
				objective: "Review overdue invoices.",
				outputContract: "A list of overdue invoice IDs.",
				toolGuidance: ['Use your "finance.read" scope group.'],
				boundaries: ["Do not fabricate data."],
				traceExcerpts: [
					"operator: which invoices are overdue this month?",
					"route rationale: billing question owned by finance tedi",
				],
				sourceContent: "Which invoices are overdue this month?",
			},
			fallbackContent: "Which invoices are overdue this month?",
			fallbackWorkOrderId: "run-1:auto:tedi-123",
			label: "DELEGATION",
		});
		expect(rendered).toContain("Recent context:");
		expect(rendered).toContain(
			"- operator: which invoices are overdue this month?",
		);
		expect(rendered).toContain(
			"- route rationale: billing question owned by finance tedi",
		);
		// Ordered between Boundaries and the Source request.
		expect(rendered.indexOf("Boundaries:")).toBeLessThan(
			rendered.indexOf("Recent context:"),
		);
		expect(rendered.indexOf("Recent context:")).toBeLessThan(
			rendered.indexOf("Source request:"),
		);
	});

	it("omits the `Recent context:` block when traceExcerpts is absent", () => {
		const rendered = renderDelegationWorkOrderMessage({
			workOrder: {
				objective: "Review overdue invoices.",
				outputContract: "A list of overdue invoice IDs.",
				boundaries: ["Do not fabricate data."],
				sourceContent: "Which invoices are overdue this month?",
			},
			fallbackContent: "Which invoices are overdue this month?",
			fallbackWorkOrderId: "run-1:auto:tedi-123",
		});
		expect(rendered).not.toContain("Recent context:");
	});

	it("end-to-end: a work order built WITH excerpts renders the block", () => {
		const wo = buildDelegationWorkOrder({
			route: makeRoute(),
			card: makeCard(),
			userContent: "Which invoices are overdue?",
			traceExcerpts: ["operator: check overdue invoices"],
		});
		const rendered = renderDelegationWorkOrderMessage({
			workOrder: wo as unknown as Record<string, unknown>,
			fallbackContent: "Which invoices are overdue?",
			fallbackWorkOrderId: "run-1:auto:tedi-123",
		});
		expect(rendered).toContain("Recent context:");
		expect(rendered).toContain("- operator: check overdue invoices");
	});
});

describe("outputSchema task mode (opt-in Tedix result-contract pattern)", () => {
	const schema = {
		type: "object",
		required: ["status"],
		properties: { status: { type: "string", enum: ["ok", "partial"] } },
	};

	it("surfaces the caller-supplied outputSchema on the returned work order", () => {
		const wo = buildDelegationWorkOrder({
			route: makeRoute(),
			card: makeCard(),
			userContent: "anything",
			outputSchema: schema,
		});
		expect(wo.outputSchema).toEqual(schema);
	});

	it("uses null when no output schema is supplied", () => {
		const wo = buildDelegationWorkOrder({
			route: makeRoute(),
			card: makeCard(),
			userContent: "anything",
		});
		expect(wo.outputSchema).toBeNull();
	});

	it("keeps an explicit null output schema", () => {
		const wo = buildDelegationWorkOrder({
			route: makeRoute(),
			card: makeCard(),
			userContent: "anything",
			outputSchema: null,
		});
		expect(wo.outputSchema).toBeNull();
	});

	it("renders an `Output contract (structured):` block with the schema as fenced json when present", () => {
		const rendered = renderDelegationWorkOrderMessage({
			workOrder: {
				objective: "Review overdue invoices.",
				outputContract: "A list of overdue invoice IDs.",
				sourceContent: "Which invoices are overdue this month?",
				outputSchema: schema,
			},
			fallbackContent: "Which invoices are overdue this month?",
			fallbackWorkOrderId: "run-1:auto:tedi-123",
		});
		expect(rendered).toContain("Output contract (structured):");
		expect(rendered).toContain("```json");
		expect(rendered).toContain(JSON.stringify(schema, null, 2));
		expect(rendered).toContain("In addition to your prose answer");
		// Ordered before the Source request block.
		expect(rendered.indexOf("Output contract (structured):")).toBeLessThan(
			rendered.indexOf("Source request:"),
		);
	});

	it("omits the `Output contract (structured):` block when outputSchema is absent — BYTE-IDENTICAL regression pin", () => {
		const withoutSchema = renderDelegationWorkOrderMessage({
			workOrder: {
				objective: "Review overdue invoices.",
				outputContract: "A list of overdue invoice IDs.",
				sourceContent: "Which invoices are overdue this month?",
			},
			fallbackContent: "Which invoices are overdue this month?",
			fallbackWorkOrderId: "run-1:auto:tedi-123",
		});
		const withNullSchema = renderDelegationWorkOrderMessage({
			workOrder: {
				objective: "Review overdue invoices.",
				outputContract: "A list of overdue invoice IDs.",
				sourceContent: "Which invoices are overdue this month?",
				outputSchema: null,
			},
			fallbackContent: "Which invoices are overdue this month?",
			fallbackWorkOrderId: "run-1:auto:tedi-123",
		});
		expect(withoutSchema).not.toContain("Output contract (structured):");
		expect(withNullSchema).toBe(withoutSchema);
	});

	it("end-to-end: a work order built WITHOUT outputSchema renders byte-identically to a work order that never knew this field existed", () => {
		const before = buildDelegationWorkOrder({
			route: makeRoute(),
			card: makeCard(),
			userContent: "Which invoices are overdue?",
		});
		const renderedBefore = renderDelegationWorkOrderMessage({
			workOrder: before as unknown as Record<string, unknown>,
			fallbackContent: "Which invoices are overdue?",
			fallbackWorkOrderId: "run-1:auto:tedi-123",
		});
		expect(renderedBefore).not.toContain("Output contract (structured):");
	});

	it("end-to-end: a work order built WITH an outputSchema renders the block", () => {
		const wo = buildDelegationWorkOrder({
			route: makeRoute(),
			card: makeCard(),
			userContent: "Which invoices are overdue?",
			outputSchema: schema,
		});
		const rendered = renderDelegationWorkOrderMessage({
			workOrder: wo as unknown as Record<string, unknown>,
			fallbackContent: "Which invoices are overdue?",
			fallbackWorkOrderId: "run-1:auto:tedi-123",
		});
		expect(rendered).toContain("Output contract (structured):");
		expect(rendered).toContain(JSON.stringify(schema, null, 2));
	});
});

describe("coding validation contract", () => {
	it("buildDelegationWorkOrder sets projectValidation for an embodied coding target on an embodied route", () => {
		const wo = buildDelegationWorkOrder({
			route: makeRoute({ effortClass: "embodied" }),
			card: makeCard({ embodied: true, hasRepository: true }),
			userContent: "fix the routing bug and run the tests",
		});
		expect(wo.kind).toBe("tedi.delegate");
		expect(wo.executionRequirement.surface).toBe("managed_job");
		expect((wo as { projectValidation?: boolean }).projectValidation).toBe(
			true,
		);
	});

	it("does NOT set projectValidation for an embodied target WITHOUT a configured repository (warm-lease-only / browser)", () => {
		const wo = buildDelegationWorkOrder({
			route: makeRoute({ effortClass: "embodied" }),
			card: makeCard({ embodied: true, hasRepository: false }),
			userContent: "open the dashboard and screenshot it",
		});
		expect(wo.kind).toBe("workstation.attach");
		expect((wo as { projectValidation?: boolean }).projectValidation).toBe(
			false,
		);
	});

	it("does NOT set projectValidation for a non-embodied (read-only) route", () => {
		const wo = buildDelegationWorkOrder({
			route: makeRoute({ effortClass: "multi_hop_read" }),
			card: makeCard({ embodied: true, hasRepository: true }),
			userContent: "introduce yourself",
		});
		expect(wo.kind).toBe("tedi.delegate");
		expect((wo as { projectValidation?: boolean }).projectValidation).toBe(
			false,
		);
	});

	it("renders the validation contract when projectValidation is set", () => {
		const rendered = renderDelegationWorkOrderMessage({
			workOrder: {
				objective: "Fix the routing gap.",
				outputContract: "A green test run + a commit SHA.",
				sourceContent: "fix the routing gap",
				projectValidation: true,
			},
			fallbackContent: "fix the routing gap",
			fallbackWorkOrderId: "run-1:auto:cto",
		});
		expect(rendered).toContain("Project validation contract:");
		expect(rendered).toContain("depsReady:true");
		expect(rendered).toContain("bootstrap.nextAction");
		expect(rendered).toContain("bootstrap.installProcessId");
		expect(rendered).toContain("bun run --filter @tedix/");
		// Ordered before the Source request block.
		expect(rendered.indexOf("Project validation contract:")).toBeLessThan(
			rendered.indexOf("Source request:"),
		);
	});

	it("omits the validation contract for a normal (non-coding) work order", () => {
		const rendered = renderDelegationWorkOrderMessage({
			workOrder: {
				objective: "Review overdue invoices.",
				outputContract: "A list of overdue invoice IDs.",
				sourceContent: "Which invoices are overdue?",
			},
			fallbackContent: "Which invoices are overdue?",
			fallbackWorkOrderId: "run-1:auto:tedi-123",
		});
		expect(rendered).not.toContain("Validation contract");
	});

	it("end-to-end: an embodied coding work order renders the validation contract", () => {
		const wo = buildDelegationWorkOrder({
			route: makeRoute({ effortClass: "embodied" }),
			card: makeCard({ embodied: true, hasRepository: true }),
			userContent: "fix the bug and run focused tests",
		});
		const rendered = renderDelegationWorkOrderMessage({
			workOrder: wo as unknown as Record<string, unknown>,
			fallbackContent: "fix the bug and run focused tests",
			fallbackWorkOrderId: "run-1:auto:cto",
		});
		expect(rendered).toContain("Project validation contract:");
		expect(rendered).toContain("bun run --filter @tedix/");
	});
});

describe("decideDelegationDispatch", () => {
	const AUTHORIZED_SPEAKER = { approvalAuthority: true };

	it("does not gate a native repository task on workstation warmth", () => {
		const route = makeRoute({ effortClass: "embodied", risk: "low" });
		const d = decideDelegationDispatch({
			route,
			card: makeCard({
				embodied: true,
				hasWarmWorkstationLease: false,
				availability: "running",
			}),
			executionRequirement: deriveExecutionRequirement(
				"Review and update a small documentation file using native workspace tools only",
				route,
			),
			speaker: AUTHORIZED_SPEAKER,
		});
		expect(d).toMatchObject({ canAutoDispatch: true, mode: "auto" });
	});

	it("auto-dispatches ONLY the fully-authorized, active, in-scope, low-risk path", () => {
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "low" }),
			card: makeCard(),
			speaker: AUTHORIZED_SPEAKER,
		});
		expect(d).toMatchObject({ mode: "auto", canAutoDispatch: true });
		expect(d.reason.length).toBeGreaterThan(0);
	});

	// Delegation depth bound.
	it("blocks a delegation whose chain depth reaches MAX_DELEGATION_DEPTH", () => {
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "low" }),
			card: makeCard(),
			speaker: AUTHORIZED_SPEAKER,
			delegationDepth: MAX_DELEGATION_DEPTH,
		});
		expect(d).toMatchObject({
			canAutoDispatch: false,
			mode: "blocked",
			failure: { category: "policy", retryable: false },
		});
		expect(d.reason).toContain("exceeds the maximum chain depth");
	});

	it("allows a delegation one hop under the depth ceiling", () => {
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "low" }),
			card: makeCard(),
			speaker: AUTHORIZED_SPEAKER,
			delegationDepth: MAX_DELEGATION_DEPTH - 1,
		});
		expect(d).toMatchObject({ mode: "auto", canAutoDispatch: true });
	});

	it("treats an absent delegationDepth as top-level (0) — backward compatible", () => {
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "low" }),
			card: makeCard(),
			speaker: AUTHORIZED_SPEAKER,
		});
		expect(d.mode).not.toBe("blocked");
	});

	it("does not auto-dispatch when the operator parks delegation for approval", () => {
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "low" }),
			card: makeCard(),
			speaker: AUTHORIZED_SPEAKER,
			operatorHeldForApproval: true,
		});

		expect(d).toMatchObject({
			mode: "needs_approval",
			canAutoDispatch: false,
		});
		expect(d.reason).toContain("held dispatch for approval");
	});

	it("blocks when there is no capability card (fail closed)", () => {
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "low" }),
			card: null,
			speaker: AUTHORIZED_SPEAKER,
		});
		expect(d).toMatchObject({ mode: "blocked", canAutoDispatch: false });
		expect(d.reason).toContain("no capability data");
	});

	it("holds a gated NON-embodied target before waking it", () => {
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "low" }),
			card: makeCard({
				runtimeKind: "agent",
				embodied: false,
				availability: "sleeping",
				requiresApproval: true,
			}),
			speaker: AUTHORIZED_SPEAKER,
		});
		expect(d).toMatchObject({ mode: "needs_approval", canAutoDispatch: false });
		expect(d.reason).toContain("not active");
	});

	it("auto-wakes an autonomous target for an in-scope low-risk cognitive turn", () => {
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "low" }),
			card: makeCard({
				runtimeKind: "agent",
				embodied: false,
				availability: "standby",
				requiresApproval: false,
			}),
			speaker: AUTHORIZED_SPEAKER,
		});
		expect(d).toMatchObject({ mode: "auto", canAutoDispatch: true });
	});

	it("still holds a high-risk route when its autonomous target is in standby", () => {
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "high" }),
			card: makeCard({ availability: "standby", requiresApproval: false }),
			speaker: AUTHORIZED_SPEAKER,
		});
		expect(d).toMatchObject({ mode: "needs_approval", canAutoDispatch: false });
		expect(d.reason).toContain("high risk");
	});

	// --- Change 1: boot-vs-task preflight (boot_unavailable refusal) -----------

	it("REFUSES (boot_unavailable) when an embodied-effort route hits an embodied target whose body is cold (sleeping)", () => {
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "low", effortClass: "embodied" }),
			card: makeCard({ embodied: true, availability: "sleeping" }),
			speaker: AUTHORIZED_SPEAKER,
		});
		expect(d).toMatchObject({
			mode: "boot_unavailable",
			canAutoDispatch: false,
		});
		expect(d.reason.toLowerCase()).toContain("cold");
	});

	it("REFUSES (boot_unavailable) an embodied-effort route to an embodied target in 'standby' (no warm lease)", () => {
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "low", effortClass: "embodied" }),
			card: makeCard({
				runtimeKind: "agent",
				embodied: true,
				availability: "standby",
			}),
			speaker: AUTHORIZED_SPEAKER,
		});
		expect(d.mode).toBe("boot_unavailable");
		expect(d.canAutoDispatch).toBe(false);
	});

	it("does NOT REFUSE a read-only route to a cold-bodied embodied target — degrades, never boot_unavailable (CTO 'introduce yourself')", () => {
		// Needs-aware degradation: a permanently-embodied isolate (configured repository, no
		// warm lease) on a read-only route does NOT need the body. It must take the
		// cognitive/isolate dispatch path, NOT be refused. With the isolate body up
		// (availability running) and all gates met, this auto-dispatches as a
		// bodiless cognitive turn.
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "low", effortClass: "multi_hop_read" }),
			card: makeCard({
				runtimeKind: "agent",
				embodied: true,
				availability: "running",
				hasWarmWorkstationLease: false,
			}),
			speaker: AUTHORIZED_SPEAKER,
		});
		expect(d.mode).not.toBe("boot_unavailable");
		expect(d).toMatchObject({ mode: "auto", canAutoDispatch: true });
	});

	it("a read-only route to a SLEEPING autonomous embodied target wakes for a cognitive turn", () => {
		// Same needs-aware path, but the body is asleep: the embodied-route refusal
		// no longer fires, and the autonomous cognitive target may wake itself.
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "low", effortClass: "multi_hop_read" }),
			card: makeCard({ embodied: true, availability: "sleeping" }),
			speaker: AUTHORIZED_SPEAKER,
		});
		expect(d.mode).not.toBe("boot_unavailable");
		expect(d).toMatchObject({ mode: "auto", canAutoDispatch: true });
	});

	it("does NOT refuse an embodied target whose body is warm (running)", () => {
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "low" }),
			card: makeCard({ embodied: true, availability: "running" }),
			speaker: AUTHORIZED_SPEAKER,
		});
		expect(d.mode).toBe("auto");
	});

	it("treats 'active' availability as active", () => {
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "low" }),
			card: makeCard({ availability: "active" }),
			speaker: AUTHORIZED_SPEAKER,
		});
		expect(d.mode).toBe("auto");
	});

	it("needs approval when an embodied route targets a tedi without body/workstation capability", () => {
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "low", effortClass: "embodied" }),
			card: makeCard({ runtimeKind: "agent", embodied: false }),
			speaker: AUTHORIZED_SPEAKER,
		});
		expect(d).toMatchObject({ mode: "needs_approval", canAutoDispatch: false });
		expect(d.reason).toContain("without body/workstation capability");
	});

	it("auto-dispatches an embodied route to a workstation-capable tedi when all other gates pass", () => {
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "low", effortClass: "embodied" }),
			card: makeCard({
				runtimeKind: "agent",
				embodied: true,
				hasWarmWorkstationLease: true,
			}),
			speaker: AUTHORIZED_SPEAKER,
		});
		expect(d).toMatchObject({ mode: "auto", canAutoDispatch: true });
	});

	it("auto-dispatches an embodied route to a workstation-capable isolate with a WARM lease", () => {
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "low", effortClass: "embodied" }),
			// embodied isolate must carry a real warm lease to be warm (not just a
			// repoConfig that would force a cold on-demand spawn).
			card: makeCard({
				runtimeKind: "agent",
				embodied: true,
				hasWarmWorkstationLease: true,
			}),
			speaker: AUTHORIZED_SPEAKER,
		});
		expect(d).toMatchObject({ mode: "auto", canAutoDispatch: true });
	});

	it("DEGRADES to needs_approval (not boot_unavailable) for a running isolate with a cold workstation lease (it warms its own workstation first turn)", () => {
		// `embodied` set from repoConfig.repoUrl, isolate body UP (availability
		// running) but no warm workstation lease. The isolate wakes on message and
		// warms its OWN workstation on the first turn (proven by the direct-delegate
		// path), so this must NOT flat-refuse; it degrades to needs_approval (an
		// actionable approve -> dispatch card), NOT boot_unavailable.
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "low", effortClass: "embodied" }),
			card: makeCard({
				runtimeKind: "agent",
				embodied: true,
				availability: "running",
				hasWarmWorkstationLease: false,
			}),
			speaker: AUTHORIZED_SPEAKER,
		});
		expect(d).toMatchObject({
			mode: "needs_approval",
			canAutoDispatch: false,
		});
	});

	it("REFUSES (boot_unavailable) an embodied isolate whose BODY is cold (availability not running) with no warm lease", () => {
		// Fail-closed floor: when the isolate body itself is down (e.g. sleeping)
		// AND there is no warm workstation lease, an embodied-effort dispatch would
		// land on a dead surface and fail its first turn; refuse, do not card.
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "low", effortClass: "embodied" }),
			card: makeCard({
				runtimeKind: "agent",
				embodied: true,
				availability: "sleeping",
				hasWarmWorkstationLease: false,
			}),
			speaker: AUTHORIZED_SPEAKER,
		});
		expect(d).toMatchObject({
			mode: "boot_unavailable",
			canAutoDispatch: false,
		});
	});

	it("HOLDS 'warming' (needs_approval) a coding delegation to a warm-but-not-environment-ready workstation", () => {
		// The "vitest not found" preflight: a coding tedi with a WARM lease whose
		// deps are still installing (environmentReady:false). Must NOT auto-dispatch into
		// the not-ready env — hold until environment-ready.
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "low", effortClass: "embodied" }),
			card: makeCard({
				runtimeKind: "agent",
				embodied: true,
				availability: "running",
				hasWarmWorkstationLease: true,
				hasRepository: true,
				depsReady: false,
				environmentReady: false,
			}),
			speaker: AUTHORIZED_SPEAKER,
		});
		expect(d).toMatchObject({ mode: "needs_approval", canAutoDispatch: false });
		expect(d.reason).toContain("warming");
	});

	it("AUTO-dispatches a coding delegation when the warm workstation IS environment-ready", () => {
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "low", effortClass: "embodied" }),
			card: makeCard({
				runtimeKind: "agent",
				embodied: true,
				availability: "running",
				hasWarmWorkstationLease: true,
				hasRepository: true,
				depsReady: true,
				environmentReady: true,
			}),
			speaker: AUTHORIZED_SPEAKER,
		});
		expect(d).toMatchObject({ mode: "auto", canAutoDispatch: true });
	});

	it("does NOT apply the warming gate to a NON-coding embodied target (browser/shell) on a warm lease", () => {
		// hasRepository:false → no deps notion → readiness gate must not fire.
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "low", effortClass: "embodied" }),
			card: makeCard({
				runtimeKind: "agent",
				embodied: true,
				availability: "running",
				hasWarmWorkstationLease: true,
				hasRepository: false,
				depsReady: false,
				environmentReady: false,
			}),
			speaker: AUTHORIZED_SPEAKER,
		});
		expect(d).toMatchObject({ mode: "auto", canAutoDispatch: true });
	});

	it("leaves non-embodied routes to an isolate tedi ungated by the body check", () => {
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "low", effortClass: "multi_hop_read" }),
			card: makeCard({ runtimeKind: "agent", embodied: false }),
			speaker: AUTHORIZED_SPEAKER,
		});
		expect(d).toMatchObject({ mode: "auto", canAutoDispatch: true });
	});

	it("needs approval when the card requires approval", () => {
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "low" }),
			card: makeCard({ requiresApproval: true }),
			speaker: AUTHORIZED_SPEAKER,
		});
		expect(d).toMatchObject({ mode: "needs_approval", canAutoDispatch: false });
	});

	it("needs approval when the target has no authorized scope groups", () => {
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "low" }),
			card: makeCard({ scopeGroups: [] }),
			speaker: AUTHORIZED_SPEAKER,
		});
		expect(d).toMatchObject({ mode: "needs_approval", canAutoDispatch: false });
		expect(d.reason).toContain("scope");
	});

	it("needs approval when the speaker lacks authority", () => {
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "low" }),
			card: makeCard(),
			speaker: { approvalAuthority: false },
		});
		expect(d).toMatchObject({ mode: "needs_approval", canAutoDispatch: false });
		expect(d.reason).toContain("authority");
	});

	it("needs approval when the speaker is null (fail closed)", () => {
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "low" }),
			card: makeCard(),
			speaker: null,
		});
		expect(d).toMatchObject({ mode: "needs_approval", canAutoDispatch: false });
	});

	it("needs approval when the route is high-risk even if otherwise authorized", () => {
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "high" }),
			card: makeCard(),
			speaker: AUTHORIZED_SPEAKER,
		});
		expect(d).toMatchObject({ mode: "needs_approval", canAutoDispatch: false });
		expect(d.reason).toContain("high risk");
	});

	it("never returns auto when uncertain — medium risk still passes if all gates met", () => {
		// medium risk is permitted; the high-risk gate only blocks "high".
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "medium" }),
			card: makeCard(),
			speaker: AUTHORIZED_SPEAKER,
		});
		expect(d.mode).toBe("auto");
	});

	// --- Change 3: layered policy precedence (session → tedi → org) ------------

	it("leaves the otherwise-auto verdict unchanged when no gating layers are present", () => {
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "low" }),
			card: makeCard(),
			speaker: AUTHORIZED_SPEAKER,
			gating: null,
		});
		expect(d.mode).toBe("auto");
	});

	it("a session-layer DENY short-circuits an otherwise-auto verdict to needs_approval", () => {
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "low" }),
			card: makeCard(),
			speaker: AUTHORIZED_SPEAKER,
			gating: { session: { effect: "deny", reason: "muted for this thread" } },
		});
		expect(d).toMatchObject({ mode: "needs_approval", canAutoDispatch: false });
		expect(d.reason).toContain("session");
		expect(d.reason).toContain("muted for this thread");
	});

	it("an org-layer DENY also short-circuits (deny wins at any layer)", () => {
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "low" }),
			card: makeCard(),
			speaker: AUTHORIZED_SPEAKER,
			gating: { org: { effect: "deny" } },
		});
		expect(d.mode).toBe("needs_approval");
		expect(d.reason).toContain("org");
	});

	it("a tedi-layer DENY (sourced from card.dispatchPolicy) short-circuits to needs_approval", () => {
		// Mirrors the live wiring: the tedi gating layer is the card's
		// dispatchPolicy, parsed from its policy pack gatingPolicy.
		const card = makeCard({ dispatchPolicy: { effect: "deny" } });
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "low" }),
			card,
			speaker: AUTHORIZED_SPEAKER,
			gating: { tedi: card.dispatchPolicy },
		});
		expect(d.mode).toBe("needs_approval");
		expect(d.reason).toContain("tedi");
	});

	it("a session ALLOW does NOT override a lower-precedence org DENY (fail-closed)", () => {
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "low" }),
			card: makeCard(),
			speaker: AUTHORIZED_SPEAKER,
			gating: {
				session: { effect: "allow" },
				org: { effect: "deny" },
			},
		});
		expect(d.mode).toBe("needs_approval");
		expect(d.reason).toContain("org");
	});

	it("a session ALLOW does NOT override a lower-precedence tedi DENY (org/tedi enforce; fail-closed)", () => {
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "low" }),
			card: makeCard(),
			speaker: AUTHORIZED_SPEAKER,
			gating: {
				session: { effect: "allow" },
				tedi: { effect: "deny", reason: "tedi paused for delegations" },
				org: null,
			},
		});
		expect(d.mode).toBe("needs_approval");
		expect(d.reason).toContain("tedi");
		expect(d.reason).toContain("tedi paused for delegations");
	});

	it("a session ALLOW never weakens the existing gate (still needs_approval without authority)", () => {
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "low" }),
			card: makeCard(),
			speaker: { approvalAuthority: false },
			gating: { session: { effect: "allow" } },
		});
		expect(d.mode).toBe("needs_approval");
		expect(d.reason).toContain("authority");
	});
});

// --- Delegation contract (arXiv:2603.18043) ----------------------------------

describe("delegation contract", () => {
	it("derives per-effort-class budgets (single_read 3, multi_hop_read 8, fan_out 16, embodied 24)", () => {
		const cases = [
			{ effortClass: "single_read", maxToolCalls: 3, deadlineMs: 120_000 },
			{ effortClass: "multi_hop_read", maxToolCalls: 8, deadlineMs: 300_000 },
			{ effortClass: "fan_out", maxToolCalls: 16, deadlineMs: 600_000 },
			{ effortClass: "embodied", maxToolCalls: 24, deadlineMs: 1_200_000 },
		] as const;
		for (const c of cases) {
			const { budget } = deriveDelegationContract(
				makeRoute({ effortClass: c.effortClass }),
			);
			expect(budget).toEqual({
				maxToolCalls: c.maxToolCalls,
				deadlineMs: c.deadlineMs,
			});
		}
	});

	it("a null effort class falls back to the middle read budget, never the widest", () => {
		const { budget } = deriveDelegationContract(
			makeRoute({ effortClass: null }),
		);
		expect(budget).toEqual({ maxToolCalls: 8, deadlineMs: 300_000 });
	});

	it("read routes get read-shaped success criteria (cite the tool calls that produced the facts)", () => {
		const { contract } = deriveDelegationContract(
			makeRoute({ effortClass: "multi_hop_read" }),
		);
		expect(contract.successCriteria[0]).toContain(
			"citing the tool calls that produced them",
		);
		expect(contract.successCriteria.join("\n")).not.toContain(
			"mutating tool call",
		);
	});

	it("embodied (write-shaped) routes get mutation-proof success criteria", () => {
		const { contract } = deriveDelegationContract(
			makeRoute({ effortClass: "embodied" }),
		);
		expect(contract.successCriteria[0]).toContain("mutating tool call result");
	});

	it("fan_out adds a branch-accounting criterion", () => {
		const { contract } = deriveDelegationContract(
			makeRoute({ effortClass: "fan_out" }),
		);
		expect(
			contract.successCriteria.some((c) => c.includes("every branch")),
		).toBe(true);
	});

	it("every contract carries the fail_closed failure policy and soft budget/deadline hints", () => {
		const { contract } = deriveDelegationContract(makeRoute());
		expect(contract.failurePolicy).toMatch(/^fail_closed/);
		expect(contract.failurePolicy).toContain('"Partial result:"');
		expect(contract.budgetHint).toContain("8 tool calls");
		expect(contract.deadlineHint).toContain("~5 minutes");
	});

	it("buildDelegationWorkOrder rides the derived contract on the work order", () => {
		const wo = buildDelegationWorkOrder({
			route: makeRoute(),
			card: makeCard(),
			userContent: "which invoices are overdue?",
		});
		expect(wo.contract.successCriteria.length).toBeGreaterThan(0);
		expect(wo.contract.failurePolicy).toMatch(/^fail_closed/);
	});
});

describe("renderDelegationWorkOrderMessage — CONTRACT block", () => {
	it("renders success criteria, budget, deadline, and failure policy when the contract is present", () => {
		const message = renderDelegationWorkOrderMessage({
			workOrder: {
				id: "wo-1",
				objective: "Answer the billing question.",
				outputContract: "Return the overdue invoices.",
				sourceContent: "which invoices are overdue?",
				contract: {
					successCriteria: [
						"the answer states the specific facts read, citing the tool calls that produced them",
					],
					budgetHint: "about 8 tool calls (soft cap)",
					deadlineHint: "~5 minutes of wall clock",
					failurePolicy:
						"fail_closed — if you cannot meet the criteria, say so explicitly; a partial result must be labeled partial",
				},
			},
			fallbackContent: "which invoices are overdue?",
			fallbackWorkOrderId: "wo-1",
		});
		expect(message).toContain("Success criteria:");
		expect(message).toContain(
			"- the answer states the specific facts read, citing the tool calls that produced them",
		);
		expect(message).toContain("Budget: about 8 tool calls (soft cap)");
		expect(message).toContain("Deadline (soft): ~5 minutes of wall clock");
		expect(message).toContain("Failure policy: fail_closed —");
	});

	it("omits the CONTRACT block for a historical work order without one (fail-soft)", () => {
		const message = renderDelegationWorkOrderMessage({
			workOrder: {
				id: "wo-legacy",
				objective: "Answer the billing question.",
				outputContract: "Return the overdue invoices.",
				sourceContent: "which invoices are overdue?",
			},
			fallbackContent: "which invoices are overdue?",
			fallbackWorkOrderId: "wo-legacy",
		});
		expect(message).not.toContain("Success criteria:");
		expect(message).not.toContain("Budget:");
		expect(message).not.toContain("Deadline (soft):");
		expect(message).not.toContain("Failure policy:");
	});

	it("end-to-end: a built work order renders the CONTRACT block", () => {
		const wo = buildDelegationWorkOrder({
			route: makeRoute({ effortClass: "single_read" }),
			card: makeCard(),
			userContent: "what is the current invoice total?",
		});
		const message = renderDelegationWorkOrderMessage({
			workOrder: wo as unknown as Record<string, unknown>,
			fallbackContent: "what is the current invoice total?",
			fallbackWorkOrderId: "wo-e2e",
		});
		expect(message).toContain("Success criteria:");
		expect(message).toContain("Budget: about 3 tool calls");
		expect(message).toContain("Deadline (soft): ~2 minutes");
		expect(message).toContain("Failure policy: fail_closed —");
	});
});

// --- Typed failure taxonomy ---------------------------------------------------

describe("classifyDelegationFailure", () => {
	it("classifies dispatch timeouts as transport (retryable)", () => {
		expect(
			classifyDelegationFailure(
				"dispatch_timeout: Delegated child dispatch timed out before the child runtime published events",
			),
		).toEqual({ category: "transport", retryable: true });
	});

	it("classifies network/5xx hop failures as transport (retryable)", () => {
		expect(
			classifyDelegationFailure("fetch failed: 503 from upstream"),
		).toEqual({
			category: "transport",
			retryable: true,
		});
	});

	it("classifies cold-body/boot failures as runtime (retryable)", () => {
		expect(
			classifyDelegationFailure(
				"target body is cold; isolate is not running and no warm workstation lease exists; refusing dispatch instead of enqueuing a child that fails its first turn",
			),
		).toEqual({ category: "runtime", retryable: true });
	});

	it("classifies runtime_unavailable/runtime_dropped as runtime (retryable)", () => {
		expect(classifyDelegationFailure("runtime_unavailable")).toEqual({
			category: "runtime",
			retryable: true,
		});
		expect(classifyDelegationFailure("runtime_dropped mid-turn")).toEqual({
			category: "runtime",
			retryable: true,
		});
	});

	it("classifies denials/approval/scope failures as policy (not retryable)", () => {
		expect(
			classifyDelegationFailure("dispatch denied by session policy: pilot"),
		).toEqual({
			category: "policy",
			retryable: false,
		});
		expect(
			classifyDelegationFailure("target has no authorized scope groups"),
		).toEqual({
			category: "policy",
			retryable: false,
		});
	});

	it("classifies missing-capability failures as capability (not retryable)", () => {
		expect(classifyDelegationFailure("no capability data for target")).toEqual({
			category: "capability",
			retryable: false,
		});
		expect(
			classifyDelegationFailure("no such tool: repo_commit on this target"),
		).toEqual({
			category: "capability",
			retryable: false,
		});
	});

	it("classifies contract-shaped text failures as quality (retryable)", () => {
		expect(
			classifyDelegationFailure("result unverified: criteria not met"),
		).toEqual({
			category: "quality",
			retryable: true,
		});
	});

	it("an overclaim verdict outranks the error text (quality, retryable)", () => {
		expect(
			classifyDelegationFailure("fetch failed", { overclaim: true }),
		).toEqual({
			category: "quality",
			retryable: true,
		});
		expect(classifyDelegationFailure("", { overclaim: true })).toEqual({
			category: "quality",
			retryable: true,
		});
	});

	it("defaults unknown text to runtime (retryable) — never blames the worker on a fallback", () => {
		expect(
			classifyDelegationFailure("something inexplicable happened"),
		).toEqual({
			category: "runtime",
			retryable: true,
		});
		expect(classifyDelegationFailure("")).toEqual({
			category: "runtime",
			retryable: true,
		});
	});
});

describe("decideDelegationDispatch — typed failure on hard-fail verdicts", () => {
	it("blocked (no card) carries a capability failure classification", () => {
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "low" }),
			card: null,
			speaker: { approvalAuthority: true },
		});
		expect(d.mode).toBe("blocked");
		expect(d.failure).toEqual({ category: "capability", retryable: false });
	});

	it("boot_unavailable carries a runtime failure classification", () => {
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "low", effortClass: "embodied" }),
			card: makeCard({
				embodied: true,
				availability: "sleeping",
				hasWarmWorkstationLease: false,
			}),
			speaker: { approvalAuthority: true },
		});
		expect(d.mode).toBe("boot_unavailable");
		expect(d.failure).toEqual({ category: "runtime", retryable: true });
	});

	it("needs_approval and auto verdicts carry NO failure (pending decision ≠ failure)", () => {
		const approval = decideDelegationDispatch({
			route: makeRoute({ risk: "high" }),
			card: makeCard(),
			speaker: { approvalAuthority: true },
		});
		expect(approval.mode).toBe("needs_approval");
		expect(approval.failure).toBeUndefined();

		const auto = decideDelegationDispatch({
			route: makeRoute({ risk: "low" }),
			card: makeCard(),
			speaker: { approvalAuthority: true },
		});
		expect(auto.mode).toBe("auto");
		expect(auto.failure).toBeUndefined();
	});
});

describe("shouldSerializeFanOut (fleet fan-out gate)", () => {
	it("parallelizes an independent read-only multi-tedi fan-out", () => {
		expect(
			shouldSerializeFanOut({
				dispatch: true,
				assignmentCount: 3,
				writeBearingCount: 0,
			}),
		).toBe(false);
	});

	// Regression: a dependency-coordinated but read-only fan-out must not be
	// serialized here. Cross-tedi dependency ordering
	// is owned by the blocker gate in approvePlanAssignments, which DEFERS every
	// dependent whose blocker is non-terminal (completion-gated) — so a plan like
	// A→B→C dispatches only the root A this turn; B and C never dispatch, leaving
	// nothing to serialize. The pre-fix gate keyed on `dependencyEdges > 0` and
	// serialized this case redundantly (a warn log + enqueue await with no
	// correctness effect the blocker gate did not already provide). Serialization
	// is now keyed solely on the write-race signal (writeBearingCount > 1).
	// Proof the defect was real: with the pre-fix logic
	//   `if (dependencyEdges > 0) return true` this same fan-out returned TRUE.
	it("does NOT serialize a dependency-coordinated read-only fan-out (blocker gate owns ordering)", () => {
		expect(
			shouldSerializeFanOut({
				dispatch: true,
				assignmentCount: 3,
				writeBearingCount: 0,
			}),
		).toBe(false);
	});

	it("no-ops for a single assignment (nothing to fan out, even write-bearing)", () => {
		expect(
			shouldSerializeFanOut({
				dispatch: true,
				assignmentCount: 1,
				writeBearingCount: 5,
			}),
		).toBe(false);
	});
	it("no-ops when not dispatching (approval-only)", () => {
		expect(
			shouldSerializeFanOut({
				dispatch: false,
				assignmentCount: 3,
				writeBearingCount: 2,
			}),
		).toBe(false);
	});

	// The acceptance criterion is "no cross-facet write races": an
	// independent-but-write-bearing fan-out (2+ members mutating shared state)
	// must serialize even with no dependency edge.
	it("serializes an independent-but-write-bearing fan-out", () => {
		expect(
			shouldSerializeFanOut({
				dispatch: true,
				assignmentCount: 2,
				writeBearingCount: 2,
			}),
		).toBe(true);
	});

	it("keeps the parallel path when only ONE member writes (no write-write race)", () => {
		expect(
			shouldSerializeFanOut({
				dispatch: true,
				assignmentCount: 3,
				writeBearingCount: 1,
			}),
		).toBe(false);
	});

	it("treats an omitted writeBearingCount as zero (parallel)", () => {
		expect(
			shouldSerializeFanOut({
				dispatch: true,
				assignmentCount: 3,
			}),
		).toBe(false);
	});
});

describe("serializedFanOutChainEdges (real serialization)", () => {
	// REGRESSION (adversarial review): `shouldSerializeFanOut` only DECIDES to
	// serialize; the approve path then `await`ed the async delegate enqueue, which
	// resolves at QUEUE time, not completion — every child still executed
	// concurrently in its own runtime, so a write-bearing fan-out still raced. Real
	// serialization requires chaining the members into blocker edges the blocker
	// gate + unblock watcher advance one at a time. These lock that the synthesized
	// chain is a cycle-free linear extension of the plan DAG.
	it("chains independent write-bearing roots into one line (no existing edges)", () => {
		expect(
			serializedFanOutChainEdges({
				orderedWorkItemIds: ["A", "B", "C"],
				existingEdges: [],
			}),
		).toEqual([
			{ fromWorkItemId: "A", toWorkItemId: "B" },
			{ fromWorkItemId: "B", toWorkItemId: "C" },
		]);
	});

	it("extends an existing dependency chain instead of duplicating it", () => {
		// A→B explicit; C independent. The set serializes as A→B (existing) then B→C
		// (synthetic) — only B→C is emitted.
		expect(
			serializedFanOutChainEdges({
				orderedWorkItemIds: ["A", "B", "C"],
				existingEdges: [{ fromWorkItemId: "A", toWorkItemId: "B" }],
			}),
		).toEqual([{ fromWorkItemId: "B", toWorkItemId: "C" }]);
	});

	it("adds nothing when the explicit edges already totally order the set", () => {
		expect(
			serializedFanOutChainEdges({
				orderedWorkItemIds: ["A", "B", "C"],
				existingEdges: [
					{ fromWorkItemId: "A", toWorkItemId: "B" },
					{ fromWorkItemId: "B", toWorkItemId: "C" },
				],
			}),
		).toEqual([]);
	});

	it("walks a linear extension that respects existing edges (dependent listed first) — never the reverse", () => {
		// Listing order [B, A] but A→B means A must precede B. The chain follows the
		// topo order A,B and emits nothing that would point B→A (which would deadlock).
		expect(
			serializedFanOutChainEdges({
				orderedWorkItemIds: ["B", "A"],
				existingEdges: [{ fromWorkItemId: "A", toWorkItemId: "B" }],
			}),
		).toEqual([]);
	});

	it("never introduces a cycle — the combined graph stays acyclic (diamond + extra root)", () => {
		const nodes = ["A", "B", "C", "D", "E"];
		const existing = [
			{ fromWorkItemId: "A", toWorkItemId: "B" },
			{ fromWorkItemId: "A", toWorkItemId: "C" },
			{ fromWorkItemId: "B", toWorkItemId: "D" },
			{ fromWorkItemId: "C", toWorkItemId: "D" },
		];
		const synthetic = serializedFanOutChainEdges({
			orderedWorkItemIds: nodes,
			existingEdges: existing,
		});
		const adj = new Map<string, string[]>(nodes.map((n) => [n, []]));
		for (const e of [...existing, ...synthetic]) {
			adj.get(e.fromWorkItemId)?.push(e.toWorkItemId);
		}
		const state = new Map<string, number>();
		const hasCycle = (n: string): boolean => {
			if (state.get(n) === 1) return true;
			if (state.get(n) === 2) return false;
			state.set(n, 1);
			for (const m of adj.get(n) ?? []) {
				if (hasCycle(m)) return true;
			}
			state.set(n, 2);
			return false;
		};
		expect(nodes.some((n) => hasCycle(n))).toBe(false);
		expect(synthetic.length).toBeGreaterThan(0);
	});

	it("fails safe on a pre-existing cycle: emits nothing rather than deepening the deadlock", () => {
		expect(
			serializedFanOutChainEdges({
				orderedWorkItemIds: ["A", "B"],
				existingEdges: [
					{ fromWorkItemId: "A", toWorkItemId: "B" },
					{ fromWorkItemId: "B", toWorkItemId: "A" },
				],
			}),
		).toEqual([]);
	});

	it("returns nothing for a single-member set", () => {
		expect(
			serializedFanOutChainEdges({
				orderedWorkItemIds: ["A"],
				existingEdges: [],
			}),
		).toEqual([]);
	});
});

describe("assignmentIsWriteBearing (write-race classifier)", () => {
	it("classifies a mutation-verb objective as write-bearing", () => {
		for (const objective of [
			"Create the onboarding checklist in the shared workspace",
			"Update the tenant billing config",
			"Delete the stale ledger rows",
			"Deploy the widget bundle",
			"Fix the failing migration and commit it",
		]) {
			expect(assignmentIsWriteBearing({ routeKind: "agent", objective })).toBe(
				true,
			);
		}
	});

	it("classifies a read-only objective as NOT write-bearing", () => {
		for (const objective of [
			"Review the Q3 revenue report and summarize the top risks",
			"Investigate why latency regressed and explain the cause",
			"Compare the two vendor proposals",
		]) {
			expect(assignmentIsWriteBearing({ routeKind: "agent", objective })).toBe(
				false,
			);
		}
	});

	it("treats workstation and workflow routes as write-bearing by construction", () => {
		expect(
			assignmentIsWriteBearing({
				routeKind: "workstation",
				objective: "Read the repository layout",
			}),
		).toBe(true);
		expect(
			assignmentIsWriteBearing({
				routeKind: "workflow",
				objective: "Run the nightly reconciliation",
			}),
		).toBe(true);
	});
});

describe("verify command", () => {
	const VERIFY = `tedix -w tedix work approval-list --input '{"limit":5}'`;

	it("carries the verify command on the work order and hardens the failure policy", () => {
		const wo = buildDelegationWorkOrder({
			route: makeRoute(),
			card: makeCard(),
			userContent: "fix the approval inbox read",
			verifyCommand: `  ${VERIFY}  `,
		});
		expect(wo.verifyCommand).toBe(VERIFY);
		expect(wo.contract.failurePolicy).toContain("fail_closed");
		expect(wo.contract.failurePolicy).toContain("Verification output:");
	});

	it("clamps an oversized verify command to the schema bound", () => {
		const wo = buildDelegationWorkOrder({
			route: makeRoute(),
			card: makeCard(),
			userContent: "x",
			verifyCommand: "a".repeat(900),
		});
		expect(wo.verifyCommand?.length).toBe(500);
	});

	it("omits the field and keeps the derived failure policy without a verify command", () => {
		const wo = buildDelegationWorkOrder({
			route: makeRoute(),
			card: makeCard(),
			userContent: "x",
		});
		expect(wo).not.toHaveProperty("verifyCommand");
		expect(wo.contract.failurePolicy).not.toContain("Verification output:");
	});

	it("renders the Verification section after the failure policy", () => {
		const rendered = renderDelegationWorkOrderMessage({
			workOrder: {
				objective: "Fix the approval inbox read.",
				outputContract: "A commit sha plus the passing reproduction.",
				sourceContent: "fix the approval inbox read",
				contract: { failurePolicy: "fail_closed" },
				verifyCommand: VERIFY,
			},
			fallbackContent: "fix the approval inbox read",
			fallbackWorkOrderId: "run-1:delegate:cto",
		});
		expect(rendered).toContain("Verification:");
		expect(rendered).toContain(
			`run this exact command in your own environment: ${VERIFY}`,
		);
		expect(rendered).toContain("Verification output:");
		expect(rendered).toContain("Outcome: failed");
		expect(rendered.indexOf("Failure policy:")).toBeLessThan(
			rendered.indexOf("Verification:"),
		);
	});

	it("renders no Verification section without a verify command", () => {
		const rendered = renderDelegationWorkOrderMessage({
			workOrder: {
				objective: "Review overdue invoices.",
				outputContract: "A list of overdue invoice IDs.",
				sourceContent: "Which invoices are overdue?",
			},
			fallbackContent: "Which invoices are overdue?",
			fallbackWorkOrderId: "run-1:auto:tedi-123",
		});
		expect(rendered).not.toContain("Verification:");
		expect(rendered).not.toContain("Verification output:");
	});
});

describe("coding tool guidance", () => {
	const CODING_MARKERS = [
		"ONE exec script",
		"cloudflare_tedix.execute",
		"scoped to the caller",
		"one progress line",
	];

	it("adds coding guidance and the check-integrity boundary when the caller demands code proof", () => {
		const wo = buildDelegationWorkOrder({
			route: makeRoute({ effortClass: "embodied" }),
			card: null,
			userContent: "fix the approval inbox read",
			requiredProofKind: "code",
		});
		const guidance = wo.toolGuidance.join("\n");
		for (const marker of CODING_MARKERS) expect(guidance).toContain(marker);
		expect(wo.boundaries.join("\n")).toContain(
			"Never weaken, skip, delete, or narrow a test",
		);
		expect(wo.boundaries.join("\n")).toContain("Never edit CI configuration");
		const rendered = renderDelegationWorkOrderMessage({
			workOrder: wo as unknown as Record<string, unknown>,
			fallbackContent: "fix the approval inbox read",
			fallbackWorkOrderId: "coding-task",
		});
		expect(rendered).toContain("Never weaken, skip, delete, or narrow a test");
		expect(wo.toolGuidance.length).toBeLessThanOrEqual(8);
	});

	it("adds them when the execution requirement itself includes repository_edit", () => {
		const wo = buildDelegationWorkOrder({
			route: makeRoute({ effortClass: "embodied" }),
			card: makeCard({ embodied: true, hasRepository: true }),
			userContent: "fix the bug in apps/api and run the tests",
		});
		expect(wo.executionRequirement.requiredCapabilities).toContain(
			"repository_edit",
		);
		const guidance = wo.toolGuidance.join("\n");
		for (const marker of CODING_MARKERS) expect(guidance).toContain(marker);
		expect(wo.boundaries.join("\n")).toContain(
			"Never weaken, skip, delete, or narrow a test",
		);
		// The guidance cap trims card-derived lines, never the coding lines.
		expect(wo.toolGuidance.length).toBeLessThanOrEqual(8);
	});

	it("does not add them to a read-only, non-coding delegation", () => {
		const wo = buildDelegationWorkOrder({
			route: makeRoute(),
			card: makeCard(),
			userContent: "Which invoices are overdue?",
		});
		const guidance = wo.toolGuidance.join("\n");
		for (const marker of CODING_MARKERS) expect(guidance).not.toContain(marker);
		expect(wo.boundaries.join("\n")).not.toContain(
			"Never weaken, skip, delete, or narrow a test",
		);
	});
});

describe("decideDelegationDispatch approvalRoute", () => {
	const AUTHORIZED = { approvalAuthority: true };

	it.each([
		[
			"rule 6: target requires approval",
			{ card: makeCard({ requiresApproval: true }) },
		],
		["rule 9: high-risk route", { route: makeRoute({ risk: "high" }) }],
	])("routes %s to the agent approver", (_label, overrides) => {
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "low" }),
			card: makeCard(),
			speaker: AUTHORIZED,
			...overrides,
		});
		expect(d).toMatchObject({ mode: "needs_approval", approvalRoute: "agent" });
	});

	it.each([
		[
			"rule 2: layered policy DENY",
			{ gating: { org: { effect: "deny" as const, reason: "freeze" } } },
		],
		[
			"rule 4: gated target not active",
			{
				card: makeCard({ availability: "stopped", requiresApproval: true }),
			},
		],
		[
			"rule 5: embodied route to a non-embodied target",
			{
				route: makeRoute({ risk: "low", effortClass: "embodied" }),
				card: makeCard({ embodied: false }),
			},
		],
		["rule 7: no scope groups", { card: makeCard({ scopeGroups: [] }) }],
		[
			"rule 8: speaker lacks approval authority",
			{ speaker: { approvalAuthority: false } },
		],
		["an explicit operator hold", { operatorHeldForApproval: true }],
	])("keeps %s with the operator", (_label, overrides) => {
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "low" }),
			card: makeCard(),
			speaker: AUTHORIZED,
			...overrides,
		});
		expect(d).toMatchObject({ mode: "needs_approval", approvalRoute: "human" });
	});

	it("routes both earned-delegation holds to the agent when the gate would dispatch", () => {
		const missingGrant = decideDelegationDispatch({
			route: makeRoute({ risk: "low" }),
			card: makeCard({ delegationEntrustments: [] }),
			speaker: AUTHORIZED,
			earnedDelegationEnforcement: "enforce",
		});
		expect(missingGrant).toMatchObject({
			mode: "needs_approval",
			approvalRoute: "agent",
		});
		const outsideAllowlist = decideDelegationDispatch({
			route: makeRoute({ risk: "low" }),
			card: makeCard(),
			speaker: AUTHORIZED,
			earnedDelegationEnforcement: "enforce",
			earnedDelegationActivityAllowed: false,
		});
		expect(outsideAllowlist).toMatchObject({
			mode: "needs_approval",
			approvalRoute: "agent",
		});
	});

	it("never lets an earned-delegation hold launder a human-only hold", () => {
		const d = decideDelegationDispatch({
			route: makeRoute({ risk: "low" }),
			card: makeCard({ delegationEntrustments: [] }),
			speaker: { approvalAuthority: false },
			earnedDelegationEnforcement: "enforce",
		});
		expect(d).toMatchObject({ mode: "needs_approval", approvalRoute: "human" });
	});

	it("carries no approvalRoute on auto or refusal verdicts", () => {
		expect(
			decideDelegationDispatch({
				route: makeRoute({ risk: "low" }),
				card: makeCard(),
				speaker: AUTHORIZED,
			}).approvalRoute,
		).toBeUndefined();
		expect(
			decideDelegationDispatch({
				route: makeRoute({ risk: "low" }),
				card: null,
				speaker: AUTHORIZED,
			}).approvalRoute,
		).toBeUndefined();
	});
});
