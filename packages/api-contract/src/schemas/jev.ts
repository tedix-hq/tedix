import * as z from "zod";
import { ProviderExecutionIdentitySchema } from "./provider-execution";

/** Exact provider model IDs admitted by the shared bounded-judgment executor. */
export const DecisionModelSchema = z.enum([
	"typesafe/jev",
	"@cf/cloudflare/clef",
	"@cf/cloudflare/clef-flash",
]);
export type DecisionModel = z.infer<typeof DecisionModelSchema>;

/**
 * A confident wrong memory verdict silently removes recall, so a purpose
 * enforces by default only after a recorded evaluation on real facts. Memory
 * quality passed (2026-10-07, see jev-memory-quality.ts); graph linking has
 * not and stays in shadow: judged, metered and logged, never applied.
 * Clef keeps memory content on Workers AI rather than a third-party model owner.
 */
const memoryJudgmentPolicy = (mode: "shadow" | "enforce") =>
	z
		.strictObject({
			mode: z.enum(["shadow", "enforce"]).default(mode),
			model: DecisionModelSchema.default("@cf/cloudflare/clef-flash"),
		})
		.prefault({});
const MemoryJudgmentPolicySchema = memoryJudgmentPolicy("shadow");
export type MemoryJudgmentPolicy = z.infer<typeof MemoryJudgmentPolicySchema>;

/** Ranking defaults on; explicit v1 tenant/purpose denials remain authoritative. */
export const JevSettingsSchema = z.strictObject({
	version: z.literal(1).default(1),
	enabled: z.boolean().default(true),
	transport: z.enum(["cloudflare", "direct"]).default("cloudflare"),
	timeoutMs: z.number().int().min(100).max(5000).default(2000),
	purposes: z
		.strictObject({
			contextRanking: z
				.strictObject({
					enabled: z.boolean().default(true),
					minConfidence: z
						.number()
						.min(0.5)
						.max(1)
						.optional()
						.describe(
							"Legacy v1 field retained for stored policy; not an applicability threshold.",
						),
					minApplicability: z.number().min(0.5).max(1).default(0.6),
					maxCandidates: z.number().int().min(1).max(40).default(40),
				})
				.prefault({}),
			skillRanking: z
				.strictObject({
					enabled: z.boolean().default(true),
					minConfidence: z
						.number()
						.min(0.5)
						.max(1)
						.optional()
						.describe(
							"Legacy v1 field retained for stored policy; not an applicability threshold.",
						),
					minApplicability: z.number().min(0.5).max(1).default(0.6),
					maxCandidates: z.number().int().min(1).max(40).default(40),
				})
				.prefault({}),
			memoryQuality: memoryJudgmentPolicy("enforce"),
			graphLinking: MemoryJudgmentPolicySchema,
		})
		.prefault({}),
});
export type JevSettings = z.infer<typeof JevSettingsSchema>;

/** Absent policy uses defaults; explicit denial and invalid/future policy fail closed. */
export function parseJevSettings(metadata: unknown): JevSettings {
	const value =
		metadata && typeof metadata === "object" && !Array.isArray(metadata)
			? (metadata as Record<string, unknown>).jev
			: undefined;
	const parsed = JevSettingsSchema.safeParse(value === undefined ? {} : value);
	return parsed.success
		? parsed.data
		: JevSettingsSchema.parse({ enabled: false });
}

export const RankSkillsInputSchema = z.strictObject({
	tediId: z.uuid(),
	runId: z.string().min(1).max(300),
	query: z.string().min(10).max(2000),
	skillIds: z
		.array(z.uuid())
		.min(2)
		.max(40)
		.refine((ids) => new Set(ids).size === ids.length, "Duplicate skill IDs"),
});
export type RankSkillsInput = z.infer<typeof RankSkillsInputSchema>;
export const JevExecutionAttemptSchema = z.strictObject({
	identity: ProviderExecutionIdentitySchema,
	occurredAt: z.string(),
	executionId: z.string(),
	usage: z
		.strictObject({
			inputTokens: z
				.number()
				.nonnegative()
				.nullable()
				.describe("Null when this provider token count was not reported."),
			outputTokens: z
				.number()
				.nonnegative()
				.nullable()
				.describe("Null when this provider token count was not reported."),
			cacheReadTokens: z
				.number()
				.nonnegative()
				.nullable()
				.describe("Null when this provider token count was not reported."),
			cacheWriteTokens: z
				.number()
				.nonnegative()
				.nullable()
				.describe("Null when this provider token count was not reported."),
		})
		.optional()
		.describe(
			"Absent when dispatch failed before provider usage was reported.",
		),
});
export const RankSkillsOutputSchema = z.strictObject({
	executionAttempts: z.array(JevExecutionAttemptSchema).max(1),
	usagePersistence: z.enum([
		"not_dispatched",
		"persisted",
		"unknown",
		"failed",
	]),
	skillIds: z
		.array(z.uuid())
		.max(40)
		.nullable()
		.describe(
			"Null when disabled, ineligible, uncertain, or unavailable; retain original order.",
		),
});
export type RankSkillsOutput = z.infer<typeof RankSkillsOutputSchema>;

/** Service-bound Code Mode discovery: the MCP edge supplies only its authorized shortlist. */
export const RankDiscoveryInputSchema = z.strictObject({
	query: z.string().trim().min(3).max(2000),
	candidates: z
		.array(
			z.strictObject({
				id: z.string().min(1).max(200),
				kind: z.enum(["tool", "skill"]),
				description: z.string().trim().min(1).max(400),
			}),
		)
		.min(2)
		.max(12)
		.refine(
			(rows) => new Set(rows.map((row) => row.id)).size === rows.length,
			"Duplicate discovery IDs",
		),
	runId: z
		.string()
		.min(1)
		.max(300)
		.optional()
		.describe(
			"Absent for discovery outside a durable run; billing remains organization-attributed.",
		),
});
export type RankDiscoveryInput = z.infer<typeof RankDiscoveryInputSchema>;
export const RankDiscoveryOutputSchema = z.strictObject({
	rankedIds: z
		.array(z.string())
		.max(12)
		.nullable()
		.describe(
			"Null when the model abstains or admission fails; retain lexical ordering.",
		),
	executionAttempts: z.array(JevExecutionAttemptSchema).max(1),
	usagePersistence: z.enum([
		"not_dispatched",
		"persisted",
		"unknown",
		"failed",
	]),
});
export type RankDiscoveryOutput = z.infer<typeof RankDiscoveryOutputSchema>;
