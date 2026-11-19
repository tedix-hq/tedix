import * as z from "zod";

// "kernel" = tenant control-plane actor (kernel direct tool calls) —
// distinguishes "Home used a tool for this turn" from generic internal service
// callers (audit contract).
export const AuditActorTypeSchema = z.enum([
	"user",
	"service",
	"tedi",
	"m2m",
	"api_key",
	"anonymous",
	"external_agent",
	"kernel",
]);

export type AuditActorType = z.infer<typeof AuditActorTypeSchema>;

export const AuditSearchFiltersSchema = z.object({
	actorId: z.string().optional(),
	action: z.string().optional(),
	resourceType: z.string().optional(),
	resourceId: z.string().optional(),
	startDate: z.string().datetime().optional(),
	endDate: z.string().datetime().optional(),
});

export const AUDIT_EXPORT_FORMATS = ["csv", "jsonl"] as const;
export const AuditExportFormatSchema = z.enum(AUDIT_EXPORT_FORMATS);
export type AuditExportFormat = z.infer<typeof AuditExportFormatSchema>;

/** Hard ceiling on rows in one export; narrow the filters for more. */
export const AUDIT_EXPORT_MAX_LIMIT = 10_000;
export const AUDIT_EXPORT_DEFAULT_LIMIT = 5_000;

/**
 * A capped export that left matching events out ends its JSON Lines with one
 * `{"_export":{"truncated":true,"events":n,"limit":n}}` line, and either
 * format's filename ends `-truncated-<rows>`.
 */
export const AUDIT_EXPORT_TRUNCATED_MARKER = "_export";
export const AUDIT_EXPORT_TRUNCATED_FILENAME =
	/-truncated-(\d+)\.(?:csv|jsonl)$/;

export const AuditExportInputSchema = AuditSearchFiltersSchema.extend({
	format: AuditExportFormatSchema.default("csv"),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(AUDIT_EXPORT_MAX_LIMIT)
		.default(AUDIT_EXPORT_DEFAULT_LIMIT),
});

export type AuditExportInput = z.input<typeof AuditExportInputSchema>;

/**
 * Attribution keys lifted out of `metadata` into their own CSV columns, in
 * column order. The full `metadata` object is still exported alongside.
 */
export const AUDIT_EXPORT_ATTRIBUTION_KEYS = [
	"subjectUserId",
	"oauthClientId",
	"delegationMode",
	"externalAgentPrincipalId",
	"externalAgentSessionId",
	"ownerHostSessionId",
	"ownerHostPrincipalId",
	"ownerHostHarness",
	"ownerHostModel",
	"requestRunId",
	"requestRootRunId",
	"requestWorkItemId",
	"riskTier",
	"governance",
	"traceId",
	"executionId",
] as const;

/** The export is the file itself: CSV or one JSON event per line. */
export const AuditExportOutputSchema = z.file();

// One stored row per gateway tool call. Arguments are kept only as
// `argsHash`; an undo plan's compensating call is not stored because it
// would carry raw arguments.
const RevisionRefSchema = z.object({
	revisionId: z.string(),
	hash: z.string().optional(),
});
export const GatewayChangeRecordBodySchema = z.object({
	resource: z.string(),
	operation: z.string(),
	actor: z.object({
		id: z.string(),
		kind: z.string(),
		organizationId: z.string().optional(),
	}),
	source: z.object({ surface: z.string(), traceId: z.string().optional() }),
	before: RevisionRefSchema.optional(),
	after: RevisionRefSchema.optional(),
	decision: z.object({
		verdict: z.enum(["allow", "needs_approval", "deny"]),
		gate: z.enum([
			"edge_access",
			"tool_scope",
			"risk_rate_limit",
			"annotation_assertion",
			"destructive_approval",
			"secret_egress",
			"budget",
		]),
		reason: z.string(),
		riskTier: z.enum([
			"read",
			"bounded_write",
			"high_impact_write",
			"external_side_effect",
			"unclassified",
		]),
		blastRadius: z.enum([
			"none",
			"single_resource",
			"tenant",
			"multi_tenant",
			"external_system",
			"unclassified",
		]),
		budget: z
			.object({
				limit: z.number(),
				windowSeconds: z.number(),
				used: z.number().optional(),
				remaining: z.number().optional(),
			})
			.optional(),
		rate: z
			.object({
				limited: z.boolean(),
				retryAfterSeconds: z.number().optional(),
				scope: z.string().optional(),
			})
			.optional(),
		approvalRoute: z.enum(["human", "agent"]).optional(),
	}),
	outcome: z.enum([
		"applied",
		"not_applied",
		"unknown",
		"denied",
		"needs_approval",
	]),
	approval: z
		.object({
			approverId: z.string(),
			approvedAt: z.string(),
			presentedHash: z.string(),
			approvalRequestId: z.string().optional(),
		})
		.optional(),
	undo: z
		.object({
			kind: z.enum(["rollback_revision", "compensating_call", "manual"]),
			toRevision: RevisionRefSchema.optional(),
			instructions: z.string().optional(),
		})
		.optional(),
	argsHash: z.string(),
});
/**
 * A timestamp in the one form `recorded_at` is stored and compared in:
 * `Date.prototype.toISOString()` (UTC, milliseconds). Range reads compare the
 * column as text so its index is used, which is only correct in this form.
 */
const GatewayChangeRecordTimestampSchema = z
	.string()
	.datetime({ offset: true })
	.transform((value) => new Date(value).toISOString());

