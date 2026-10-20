import { describe, expect, it } from "vite-plus/test";
import {
	ModelFallbackPolicySchema,
	fallbackFailureReason,
} from "./model-fallback";
const a = "azure-openai/gpt-6.1-sol";
const b = "azure-openai/gpt-6-luna";
const c = "cloudflare/auto";
describe("model fallback policy", () => {
	it("rejects self loops, indirect cycles, duplicate edges and unknown models", () => {
		for (const ladder of [
			{ [a]: [a] },
			{ [a]: [b], [b]: [c], [c]: [a] },
			{ [a]: [b, b] },
			{ [a]: ["fake/model"] },
		]) {
			expect(
				ModelFallbackPolicySchema.safeParse({
					version: 1,
					maxTransitions: 3,
					ladder,
				}).success,
			).toBe(false);
		}
	});
	it("accepts an ordered DAG and bounds transitions", () => {
		expect(
			ModelFallbackPolicySchema.parse({
				version: 1,
				maxTransitions: 3,
				ladder: { [a]: [b, c], [b]: [c] },
			}).ladder[a],
		).toEqual([b, c]);
		expect(
			ModelFallbackPolicySchema.safeParse({
				version: 1,
				maxTransitions: 99,
				ladder: {},
			}).success,
		).toBe(false);
	});
	it("classifies provider failures without treating authentication, rate limiting or app errors as quota", () => {
		expect(fallbackFailureReason({ statusCode: 402 })).toBe(
			"credits_exhausted",
		);
		expect(
			fallbackFailureReason({
				statusCode: 429,
				responseBody: '{"error":{"code":"insufficient_quota"}}',
			}),
		).toBe("quota_exhausted");
		expect(fallbackFailureReason({ statusCode: 503 })).toBe(
			"provider_unavailable",
		);
		for (const error of [
			{ statusCode: 429, message: "rate limit" },
			{ statusCode: 401, message: "out of credits" },
			new Error("quota exhausted"),
			{ statusCode: 400 },
		])
			expect(fallbackFailureReason(error)).toBeNull();
	});
});
