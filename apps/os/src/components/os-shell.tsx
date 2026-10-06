import { getCurrentTenant } from "@descope/react-sdk/flows";
import {
	CaretRight,
	GearSix,
	List,
	MagnifyingGlass,
	SidebarSimple,
	SquaresFour,
	UserCircle,
} from "@phosphor-icons/react";
import { Outlet, useRouterState } from "@tanstack/react-router";
import { Fragment, useEffect, useRef, useState } from "react";
import { Button } from "@/components/kumo/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/kumo/dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/kumo/avatar";
import { buildAccountProfileUrl } from "@/shared/account-profile-routing";
import {
	isOsShellNavigationItemActive,
	OS_SHELL_NAVIGATION_SECTIONS,
	OS_SHELL_PRIMARY_NAVIGATION,
	type OsShellNavigationItem,
	resolveOsShellRouteContext,
} from "@/lib/os-shell-navigation";
import { resolveOsTenant } from "@/shared/os-tenant";
import { Link } from "@/components/kumo/link";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarProvider,
	SidebarTrigger,
	useSidebar,
} from "@/components/kumo/sidebar";
import { OsCommandPalette } from "@/components/os-command-palette";
import { ApprovalNotifications } from "@/components/approval-notifications";
import { OsQuickChat } from "@/components/os-quick-chat";
import { OsSidebarWorkspaces } from "@/components/os-sidebar-workspaces";
import { OsSidebarBillingStatus } from "@/components/os-sidebar-billing-status";
import { OsWorkspaceSwitcher } from "@/components/os-workspace-switcher";
import { TransportStatus } from "@/components/transport-status";
import { shouldUseWorkspaceWorkbench } from "@/lib/os-layout-routing";
import { SURFACE_ICONS } from "@/lib/surface-icons";
import { useOsIdentity } from "@/lib/use-os-identity";
import type { OsIdentity } from "@/lib/use-os-identity";
import {
	useOsDurableTheme,
	useOsOrganizationTheme,
} from "@/lib/use-os-preferences";

const SIDEBAR_COLLAPSED_KEY = "tedix-os-sidebar-collapsed";

function navigationIcon(item: OsShellNavigationItem) {
	return item.id === "workspaces" ? SquaresFour : SURFACE_ICONS[item.id];
}

/**
 * Kumo keeps the mobile sheet open across a client navigation; the shell has
 * always dismissed it, so re-assert that here rather than wiring an onClick
 * through every nav row.
 */
function CloseMobileNavigationOnNavigate({ pathname }: { pathname: string }) {
	const { isMobile, setOpenMobile } = useSidebar();
	const previousPathname = useRef(pathname);

	useEffect(() => {
		if (isMobile && previousPathname.current !== pathname) setOpenMobile(false);
		previousPathname.current = pathname;
	}, [isMobile, pathname, setOpenMobile]);

	return null;
}

function SidebarNavigationItem({
	item,
	pathname,
}: {
	item: OsShellNavigationItem;
	pathname: string;
}) {
	return (
		<SidebarMenuButton
			active={isOsShellNavigationItemActive(item, pathname)}
			href={item.path}
			icon={navigationIcon(item)}
			tooltip={item.label}
		>
			{item.label}
		</SidebarMenuButton>
	);
}

