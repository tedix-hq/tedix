/**
 * Durable explicit Neo4j GDS refresh.
 *
 * The API reserves an organization-scoped graph_projection_maintenance_runs
 * row before dispatch. This Workflow owns the long-running mutation while
 * MCP/API callers receive an immediate task handle and poll that lifecycle.
 */

import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { createDbClient } from "@tedix/db/client";
import {
	cancelGraphProjectionMaintenance,
	failGraphProjectionMaintenance,
	getGraphProjectionMaintenanceRun,
	markGraphProjectionMaintenanceRunning,
} from "@tedix/db/queries/graph-projection-maintenance";
import {
	GraphProjectionAlgorithmRefreshError,
	refreshGraphProjectionAlgorithms,
} from "../services/graph-projection-algorithms";

export interface GraphGdsRefreshWorkflowParams {
	runtimeEnvironment: "development" | "staging" | "production";
	organizationId: string;
	ledgerId: string;
	source?: "operator" | "mcp" | "redrive" | "test";
}

type GraphGdsRefreshWorkflowResult = {
	operation: "gds_refresh";
	organizationId: string;
	watermark: number;
	epoch: string;
};

function completedReceipt(
	value: Record<string, unknown> | null,
	organizationId: string,
): GraphGdsRefreshWorkflowResult | null {
	if (
		value?.operation !== "gds_refresh" ||
		value.organizationId !== organizationId ||
		typeof value.watermark !== "number" ||
		typeof value.epoch !== "string"
	) {
		return null;
	}
	return {
		operation: "gds_refresh",
		organizationId,
		watermark: value.watermark,
		epoch: value.epoch,
	};
}

export class GraphGdsRefreshWorkflow extends WorkflowEntrypoint<
	CloudflareEnv,
	GraphGdsRefreshWorkflowParams
> {
	async run(
		event: WorkflowEvent<GraphGdsRefreshWorkflowParams>,
		step: WorkflowStep,
	): Promise<GraphGdsRefreshWorkflowResult> {
		const payload = event.payload;
		const db = createDbClient(this.env.DB);

		await step.do(
			"mark GDS refresh running",
			{ retries: { limit: 3, delay: "2 seconds" }, timeout: "30 seconds" },
			async () => {
				if (payload.runtimeEnvironment !== this.env.ENVIRONMENT) {
					throw new NonRetryableError(
						"Graph GDS workflow runtime environment does not match its binding",
					);
				}
				const row = await getGraphProjectionMaintenanceRun(
					db,
					this.env.ENVIRONMENT,
					payload.organizationId,
					payload.ledgerId,
				);
				if (!row) {
					throw new NonRetryableError(
						`Missing graph GDS workflow ledger row ${payload.ledgerId}`,
					);
				}
				if (
					row.operation !== "gds_refresh" ||
					row.workflowId !== event.instanceId
				) {
					throw new NonRetryableError(
						"Graph GDS workflow ledger ownership does not match the dispatched organization",
					);
				}
				if (row.status === "cancel_requested") {
					await cancelGraphProjectionMaintenance(
						db,
						this.env.ENVIRONMENT,
						payload.organizationId,
						payload.ledgerId,
					);
					throw new NonRetryableError("Graph GDS refresh was canceled");
				}
				if (row.status === "queued" || row.status === "running") {
					await markGraphProjectionMaintenanceRunning(
						db,
						this.env.ENVIRONMENT,
						payload.organizationId,
						payload.ledgerId,
					);
				}
			},
		);

		try {
			return await step.do(
				"refresh graph data science projection",
				{ retries: { limit: 3, delay: "10 seconds" }, timeout: "10 minutes" },
				async () => {
					// The completion receipt and Neo4j mutation share one durable step.
					// If the step result is lost after D1 commits, replay recognizes the
					// receipt and never starts a second expensive refresh.
					const prior = await getGraphProjectionMaintenanceRun(
						db,
						this.env.ENVIRONMENT,
						payload.organizationId,
						payload.ledgerId,
					);
					if (prior?.status === "completed") {
						const receipt = completedReceipt(
							prior.result ?? null,
							payload.organizationId,
						);
						if (receipt) return receipt;
						throw new NonRetryableError(
							"Graph GDS refresh completed without a valid atomic receipt",
						);
					}

					try {
						const refreshed = await refreshGraphProjectionAlgorithms({
							db,
							env: this.env,
							organizationId: payload.organizationId,
							operationId: event.instanceId,
							maintenanceRunId: payload.ledgerId,
							assertCanContinue: async () => {
								const current = await getGraphProjectionMaintenanceRun(
									db,
									this.env.ENVIRONMENT,
									payload.organizationId,
									payload.ledgerId,
								);
								if (
									!current ||
									current.status === "cancel_requested" ||
									current.status === "canceled"
								) {
									throw new GraphProjectionAlgorithmRefreshError(
										"operation_cancelled",
										"Graph GDS refresh was canceled before the next mutation phase",
									);
								}
								if (current.status !== "running") {
									throw new GraphProjectionAlgorithmRefreshError(
										"operation_cancelled",
										`Graph GDS refresh cannot continue from ${current.status}`,
									);
								}
							},
						});
						const result: GraphGdsRefreshWorkflowResult = {
							operation: "gds_refresh",
							organizationId: payload.organizationId,
							watermark: refreshed.watermark,
							epoch: refreshed.epoch,
						};
						const completed = await getGraphProjectionMaintenanceRun(
							db,
							this.env.ENVIRONMENT,
							payload.organizationId,
							payload.ledgerId,
						);
						if (completed?.status !== "completed") {
							throw new GraphProjectionAlgorithmRefreshError(
								"operation_cancelled",
								"Graph GDS refresh terminal receipt was not committed",
							);
						}
						return result;
					} catch (error) {
						if (
							error instanceof GraphProjectionAlgorithmRefreshError &&
							(error.reason === "projection_not_ready" ||
								error.reason === "operation_cancelled")
						) {
							throw new NonRetryableError(error.message);
						}
						throw error;
					}
				},
			);
		} catch (error) {
			await step.do(
				"record GDS refresh failure",
				{ retries: { limit: 3, delay: "2 seconds" }, timeout: "30 seconds" },
				async () => {
					const row = await getGraphProjectionMaintenanceRun(
						db,
						this.env.ENVIRONMENT,
						payload.organizationId,
						payload.ledgerId,
					);
					if (row?.status === "cancel_requested") {
						await cancelGraphProjectionMaintenance(
							db,
							this.env.ENVIRONMENT,
							payload.organizationId,
							payload.ledgerId,
						);
					} else if (row?.status === "queued" || row?.status === "running") {
						await failGraphProjectionMaintenance(
							db,
							this.env.ENVIRONMENT,
							payload.organizationId,
							payload.ledgerId,
							error instanceof Error ? error.message : String(error),
						);
					}
				},
			);
			throw error;
		}
	}
}
