import type { SkillRuntimeEnv } from "../env";
import type { Hono } from "hono";
import { createDbClient } from "@tedix/db/client";
import { requirePendingConnectionRecovery } from "../workflow-connection-recovery";
import { logControlFailure, logRuntimeFailure } from "../control-log";
import {
	getSkillRun,
	reconcileSkillRun,
	skillRunEnvironment,
	updateSkillRunAfterControl,
} from "../db";
import {
	buildWorkflowApprovalEvent,
	claimWorkflowApprovalDecision,
	finalizeWorkflowApprovalDecision,
	WORKFLOW_APPROVAL_EVENT_TYPE,
	WorkflowApprovalDecisionConflictError,
} from "../workflow-approval";
import { workflowEngineErrorText } from "../workflow-engine-error";
import { mapWorkflowEngineStatus } from "../workflow-engine-status";
import { settleWorkflowSubmissionBeforeTerminal } from "../workflow-submission";
import {
	ApprovalRequestSchema,
	SendEventRequestSchema,
	type AppEnv,
} from "../control-requests";
import {
	type EngineStatusSnapshot,
	type RunStatus,
	workflowEpochConflict,
	workflowControlRestartConflict,
	workflowControlAdmissionConflict,
	workflowControlRetiredConflict,
	readEngineStatus,
} from "../control-admission";

const RejectionRequestSchema = ApprovalRequestSchema;

async function deliverApprovalDecision(input: {
	env: SkillRuntimeEnv;
	run: NonNullable<Awaited<ReturnType<typeof getSkillRun>>>;
	decision: "approved" | "rejected";
	approvalId: string;
	reason?: string;
	payload: Record<string, unknown>;
}): Promise<{
	runId: string;
	workflowInstanceId: string;
	executionEpoch: number;
	status: RunStatus;
	engine: EngineStatusSnapshot | null;
	eventType: string;
	decision: "approved" | "rejected";
	deduplicated: boolean;
}> {
	if (!input.run.instanceId) throw new Error("no_instance");
	const handle = await input.env.WORKFLOWS.get(input.run.instanceId);
	const approvalId = input.approvalId!;
	const claim = await claimWorkflowApprovalDecision({
		db: input.env.DB,
		runId: input.run.runId,
		executionEpoch: input.run.executionEpoch,
		approvalId,
		decision: input.decision,
		reason: input.reason,
		payload: input.payload,
	});
	if (!claim.deduplicated) {
		if (!claim.pendingContent) {
			throw new Error("workflow approval reservation is missing pending state");
		}
		try {
			await handle.sendEvent(
				buildWorkflowApprovalEvent({
					approved: input.decision === "approved",
					reason: input.reason,
					approvalId,
					metadata: input.payload,
				}),
			);
			await finalizeWorkflowApprovalDecision({
				db: input.env.DB,
				runId: input.run.runId,
				path: claim.path,
				executionEpoch: input.run.executionEpoch,
				approvalId,
				decision: input.decision,
				requestDigest: claim.requestDigest,
				pendingContent: claim.pendingContent,
				delivered: true,
			});
		} catch (error) {
			await finalizeWorkflowApprovalDecision({
				db: input.env.DB,
				runId: input.run.runId,
				path: claim.path,
				executionEpoch: input.run.executionEpoch,
				approvalId,
				decision: input.decision,
				requestDigest: claim.requestDigest,
				pendingContent: claim.pendingContent,
				delivered: false,
			}).catch(() => {});
			throw error;
		}
	}
	let engine: EngineStatusSnapshot | null = null;
	let status = input.run.status as RunStatus;
	try {
		engine = await readEngineStatus(handle);
		const mappedStatus = mapWorkflowEngineStatus(engine.status);
		if (mappedStatus) {
			status = mappedStatus;
			const terminal =
				status === "completed" || status === "failed" || status === "canceled";
			const engineError = workflowEngineErrorText(engine.error);
			if (terminal) {
				const submissionSettled = await settleWorkflowSubmissionBeforeTerminal({
					db: input.env.DB,
					runId: input.run.runId,
					organizationId: input.run.orgId,
					executionEpoch: input.run.executionEpoch,
					status,
					error: engineError,
				});
				if (!submissionSettled) {
					throw new Error("workflow_submission_settlement_pending");
				}
				await reconcileSkillRun(input.env.DB, input.run.runId, {
					status,
					result: status === "completed" ? engine.output : undefined,
					error: status === "failed" ? engineError : null,
					expectedExecutionEpoch: input.run.executionEpoch,
				});
			} else {
				await updateSkillRunAfterControl(
					input.env.DB,
					input.run.runId,
					status,
					{
						expectedExecutionEpoch: input.run.executionEpoch,
					},
				);
			}
		}
	} catch (error) {
		// The event delivery already succeeded. Do not encourage a duplicate event
		// merely because the follow-up lifecycle read was temporarily unavailable.
		logRuntimeFailure(
			"workflow.approval_status_confirmation.failed",
			error,
			input.run.runId,
		);
	}
	return {
		runId: input.run.runId,
		workflowInstanceId: input.run.instanceId,
		executionEpoch: input.run.executionEpoch,
		status,
		engine,
		eventType: WORKFLOW_APPROVAL_EVENT_TYPE,
		decision: input.decision,
		deduplicated: claim.deduplicated,
	};
}

