import { describe, expect, it } from "vite-plus/test";
import { workApprovalsContract } from "./work-approvals";

describe("Work approvals contract", () => {
	function inputSchema(name: keyof typeof workApprovalsContract) {
		return workApprovalsContract[name]["~orpc"].inputSchemas[0]!;
	}

	const validPropose = {
		workItemId: "00000000-0000-4000-8000-000000000001",
		workItemVersion: 1,
		proposal: { summary: "Ship the reviewed change" },
		authorityKey: "deploy:production",
		approverType: "user",
		approverId: "owner@example.com",
		requestRationale: "Release the reviewed change",
		expiresAt: "2099-01-01T00:00:00.000Z",
	};

	it("defaults to an admission proposal and keeps its bindings mandatory", () => {
		const parsed = inputSchema("propose").safeParse(validPropose);
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data.action).toBe("admission");
		expect(
			inputSchema("propose").safeParse({ ...validPropose, action: "bogus" })
				.success,
		).toBe(false);
		expect(
			inputSchema("propose").safeParse({
				...validPropose,
				proposal: undefined,
			}).success,
		).toBe(false);
		expect(
			inputSchema("propose").safeParse({
				...validPropose,
				approverId: undefined,
			}).success,
		).toBe(false);
	});

	it("keeps the acceptance contract versioned and its outcome statement required", () => {
		expect(
			inputSchema("propose").safeParse({
				...validPropose,
				action: "acceptance",
				acceptanceContract: {
					version: 1,
					doneLooksLike: "The watch completes green",
				},
			}).success,
		).toBe(true);
		for (const acceptanceContract of [
			{ version: 1 },
			{ version: 2, doneLooksLike: "Done" },
			{ version: 1, doneLooksLike: "Done", extra: true },
		]) {
			expect(
				inputSchema("propose").safeParse({
					...validPropose,
					action: "acceptance",
					acceptanceContract,
				}).success,
			).toBe(false);
		}
	});

	it("requires a version-fenced typed decision with rationale", () => {
		const valid = {
			proposalId: "00000000-0000-4000-8000-000000000001",
			expectedProposalVersion: 1,
			decision: "approved",
			rationale: "Digest and authority scope match",
		};
		expect(inputSchema("decide").safeParse(valid).success).toBe(true);
		expect(
			inputSchema("decide").safeParse({ ...valid, decision: "commented" })
				.success,
		).toBe(false);
		expect(
			inputSchema("decide").safeParse({ ...valid, rationale: "" }).success,
		).toBe(false);
	});

	it("keeps server-only resolution fences off public proposal and decision inputs", () => {
		const proposalShape = inputSchema("propose");
		const decisionShape = inputSchema("decide");
		expect(
			proposalShape.safeParse({
				...validPropose,
				resolutionFence: "00000000-0000-4000-8000-000000000099",
			}).success,
		).toBe(false);
		expect(
			decisionShape.safeParse({
				proposalId: "00000000-0000-4000-8000-000000000001",
				expectedProposalVersion: 1,
				decision: "approved",
				rationale: "Approved",
				resolutionFence: "00000000-0000-4000-8000-000000000099",
			}).success,
		).toBe(false);
	});

	it("bounds inbox fan-out and exposes expiry as a first-class status", () => {
		expect(
			inputSchema("listInbox").safeParse({
				statuses: ["pending", "expired"],
				limit: 100,
			}).success,
		).toBe(true);
		expect(inputSchema("listInbox").safeParse({ limit: 101 }).success).toBe(
			false,
		);
	});

	it("bounds structured proposal depth, keys, and serialized size", () => {
		let nested: Record<string, unknown> = { leaf: true };
		for (let index = 0; index < 9; index += 1) nested = { nested };
		expect(
			inputSchema("propose").safeParse({
				...validPropose,
				proposal: nested,
			}).success,
		).toBe(false);
		expect(
			inputSchema("propose").safeParse({
				...validPropose,
				proposal: Object.fromEntries(
					Array.from({ length: 257 }, (_, index) => [`key${index}`, index]),
				),
			}).success,
		).toBe(false);
		expect(
			inputSchema("propose").safeParse({
				...validPropose,
				proposal: { body: "x".repeat(32_769) },
			}).success,
		).toBe(false);
	});
});
