import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, type ReactNode } from "react";
import { SharedWorkspacePage } from "@/components/shared-workspace-page";
import { disposeOsCapabilities } from "@/lib/capability-lifecycle";
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
	const allowed = !access.isError && access.data?.role === "build";
	const wasAllowed = useRef(false);
	useEffect(() => {
		if (wasAllowed.current && !allowed) disposeOsCapabilities();
		wasAllowed.current = allowed;
	}, [allowed]);
	if (access.isPending) return <div aria-busy="true">Opening workspace…</div>;
	if (!allowed) return <SharedWorkspacePage workspaceId={workspaceId} />;
	return children;
}
