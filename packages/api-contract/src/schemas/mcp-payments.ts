import * as z from "zod";
import { JsonValueSchema } from "./common";

export const McpPaymentEventTypeSchema = z.enum([
	"payment_required",
	"payment_settled",
	"payment_rejected",
]);
export type McpPaymentEventType = z.infer<typeof McpPaymentEventTypeSchema>;

export const McpPaymentStatusSchema = z.enum([
	"required",
	"settled",
	"rejected",
]);
export type McpPaymentStatus = z.infer<typeof McpPaymentStatusSchema>;

const JsonRecordSchema = z.record(z.string(), JsonValueSchema);
const AmountStringSchema = z
	.string()
	.regex(/^(0|[1-9]\d*)(\.\d{1,18})?$/, "Must be a decimal amount string");

export const McpPaymentEventSchema = z.object({
	id: z.string(),
	requirementId: z.string(),
	eventType: McpPaymentEventTypeSchema,
	status: McpPaymentStatusSchema,
	protocol: z.string(),
	mode: z.string(),
	network: z.string(),
	asset: z.string().nullable(),
	currency: z.string().nullable(),
	amount: z.string(),
	recipient: z.string(),
	resource: z.string().nullable(),
	appId: z.string().nullable(),
	appSlug: z.string(),
	organizationId: z.string().nullable(),
	toolRowId: z.string().nullable(),
	toolId: z.string(),
	tediId: z.string().nullable(),
	userId: z.string().nullable(),
	clientId: z.string().nullable(),
	authType: z.string().nullable(),
	traceId: z.string().nullable(),
	toolArgsHash: z.string().nullable(),
	settled: z.boolean(),
	requirements: JsonRecordSchema.nullable(),
	paymentProof: JsonRecordSchema.nullable(),
	paymentResponse: JsonRecordSchema.nullable(),
	budgetPolicy: JsonRecordSchema.nullable(),
	budgetDecision: JsonRecordSchema.nullable(),
	decisionRationale: z.string().nullable(),
	auditEventId: z.string().nullable(),
	rationaleRecordId: z.string().nullable(),
	createdAt: z.string(),
});
export type McpPaymentEvent = z.infer<typeof McpPaymentEventSchema>;

