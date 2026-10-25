import * as z from "zod";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
export const RepositoryObserverConfigSchema = z.strictObject({
	repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
	branch: z.string().min(1).max(200).default("main"),
	pauseWithFactorySchedule: z
		.boolean()
		.describe(
			"Reject events while the linked factory schedule is paused or missing",
		)
		.default(true),
	pushWorkflow: z
		.string()
		.regex(/^\.github\/workflows\/[\w.-]+\.ya?ml$/)
		.default(".github/workflows/tedix-observer.yml"),
	shipRepository: z
		.string()
		.regex(/^[\w.-]+\/[\w.-]+$/)
		.optional(),
	shipWorkflow: z
		.string()
		.regex(/^\.github\/workflows\/[\w.-]+\.ya?ml$/)
		.default(".github/workflows/tedix-observer.yml"),
	ownerTediId: z.uuid(),
	maxActivePushWakes: z
		.number()
		.int()
		.min(1)
		.max(10)
		.describe(
			"Push observations the owner tedi works on at once; later pushes wait for a free slot, newest first",
		)
		.default(2),
	escalationUserId: z.string().min(1),
	instructions: z.string().min(20).max(12000),
	diagnosticLessonIds: z.array(z.uuid()).max(50).default([]),
	// Only a human administrator installs standing repair recipes.
	repairs: z
		.array(
			z.discriminatedUnion("kind", [
				z.strictObject({
					kind: z.literal("source_patch"),
					lessonId: z.uuid(),
					autoFixable: z.literal(true),
					skillId: z.uuid(),
					skillRevision: z.number().int().positive(),
					allowedPaths: z.array(z.string().min(1)).min(1).max(100),
				}),
				z.strictObject({
					kind: z.literal("retry"),
					lessonId: z.uuid(),
					autoFixable: z.literal(true),
				}),
			]),
		)
		.max(20)
		.default([]),
});
export const RepositoryEventSchema = z.strictObject({
	projectId: z.uuid(),
	repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
	branch: z.string().min(1).max(200),
	sha,
	beforeSha: sha.optional(),
	/** Every commit the push added to the branch, newest first; capped. */
	commitShas: z.array(sha).max(100).optional(),
	occurredAt: z.iso.datetime().optional(),
	kind: z.enum(["push", "ship_red", "ship_green", "ci_red", "ci_green"]),
	// Same incident across retries: a new run ID is evidence, not a new repair budget.
	surface: z.string().max(100).default("all"),
	paths: z.array(z.string().min(1).max(500)).max(500).default([]),
	commands: z.string().max(4000).default(""),
	summary: z.string().max(24000),
	evidenceUrl: z.url().max(2000),
	workItemId: z.uuid().optional(),
	repairObservationId: z.uuid().optional(),
});
export const RepositoryReviewSchema = z.strictObject({
	observationId: z.uuid(),
	diagnosis: z.string().min(10).max(12000),
	lessons: z
		.array(
			z.strictObject({
				lessonId: z.uuid(),
				verdict: z.enum([
					"applied",
					"not_applied",
					"not_applicable",
					"unknown",
				]),
				evidence: z.string().min(1).max(4000),
				fix: z.string().max(6000),
			}),
		)
		.max(50),
	stillRed: z.boolean().default(false),
});
export type RepositoryObserverConfig = z.infer<
	typeof RepositoryObserverConfigSchema
>;
export type RepositoryEvent = z.infer<typeof RepositoryEventSchema>;
