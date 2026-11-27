import { baseErrorConstructors } from "@tedix/api-contract/errors";
import {
	validateCatalogFallback,
	type ModelCatalogConfig,
} from "@tedix/api-contract/schemas/model-catalog-config";
import { type DbClient } from "@tedix/db/client";
import { getOrganizationModelFallback } from "@tedix/db/queries/model-fallback";
import { getKernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";
import { insertKernelRuntimeEventIfAbsent } from "@tedix/db/queries/kernel-runtime-events";
import { type ModelFallbackStep } from "@tedix/api-contract/schemas/model-fallback";
export function kernelFallbackHooks(
	db: DbClient,
	scope: { organizationId: string; runId: string },
	catalog: ModelCatalogConfig,
) {
	return {
		load: async () =>
			validateCatalogFallback(
				(await getOrganizationModelFallback(db, scope.organizationId)) ??
					catalog.fallback,
				catalog.entries,
			),
		record: async (step: ModelFallbackStep) => {
			const run = await getKernelRuntimeRun(db, {
				id: scope.runId,
				organizationId: scope.organizationId,
			});
			if (!run || run.status !== "running")
				throw baseErrorConstructors.CONFLICT({
					message: "Model fallback run is unavailable",
				});
			await insertKernelRuntimeEventIfAbsent(db, {
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
