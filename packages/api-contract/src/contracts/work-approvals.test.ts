import { describe, expect, it } from "vite-plus/test";
import { workApprovalsContract } from "./work-approvals";

describe("Work approvals contract", () => {
	function inputSchema(name: keyof typeof workApprovalsContract) {
		return workApprovalsContract[name]["~orpc"].inputSchemas[0]!;
	}

	it("keeps exact typed admission proposal bindings mandatory", () => {
		const valid = {
			workItemId: "00000000-0000-4000-8000-000000000001",
			workItemVersion: 4,
			proposal: {
				artifactRef: "tedix-api-production",
				artifactVersion: "sha:a54939e",
			},
			authorityKey: "deploy:production",
			approverType: "user",
			approverId: "owner@example.com",
			requestRationale: "Release the reviewed change",
			expiresAt: "2026-08-21T00:00:00.000Z",
		};
		expect(inputSchema("propose").safeParse(valid).success).toBe(true);
		expect(
			inputSchema("propose").safeParse({
				...valid,
				action: "evaluate_high_risk_repair",
			}).success,
		).toBe(false);
		expect(
			inputSchema("propose").safeParse({
				...valid,
				proposal: undefined,
			}).success,
		).toBe(false);
		expect(
			inputSchema("propose").safeParse({
				...valid,
				approverId: undefined,
			}).success,
		).toBe(false);
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
				workItemId: "00000000-0000-4000-8000-000000000001",
				workItemVersion: 1,
				proposal: {},
				authorityKey: "deploy:production",
				approverType: "user",
				approverId: "owner@example.com",
				requestRationale: "Release",
				expiresAt: "2026-08-21T00:00:00.000Z",
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
		const base = {
			workItemId: "00000000-0000-4000-8000-000000000001",
			workItemVersion: 4,
			authorityKey: "deploy:production",
			approverType: "user",
			approverId: "owner@example.com",
			requestRationale: "Release the reviewed change",
			expiresAt: "2026-08-21T00:00:00.000Z",
		};
		let nested: Record<string, unknown> = { leaf: true };
		for (let index = 0; index < 9; index += 1) nested = { nested };
		expect(
			inputSchema("propose").safeParse({ ...base, proposal: nested }).success,
		).toBe(false);
		expect(
			inputSchema("propose").safeParse({
				...base,
				proposal: Object.fromEntries(
					Array.from({ length: 257 }, (_, index) => [`key${index}`, index]),
				),
			}).success,
		).toBe(false);
		expect(
			inputSchema("propose").safeParse({
				...base,
				proposal: { body: "x".repeat(32_769) },
			}).success,
		).toBe(false);
	});
});
