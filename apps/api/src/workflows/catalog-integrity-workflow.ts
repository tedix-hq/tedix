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
import { runCatalogIntegrityMaintenance } from "@tedix/db/queries/catalog/maintenance-reports";

export type CatalogIntegrityWorkflowInput = {
	source?: "cron" | "operator" | "test";
	apply?: boolean;
	limit?: number;
	catalogAppId?: string;
	staleLastSeenDays?: number;
};

export class CatalogIntegrityWorkflow extends WorkflowEntrypoint<
	CloudflareEnv,
	CatalogIntegrityWorkflowInput
> {
	async run(
		event: WorkflowEvent<CatalogIntegrityWorkflowInput>,
		step: WorkflowStep,
	) {
		const db = createDbClient(this.env.DB);
		const payload = event.payload ?? {};
		const ledgerId = await step.do("record workflow start", async () => {
			const ledger = await createWorkflowRunRecord(db, {
				workflowType: "catalog_integrity",
				workflowId: event.instanceId,
				trigger: payload.source ?? "operator",
				target: payload.catalogAppId ?? null,
			});
			return ledger.id;
		});

		try {
			const result = await step.do("check catalog integrity", async () =>
				runCatalogIntegrityMaintenance(db, this.env.DB, {
					apply: payload.apply ?? true,
					limit: payload.limit ?? 10_000,
					catalogAppId: payload.catalogAppId,
					staleLastSeenDays: payload.staleLastSeenDays,
				}),
			);

			await step.do("record workflow completion", async () => {
				await completeWorkflowRunRecord(db, ledgerId, {
					status: "completed",
					totalCount: result.checkedApps,
					successCount: result.checkedApps - result.errorCount,
					errorCount: result.errorCount,
					output: {
						summary: result.summary,
						issueCount: result.issueCount,
						warningCount: result.warningCount,
						repaired: result.repaired,
						qualityIssueCount: result.qualityReport.issueCount,
						qualityErrorCount: result.qualityReport.errorCount,
						qualityWarningCount: result.qualityReport.warningCount,
						qualitySummary: result.qualityReport.summary,
						// Standing backlog counter: tools with no declared write
						// capability. Recorded on every cron run so the number is
						// trackable over time instead of only observable by hand.
						unclassifiedWriteCapabilityTools:
							result.writeCapabilityReport.totalTools,
						unclassifiedWriteCapabilityApps:
							result.writeCapabilityReport.totalApps,
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
