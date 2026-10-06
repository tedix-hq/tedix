/**
 * Approval Workflow
 *
 * Cloudflare Workflow that manages the lifecycle of a tedi approval request:
 * 1. Wait for a resolution event, with D1 polling as the durable fallback
 * 2. Settle any linked Gadget execution exactly once
 * 3. Notify the tedi of the outcome
 * 4. On expiry: mark as expired, settle the Gadget, and notify tedi
 *
 * Triggered by: tediApprovals.create oRPC procedure
 */

import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import { createDbClient } from "@tedix/db/client";
import {
	getApprovalRequestById,
	expireStaleApprovals,
} from "@tedix/db/queries/approvals";
import { getTediById } from "@tedix/db/queries/tedis";
import { insertAuditEvent } from "@tedix/db/queries/audit";
import {
	failOsGadgetApprovalDispatch,
	settleOsGadgetApproval,
} from "../services/os-gadget-approval-settlement";

interface ApprovalWorkflowParams {
	approvalRequestId: string;
	tediId: string;
	orgId: string;
	ttlHours: number;
}

export class ApprovalWorkflow extends WorkflowEntrypoint<
	CloudflareEnv,
	ApprovalWorkflowParams
> {
	async run(event: WorkflowEvent<ApprovalWorkflowParams>, step: WorkflowStep) {
		const { approvalRequestId, tediId, orgId, ttlHours } = event.payload;
		const db = createDbClient(this.env.DB);

		// Step 1: Expire any stale approvals across the table (housekeeping — idempotent SQL UPDATE)
		await step.do(
			"expire-stale",
			{ retries: { limit: 2, delay: "2 seconds" }, timeout: "30 seconds" },
			async () => {
				return expireStaleApprovals(db);
			},
		);

		// Step 2: wait for immediate resolver signals. The D1 read before every
		// wait closes the create/signal race; the timeout supplies a polling
		// fallback when event delivery itself fails.
		const maxAttempts = Math.ceil((ttlHours * 60) / 5);
		let finalStatus: string | null = null;

		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			const status = await step.do(
				`check-status-${attempt}`,
				{ retries: { limit: 3, delay: "2 seconds" }, timeout: "15 seconds" },
				async () => {
					const request = await getApprovalRequestById(db, approvalRequestId);
					if (!request) return "not_found";
					return request.status;
				},
			);

			if (
				status === "approved" ||
				status === "rejected" ||
				status === "cancelled" ||
				status === "expired" ||
				status === "not_found"
			) {
				finalStatus = status;
				break;
			}

			try {
				await step.waitForEvent(`approval-resolution-${attempt}`, {
					type: "approval-resolution",
					timeout: "5 minutes",
				});
			} catch {
				// Timeout is expected when the resolver could not signal. The next
				// loop reads canonical D1 state and continues durably.
			}
		}

		if (!finalStatus || finalStatus === "pending") {
			finalStatus = await step.do(
				"final-status-or-expire",
				{ retries: { limit: 2, delay: "2 seconds" }, timeout: "30 seconds" },
				async () => {
					await expireStaleApprovals(db);
					const request = await getApprovalRequestById(db, approvalRequestId);
					return request?.status ?? "not_found";
				},
			);
		}

		// Step 3: settle a linked Gadget receipt. The service is a no-op for every
		// other approval type. Its deterministic run and reservation keys make the
		// Workflow's retries safe after any process interruption.
		try {
			await step.do(
				"settle-gadget-approval",
				{ retries: { limit: 4, delay: "5 seconds" }, timeout: "2 minutes" },
				async () => {
					const request = await getApprovalRequestById(db, approvalRequestId);
					if (!request) return { handled: false, reason: "request_not_found" };
					return settleOsGadgetApproval(
						{ db, env: this.env, authType: "service-binding" },
						request,
					);
				},
			);
		} catch (error) {
			console.error("Gadget approval dispatch exhausted retries:", error);
			await step.do(
				"fail-gadget-dispatch",
				{ retries: { limit: 3, delay: "2 seconds" }, timeout: "30 seconds" },
				async () => {
					const request = await getApprovalRequestById(db, approvalRequestId);
					if (!request) return null;
					return failOsGadgetApprovalDispatch(
						{ db, env: this.env, authType: "service-binding" },
						request,
						error,
					);
				},
			);
		}

		// Step 4: Notify the tedi of the outcome (best-effort, short timeout)
		await step.do(
			"notify-tedi",
			{ retries: { limit: 2, delay: "5 seconds" }, timeout: "30 seconds" },
			async () => {
				const request = await getApprovalRequestById(db, approvalRequestId);
				if (!request) return { notified: false, reason: "request_not_found" };

				// Look up the tedi to get its slug for routing
				const tedi = await getTediById(db, tediId);
				if (!tedi || !tedi.slug)
					return { notified: false, reason: "tedi_not_found" };

				// Build notification message
				const statusLabel =
					finalStatus === "approved"
						? "APPROVED"
						: finalStatus === "rejected" || finalStatus === "cancelled"
							? "REJECTED"
							: "EXPIRED";
				const message = `Approval request ${statusLabel}: "${request.description}" (action: ${request.actionType})${request.resolution ? `. Note: ${request.resolution}` : ""}`;

				// Notify via TEDI_SERVICE binding
				if (this.env.TEDI_SERVICE) {
					try {
						const envName = String(this.env.ENVIRONMENT || "");
						const domain =
							envName === "production" ? "tedix.dev" : "tedix.tech";
						const tediHost = `${tedi.slug}.tedi.${domain}`;

						await this.env.TEDI_SERVICE.fetch(
							new Request("https://tedi/api/admin/notify", {
								method: "POST",
								headers: {
									"Content-Type": "application/json",
									"X-Tedix-Host": tediHost,
									"X-Service-Binding": "true",
								},
								body: JSON.stringify({
									message,
									session: "main",
									wait: false,
									provenance: { type: "system" },
								}),
							}),
						);
					} catch (err) {
						// Notification is best-effort
						if (this.env.ENVIRONMENT === "development") {
							console.error("Failed to notify tedi:", err);
						}
					}
				}

				return { notified: true, status: finalStatus };
			},
		);

		// Step 5: Emit audit event for workflow completion
		// Auditing is append-only; on retry we may emit duplicate audit rows — accepted
		// trade-off for ensuring the event is recorded.
		await step.do(
			"audit-completion",
			{ retries: { limit: 2, delay: "2 seconds" }, timeout: "15 seconds" },
			async () => {
				await insertAuditEvent(db, {
					organizationId: orgId,
					actorId: "approval-workflow",
					actorType: "service",
					action: `approval.workflow.${finalStatus}`,
					resourceType: "approval_request",
					resourceId: approvalRequestId,
					metadata: { tediId, finalStatus, ttlHours },
				});
			},
		);

		return {
			approvalRequestId,
			finalStatus,
		};
	}
}
