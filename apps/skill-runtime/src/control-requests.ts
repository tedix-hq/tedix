import type { SkillRuntimeEnv } from "./env";
import { OsDerivedAccessEnvelopeSchema } from "@tedix/api-contract/schemas/os-workspaces";
import { WorkflowEventTypeSchema } from "@tedix/api-contract/schemas/common";
import * as z from "zod";

export const RunRequestSchema = z.object({
	runId: z.string().uuid().optional(),
	idempotencyKey: z.string().min(1).max(256).optional(),
	skillId: z.string().min(1),
	tediId: z.string().min(1),
	orgId: z.string().min(1),
	params: z.unknown().optional(),
	// Run-pinned source. The workflow factory only reads the snapshot captured
	// at dispatch time, never live skill_entries rows.
	skillSlug: z.string(),
	skillRevision: z.number().int().nullish(),
	workflowSource: z.string().min(1),
	skillDoc: z.string(),
	capabilityManifest: z.record(z.string(), z.unknown()),
	resourceAccessEnvelope: OsDerivedAccessEnvelopeSchema.optional(),
	certification: z.boolean().optional(),
	createdBy: z.string().min(1).max(128).optional(),
	workItemId: z.string().uuid().optional(),
	originTediRunId: z.string().uuid().optional(),
});

export const StatusRequestSchema = z.object({
	runId: z.string().min(1),
});

export const ControlRequestSchema = z.object({
	runId: z.string().min(1),
	// Optional for one rolling-compatible release because production deploys
	// skill-runtime before apps/api. The new API always supplies this fence;
	// remove optionality after every caller has crossed this release.
	expectedExecutionEpoch: z.number().int().min(0).optional(),
});

export const CancelRequestSchema = ControlRequestSchema.extend({
	rollback: z.boolean().optional().default(false),
});

export const RestartRequestSchema = ControlRequestSchema.extend({
	restartId: z.string().min(1).max(128),
	abortUnknown: z.boolean().optional().default(false),
	reason: z.string().min(1).max(4000).optional(),
	from: z
		.object({
			name: z.string().min(1),
			count: z.number().int().min(1).optional(),
			type: z.enum(["do", "sleep", "waitForEvent"]).optional(),
		})
		.optional(),
});

export const ApprovalRequestSchema = ControlRequestSchema.extend({
	approvalId: z.string().min(1).max(128),
	reason: z.string().min(1).max(4000).optional(),
	payload: z.record(z.string(), z.unknown()).optional().default({}),
});

export const SendEventRequestSchema = ControlRequestSchema.extend({
	type: WorkflowEventTypeSchema.describe(
		"Event name the tenant workflow is awaiting (e.g. 'content-approved')",
	),
	payload: z.unknown().optional(),
});

export type AppEnv = {
	Bindings: SkillRuntimeEnv;
};