/**
 * The gateway names the record (`id`, `recordedAt`) so it can answer a call
 * before the write lands. Appending an `id` that is already stored for the
 * organization stores nothing new.
 */
export const GatewayChangeRecordInputSchema =
	GatewayChangeRecordBodySchema.extend({
		id: z.uuid().optional(),
		recordedAt: GatewayChangeRecordTimestampSchema.optional(),
	});
export const GatewayChangeRecordSchema = GatewayChangeRecordBodySchema.extend({
	id: z.uuid(),
	sequence: z.number().int().positive(),
	recordedAt: z.string().datetime(),
});
export const GatewayLedgerQuerySchema = z.strictObject({
	resource: z.string().optional(),
	actorId: z.string().optional(),
	afterSequence: z.number().int().nonnegative().optional(),
	limit: z.number().int().min(1).max(1000).default(1000),
});
/** An owner's or admin's read of their own organization's gateway records. */
export const GatewayChangeRecordsInputSchema = z
	.strictObject({
		from: GatewayChangeRecordTimestampSchema.describe(
			"Inclusive start of the recorded-at time range",
		),
		until: GatewayChangeRecordTimestampSchema.describe(
			"Exclusive end of the recorded-at time range",
		),
		afterSequence: z.number().int().nonnegative().optional(),
		limit: z.number().int().min(1).max(200).default(100),
		resource: z
			.string()
			.min(1)
			.optional()
			.describe("Only records for this resource, such as tool:<tool id>"),
		actorId: z
			.string()
			.min(1)
			.optional()
			.describe("Only records for calls made by this actor"),
	})
	.refine((input) => input.from < input.until, {
		message: "from must precede until",
		path: ["until"],
	});
export const GatewayChangeRecordsExportSchema = z.object({
	from: z.string(),
	until: z.string(),
	exportedAt: z.string(),
	count: z
		.number()
		.int()
		.nonnegative()
		.describe(
			"Total records in the time range and filters, independent of page size and cursor",
		),
	records: z.array(
		GatewayChangeRecordSchema.extend({
			recordDigest: z
				.string()
				.nullable()
				.describe(
					"SHA-256 of the record's content; null until the record is sealed",
				),
			chainHash: z
				.string()
				.nullable()
				.describe(
					"SHA-256 linking the record to the organization's previous record; null until sealed",
				),
		}),
	),
	nextAfterSequence: z.number().int().nullable(),
});

/**
 * Checkpoints of an organization's gateway change records, by sequence or by
 * when they were sealed. Every filter is optional; with none, the read starts
 * at the organization's first checkpoint.
 */
export const GatewayChangeRecordCheckpointsInputSchema = z
	.strictObject({
		fromSequence: z
			.number()
			.int()
			.nonnegative()
			.optional()
			.describe("Only checkpoints whose records end at or after this sequence"),
		untilSequence: z
			.number()
			.int()
			.nonnegative()
			.optional()
			.describe(
				"Only checkpoints whose records start at or before this sequence",
			),
		from: GatewayChangeRecordTimestampSchema.optional().describe(
			"Only checkpoints sealed at or after this time",
		),
		until: GatewayChangeRecordTimestampSchema.optional().describe(
			"Only checkpoints sealed before this time",
		),
		afterLastSequence: z
			.number()
			.int()
			.nonnegative()
			.optional()
			.describe("Page cursor: pass the previous page's nextAfterLastSequence"),
		limit: z.number().int().min(1).max(200).default(100),
	})
	.refine((input) => !input.from || !input.until || input.from < input.until, {
		message: "from must precede until",
		path: ["until"],
	});

/** https://github.com/secure-systems-lab/dsse/blob/master/envelope.md */
export const DsseEnvelopeSchema = z.object({
	payloadType: z.string(),
	payload: z.string(),
	signatures: z.array(z.object({ keyid: z.string(), sig: z.string() })),
});

export const GatewayChangeRecordCheckpointSchema = z.object({
	id: z.string(),
	organizationId: z.string(),
	firstSequence: z.number().int(),
	lastSequence: z.number().int(),
	recordCount: z.number().int(),
	headChainHash: z.string(),
	previousCheckpointDigest: z.string().nullable(),
	previousChainHash: z.string().nullable(),
	checkpointDigest: z.string(),
	sealedAt: z.string(),
	envelope: DsseEnvelopeSchema.nullable().describe(
		"The signed in-toto statement for this checkpoint; null when signing was off",
	),
	keyId: z.string().nullable(),
});

export const GatewayChangeRecordCheckpointsExportSchema = z.object({
	exportedAt: z.string(),
	checkpoints: z.array(GatewayChangeRecordCheckpointSchema),
	nextAfterLastSequence: z.number().int().nullable(),
	publicKey: z
		.object({
			keyId: z.string(),
			algorithm: z.literal("Ed25519"),
			spki: z.string().describe("Base64 SubjectPublicKeyInfo DER"),
		})
		.nullable()
		.describe(
			"The key new checkpoints are signed with, null when signing is off. Confirm it through another channel before trusting it.",
		),
});
export type GatewayChangeRecordInput = z.infer<
	typeof GatewayChangeRecordInputSchema
>;
export type GatewayChangeRecordBody = z.infer<
	typeof GatewayChangeRecordBodySchema
>;
export type GatewayChangeRecord = z.infer<typeof GatewayChangeRecordSchema>;
