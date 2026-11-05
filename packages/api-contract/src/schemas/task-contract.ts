import * as z from "zod";
import { WorkItemSchema } from "./work-items";

const Id = z.string().min(1).max(300);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Check = z.strictObject({ id: Id, description: z.string().min(1) });
const Gate = z.strictObject({ id: Id, approverId: Id });

export const TaskContractWorkSchema = WorkItemSchema.pick({
	id: true,
	orgId: true,
	version: true,
	title: true,
	description: true,
	disposition: true,
	acceptanceContract: true,
	requiredCapabilities: true,
	requiredAuthorities: true,
});

export const TaskContractSchema = z.strictObject({
	format: z.literal("tedix.task-contract/v1"),
	contractId: z.uuid(),
	nonce: z.uuid(),
	workItemId: z.uuid(),
	workVersion: z.number().int().positive(),
	orgId: z.uuid(),
	title: z.string().min(1),
	acceptedOutcome: z.string().min(1),
	acceptanceChecks: z
		.array(Check)
		.min(1)
		.refine(
			(checks) =>
				new Set(checks.map((check) => check.id)).size === checks.length,
			"Acceptance check IDs must be unique",
		),
	scope: z.strictObject({
		capabilities: z.array(Id),
		resources: z.array(Id),
	}),
	budget: z.strictObject({
		maxTokens: z.number().int().nonnegative(),
		maxCostUsd: z.number().finite().nonnegative(),
	}),
	requiredAuthorities: z.array(Id),
	humanGates: z
		.array(Gate)
		.refine(
			(gates) => new Set(gates.map((gate) => gate.id)).size === gates.length,
			"Human gate IDs must be unique",
		),
	expiresAt: z.iso.datetime(),
	execution: z.strictObject({
		runtimeId: Id,
		spiffeId: z.string().regex(/^spiffe:\/\/[^/]+\/.+/),
		modelCalls: z.literal("external_gateway"),
	}),
});

export const TaskApprovalSchema = z.strictObject({
	orgId: z.uuid(),
	contractDigest: Digest,
	gateId: Id,
	approverId: Id,
	actorType: z.literal("human"),
	decision: z.literal("approved"),
	reference: Id,
	expiresAt: z.iso.datetime(),
});

export const TaskResultSchema = z.strictObject({
	orgId: z.uuid(),
	contractId: z.uuid(),
	contractDigest: Digest,
	nonce: z.uuid(),
	runId: Id,
	runtimeId: Id,
	spiffeId: z.string().regex(/^spiffe:\/\/[^/]+\/.+/),
	claims: z.array(z.string().min(1)),
	evidenceRefs: z.array(Id).min(1),
});

export const TaskSignatureSchema = z.strictObject({
	keyId: Id,
	value: z.string().min(1),
});

export const SignedTaskApprovalSchema = z.strictObject({
	payload: TaskApprovalSchema,
	signature: TaskSignatureSchema,
});
export const SignedTaskResultSchema = z.strictObject({
	payload: TaskResultSchema,
	signature: TaskSignatureSchema,
});

export const TaskVerifiedOutcomeSchema = z.strictObject({
	checkId: Id,
	passed: z.boolean(),
	evidenceRefs: z.array(Id).min(1),
});

export const TaskReceiptSchema = z.strictObject({
	format: z.literal("tedix.task-receipt/v1"),
	orgId: z.uuid(),
	workItemId: z.uuid(),
	workVersion: z.number().int().positive(),
	contractId: z.uuid(),
	contractDigest: Digest,
	resultDigest: Digest,
	result: SignedTaskResultSchema,
	approvals: z.array(SignedTaskApprovalSchema),
	verifiedOutcomes: z.array(TaskVerifiedOutcomeSchema).min(1),
	verifiedAt: z.iso.datetime(),
});

export type TaskContract = z.infer<typeof TaskContractSchema>;
export type TaskApproval = z.infer<typeof TaskApprovalSchema>;
export type TaskResult = z.infer<typeof TaskResultSchema>;
export type SignedTaskApproval = z.infer<typeof SignedTaskApprovalSchema>;
export type SignedTaskResult = z.infer<typeof SignedTaskResultSchema>;
export type TaskVerifiedOutcome = z.infer<typeof TaskVerifiedOutcomeSchema>;
export type TaskReceipt = z.infer<typeof TaskReceiptSchema>;
