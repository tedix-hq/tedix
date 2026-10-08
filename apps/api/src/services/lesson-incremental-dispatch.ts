/**
 * Start one person's incremental lesson distillation
 * (`lesson-map-reduce.ts` `distillOwnerIncrementally`) as a Workflow
 * instance, so a new decision reaches their next session in a minute or two.
 * Fail-soft: the nightly run re-reads the whole history anyway.
 */
export async function startIncrementalLessons(
	env: Pick<CloudflareEnv, "MEMORY_REFLECTION_WORKFLOW">,
	organizationId: string,
	ownerUserId: string,
): Promise<boolean> {
	try {
		await env.MEMORY_REFLECTION_WORKFLOW.create({
			id: `lessons-inc-${organizationId}-${crypto.randomUUID()}`.slice(0, 100),
			params: {
				organizationId,
				scope: "lessons-incremental" as const,
				ownerUserId,
			},
		});
		return true;
	} catch (error) {
		console.error("[learning-feed] incremental lesson start failed:", error);
		return false;
	}
}
