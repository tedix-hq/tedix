import { exceptionTopology } from "./exception-topology";

type PersistenceFailureEvent =
	| "tedi.trace.bundle_put_failed"
	| "tedi.trace.bundle_write_failed"
	| "tedi.artifact.turn_summary_record_failed"
	| "tedi.artifact.deliverable_record_failed"
	| "tedi.artifact.workstation_record_failed";

/** Persistence failures may include prompt, artifact, provider or R2 details. */
export function logTediPersistenceFailure(
	event: PersistenceFailureEvent,
	error: unknown,
): void {
	console.error({
		component: "tedi-runtime-persistence",
		event,
		exception: exceptionTopology(error),
	});
}
