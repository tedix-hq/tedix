import type { ReactNode } from "react";
import { CaretUpDown, Check } from "@phosphor-icons/react";
import { resolveOsTenant } from "@/shared/os-tenant";
import {
	findWorkspaceSurface,
	useSurfaceSwitch,
	useWorkspaceDirectory,
} from "@/lib/workspace-switcher";
import { Button } from "@/components/kumo/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/kumo/dropdown-menu";
import { osApi } from "@/lib/api";
import { myWorkspacesDirectoryQueryOptions } from "@/lib/os-query-options";

const APP_SURFACES = ["os", "cms"] as const;

const SURFACE_LABELS = {
	cms: "CMS",
	os: "OS",
} as const;

/**
 * Tenant-chrome workspace and app switcher. The authenticated directory owns
 * membership, provisioning, and every destination URL; this component only
 * presents those records and initiates full-page session handoffs.
 */
export function OsWorkspaceSwitcher({ children }: { children?: ReactNode }) {
	const tenant = resolveOsTenant(window.location.hostname);
	const directoryQuery = myWorkspacesDirectoryQueryOptions({
		limit: 100,
		offset: 0,
	});
	const directory = useWorkspaceDirectory({
		current: { slug: tenant.kind === "tenant" ? tenant.slug : undefined },
		enabled: tenant.kind === "tenant",
		load: () => osApi.directory.listMyWorkspaces({ limit: 100, offset: 0 }),
		queryKey: directoryQuery.queryKey,
	});
	const surfaceSwitch = useSurfaceSwitch({});

	if (tenant.kind !== "tenant") return children;

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						aria-label="Switch workspace or app"
						className="flex w-full min-w-0 items-center justify-start gap-2 px-0 group-data-[state=collapsed]/sidebar:justify-center"
						multiline
						size="sm"
						title="Switch workspace or app"
						variant="ghost"
					/>
				}
			>
				{children}
				<CaretUpDown
					size={14}
					className="ml-auto shrink-0 group-data-[state=collapsed]/sidebar:hidden"
				/>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-64">
				<DropdownMenuGroup>
					<DropdownMenuLabel>Workspaces and apps</DropdownMenuLabel>
				</DropdownMenuGroup>
				{directory.query.isLoading ? (
					<DropdownMenuItem disabled>Loading workspaces…</DropdownMenuItem>
				) : null}
				{directory.query.isError ? (
					<DropdownMenuItem disabled>
						Workspace directory unavailable
					</DropdownMenuItem>
				) : null}
				{directory.workspaces.map((workspace, workspaceIndex) => (
					<DropdownMenuGroup key={workspace.org.organizationId}>
						{workspaceIndex > 0 ? <DropdownMenuSeparator /> : null}
						<DropdownMenuLabel>{workspace.org.name}</DropdownMenuLabel>
						{!workspace.org.provisionComplete ? (
							<DropdownMenuItem disabled>Provisioning</DropdownMenuItem>
						) : (
							APP_SURFACES.map((surface) => {
								const entry = findWorkspaceSurface(workspace, surface);
								const isCurrent =
									surface === "os" && workspace.org.slug === tenant.slug;
								return (
									<DropdownMenuItem
										disabled={!entry?.provisioned || isCurrent}
										key={surface}
										onClick={() => surfaceSwitch.switchTo(workspace, surface)}
									>
										<span className="flex-1">{SURFACE_LABELS[surface]}</span>
										{isCurrent ? <Check size={14} /> : null}
									</DropdownMenuItem>
								);
							})
						)}
					</DropdownMenuGroup>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
