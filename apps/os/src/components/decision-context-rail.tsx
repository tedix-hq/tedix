import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import {
	createContext,
	Fragment,
	useContext,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { InfoIcon, SlidersHorizontalIcon } from "@phosphor-icons/react";
import { OS_COPY } from "@/shared/os-copy";
import { Button } from "@/components/kumo/button";
import { Kbd } from "@/components/kumo/kbd";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
} from "@/components/kumo/sheet";
import { WorkToolbarTargetContext } from "@/components/deck-presentation-context";
import {
	OsTopbarActionsTargetContext,
	OsTopbarMenuContext,
} from "@/components/os-topbar-actions-context";
import { DropdownMenuItem } from "@/components/kumo/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/kumo/tooltip";
import {
	PopoverRoot,
	PopoverTrigger,
	PopoverContent,
} from "@/components/kumo/popover";
import {
	Select,
	SelectTrigger,
	SelectContent,
	SelectItem,
} from "@/components/kumo/select";
import { Combobox } from "@/components/kumo/combobox";
import { userProfileQueryOptions } from "@/lib/os-query-options";
import { isTypingEvent } from "@/lib/keyboard";

/** Card (>= 31rem) + gap + narrowest rail (20rem). */
const RAIL_INLINE_MIN_WIDTH = 880;

const RAIL_SECTIONS = [
	"why",
	"source",
	"feedback",
	"style",
	"details",
] as const;

export const DecisionRailContext = createContext<{
	target: HTMLDivElement | null;
	openSection: (id?: string) => void;
	openedBefore: (id: string) => boolean;
	open: boolean;
	phone: boolean;
	toggle: () => void;
	activeSection?: string;
	railId: string;
	surface: "deck" | "feed";
} | null>(null);

