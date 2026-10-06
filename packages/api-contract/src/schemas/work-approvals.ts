import * as z from "zod";
import { BoundedJsonObjectSchema } from "./bounded-json";
import {
	WorkItemSchema,
	WorkAdmissionSpecificationReceiptSchema,
	WorkFactoryProjectionCursorSchema,
	WorkPrincipalTypeSchema,
} from "./work-items";

export const WorkApprovalStatusSchema = z.enum([
	"pending",
	"approved",
	"rejected",
	"cancelled",
	"expired",
]);
export type WorkApprovalStatus = z.infer<typeof WorkApprovalStatusSchema>;

export const WorkApprovalDecisionSchema = z.enum(["approved", "rejected"]);

export const WorkApprovalCursorSchema = WorkFactoryProjectionCursorSchema;

export const WorkApprovalProposalSchema = z.strictObject({
	id: z.uuid(),
	orgId: z.uuid(),
	workItemId: z.uuid(),
	workItemVersion: z.number().int().positive(),
	action: z
		.string()
		.trim()
		.min(1)
		.max(100)
		.regex(/^[a-z][a-z0-9_]*$/),
	proposal: BoundedJsonObjectSchema,
	authorityKey: z
		.string()
		.trim()
		.min(1)
		.max(200)
		.regex(/^[a-z][a-z0-9_.:-]*$/),
	approverType: z.enum(["user", "tedi"]),
	approverId: z.string().trim().min(1).max(300),
	requestRationale: z.string().trim().min(1).max(10_000),
	requestedByType: WorkPrincipalTypeSchema,
	requestedById: z.string().trim().min(1).max(300),
	requestedBySessionId: z
		.string()
		.max(300)
		.nullable()
		.describe(
			"Present only for external-agent requesters with an immutable active session.",
		),
	status: WorkApprovalStatusSchema,
	requestedAt: z.iso.datetime(),
	expiresAt: z.iso.datetime(),
	resolvedAt: z.iso
		.datetime()
		.nullable()
		.describe("Null while the approval proposal remains pending."),
	version: z.number().int().positive(),
});

export const WorkApprovalDecisionReceiptSchema = z.strictObject({
	id: z.uuid(),
	proposalId: z.uuid(),
	resolvedProposalVersion: z.number().int().positive(),
	decision: WorkApprovalDecisionSchema,
	deciderType: WorkPrincipalTypeSchema.extract(["user", "tedi"]),
	deciderId: z.string().trim().min(1).max(300),
	rationale: z.string().trim().min(1).max(10_000),
	decidedAt: z.iso.datetime(),
});

export const WorkApprovalInboxRowSchema = z.strictObject({
	proposal: WorkApprovalProposalSchema,
	effectiveStatus: WorkApprovalStatusSchema,
	canDecide: z
		.boolean()
		.describe(
			"True only in the authenticated actor's inbox while the exact proposal remains pending.",
		),
	decision: WorkApprovalDecisionReceiptSchema.nullable().describe(
		"Null until the proposal is approved or rejected by its designated approver.",
	),
	workItem: WorkItemSchema,
	admissionSpecification: WorkAdmissionSpecificationReceiptSchema,
});

export const CreateWorkApprovalProposalInputSchema = z.strictObject({
	workItemId: z.uuid(),
	workItemVersion: z.number().int().positive(),
	proposal: WorkApprovalProposalSchema.shape.proposal,
	authorityKey: WorkApprovalProposalSchema.shape.authorityKey,
	approverType: WorkApprovalProposalSchema.shape.approverType,
	approverId: WorkApprovalProposalSchema.shape.approverId,
	requestRationale: WorkApprovalProposalSchema.shape.requestRationale,
	expiresAt: z.iso.datetime(),
});

export const DecideWorkApprovalProposalInputSchema = z.strictObject({
	proposalId: z.uuid(),
	expectedProposalVersion: z.number().int().positive(),
	decision: WorkApprovalDecisionSchema,
	rationale: WorkApprovalDecisionReceiptSchema.shape.rationale,
});

export const ListWorkApprovalInboxInputSchema = z.strictObject({
	proposalId: z
		.uuid()
		.optional()
		.describe(
			"Optional exact proposal filter; designation and organization boundaries still apply.",
		),
	statuses: z
		.array(WorkApprovalStatusSchema)
		.min(1)
		.max(5)
		.optional()
		.describe(
			"Optional status filter; omission includes every effective approval status.",
		),
	workItemId: z
		.uuid()
		.optional()
		.describe("Optional Work Item filter for a scoped approval inbox."),
	projectId: z
		.uuid()
		.optional()
		.describe("Optional project filter for a scoped approval inbox."),
	authorityKey: WorkApprovalProposalSchema.shape.authorityKey
		.optional()
		.describe(
			"Optional authority filter; omission includes every authority requested from the caller.",
		),
	cursor: WorkApprovalCursorSchema.optional().describe(
		"Opaque inbox continuation cursor; omit to read the newest page.",
	),
	limit: z.number().int().min(1).max(100).default(50),
});

export const ListWorkApprovalInboxResultSchema = z.strictObject({
	data: z.array(WorkApprovalInboxRowSchema),
	nextCursor: WorkApprovalCursorSchema.nullable().describe(
		"Null when the bounded approval inbox has no further page.",
	),
	hasMore: z.boolean(),
	observedAt: z.iso.datetime(),
});
