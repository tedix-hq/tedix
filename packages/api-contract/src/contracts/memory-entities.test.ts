import { describe, expect, it } from "vite-plus/test";
import {
	MemoryEntityMentionSchema,
	MemoryEntityResolutionDecisionSchema,
	RecordMemoryEntityMentionInputSchema,
	ReviewMemoryEntityResolutionInputSchema,
} from "./memory-entities";

const uuid = (suffix: string) =>
	`00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;

describe("memory entity contract", () => {
	it("rejects partial or inverted immutable mention spans", () => {
		const base = {
			mentionId: uuid("1"),
			occurrenceKey: "fact-1:0:5",
			surfaceForm: "Tedix",
			proposedType: "product",
			extractor: "test",
			extractorVersion: "1",
			confidence: 0.9,
		};

		expect(
			RecordMemoryEntityMentionInputSchema.safeParse({
				...base,
				charStart: 0,
			}).success,
		).toBe(false);
		expect(
			RecordMemoryEntityMentionInputSchema.safeParse({
				...base,
				charStart: 5,
				charEnd: 2,
			}).success,
		).toBe(false);
		expect(
			RecordMemoryEntityMentionInputSchema.safeParse({
				...base,
				charStart: 0,
				charEnd: 5,
			}).success,
		).toBe(true);
	});

	it("requires a canonical resolution id only for acceptance", () => {
		const base = {
			decisionId: uuid("2"),
			expectedDecisionVersion: 0,
			reviewRationale: "Evidence checked independently",
		};

		expect(
			ReviewMemoryEntityResolutionInputSchema.safeParse({
				...base,
				outcome: "accept",
			}).success,
		).toBe(false);
		expect(
			ReviewMemoryEntityResolutionInputSchema.safeParse({
				...base,
				outcome: "reject",
			}).success,
		).toBe(true);
		expect(
			ReviewMemoryEntityResolutionInputSchema.safeParse({
				...base,
				outcome: "accept",
				resolutionId: uuid("3"),
			}).success,
		).toBe(true);
	});

	it("keeps immutable evidence and adjudication actors explicit", () => {
		expect(
			MemoryEntityMentionSchema.safeParse({
				id: uuid("4"),
				organizationId: uuid("5"),
				occurrenceKey: "source:1",
				sourceFactId: null,
				sourceUri: "https://example.test/source",
				sourceContentHash: "sha256:abc",
				sourceSessionId: null,
				sourceRunId: null,
				surfaceForm: "Acme",
				normalizedForm: "acme",
				proposedType: "organization",
				charStart: null,
				charEnd: null,
				extractor: "fixture",
				extractorVersion: "1",
				modelId: null,
				harnessVersionId: null,
				confidence: 1,
				evidence: {},
				createdAt: "2026-07-27T00:00:00.000Z",
			}).success,
		).toBe(true);
		expect(
			MemoryEntityResolutionDecisionSchema.safeParse({
				id: uuid("6"),
				organizationId: uuid("5"),
				clientProposalKey: "proposal-1",
				operation: "link_mention",
				mentionId: uuid("4"),
				aliasId: null,
				sourceEntityId: null,
				targetEntityId: uuid("7"),
				status: "accepted",
				confidence: 0.95,
				rationale: "Exact verified identity",
				evidence: {},
				proposedByType: "external_agent",
				proposedById: "agent-1",
				reviewedByType: "user",
				reviewedById: "owner-1",
				reviewRationale: "Independent review",
				sourceRunId: null,
				expectedMentionVersion: 0,
				expectedHeadDecisionId: null,
				expectedEntityVersion: 0,
				version: 1,
				supersedesDecisionId: null,
				rollbackOfDecisionId: null,
				inverse: {
					entityId: null,
					resolutionId: null,
					confidence: null,
				},
				proposedAt: "2026-07-27T00:00:00.000Z",
				reviewedAt: "2026-07-27T00:01:00.000Z",
				appliedAt: "2026-07-27T00:01:00.000Z",
			}).success,
		).toBe(true);
	});
});
