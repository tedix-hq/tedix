"use client";

import {
	SidebarCollapsible as KumoSidebarCollapsible,
	SidebarCollapsibleContent as KumoSidebarCollapsibleContent,
	SidebarCollapsibleTrigger as KumoSidebarCollapsibleTrigger,
	SidebarContent as KumoSidebarContent,
	SidebarFooter as KumoSidebarFooter,
	SidebarGroup as KumoSidebarGroup,
	SidebarGroupLabel as KumoSidebarGroupLabel,
	SidebarHeader as KumoSidebarHeader,
	SidebarMenu as KumoSidebarMenu,
	SidebarMenuButton as KumoSidebarMenuButton,
	type SidebarMenuButtonProps as KumoSidebarMenuButtonProps,
	SidebarMenuChevron as KumoSidebarMenuChevron,
	SidebarMenuItem as KumoSidebarMenuItem,
	SidebarMenuSub as KumoSidebarMenuSub,
	SidebarMenuSubButton as KumoSidebarMenuSubButton,
	SidebarProvider as KumoSidebarProvider,
	type SidebarProviderProps as KumoSidebarProviderProps,
	SidebarRoot as KumoSidebarRoot,
	type SidebarRootProps as KumoSidebarRootProps,
	SidebarTrigger as KumoSidebarTrigger,
	useSidebar,
} from "@cloudflare/kumo/components/sidebar";
import {
	type ComponentProps,
	type ComponentType,
	type CSSProperties,
	isValidElement,
	type ReactElement,
	useCallback,
	useState,
	useSyncExternalStore,
} from "react";

import { cn } from "@/lib/utils";

/**
 * Tedix OS application shell rail.
 *
 * The shell used to hand-roll the rail in bare `aside`/`nav`/`div` markup with
 * ~480 lines of BEM CSS: collapse persistence, a mobile drawer and scrim,
 * icon-only collapsed rows, collapsed-row tooltips, and the expandable sub-nav
 * groups. Kumo's `Sidebar` owns every one of those behaviours, so this adapter
 * exists only to hold the OS geometry contract on top of it.
 *
 * That geometry is deliberate and matched against the authenticated Cloudflare
 * Console — 260px rail / 56px collapsed rail, 56px header, 52px footer, 34px
 * nav rows on an 8px radius with `0 12px` padding and a 10px icon gap, 13px/500
 * `type-tedix-control` type, the selected row painted with the solid
 * `--secondary` control step (Kumo paints hover and selection from one token,
 * so the OS rebinds `--sidebar-active-bg` per row state), and a 32px filled
 * search chip on `--card`.
 *
 * Touch floors cover both the documented 390px product viewport (`max-sm:`)
 * and coarse pointers at any width. The narrow-layout rule keeps responsive
 * browser validation deterministic; the capability rule still protects touch
 * laptops and tablets above the small breakpoint.
 */

/** Below this viewport width the rail renders as Kumo's mobile dialog sheet. */
const OS_SIDEBAR_MOBILE_BREAKPOINT = 820;

/** 260px rail / 56px collapsed rail. Kumo defaults to 16.25rem / 57px. */
const OS_SIDEBAR_GEOMETRY = {
	"--sidebar-width": "260px",
	"--sidebar-width-icon": "56px",
} as CSSProperties;

/**
 * Kumo resolves `isMobile` internally, but the provider needs the answer one
 * level higher: in controlled mode Kumo maps a single `open` prop onto the
 * desktop rail AND the mobile sheet, so without this the persisted collapse
 * preference would open the drawer on load and every drawer toggle would
 * rewrite the operator's desktop preference. Mirrors Kumo's own query exactly.
 */
function useIsMobileViewport(breakpoint: number): boolean {
	const query = `(max-width: ${breakpoint - 1}px)`;
	return useSyncExternalStore(
		useCallback(
			(onChange: () => void) => {
				const list = window.matchMedia(query);
				list.addEventListener("change", onChange);
				return () => list.removeEventListener("change", onChange);
			},
			[query],
		),
		useCallback(() => window.matchMedia(query).matches, [query]),
		useCallback(() => false, []),
	);
}

function readCollapsed(storageKey: string | undefined): boolean {
	if (!storageKey) return false;
	try {
		return localStorage.getItem(storageKey) === "1";
	} catch {
		return false;
	}
}

function writeCollapsed(storageKey: string | undefined, collapsed: boolean) {
	if (!storageKey) return;
	try {
		localStorage.setItem(storageKey, collapsed ? "1" : "0");
	} catch {
		// Persistence is best-effort.
	}
}

interface SidebarProviderProps extends Omit<
	KumoSidebarProviderProps,
	"open" | "onOpenChange"
