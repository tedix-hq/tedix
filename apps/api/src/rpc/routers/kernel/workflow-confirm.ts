/**
 * Kernel — starting a workflow Home offered.
 *
 * When the previous turn in a Home conversation produced a `run_workflow`
 * route, the reply offers the workflow with a Start button. Pressing it sends
 * a turn that names the offered workflow (`startOfferedWorkflow`); the turn
 * starts the workflow only while that offer is still the latest reply. What
 * the person types is never read as a confirmation.
 */

export { readPendingWorkflowHint } from "@tedix/db/queries/kernel-runtime-runs";

export interface WorkflowDispatchInput {
	organizationId: string;
	conversationId: string;
	homeRunId: string;
	workflowSlug: string;
}

export interface WorkflowDispatchResult {
	workflowRunId: string;
	status: "dispatched" | "failed";
	/** Owning tedi, captured with the Home→workflow link for operator controls. */
	workflowTediId?: string;
	error?: string;
}

/** Injected dispatcher — pure over this interface, wired with SKILL_RUNTIME in production. */
export type WorkflowConfirmDispatcher = (
	input: WorkflowDispatchInput,
) => Promise<WorkflowDispatchResult>;
