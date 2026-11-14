import * as z from "zod";

/** Display-only choices; answering still uses the originating card's controls. */
export const AttentionDisplayOptionSchema = z.strictObject({
	id: z.string(),
	label: z.string(),
	consequence: z.string().nullable(),
	recommended: z.boolean().optional(),
});
