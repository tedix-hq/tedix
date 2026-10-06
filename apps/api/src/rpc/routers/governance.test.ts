import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import {
	buildDecisionRightsMatrix,
	governanceContractRouter,
} from "./governance";
import {
	AGENT_UNREACHABLE_CAPABILITY_FIELDS,
	agentUnreachableCapabilityFieldsTouched,
} from "./tedis/crud";

const mocks = vi.hoisted(() => ({
	countPendingApprovalsByTedi: vi.fn(),
	countReviewFlaggedSkillsByTedi: vi.fn(),
	summarizeCronExecutionsByTedi: vi.fn(),
	listGovernanceAuditEvents: vi.fn(),
	getSkillPortfolioBalance: vi.fn(),
	getSkillPortfolioBalanceByTedi: vi.fn(),
	listObjectives: vi.fn(),
	getTedisByOrganization: vi.fn(),
}));

vi.mock("@tedix/db/queries/governance-overview", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@tedix/db/queries/governance-overview")
		>();
	return {
		...actual,
		countPendingApprovalsByTedi: mocks.countPendingApprovalsByTedi,
		countReviewFlaggedSkillsByTedi: mocks.countReviewFlaggedSkillsByTedi,
		summarizeCronExecutionsByTedi: mocks.summarizeCronExecutionsByTedi,
		listGovernanceAuditEvents: mocks.listGovernanceAuditEvents,
	};
});

vi.mock("@tedix/db/queries/skill-portfolio", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@tedix/db/queries/skill-portfolio")>();
	return {
		...actual,
		getSkillPortfolioBalance: mocks.getSkillPortfolioBalance,
		getSkillPortfolioBalanceByTedi: mocks.getSkillPortfolioBalanceByTedi,
	};
});

vi.mock("@tedix/db/queries/tedi-objectives", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@tedix/db/queries/tedi-objectives")>();
	return { ...actual, listObjectives: mocks.listObjectives };
});

vi.mock("@tedix/db/queries/tedis", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@tedix/db/queries/tedis")>();
	return { ...actual, getTedisByOrganization: mocks.getTedisByOrganization };
});

const ORG_ID = "org-1";

const EMPTY_PORTFOLIO = {
	totalSkills: 0,
	layers: {
		innovation: { count: 0, share: 0, healthyShare: 0.05, deviation: -0.05 },
		differentiation: { count: 0, share: 0, healthyShare: 0.2, deviation: -0.2 },
		record: { count: 0, share: 0, healthyShare: 0.75, deviation: -0.75 },
	},
	healthyEnvelope: { record: 0.75, differentiation: 0.2, innovation: 0.05 },
	stagnation: false,
	stagnationKind: null,
};

function createContext(): BaseContext {
	return {
		authType: "user",
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		organizationId: ORG_ID,
		userRole: "member",
		rateLimiter: {
			limit: vi.fn(async () => ({ success: true })),
		} as unknown as RateLimit,
		url: new URL("https://api.tedix.test/rpc/governance"),
		user: {
			aud: "test",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			sub: "user-1",
			dct: "tenant-1",
			permissions: [],
			roles: [],
		},
	};
}

/**
 * Agent-class caller: the production MCP-edge path — trusted service binding
 * forwarding a tedi identity. Fails isLifecycleOverrideAuthority, so the
 * governance overview redacts its gap enumeration (A7).
 */
function createAgentContext(): BaseContext {
	return {
		authType: "service-binding",
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers({
			"X-Service-Binding": "true",
			"X-Tedix-Mcp-Tool-Id": "governance:overview",
			"X-Tedix-Tedi-Scopes": "mcp:memory",
		}),
		organizationId: ORG_ID,
		tediId: "tedi-1",
		tediScopes: ["mcp:memory"],
		rateLimiter: {
			limit: vi.fn(async () => ({ success: true })),
		} as unknown as RateLimit,
		url: new URL("https://api.tedix.test/rpc/governance"),
		user: undefined,
	} as BaseContext;
}

