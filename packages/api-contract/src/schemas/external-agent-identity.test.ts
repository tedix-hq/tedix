import { describe, expect, it } from "vite-plus/test";
import {
	ExternalAgentWorkManagementGrantSchema,
	ExternalAgentPrincipalMetadataSchema,
	externalAgentScopeCeiling,
	ExternalAgentReviewAssessmentSchema,
	ExternalAgentSessionSchema,
} from "./external-agent-identity";

const BASE = {
	id: "00000000-0000-4000-8000-000000000001",
	organizationId: "00000000-0000-4000-8000-000000000002",
	principalId: "00000000-0000-4000-8000-000000000003",
	externalSessionKey: "codex:thread-1",
	harness: "codex",
	harnessVersion: "26.715",
	modelProvider: "openai",
	modelId: "gpt-5.6",
	modelVersion: "2026-07-20",
	identitySource: "explicit" as const,
	status: "active" as const,
	creditEligible: true,
	startedAt: "2026-07-20T00:00:00.000Z",
	lastSeenAt: "2026-07-20T00:00:00.000Z",
	endedAt: null,
	metadata: {},
};

describe("ExternalAgentSessionSchema", () => {
	it("rejects derived sessions that claim credit eligibility", () => {
		expect(
			ExternalAgentSessionSchema.safeParse({
				...BASE,
				identitySource: "derived",
			}).success,
		).toBe(false);
	});

	it("requires endedAt to agree with status", () => {
		expect(
			ExternalAgentSessionSchema.safeParse({
				...BASE,
				status: "ended",
			}).success,
		).toBe(false);
		expect(ExternalAgentSessionSchema.safeParse(BASE).success).toBe(true);
	});
});

describe("ExternalAgentReviewAssessmentSchema", () => {
	const review = {
		outcome: "success" as const,
		score: 1,
		policyViolationSeverity: 0,
		reviewMethod: "independent-reproduction",
		evidenceRefs: ["artifact://proof"],
	};

	it("rejects contradictory success and failure scores", () => {
		expect(
			ExternalAgentReviewAssessmentSchema.safeParse({
				...review,
				score: 0,
			}).success,
		).toBe(false);
		expect(
			ExternalAgentReviewAssessmentSchema.safeParse({
				...review,
				outcome: "failure",
				score: 1,
			}).success,
		).toBe(false);
	});

	it("requires positive severity only for policy violations", () => {
		expect(
			ExternalAgentReviewAssessmentSchema.safeParse({
				...review,
				policyViolationSeverity: 1,
			}).success,
		).toBe(false);
		expect(
			ExternalAgentReviewAssessmentSchema.safeParse({
				...review,
				outcome: "policy_violation",
				score: 0,
				policyViolationSeverity: 0,
			}).success,
		).toBe(false);
	});
});

describe("external-agent enrollment ceiling", () => {
	it.each([
		"platform:admin",
		"*",
		"connections.admin",
		"mcp:apps",
		"mcp:work",
		"mcp:settings.read",
		"mcp:settings.write",
		"mcp:settings.admin",
		"mcp:team.admin",
		"mcp:apps.admin",
		"invented:scope",
	])("refuses cloud scope %s", (scope) => {
		expect(
			ExternalAgentPrincipalMetadataSchema.safeParse({
				platform: "codex-cloud",
				allowedScopes: [scope],
			}).success,
		).toBe(false);
	});
	it("accepts exact read/write capabilities and preserves unrelated metadata", () => {
		expect(
			ExternalAgentPrincipalMetadataSchema.parse({
				platform: "codex-cloud",
				allowedScopes: ["mcp:work.read", "mcp:work.write"],
				label: "fixture",
			}),
		).toMatchObject({ label: "fixture" });
	});
	it("preserves legacy principals and denies missing or malformed cloud ceilings", () => {
		expect(externalAgentScopeCeiling({})).toBeUndefined();
		expect(externalAgentScopeCeiling({ allowedScopes: [] })).toEqual([]);
		expect(() =>
			externalAgentScopeCeiling({ platform: "codex-cloud" }),
		).toThrow();
		expect(() =>
			externalAgentScopeCeiling({ allowedScopes: "mcp:work.read" }),
		).toThrow();
	});
});

describe("external-agent represented identity metadata", () => {
	it.each([null, 42, "", " ", "x".repeat(201)])(
		"rejects malformed representedUserId %j",
		(representedUserId) => {
			expect(
				ExternalAgentPrincipalMetadataSchema.safeParse({ representedUserId })
					.success,
			).toBe(false);
		},
	);
	it("retains a canonical opaque user id and typed platform", () => {
		expect(
			ExternalAgentPrincipalMetadataSchema.parse({
				platform: "codex-cloud",
				allowedScopes: [],
				representedUserId: "canonical-human",
			}),
		).toMatchObject({ representedUserId: "canonical-human" });
		expect(
			ExternalAgentPrincipalMetadataSchema.safeParse({
				platform: "invented",
				allowedScopes: [],
			}).success,
		).toBe(false);
	});
});

describe("Work management scopes", () => {
	it.each([
		{ scope: "organization", actions: ["specification", "cancellation"] },
		{ scope: "project", projectId: BASE.id, actions: ["specification"] },
		{ sourceIntentPrefixes: ["repair:"], actions: ["assignment"] },
	])("accepts a bounded scope: %j", (grant) => {
		expect(
			ExternalAgentWorkManagementGrantSchema.safeParse(grant).success,
		).toBe(true);
	});
	it.each([
		{
			scope: "organization",
			sourceIntentPrefixes: ["repair:"],
			actions: ["specification"],
		},
		{ scope: "project", actions: ["specification"] },
		{ scope: "organization", actions: ["completion"] },
		{ scope: "organization", actions: ["delete"] },
		{ scope: "organization", actions: ["payment"] },
		{ scope: "organization", actions: [] },
		{ actions: ["specification"] },
	])("rejects ambiguous or unauthorized grant shape: %j", (grant) => {
		expect(
			ExternalAgentWorkManagementGrantSchema.safeParse(grant).success,
		).toBe(false);
	});
});
