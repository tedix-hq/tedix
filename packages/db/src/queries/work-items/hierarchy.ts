import type { WorkItemAggregateDisposition } from "@tedix/api-contract/schemas/work-items";

export interface WorkItemRollupTotals {
	total: number;
	byDisposition: Record<string, number>;
	byWorkKind: Record<string, number>;
	percentDone: number;
	aggregateDisposition: WorkItemAggregateDisposition;
	distinctExecutors: Array<{ type: "tedi" | "external_agent"; id: string }>;
}

interface RollupInputNode {
	workKind: string;
	disposition: "proposed" | "accepted" | "completed" | "cancelled";
}

export function computeWorkItemRollupTotals(
	nodes: RollupInputNode[],
): WorkItemRollupTotals {
	const byDisposition: Record<string, number> = {};
	const byWorkKind: Record<string, number> = {};
	for (const node of nodes) {
		byDisposition[node.disposition] =
			(byDisposition[node.disposition] ?? 0) + 1;
		byWorkKind[node.workKind] = (byWorkKind[node.workKind] ?? 0) + 1;
	}
	const total = nodes.length;
	const cancelled = byDisposition.cancelled ?? 0;
	const completed = byDisposition.completed ?? 0;
	const denominator = total - cancelled;
	const aggregateDisposition: WorkItemAggregateDisposition =
		total === 0
			? "empty"
			: (byDisposition.proposed ?? 0) > 0
				? "proposed"
				: (byDisposition.accepted ?? 0) > 0
					? "accepted"
					: completed > 0
						? "completed"
						: "cancelled";
	return {
		total,
		byDisposition,
		byWorkKind,
		percentDone: denominator > 0 ? completed / denominator : 0,
		aggregateDisposition,
		distinctExecutors: [],
	};
}