function createClient(context: BaseContext) {
	return createRouterClient(governanceContractRouter, { context });
}

// =============================================================================
// Decision-rights matrix — every cell derived, none aspirational
// =============================================================================

describe("buildDecisionRightsMatrix", () => {
	const matrix = buildDecisionRightsMatrix();
	const controls = matrix.flatMap((row) => row.controls);

	it("covers exactly the five Weill & Ross domains, in order", () => {
		expect(matrix.map((row) => row.domain)).toEqual([
			"ai_principles",
			"architecture",
			"infrastructure",
			"application_needs",
			"investment",
		]);
	});

	it("every control carries enforcedBy XOR an honest ungoverned/unenforced status", () => {
		for (const control of controls) {
			const honest =
				control.status === "ungoverned" ||
				control.status === "declared_unenforced";
			if (control.enforcedBy === null) {
				expect(honest, `"${control.surface}" has no enforcedBy`).toBe(true);
			} else {
				expect(honest, `"${control.surface}" cites enforcement`).toBe(false);
				// A citation must point at real code: a named construct (usually a
				// function) plus the file that enforces it.
				expect(control.enforcedBy).toMatch(/\w+(\(\)|Schema)/);
				expect(control.enforcedBy).toMatch(/(apps|packages)\/[\w/-]+\.ts/);
			}
		}
	});

	it("names its ungoverned surfaces plainly (SOUL directives, tedi budgets)", () => {
		const ungoverned = controls.filter((c) => c.status === "ungoverned");
		expect(ungoverned.some((c) => c.surface.includes("personality"))).toBe(
			true,
		);
		expect(ungoverned.some((c) => c.surface.includes("budgets"))).toBe(true);
	});

	it("capability-tier cells match the live allowlist gate", () => {
		// The gate itself: agents (and every unproven identity) fail closed;
		// only human/apikey pass. The matrix cells must say exactly that.
		const allFields = Object.fromEntries(
			AGENT_UNREACHABLE_CAPABILITY_FIELDS.map((field) => [field, {}]),
		);
		expect(agentUnreachableCapabilityFieldsTouched("tedi", allFields)).toEqual([
			...AGENT_UNREACHABLE_CAPABILITY_FIELDS,
		]);
		expect(
			agentUnreachableCapabilityFieldsTouched(undefined, allFields),
		).toEqual([...AGENT_UNREACHABLE_CAPABILITY_FIELDS]);
		expect(agentUnreachableCapabilityFieldsTouched("user", allFields)).toEqual(
			[],
		);
		expect(
			agentUnreachableCapabilityFieldsTouched("apikey", allFields),
		).toEqual([]);

		const gateCells = controls.filter((c) =>
			c.enforcedBy?.includes("agentUnreachableCapabilityFieldsTouched"),
		);
		expect(gateCells.length).toBeGreaterThanOrEqual(2);
		for (const cell of gateCells) {
			expect(cell.decide).toEqual(["human", "apikey"]);
			expect(cell.status).toBe("enforced");
		}
		// Every gated field appears on some cell's surface.
		const surfaces = gateCells.map((c) => c.surface).join(" ");
		for (const field of AGENT_UNREACHABLE_CAPABILITY_FIELDS) {
			expect(surfaces).toContain(field);
		}
	});

	it("disposer separation and force overrides cite their enforcement points", () => {
		const promotion = controls.find((c) =>
			c.surface.includes("apply_skill_proposal"),
		);
		expect(promotion?.enforcedBy).toContain("skillProposalApplyAuthority()");
		expect(promotion?.enforcedBy).toContain(
			"assertForcedSkillPromotionAuthority()",
		);
		expect(promotion?.decide).toContain("tedi:non_author (with mcp:skills)");

		const force = controls.find((c) =>
			c.surface.includes("Forced lifecycle override"),
		);
		expect(force?.enforcedBy).toContain("isLifecycleOverrideAuthority()");
		expect(force?.decide).toEqual(["human", "apikey"]);
	});
});

