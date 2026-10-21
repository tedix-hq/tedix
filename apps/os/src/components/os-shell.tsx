import { Kbd } from "@/components/kumo/kbd";
import { OsSettingsFrame } from "@/components/os-settings-frame";
import { useOsLocale } from "@/lib/use-os-locale";
import { WorkActorDirectory } from "@/components/work-actor-directory";
import {
	OsTopbarActionsTargetContext,
	OsTopbarMenuContext,
} from "@/components/os-topbar-actions-context";
import {
	DotsThree,
	List,
	MagnifyingGlass,
	SquaresFour,
} from "@phosphor-icons/react";
import { useMediaQuery } from "@/lib/use-media-query";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "@/components/kumo/dropdown-menu";
import { Outlet, useRouterState } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Button } from "@/components/kumo/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/kumo/dialog";
import {
	isOsShellNavigationItemActive,
	OS_SHELL_NAVIGATION_SECTIONS,
	OS_SHELL_PRIMARY_NAVIGATION,
	type OsShellNavigationItem,
} from "@/lib/os-shell-navigation";
import { resolveOsTenant } from "@/shared/os-tenant";
import { OsShellBreadcrumbs } from "@/components/os-shell-breadcrumbs";
import { OsAccountMenu } from "@/components/os-account-menu";
import { SampleDataBadge } from "@/components/sample-data-badge";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarProvider,
	useSidebar,
} from "@/components/kumo/sidebar";
import { ApprovalNotifications } from "@/components/approval-notifications";
import { OsQuickChat } from "@/components/os-quick-chat";
import { OsOrganizationIdentity } from "@/components/os-organization-identity";
import { OsWorkspaceSwitcher } from "@/components/os-workspace-switcher";
import { TransportStatus } from "@/components/transport-status";
import { WorkNeedsYouCount } from "@/components/work-needs-you-count";
import { SupportGetHelp } from "@/components/support-get-help";
import { shouldUseWorkspaceWorkbench } from "@/lib/os-layout-routing";
import { SURFACE_ICONS } from "@/lib/surface-icons";
import { useOsIdentity } from "@/lib/use-os-identity";
import type { OsIdentity } from "@/lib/use-os-identity";
import {
	useOsDurableTheme,
	useOsOrganizationTheme,
} from "@/lib/use-os-preferences";

const OsCommandPalette = lazy(() =>
	import("@/components/os-command-palette").then((module) => ({
		default: module.OsCommandPalette,
	})),
);

const SIDEBAR_COLLAPSED_KEY = "tedix-os-sidebar-collapsed";

function navigationIcon(item: OsShellNavigationItem) {
	return item.id === "workspaces" ? SquaresFour : SURFACE_ICONS[item.id];
}

/**
 * Kumo keeps the mobile sheet open across a client navigation; the shell has
 * always dismissed it, so re-assert that here rather than wiring an onClick
 * through every nav row.
 */
function CloseMobileNavigationOnNavigate() {
	const { isMobile, setOpenMobile } = useSidebar();
	const href = useRouterState({ select: (state) => state.location.href });
	const previousHref = useRef(href);

	useEffect(() => {
		if (isMobile && previousHref.current !== href) setOpenMobile(false);
		previousHref.current = href;
	}, [href, isMobile, setOpenMobile]);

	return null;
}

function SidebarKeyboardShortcut() {
	const { toggleSidebar } = useSidebar();
	useEffect(() => {
		const toggle = (event: KeyboardEvent) => {
			if (
				event.defaultPrevented ||
				event.repeat ||
				event.altKey ||
				event.shiftKey ||
				!(event.metaKey || event.ctrlKey) ||
				event.key.toLowerCase() !== "b" ||
				event
					.composedPath()
					.some(
						(node) =>
							node instanceof Element &&
							node.matches(
								"input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=textbox]",
							),
					)
			)
				return;
			event.preventDefault();
			toggleSidebar();
		};
		window.addEventListener("keydown", toggle);
		return () => window.removeEventListener("keydown", toggle);
	}, [toggleSidebar]);
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
			{item.id === "work" ? <WorkNeedsYouCount /> : null}
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
					<OsOrganizationIdentity fallbackLabel={tenantLabel} />
				</OsWorkspaceSwitcher>
			</SidebarHeader>

			<SidebarGroup className="shrink-0 px-2 pb-2 coarse:group-data-[state=collapsed]/sidebar:px-1">
				{collapsed ? null : (
					<Button
						className="mx-0 my-2 flex !h-8 w-full items-center gap-2 whitespace-nowrap rounded-lg border border-transparent bg-kumo-base px-3 text-left text-kumo-subtle transition-colors hover:border-kumo-hairline hover:bg-kumo-tint hover:text-kumo-default coarse:min-h-11"
						onClick={onOpenPalette}
						size="sm"
						variant="ghost"
					>
						<MagnifyingGlass size={16} />
						<span>Quick search…</span>
						<Kbd className="ml-auto">⌘K</Kbd>
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
					<SidebarGroup
						key={section.label}
						className="border-t border-kumo-line pt-2"
					>
						<SidebarGroup>
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
					</SidebarGroup>
				))}
			</SidebarContent>

			<SidebarFooter className="h-auto flex-col gap-1 py-2 group-data-[state=collapsed]/sidebar:px-2 coarse:group-data-[state=collapsed]/sidebar:px-1">
				<OsAccountMenu identity={identity} />
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
				aria-keyshortcuts="Meta+K Control+K"
				onClick={onOpenPalette}
				size="icon-sm"
				title="Search (⌘/Ctrl+K)"
				variant="outline"
			>
				<MagnifyingGlass size={15} />
			</Button>
		);
	}

	return (
		<Button
			aria-label="Search"
			aria-keyshortcuts="Meta+K Control+K"
			onClick={onOpenPalette}
			size="sm"
			title="Search (⌘/Ctrl+K)"
			variant="outline"
		>
			<MagnifyingGlass size={15} />
			<span>Search</span>
			<Kbd>⌘K</Kbd>
		</Button>
	);
}

