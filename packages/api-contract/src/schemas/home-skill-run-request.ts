import { z } from "zod";
import { JsonValueSchema } from "./common";

/** Arguments explicitly supplied in a Home request for one approved skill run. */
export const HomeSkillRunRequestSchema = z
	.object({
		skillId: z.string().uuid(),
		tediId: z.string().uuid(),
		expectedSkillRevision: z.number().int().positive(),
		workItemId: z.string().uuid(),
		idempotencyKey: z.string().min(1).max(128),
		params: z.record(z.string(), JsonValueSchema),
	})
	.strict();
