import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { KernelContext } from "./context-assembly";
import {
	createJevDelegationRanker,
	refineDelegationFit,
} from "./jev-delegation-fit";
import type { KernelRouteDecision } from "./route-schema";

const mocks = vi.hoisted(() => ({ org: vi.fn(), judge: vi.fn() }));
vi.mock("@tedix/db/queries/organizations", () => ({
	getOrganizationById: mocks.org,
}));
vi.mock("../../../services/jev-judgment", () => ({
	executeJevJudgment: mocks.judge,
	JevUsagePersistenceError: class extends Error {},
}));

beforeEach(() => {
	vi.clearAllMocks();
	mocks.org.mockResolvedValue({ metadata: {} });
	mocks.judge.mockResolvedValue({
		answers: {
			which: {
				type: "choice",
				probabilities: { c0: 0.1, c1: 0.9 },
			},
			fits0: { type: "noul", noul: 0.7 },
			fits1: { type: "noul", noul: 0.9 },
		},
	});
});

const tedis = [
	{
		id: "finance",
		slug: "cfo",
		name: "CFO",
		capability: {
			availability: "running",
			embodied: false,
			apps: ["globex"],
			scopeGroups: ["invoice:read"],
			skills: ["reconcile-invoices"],
		},
	},
	{
		id: "engineering",
		slug: "cto",
		name: "CTO",
		capability: {
			availability: "running",
			embodied: true,
			apps: ["github"],
			scopeGroups: ["repository:read"],
			skills: ["review-code"],
		},
	},
] as unknown as KernelContext["tedis"];

const context: KernelContext = {
	tedis,
	apps: [],
	workflows: [],
	workItems: [],
	facts: [],
	rationale: [],
	speaker: null,
	history: [],
};

const route: KernelRouteDecision = {
	routeKind: "delegate_tedi",
	answer: null,
	rationale: "Finance owns this request.",
	risk: "low",
	confidence: 0.8,
	effortClass: "single_read",
	targetTediId: "finance",
	targetTediLabel: "CFO",
	targetActivityId: "finance-activity",
	plannedToolIds: ["globex.list_invoices"],
	toolIntent: null,
	workflowHint: null,
	clarifyingQuestion: null,
	evidenceExpectation: "Recent commits",
};

