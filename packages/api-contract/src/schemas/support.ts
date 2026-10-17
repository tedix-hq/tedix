import * as z from "zod";

export const SupportReportSchema = z.strictObject({
	title: z.string().min(1).max(200),
	expected: z.string().min(1).max(2000),
	actual: z.string().min(1).max(2000),
	steps: z.string().max(2000).default(""),
	impact: z.string().max(500).default(""),
	page: z.string().max(500).default(""),
	lastError: z.string().max(500).default(""),
	observedAt: z.iso.datetime(),
	origin: z.enum(["os", "agent", "email"]),
	language: z.enum(["en", "es"]).default("en"),
	diagnosticRefs: z.array(z.string().max(200)).max(10).default([]),
});
export type SupportReport = z.infer<typeof SupportReportSchema>;
export const SupportConsentSchema = z.strictObject({
	reference: z.string().min(1).max(500),
	payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
	approved: z.literal(true),
});
export const FileSupportRequestSchema = z.strictObject({
	idempotencyKey: z.string().min(1).max(128),
	report: SupportReportSchema,
	consent: SupportConsentSchema,
	ticketId: z.uuid().optional(),
	expectedVersion: z.number().int().positive().optional(),
	retest: z.enum(["unblocked", "still-blocked"]).optional(),
});
export const SupportStatusSchema = z.enum([
	"received",
	"triaging",
	"needs-info",
	"in-progress",
	"answered",
	"resolved",
	"closed-without-confirmation",
]);
export const SupportAnswerSchema = z.strictObject({
	body: z.string().min(1).max(4000),
	evidence: z.array(z.string().min(1).max(500)).min(1).max(10),
	nextStep: z.string().min(1).max(500),
});
export const SupportPublicUpdateSchema = z.strictObject({
	version: z.number().int(),
	body: z.string(),
	evidence: z.array(z.string()),
	nextStep: z.string(),
	createdAt: z.string(),
});
export const SupportReceiptSchema = z.strictObject({
	title: z.string(),
	owner: z.string(),
	waitingOn: z.enum(["support", "admin", "reporter", "none"]),
	lastPublicUpdateAt: z.string().nullable(),
	ticketId: z.uuid(),
	workItemId: z.uuid(),
	statusUrl: z.string(),
	status: SupportStatusSchema,
	version: z.number().int(),
	recordedAt: z.string(),
	mirrorDelivery: z.enum(["pending", "delivered"]),
	nextUpdateDue: z.string(),
	reporterVerification: z.enum(["unconfirmed", "unblocked", "still-blocked"]),
	publicUpdates: z.array(SupportPublicUpdateSchema),
	nextPollMs: z.number(),
});
export const SupportConfigurationSchema = z.strictObject({
	platformOrgId: z.uuid(),
	supportTediId: z.uuid(),
	adminUserId: z.string().min(1),
	engineeringTediId: z.uuid().optional(),
	engineeringProjectId: z.uuid().optional(),
	reviewWorkItemId: z.uuid().optional(),
	projectKey: z.string().min(1).max(32).default("SUPPORT"),
	firstResponseMinutes: z.number().int().min(1).default(60),
	nextStepHours: z.number().int().min(1).default(48),
	reviewTimezone: z.string().default("Europe/Berlin"),
	enabled: z.boolean().default(true),
});
export type SupportConfiguration = z.infer<typeof SupportConfigurationSchema>;
