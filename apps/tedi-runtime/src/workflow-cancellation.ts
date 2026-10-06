type Instance = Pick<WorkflowInstance, "status" | "terminate">;
interface Binding {
	get(id: string): Promise<Instance>;
}
const terminal = new Set(["complete", "errored", "terminated"]);
const missing = (error: unknown) =>
	error instanceof Error && error.message.includes("(instance.not_found)");

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
