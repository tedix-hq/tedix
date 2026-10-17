import { OrganizationMark } from "@/shared/organization-mark";
import { osApi } from "@/lib/api";
import { myWorkspacesDirectoryQueryOptions } from "@/lib/os-query-options";
import { useWorkspaceDirectory } from "@/lib/workspace-switcher";
import { resolveOsTenant } from "@/shared/os-tenant";

const DIRECTORY_PAGE = { limit: 100, offset: 0 } as const;

/**
 * The caller's workspace directory, resolved against the tenant this OS host
 * serves. One query backs both the sidebar identity and the switcher menu.
 */
export function useOsWorkspaceDirectory() {
	const tenant = resolveOsTenant(window.location.hostname);
	const directory = useWorkspaceDirectory({
		current: { slug: tenant.kind === "tenant" ? tenant.slug : undefined },
		enabled: tenant.kind === "tenant",
		load: () => osApi.directory.listMyWorkspaces(DIRECTORY_PAGE),
		queryKey: myWorkspacesDirectoryQueryOptions(DIRECTORY_PAGE).queryKey,
	});
	const current =
		tenant.kind === "tenant"
			? (directory.workspaces.find(
					(workspace) => workspace.org.slug === tenant.slug,
				) ?? null)
			: null;
	return { ...directory, current, tenant };
}

/**
 * Sidebar header identity: the current organization's logo and display name
 * over the app label. Until the directory answers (or off a tenant host) it
 * shows the letter tile and `fallbackLabel`.
 */
export function OsOrganizationIdentity({
	fallbackLabel,
}: {
	fallbackLabel: string;
}) {
	const { current } = useOsWorkspaceDirectory();
	const name = current?.org.name || fallbackLabel;

	return (
		<>
			<OrganizationMark logoUrl={current?.org.logoUrl} name={name} />
			<div className="flex min-w-0 flex-col text-left group-data-[state=collapsed]/sidebar:hidden">
				<strong className="max-w-[160px] truncate type-tedix-body font-semibold">
					{name}
				</strong>
				<span className="whitespace-nowrap text-kumo-subtle type-tedix-caption">
					OS
				</span>
			</div>
		</>
	);
}
