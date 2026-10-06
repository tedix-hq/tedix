/** OS cookie-session adapter; the transport lifecycle is shared with embeds. */
import type { CapnSessionStub } from "@/capnweb/contract";
import {
	createSessionHub,
	type SessionHub,
	type SessionHubOptions,
	type SessionLeaseHandle,
} from "@tedix/chat-transport/session-hub";
export type CapnSessionLeaseHandle = SessionLeaseHandle<CapnSessionStub>;
export type CapnSessionHub = SessionHub<CapnSessionStub>;
export type CapnSessionHubOptions = SessionHubOptions<CapnSessionStub>;
export function createCapnSessionHub(
	options: CapnSessionHubOptions,
): CapnSessionHub {
	return createSessionHub(options);
}
// ---------------------------------------------------------------------------
// The one shared hub
// ---------------------------------------------------------------------------

let sharedHub: CapnSessionHub | null = null;

/**
 * The process-wide hub. Created on first use so a tab that never opens the
 * Cap'n lane never constructs one, and resettable so tests never inherit a
 * previous suite's socket.
 */
export function getSharedCapnSessionHub(
	options: CapnSessionHubOptions,
): CapnSessionHub {
	if (sharedHub === null) sharedHub = createCapnSessionHub(options);
	return sharedHub;
}

export function resetSharedCapnSessionHub(): void {
	sharedHub = null;
}

/** Wake-probe entrypoint; reconnect pacing remains owned by the chat machine. */
export function probeSharedCapnSessionHub(): Promise<boolean> {
	return sharedHub?.probe() ?? Promise.resolve(false);
}