/** Deliver the standard, branchable human-approval event. */
export function registerApprovalRoutes(app: Hono<AppEnv>) {
	app.post("/approve", async (c) => {
		const parsed = ApprovalRequestSchema.safeParse(
			await c.req.json().catch(() => ({})),
		);
		if (!parsed.success) {
			return c.json(
				{ error: "invalid_request", issues: parsed.error.issues },
				400,
			);
		}
		const run = await getSkillRun(
			c.env.DB,
			parsed.data.runId,
			skillRunEnvironment(c.env.ENVIRONMENT),
		);
		if (!run) return c.json({ error: "not_found" }, 404);
		const epochConflict = workflowEpochConflict(
			run,
			parsed.data.expectedExecutionEpoch,
		);
		if (epochConflict) return c.json(epochConflict, 409);
		const retiredConflict = workflowControlRetiredConflict(run);
		if (retiredConflict) return c.json(retiredConflict, 409);
		const restartConflict = workflowControlRestartConflict(run);
		if (restartConflict) return c.json(restartConflict, 409);
		const admissionConflict = workflowControlAdmissionConflict(run);
		if (admissionConflict) return c.json(admissionConflict, 409);
		if (!run.instanceId) return c.json({ error: "no_instance" }, 409);
		try {
			return c.json({
				ok: true,
				action: "approve",
				...(await deliverApprovalDecision({
					env: c.env,
					run,
					decision: "approved",
					approvalId: parsed.data.approvalId,
					reason: parsed.data.reason,
					payload: parsed.data.payload,
				})),
			});
		} catch (error) {
			if (error instanceof WorkflowApprovalDecisionConflictError) {
				return c.json({ error: error.code, message: error.message }, 409);
			}
			const message = error instanceof Error ? error.message : String(error);
			logControlFailure("approve", error, run.runId);
			return c.json({ error: "workflow_approve_failed", message }, 502);
		}
	});

	/** Deliver rejection through the same standard approval event type. */
	app.post("/reject", async (c) => {
		const parsed = RejectionRequestSchema.safeParse(
			await c.req.json().catch(() => ({})),
		);
		if (!parsed.success) {
			return c.json(
				{ error: "invalid_request", issues: parsed.error.issues },
				400,
			);
		}
		const run = await getSkillRun(
			c.env.DB,
			parsed.data.runId,
			skillRunEnvironment(c.env.ENVIRONMENT),
		);
		if (!run) return c.json({ error: "not_found" }, 404);
		const epochConflict = workflowEpochConflict(
			run,
			parsed.data.expectedExecutionEpoch,
		);
		if (epochConflict) return c.json(epochConflict, 409);
		const retiredConflict = workflowControlRetiredConflict(run);
		if (retiredConflict) return c.json(retiredConflict, 409);
		const restartConflict = workflowControlRestartConflict(run);
		if (restartConflict) return c.json(restartConflict, 409);
		const admissionConflict = workflowControlAdmissionConflict(run);
		if (admissionConflict) return c.json(admissionConflict, 409);
		if (!run.instanceId) return c.json({ error: "no_instance" }, 409);
		try {
			return c.json({
				ok: true,
				action: "reject",
				...(await deliverApprovalDecision({
					env: c.env,
					run,
					decision: "rejected",
					approvalId: parsed.data.approvalId,
					reason: parsed.data.reason,
					payload: parsed.data.payload,
				})),
			});
		} catch (error) {
			if (error instanceof WorkflowApprovalDecisionConflictError) {
				return c.json({ error: error.code, message: error.message }, 409);
			}
			const message = error instanceof Error ? error.message : String(error);
			logControlFailure("reject", error, run.runId);
			return c.json({ error: "workflow_reject_failed", message }, 502);
		}
	});

	/**
	 * POST /event
	 * Deliver a typed event to a workflow awaiting step.waitForEvent. Event
	 * delivery is not claimed to be idempotent; callers must avoid blind retries
	 * after an ambiguous transport failure and use a business identifier in the
	 * payload when dedupe matters.
	 */
	app.post("/event", async (c) => {
		const body = await c.req.json().catch(() => ({}));
		const parsed = SendEventRequestSchema.safeParse(body);
		if (!parsed.success) {
			return c.json(
				{ error: "invalid_request", issues: parsed.error.issues },
				400,
			);
		}
		const run = await getSkillRun(
			c.env.DB,
			parsed.data.runId,
			skillRunEnvironment(c.env.ENVIRONMENT),
		);
		if (!run) return c.json({ error: "not_found" }, 404);
		const epochConflict = workflowEpochConflict(
			run,
			parsed.data.expectedExecutionEpoch,
		);
		if (epochConflict) return c.json(epochConflict, 409);
		const retiredConflict = workflowControlRetiredConflict(run);
		if (retiredConflict) return c.json(retiredConflict, 409);
		const restartConflict = workflowControlRestartConflict(run);
		if (restartConflict) return c.json(restartConflict, 409);
		const admissionConflict = workflowControlAdmissionConflict(run);
		if (admissionConflict) return c.json(admissionConflict, 409);
		if (!run.instanceId) return c.json({ error: "no_instance" }, 409);

		try {
			if (parsed.data.type.startsWith("connection_recovery_")) {
				await requirePendingConnectionRecovery(createDbClient(c.env.DB), {
					runId: run.runId,
					executionEpoch: run.executionEpoch,
					type: parsed.data.type,
					payload: parsed.data.payload,
				});
			}
			const handle = await c.env.WORKFLOWS.get(run.instanceId);
			await handle.sendEvent({
				type: parsed.data.type,
				payload: parsed.data.payload ?? {},
			});
			console.log(
				JSON.stringify({
					service: "skill-runtime",
					event: "run.event_sent",
					ts: new Date().toISOString(),
					runId: run.runId,
					workflowInstanceId: run.instanceId,
					eventType: parsed.data.type,
				}),
			);
			return c.json({ ok: true, executionEpoch: run.executionEpoch });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logControlFailure("event", err, run.runId);
			return c.json({ error: "send_event_failed", message }, 500);
		}
	});
}
