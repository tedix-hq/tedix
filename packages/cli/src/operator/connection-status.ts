/**
 * Connection-status labels used by the tedix CLI footer.
 */

export type ConnectionStatus = "connected" | "reconnecting" | "lost";

/** Standard operator-facing copy per CLI connection status. */
export const CONNECTION_STATUS_COPY: Record<ConnectionStatus, string> = {
	connected: "Connected",
	reconnecting: "Reconnecting…",
	lost: "Connection lost",
};
