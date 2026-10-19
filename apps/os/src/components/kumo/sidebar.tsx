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
	SidebarLoading as KumoSidebarLoading,
	SidebarMenu as KumoSidebarMenu,
	SidebarMenuButton as KumoSidebarMenuButton,
	type SidebarMenuButtonProps as KumoSidebarMenuButtonProps,
	SidebarMenuChevron as KumoSidebarMenuChevron,
	SidebarMenuItem as KumoSidebarMenuItem,
	SidebarMenuSub as KumoSidebarMenuSub,
	SidebarMenuSubButton as KumoSidebarMenuSubButton,
	SidebarProvider as KumoSidebarProvider,
	type SidebarProviderProps as KumoSidebarProviderProps,
	SidebarResizeHandle as KumoSidebarResizeHandle,
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
	useEffect,
	useState,
	useSyncExternalStore,
} from "react";

import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

/**
 * Tedix OS application shell rail.
 *
 * The shell used to hand-roll the rail in bare `aside`/`nav`/`div` markup with
 * ~480 lines of BEM CSS: collapse persistence, a mobile drawer and scrim,
 * icon-only collapsed rows, collapsed-row tooltips, and the expandable sub-nav
 * groups. Kumo's `Sidebar` owns every one of those behaviours, so this adapter
 * exists only to hold the OS geometry contract on top of it.
 *
 * Geometry: 220–360px rail (260px default) / 56px collapsed rail, 56px header, 52px footer, 44px
 * nav rows on an 8px radius with `0 12px` padding and an 8px icon gap, 13px/500
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
const OS_SIDEBAR_DEFAULT_WIDTH = 260;
const OS_SIDEBAR_MIN_WIDTH = 220;
const OS_SIDEBAR_MAX_WIDTH = 360;
const OS_SIDEBAR_GEOMETRY = {
	"--sidebar-width-icon": "56px",
} as CSSProperties;

/**
 * Kumo resolves `isMobile` internally, but the provider needs the answer one
 * level higher: in controlled mode Kumo maps a single `open` prop onto the
 * desktop rail AND the mobile sheet, so without this the persisted collapse
 * preference would open the drawer on load and every drawer toggle would
 * rewrite the operator's desktop preference. Mirrors Kumo's own query exactly.
 */