function OsSidebar({
	identity,
	onOpenPalette,
	pathname,
	tenantLabel,
}: {
	identity: OsIdentity;
	onOpenPalette: () => void;
	pathname: string;
	tenantLabel: string;
}) {
	const { state } = useSidebar();
	const collapsed = state === "collapsed";

	return (
		<Sidebar aria-label="OS navigation">
			<SidebarHeader>
				<OsWorkspaceSwitcher>
					<div className="brand-mark" aria-hidden="true">
						T
					</div>
					<div className="flex min-w-0 flex-col text-left group-data-[state=collapsed]/sidebar:hidden">
						<strong className="whitespace-nowrap type-tedix-body font-semibold">
							OS
						</strong>
						<span className="max-w-[140px] truncate text-kumo-subtle type-tedix-caption">
							{tenantLabel}
						</span>
					</div>
				</OsWorkspaceSwitcher>
			</SidebarHeader>

			<SidebarGroup className="shrink-0 px-2">
				{collapsed ? null : (
					<Button
						className="mx-0 my-2 flex !h-8 w-full items-center gap-2.5 whitespace-nowrap rounded-lg border border-transparent bg-kumo-base px-3 text-left text-kumo-subtle transition-colors hover:border-kumo-hairline hover:bg-kumo-tint hover:text-kumo-default coarse:min-h-11"
						onClick={onOpenPalette}
						size="sm"
						variant="ghost"
					>
						<MagnifyingGlass size={14} />
						<span>Quick search…</span>
						<kbd className="ml-auto text-kumo-subtle type-tedix-caption">
							⌘K
						</kbd>
					</Button>
				)}

				<SidebarGroup>
					<SidebarMenu aria-label="Primary">
						{OS_SHELL_PRIMARY_NAVIGATION.map((item) => (
							<SidebarNavigationItem
								item={item}
								key={item.id}
								pathname={pathname}
							/>
						))}
					</SidebarMenu>
				</SidebarGroup>
			</SidebarGroup>
			<SidebarContent>
				{OS_SHELL_NAVIGATION_SECTIONS.map((section) => (
					<Fragment key={section.label}>
						<SidebarGroup>
							<SidebarGroupLabel>{section.label}</SidebarGroupLabel>
							<SidebarMenu aria-label={section.label}>
								{section.items.map((item) => (
									<SidebarNavigationItem
										item={item}
										key={item.id}
										pathname={pathname}
									/>
								))}
							</SidebarMenu>
						</SidebarGroup>
						{section.label === "Capabilities" ? <OsSidebarWorkspaces /> : null}
					</Fragment>
				))}
			</SidebarContent>

			<SidebarFooter className="h-auto flex-col gap-1.5 py-2.5 group-data-[state=collapsed]/sidebar:px-2">
				<OsSidebarBillingStatus />
				<SidebarMenu aria-label="Organization" className="w-full">
					<SidebarMenuButton
						href="/admin"
						aria-label="Organization settings"
						icon={GearSix}
						tooltip="Organization settings"
					>
						Organization settings
					</SidebarMenuButton>
				</SidebarMenu>
				<SidebarMenu aria-label="Account" className="w-full">
					<SidebarMenuButton
						href="/account/settings"
						aria-label="Personal settings"
						icon={GearSix}
						tooltip="Personal settings"
					>
						Personal settings
					</SidebarMenuButton>
				</SidebarMenu>
				<div className="flex items-center gap-1 self-stretch group-data-[state=collapsed]/sidebar:flex-col group-data-[state=collapsed]/sidebar:gap-1.5 group-data-[state=collapsed]/sidebar:self-auto">
					<SidebarTrigger
						aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
						className="ml-auto shrink-0 group-data-[state=collapsed]/sidebar:ml-0"
						title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
					>
						<SidebarSimple size={15} />
					</SidebarTrigger>
				</div>
				<Link
					aria-label="User profile"
					className="group/user-chip flex min-w-0 items-center gap-2 self-stretch text-kumo-subtle type-tedix-label no-underline! transition-colors hover:text-kumo-default max-sm:min-h-11 max-sm:min-w-11 coarse:min-h-11 coarse:min-w-11 group-data-[state=collapsed]/sidebar:self-auto"
					href={buildAccountProfileUrl(new URL(window.location.href))}
				>
					<Avatar size="sm" className="size-7">
						{identity.avatarUrl ? (
							<AvatarImage src={identity.avatarUrl} alt="" />
						) : null}
						<AvatarFallback className="font-semibold uppercase">
							{identity.name[0] || "T"}
						</AvatarFallback>
					</Avatar>
					<span className="max-w-[116px] truncate group-data-[state=collapsed]/sidebar:hidden">
						{identity.name}
					</span>
					<UserCircle
						className="shrink-0 opacity-0 transition-opacity group-hover/user-chip:opacity-100 group-focus-visible/user-chip:opacity-100 group-data-[state=collapsed]/sidebar:hidden"
						size={13}
					/>
				</Link>
			</SidebarFooter>
		</Sidebar>
	);
}

