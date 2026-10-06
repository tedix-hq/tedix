/**
 * The shell's transport / reconnect indicator.
 *
 * The OS chrome carried exactly one piece of live-system signal — a decorative
 * constant reading "Governed" — while the only real connection state in the app
 * was buried inside ChatThread. This renders what the global connection manager
 * actually knows, and nothing more:
 *
 * - IDLE is not a failure. Nothing is subscribed, so the surface has no live
 *   feed and must not claim one. It is rendered as its own state, never as
 *   "connected" and never as "broken".
 * - CONNECTING and RECONNECTING are distinct: the first has never been open,
 *   the second lost a connection it had and is retrying on the existing backoff
 *   ladder. Collapsing them would hide an outage behind a first-load spinner.
 * - DEGRADED is the loudest state: the Cap'n Web stream (the ONLY event
 *   transport — the SSE fallback lane was retired) cannot establish, live
 *   updates are paused, and ChatThread is polling instead. The machine keeps
 *   retrying; the chip clears itself on the next successful open.
 * - COUNTS ARE ABSENT UNTIL THEY EXIST. The tooltip names the multiplexing
 *   (subscribers over subscriptions) only when there is a live subscription to
 *   count; a "0 subscribers" claim would be a rendered fact no read supports.
 */

import type { ConversationStreamStatus } from "@/lib/conversation-stream";
import type { RealtimeStatusSnapshot } from "@/lib/realtime-connection";
import { useRealtimeStatus } from "@/lib/use-realtime";

const STATUS_LABELS: Record<ConversationStreamStatus, string> = {
	idle: "Not live",
	connecting: "Connecting",
	open: "Live",
	reconnecting: "Reconnecting",
};

/**
 * Tooltip copy. Exported pure so a test asserts the RENDERED claim rather than
 * a proxy for it.
 */
export function transportStatusTitle(snapshot: RealtimeStatusSnapshot): string {
	if (snapshot.degraded) {
		return "Live updates are paused — the event stream cannot establish, so this view refreshes by polling while the connection keeps retrying.";
	}
	switch (snapshot.status) {
		case "idle":
			return "No live event stream is open. Reads still refresh on use.";
		case "connecting":
			return "Opening the live event stream.";
		case "reconnecting":
			return "The live event stream dropped and is retrying; durable events replay from the last cursor on reconnect.";
		case "open": {
			const base = "Live event stream open.";
			// Only claim a multiplex when there is one to claim.
			if (snapshot.subscriptions === 0) return base;
			const subscribers =
				snapshot.subscribers === 1
					? "1 surface"
					: `${snapshot.subscribers} surfaces`;
			const subscriptions =
				snapshot.subscriptions === 1
					? "1 subscription"
					: `${snapshot.subscriptions} subscriptions`;
			return `${base} ${subscribers} on ${subscriptions}.`;
		}
	}
}

export function TransportStatus() {
	const snapshot = useRealtimeStatus();
	// Healthy and idle transport are intentionally silent. The global shell only
	// earns visual attention when the live lane is opening, recovering, or
	// degraded; reads and governance remain enforced without a permanent
	// decorative status chip.
	if (
		!snapshot.degraded &&
		(snapshot.status === "idle" || snapshot.status === "open")
	) {
		return null;
	}
	const label = snapshot.degraded
		? "Live updates paused"
		: STATUS_LABELS[snapshot.status];
	return (
		<span
			className="transport-status"
			data-status={snapshot.degraded ? "degraded" : snapshot.status}
			title={transportStatusTitle(snapshot)}
		>
			<span aria-hidden="true" /> {label}
		</span>
	);
}