function useMediaQuery(query: string): boolean {
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

function readWidth(storageKey: string | undefined): number {
	try {
		const value = storageKey ? Number(localStorage.getItem(storageKey)) : NaN;
		if (
			Number.isFinite(value) &&
			value >= OS_SIDEBAR_MIN_WIDTH &&
			value <= OS_SIDEBAR_MAX_WIDTH
		)
			return value;
	} catch {
		// Persistence is best-effort.
	}
	return OS_SIDEBAR_DEFAULT_WIDTH;
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
	widthStorageKey?: string;
}

function SidebarProvider({
	className,
	collapsedStorageKey,
	widthStorageKey,
	children,
	resizable = false,
	peekable = false,
	collapsible = "icon",
	defaultOpen = true,
	mobileBreakpoint = OS_SIDEBAR_MOBILE_BREAKPOINT,
	style,
	...props
}: SidebarProviderProps) {
	const isMobile = useMediaQuery(`(max-width: ${mobileBreakpoint - 1}px)`);
	const finePointer = useMediaQuery("(hover: hover) and (pointer: fine)");
	const [initialWidth] = useState(() => readWidth(widthStorageKey));
	const [expanded, setExpanded] = useState(() =>
		collapsedStorageKey ? !readCollapsed(collapsedStorageKey) : defaultOpen,
	);
	const [sheetOpen, setSheetOpen] = useState(false);

	const handleOpenChange = useCallback(
		(next: boolean) => {
			// Kumo retains callbacks until its context state changes. Read the
			// viewport at invocation so breakpoint changes cannot persist sheet state.
			if (window.matchMedia(`(max-width: ${mobileBreakpoint - 1}px)`).matches) {
				setSheetOpen(next);
				return;
			}
			setExpanded(next);
			writeCollapsed(collapsedStorageKey, !next);
		},
		[collapsedStorageKey, mobileBreakpoint],
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
			resizable={resizable && !isMobile}
			defaultWidth={initialWidth}
			minWidth={OS_SIDEBAR_MIN_WIDTH}
			maxWidth={OS_SIDEBAR_MAX_WIDTH}
			peekable={peekable && finePointer && !isMobile}
			onWidthChange={(width) => {
				try {
					if (widthStorageKey)
						localStorage.setItem(widthStorageKey, String(width));
				} catch {
					// Persistence is best-effort.
				}
			}}
			style={{
				...OS_SIDEBAR_GEOMETRY,
				...(!resizable || isMobile ? { "--sidebar-width": "260px" } : {}),
				...style,
			}}
			{...props}
		>
			{children}
		</KumoSidebarProvider>
	);
}

function Sidebar({
	className,
	contentClassName,
	...props
}: KumoSidebarRootProps) {
	const { stopPeek, isMobile } = useSidebar();
	useEffect(() => {
		const escape = (event: KeyboardEvent) => {
			if (event.key === "Escape") stopPeek();
		};
		document.addEventListener("keydown", escape);
		return () => document.removeEventListener("keydown", escape);
	}, [stopPeek]);
	return (
		<KumoSidebarRoot
			className={cn("shrink-0", className)}
			// Console separates the rail with a hairline, not Kumo's heavier line.
			contentClassName={cn(
				"border-kumo-hairline group-data-[state=peeking]/sidebar:delay-150 group-data-[state=peeking]/sidebar:shadow-tedix-overlay",
				contentClassName,
			)}
			{...props}
		>
			{props.children}
			{!isMobile && <SidebarResizeHandle />}
		</KumoSidebarRoot>
	);
}

function SidebarResizeHandle() {
	const { width, minWidth, maxWidth, setWidth, setOpen, open, side } =
		useSidebar();
	return (
		<KumoSidebarResizeHandle
			role="separator"
			aria-orientation="vertical"
			aria-valuemin={minWidth}
			aria-valuemax={maxWidth}
			aria-valuenow={width}
			className="z-50"
			onDoubleClick={() => setWidth(OS_SIDEBAR_DEFAULT_WIDTH)}
			onKeyDown={(event) => {
				const grow = side === "left" ? "ArrowRight" : "ArrowLeft";
				const shrink = side === "left" ? "ArrowLeft" : "ArrowRight";
				if (![grow, shrink, "Home", "End"].includes(event.key)) return;
				event.preventDefault();
				setOpen(true);
				setWidth(
					event.key === "Home"
						? minWidth
						: event.key === "End"
							? maxWidth
							: !open
								? minWidth
								: width + (event.key === grow ? 10 : -10),
				);
			}}
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
 *
 * Kumo fades the first 24px of a scrolled viewport. The OS pins its primary
 * rows directly above this area with no top padding, so that fade made the
 * row scrolled under them look half-hidden behind the last pinned row. Only
 * the bottom edge fades here; a scrolled-away top shows a hairline instead.
 */
function SidebarContent({
	className,
	...props
}: ComponentProps<typeof KumoSidebarContent>) {
	return (
		<KumoSidebarContent
			className={cn(
				"[&_[data-sidebar=viewport]]:px-2! [&_[data-sidebar=viewport]]:pt-0! [&_[data-sidebar=viewport]]:pb-2!",
				"coarse:group-data-[state=collapsed]/sidebar:[&_[data-sidebar=viewport]]:px-1!",
				"[&_[data-sidebar=viewport]]:[mask-image:linear-gradient(to_bottom,black_calc(100%-min(24px,var(--scroll-area-overflow-y-end,24px))),transparent_100%)]!",
				"before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:z-10 before:h-px before:bg-kumo-hairline before:opacity-0 data-[overflow-y-start]:before:opacity-100",
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
				"h-13 gap-2 border-kumo-hairline px-2 group-not-data-[state=collapsed]/sidebar:px-2",
				"group-data-[state=collapsed]/sidebar:h-auto group-data-[state=collapsed]/sidebar:flex-col group-data-[state=collapsed]/sidebar:gap-2 group-data-[state=collapsed]/sidebar:border-kumo-hairline group-data-[state=collapsed]/sidebar:py-2",
				"coarse:group-data-[state=collapsed]/sidebar:px-1",
				className,
			)}
			{...props}
		/>
	);
}

// Kumo recognizes the footer by displayName and keeps it outside the peek zone.
SidebarFooter.displayName = "Sidebar.Footer";

function SidebarLoading({
	className,
	...props
}: ComponentProps<typeof KumoSidebarLoading>) {
	return (
		<KumoSidebarLoading
			className={cn(
				"flex-none px-0 py-2 [&>div>div:not(.skeleton-line)]:min-h-11 [&>div>div:not(.skeleton-line)]:gap-2 [&>div>div>.skeleton-line:first-child]:size-4",
				className,
			)}
			{...props}
		/>
	);
}

const SidebarGroup = KumoSidebarGroup;

/** Section label: 13px/500 muted, 12px inset, 16px above / 4px below. */
function SidebarGroupLabel({
	className,
	...props
}: ComponentProps<typeof KumoSidebarGroupLabel>) {
	return (
		<KumoSidebarGroupLabel
			className={cn(
				"border-kumo-hairline [&>div>div]:mt-4 [&>div>div]:mb-1 [&>div>div]:px-3 [&>div>div]:text-tedix-control",
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
 * 44px nav row, 8px radius, `0 12px` padding, 8px icon gap, 13px/500 type.
 *
 * Kumo paints hover and selection from one `--sidebar-active-bg` token; the OS
 * separates them (hover on the neutral tint step, selection on the solid
 * `--secondary` control step), so the row rebinds the token on `data-active`
 * instead of fighting Kumo's own background rule in the cascade.
 *
 * Hide the collapsed label explicitly; width-based clipping leaks text when
 * icon geometry changes. Keep the name available before its tooltip opens.
 */
function SidebarMenuButton({
	className,
	icon: Icon,
	...props
}: SidebarMenuButtonProps) {
	return (
		<KumoSidebarMenuButton
			aria-label={
				props["aria-label"] ??
				(typeof props.tooltip === "string" ? props.tooltip : undefined)
			}
			className={cn(
				"min-h-11 type-tedix-control font-medium focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-kumo-focus",
				"[--sidebar-active-bg:var(--color-kumo-tint)] data-[active]:[--sidebar-active-bg:var(--color-kumo-control)]",
				// Kumo's tooltip trigger stamps `cursor-default` even while the
				// tooltip is disabled (expanded rail); a nav row is always a link.
				"cursor-pointer!",
				"[&>div]:translate-x-0 [&>div]:gap-2",
				"group-data-[state=collapsed]/sidebar:px-0 group-data-[state=collapsed]/sidebar:[&>div]:justify-center group-data-[state=collapsed]/sidebar:[&>div>span:last-child]:hidden",
				className,
			)}
			icon={
				isValidElement(Icon) ? (
					Icon
				) : Icon ? (
					<Icon
						className="size-4 shrink-0 text-kumo-subtle transition-colors group-data-[active]/menu-button:text-kumo-brand"
						size={16}
					/>
				) : undefined
			}
			{...props}
		/>
	);
}

const SidebarMenuSub = KumoSidebarMenuSub;

/** Indented child row. Same 44px rhythm as a top-level row. */
function SidebarMenuSubButton({
	className,
	...props
}: ComponentProps<typeof KumoSidebarMenuSubButton>) {
	return (
		<KumoSidebarMenuSubButton
			className={cn(
				"min-h-11 type-tedix-control font-medium focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-kumo-focus",
				"[--sidebar-active-bg:var(--color-kumo-tint)] data-[active]:[--sidebar-active-bg:var(--color-kumo-control)]",
				className,
			)}
			{...props}
		/>
	);
}

/** 28px desktop ghost affordance with the shared 44px mobile touch floor. */
function SidebarTrigger({
	className,
	title,
	...props
}: ComponentProps<typeof KumoSidebarTrigger>) {
	const { state } = useSidebar();
	const label =
		props["aria-label"] ??
		(state === "collapsed" ? "Expand sidebar" : "Collapse sidebar");
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<KumoSidebarTrigger
						aria-keyshortcuts="Meta+B Control+B"
						className={cn(
							"size-7 rounded-md text-kumo-subtle max-sm:size-11 coarse:size-11",
							className,
						)}
						{...props}
					/>
				}
			/>
			<TooltipContent>{title ?? label} (⌘/Ctrl+B)</TooltipContent>
		</Tooltip>
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
	SidebarLoading,
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
