import type { GraphProjectionMaintenanceEnvironment } from "@tedix/db/schema/graph-projection";

type GraphGdsWorkflowBinding = CloudflareEnv["GRAPH_GDS_REFRESH_WORKFLOW"];

export interface GraphGdsRefreshDispatch {
	id: string;
	runtimeEnvironment: GraphProjectionMaintenanceEnvironment;
	organizationId: string;
	source: "operator" | "mcp" | "test";
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
