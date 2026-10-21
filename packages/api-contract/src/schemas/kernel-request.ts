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
	z.object({ kind: z.literal("home_response") }).strict(),
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
	z
		.object({
			kind: z.literal("work_commit_delivery"),
			/** Null records a clean exit that named no commit; it never passes. */
			commitSha: sha.nullable(),
			/** Main revision the Attempt started from, when the executor reported it. */
			baseSha: sha.nullable(),
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
		probeAttempts: z.number().int().nonnegative().optional(),
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

/** Operator-owned registry; requests select target IDs, never probe URLs or credentials. */
export const KernelRequestPolicySchema = z
	.object({
		version: z.literal(1),
		enabled: z.boolean(),
		homeCaptureEnabled: z
			.boolean()
			.optional()
			.describe("False stops new Home capture while existing requests drain."),
		homeConversationIds: z
			.array(identity)
			.max(100)
			.optional()
			.describe(
				"Omit for all Home conversations; an empty list captures none.",
			),
		localSessionKeys: z.array(identity).max(100).optional(),
		nextOwner: identity,
		retryMs: z.number().int().min(1000).max(3_600_000),
		probeTimeoutMs: z.number().int().min(100).max(30_000),
		maxProbeAttempts: z.number().int().min(1).max(20),
		runBudgetMs: z.number().int().min(100).max(30_000),
		workAttemptDelivery: z
			.object({
				/** Project whose repository observer records pushes to the delivery branch. */
				observerProjectId: identity,
				/** A SHA not observed on main and deployed within this window fails. */
				verifyWindowMs: z.number().int().min(60_000).max(172_800_000),
				/** Operator-approved timer authority; omission keeps verified Work open. */
				completion: z
					.object({
						projectIds: z.array(identity).min(1).max(100),
						repositoryTargetId: identity,
					})
					.strict()
					.optional(),
			})
			.strict()
			.optional()
			.describe(
				"Present to verify dispatcher Work Attempts against observed main and the deployed revision.",
			),
		repositoryTargets: z
			.array(
				z
					.object({
						id: identity,
						repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
						shipRepository: z
							.string()
							.regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
						workflowId: z.string().regex(/^[A-Za-z0-9_.-]+$/),
						connectionInstanceId: identity.optional(),
						surface: identity,
						liveManifestUrl: z.url({ protocol: /^https$/ }),
						maxAgeMs: z.number().int().min(1000).max(86_400_000),
					})
					.strict(),
			)
			.max(20),
	})
	.strict();
export type KernelRequestPolicy = z.infer<typeof KernelRequestPolicySchema>;
