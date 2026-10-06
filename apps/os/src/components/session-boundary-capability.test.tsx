import { act } from "react";
import { createRoot } from "react-dom/client";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { SessionBoundary } from "@/components/session-boundary";
import type { CapnSessionStub } from "@/capnweb/contract";
import {
	acquireConversationStream,
	realtimeSubscriptionCount,
	resetRealtimeConnections,
} from "@/lib/realtime-connection";

/**
 * The capability-lifecycle singleton trap (slice-2 apex account promotion).
 *
 * `SessionBoundary` composes `OsCapabilityLifecycleBoundary`, whose UNMOUNT
 * calls `disposeOsCapabilities()` — which resets the MODULE-LEVEL realtime
 * connection manager (`resetRealtimeConnections` et al). Two boundary instances
 * mounted in one document are therefore NOT independent: the first to unmount
 * tears the shared realtime manager out from under the second, and chat/canvas
 * silently stop updating with no error and no reconnect.
 *
 * The account surface is a set of first-class routes under the existing
 * `_session` SessionBoundary rather than giving it a second boundary. These
 * tests lock that in: the positive case is the shipped structure (one shared
 * boundary, the account subtree unmounts and the product realtime survives); the
 * characterization case proves WHY a second boundary is forbidden.
 *
 * A single-mount boundary test cannot catch either: the hazard only appears when
 * two surfaces coexist and one goes away.
 */

// happy-dom serves `http://localhost/`, so `resolveOsTenant(hostname)` is the
// zero-account local lane and `SessionBoundary` is a pass-through capability
// boundary that mounts its children synchronously — no broker fetch to stub.
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: Array<() => void> = [];

/** A connect seam that never resolves: these tests count subscriptions, not frames. */
const pendingConnect = (): Promise<CapnSessionStub> => new Promise(() => {});

/** Holds one live conversation stream for as long as it is mounted. */
function ProductStreamSurface({ conversationId }: { conversationId: string }) {
	useEffect(() => {
		const lease = acquireConversationStream(
			conversationId,
			{},
			{ connect: pendingConnect, metrics: null },
		);
		return () => lease.release();
	}, [conversationId]);
	return null;
}

function mount(node: React.ReactNode) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => root.render(node));
	const rerender = (next: React.ReactNode) => act(() => root.render(next));
	cleanups.push(() => {
		act(() => root.unmount());
		container.remove();
	});
	return { container, rerender };
}

beforeEach(() => {
	resetRealtimeConnections();
});

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
	resetRealtimeConnections();
});

describe("account/product capability-lifecycle coexistence", () => {
	it("keeps the product realtime stream alive when the account subtree unmounts (slice-2 shared boundary)", () => {
		// The shipped structure: ONE SessionBoundary owns capability lifecycle;
		// the product surface and the account surface are sibling subtrees under
		// it, exactly as `_session/_tenant` and `_session/account` are.
		const view = (showAccount: boolean) => (
			<SessionBoundary renderLogin={() => null}>
				<ProductStreamSurface conversationId="home:main" />
				{showAccount ? <div data-testid="account-surface" /> : null}
			</SessionBoundary>
		);

		const { rerender } = mount(view(true));
		expect(realtimeSubscriptionCount()).toBe(1);

		// Unmount ONLY the account subtree. The shared boundary stays mounted, so
		// nothing disposes the connection manager.
		rerender(view(false));
		expect(realtimeSubscriptionCount()).toBe(1);
	});

	it("a SECOND boundary's unmount disposes the shared realtime manager — why the account surface must not mount one", () => {
		// The forbidden shape: two SessionBoundary instances in one document, each
		// its own OsCapabilityLifecycleBoundary. The product boundary holds a live
		// stream; the account boundary holds none.
		const view = (showAccount: boolean) => (
			<>
				<SessionBoundary renderLogin={() => null}>
					<ProductStreamSurface conversationId="home:main" />
				</SessionBoundary>
				{showAccount ? (
					<SessionBoundary renderLogin={() => null}>
						<div data-testid="account-surface" />
					</SessionBoundary>
				) : null}
			</>
		);

		const { rerender } = mount(view(true));
		expect(realtimeSubscriptionCount()).toBe(1);

		// Unmounting the account boundary fires disposeOsCapabilities(), which
		// resets the module-level manager and silently kills the product stream
		// the OTHER, still-mounted boundary depends on.
		rerender(view(false));
		expect(realtimeSubscriptionCount()).toBe(0);
	});
});
