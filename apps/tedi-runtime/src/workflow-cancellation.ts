type Instance = Pick<WorkflowInstance, "status" | "terminate">;
interface Binding {
	get(id: string): Promise<Instance>;
}
const terminal = new Set(["complete", "errored", "terminated"]);
const missing = (error: unknown) =>
	error instanceof Error && error.message.includes("(instance.not_found)");

/** Read-only proof: an unknown status or lookup error must never authorize cleanup. */
export async function settledWorkflow(binding: Binding, id: string) {
	try {
		const status = (await (await binding.get(id)).status()).status;
		if (terminal.has(status)) return "already_settled";
		if (
			![
				"running",
				"queued",
				"waiting",
				"waitingForSleep",
				"paused",
				"waitingForPause",
			].includes(status)
		)
			throw new Error("unverified_workflow_status");
		return null;
	} catch (error) {
		if (missing(error)) return "not_found";
		throw error;
	}
}

/** The caller persists cancel intent first, including cancellation before admission. */
export async function terminateWorkflow(binding: Binding, id: string) {
	try {
		const instance = await binding.get(id);
		if (terminal.has((await instance.status()).status))
			return { detail: "already_settled" };
		try {
			await instance.terminate();
		} catch (error) {
			// Completion may win the race between status and termination.
			if (terminal.has((await instance.status()).status))
				return { detail: "already_settled" };
			throw error;
		}
		return { detail: "terminated" };
	} catch (error) {
		if (missing(error)) return { detail: "not_found" };
		throw error;
	}
}
