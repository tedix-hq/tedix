import { describe, expect, it } from "vite-plus/test";
import {
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