// =============================================================================
// Overview handler — expected shape on an empty org
// =============================================================================

describe("governance.overview", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getTedisByOrganization.mockResolvedValue([]);
		mocks.getSkillPortfolioBalance.mockResolvedValue(EMPTY_PORTFOLIO);
		mocks.getSkillPortfolioBalanceByTedi.mockResolvedValue(new Map());
		mocks.countPendingApprovalsByTedi.mockResolvedValue([]);
		mocks.countReviewFlaggedSkillsByTedi.mockResolvedValue([]);
		mocks.summarizeCronExecutionsByTedi.mockResolvedValue([]);
		mocks.listObjectives.mockResolvedValue({ data: [], total: 0 });
		mocks.listGovernanceAuditEvents.mockResolvedValue([]);
	});

	it("responds with the full one-pager shape on an empty org", async () => {
		const client = createClient(createContext());
		const overview = await client.overview({});

		expect(overview.organizationId).toBe(ORG_ID);
		expect(overview.decisionRights).toHaveLength(5);
		expect(overview.doctrine).toContain("Allowlist doctrine");
		expect(overview.tedis).toEqual([]);
		expect(overview.tediTotal).toBe(0);
		expect(overview.tedisTruncated).toBe(false);
		expect(overview.orgSkillPortfolio.totalSkills).toBe(0);
		expect(overview.orgScopedReviewFlaggedSkills).toBe(0);
		expect(overview.pendingApprovalsTotal).toBe(0);
		expect(overview.recentEvents).toEqual([]);
		expect(overview.eventCoverage.auditedActions).toContain(
			"tedi.config_change",
		);
		expect(overview.eventCoverage.notRecorded.length).toBeGreaterThan(0);
	});

	it("assembles per-tedi gates, counts, and merged events", async () => {
		mocks.getTedisByOrganization.mockResolvedValue([
			{ id: "tedi-1", slug: "cto", name: "CTO", displayName: null },
		]);
		mocks.listObjectives.mockResolvedValue({
			data: [
				{
					id: "obj-1",
					tediId: "tedi-1",
					orgId: ORG_ID,
					title: "Keep deploys green",
					type: "standing",
					status: "active",
					gateConfig: {
						autonomyLevel: "supervised",
						gateType: "first_n",
						graduationCriteria: { consecutiveSuccesses: 3, minComplexity: 2 },
						currentStreak: 2,
						lastGraduatedAt: "2026-07-15T10:00:00.000Z",
					},
				},
			],
			total: 1,
		});
		mocks.countPendingApprovalsByTedi.mockResolvedValue([
			{ tediId: "tedi-1", count: 2 },
		]);
		mocks.countReviewFlaggedSkillsByTedi.mockResolvedValue([
			{ tediId: "tedi-1", count: 1 },
			{ tediId: null, count: 3 },
		]);
		mocks.summarizeCronExecutionsByTedi.mockResolvedValue([
			{
				tediId: "tedi-1",
				fires: 6,
				failures: 1,
				lastFireAt: "2026-07-16T09:00:00.000Z",
			},
		]);
		mocks.listGovernanceAuditEvents.mockResolvedValue([
			{
				action: "tedi.config_change",
				actorId: "user-1",
				actorType: "user",
				resourceType: "tedi",
				resourceId: "tedi-1",
				timestamp: new Date("2026-07-16T08:00:00.000Z"),
				metadata: null,
			},
		]);
		mocks.getSkillPortfolioBalanceByTedi.mockResolvedValue(
			new Map([
				[
					"tedi-1",
					{
						...EMPTY_PORTFOLIO,
						totalSkills: 3,
						layers: {
							...EMPTY_PORTFOLIO.layers,
							differentiation: {
								...EMPTY_PORTFOLIO.layers.differentiation,
								count: 3,
							},
						},
					},
				],
			]),
		);

		const client = createClient(createContext());
		const overview = await client.overview({});

		expect(overview.tedis).toHaveLength(1);
		const tedi = overview.tedis[0];
		expect(tedi).toMatchObject({
			tediId: "tedi-1",
			slug: "cto",
			name: "CTO",
			pendingApprovals: 2,
			reviewFlaggedSkills: 1,
			skillPortfolio: {
				totalSkills: 3,
				innovation: 0,
				differentiation: 3,
				record: 0,
			},
			cronExecutions24h: {
				fires: 6,
				failures: 1,
				lastFireAt: "2026-07-16T09:00:00.000Z",
			},
		});
		expect(tedi?.objectives.activeTotal).toBe(1);
		expect(tedi?.objectives.byGateType).toEqual({ first_n: 1 });
		expect(tedi?.objectives.byAutonomyLevel).toEqual({ supervised: 1 });
		expect(tedi?.objectives.gates[0]).toMatchObject({
			objectiveId: "obj-1",
			gateType: "first_n",
			autonomyLevel: "supervised",
			currentStreak: 2,
			consecutiveSuccessesRequired: 3,
			minComplexity: 2,
		});
		expect(overview.orgScopedReviewFlaggedSkills).toBe(3);
		expect(overview.pendingApprovalsTotal).toBe(2);

		// Merged feed: derived graduation (2026-07-15) sorts after the audit
		// row (2026-07-16), newest first.
		expect(overview.recentEvents.map((event) => event.kind)).toEqual([
			"tedi.config_change",
			"gate_graduation",
		]);
	});
});

