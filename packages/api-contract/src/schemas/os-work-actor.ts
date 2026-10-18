import * as z from "zod";

/** Display provenance only; never execution authority. */
export const WorkActorReferenceSchema = z.object({
	type: z.string(),
	id: z.string().nullable().optional(),
	harness: z.string().nullable().optional(),
});
export type WorkActorReference = z.infer<typeof WorkActorReferenceSchema>;
