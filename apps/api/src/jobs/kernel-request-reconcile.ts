import { createDbQueryClient } from "@tedix/db/query-client";
import {
	DISPATCHER_ATTEMPT_CAPTURE_LOOKBACK_MS,
	listDispatcherAttemptCaptureOrganizations,
	listDueKernelRequestOrganizations,
} from "@tedix/db/queries/kernel-requests";
import { PlatformCronPathError } from "./platform-cron-receipts";

/**
 * Remote follow-through on the two-minute platform tick: one
 * `reconcileRequests` call per tenant Durable Object that has due kernel
 * requests or dispatcher settlements not yet captured. Both listings are
 * bounded at five organizations (oldest due first), so a backlog drains over
 * consecutive ticks instead of one tick fanning out unbounded remote calls.
 *
 * This is its own receipt (`kernel-request-reconcile`), separate from the
 * pure-D1 lease sweep it used to ride. Every listed organization is attempted
 * even when an earlier reconcile rejects, then the failures surface in one
 * `PlatformCronPathError` so the receipt records both the partial counts and
 * the per-organization diagnostics. A rejected reconcile leaves its requests
 * due; the next tick retries them at the same cadence.
 */
export async function reconcileDueKernelRequests(
	env: CloudflareEnv,
	scheduledTime: number,
): Promise<Record<string, number>> {
	const counts = {
		kernelReconcileOrganizations: 0,
		requestsRecovered: 0,
		requestRecoveryFailures: 0,
	};
	if (!env.KERNEL) return counts;
	const db = createDbQueryClient(env.DB);
	// Dispatcher settlements enter the tracker inside the same reconcile call.
	const organizations = new Set(
		[
			...(await listDueKernelRequestOrganizations(
				db,
				new Date(scheduledTime).toISOString(),
			)),
			...(await listDispatcherAttemptCaptureOrganizations(
				db,
				new Date(
					scheduledTime - DISPATCHER_ATTEMPT_CAPTURE_LOOKBACK_MS,
				).toISOString(),
			)),
		].map((row) => row.organizationId),
	);
	counts.kernelReconcileOrganizations = organizations.size;
	const failures: unknown[] = [];
	for (const result of await Promise.allSettled(
		[...organizations].map((organizationId) =>
			env.KERNEL.get(env.KERNEL.idFromName(organizationId)).reconcileRequests({
				organizationId,
			}),
		),
	)) {
		if (result.status === "fulfilled") counts.requestsRecovered += result.value;
		else {
			counts.requestRecoveryFailures++;
			failures.push(result.reason);
		}
	}
	if (failures.length)
		throw new PlatformCronPathError(
			failures,
			"Kernel request reconciliation failed",
			counts,
		);
	return counts;
}
