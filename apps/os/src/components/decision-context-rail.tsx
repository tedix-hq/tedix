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
	useRef,
	useState,
	type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import {
	InfoIcon,
	SlidersHorizontalIcon,
	CaretDownIcon,
} from "@phosphor-icons/react";
import { OS_COPY } from "@/shared/os-copy";
import { Button } from "@/components/kumo/button";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
} from "@/components/kumo/sheet";
import { WorkToolbarTargetContext } from "@/components/deck-presentation-context";
import { OsTopbarActionsTargetContext } from "@/components/os-topbar-actions-context";
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
import { userProfileQueryOptions } from "@/lib/os-query-options";

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
	const contextTrigger = useRef<HTMLButtonElement>(null);
	const contextId = useId();
	const profile = useQuery(userProfileQueryOptions());
	const key = profile.data?.id
		? `tedix:decision-context:${profile.data.id}`
		: null;
	const [open, setOpen] = useState(false);
	const [shortcutsOpen, setShortcutsOpen] = useState(false);
	const [phone, setPhone] = useState(false);
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
				(event.key.toLowerCase() !== "i" && event.key !== "?") ||
				event.metaKey ||
				event.ctrlKey ||
				event.altKey ||
				(event.target instanceof Element &&
					event.target.closest("input,textarea,[contenteditable=true]"))
			)
				return;
			event.preventDefault();
			if (event.key === "?") {
				setShortcutsOpen(true);
			} else changeOpen(!open);
		};
		document.addEventListener("keydown", shortcut);
		return () => document.removeEventListener("keydown", shortcut);
	}, [open, key, shortcutsOpen, surface]);
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
					<kbd>{key}</kbd>
					<span>{label}</span>
				</Fragment>
			))}
		</div>
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
	const trigger = (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						ref={contextTrigger}
						variant="ghost"
						size="icon"
						aria-label="Decision context"
						aria-haspopup="dialog"
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
			{topbarTarget ? createPortal(trigger, topbarTarget) : trigger}
			<div className="feed-deck fd-context-layout">
				<div className="fd-context-main">{children}</div>
			</div>
			<Sheet open={open} onOpenChange={changeOpen}>
				<SheetContent
					id={contextId}
					data-decision-context
					side={phone ? "bottom" : "right"}
					size="md"
					className={`gap-8 p-4 sm:p-6 ${phone ? "max-h-[80dvh] rounded-t-xl" : ""}`}
					showCloseButton={false}
					keepMounted
					finalFocus={contextTrigger}
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
				</SheetContent>
			</Sheet>
			<Sheet open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
				<SheetContent
					side={phone ? "bottom" : "right"}
					className="feed-deck fd-shortcut-sheet"
				>
					<SheetHeader>
						<SheetTitle>Shortcuts</SheetTitle>
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
						<PopoverContent align="end" className="feed-deck fd-mobile-filters">
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
	children,
}: {
	label: ReactNode;
	children: ReactNode;
}) {
	return (
		<PopoverRoot>
			<PopoverTrigger
				render={<Button variant="ghost" size="sm" className="fd-filter-chip" />}
			>
				{label}
				<CaretDownIcon size={12} />
			</PopoverTrigger>
			<PopoverContent align="start" className="feed-deck fd-filter-options">
				{children}
			</PopoverContent>
		</PopoverRoot>
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
	return (
		<>
			{trigger && (
				<Button variant="ghost" onClick={() => rail.openSection(id)}>
					{title}
				</Button>
			)}
			{rail.target &&
				createPortal(
					<section
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
