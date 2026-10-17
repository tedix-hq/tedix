import * as z from "zod";

const text = z.string().trim().min(1).max(2000);
export const AgentReviewFeedbackSchema = z.strictObject({
	version: z.literal(1),
	reviewedSha: z.string().regex(/^[a-f0-9]{40}$/),
	projectContext: text,
	fitScore: z.number().int().min(0).max(5),
	blockers: z.array(text).max(20),
	suggestions: z.array(text).max(20),
	bugs: z
		.array(
			z.strictObject({
				title: z.string().trim().min(1).max(200),
				evidence: text,
				repro: text,
				expected: text,
				actual: text,
			}),
		)
		.max(20),
});

export const FileAgentReviewInputSchema = z.strictObject({
	reportMarkdown: z
		.string()
		.trim()
		.min(200)
		.max(24 * 1024),
	feedback: AgentReviewFeedbackSchema,
	website: z.string().max(0).optional(),
});

export type FileAgentReviewInput = z.infer<typeof FileAgentReviewInputSchema>;
