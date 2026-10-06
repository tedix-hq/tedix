import { exceptionTopology } from "./exception-topology";

/** Inbound mail and provider failures can contain addresses and login links. */
export function logInboundEmailPersistenceFailure(error: unknown): void {
	console.error({
		component: "tedi-runtime-email",
		event: "tedi.email.inbound_persist_failed",
		exception: exceptionTopology(error),
	});
}
