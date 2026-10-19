/** A failed routing turn can be replayed only before any action was selected. */
export function isHomeRouteRetryable(run: {
	status: string;
	delegatedTediId?: string | null;
	childRunId?: string | null;
	metadata?: unknown;
}): boolean {
	if (run.status !== "failed" || run.delegatedTediId || run.childRunId)
		return false;
	const metadata = record(run.metadata);
	const body = record(metadata?.bodyExecutionResult);
	const error = record(body?.error);
	const saved = record(metadata?.redriveInput);
	return (
		metadata?.kernelRoute === null &&
		!metadata?.delegationWorkOrder &&
		!metadata?.approvalRequestId &&
		!metadata?.childRunId &&
		!metadata?.delegatedTediId &&
		!metadata?.homePlan &&
		!metadata?.kernelWriteProposal &&
		error?.kind === "model" &&
		error.retryable === true &&
		typeof saved?.content === "string"
	);
}

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}
