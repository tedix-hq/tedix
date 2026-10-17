import { z } from "zod";

export const KernelRequestStateSchema = z.enum([
	"received",
	"filed",
	"briefed",
	"running",
	"verifying",
	"reported",
	"learned",
	"cancelled",
]);
export type KernelRequestState = z.infer<typeof KernelRequestStateSchema>;

const identity = z.string().trim().min(1).max(300);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
export const KernelAcceptanceCheckSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("os_output_revision"),
			outputId: identity,
			revisionId: identity,
		})
		.strict(),
	z
		.object({
			kind: z.literal("repository_delivery"),
			targetId: identity,
			commitSha: sha,
			surface: identity,
		})
		.strict(),
]);
export type KernelAcceptanceCheck = z.infer<typeof KernelAcceptanceCheckSchema>;

export const KernelAcceptanceObservationSchema = z
	.object({
		checkerVersion: z.literal(1),
		checkIndex: z.number().int().nonnegative(),
		inputDigest: z.string().min(1),
		status: z.enum(["pass", "fail", "unknown"]),
		observedVersion: z.string().nullable(),
		checkedAt: z.iso.datetime(),
		evidenceRefs: z.array(z.string().min(1)).max(20),
		limitations: z.string().nullable(),
	})
	.strict();
export type KernelAcceptanceObservation = z.infer<
	typeof KernelAcceptanceObservationSchema
>;

/** Source adapters establish ACLs; this record never contains private prompt text. */
export const KernelRequestSnapshotSchema = z
	.object({
		state: KernelRequestStateSchema,
		workItemId: identity.nullable(),
		attemptId: identity.nullable(),
		briefRevision: z.number().int().nonnegative(),
		checks: z.array(KernelAcceptanceCheckSchema).max(20),
		acceptanceKey: z.string().nullable(),
		observations: z.array(KernelAcceptanceObservationSchema).max(20),
		outcome: z.enum(["verified", "failed", "unknown"]).nullable(),
		delivery: z
			.object({
				intentId: identity,
				status: z.enum(["pending", "acknowledged", "unavailable"]),
				receiptRef: z.string().nullable(),
			})
			.strict()
			.nullable(),
		learning: z.enum(["pending", "lesson_saved", "no_new_lesson"]).nullable(),
	})
	.strict();
export type KernelRequestSnapshot = z.infer<typeof KernelRequestSnapshotSchema>;
