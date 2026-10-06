import { resetLiveWorkspaceSubscribers } from "@/lib/live-workspace-projection";
import {
	probeRealtimeConnection,
	resetRealtimeConnections,
} from "@/lib/realtime-connection";
import { resetRealtimePumps } from "@/lib/use-realtime";

type PageHideEvent = { persisted?: boolean };

type PageLifecycleTarget = {
	addEventListener(
		type: "pagehide",
		listener: (event: PageHideEvent) => void,
	): void;
	removeEventListener(
		type: "pagehide",
		listener: (event: PageHideEvent) => void,
	): void;
};

type WakeProbeTarget = {
	addEventListener(
		type: "visibilitychange" | "online",
		listener: () => void,
	): void;
	removeEventListener(
		type: "visibilitychange" | "online",
		listener: () => void,
	): void;
};

/** Probe on signals that commonly follow a sleeping or backgrounded socket. */
export function installOsRealtimeWakeProbes(
	target: WakeProbeTarget,
	visibilityState: () => DocumentVisibilityState,
	probe: () => Promise<boolean> = probeRealtimeConnection,
): () => void {
	const onVisible = () => {
		if (visibilityState() === "visible") void probe();
	};
	const onOnline = () => void probe();
	target.addEventListener("visibilitychange", onVisible);
	target.addEventListener("online", onOnline);
	let removed = false;
	return () => {
		if (removed) return;
		removed = true;
		target.removeEventListener("visibilitychange", onVisible);
		target.removeEventListener("online", onOnline);
	};
}

/**
 * Hard session boundary. Normal route/workspace ownership releases individual
 * leases; logout and cross-tenant navigation dispose every module-level live
 * capability so no authenticated closure can survive the old document.
 */
export function disposeOsCapabilities(): void {
	resetRealtimePumps();
	resetLiveWorkspaceSubscribers();
	resetRealtimeConnections();
}

/**
 * Installs the document-exit owner. A persisted pagehide is a bfcache freeze,
 * not logout/navigation: the browser owns suspension and the React tree must
 * retain its leases so it can resume on pageshow.
 */
export function installOsCapabilityPageLifecycle(
	target: PageLifecycleTarget,
	dispose: () => void = disposeOsCapabilities,
): () => void {
	const onPageHide = (event: PageHideEvent) => {
		if (event.persisted === true) return;
		dispose();
	};
	target.addEventListener("pagehide", onPageHide);
	let removed = false;
	return () => {
		if (removed) return;
		removed = true;
		target.removeEventListener("pagehide", onPageHide);
	};
}
