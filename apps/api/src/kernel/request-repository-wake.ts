import { durableObjectStubByName } from "@tedix/worker-kit/durable-objects";
import { wakeRepositoryKernelRequests } from "@tedix/db/queries/kernel-requests";
import type { BaseContext } from "../rpc/orpc";
import { readKernelRequestPolicy } from "./request-home-source";

export async function wakeKernelRequestsForRepository(
	context: BaseContext,
	organizationId: string,
	event: { repository: string; projectId: string },
) {
	if (!context.env?.KERNEL) return;
	const policy = await readKernelRequestPolicy(context, organizationId);
	if (!policy) return;
	const targetIds = policy.repositoryTargets
		.filter((target) => target.repository === event.repository)
		.map((target) => target.id);
	const workAttempts =
		policy.workAttemptDelivery?.observerProjectId === event.projectId;
	if (!targetIds.length && !workAttempts) return;
	await wakeRepositoryKernelRequests(context.db, {
		organizationId,
		targetIds,
		workAttempts,
		now: new Date().toISOString(),
	});
	// A hint only advances the timer. The coordinator re-reads canonical state.
	await durableObjectStubByName(
		context.env.KERNEL,
		context.env,
		organizationId,
	).ensureRequestReconciliation({ organizationId });
}