/** Shared app context: auxiliary information lives outside the decision column. */
export function DecisionContextRail({
	children,
	surface = "feed",
}: {
	children: ReactNode;
	surface?: "deck" | "feed";
}) {
	const topbarTarget = useContext(OsTopbarActionsTargetContext);
	const menu = useContext(OsTopbarMenuContext);
	const contextTrigger = useRef<HTMLButtonElement>(null);
	const contextId = useId();
	const profile = useQuery(userProfileQueryOptions());
	const key = profile.data?.id
		? `tedix:decision-context:${profile.data.id}`
		: null;
	const [open, setOpen] = useState(false);
	const [shortcutsOpen, setShortcutsOpen] = useState(false);
	const [phone, setPhone] = useState(false);
	const [desktop, setDesktop] = useState(false);
	const [frame, setFrame] = useState<HTMLDivElement | null>(null);
	const [target, setTarget] = useState<HTMLDivElement | null>(null);
	const [section, setSection] = useState<string>();
	const visited = useRef(new Set<string>());
	useEffect(() => {
		if (!key) return;
		try {
			setOpen(localStorage.getItem(key) === "open");
		} catch {
			setOpen(false);
		}
	}, [key]);
	useEffect(() => {
		const media = matchMedia("(max-width: 639px)");
		const update = () => setPhone(media.matches);
		update();
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, []);
	// The rail sits beside the card only when the Deck column has room for both;
	// otherwise it opens as a sheet. The frame width never depends on rail state.
	useLayoutEffect(() => {
		if (!frame) return;
		const update = () =>
			setDesktop(frame.getBoundingClientRect().width >= RAIL_INLINE_MIN_WIDTH);
		update();
		let pending = 0;
		const observer = new ResizeObserver(() => {
			cancelAnimationFrame(pending);
			pending = requestAnimationFrame(update);
		});
		observer.observe(frame);
		return () => {
			cancelAnimationFrame(pending);
			observer.disconnect();
		};
	}, [frame]);
	const changeOpen = (value: boolean) => {
		setOpen(value);
		if (!value) setSection(undefined);
		if (key)
			try {
				localStorage.setItem(key, value ? "open" : "closed");
			} catch {
				/* Browser storage may be disabled. */
			}
	};
	useEffect(() => {
		const shortcut = (event: KeyboardEvent) => {
			if (
				event.defaultPrevented ||
				shortcutsOpen ||
				(surface === "feed" && event.key === "?")
			)
				return;
			if (
				(event.key.toLowerCase() !== "i" &&
					event.key !== "?" &&
					!(event.key === "Escape" && desktop && open)) ||
				event.metaKey ||
				event.ctrlKey ||
				event.altKey ||
				isTypingEvent(event)
			)
				return;
			event.preventDefault();
			if (event.key === "?") {
				setShortcutsOpen(true);
			} else {
				changeOpen(event.key === "Escape" ? false : !open);
				if (event.key === "Escape") contextTrigger.current?.focus();
			}
		};
		document.addEventListener("keydown", shortcut);
		return () => document.removeEventListener("keydown", shortcut);
	}, [open, key, shortcutsOpen, surface, desktop]);
	useEffect(() => {
		if (!open || !target) return;
		const container = target.closest<HTMLElement>("[data-decision-context]");
		const node = section
			? target.querySelector<HTMLElement>(`[data-context-section="${section}"]`)
			: null;
		if (!container) return;
		if (node)
			container.scrollTop +=
				node.getBoundingClientRect().top -
				container.getBoundingClientRect().top -
				parseFloat(getComputedStyle(container).paddingTop);
		else container.scrollTop = 0;
	}, [open, section, target]);
	const shortcutGrid = (
		<div className="fd-shortcut-grid">
			{OS_COPY.feedDeckVisual.shortcutList.map(([key, label]) => (
				<Fragment key={key}>
					<Kbd>{key}</Kbd>
					<span>{label}</span>
				</Fragment>
			))}
		</div>
	);
	// One legend entry point for the whole Deck; cards carry no per-button hints.
	const shortcutHint = surface === "deck" && (
		<p className="fd-shortcut-hint">
			{OS_COPY.feedDeckVisual.shortcutHint[0]} <Kbd>?</Kbd>{" "}
			{OS_COPY.feedDeckVisual.shortcutHint[1]}
		</p>
	);
	const contents = (
		<div
			ref={setTarget}
			className="feed-deck fd-context-sections !rounded-none !bg-transparent !p-0"
		>
			{RAIL_SECTIONS.map((id) => (
				<div key={id} data-rail-slot={id} />
			))}
		</div>
	);
	const trigger = menu ? (
		<DropdownMenuItem onClick={() => changeOpen(true)}>
			<InfoIcon aria-hidden size={18} />
			Info
		</DropdownMenuItem>
	) : (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						ref={contextTrigger}
						variant="ghost"
						size="icon"
						aria-label="Decision context"
						aria-haspopup={desktop ? undefined : "dialog"}
						aria-expanded={open}
						aria-controls={open ? contextId : undefined}
						aria-keyshortcuts="I"
						onClick={() => changeOpen(!open)}
					/>
				}
			>
				<InfoIcon aria-hidden size={20} />
			</TooltipTrigger>
			<TooltipContent>Decision context (I)</TooltipContent>
		</Tooltip>
	);
	return (
		<DecisionRailContext.Provider
			value={{
				target,
				surface,
				open,
				phone,
				toggle: () => changeOpen(!open),
				activeSection: section,
				railId: contextId,
				openSection: (id) => {
					if (id === "shortcuts") {
						setShortcutsOpen(true);
						return;
					}
					setSection(id);
					changeOpen(true);
				},
				openedBefore: (id) => {
					if (open) visited.current.add(id);
					return visited.current.has(id);
				},
			}}
		>
			{topbarTarget
				? createPortal(trigger, topbarTarget)
				: menu
					? null
					: trigger}
			<div ref={setFrame} className="fd-context-frame">
				<div
					className="feed-deck fd-context-layout"
					data-context-open={open && desktop}
				>
					<div className="fd-context-main">{children}</div>
					{desktop && (
						<aside
							id={contextId}
							data-decision-context
							className="fd-context-rail"
							aria-label="Decision context"
							hidden={!open}
						>
							<div className="mb-8 flex items-center justify-between gap-2">
								<h2 className="type-tedix-section">Decision context</h2>
								<Button
									variant="ghost"
									size="sm"
									aria-label="Close decision context"
									onClick={() => changeOpen(false)}
								>
									Done
								</Button>
							</div>
							{contents}
							{shortcutHint}
						</aside>
					)}
				</div>
			</div>
			{!desktop && (
				<Sheet open={open} onOpenChange={changeOpen}>
					<SheetContent
						id={contextId}
						data-decision-context
						side={phone ? "bottom" : "right"}
						size="md"
						className={`gap-8 p-4 sm:p-6 ${phone ? "max-h-[80dvh] rounded-t-xl" : ""}`}
						showCloseButton={false}
						keepMounted
						finalFocus={menu?.anchor ?? contextTrigger}
					>
						<SheetHeader className="flex-row items-center justify-between p-0 sm:p-0">
							<SheetTitle>Decision context</SheetTitle>
							<Button
								variant="ghost"
								size="sm"
								className="min-h-11"
								aria-label="Close decision context"
								onClick={() => changeOpen(false)}
							>
								Done
							</Button>
						</SheetHeader>
						{contents}
						{shortcutHint}
					</SheetContent>
				</Sheet>
			)}
			<Sheet open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
				<SheetContent
					side={phone ? "bottom" : "right"}
					className="feed-deck fd-shortcut-sheet"
				>
					<SheetHeader>
						<SheetTitle>{OS_COPY.feedDeckVisual.shortcutsTitle}</SheetTitle>
					</SheetHeader>
					{shortcutGrid}
				</SheetContent>
			</Sheet>
		</DecisionRailContext.Provider>
	);
}