describe("refineDelegationFit", () => {
	it("promotes only an already visible capable target and clears old target authority", async () => {
		const ranker = vi.fn().mockResolvedValue(["engineering", "finance"]);
		const result = await refineDelegationFit({
			content: "Find the last five GitHub commits",
			context,
			decision: route,
			ranker,
		});
		expect(ranker).toHaveBeenCalledWith({
			kind: "tedi",
			query: "Find the last five GitHub commits",
			candidates: expect.arrayContaining([
				expect.objectContaining({ id: "engineering" }),
			]),
		});
		expect(result).toMatchObject({
			targetTediId: "engineering",
			targetTediLabel: "CTO",
			targetActivityId: null,
			plannedToolIds: [],
		});
	});

	it("preserves the planner decision when the operator names a tedi", async () => {
		const ranker = vi.fn();
		const result = await refineDelegationFit({
			content: "Have the CFO find recent GitHub commits",
			context,
			decision: route,
			ranker,
		});
		expect(result).toBe(route);
		expect(ranker).not.toHaveBeenCalled();
	});

	it("does not let semantic ranking displace unique provider ownership", async () => {
		const ranker = vi.fn();
		const result = await refineDelegationFit({
			content: "Find recent GitHub commits",
			context: {
				...context,
				apps: [{ slug: "github", name: "GitHub" }],
			},
			decision: { ...route, targetTediId: "engineering" },
			ranker,
		});
		expect(result.targetTediId).toBe("engineering");
		expect(ranker).not.toHaveBeenCalled();
	});

	it("rejects an invalid ranking and never adds a target from outside the roster", async () => {
		for (const order of [null, ["unknown", "finance"], ["engineering"]]) {
			const result = await refineDelegationFit({
				content: "Find the last five GitHub commits",
				context,
				decision: route,
				ranker: async () => order,
			});
			expect(result).toBe(route);
		}
	});

	it("does not rank a workstation task against a tedi without an embodied capability", async () => {
		const ranker = vi.fn();
		const result = await refineDelegationFit({
			content: "Run a browser session to review the website",
			context,
			decision: { ...route, targetTediId: "engineering" },
			ranker,
		});
		expect(result.targetTediId).toBe("engineering");
		expect(ranker).not.toHaveBeenCalled();
	});

	it("updates the handoff copy when semantic fit changes its target", async () => {
		const result = await refineDelegationFit({
			content: "Discuss the GitHub architecture over several sessions",
			context,
			decision: {
				...route,
				routeKind: "suggest_handoff",
				answer: "Open a session with the CFO.",
			},
			ranker: async () => ["engineering", "finance"],
		});
		expect(result.answer).toContain("CTO");
		expect(result.answer).not.toContain("CFO");
	});

	it("clears a stale named answer when Jev changes a delegated target", async () => {
		const result = await refineDelegationFit({
			content: "Read a Work Item and summarize its accepted outcome",
			context,
			decision: {
				...route,
				targetTediId: "engineering",
				targetTediLabel: "CTO",
				answer: "I'll have the CTO read the Work Item.",
			},
			ranker: async () => ["finance", "engineering"],
		});
		expect(result).toMatchObject({
			targetTediId: "finance",
			targetTediLabel: "CFO",
			answer: null,
			targetActivityId: null,
			plannedToolIds: [],
		});
	});

	it("keeps an ungated planner target when the other candidate requires approval", async () => {
		const ranker = vi.fn();
		const decision = {
			...route,
			targetTediId: "engineering",
			targetTediLabel: "CTO",
		};
		const result = await refineDelegationFit({
			content: "Read a Work Item and summarize its accepted outcome",
			context: {
				...context,
				tedis: [
					{
						...tedis[0],
						capability: {
							...tedis[0]!.capability!,
							availability: "standby",
							requiresApproval: true,
						},
					},
					{
						...tedis[1],
						capability: {
							...tedis[1]!.capability!,
							requiresApproval: false,
						},
					},
				],
			},
			decision,
			ranker,
		});
		expect(result).toBe(decision);
		expect(ranker).not.toHaveBeenCalled();
	});

	it("still considers an autonomous standby candidate without an approval gate", async () => {
		const ranker = vi.fn().mockResolvedValue(["finance", "engineering"]);
		const result = await refineDelegationFit({
			content: "Read a Work Item and summarize its accepted outcome",
			context: {
				...context,
				tedis: [
					{
						...tedis[0],
						capability: {
							...tedis[0]!.capability!,
							availability: "standby",
							requiresApproval: false,
						},
					},
					{
						...tedis[1],
						capability: {
							...tedis[1]!.capability!,
							requiresApproval: false,
						},
					},
				],
			},
			decision: { ...route, targetTediId: "engineering" },
			ranker,
		});
		expect(ranker).toHaveBeenCalledOnce();
		expect(result.targetTediId).toBe("finance");
	});
});

describe("createJevDelegationRanker", () => {
	const input = {
		kind: "tedi" as const,
		query: "Investigate the deployment",
		candidates: [
			{ id: "finance", description: "CFO finance" },
			{ id: "engineering", description: "CTO engineering" },
		],
	};
	it("judges by default even when the separate context-ranking purpose is disabled", async () => {
		mocks.org.mockResolvedValue({
			metadata: {
				jev: { purposes: { contextRanking: { enabled: false } } },
			},
		});
		const ranker = createJevDelegationRanker({} as never, {} as never, {
			organizationId: "org-1",
		});
		expect(await ranker(input)).toEqual(["engineering", "finance"]);
		expect(mocks.judge).toHaveBeenCalledWith(
			expect.objectContaining({
				source: "kernel:delegation-fit",
				billingSource: "kernel",
				sessionType: "kernel",
				transport: "cloudflare",
			}),
		);
	});

	it("honors an explicit organization-wide Jev denial", async () => {
		mocks.org.mockResolvedValue({ metadata: { jev: { enabled: false } } });
		const ranker = createJevDelegationRanker({} as never, {} as never, {
			organizationId: "org-1",
		});
		expect(await ranker(input)).toBeNull();
		expect(mocks.judge).not.toHaveBeenCalled();
	});

	it("does not dispatch paid inference when organization policy cannot be read", async () => {
		mocks.org.mockRejectedValue(new Error("D1 unavailable"));
		const ranker = createJevDelegationRanker({} as never, {} as never, {
			organizationId: "org-1",
		});
		expect(await ranker(input)).toBeNull();
		expect(mocks.judge).not.toHaveBeenCalled();
	});
});
