import type { Connection } from "agents";

/** Reject client attempts to mutate the parent runtime's durable state. */
export function validateRuntimeStateChange(
	_sourceState: unknown,
	source: Connection | "server",
): void {
	if (source !== "server") {
		throw new Error(
			"State update rejected: client-originated state mutation is not permitted on a tedi runtime",
		);
	}
}
