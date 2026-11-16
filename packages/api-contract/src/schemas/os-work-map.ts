import * as z from "zod";

/** The Work Map app: one live view of purpose, progress, lanes and stuck work. */
export const WORK_MAP_ENTRY = "tedix:app/work-map";

export const WorkMapConfigSchema = z.strictObject({
	version: z.literal(1),
	/** Accepted work with no event for this long counts as not moving. */
	stalledAfterHours: z.number().int().min(1).max(168).default(12),
});
export type WorkMapConfig = z.infer<typeof WorkMapConfigSchema>;
