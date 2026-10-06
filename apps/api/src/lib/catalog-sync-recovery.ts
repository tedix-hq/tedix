/** Native completion can still carry a failed application result. */
export function catalogSyncTerminalFailure(state: {
	status: string;
	output?: unknown;
}): string | null {
	if (state.status === "errored" || state.status === "terminated") {
		return `Native catalog workflow ${state.status}`;
	}
	if (
		state.status !== "complete" ||
		!state.output ||
		typeof state.output !== "object"
	)
		return null;
	if (!("success" in state.output) || state.output.success !== false)
		return null;
	return "error" in state.output && typeof state.output.error === "string"
		? state.output.error
		: "Native catalog workflow returned success=false";
}
