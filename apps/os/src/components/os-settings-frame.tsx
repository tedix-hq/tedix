import {
	useEffect,
	useRef,
	type ComponentType,
	type CSSProperties,
	type ReactNode,
} from "react";
import { useRouter } from "@tanstack/react-router";
import {
	Buildings,
	CaretDown,
	CreditCard,
	GearSix,
	Key,
	PlugsConnected,
	UserCircle,
} from "@phosphor-icons/react";
import { canAccessAdminSection } from "@/components/admin-layout";
import { Button } from "@/components/kumo/button";
import {
	Sidebar,
	SidebarContent,
	SidebarGroup,
	SidebarGroupLabel,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarMenuSub,
	SidebarMenuSubButton,
	SidebarProvider,
	useSidebar,
} from "@/components/kumo/sidebar";
import { getOsSurface, OS_SETTINGS_NAVIGATION } from "@/lib/os-navigation";
import { SURFACE_ICONS } from "@/lib/surface-icons";
import { useOsOperationalContext } from "@/lib/use-os-preferences";
import { OS_COPY } from "@/shared/os-copy";

type SettingsItem = {
	path: string;
	label: string;
	icon: ComponentType<{ className?: string; size?: number }>;
};
type SettingsGroup = { label: string; items: SettingsItem[] };

/**
 * The rail sits on the base surface, where the shell's solid control step is
 * near-invisible and close to the hover tint. Selection takes a brand wash
 * instead, so the current page never reads like a hovered row.
 */
const SELECTED_ROW =
	"data-[active]:[--sidebar-active-bg:color-mix(in_oklab,var(--color-kumo-brand)_14%,transparent)] data-[active]:text-kumo-strong";

function surfaceItem(id: "blueprints" | "widget" | "audit"): SettingsItem {
	const surface = getOsSurface(id);
	return { path: surface.path, label: surface.label, icon: SURFACE_ICONS[id] };
}

function settingsGroups({
	isAdmin,
	canManageBilling,
}: {
	isAdmin: boolean;
	canManageBilling: boolean;
}): SettingsGroup[] {
	const admin = (...items: SettingsItem[]) => (isAdmin ? items : []);
	return [
		{
			label: "Organization",
			items: [
				...admin(
					{ path: "/admin", label: OS_COPY.navigation.settings, icon: GearSix },
					{
						path: "/admin/organization",
						label: "Organization",
						icon: Buildings,
					},
				),
				surfaceItem("widget"),
				surfaceItem("blueprints"),
			],
		},
		{
			label: "Connections",
			items: [
				...admin({
					path: "/admin/connections",
					label: "Connected accounts",
					icon: PlugsConnected,
				}),
				{
					path: "/account/connections",
					label: "My accounts",
					icon: UserCircle,
				},
				...admin({ path: "/admin/api-keys", label: "API keys", icon: Key }),
			],
		},
		{
			label: "Billing",
			items: [
				{
					path: "/compute",
					label: OS_COPY.navigation.compute,
					icon: SURFACE_ICONS.compute,
				},
				...(canManageBilling
					? [{ path: "/admin/payments", label: "Payments", icon: CreditCard }]
					: []),
			],
		},
		{ label: "History", items: [surfaceItem("audit")] },
	];
}

/** Settings share their existing routes so saved links and read permissions survive. */
export function OsSettingsFrame({
	pathname,
	children,
}: {
	pathname: string;
	children: ReactNode;
}) {
	const context = useOsOperationalContext();
	const isAdmin = context.data?.authority
		? canAccessAdminSection(context.data.authority)
		: false;
	const canManageBilling =
		context.data?.authority.permissions.includes("billing:manage") ?? false;
	const isSettings =
		pathname === "/admin" ||
		pathname.startsWith("/admin/") ||
		OS_SETTINGS_NAVIGATION.some((item) => item.path === pathname);
	if (!isSettings) return children;
	const groups = settingsGroups({ isAdmin, canManageBilling });
	const usageActive = pathname === "/compute" || pathname === "/admin/billing";
	const active = groups
		.flatMap((group) => group.items)
		.find(
			(item) =>
				item.path === pathname || (item.path === "/compute" && usageActive),
		);
	return (
		// A second, contained Kumo sidebar: it scopes its own state so the shell
		// rail's collapse and phone sheet stay independent of this one.
		<SidebarProvider
			contained
			collapsible="offcanvas"
			mobileBreakpoint={768}
			className="h-auto min-h-0 flex-1 bg-transparent [--sidebar-bg:var(--color-kumo-base)]"
			style={{ "--sidebar-width": "240px" } as CSSProperties}
		>
			<SettingsNavigation
				activePath={active?.path}
				canManageBilling={canManageBilling}
				groups={groups}
				pathname={pathname}
			/>
			<div className="flex min-h-0 min-w-0 flex-1 flex-col">
				<SettingsMenuTrigger label={active?.label} />
				{/* Below md the menu row is already the one navigation row; a page's
				    own capability rail would stack a second strip under it. */}
				<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto max-md:[&_[data-capability-nav]]:hidden">
					{children}
				</div>
			</div>
		</SidebarProvider>
	);
}

