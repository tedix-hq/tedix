import type { ReactElement, ReactNode } from "react";
import { CaretUpDown, GearSix, Plus, X } from "@phosphor-icons/react";
import type {
	DirectorySurface,
	DirectoryWorkspaceRecord,
} from "@tedix/api-contract/contracts/directory";
import {
	findWorkspaceSurface,
	useSurfaceSwitch,
} from "@/lib/workspace-switcher";
import { OsRouterLink } from "@/components/kumo/link-provider";
import { Button } from "@/components/kumo/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuEmpty,
	DropdownMenuFilterClear,
	DropdownMenuFilterInput,
	DropdownMenuFilterProvider,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuLinkItem,
	DropdownMenuList,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/kumo/dropdown-menu";
import { useQuery } from "@tanstack/react-query";
import { EntityAvatar } from "@/shared/entity-avatar";
import { useOsWorkspaceDirectory } from "@/components/os-organization-identity";
import { canAccessAdminSection } from "@/components/admin-layout";
import { operationalContextQueryOptions } from "@/lib/os-query-options";

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
	const context = useQuery({
		...operationalContextQueryOptions(),
		enabled: tenant.kind === "tenant",
	});
	const canManageSettings = context.data?.authority
		? canAccessAdminSection(context.data.authority)
		: false;

	if (tenant.kind !== "tenant") return children;

	return (
		<OrganizationSwitcherMenu
			createLink={
				<OsRouterLink to="/account/onboarding" search={{ new: true }} />
			}
			currentSlug={tenant.slug}
			isError={directory.query.isError}
			isLoading={directory.query.isLoading}
			onSwitch={surfaceSwitch.switchTo}
			settingsLink={
				canManageSettings ? (
					<OsRouterLink to="/admin/organization" />
				) : undefined
			}
			workspaces={directory.workspaces}
		>
			{children}
		</OrganizationSwitcherMenu>
	);
}

/**
 * One compact row per organization, the current one first with a check.
 * Choosing a row opens that organization's OS; an organization whose CMS is
 * provisioned also gets a trailing "CMS" item inside the same highlighted row.
 * A labelled group, the filter field's own list, and a settings/create footer
 * are all shipped Kumo menu parts.
 */
export function OrganizationSwitcherMenu({
	children,
	createLink,
	currentSlug,
	isError,
	isLoading,
	onSwitch,
	settingsLink,
	workspaces,
}: {
	children?: ReactNode;
	/** Render element for the footer's create action (a link), when the caller may create organizations. */
	createLink?: ReactElement;
	currentSlug: string;
	isError: boolean;
	isLoading: boolean;
	onSwitch: (
		workspace: DirectoryWorkspaceRecord,
		surface: DirectorySurface,
	) => unknown;
	/** Render element for the footer's settings link, when the caller may manage this organization. */
	settingsLink?: ReactElement;
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
					<div className="flex items-center gap-1 rounded-md bg-kumo-base px-2 ring ring-kumo-line focus-within:ring-kumo-brand">
						<DropdownMenuFilterInput
							aria-label="Search organizations"
							className="bg-transparent px-0 ring-0 focus-visible:ring-0"
							placeholder="Search organizations…"
						/>
						<DropdownMenuFilterClear aria-label="Clear organization search">
							<X aria-hidden="true" size={12} weight="bold" />
						</DropdownMenuFilterClear>
					</div>
				) : null}
				<DropdownMenuList className="max-h-[min(20rem,50dvh)] min-h-0 overflow-y-auto overscroll-contain">
					<DropdownMenuGroup>
						<DropdownMenuLabel>Organizations</DropdownMenuLabel>
						{isLoading ? (
							<DropdownMenuItem disabled>
								Loading organizations…
							</DropdownMenuItem>
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
					</DropdownMenuGroup>
					{searchable ? (
						<DropdownMenuEmpty className="px-2 py-1.5 text-kumo-subtle type-tedix-control">
							No organizations match
						</DropdownMenuEmpty>
					) : null}
					{settingsLink || createLink ? (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuGroup>
								{settingsLink ? (
									<DropdownMenuLinkItem icon={GearSix} render={settingsLink}>
										Organization settings
									</DropdownMenuLinkItem>
								) : null}
								{createLink ? (
									<DropdownMenuLinkItem icon={Plus} render={createLink}>
										Create organization
									</DropdownMenuLinkItem>
								) : null}
							</DropdownMenuGroup>
						</>
					) : null}
				</DropdownMenuList>
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
		<div
			className="flex min-w-0 items-stretch rounded-md transition-colors has-[data-highlighted]:bg-kumo-tint"
			data-org-row={org.slug}
		>
			<DropdownMenuItem
				aria-current={isCurrent ? "true" : undefined}
				className="min-w-0 flex-1 data-[highlighted]:bg-transparent"
				disabled={!isCurrent && (settingUp || !os?.provisioned)}
				label={org.name}
				onClick={() => {
					if (!isCurrent) onSwitch(workspace, "os");
				}}
				selected={isCurrent}
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
			</DropdownMenuItem>
			{!settingUp && cms?.provisioned ? (
				<DropdownMenuItem
					aria-label={`Open ${org.name} CMS`}
					className="shrink-0 px-2 text-kumo-subtle data-[highlighted]:bg-transparent data-[highlighted]:text-kumo-default data-[highlighted]:ring-1 data-[highlighted]:ring-inset data-[highlighted]:ring-kumo-line"
					label={org.name}
					onClick={() => onSwitch(workspace, "cms")}
				>
					CMS
				</DropdownMenuItem>
			) : null}
		</div>
	);
}
