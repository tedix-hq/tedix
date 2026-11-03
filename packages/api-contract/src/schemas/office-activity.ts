import * as z from "zod";

/** Operational facts only. No free text from host events is accepted here. */
export const OfficeObservationSchema = z.strictObject({
	id: z.uuid(),
	occurrences: z.number().int().min(1).max(1_000_000).default(1),
	reportedState: z
		.enum(["working", "needs_you", "done", "error", "ended"])
		.optional(),
	at: z.iso.datetime(),
	source: z.enum(["hook", "supervisor"]),
	host: z.enum(["claude-code", "codex", "devin", "opencode"]),
	sessionKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/),
	trigger: z.enum([
		"SessionStart",
		"UserPromptSubmit",
		"PreToolUse",
		"PostToolUse",
		"PostToolUseFailure",
		"PermissionRequest",
		"Notification",
		"Stop",
		"StopFailure",
		"SessionEnd",
		"reply_drain",
	]),
	outcome: z.enum(["observed", "success", "deferred", "failed", "unknown"]),
	reason: z.enum([
		"reported",
		"working",
		"session_unavailable",
		"host_mismatch",
		"receipt_unconfirmed",
		"delivery_failed",
		"delivery_confirmed",
		"queue_unconfirmed",
		"resume_running",
	]),
	requestId: z.uuid().optional(),
	responseId: z.uuid().optional(),
	reporterVersion: z
		.string()
		.max(40)
		.regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/),
});
export type OfficeObservation = z.infer<typeof OfficeObservationSchema>;

export const OfficeActivityRowSchema = OfficeObservationSchema.extend({
	workItemId: z.uuid().nullable(),
});
export type OfficeActivityRow = z.infer<typeof OfficeActivityRowSchema>;

export const OfficeCanonicalRowSchema = z.strictObject({
	id: z.string(),
	at: z.string(),
	source: z.enum(["reply", "work"]),
	sessionKey: z.string().nullable(),
	host: z.string().nullable(),
	stage: z.enum([
		"saved",
		"queued",
		"delivered",
		"acknowledged",
		"handed_off",
		"unknown",
		"work_closed",
		"attempt_succeeded",
		"attempt_failed",
	]),
	workItemId: z.string().nullable(),
	attemptId: z.string().nullable(),
	requestId: z.string().nullable(),
	resultRecorded: z.boolean(),
});
export type OfficeCanonicalRow = z.infer<typeof OfficeCanonicalRowSchema>;

export const ListOfficeActivityInputSchema = z.strictObject({
	before: z.strictObject({ at: z.iso.datetime(), id: z.uuid() }).optional(),
	limit: z.number().int().min(1).max(100).default(50),
});
export const ListOfficeActivityResultSchema = z.strictObject({
	rows: z.array(OfficeActivityRowSchema).max(100),
	canonical: z.array(OfficeCanonicalRowSchema).max(300),
	nextBefore: z.strictObject({ at: z.iso.datetime(), id: z.uuid() }).nullable(),
	observedAt: z.iso.datetime(),
	retainedSince: z.iso.datetime(),
});
