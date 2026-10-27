import * as z from "zod";

/** Hands accepted non-coding Work with no executor to its steward tedi. */
export const WorkAutoRoutePolicySchema = z.object({
	enabled: z.boolean(),
	/** Most Work items delegated per organization per run (every 10 minutes). */
	maxPerRun: z.number().int().min(1).max(10).default(2),
});

export const WorkStewardshipPolicySchema = z.object({
	enabled: z.boolean(),
	useProjectLead: z.boolean().default(true),
	projectStewards: z.record(z.uuid(), z.uuid()).default({}),
	workKindStewards: z.record(z.string().min(1).max(100), z.uuid()).default({}),
	defaultTediId: z.uuid().optional(),
	autoRoute: WorkAutoRoutePolicySchema.optional(),
});
export type WorkStewardshipPolicy = z.infer<typeof WorkStewardshipPolicySchema>;
