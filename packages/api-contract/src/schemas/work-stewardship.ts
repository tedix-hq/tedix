import * as z from "zod";

export const WorkStewardshipPolicySchema = z.object({
	enabled: z.boolean(),
	useProjectLead: z.boolean().default(true),
	projectStewards: z.record(z.uuid(), z.uuid()).default({}),
	workKindStewards: z.record(z.string().min(1).max(100), z.uuid()).default({}),
	defaultTediId: z.uuid().optional(),
});
