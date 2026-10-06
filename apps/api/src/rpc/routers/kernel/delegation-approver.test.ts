import type { DbClient } from "@tedix/db/client";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	agentReviewIsPending,
	readHomeDelegationAgentReview,
	renderHeldDelegationLine,
	resolveDelegationApprover,
} from "./delegation-approver";

const ORG_ID = "org-1";
const CTO = {
	id: "tedi-cto",
	organizationId: ORG_ID,
	name: "CTO",
	slug: "cto",
	status: "active",
	retiredAt: null,
};

function dbWith(row: Record<string, unknown> | undefined): DbClient {
	return {
		query: { tedis: { findFirst: vi.fn(async () => row) } },
	} as unknown as DbClient;
}

function tediService(
	nativeTools: string[] = ["list_work_approval_inbox", "decide_work_approval"],
) {
	return {
		fetch: vi.fn(async () => Response.json({ nativeTools })),
	} as unknown as Fetcher;
}

function resolve(
	overrides: Partial<Parameters<typeof resolveDelegationApprover>[0]> = {},
) {
	return resolveDelegationApprover({
		db: dbWith(CTO),
		env: { TEDI_SERVICE: tediService(), ENVIRONMENT: "production" },
		organizationId: ORG_ID,
		designation: { type: "tedi", id: "tedi-cto" },
		targetTediId: "tedi-cpo",
		...overrides,
	});
}

describe("resolveDelegationApprover", () => {
	it("resolves an active, independent, capable approver tedi", async () => {
		const service = tediService();
		await expect(
			resolve({ env: { TEDI_SERVICE: service, ENVIRONMENT: "production" } }),
		).resolves.toEqual({
			approver: { tediId: "tedi-cto", label: "CTO" },
			reason: null,
		});
		const request = (service.fetch as ReturnType<typeof vi.fn>).mock
			.calls[0]?.[0] as Request;
		expect(new URL(request.url).pathname).toBe("/hooks/review-capabilities");
		expect(request.headers.get("X-Tedix-Host")).toBe("cto.tedi.tedix.dev");
	});

	it.each([
		["no designation", { designation: null }, /no delegation approver/],
		[
			"the approver is the target",
			{ targetTediId: "tedi-cto" },
			/delegation target/,
		],
		[
			"the approver is the delegating parent",
			{ delegationDepth: 1, parentTediId: "tedi-cto" },
			/delegating parent/,
		],
		[
			"a nested delegation with no known parent",
			{ delegationDepth: 1, parentTediId: null },
			/cannot prove approver independence/,
		],
		[
			"the approver requested the delegation",
			{ requesterTediId: "tedi-cto" },
			/requested this delegation/,
		],
		[
			"the tedi is unknown",
			{ db: dbWith(undefined) },
			/not a tedi of this org/,
		],
		[
			"the tedi is retired",
			{ db: dbWith({ ...CTO, retiredAt: "2026-09-01T00:00:00.000Z" }) },
			/not a tedi of this org/,
		],
		[
			"the tedi is inactive",
			{ db: dbWith({ ...CTO, status: "paused" }) },
			/not active/,
		],
		[
			"the tedi runtime is unbound",
			{ env: { ENVIRONMENT: "production" } },
			/runtime is unavailable/,
		],
		[
			"the tedi lacks the native approval tools",
			{
				env: {
					TEDI_SERVICE: tediService(["list_work_approval_inbox"]),
					ENVIRONMENT: "production",
				},
			},
			/capability preflight: .*decide_work_approval/,
		],
	])(
		"falls back to the operator when %s",
		async (_label, overrides, reason) => {
			const result = await resolve(overrides);
			expect(result.approver).toBeNull();
			expect(result.reason).toMatch(reason);
		},
	);

	it("allows a nested delegation whose parent is a different tedi", async () => {
		const result = await resolve({
			delegationDepth: 2,
			parentTediId: "tedi-ops",
		});
		expect(result.approver?.tediId).toBe("tedi-cto");
	});
});

describe("agent review helpers", () => {
	it("renders the approver line only when an approver is engaged", () => {
		expect(renderHeldDelegationLine("CPO", "CTO")).toContain(
			"routed the decision to CTO",
		);
		expect(renderHeldDelegationLine("CPO", null)).toContain(
			"approve this Home run",
		);
	});

	it("treats a pending review as pending only until it expires", () => {
		const review = readHomeDelegationAgentReview({
			agentReview: {
				status: "pending",
				approverTediId: "tedi-cto",
				approverTediLabel: "CTO",
				expiresAt: "2026-09-26T12:00:00.000Z",
			},
		});
		expect(
			agentReviewIsPending(review, Date.parse("2026-09-26T11:00:00.000Z")),
		).toBe(true);
		expect(
			agentReviewIsPending(review, Date.parse("2026-09-26T12:00:00.000Z")),
		).toBe(false);
		expect(agentReviewIsPending({ ...review!, status: "rejected" }, 0)).toBe(
			false,
		);
		expect(
			readHomeDelegationAgentReview({ agentReview: { status: "x" } }),
		).toBe(null);
	});
});
