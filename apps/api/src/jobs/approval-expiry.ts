/**
 * Closes approval requests whose window has passed. An expired request was
 * never approved, so nothing runs; closing it takes it off every waiting list
 * instead of leaving it there until another approval happens to start.
 */
export async function expireOverdueApprovals(
	env: CloudflareEnv,
	dueIds?: string[],
): Promise<Record<string, number>> {
	const { coreDb } = await import("@tedix/db/core-store/scope");
	const { expireStaleApprovals } = await import("@tedix/db/queries/approvals");

	const expired = await expireStaleApprovals(coreDb(env), {
		dueIds,
	});
	return { expired };
}
