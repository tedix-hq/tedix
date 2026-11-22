import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { OS_API_REQUEST_TIMEOUT_MS } from "./api";
import { followWorkspaceEvents } from "./workspace-event-stream";

const { events, reconcile } = vi.hoisted(() => ({
	events: vi.fn(),
	reconcile: vi.fn(),
}));

vi.mock("./api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./api")>();
	return {
		...actual,
		osApi: {
			osCollaborators: { events, access: actual.osApi.osCollaborators.access },
		},
	};
});
vi.mock("./live-workspace-projection", () => ({
	reconcileLiveWorkspace: reconcile,
}));

afterEach(() => {
	vi.useRealTimers();
	vi.resetAllMocks();
});

function follow() {
	const controller = new AbortController();
	const queryClient = new QueryClient();
	const invalidate = vi.spyOn(queryClient, "invalidateQueries");
	const setOpen = vi.fn();
	const done = followWorkspaceEvents({
		queryClient,
		workspaceId: "workspace-1",
		signal: controller.signal,
		setOpen,
	});
	return { controller, invalidate, setOpen, done };
}

function heldRequest(_input: unknown, { signal }: { signal: AbortSignal }) {
	return new Promise((_resolve, reject) => {
		signal.addEventListener("abort", () => reject(signal.reason), {
			once: true,
		});
	});
}

describe("workspace event stream", () => {
	it.each([
		new Error("API request timed out after 15000ms"),
		new DOMException("Aborted", "AbortError"),
		new DOMException("Timed out", "TimeoutError"),
		new Error("Fetch failed", {
			cause: new Error("API request timed out after 15000ms"),
		}),
	])(
		"keeps an interrupted hold open and replays its cursor: %s",
		async (error) => {
			vi.useFakeTimers();
			events
				.mockResolvedValueOnce({ cursor: 7, kinds: [] })
				.mockResolvedValueOnce({ cursor: 8, kinds: [] })
				.mockRejectedValueOnce(error)
				.mockResolvedValueOnce({ cursor: 9, kinds: ["workspace.updated"] })
				.mockImplementationOnce(heldRequest);
			const run = follow();
			await vi.advanceTimersByTimeAsync(0);
			expect(run.setOpen.mock.calls).toEqual([[true]]);
			expect(reconcile).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1_000);
			expect(events.mock.calls[3]?.[0]).toEqual({
				workspaceId: "workspace-1",
				after: 8,
				waitMs: 12_000,
			});
			expect(events.mock.calls[3]?.[0].waitMs).toBeLessThan(
				OS_API_REQUEST_TIMEOUT_MS,
			);
			expect(run.setOpen.mock.calls).toEqual([[true]]);
			expect(reconcile).toHaveBeenCalledTimes(1);
			run.controller.abort();
			await run.done;
			expect(reconcile).toHaveBeenCalledTimes(1);
		},
	);

	it.each([new Error("Network unavailable"), { code: "FORBIDDEN" }])(
		"closes and reconciles after a real failure: %s",
		async (error) => {
			vi.useFakeTimers();
			events
				.mockResolvedValueOnce({ cursor: 7, kinds: [] })
				.mockRejectedValueOnce(error)
				.mockResolvedValueOnce({ cursor: 10, kinds: [] })
				.mockImplementationOnce(heldRequest);
			const run = follow();
			await vi.advanceTimersByTimeAsync(0);
			expect(run.setOpen.mock.calls).toEqual([[true], [false]]);
			if ("code" in error) {
				expect(run.invalidate).toHaveBeenCalledTimes(1);
			}
			await vi.advanceTimersByTimeAsync(1_000);
			expect(events.mock.calls[2]?.[0]).toEqual({
				workspaceId: "workspace-1",
			});
			expect(run.setOpen.mock.calls).toEqual([[true], [false], [true]]);
			expect(reconcile).toHaveBeenCalledTimes(1);
			run.controller.abort();
			await run.done;
		},
	);
});
