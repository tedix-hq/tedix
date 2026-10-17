import * as z from "zod";
import {
	WorkAgentSessionEffectiveStateSchema,
	WorkAgentSessionHarnessSchema,
} from "./work-agent-sessions";

export const OFFICE_ENTRY = "tedix:app/office";
export const AGENTS_ENTRY = "tedix:app/agents";
export const WORK_DISPATCH_ENTRY = "tedix:app/work";
export const WorkDispatchConfigSchema = z.strictObject({
	version: z.literal(1),
	projectId: z.uuid(),
});

export const OfficeConfigSchema = z.strictObject({ version: z.literal(1) });
export const AgentsConfigSchema = z.strictObject({
	version: z.literal(1),
	projectId: z.uuid().optional(),
	states: z
		.array(WorkAgentSessionEffectiveStateSchema)
		.min(1)
		.max(6)
		.optional(),
	harnesses: z.array(WorkAgentSessionHarnessSchema).min(1).max(4).optional(),
});
export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;
