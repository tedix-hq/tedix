import { useQuery } from "@tanstack/react-query";
import type {
	DirectorySurface,
	DirectoryWorkspaceRecord,
} from "@tedix/api-contract/contracts/directory";
import { useCallback, useMemo, useState } from "react";

export interface WorkspaceDirectoryResponse {
	data: DirectoryWorkspaceRecord[];
	pagination: {
		hasMore: boolean;
		limit: number;
		offset: number;
		total: number;
	};
}

export interface WorkspaceIdentityHint {
	organizationId?: string | null;
	slug?: string | null;
	tenantId?: string | null;
}

export function selectActiveWorkspace(
	workspaces: readonly DirectoryWorkspaceRecord[],
	hint: WorkspaceIdentityHint,
): DirectoryWorkspaceRecord | null {
	return (
		workspaces.find(
			(workspace) =>
				(Boolean(hint.organizationId) &&
					workspace.org.organizationId === hint.organizationId) ||
				(Boolean(hint.slug) && workspace.org.slug === hint.slug) ||
				(Boolean(hint.tenantId) &&
					workspace.org.descopeTenantId === hint.tenantId),
		) ??
		workspaces[0] ??
		null
	);
}

export function useWorkspaceDirectory({
	current,
	enabled = true,
	load,
	queryKey,
}: {
	current: WorkspaceIdentityHint;
	enabled?: boolean;
	load: () => Promise<WorkspaceDirectoryResponse>;
	queryKey: readonly unknown[];
}) {
	const query = useQuery({ enabled, queryFn: load, queryKey });
	const workspaces = query.data?.data ?? [];
	const activeWorkspace = useMemo(
		() => selectActiveWorkspace(workspaces, current),
		[current.organizationId, current.slug, current.tenantId, workspaces],
	);
	return { activeWorkspace, query, workspaces };
}

export function findWorkspaceSurface(
	workspace: DirectoryWorkspaceRecord,
	surface: DirectorySurface,
) {
	return workspace.surfaces.find((entry) => entry.surface === surface) ?? null;
}

export function buildSurfaceSwitchUrl({
	surface,
	workspace,
}: {
	surface: DirectorySurface;
	workspace: DirectoryWorkspaceRecord;
}): string | null {
	const target = findWorkspaceSurface(workspace, surface);
	if (
		!workspace.org.provisionComplete ||
		!target?.provisioned ||
		!target.canonicalUrl
	) {
		return null;
	}
	return surface === "mcp" ? target.canonicalUrl : target.handoffUrl;
}

export function useSurfaceSwitch({
	navigate,
}: {
	navigate?: (url: string) => void;
}) {
	const [switchingTo, setSwitchingTo] = useState<string | null>(null);
	const switchTo = useCallback(
		(
			workspace: DirectoryWorkspaceRecord,
			surface: DirectorySurface,
			_redirectTo = "/",
		) => {
			const url = buildSurfaceSwitchUrl({
				surface,
				workspace,
			});
			if (!url) return false;
			setSwitchingTo(`${workspace.org.organizationId}:${surface}`);
			(navigate ?? ((target) => window.location.assign(target)))(url);
			return true;
		},
		[navigate],
	);
	return { switchingTo, switchTo };
}