// =============================================================================
// Gap redaction: the ungoverned/declared_unenforced enumeration is an
// attack map for the governed workers; operators see everything, agent-class
// callers get the rows with those cells' detail replaced by "restricted".
// =============================================================================

describe("governance.overview gap redaction (A7)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getTedisByOrganization.mockResolvedValue([]);
		mocks.getSkillPortfolioBalance.mockResolvedValue(EMPTY_PORTFOLIO);
		mocks.getSkillPortfolioBalanceByTedi.mockResolvedValue(new Map());
		mocks.countPendingApprovalsByTedi.mockResolvedValue([]);
		mocks.countReviewFlaggedSkillsByTedi.mockResolvedValue([]);
		mocks.summarizeCronExecutionsByTedi.mockResolvedValue([]);
		mocks.listObjectives.mockResolvedValue({ data: [], total: 0 });
		mocks.listGovernanceAuditEvents.mockResolvedValue([]);
	});

	it("agent-class callers see every gap cell as restricted", async () => {
		const client = createClient(createAgentContext());
		const overview = await client.overview({});

		const controls = overview.decisionRights.flatMap((row) => row.controls);
		const gaps = controls.filter(
			(control) =>
				control.status === "ungoverned" ||
				control.status === "declared_unenforced",
		);
		expect(gaps.length).toBeGreaterThan(0);
		for (const gap of gaps) {
			expect(gap.surface).toBe("restricted");
			expect(gap.notes).toBe("restricted");
			expect(gap.decide).toEqual([]);
			expect(gap.propose).toEqual([]);
			expect(gap.enforcedBy).toBeNull();
		}

		const serialized = JSON.stringify(overview.decisionRights);
		// The two named ungoverned surfaces must not leak their detail.
		expect(serialized).not.toContain("personality");
		expect(serialized).not.toContain("spend ceilings");
		// Enforced cells stay fully legible — worker legibility of the gates
		// that bind them is the point of this surface.
		expect(serialized).toContain("skillProposalApplyAuthority()");
		expect(overview.decisionRights).toHaveLength(5);
	});

	it("operators (user JWT / API key) see the full gap enumeration", async () => {
		const client = createClient(createContext());
		const overview = await client.overview({});
		const serialized = JSON.stringify(overview.decisionRights);
		expect(serialized).toContain("personality");
		expect(serialized).toContain("an agent can raise its own spend ceilings");
	});
});
