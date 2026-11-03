import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { CanvasDocSelection } from "@/lib/canvas-search";
import {
	createWorkspaceReconnectReconciler,
	reconcileLiveWorkspaceEvent,
	subscribeLiveWorkspace,
} from "@/lib/live-workspace-projection";
import { useRealtimeSurface } from "@/lib/use-realtime";

/**
 * Keeps the active Canvas workspace fresh without creating another transport.
 * The shared Home pump supplies relevant hints; reconnect always reconciles
 * through the canonical API. Collaborative document ownership (`use-collab-doc`)
 * is intentionally separate.
 */
export function useLiveWorkspace(
	workspaceId: string | null,
	selectedDoc: CanvasDocSelection | null,
): void {
	const queryClient = useQueryClient();
	const { status } = useRealtimeSurface({ enabled: workspaceId !== null });
	const scopeRef = useRef({
		workspaceId: workspaceId ?? "",
		gadgetId: undefined as string | undefined,
		outputId: undefined as string | undefined,
	});
	scopeRef.current = {
		workspaceId: workspaceId ?? "",
		gadgetId: selectedDoc?.type === "gadget" ? selectedDoc.id : undefined,
		outputId: selectedDoc?.type === "output" ? selectedDoc.id : undefined,
	};
	const reconnectRef = useRef<
		ReturnType<typeof createWorkspaceReconnectReconciler> | undefined
	>(undefined);
	if (!reconnectRef.current) {
		reconnectRef.current = createWorkspaceReconnectReconciler(
			queryClient,
			() => scopeRef.current,
		);
	}

	useEffect(() => {
		if (workspaceId === null) return;
		return subscribeLiveWorkspace(workspaceId, (event) => {
			reconcileLiveWorkspaceEvent(queryClient, workspaceId, event);
		});
	}, [queryClient, workspaceId]);

	useEffect(() => {
		if (workspaceId === null) return;
		reconnectRef.current?.(status);
	}, [status, workspaceId]);
}
