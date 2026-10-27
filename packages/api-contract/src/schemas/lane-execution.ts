import { z } from "zod";

const key = z.string().trim().min(1).max(300);
const micros = z.number().int().safe().positive();

export const LaneExecutorSchema = z
	.object({
		id: key,
		kind: z.enum(["codex", "claude", "tedi", "skill"]),
		principalType: z.enum(["external_agent", "tedi"]),
		principalId: key,
		resourceKey: key,
		/** Null means unavailable pricing, never a free execution. */
		costMicros: micros.nullable(),
		capabilities: z.array(key).max(100),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (
			(value.kind === "codex" || value.kind === "claude") !==
			(value.principalType === "external_agent")
		)
			ctx.addIssue({
				code: "custom",
				message: "Executor kind must match its admitted principal type",
			});
	});
export type LaneExecutor = z.infer<typeof LaneExecutorSchema>;

/** Owner-configured Work metadata; resource pools and envelopes are registered separately. */
export const LaneExecutionPolicySchema = z
	.object({
		version: z.literal(1),
		role: z.enum(["maker", "verification", "closure"]),
		sharedResourceKeys: z.array(key).min(1).max(10),
		/** Smaller than the shared pool, leaving reserved slots for verification/closure. */
		makerResourceKey: key,
		reservedSlots: z.number().int().min(1).max(1000),
		budgetEnvelopeIds: z.array(key).min(1).max(10),
		executors: z.array(LaneExecutorSchema).min(1).max(20),
		maxAttempts: z.number().int().min(1).max(20),
		maxDelegationDepth: z.number().int().min(0).max(10),
		delegationDepth: z.number().int().min(0).max(10),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (
			new Set(value.executors.map((e) => e.id)).size !==
				value.executors.length ||
			new Set(value.executors.map((e) => `${e.principalType}:${e.principalId}`))
				.size !== value.executors.length ||
			new Set(value.sharedResourceKeys).size !==
				value.sharedResourceKeys.length ||
			value.sharedResourceKeys.includes(value.makerResourceKey)
		)
			ctx.addIssue({
				code: "custom",
				message: "Lane resources and executors must be distinct",
			});
	});
export type LaneExecutionPolicy = z.infer<typeof LaneExecutionPolicySchema>;

export function laneResourceKeys(
	policy: LaneExecutionPolicy,
	executor: LaneExecutor,
) {
	return [
		...new Set([
			...policy.sharedResourceKeys,
			...(policy.role === "maker" ? [policy.makerResourceKey] : []),
			executor.resourceKey,
		]),
	];
}

export const LaneCheckpointSchema = z
	.object({
		previousAttemptId: key,
		executorId: key,
		/** A stable key is also used by admission and host delivery on replay. */
		key,
		status: z.enum(["reconcile", "ready", "dispatching", "continued", "held"]),
		writeReceiptRefs: z.array(key).max(100),
		uncertainWriteRefs: z.array(key).max(100),
		reconciledRefs: z.array(key).max(100),
		failedCostMicros: micros.nullable(),
		successorExecutorId: key.nullable(),
		successorAttemptId: key.nullable(),
		hostAcknowledgmentRef: key.nullable(),
		deadline: z.iso.datetime(),
		reason: key.nullable(),
	})
	.strict();
export type LaneCheckpoint = z.infer<typeof LaneCheckpointSchema>;
