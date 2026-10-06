import type { DbClient } from "@tedix/db/client";
import {
	cancelGraphProjectionMaintenance,
	failGraphProjectionMaintenance,
	listStaleGraphProjectionMaintenanceRuns,
} from "@tedix/db/queries/graph-projection-maintenance";
import type {
	GraphProjectionMaintenanceEnvironment,
	GraphProjectionMaintenanceRun,
} from "@tedix/db/schema/graph-projection";

type GraphGdsWorkflowBinding = CloudflareEnv["GRAPH_GDS_REFRESH_WORKFLOW"];

export interface GraphGdsRefreshDispatch {
	id: string;
	runtimeEnvironment: GraphProjectionMaintenanceEnvironment;
	organizationId: string;
	source: "operator" | "mcp" | "redrive" | "test";
}

/**
 * Create exactly one deterministic Workflow instance, accepting the normal
 * duplicate-create race only after the same instance is observable.
 */
export async function ensureGraphGdsRefreshWorkflow(
	binding: GraphGdsWorkflowBinding,
	input: GraphGdsRefreshDispatch,
	options: { preferCreate?: boolean } = {},
): Promise<"existing" | "created"> {
	if (!options.preferCreate) {
		try {
			const existing = await binding.get(input.id);
			await existing.status();
			return "existing";
		} catch {}
	}

	try {
		await binding.create({
			id: input.id,
			params: {
				runtimeEnvironment: input.runtimeEnvironment,
				organizationId: input.organizationId,
				ledgerId: input.id,
				source: input.source,
			},
		});
		return "created";
	} catch (error) {
		try {
			const existing = await binding.get(input.id);
			await existing.status();
			return "existing";
		} catch {
			throw error;
		}
	}
}

type ReconcileOutcome = "created" | "existing" | "settled";

async function reconcileMaintenanceRun(input: {
	db: DbClient;
	binding: GraphGdsWorkflowBinding;
	run: GraphProjectionMaintenanceRun;
}): Promise<ReconcileOutcome> {
	const { run } = input;
	let nativeStatus: string | null = null;
	try {
		const handle = await input.binding.get(run.workflowId);
		nativeStatus = (await handle.status()).status;
	} catch (error) {
		if (run.status === "queued" || run.status === "cancel_requested") {
			return ensureGraphGdsRefreshWorkflow(input.binding, {
				id: run.workflowId,
				runtimeEnvironment: run.runtimeEnvironment,
				organizationId: run.organizationId,
				source: "redrive",
			});
		}
		throw error;
	}

	if (
		nativeStatus === "complete" ||
		nativeStatus === "errored" ||
		nativeStatus === "terminated"
	) {
		if (run.status === "cancel_requested") {
			await cancelGraphProjectionMaintenance(
				input.db,
				run.runtimeEnvironment,
				run.organizationId,
				run.id,
			);
		} else {
			await failGraphProjectionMaintenance(
				input.db,
				run.runtimeEnvironment,
				run.organizationId,
				run.id,
				`Graph GDS Workflow reached ${nativeStatus} without a matching D1 terminal receipt`,
			);
		}
		return "settled";
	}
	return "existing";
}

/**
 * Repair dispatch ambiguity and reconcile native terminal states against D1.
 * The scan is environment-fenced, ignores fresh rows, and caps each two-minute
 * control-plane tick.
 */
export async function reconcileStaleGraphGdsRefreshes(input: {
	db: DbClient;
	binding: GraphGdsWorkflowBinding;
	runtimeEnvironment: GraphProjectionMaintenanceEnvironment;
	nowMs: number;
	staleAfterMs?: number;
	limit?: number;
}): Promise<{
	candidates: number;
	created: number;
	existing: number;
	settled: number;
	failed: number;
}> {
	const rows = await listStaleGraphProjectionMaintenanceRuns(input.db, {
		runtimeEnvironment: input.runtimeEnvironment,
		updatedBefore: new Date(
			input.nowMs - (input.staleAfterMs ?? 30_000),
		).toISOString(),
		limit: input.limit ?? 10,
	});
	const outcomes = await Promise.allSettled(
		rows.map((run) =>
			reconcileMaintenanceRun({
				db: input.db,
				binding: input.binding,
				run,
			}),
		),
	);
	return {
		candidates: rows.length,
		created: outcomes.filter(
			(result) => result.status === "fulfilled" && result.value === "created",
		).length,
		existing: outcomes.filter(
			(result) => result.status === "fulfilled" && result.value === "existing",
		).length,
		settled: outcomes.filter(
			(result) => result.status === "fulfilled" && result.value === "settled",
		).length,
		failed: outcomes.filter((result) => result.status === "rejected").length,
	};
}