export const McpPaymentListEventsInputSchema = z.object({
	appSlug: z.string().min(1).max(100).optional(),
	toolId: z.string().min(1).max(200).optional(),
	requirementId: z.string().min(1).max(200).optional(),
	tediId: z.uuid().optional(),
	status: McpPaymentStatusSchema.optional(),
	limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type McpPaymentListEventsInput = z.infer<
	typeof McpPaymentListEventsInputSchema
>;

export const McpPaymentListEventsOutputSchema = z.object({
	events: z.array(McpPaymentEventSchema),
});
export type McpPaymentListEventsOutput = z.infer<
	typeof McpPaymentListEventsOutputSchema
>;

export const McpPaymentRequestBudgetOverrideInputSchema = z.object({
	rejectedEventId: z.uuid(),
	reason: z.string().trim().min(1).max(1000),
});
export const McpPaymentRequestBudgetOverrideOutputSchema = z.object({
	approvalRequestId: z.uuid(),
	status: z.enum(["pending", "approved", "rejected", "cancelled", "expired"]),
	created: z.boolean(),
});

export const McpPaymentGetReceiptInputSchema = z.object({
	id: z.string().min(1).max(200),
});
export type McpPaymentGetReceiptInput = z.infer<
	typeof McpPaymentGetReceiptInputSchema
>;

export const McpPaymentGetReceiptOutputSchema = z.object({
	receipt: McpPaymentEventSchema,
	events: z.array(McpPaymentEventSchema),
});
export type McpPaymentGetReceiptOutput = z.infer<
	typeof McpPaymentGetReceiptOutputSchema
>;

export const McpPaymentSpendSummaryInputSchema = z.object({
	tediId: z.uuid().optional(),
	appSlug: z.string().min(1).max(100).optional(),
	toolId: z.string().min(1).max(200).optional(),
	lastHours: z.coerce
		.number()
		.int()
		.min(1)
		.max(24 * 90)
		.default(24),
	limit: z.coerce.number().int().min(1).max(250).default(100),
});
export type McpPaymentSpendSummaryInput = z.infer<
	typeof McpPaymentSpendSummaryInputSchema
>;

export const McpPaymentSpendSummaryRowSchema = z.object({
	appSlug: z.string(),
	toolId: z.string(),
	currency: z.string().nullable(),
	asset: z.string().nullable(),
	network: z.string(),
	settledCount: z.number(),
	totalAmount: z.number(),
	firstSettledAt: z.string().nullable(),
	lastSettledAt: z.string().nullable(),
});
export type McpPaymentSpendSummaryRow = z.infer<
	typeof McpPaymentSpendSummaryRowSchema
>;

export const McpPaymentSpendSummaryOutputSchema = z.object({
	lastHours: z.number(),
	since: z.string(),
	summary: z.array(McpPaymentSpendSummaryRowSchema),
	totals: z.array(
		z.object({
			currency: z.string().nullable(),
			asset: z.string().nullable(),
			network: z.string(),
			settledCount: z.number(),
			totalAmount: z.number(),
		}),
	),
});
export type McpPaymentSpendSummaryOutput = z.infer<
	typeof McpPaymentSpendSummaryOutputSchema
>;

export const McpPaymentPolicyModeSchema = z.enum(["enforce", "warn"]);
export type McpPaymentPolicyMode = z.infer<typeof McpPaymentPolicyModeSchema>;

export const McpPaymentPolicySchema = z.object({
	id: z.string(),
	organizationId: z.string(),
	tediId: z.string().nullable(),
	appSlug: z.string().nullable(),
	toolId: z.string().nullable(),
	currency: z.string(),
	network: z.string(),
	enabled: z.boolean(),
	maxAmount: z.string(),
	maxTransactionAmount: z.string().nullable(),
	allowedRecipients: z.array(z.string()).nullable(),
	allowedTools: z.array(z.string()).nullable(),
	windowSeconds: z.number(),
	mode: McpPaymentPolicyModeSchema,
	createdBy: z.string().nullable(),
	updatedBy: z.string().nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
});
export type McpPaymentPolicy = z.infer<typeof McpPaymentPolicySchema>;

export const McpPaymentListPoliciesInputSchema = z.object({
	tediId: z.uuid().optional(),
	appSlug: z.string().min(1).max(100).optional(),
	toolId: z.string().min(1).max(200).optional(),
	enabled: z.boolean().optional(),
	limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type McpPaymentListPoliciesInput = z.infer<
	typeof McpPaymentListPoliciesInputSchema
>;

export const McpPaymentListPoliciesOutputSchema = z.object({
	policies: z.array(McpPaymentPolicySchema),
});
export type McpPaymentListPoliciesOutput = z.infer<
	typeof McpPaymentListPoliciesOutputSchema
>;

export const McpPaymentSetBudgetPolicyInputSchema = z.object({
	tediId: z.uuid().optional(),
	appSlug: z.string().min(1).max(100).optional(),
	toolId: z.string().min(1).max(200).optional(),
	currency: z.string().min(1).max(32).default("USDC"),
	network: z.string().min(1).max(100).default("solana-devnet"),
	enabled: z.boolean().default(true),
	maxAmount: AmountStringSchema,
	maxTransactionAmount: AmountStringSchema.nullable().optional(),
	allowedRecipients: z
		.array(z.string().min(1).max(200))
		.max(100)
		.nullable()
		.optional(),
	allowedTools: z
		.array(
			z
				.string()
				.min(3)
				.max(300)
				.regex(/^[^:]+:[^:]+$/, "Use appSlug:toolId"),
		)
		.max(100)
		.nullable()
		.optional(),
	windowSeconds: z.coerce
		.number()
		.int()
		.min(60)
		.max(60 * 60 * 24 * 90)
		.default(86_400),
	mode: McpPaymentPolicyModeSchema.default("enforce"),
});
export type McpPaymentSetBudgetPolicyInput = z.infer<
	typeof McpPaymentSetBudgetPolicyInputSchema
>;

export const McpPaymentSetBudgetPolicyOutputSchema = z.object({
	policy: McpPaymentPolicySchema,
});
export type McpPaymentSetBudgetPolicyOutput = z.infer<
	typeof McpPaymentSetBudgetPolicyOutputSchema
>;

export const McpPaymentGetEffectivePolicyInputSchema = z.object({
	tediId: z.uuid().optional(),
	appSlug: z.string().min(1).max(100),
	toolId: z.string().min(1).max(200),
	currency: z.string().min(1).max(32).default("USDC"),
	network: z.string().min(1).max(100).default("solana-devnet"),
});
export type McpPaymentGetEffectivePolicyInput = z.infer<
	typeof McpPaymentGetEffectivePolicyInputSchema
>;

export const McpPaymentGetEffectivePolicyOutputSchema = z.object({
	policy: McpPaymentPolicySchema.nullable(),
});
export type McpPaymentGetEffectivePolicyOutput = z.infer<
	typeof McpPaymentGetEffectivePolicyOutputSchema
>;

export const McpPaymentDisablePolicyInputSchema = z.object({
	id: z.string().min(1).max(300),
});
export type McpPaymentDisablePolicyInput = z.infer<
	typeof McpPaymentDisablePolicyInputSchema
>;

export const McpPaymentDisablePolicyOutputSchema = z.object({
	policy: McpPaymentPolicySchema,
});
export type McpPaymentDisablePolicyOutput = z.infer<
	typeof McpPaymentDisablePolicyOutputSchema
>;

export const McpPaymentAccountStatusSchema = z.enum([
	"active",
	"paused",
	"disabled",
]);
export type McpPaymentAccountStatus = z.infer<
	typeof McpPaymentAccountStatusSchema
>;

export const McpPaymentCustodyModeSchema = z.enum([
	"mock",
	"watch_only",
	"delegated",
	"non_custodial",
]);
export type McpPaymentCustodyMode = z.infer<typeof McpPaymentCustodyModeSchema>;

export const McpPaymentSignerProviderSchema = z.enum([
	"mock",
	"pay_sh",
	"privy",
	"solana_pay",
	"manual",
]);
export type McpPaymentSignerProvider = z.infer<
	typeof McpPaymentSignerProviderSchema
>;

export const McpPaymentAccountSchema = z.object({
	id: z.string(),
	organizationId: z.string(),
	tediId: z.string().nullable(),
	appSlug: z.string().nullable(),
	label: z.string(),
	network: z.string(),
	asset: z.string(),
	publicAddress: z.string(),
	status: McpPaymentAccountStatusSchema,
	custodyMode: McpPaymentCustodyModeSchema,
	signerProvider: McpPaymentSignerProviderSchema,
	metadata: JsonRecordSchema.nullable(),
	createdBy: z.string().nullable(),
	updatedBy: z.string().nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
});
export type McpPaymentAccount = z.infer<typeof McpPaymentAccountSchema>;

export const McpPaymentListAccountsInputSchema = z.object({
	tediId: z.uuid().optional(),
	appSlug: z.string().min(1).max(100).optional(),
	network: z.string().min(1).max(100).optional(),
	asset: z.string().min(1).max(32).optional(),
	status: McpPaymentAccountStatusSchema.optional(),
	limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type McpPaymentListAccountsInput = z.infer<
	typeof McpPaymentListAccountsInputSchema
>;

export const McpPaymentListAccountsOutputSchema = z.object({
	accounts: z.array(McpPaymentAccountSchema),
});
export type McpPaymentListAccountsOutput = z.infer<
	typeof McpPaymentListAccountsOutputSchema
>;

export const McpPaymentRegisterAccountInputSchema = z.object({
	tediId: z.uuid().optional(),
	appSlug: z.string().min(1).max(100).optional(),
	label: z.string().min(1).max(120),
	network: z.string().min(1).max(100).default("solana-devnet"),
	asset: z.string().min(1).max(32).default("USDC"),
	publicAddress: z.string().min(1).max(200),
	status: McpPaymentAccountStatusSchema.default("active"),
	custodyMode: McpPaymentCustodyModeSchema.default("mock"),
	signerProvider: McpPaymentSignerProviderSchema.default("mock"),
	metadata: JsonRecordSchema.optional(),
});
export type McpPaymentRegisterAccountInput = z.infer<
	typeof McpPaymentRegisterAccountInputSchema
>;

export const McpPaymentRegisterAccountOutputSchema = z.object({
	account: McpPaymentAccountSchema,
});
export type McpPaymentRegisterAccountOutput = z.infer<
	typeof McpPaymentRegisterAccountOutputSchema
>;

export const McpPaymentReservationStatusSchema = z.enum([
	"reserved",
	"settled",
	"rejected",
	"expired",
	"canceled",
]);
export type McpPaymentReservationStatus = z.infer<
	typeof McpPaymentReservationStatusSchema
>;

export const McpPaymentReservationSchema = z.object({
	id: z.string(),
	requirementId: z.string(),
	organizationId: z.string(),
	tediId: z.string().nullable(),
	appSlug: z.string(),
	toolId: z.string(),
	accountId: z.string().nullable(),
	policyId: z.string().nullable(),
	status: McpPaymentReservationStatusSchema,
	protocol: z.string(),
	mode: z.string(),
	network: z.string(),
	asset: z.string().nullable(),
	currency: z.string().nullable(),
	amount: z.string(),
	recipient: z.string(),
	resource: z.string().nullable(),
	expiresAt: z.string(),
	settledEventId: z.string().nullable(),
	metadata: JsonRecordSchema.nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
});
export type McpPaymentReservation = z.infer<typeof McpPaymentReservationSchema>;

export const McpPaymentListReservationsInputSchema = z.object({
	tediId: z.uuid().optional(),
	appSlug: z.string().min(1).max(100).optional(),
	toolId: z.string().min(1).max(200).optional(),
	status: McpPaymentReservationStatusSchema.optional(),
	limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type McpPaymentListReservationsInput = z.infer<
	typeof McpPaymentListReservationsInputSchema
>;

export const McpPaymentListReservationsOutputSchema = z.object({
	reservations: z.array(McpPaymentReservationSchema),
});
export type McpPaymentListReservationsOutput = z.infer<
	typeof McpPaymentListReservationsOutputSchema
>;
