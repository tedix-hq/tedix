import * as z from "zod";

/** Slug of the system policy pack every organization's runners inherit. */
export const RUNNER_RULES_SLUG = "runner-rules";

/**
 * The rules every local runner briefs its runs with, published once for the
 * whole installation and edited as data. An organization adds its own rules
 * in a skill; it never has to repeat these.
 */
export const RunnerRulesSchema = z.strictObject({
	content: z.string().trim().min(1).max(20_000),
});
export type RunnerRules = z.infer<typeof RunnerRulesSchema>;

export const RunnerRulesResultSchema = z.object({
	/** Null until an installation administrator publishes the pack. */
	rules: z
		.object({
			content: z.string(),
			/** The published version, recorded with each run it briefed. */
			version: z.number().int(),
		})
		.nullable(),
});
