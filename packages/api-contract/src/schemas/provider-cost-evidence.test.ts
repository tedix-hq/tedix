import { describe, expect, it } from "vite-plus/test";
import {
	RecordProviderCostEvidenceInputSchema,
	ProviderNativeUsageSchema,
	reportedCostDecimalToMicros,
	providerCostEvidenceDigest,
} from "./provider-cost-evidence";

describe("provider estimate facts", () => {
	it("preserves exact decimal micros and rounds only fractional microUSD upward", () => {
		expect(reportedCostDecimalToMicros("0.033199")).toBe(33199);
		expect(reportedCostDecimalToMicros("0.00219662")).toBe(2197);
		expect(reportedCostDecimalToMicros("0")).toBe(0);
		for (const value of [
			"-1",
			"1e-6",
			" 1",
			"01",
			"NaN",
			"Infinity",
			"9007199254740992",
			"0.0000000000000000001",
		])
			expect(() => reportedCostDecimalToMicros(value)).toThrow();
	});
	it("refuses unknown counters and cache creation double counting", () => {
		expect(
			ProviderNativeUsageSchema.safeParse({
				inputTokens: 10,
				outputTokens: 2,
				cacheReadTokens: 4,
				cacheWriteTokens: 6,
				known: true,
			}).success,
		).toBe(true);
		expect(
			ProviderNativeUsageSchema.safeParse({
				inputTokens: 10,
				outputTokens: 2,
				cacheReadTokens: 4,
				cacheWriteTokens: 7,
				known: true,
			}).success,
		).toBe(false);
		expect(
			ProviderNativeUsageSchema.safeParse({
				inputTokens: 10,
				outputTokens: 2,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				known: false,
			}).success,
		).toBe(false);
	});
	it("does not accept client prices or claimed authority", () => {
		const input = {
			mode: "validate_only",
			financialWorkItemId: "00000000-0000-4000-8000-000000000001",
			approvalProposalId: "00000000-0000-4000-8000-000000000002",
			approvalDecisionId: "00000000-0000-4000-8000-000000000003",
			attemptId: null,
			records: [
				{
					sourceCallId: "source",
					expectedSourceDigest: "a".repeat(64),
					expectedParentEvidenceVersionId: null,
					idempotencyDigest: "b".repeat(64),
				},
			],
		};
		expect(RecordProviderCostEvidenceInputSchema.safeParse(input).success).toBe(
			true,
		);
		expect(
			RecordProviderCostEvidenceInputSchema.safeParse({
				...input,
				approved: true,
			}).success,
		).toBe(false);
		expect(
			RecordProviderCostEvidenceInputSchema.safeParse({
				...input,
				mode: "append",
			}).success,
		).toBe(false);
		expect(
			RecordProviderCostEvidenceInputSchema.safeParse({
				...input,
				records: [...input.records, ...input.records],
			}).success,
		).toBe(false);
	});
	it("binds all JSON facts with stable object-key ordering and distinct domains", async () => {
		expect(await providerCostEvidenceDigest("source", { b: 2, a: 1 })).toBe(
			await providerCostEvidenceDigest("source", { a: 1, b: 2 }),
		);
		expect(await providerCostEvidenceDigest("source", { a: 1 })).not.toBe(
			await providerCostEvidenceDigest("basis", { a: 1 }),
		);
		await expect(
			providerCostEvidenceDigest("source", { a: undefined }),
		).rejects.toThrow();
	});
});
