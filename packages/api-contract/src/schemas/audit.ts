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
