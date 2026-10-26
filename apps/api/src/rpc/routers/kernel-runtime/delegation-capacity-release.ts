import { safeExceptionTopology } from "../../../lib/safe-log-metadata";
import {
	countActiveDelegatedRunsByTedi,
	type KernelRuntimeRun,
} from "@tedix/db/queries/kernel-runtime-runs";
import { isCapacityDeferredDelegation } from "../../../kernel/delegation-deferral";
import type { BaseContext } from "../../orpc";
import {
	DELEGATION_LOAD_WINDOW_MS,
	delegationCapacity,
} from "../kernel/delegation-load";
import { getTediCapabilityCards } from "../kernel/tedi-capabilities";
import { respondKernelDelegationRecommendationApprovalCore } from "./approval-control";
import { kernelDelegationRecommendationFromRun } from "./turn-delegation";

/**
 * Start capacity-deferred delegations, oldest first, while their target tedi
 * has a free delegated-run slot. Runs from the org KernelDO's reconciliation
 * sweep; no human or approval tedi is involved. Returns the started run ids.
 */
export async function releaseCapacityDeferredDelegations(
	context: BaseContext,
	organizationId: string,
	runs: readonly KernelRuntimeRun[],
): Promise<string[]> {
	const deferred = runs
		.filter(isCapacityDeferredDelegation)
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	if (deferred.length === 0) return [];
	const [load, cards] = await Promise.all([
		countActiveDelegatedRunsByTedi(context.db, {
			organizationId,
			updatedSince: new Date(
				Date.now() - DELEGATION_LOAD_WINDOW_MS,
			).toISOString(),
		}),
		getTediCapabilityCards(context.db, organizationId),
	]);
	const started: string[] = [];
	for (const run of deferred) {
		const pending = kernelDelegationRecommendationFromRun(run, "deferred");
		const card = cards.find((c) => c.tediId === pending?.targetTediId);
		if (!pending || !card) continue;
		const capacity = delegationCapacity(card, load);
		if (capacity.active >= capacity.limit) continue;
		try {
			await respondKernelDelegationRecommendationApprovalCore(context, {
				organizationId,
				run,
				decision: "approve",
				resolvedBy: { type: "policy", id: "delegation-capacity" },
				note: `${card.name} had a free delegated-run slot; started automatically.`,
				capacityRelease: true,
			});
			load.set(card.tediId, capacity.active + 1);
			started.push(run.id);
		} catch (error) {
			console.warn("[kernel] capacity-deferred delegation release failed", {
				runId: run.id,
				exception: safeExceptionTopology(error),
			});
		}
	}
	return started;
}
