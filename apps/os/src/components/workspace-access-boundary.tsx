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

export const WORKSPACE_ACCESS_CHECK_MS = 3_000;

/** A permission change retires the mounted editors and chat before reopening. */
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
			refetchIntervalInBackground: true,
			retry: false,
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
	const paused = !verified;
	return (
		<WorkspaceVerificationPausedContext.Provider value={paused}>
			<div
				className="contents"
				inert={paused}
				aria-busy={paused}
				data-workspace-verification-paused={paused || undefined}
			>
				{children}
			</div>
			{paused && (
				<div
					role="alert"
					className="fixed inset-0 z-50 flex items-start justify-center bg-kumo-base/80 p-6"
				>
					<div className="grid gap-2">
						<Text>
							Workspace access could not be verified. Editing is paused; your
							open work is kept here.
						</Text>
						<Button variant="outline" onClick={() => void access.refetch()}>
							Verify access again
						</Button>
					</div>
				</div>
			)}
		</WorkspaceVerificationPausedContext.Provider>
	);
}
