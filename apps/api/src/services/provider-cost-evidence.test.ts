import { describe, expect, it } from "vite-plus/test";
import {
	reportedEstimateMicros,
	rateEstimateMicros,
	assertManifestCostCaps,
} from "./provider-cost-evidence";

describe("exact nonpayable provider estimate arithmetic", () => {
	it.each([
		["0.033199", 33199],
		["0.00219662", 2197],
		["0", 0],
		["0.000000000000000001", 1],
		["9007199254.740991", Number.MAX_SAFE_INTEGER],
	] as const)("ceil %s exactly", (decimal, expected) =>
		expect(reportedEstimateMicros(decimal)).toBe(expected),
	);
	it.each([
		"",
		" 0",
		"-1",
		"+1",
		"01",
		"1e-3",
		"NaN",
		"Infinity",
		"0.1234567890123456789",
		"9007199254.740992",
	])("rejects unsupported %s", (decimal) =>
		expect(() => reportedEstimateMicros(decimal)).toThrow(),
	);
	it("prices inclusive cache partitions once and rejects missing counts", () => {
		const rate = {
			inputMicrousdPerMillion: 1_000_000,
			outputMicrousdPerMillion: 2_000_000,
			cacheReadMicrousdPerMillion: 100_000,
			cacheWriteMicrousdPerMillion: 500_000,
		};
		expect(
			rateEstimateMicros(rate, {
				inputTokens: 10,
				outputTokens: 1,
				cacheReadTokens: 2,
				cacheWriteTokens: 4,
			}),
		).toBe(9);
		expect(() =>
			rateEstimateMicros(rate, {
				inputTokens: 10,
				outputTokens: 1,
				cacheReadTokens: null,
				cacheWriteTokens: 0,
			}),
		).toThrow();
	});
	it("validates the complete manifest sum and every record before append", () => {
		const rows = [
			{ calculatedMicros: 33199, expectedCostMicros: 33199, maxMicros: 33199 },
			{ calculatedMicros: 2197, expectedCostMicros: 2197, maxMicros: 2197 },
		];
		expect(assertManifestCostCaps(rows, 35396)).toBe(35396);
		expect(() => assertManifestCostCaps(rows, 35395)).toThrow();
		expect(() =>
			assertManifestCostCaps(
				[{ ...rows[0]!, expectedCostMicros: 33198 }],
				35396,
			),
		).toThrow();
		expect(() =>
			assertManifestCostCaps([{ ...rows[0]!, maxMicros: 33198 }], 35396),
		).toThrow();
	});
});
