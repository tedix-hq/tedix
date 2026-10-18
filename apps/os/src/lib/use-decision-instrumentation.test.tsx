import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { useDecisionInstrumentation } from "./use-decision-instrumentation";
const state = vi.hoisted(() => ({
	record: vi.fn().mockResolvedValue({ id: "fictional-exposure" }),
}));
vi.mock("@/lib/api", () => ({
	osApi: { learningFeedback: { recordExposure: state.record } },
}));
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement | undefined;
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	state.record.mockClear();
});
function Preview({
	enabled = true,
	rail = false,
}: {
	enabled?: boolean;
	rail?: boolean;
}) {
	const ref = useRef<HTMLDivElement>(null);
	useDecisionInstrumentation({
		enabled,
		scopeKey: "fictional-org:fictional-person",
		root: ref,
		cardId: "fictional-card",
		sourceVersion: 1,
		position: 0,
		railOpened: rail,
		timezone: "UTC",
		ranking: { version: "decision-learning-v1", score: 3, features: [] },
		candidates: [
			{ id: "fictional-card", score: 3, reason: "shown", position: 0 },
			{
				id: "fictional-unshown",
				score: 2,
				reason: "ranked_lower",
				position: 1,
			},
		],
		candidateSetComplete: true,
	});
	return (
		<div ref={ref}>
			<div className="fd-decision">
				<h2 data-slot="card-title">Fictional title</h2>
				<p className="fd-recommendation" data-offscreen>
					Fictional recommendation
				</p>
				<div data-decision-actions>Approve</div>
			</div>
		</div>
	);
}
function prepare() {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
		function (this: HTMLElement) {
			return {
				x: 0,
				y: 0,
				left: 0,
				right: 100,
				top: this.hasAttribute("data-offscreen") ? 10000 : 10,
				bottom: this.hasAttribute("data-offscreen") ? 10100 : 110,
				width: 100,
				height: 100,
				toJSON: () => ({}),
			};
		},
	);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) =>
		setTimeout(() => fn(0), 0),
	);
	vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
}
it("records the visible fields and unshown alternatives, and appends a new snapshot when the rail opens", async () => {
	prepare();
	await act(async () => {
		root!.render(<Preview />);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 10));
	});
	expect(state.record).toHaveBeenCalledTimes(1);
	const first = state.record.mock.calls[0]?.[0];
	expect(first).toMatchObject({
		aboveFold: ["title", "options"],
		railOpened: false,
		candidateCount: 2,
		candidates: [
			{ cardId: "fictional-card", reason: "shown" },
			{ cardId: "fictional-unshown", reason: "ranked_lower" },
		],
	});
	await act(async () => root!.render(<Preview rail />));
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 10));
	});
	expect(state.record).toHaveBeenCalledTimes(2);
	const second = state.record.mock.calls[1]?.[0];
	expect(second.sessionId).toBe(first.sessionId);
	expect(second.clientEventId).not.toBe(first.clientEventId);
	expect(second.railOpened).toBe(true);
});
it("does not capture practice or history mode", async () => {
	prepare();
	await act(async () => root!.render(<Preview enabled={false} />));
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 10));
	});
	expect(state.record).not.toHaveBeenCalled();
});