/** Only the mobile sheet needs a hamburger; the rail owns its own trigger. */
function MobileNavigationTrigger() {
	const { isMobile, openMobile, toggleSidebar } = useSidebar();
	if (!isMobile) return null;
	return (
		<Button
			aria-label="Toggle navigation"
			aria-expanded={openMobile}
			aria-keyshortcuts="Meta+B Control+B"
			data-sidebar="trigger"
			onClick={toggleSidebar}
			size="icon-sm"
			variant="ghost"
			title="Toggle navigation"
		>
			<List size={18} />
		</Button>
	);
}

export function OsShell() {
	useOsLocale();
	const phone = useMediaQuery("(max-width: 819px)");
	const overflowTrigger = useRef<HTMLButtonElement>(null);
	const [menuActions, setMenuActions] = useState<HTMLDivElement | null>(null);
	const [paletteOpen, setPaletteOpen] = useState(false);
	const [topbarActions, setTopbarActions] = useState<HTMLDivElement | null>(
		null,
	);
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
	const tenantLabel =
		tenant.kind === "local"
			? tenant.slug || "Local workspace"
			: tenant.kind === "tenant"
				? tenant.slug
				: "Tedix";
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
		<OsTopbarMenuContext.Provider
			value={
				phone && !workspaceWorkbench
					? { target: menuActions, anchor: overflowTrigger }
					: null
			}
		>
			<DropdownMenu>
				<SidebarProvider
					className="os-shell"
					collapsedStorageKey={SIDEBAR_COLLAPSED_KEY}
					widthStorageKey="tedix-os-sidebar-width"
					resizable
					peekable
				>
					<CloseMobileNavigationOnNavigate />
					{workspaceWorkbench ? null : <SidebarKeyboardShortcut />}
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
									<OsShellBreadcrumbs pathname={pathname} />
								</div>
								<div className="topbar-actions">
									{phone ? null : (
										<>
											<div
												ref={setTopbarActions}
												className="flex shrink-0 items-center empty:hidden"
											/>
											<SampleDataBadge />
										</>
									)}
									<SupportGetHelp organization={tenantLabel} />
									<ApprovalNotifications topbar />
									<TopbarSearch onOpenPalette={() => setPaletteOpen(true)} />
									{phone ? (
										<>
											<DropdownMenuTrigger
												render={
													<Button
														ref={overflowTrigger}
														aria-label="More options"
														size="icon"
														variant="ghost"
													>
														<DotsThree size={20} />
													</Button>
												}
											/>
											<DropdownMenuContent align="end">
												<div ref={setTopbarActions} className="flex flex-col" />
												<div ref={setMenuActions} className="flex flex-col" />
												<SampleDataBadge />
												<TransportStatus />
											</DropdownMenuContent>
										</>
									) : (
										<TransportStatus />
									)}
								</div>
							</header>
						)}
						<main className="route-content">
							<OsTopbarActionsTargetContext.Provider value={topbarActions}>
								<WorkActorDirectory>
									<OsSettingsFrame pathname={pathname}>
										<Outlet />
									</OsSettingsFrame>
								</WorkActorDirectory>
							</OsTopbarActionsTargetContext.Provider>
						</main>
					</div>
					{paletteOpen ? (
						<Suspense fallback={null}>
							<OsCommandPalette
								open={paletteOpen}
								onOpenChange={setPaletteOpen}
							/>
						</Suspense>
					) : null}
					<OsQuickChat />
					<Dialog
						open={setupPromptOpen}
						onOpenChange={(open) => !open && closeSetupPrompt()}
					>
						<DialogContent>
							<DialogHeader>
								<DialogTitle>Set up Tedix on this device</DialogTitle>
								<DialogDescription>
									Install the Tedix CLI, then choose the Codex or Claude Code
									plugin for its skills and optional session hook. Each host
									will ask you to review its own connection and hook
									permissions.
								</DialogDescription>
							</DialogHeader>
							<p className="text-kumo-subtle type-tedix-label">
								Your browser cannot run a local installer. The setup guide gives
								you commands to copy into your terminal and the steps to verify
								the connection.
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
			</DropdownMenu>
		</OsTopbarMenuContext.Provider>
	);
}
