import * as z from "zod";

export const SiteThemeCandidateSchema = z.object({
	id: z.string(),
	version: z.number().int(),
	createdAt: z.string(),
	previewUrl: z.url(),
	predecessorMatches: z.boolean(),
});
