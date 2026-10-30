import {
	validateCatalogFallback,
	type ModelCatalogConfig,
} from "@tedix/api-contract/schemas/model-catalog-config";
import { createDbClient } from "@tedix/db/client";
import { getOrganizationModelFallback } from "@tedix/db/queries/model-fallback";
import { getKernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";
import { insertKernelRuntimeEventIfAbsent } from "@tedix/db/queries/kernel-runtime-events";
import { type ModelFallbackStep } from "@tedix/api-contract/schemas/model-fallback";
export function kernelFallbackHooks(
	binding: D1Database,
	scope: { organizationId: string; runId: string },
	catalog: ModelCatalogConfig,
) {
	const db = () => createDbClient(binding);
	return {
		load: async () =>
			validateCatalogFallback(
				(await getOrganizationModelFallback(db(), scope.organizationId)) ??
					catalog.fallback,
				catalog.entries,
			),
		record: async (step: ModelFallbackStep) => {
			const client = db();
			const run = await getKernelRuntimeRun(client, {
				id: scope.runId,
				organizationId: scope.organizationId,
			});
			if (!run || run.status !== "running")
				throw new Error("Model fallback run is unavailable");
			await insertKernelRuntimeEventIfAbsent(client, {
				id: crypto.randomUUID(),
				organizationId: run.organizationId,
				conversationId: run.conversationId,
				runId: run.id,
				kind: "step.retry",
				payload: { operation: "model_fallback", ...step },
				createdAt: new Date().toISOString(),
			});
		},
	};
}