> {
	/**
	 * `localStorage` key holding the collapsed desktop rail. Only the DESKTOP
	 * rail is persisted; the mobile sheet is transient by definition.
	 */
	collapsedStorageKey?: string;
}

function SidebarProvider({
	className,
	collapsedStorageKey,
	collapsible = "icon",
	defaultOpen = true,
	mobileBreakpoint = OS_SIDEBAR_MOBILE_BREAKPOINT,
	style,
	...props
}: SidebarProviderProps) {
	const isMobile = useIsMobileViewport(mobileBreakpoint);
	const [expanded, setExpanded] = useState(() =>
		collapsedStorageKey ? !readCollapsed(collapsedStorageKey) : defaultOpen,
	);
	const [sheetOpen, setSheetOpen] = useState(false);

	const handleOpenChange = useCallback(
		(next: boolean) => {
			if (isMobile) {
				setSheetOpen(next);
				return;
			}
			setExpanded(next);
			writeCollapsed(collapsedStorageKey, !next);
		},
		[collapsedStorageKey, isMobile],
	);

	return (
		<KumoSidebarProvider
			className={cn(
				// The rail sits on the elevated shell step, not Kumo's card surface.
				"h-(--viewport-tedix-height) min-h-0 overflow-hidden bg-kumo-canvas [--sidebar-bg:var(--color-kumo-elevated)]",
				className,
			)}
			collapsible={collapsible}
			mobileBreakpoint={mobileBreakpoint}
			onOpenChange={handleOpenChange}
			open={isMobile ? sheetOpen : expanded}
			style={{ ...OS_SIDEBAR_GEOMETRY, ...style }}
			{...props}
		/>
	);
}

function Sidebar({
	className,
	contentClassName,
	...props
}: KumoSidebarRootProps) {
	return (
		<KumoSidebarRoot
			className={cn("shrink-0", className)}
			// Console separates the rail with a hairline, not Kumo's heavier line.
			contentClassName={cn("border-kumo-hairline", contentClassName)}
			{...props}
		/>
	);
}

/** 56px brand row: 8px gap, 16px gutter. */
function SidebarHeader({
	className,
	...props
}: ComponentProps<typeof KumoSidebarHeader>) {
	return (
		<KumoSidebarHeader
			className={cn(
				"h-14 gap-2 border-kumo-hairline px-4 group-data-[state=collapsed]/sidebar:justify-center group-data-[state=collapsed]/sidebar:px-0",
				className,
			)}
			{...props}
		/>
	);
}

/**
 * The nav gutter is 8px, matching the 12px row padding to a 20px text inset.
 * Kumo's viewport padding is a compound `group-not-data-*` rule, so the
 * override has to be important rather than merely later.
 */
function SidebarContent({
	className,
	...props
}: ComponentProps<typeof KumoSidebarContent>) {
	return (
		<KumoSidebarContent
			className={cn(
				"[&_[data-sidebar=viewport]]:px-2! [&_[data-sidebar=viewport]]:pt-0! [&_[data-sidebar=viewport]]:pb-1.5!",
				className,
			)}
			{...props}
		/>
	);
}

/** 52px footer row. Collapsed, the footer actions stack inside the 56px rail. */
function SidebarFooter({
	className,
	...props
}: ComponentProps<typeof KumoSidebarFooter>) {
	return (
		<KumoSidebarFooter
			className={cn(
				"h-13 gap-1 border-kumo-hairline px-2.5 group-not-data-[state=collapsed]/sidebar:px-2.5",
				"group-data-[state=collapsed]/sidebar:h-auto group-data-[state=collapsed]/sidebar:flex-col group-data-[state=collapsed]/sidebar:gap-1.5 group-data-[state=collapsed]/sidebar:border-kumo-hairline group-data-[state=collapsed]/sidebar:py-2.5",
				className,
			)}
			{...props}
		/>
	);
}

const SidebarGroup = KumoSidebarGroup;

/** Section label: 13px/500 muted, 14px inset, 14px above / 4px below. */
function SidebarGroupLabel({
	className,
	...props
}: ComponentProps<typeof KumoSidebarGroupLabel>) {
	return (
		<KumoSidebarGroupLabel
			className={cn(
				"border-kumo-hairline [&>div>div]:mt-3.5 [&>div>div]:mb-1 [&>div>div]:px-3.5 [&>div>div]:text-tedix-control",
				className,
			)}
			{...props}
		/>
	);
}

