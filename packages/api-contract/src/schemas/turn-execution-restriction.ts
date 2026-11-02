import { z } from "zod";

/** A caller may only remove tools and automatic learning from a normal turn. */
export const TurnExecutionRestrictionSchema = z
	.object({ tools: z.literal("none"), learning: z.literal("disabled") })
	.strict();

export type TurnExecutionRestriction = z.infer<
	typeof TurnExecutionRestrictionSchema
>;