export function DecisionContextToolbar({
	children,
	filters,
}: {
	children?: ReactNode;
	filters?: ReactNode;
}) {
	const rail = useContext(DecisionRailContext);
	const target = useContext(WorkToolbarTargetContext);
	if (!children && !filters) return null;
	const toolbar = (
		<div className="feed-deck fd-app-toolbar">
			{children}
			{filters &&
				(rail?.phone ? (
					<PopoverRoot>
						<PopoverTrigger
							render={
								<Button variant="ghost" size="icon" aria-label="Filters" />
							}
						>
							<SlidersHorizontalIcon size={20} />
						</PopoverTrigger>
						<PopoverContent align="end" className="fd-mobile-filters p-1">
							{filters}
						</PopoverContent>
					</PopoverRoot>
				) : (
					<div className="fd-toolbar-filters">{filters}</div>
				))}
		</div>
	);
	return target ? createPortal(toolbar, target) : toolbar;
}

export function DecisionFilterChip({
	label,
	ariaLabel,
	value,
	onValueChange,
	options,
	searchable = false,
}: {
	label: ReactNode;
	ariaLabel: string;
	value: string;
	onValueChange: (value: string) => void;
	options: { value: string; label: string | undefined }[];
	searchable?: boolean;
}) {
	if (searchable && options.length > 8) {
		return (
			<Combobox
				items={options}
				value={options.find((option) => option.value === value)}
				isItemEqualToValue={(a, b) => a.value === b.value}
				onValueChange={(option) => {
					if (option) onValueChange(option.value);
				}}
			>
				<Combobox.Trigger
					render={
						<Button variant="ghost" size="sm" className="fd-filter-chip" />
					}
					aria-label={ariaLabel}
				>
					{label}
				</Combobox.Trigger>
				<Combobox.Content className="fd-filter-options w-56 max-w-[calc(100vw-2rem)] p-1 z-(--tedix-layer-dropdown)">
					<Combobox.Input
						aria-label="Find a project"
						placeholder="Find a project…"
						className="mt-0 px-2 first:mb-1"
					/>
					<Combobox.Empty>No projects found</Combobox.Empty>
					<Combobox.List>
						{(option: (typeof options)[number]) => (
							<Combobox.Item
								key={option.value}
								value={option}
								className="mx-0 min-h-8 items-center px-2 py-1 type-tedix-control max-sm:min-h-11 coarse:min-h-11"
							>
								{option.label}
							</Combobox.Item>
						)}
					</Combobox.List>
				</Combobox.Content>
			</Combobox>
		);
	}
	return (
		<Select
			value={value}
			onValueChange={(next) => {
				if (next !== null) onValueChange(next);
			}}
			items={options}
		>
			<SelectTrigger
				size="sm"
				aria-label={ariaLabel}
				className="fd-filter-chip border-0 bg-transparent ring-0"
			>
				{label}
			</SelectTrigger>
			<SelectContent
				align="start"
				alignItemWithTrigger={false}
				aria-label={ariaLabel}
				className="fd-filter-options w-56 max-w-[calc(100vw-2rem)] p-1"
			>
				{options.map((option) => (
					<SelectItem
						key={option.value}
						value={option.value}
						className="mx-0 min-h-8 px-2 py-1"
					>
						{option.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

export function DecisionContextSection({
	title,
	children,
	trigger = false,
	sectionId,
	defaultOpen = false,
}: {
	title: ReactNode;
	children: ReactNode;
	trigger?: boolean;
	sectionId?: string;
	defaultOpen?: boolean;
}) {
	const rail = useContext(DecisionRailContext);
	const generatedId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
	const id =
		sectionId ??
		(title === "Feedback"
			? "feedback"
			: title === "Feed preferences"
				? "seen"
				: generatedId);
	const slot = RAIL_SECTIONS.some((section) => section === id) ? id : "details";
	if (!rail)
		return (
			<section>
				<h3 className="type-tedix-section">{title}</h3>
				{children}
			</section>
		);
	const expanded = rail.open && rail.activeSection === id;
	return (
		<>
			{trigger && (
				<Button
					variant="ghost"
					aria-expanded={expanded}
					aria-controls={expanded ? `${rail.railId}-${id}` : undefined}
					onClick={() => (expanded ? rail.toggle() : rail.openSection(id))}
				>
					{title}
				</Button>
			)}
			{rail.target &&
				createPortal(
					<section
						id={`${rail.railId}-${id}`}
						data-context-section={id}
						hidden={
							rail.surface === "deck" &&
							slot === "details" &&
							rail.activeSection !== "details" &&
							rail.activeSection !== id
						}
						className="fd-context-section"
						onPointerDown={(event) => event.stopPropagation()}
						onPointerMove={(event) => event.stopPropagation()}
						onPointerUp={(event) => event.stopPropagation()}
						onTouchStart={(event) => event.stopPropagation()}
						onTouchEnd={(event) => event.stopPropagation()}
						onKeyDown={(event) => {
							if (event.key.toLowerCase() !== "i" && event.key !== "Escape")
								event.stopPropagation();
						}}
					>
						{trigger && !defaultOpen ? (
							<Collapsible
								open={rail.activeSection === id}
								onOpenChange={(open) => rail.openSection(open ? id : undefined)}
							>
								<h3 className="type-tedix-section">
									<CollapsibleTrigger>{title}</CollapsibleTrigger>
								</h3>
								<CollapsibleContent>{children}</CollapsibleContent>
							</Collapsible>
						) : (
							<>
								<h3 className="type-tedix-section">{title}</h3>
								{children}
							</>
						)}
					</section>,
					rail.target.querySelector(`[data-rail-slot="${slot}"]`)!,
				)}
		</>
	);
}