const SidebarMenu = KumoSidebarMenu;
const SidebarMenuItem = KumoSidebarMenuItem;
const SidebarMenuChevron = KumoSidebarMenuChevron;
const SidebarCollapsible = KumoSidebarCollapsible;
const SidebarCollapsibleTrigger = KumoSidebarCollapsibleTrigger;
const SidebarCollapsibleContent = KumoSidebarCollapsibleContent;

type SidebarIcon = ComponentType<{ className?: string; size?: number }>;

interface SidebarMenuButtonProps extends Omit<
	KumoSidebarMenuButtonProps,
	"icon"
> {
	/**
	 * Icon component, or a ready-made element for a row whose leading mark is
	 * not an icon (a workspace initials chip). Either way it lands in the icon
	 * slot, which is what keeps the collapsed rail icon-only — see below.
	 */
	icon?: SidebarIcon | ReactElement;
}

/**
 * 34px nav row, 8px radius, `0 12px` padding, 10px icon gap, 13px/500 type.
 *
 * Kumo paints hover and selection from one `--sidebar-active-bg` token; the OS
 * separates them (hover on the neutral tint step, selection on the solid
 * `--secondary` control step), so the row rebinds the token on `data-active`
 * instead of fighting Kumo's own background rule in the cascade.
 *
 * COLLAPSED RAIL. Kumo publishes no `display: none` for the label: its row is
 * `icon (shrink-0) + gap + label (flex-1 min-w-0 overflow-hidden)`, and the
 * collapsed rail is deliberately narrower than `icon + gap`, so the label is
 * squeezed to zero width and `tooltip` carries the name instead. That only
 * holds while the row's content box stays no wider than the icon, so the
 * collapsed padding below is load-bearing, not cosmetic: 56px rail − 2×8px
 * viewport gutter = a 40px row, minus 2×13px = a 14px content box, exactly the
 * icon. It also centres the icon (8 + 13 + 7 = 28 = half the rail), which is
 * why Kumo's own −3px nudge — tuned for its 57px rail and 16px icon — is
 * dropped rather than inherited. Do NOT give the row `px-0` when collapsed: it
 * hands the label ~8px back and the rail renders "W..", "C..", "B..".
 */
function SidebarMenuButton({
	className,
	icon: Icon,
	...props
}: SidebarMenuButtonProps) {
	return (
		<KumoSidebarMenuButton
			className={cn(
				"type-tedix-control font-medium",
				"[--sidebar-active-bg:var(--color-kumo-tint)] data-[active]:[--sidebar-active-bg:var(--color-kumo-control)]",
				// Kumo's tooltip trigger stamps `cursor-default` even while the
				// tooltip is disabled (expanded rail); a nav row is always a link.
				"cursor-pointer!",
				// 10px icon gap; the collapsed nudge is replaced by the padding below.
				"[&>div]:translate-x-0 [&>div]:gap-2.5",
				"group-data-[state=collapsed]/sidebar:px-[13px]",
				"coarse:min-h-11",
				className,
			)}
			icon={
				isValidElement(Icon) ? (
					Icon
				) : Icon ? (
					<Icon
						className="size-3.5 shrink-0 text-kumo-subtle transition-colors group-data-[active]/menu-button:text-kumo-brand"
						size={14}
					/>
				) : undefined
			}
			{...props}
		/>
	);
}

const SidebarMenuSub = KumoSidebarMenuSub;

/** Indented child row. Same 34px rhythm as a top-level row, without an icon. */
function SidebarMenuSubButton({
	className,
	...props
}: ComponentProps<typeof KumoSidebarMenuSubButton>) {
	return (
		<KumoSidebarMenuSubButton
			className={cn(
				"type-tedix-control font-medium",
				"[--sidebar-active-bg:var(--color-kumo-tint)] data-[active]:[--sidebar-active-bg:var(--color-kumo-control)]",
				"coarse:min-h-11",
				className,
			)}
			{...props}
		/>
	);
}

/** 28px desktop ghost affordance with the shared 44px mobile touch floor. */
function SidebarTrigger({
	className,
	...props
}: ComponentProps<typeof KumoSidebarTrigger>) {
	return (
		<KumoSidebarTrigger
			className={cn(
				"size-7 rounded-md text-kumo-subtle max-sm:size-11 coarse:size-11",
				className,
			)}
			{...props}
		/>
	);
}

export {
	OS_SIDEBAR_MOBILE_BREAKPOINT,
	Sidebar,
	SidebarCollapsible,
	SidebarCollapsibleContent,
	SidebarCollapsibleTrigger,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	type SidebarMenuButtonProps,
	SidebarMenuChevron,
	SidebarMenuItem,
	SidebarMenuSub,
	SidebarMenuSubButton,
	SidebarProvider,
	type SidebarProviderProps,
	SidebarTrigger,
	useSidebar,
};
