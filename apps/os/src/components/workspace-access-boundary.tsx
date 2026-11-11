import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, type ReactNode } from "react";
import { SharedWorkspacePage } from "@/components/shared-workspace-page";
import { disposeOsCapabilities } from "@/lib/capability-lifecycle";
import { Text } from "@/components/kumo/text";
import { Button } from "@/components/kumo/button";
import {
	WorkspaceVerificationPausedContext,
	isWorkspaceAccessDenied,
} from "@/lib/workspace-verification";
import { osQuery } from "@/lib/os-query-options";

/**
 * A permission change must close the editors within a few seconds, so the
 * check stays frequent. It runs in visible tabs, on focus and when the
 * browser comes back online.
 */
export const WORKSPACE_ACCESS_CHECK_MS = 3_000;

/**
 * A clear denial retires the mounted editors and chat at once. Any other
 * failed check is a connection problem: the workspace stays usable, the
 * check retries, and a small pill shows only if the retries also fail.
 */
export function WorkspaceAccessBoundary({
	workspaceId,
	children,
}: {
	workspaceId: string;
	children: ReactNode;
}) {
	const access = useQuery(
		osQuery.osCollaborators.access.queryOptions({
			input: { workspaceId },
			staleTime: 0,
			refetchInterval: WORKSPACE_ACCESS_CHECK_MS,
			refetchOnWindowFocus: true,
			refetchOnReconnect: true,
			retry: (failures, error) =>
				!isWorkspaceAccessDenied(error) && failures < 3,
			retryDelay: (attempt) => Math.min(8_000, 1_000 * 2 ** attempt),
		}),
	);

	const verified =
		!access.isError &&
		access.isFetchedAfterMount &&
		access.data?.role === "build";
	const denied = access.isError
		? isWorkspaceAccessDenied(access.error)
		: access.isFetchedAfterMount &&
			access.data !== undefined &&
			access.data.role !== "build";
	const retainedWorkspace = useRef<string | null>(null);
	useEffect(() => {
		if (verified) retainedWorkspace.current = workspaceId;
		if (denied) {
			if (retainedWorkspace.current === workspaceId) disposeOsCapabilities();
			retainedWorkspace.current = null;
		}
	}, [denied, verified, workspaceId]);
	if (denied) return <SharedWorkspacePage workspaceId={workspaceId} />;
	if (!verified && retainedWorkspace.current !== workspaceId)
		return (
			<div role="status" aria-busy={access.isPending}>
				Workspace access is being verified. Your workspace will open when
				verification succeeds.
			</div>
		);
	// Editing, chat and live sync carry on; only repository saves read this
	// and wait for a fresh check.
	const paused = !verified;
	return (
		<WorkspaceVerificationPausedContext.Provider value={paused}>
			{children}
			{paused && (
				<div
					role="status"
					data-workspace-access-unverified
					className="fixed right-4 bottom-4 z-50 flex items-center gap-2 rounded-full border border-kumo-line bg-kumo-elevated py-1 pr-1 pl-3 shadow-tedix-control"
				>
					<Text as="span" className="type-tedix-caption">
						{access.isFetching ? "Reconnecting…" : "Connection lost"}
					</Text>
					<Button
						variant="ghost"
						size="sm"
						loading={access.isFetching}
						onClick={() => void access.refetch()}
					>
						Retry
					</Button>
				</div>
			)}
		</WorkspaceVerificationPausedContext.Provider>
	);
}
