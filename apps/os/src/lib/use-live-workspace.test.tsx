import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	liveWorkspaceSubscriberCount,
	publishLiveWorkspaceEvent,
	resetLiveWorkspaceSubscribers,
} from "./live-workspace-projection";
import { useLiveWorkspace } from "./use-live-workspace";

vi.mock("./use-realtime", () => ({
	useRealtimeSurface: () => ({ conversationId: "home:main", status: "open" }),
}));

const WORKSPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function Probe({ workspaceId }: { workspaceId: string | null }) {
	useLiveWorkspace(workspaceId, null);
	return null;
}

function render(node: ReactNode) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	const container = document.createElement("div");
	const root = createRoot(container);
	const draw = (next: ReactNode) =>
		act(() => {
			root.render(
				createElement(QueryClientProvider, { client: queryClient }, next),
			);
		});
	draw(node);
	return {
		queryClient,
		rerender: draw,
		unmount: () => act(() => root.unmount()),
	};
}

afterEach(() => resetLiveWorkspaceSubscribers());

describe("useLiveWorkspace lifecycle", () => {
	it("releases the old workspace listener on switch and the final one on unmount", () => {
		const rendered = render(createElement(Probe, { workspaceId: WORKSPACE_A }));
		const invalidations = vi.spyOn(rendered.queryClient, "invalidateQueries");
		expect(liveWorkspaceSubscriberCount()).toBe(1);

		rendered.rerender(createElement(Probe, { workspaceId: WORKSPACE_B }));
		expect(liveWorkspaceSubscriberCount()).toBe(1);
		publishLiveWorkspaceEvent({
			id: "event-a",
			kind: "artifact.created",
			conversationId: "home:main",
			createdAt: "2026-08-18T12:00:00.000Z",
			payload: { workspaceId: WORKSPACE_A },
		});
		expect(invalidations).not.toHaveBeenCalled();

		publishLiveWorkspaceEvent({
			id: "event-b",
			kind: "artifact.created",
			conversationId: "home:main",
			createdAt: "2026-08-18T12:00:01.000Z",
			payload: { workspaceId: WORKSPACE_B },
		});
		expect(invalidations).toHaveBeenCalledTimes(3);

		rendered.unmount();
		expect(liveWorkspaceSubscriberCount()).toBe(0);
	});
});
