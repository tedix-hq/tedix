import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
	TransportStatus,
	transportStatusTitle,
} from "@/components/transport-status";
import type { RealtimeStatusSnapshot } from "@/lib/realtime-connection";

function snapshot(
	overrides: Partial<RealtimeStatusSnapshot> = {},
): RealtimeStatusSnapshot {
	return {
		status: "idle",
		degraded: false,
		subscriptions: 0,
		subscribers: 0,
		sockets: 0,
		...overrides,
	};
}

describe("transportStatusTitle", () => {
	it("distinguishes not-live from connecting from a dropped connection", () => {
		expect(transportStatusTitle(snapshot({ status: "idle" }))).toBe(
			"No live event stream is open. Reads still refresh on use.",
		);
		expect(transportStatusTitle(snapshot({ status: "connecting" }))).toBe(
			"Opening the live event stream.",
		);
		// A retrying connection must never read as a first-load spinner.
		expect(
			transportStatusTitle(snapshot({ status: "reconnecting" })),
		).toContain("dropped and is retrying");
	});

	it("claims the multiplex only when there is one to claim", () => {
		// Counts must be absent, not zero, until a subscription exists.
		expect(transportStatusTitle(snapshot({ status: "open" }))).toBe(
			"Live event stream open.",
		);
		expect(
			transportStatusTitle(
				snapshot({ status: "open", subscriptions: 1, subscribers: 3 }),
			),
		).toBe("Live event stream open. 3 surfaces on 1 subscription.");
	});

	it("says live updates are paused when the transport is degraded", () => {
		// Degraded outranks every status: it is the one claim that changes what
		// the user should expect from the surface (polling, not push).
		expect(
			transportStatusTitle(
				snapshot({ status: "reconnecting", degraded: true }),
			),
		).toContain("Live updates are paused");
	});
});

describe("TransportStatus", () => {
	it("keeps the healthy idle shell quiet", () => {
		const markup = renderToStaticMarkup(<TransportStatus />);
		expect(markup).toBe("");
	});
});
