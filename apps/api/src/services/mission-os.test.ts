import { parseGateConfig } from "@tedix/api-contract/contracts/tedi-objectives";
import { describe, expect, it } from "vite-plus/test";
import { computeEpisodeComplexity, computeGateGraduation } from "./mission-os";

describe("computeGateGraduation", () => {
	const baseConfig = {
		autonomyLevel: "supervised" as const,
		gateType: "first_n" as const,
		graduationCriteria: { consecutiveSuccesses: 3 },
		currentStreak: 0,
		lastGraduatedAt: null as string | null,
	};

	it("increments streak on success", () => {
		const { newConfig, graduated } = computeGateGraduation(
			baseConfig,
			"success",
		);
		expect(newConfig.currentStreak).toBe(1);
		expect(graduated).toBe(false);
	});

	it("resets streak on failure", () => {
		const config = { ...baseConfig, currentStreak: 2 };
		const { newConfig, graduated } = computeGateGraduation(config, "failure");
		expect(newConfig.currentStreak).toBe(0);
		expect(graduated).toBe(false);
	});

	it("graduates after reaching threshold", () => {
		const config = { ...baseConfig, currentStreak: 2 };
		const { newConfig, graduated } = computeGateGraduation(config, "success");
		expect(graduated).toBe(true);
		expect(newConfig.autonomyLevel).toBe("autonomous");
		expect(newConfig.currentStreak).toBe(0);
		expect(newConfig.lastGraduatedAt).toBeTruthy();
	});

	it("never auto-promotes 'always' gate type", () => {
		const config = {
			...baseConfig,
			gateType: "always" as const,
			currentStreak: 10,
		};
		const { graduated } = computeGateGraduation(config, "success");
		expect(graduated).toBe(false);
	});

	it("does not graduate when already autonomous", () => {
		const config = {
			...baseConfig,
			autonomyLevel: "autonomous" as const,
			currentStreak: 5,
		};
		const { newConfig, graduated } = computeGateGraduation(config, "success");
		expect(graduated).toBe(false);
		expect(newConfig.currentStreak).toBe(6);
	});

	// P5 scorecard discipline: complexity-weighted graduation (Goodhart guard)
	describe("complexity floor", () => {
		it("a trivial success neither advances nor resets the streak", () => {
			const config = { ...baseConfig, currentStreak: 2 };
			// complexity 0 < default floor 2 → graduation-inert
			const { newConfig, graduated } = computeGateGraduation(
				config,
				"success",
				0,
			);
			expect(graduated).toBe(false);
			expect(newConfig.currentStreak).toBe(2);
			expect(newConfig.autonomyLevel).toBe("supervised");
		});

		it("a complex success advances the streak and can graduate", () => {
			const config = { ...baseConfig, currentStreak: 2 };
			const { newConfig, graduated } = computeGateGraduation(
				config,
				"success",
				5,
			);
			expect(graduated).toBe(true);
			expect(newConfig.autonomyLevel).toBe("autonomous");
		});

		it("a failure still resets the streak regardless of complexity", () => {
			const config = { ...baseConfig, currentStreak: 2 };
			const { newConfig, graduated } = computeGateGraduation(
				config,
				"failure",
				0,
			);
			expect(graduated).toBe(false);
			expect(newConfig.currentStreak).toBe(0);
		});

		it("an unverified outcome resets the streak regardless of complexity", () => {
			const config = { ...baseConfig, currentStreak: 2 };
			const { newConfig } = computeGateGraduation(config, "unverified", 10);
			expect(newConfig.currentStreak).toBe(0);
		});

		it("no complexity signal preserves legacy streak-only behavior", () => {
			const config = { ...baseConfig, currentStreak: 1 };
			const { newConfig, graduated } = computeGateGraduation(config, "success");
			expect(graduated).toBe(false);
			expect(newConfig.currentStreak).toBe(2);
		});

		it("legacy gateConfig JSON without minComplexity gets the default floor", () => {
			const legacy = parseGateConfig(
				JSON.stringify({
					autonomyLevel: "supervised",
					gateType: "first_n",
					graduationCriteria: { consecutiveSuccesses: 3 },
					currentStreak: 2,
					lastGraduatedAt: null,
				}),
			);
			expect(legacy.graduationCriteria.minComplexity).toBeUndefined();
			// complexity 1 < DEFAULT_GATE_MIN_COMPLEXITY (2) → frozen
			const frozen = computeGateGraduation(legacy, "success", 1);
			expect(frozen.graduated).toBe(false);
			expect(frozen.newConfig.currentStreak).toBe(2);
			// complexity 2 ≥ default floor → graduates
			const advanced = computeGateGraduation(legacy, "success", 2);
			expect(advanced.graduated).toBe(true);
		});

		it("an explicit minComplexity in gateConfig wins over the default", () => {
			const config = {
				...baseConfig,
				graduationCriteria: { consecutiveSuccesses: 3, minComplexity: 5 },
				currentStreak: 2,
			};
			const frozen = computeGateGraduation(config, "success", 4);
			expect(frozen.graduated).toBe(false);
			expect(frozen.newConfig.currentStreak).toBe(2);
			const advanced = computeGateGraduation(config, "success", 5);
			expect(advanced.graduated).toBe(true);
		});

		it("trivial successes are also inert for autonomous streak tracking", () => {
			const config = {
				...baseConfig,
				autonomyLevel: "autonomous" as const,
				currentStreak: 5,
			};
			const { newConfig } = computeGateGraduation(config, "success", 0);
			expect(newConfig.currentStreak).toBe(5);
		});
	});
});

describe("computeEpisodeComplexity", () => {
	it("is 0 for a zero-execution instant episode", () => {
		expect(
			computeEpisodeComplexity({
				toolCallCount: 0,
				durationMs: 1_000,
				workItemLinked: false,
			}),
		).toBe(0);
	});

	it("counts tool calls as the primary signal", () => {
		expect(
			computeEpisodeComplexity({
				toolCallCount: 3,
				durationMs: 5_000,
				workItemLinked: false,
			}),
		).toBe(3);
	});

	it("adds one point for a linked work item", () => {
		expect(
			computeEpisodeComplexity({
				toolCallCount: 1,
				durationMs: null,
				workItemLinked: true,
			}),
		).toBe(2);
	});

	it("adds duration points at the 1-minute and 5-minute thresholds", () => {
		expect(
			computeEpisodeComplexity({
				toolCallCount: 0,
				durationMs: 60_000,
				workItemLinked: false,
			}),
		).toBe(1);
		expect(
			computeEpisodeComplexity({
				toolCallCount: 0,
				durationMs: 300_000,
				workItemLinked: false,
			}),
		).toBe(2);
	});

	it("treats unknown duration as zero duration points", () => {
		expect(
			computeEpisodeComplexity({
				toolCallCount: 2,
				durationMs: null,
				workItemLinked: false,
			}),
		).toBe(2);
	});
});
