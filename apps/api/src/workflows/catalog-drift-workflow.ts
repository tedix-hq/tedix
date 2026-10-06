import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import { createDbClient } from "@tedix/db/client";
import {
	completeWorkflowRunRecord,
	createWorkflowRunRecord,
} from "@tedix/db/queries/workflow-runs";
import { runCatalogDriftDetection } from "@tedix/db/queries/catalog/maintenance-reports";

export type CatalogDriftWorkflowInput = {
	source?: "cron" | "operator" | "test";
	limit?: number;
	catalogAppId?: string;
	autoSync?: boolean;
};

export class CatalogDriftWorkflow extends WorkflowEntrypoint<
	CloudflareEnv,
	CatalogDriftWorkflowInput
> {
	async run(
		event: WorkflowEvent<CatalogDriftWorkflowInput>,
		step: WorkflowStep,
	) {
		const db = createDbClient(this.env.DB);
		const payload = event.payload ?? {};
		const ledgerId = await step.do("record workflow start", async () => {
			const ledger = await createWorkflowRunRecord(db, {
				workflowType: "catalog_drift",
				workflowId: event.instanceId,
				trigger: payload.source ?? "operator",
				target: payload.catalogAppId ?? null,
			});
			return ledger.id;
		});

		try {
			const result = await step.do("check upstream catalog drift", async () =>
				runCatalogDriftDetection(db, this.env.DB, {
					limit: payload.limit ?? 50,
					catalogAppId: payload.catalogAppId,
					autoSync: payload.autoSync ?? true,
				}),
			);

			await step.do("record workflow completion", async () => {
				await completeWorkflowRunRecord(db, ledgerId, {
					status: "completed",
					totalCount: result.checked,
					successCount: result.checked - result.failures.length,
					errorCount: result.failures.length,
					output: {
						summary: result.summary,
						candidates: result.candidates,
						reportsSaved: result.reportsSaved,
						totalDrifts: result.totalDrifts,
						autoSyncs: result.autoSyncs,
						failures: result.failures.slice(0, 20),
					},
				});
			});

			return result;
		} catch (error) {
			await step.do("record workflow failure", async () => {
				await completeWorkflowRunRecord(db, ledgerId, {
					status: "failed",
					error: error instanceof Error ? error.message : String(error),
				});
			});
			throw error;
		}
	}
}
