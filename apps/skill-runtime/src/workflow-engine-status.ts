export type WorkflowRunStatus =
	| "queued"
	| "running"
	| "paused"
	| "completed"
	| "failed"
	| "canceled";

/**
 * Map Cloudflare's documented Workflow states onto Tedix public state.
 * Unknown or future values fail closed: callers must not project them or use
 * them to release a restart barrier until their semantics are understood.
 */
export function mapWorkflowEngineStatus(
	status: string | undefined,
): WorkflowRunStatus | null {
	switch (status) {
		case "queued":
			return "queued";
		case "running":
		case "waiting":
			return "running";
		case "paused":
		case "waitingForPause":
			return "paused";
		case "complete":
			return "completed";
		case "errored":
			return "failed";
		case "terminated":
			return "canceled";
		default:
			return null;
	}
}