function TopbarSearch({ onOpenPalette }: { onOpenPalette: () => void }) {
	const { isMobile, state } = useSidebar();
	if (!isMobile && state === "expanded") return null;

	if (isMobile) {
		return (
			<Button
				aria-label="Search"
				className="topbar-search"
				onClick={onOpenPalette}
				size="icon-sm"
				title="Search"
				variant="ghost"
			>
				<MagnifyingGlass size={15} />
			</Button>
		);
	}

	return (
		<Button
			aria-label="Search"
			className="topbar-search"
			onClick={onOpenPalette}
			size="sm"
			title="Search"
			variant="ghost"
		>
			<MagnifyingGlass size={15} />
			<span>Search</span>
			<kbd>⌘K</kbd>
		</Button>
	);
}

/** Only the mobile sheet needs a hamburger; the rail owns its own trigger. */
function MobileNavigationTrigger() {
	const { isMobile } = useSidebar();
	if (!isMobile) return null;
	return (
		<SidebarTrigger
			aria-label="Toggle navigation"
			className="ghost-icon-button"
		>
			<List size={18} />
		</SidebarTrigger>
	);
}

export function OsShell() {
	const [paletteOpen, setPaletteOpen] = useState(false);
	const [setupPromptOpen, setSetupPromptOpen] = useState(
		() => new URLSearchParams(window.location.search).get("setup") === "1",
	);
	const closeSetupPrompt = () => {
		setSetupPromptOpen(false);
		const url = new URL(window.location.href);
		url.searchParams.delete("setup");
		window.history.replaceState(window.history.state, "", url);
	};
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});
	const identity = useOsIdentity();
	// Also the app-wide hydration point for durable preferences: mounting this
	// applies the stored theme/density/motion/contrast/locale to every surface,
	// not just the settings page.
	useOsDurableTheme();
	useOsOrganizationTheme();
	const tenant = resolveOsTenant(window.location.hostname);
	// getCurrentTenant is Descope-backed; the zero-account local lane mounts
	// no Descope, so it must not be consulted there.
	const tenantLabel =
		tenant.kind === "local"
			? tenant.slug || "Local workspace"
			: tenant.kind === "tenant"
				? tenant.slug || getCurrentTenant() || "Workspace"
				: "Tedix";
	const routeContext = resolveOsShellRouteContext(pathname);
	const workspaceWorkbench = shouldUseWorkspaceWorkbench(pathname);

	useEffect(() => {
		const handleShortcut = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
				event.preventDefault();
				setPaletteOpen((open) => !open);
			}
		};
		window.addEventListener("keydown", handleShortcut);
		return () => window.removeEventListener("keydown", handleShortcut);
	}, []);

	return (
		<SidebarProvider collapsedStorageKey={SIDEBAR_COLLAPSED_KEY}>
			<CloseMobileNavigationOnNavigate pathname={pathname} />
			{workspaceWorkbench ? null : (
				<OsSidebar
					identity={identity}
					onOpenPalette={() => setPaletteOpen(true)}
					pathname={pathname}
					tenantLabel={tenantLabel}
				/>
			)}

			<div className="os-main flex-1">
				{workspaceWorkbench ? null : (
					<header className="topbar">
						<MobileNavigationTrigger />
						<div className="topbar-context" aria-label="Current route">
							{routeContext.section ? (
								<>
									<span>{routeContext.section}</span>
									<CaretRight aria-hidden size={11} />
								</>
							) : null}
							<strong>{routeContext.label}</strong>
						</div>
						<div className="topbar-actions">
							<ApprovalNotifications />
							<TopbarSearch onOpenPalette={() => setPaletteOpen(true)} />
							<TransportStatus />
						</div>
					</header>
				)}
				<main className="route-content">
					<Outlet />
				</main>
			</div>
			<OsCommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
			<OsQuickChat />
			<Dialog
				open={setupPromptOpen}
				onOpenChange={(open) => !open && closeSetupPrompt()}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Set up Tedix on this device</DialogTitle>
						<DialogDescription>
							Install the Tedix CLI, then choose the Codex or Claude Code plugin
							for its skills and optional session hook. Each host will ask you
							to review its own connection and hook permissions.
						</DialogDescription>
					</DialogHeader>
					<p className="text-kumo-subtle type-tedix-label">
						Your browser cannot run a local installer. The setup guide gives you
						commands to copy into your terminal and the steps to verify the
						connection.
					</p>
					<DialogFooter>
						<Button onClick={closeSetupPrompt} variant="ghost">
							Later
						</Button>
						<Button onClick={() => window.location.assign("/install")}>
							Set up this device
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</SidebarProvider>
	);
}