function SettingsNavigation({
	activePath,
	canManageBilling,
	groups,
	pathname,
}: {
	activePath: string | undefined;
	canManageBilling: boolean;
	groups: SettingsGroup[];
	pathname: string;
}) {
	const router = useRouter();
	const { isMobile, setOpenMobile, scrollItemIntoView } = useSidebar();
	const previousPathname = useRef(pathname);
	const itemCount = groups.flatMap((group) => group.items).length;
	useEffect(() => {
		if (previousPathname.current !== pathname && isMobile) setOpenMobile(false);
		previousPathname.current = pathname;
	}, [pathname, isMobile, setOpenMobile]);
	useEffect(() => {
		if (!activePath) return;
		// Scrolls only the rail's own viewport, never the page around it.
		const reveal = () => scrollItemIntoView(activePath);
		// Authority reads can prepend links after the pathname commits.
		reveal();
		// Router history restoration runs onRendered and can overwrite the reveal.
		return router.subscribe("onRendered", () => queueMicrotask(reveal));
	}, [activePath, itemCount, router, scrollItemIntoView]);
	return (
		<Sidebar aria-label="Settings menu">
			<SidebarContent>
				<nav aria-label="Settings sections">
					{groups.map((group) =>
						group.items.length ? (
							<SidebarGroup key={group.label}>
								<SidebarGroupLabel>{group.label}</SidebarGroupLabel>
								<SidebarMenu>
									{group.items.map((item) => (
										<SidebarMenuItem key={item.path} itemId={item.path}>
											<SidebarMenuButton
												active={item.path === activePath}
												className={SELECTED_ROW}
												aria-current={
													item.path === activePath ? "page" : undefined
												}
												data-settings-active={
													item.path === activePath ? "" : undefined
												}
												href={item.path}
												icon={item.icon}
											>
												{item.label}
											</SidebarMenuButton>
											{item.path === "/compute" && activePath === "/compute" ? (
												<SidebarMenuSub>
													<SidebarMenuSubButton
														active={pathname === "/compute"}
														className={SELECTED_ROW}
														aria-current={
															pathname === "/compute" ? "page" : undefined
														}
														href="/compute"
													>
														{OS_COPY.navigation.usage}
													</SidebarMenuSubButton>
													{canManageBilling ? (
														<SidebarMenuSubButton
															active={pathname === "/admin/billing"}
															className={SELECTED_ROW}
															aria-current={
																pathname === "/admin/billing"
																	? "page"
																	: undefined
															}
															href="/admin/billing"
														>
															{OS_COPY.navigation.billing}
														</SidebarMenuSubButton>
													) : null}
												</SidebarMenuSub>
											) : null}
										</SidebarMenuItem>
									))}
								</SidebarMenu>
							</SidebarGroup>
						) : null,
					)}
				</nav>
			</SidebarContent>
		</Sidebar>
	);
}

/** Phone row that opens the settings sheet and names the current section. */
function SettingsMenuTrigger({ label }: { label: string | undefined }) {
	const { isMobile, openMobile, toggleSidebar } = useSidebar();
	if (!isMobile) return null;
	return (
		<div className="shrink-0 border-b border-kumo-hairline bg-kumo-base px-2 py-1">
			<Button
				aria-expanded={openMobile}
				className="min-h-11 w-full justify-start gap-2"
				data-settings-menu=""
				onClick={toggleSidebar}
				variant="ghost"
			>
				<GearSix aria-hidden className="size-4 text-kumo-subtle" size={16} />
				<span className="text-kumo-subtle">{OS_COPY.navigation.settings}</span>
				{label ? <span className="truncate">/ {label}</span> : null}
				<CaretDown aria-hidden className="ml-auto size-4" size={16} />
			</Button>
		</div>
	);
}
