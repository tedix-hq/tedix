import { describe, expect, it } from "vite-plus/test";
import { skillProposalApplyAuthority } from "./cognitive-shared";

/**
 * Disposer separation for apply_skill_proposal: the identity that
 * proposes an evolution never approves it. Same shape as the existing
 * capability-mutation-gate tests — allowlist, fails closed on every
 * unproven identity.
 */
describe("skillProposalApplyAuthority", () => {
	const proposal = {
		tediId: "tedi-author",
		proposedByTediId: "tedi-author",
	};

	it("allows a signed-in human (operator authority)", () => {
		expect(
			skillProposalApplyAuthority(
				{ authType: "user", user: { sub: "U123" } as never, tediId: undefined },
				proposal,
			),
		).toEqual({ kind: "operator" });
	});

	it("allows an operator API key (operator authority)", () => {
		expect(
			skillProposalApplyAuthority(
				{ authType: "apikey", user: undefined, tediId: undefined },
				proposal,
			),
		).toEqual({ kind: "operator" });
	});

	it("rejects the authoring tedi applying its own proposal (self-approval)", () => {
		expect(() =>
			skillProposalApplyAuthority(
				{ authType: "tedi", user: undefined, tediId: "tedi-author" },
				proposal,
			),
		).toThrowError(/never approve/);
	});

	it("rejects self-approval even when identity arrives via service binding", () => {
		// The MCP edge forwards X-Tedix-Tedi-Id on trusted service-binding
		// calls; context.tediId is the downgrade signal, not authType.
		expect(() =>
			skillProposalApplyAuthority(
				{
					authType: "service-binding",
					user: undefined,
					tediId: "tedi-author",
				},
				proposal,
			),
		).toThrowError(/never approve/);
	});

	it("allows a DIFFERENT tedi to apply the proposal (cross-tedi disposer)", () => {
		expect(
			skillProposalApplyAuthority(
				{ authType: "tedi", user: undefined, tediId: "tedi-reviewer" },
				proposal,
			),
		).toEqual({ kind: "tedi", tediId: "tedi-reviewer" });
	});

	it("rejects the scoped tedi on older rows with no recorded author (fails closed)", () => {
		expect(() =>
			skillProposalApplyAuthority(
				{ authType: "tedi", user: undefined, tediId: "tedi-author" },
				{ tediId: "tedi-author", proposedByTediId: null },
			),
		).toThrowError(/never approve/);
	});

	it("rejects the author even when the proposal is scoped to another tedi", () => {
		// Scope-swap loophole: A authors a proposal scoped to B, then tries to
		// apply it itself. Authorship, not scope, is the gated identity.
		expect(() =>
			skillProposalApplyAuthority(
				{ authType: "tedi", user: undefined, tediId: "tedi-author" },
				{ tediId: "tedi-other", proposedByTediId: "tedi-author" },
			),
		).toThrowError(/never approve/);
	});

	it("rejects every anonymous machine identity, including unresolved", () => {
		for (const authType of [
			"tedi",
			"m2m",
			"service",
			"service-binding",
			undefined,
		] as const) {
			expect(() =>
				skillProposalApplyAuthority(
					{ authType, user: undefined, tediId: undefined },
					proposal,
				),
			).toThrowError(/anonymous machine credentials|identified tedi/);
		}
	});

	it("rejects a user authType with no subject (unproven human)", () => {
		expect(() =>
			skillProposalApplyAuthority(
				{ authType: "user", user: {} as never, tediId: undefined },
				proposal,
			),
		).toThrow();
	});
});
