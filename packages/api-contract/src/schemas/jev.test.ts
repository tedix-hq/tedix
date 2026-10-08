import { describe, expect, it } from "vite-plus/test";
import {
	JevSettingsSchema,
	parseJevSettings,
	RankSkillsInputSchema,
} from "./jev";
import { UpdateOrganizationInputSchema } from "./organization";

describe("tenant Jev default and explicit denial", () => {
	it("fails closed for malformed or unsupported policy", () => {
		for (const metadata of [
			{ jev: null },
			{ jev: { enabled: true, version: 2 } },
			{ jev: { enabled: true, unknown: true } },
		]) {
			expect(parseJevSettings(metadata).enabled).toBe(false);
		}
	});
	it("defaults to native routing and rejects invented routes", () => {
		expect(parseJevSettings({ jev: { enabled: true } }).transport).toBe(
			"cloudflare",
		);
		expect(
			parseJevSettings({ jev: { enabled: true, transport: "direct" } })
				.transport,
		).toBe("direct");
		expect(
			parseJevSettings({ jev: { enabled: true, transport: "proxy" } }).enabled,
		).toBe(false);
	});
	it("defaults purposes on and bounds workload controls", () => {
		expect(
			parseJevSettings({ jev: { enabled: true } }).purposes.contextRanking
				.enabled,
		).toBe(true);
		for (const value of [
			{ timeoutMs: 5001 },
			{ purposes: { contextRanking: { maxCandidates: 41 } } },
			{ purposes: { contextRanking: { minConfidence: 0.49 } } },
			{ purposes: { contextRanking: { minApplicability: 0.49 } } },
		]) {
			expect(JevSettingsSchema.safeParse(value).success).toBe(false);
		}
	});
	it("preserves valid policy through the organization update contract", () => {
		const jev = JevSettingsSchema.parse({
			enabled: true,
			purposes: { contextRanking: { enabled: true } },
		});
		const parsed = UpdateOrganizationInputSchema.parse({
			id: "11111111-1111-4111-8111-111111111111",
			metadata: { jev },
		});
		expect(parsed.metadata?.jev).toEqual(jev);
		expect(parseJevSettings({ jev })).toEqual(jev);
	});
});

it("preserves explicit runtime denial and bounds unique server-side IDs", () => {
	expect(
		parseJevSettings({
			jev: {
				enabled: true,
				purposes: {
					contextRanking: { enabled: true },
					skillRanking: { enabled: false },
				},
			},
		}).purposes.skillRanking.enabled,
	).toBe(false);
	expect(
		RankSkillsInputSchema.safeParse({
			tediId: "11111111-1111-4111-8111-111111111111",
			runId: "run",
			query: "Find suitable procedures",
			skillIds: [
				"22222222-2222-4222-8222-222222222222",
				"22222222-2222-4222-8222-222222222222",
			],
		}).success,
	).toBe(false);
});

it("defaults missing policy on while preserving explicit v1 denial", () => {
	expect(parseJevSettings({}).enabled).toBe(true);
	expect(parseJevSettings({}).purposes.skillRanking.enabled).toBe(true);
	expect(
		parseJevSettings({ jev: { version: 1, enabled: false } }).enabled,
	).toBe(false);
	expect(
		parseJevSettings({
			jev: {
				purposes: { contextRanking: { enabled: false, minConfidence: 0.8 } },
			},
		}).purposes.contextRanking.enabled,
	).toBe(false);
	expect(
		parseJevSettings({
			jev: { purposes: { contextRanking: { minConfidence: 0.99 } } },
		}).purposes.contextRanking.minApplicability,
	).toBe(0.6);
});

it("enforces only evaluated memory judgments by default", () => {
	const clef = "@cf/cloudflare/clef-flash";
	expect(parseJevSettings({}).purposes.memoryQuality).toEqual({
		mode: "enforce",
		model: clef,
	});
	expect(parseJevSettings({}).purposes.graphLinking).toEqual({
		mode: "shadow",
		model: clef,
	});
	expect(
		parseJevSettings({
			jev: { purposes: { memoryQuality: { mode: "shadow" } } },
		}).purposes.memoryQuality.mode,
	).toBe("shadow");
	expect(
		parseJevSettings({
			jev: { purposes: { graphLinking: { mode: "enforce" } } },
		}).purposes.graphLinking.mode,
	).toBe("enforce");
	expect(
		parseJevSettings({
			jev: { purposes: { memoryQuality: { mode: "apply" } } },
		}).enabled,
	).toBe(false);
});
