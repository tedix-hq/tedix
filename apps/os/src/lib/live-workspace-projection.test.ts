import { QueryClient } from "@tanstack/react-query";
import type { RuntimeStreamEvent } from "@tedix/api-contract/schemas/runtime-submissions";
import { describe, expect, it, vi } from "vite-plus/test";
import { canvasOutputsQueryOptions } from "./os-query-options";
import {
	createWorkspaceReconnectReconciler,
	publishLiveWorkspaceEvent,
	reconcileLiveWorkspaceEvent,
	resetLiveWorkspaceSubscribers,
	subscribeLiveWorkspace,
	workspaceReferenceFromEvent,
} from "./live-workspace-projection";

const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_WORKSPACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OUTPUT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function event(
	payload: NonNullable<RuntimeStreamEvent["payload"]>,
): RuntimeStreamEvent {
	return {
		id: "event-1",
		kind: "artifact.created",
		conversationId: "home:main",
		createdAt: "2026-08-18T12:00:00.000Z",
		payload,
	};
}

function client(): QueryClient {
	return new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
}

describe("live workspace projection", () => {
	it("extracts canonical workspace references from artifact metadata", () => {
		expect(
			workspaceReferenceFromEvent(
				event({
					artifact: {
						id: "artifact-1",
						metadata: { workspaceId: WORKSPACE_ID, outputId: OUTPUT_ID },
					},
				}),
			),
		).toEqual({ workspaceId: WORKSPACE_ID, outputId: OUTPUT_ID });
	});

	it("fans a relevant server event only to the active workspace", () => {
		resetLiveWorkspaceSubscribers();
		const relevant = vi.fn();
		const unrelated = vi.fn();
		const releaseRelevant = subscribeLiveWorkspace(WORKSPACE_ID, relevant);
		const releaseUnrelated = subscribeLiveWorkspace(
			OTHER_WORKSPACE_ID,
			unrelated,
		);
		const emitted = event({ workspaceId: WORKSPACE_ID, outputId: OUTPUT_ID });
		publishLiveWorkspaceEvent(emitted);
		expect(relevant).toHaveBeenCalledWith(emitted);
		expect(unrelated).not.toHaveBeenCalled();
		releaseRelevant();
		releaseUnrelated();
	});

	it("invalidates only the matching workspace and named output", async () => {
		const queryClient = client();
		const invalidations = vi.spyOn(queryClient, "invalidateQueries");
		expect(
			reconcileLiveWorkspaceEvent(
				queryClient,
				WORKSPACE_ID,
				event({ workspaceId: WORKSPACE_ID, outputId: OUTPUT_ID }),
			),
		).toBe(true);
		expect(invalidations).toHaveBeenCalledTimes(4);
		expect(
			invalidations.mock.calls.map(([filter]) => filter?.queryKey),
		).toContainEqual(canvasOutputsQueryOptions(WORKSPACE_ID).queryKey);
		expect(
			reconcileLiveWorkspaceEvent(
				queryClient,
				WORKSPACE_ID,
				event({ workspaceId: OTHER_WORKSPACE_ID }),
			),
		).toBe(false);
	});

	it("reacquires canonical state after reconnect but not on initial open", () => {
		const queryClient = client();
		const invalidations = vi.spyOn(queryClient, "invalidateQueries");
		const reconcile = createWorkspaceReconnectReconciler(queryClient, () => ({
			workspaceId: WORKSPACE_ID,
			outputId: OUTPUT_ID,
		}));
		reconcile("open");
		expect(invalidations).not.toHaveBeenCalled();
		reconcile("reconnecting");
		reconcile("open");
		expect(invalidations).toHaveBeenCalledTimes(4);
	});
});
