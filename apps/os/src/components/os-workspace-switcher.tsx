import type { ReactNode } from "react";
import { CaretUpDown, Check } from "@phosphor-icons/react";
import {
	findWorkspaceSurface,
	useSurfaceSwitch,
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
import { EntityAvatar } from "@/components/entity-avatar";
import { useOsWorkspaceDirectory } from "@/components/os-organization-identity";

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
	const { tenant, ...directory } = useOsWorkspaceDirectory();
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
			<DropdownMenuContent
				align="start"
				className="w-(--anchor-width) min-w-56 max-w-[calc(100vw-1rem)]"
			>
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
						<DropdownMenuLabel className="flex items-center gap-2">
							<EntityAvatar
								id={workspace.org.organizationId}
								image={workspace.org.logoUrl}
								name={workspace.org.name}
								kind="workspace"
								className="size-6 rounded-md"
							/>
							<span className="min-w-0 truncate">{workspace.org.name}</span>
						</DropdownMenuLabel>
						{!workspace.org.provisionComplete ? (
							<DropdownMenuItem disabled>
								Setting up — check back soon
							</DropdownMenuItem>
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
