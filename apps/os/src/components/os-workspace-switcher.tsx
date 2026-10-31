import type { ReactNode } from "react";
import { CaretUpDown, Check } from "@phosphor-icons/react";
import type {
	DirectorySurface,
	DirectoryWorkspaceRecord,
} from "@tedix/api-contract/contracts/directory";
import {
	findWorkspaceSurface,
	useSurfaceSwitch,
} from "@/lib/workspace-switcher";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuEmpty,
	DropdownMenuFilterInput,
	DropdownMenuFilterProvider,
	DropdownMenuItem,
	DropdownMenuList,
	DropdownMenuTrigger,
} from "@/components/kumo/dropdown-menu";
import { EntityAvatar } from "@/shared/entity-avatar";
import { useOsWorkspaceDirectory } from "@/components/os-organization-identity";

/** Above this many organizations the menu gets a search field. */
const SEARCH_AFTER = 6;

/**
 * Tenant-chrome organization switcher. The authenticated directory owns
 * membership, provisioning, and every destination URL; this component only
 * presents those records and initiates full-page session handoffs.
 */
export function OsWorkspaceSwitcher({ children }: { children?: ReactNode }) {
	const { tenant, ...directory } = useOsWorkspaceDirectory();
	const surfaceSwitch = useSurfaceSwitch({});

	if (tenant.kind !== "tenant") return children;

	return (
		<OrganizationSwitcherMenu
			currentSlug={tenant.slug}
			isError={directory.query.isError}
			isLoading={directory.query.isLoading}
			onSwitch={surfaceSwitch.switchTo}
			workspaces={directory.workspaces}
		>
			{children}
		</OrganizationSwitcherMenu>
	);
}

/**
 * One compact row per organization, the current one first with a check.
 * Choosing a row opens that organization's OS; an organization whose CMS is
 * provisioned also gets a trailing "CMS" item on the same row.
 */
export function OrganizationSwitcherMenu({
	children,
	currentSlug,
	isError,
	isLoading,
	onSwitch,
	workspaces,
}: {
	children?: ReactNode;
	currentSlug: string;
	isError: boolean;
	isLoading: boolean;
	onSwitch: (
		workspace: DirectoryWorkspaceRecord,
		surface: DirectorySurface,
	) => unknown;
	workspaces: readonly DirectoryWorkspaceRecord[];
}) {
	const ordered = [
		...workspaces.filter((workspace) => workspace.org.slug === currentSlug),
		...workspaces.filter((workspace) => workspace.org.slug !== currentSlug),
	];
	const searchable = ordered.length > SEARCH_AFTER;

	const menu = (
		<DropdownMenu>
			<SwitcherTrigger>{children}</SwitcherTrigger>
			<DropdownMenuContent
				align="start"
				className="flex w-72 max-w-[calc(100vw-1rem)] flex-col gap-1 overflow-hidden"
			>
				{searchable ? (
					<DropdownMenuFilterInput
						aria-label="Search organizations"
						placeholder="Search organizations…"
					/>
				) : null}
				<DropdownMenuList className="max-h-[min(20rem,50dvh)] min-h-0 overflow-y-auto overscroll-contain">
					{isLoading ? (
						<DropdownMenuItem disabled>Loading organizations…</DropdownMenuItem>
					) : null}
					{isError ? (
						<DropdownMenuItem disabled>
							Organizations unavailable
						</DropdownMenuItem>
					) : null}
					{ordered.map((workspace) => (
						<OrganizationRow
							isCurrent={workspace.org.slug === currentSlug}
							key={workspace.org.organizationId}
							onSwitch={onSwitch}
							workspace={workspace}
						/>
					))}
				</DropdownMenuList>
				{searchable ? (
					<DropdownMenuEmpty className="px-2 py-1.5 text-kumo-subtle type-tedix-control">
						No organizations match
					</DropdownMenuEmpty>
				) : null}
			</DropdownMenuContent>
		</DropdownMenu>
	);

	return searchable ? (
		<DropdownMenuFilterProvider>{menu}</DropdownMenuFilterProvider>
	) : (
		menu
	);
}

function SwitcherTrigger({ children }: { children?: ReactNode }) {
	return (
		<DropdownMenuTrigger
			render={
				<Button
					aria-label="Switch organization"
					className="flex w-full min-w-0 items-center justify-start gap-2 px-0 group-data-[state=collapsed]/sidebar:justify-center"
					multiline
					size="sm"
					title="Switch organization"
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
	);
}

function OrganizationRow({
	isCurrent,
	onSwitch,
	workspace,
}: {
	isCurrent: boolean;
	onSwitch: (
		workspace: DirectoryWorkspaceRecord,
		surface: DirectorySurface,
	) => unknown;
	workspace: DirectoryWorkspaceRecord;
}) {
	const { org } = workspace;
	const settingUp = !org.provisionComplete;
	const os = findWorkspaceSurface(workspace, "os");
	const cms = findWorkspaceSurface(workspace, "cms");
	return (
		<div className="flex min-w-0 items-center gap-1" data-org-row={org.slug}>
			<DropdownMenuItem
				aria-current={isCurrent ? "true" : undefined}
				className="min-w-0 flex-1"
				disabled={!isCurrent && (settingUp || !os?.provisioned)}
				label={org.name}
				onClick={() => {
					if (!isCurrent) onSwitch(workspace, "os");
				}}
			>
				<EntityAvatar
					id={org.organizationId}
					image={org.logoUrl}
					name={org.name}
					kind="workspace"
					className="size-5 rounded"
				/>
				<span className="min-w-0 flex-1 truncate" title={org.name}>
					{org.name}
				</span>
				{settingUp ? (
					<span className="shrink-0 text-kumo-subtle type-tedix-caption">
						Setting up
					</span>
				) : null}
				{isCurrent ? (
					<Check aria-label="Current organization" size={14} />
				) : null}
			</DropdownMenuItem>
			{!settingUp && cms?.provisioned ? (
				<DropdownMenuItem
					aria-label={`Open ${org.name} CMS`}
					className="shrink-0 px-1.5"
					label={org.name}
					onClick={() => onSwitch(workspace, "cms")}
				>
					<Badge variant="outline">CMS</Badge>
				</DropdownMenuItem>
			) : null}
		</div>
	);
}
