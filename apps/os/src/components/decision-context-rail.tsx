import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import {
	createContext,
	useContext,
	useEffect,
	useId,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { SidebarSimpleIcon } from "@phosphor-icons/react";
import { Button } from "@/components/kumo/button";
import { Link } from "@/components/kumo/link";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
} from "@/components/kumo/sheet";
import { osQuery, userProfileQueryOptions } from "@/lib/os-query-options";

export const DecisionRailContext = createContext<{
	target: HTMLDivElement | null;
	openSection: (id?: string) => void;
	openedBefore: (id: string) => boolean;
	open: boolean;
	activeSection?: string;
} | null>(null);

/** Shared app context: auxiliary information lives outside the decision column. */
export function DecisionContextRail({ children }: { children: ReactNode }) {
	const profile = useQuery(userProfileQueryOptions());
	const key = profile.data?.id
		? `tedix:decision-context:${profile.data.id}`
		: null;
	const [open, setOpen] = useState(false);
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
				(event.key.toLowerCase() !== "i" && event.key !== "Escape") ||
				(event.key === "Escape" && !open) ||
				event.metaKey ||
				event.ctrlKey ||
				event.altKey ||
				(event.target instanceof Element &&
					event.target.closest("input,textarea,[contenteditable=true]"))
			)
				return;
			event.preventDefault();
			changeOpen(event.key === "Escape" ? false : !open);
		};
		document.addEventListener("keydown", shortcut);
		return () => document.removeEventListener("keydown", shortcut);
	}, [open, key]);
	useEffect(() => {
		if (open && section && target)
			target
				.querySelector<HTMLElement>(`[data-context-section="${section}"]`)
				?.scrollIntoView({ block: "start" });
	}, [open, section, target]);
	const contents = (
		<>
			<div ref={setTarget} className="fd-context-sections" />
			{open && <DecisionRailProfile />}
		</>
	);
	return (
		<DecisionRailContext.Provider
			value={{
				target,
				open,
				activeSection: section,
				openSection: (id) => {
					setSection(id);
					changeOpen(true);
				},
				openedBefore: (id) => {
					if (open) visited.current.add(id);
					return visited.current.has(id);
				},
			}}
		>
			<div
				className="feed-deck fd-context-layout"
				data-context-open={open && !phone}
			>
				<Button
					className="fd-context-toggle"
					variant="ghost"
					size="icon"
					aria-label="Decision context"
					aria-expanded={open}
					aria-keyshortcuts="I"
					onClick={() => changeOpen(!open)}
				>
					<SidebarSimpleIcon size={20} />
				</Button>
				<div className="fd-context-main">{children}</div>
				{phone ? (
					<Sheet open={open} onOpenChange={changeOpen}>
						<SheetContent side="bottom" className="feed-deck fd-context-sheet">
							<SheetHeader>
								<SheetTitle>Decision context</SheetTitle>
							</SheetHeader>
							{contents}
						</SheetContent>
					</Sheet>
				) : (
					<aside
						className="fd-context-rail"
						aria-label="Decision context"
						hidden={!open}
					>
						<h2>Decision context</h2>
						{contents}
					</aside>
				)}
			</div>
		</DecisionRailContext.Provider>
	);
}

export function DecisionContextSection({
	title,
	children,
	trigger = false,
	sectionId,
}: {
	title: ReactNode;
	children: ReactNode;
	trigger?: boolean;
	sectionId?: string;
}) {
	const rail = useContext(DecisionRailContext);
	const generatedId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
	const id = sectionId ?? generatedId;
	if (!rail)
		return (
			<section>
				<h3>{title}</h3>
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
						{trigger ? (
							<Collapsible
								open={rail.activeSection === id}
								onOpenChange={(open) => rail.openSection(open ? id : undefined)}
							>
								<h3>
									<CollapsibleTrigger>{title}</CollapsibleTrigger>
								</h3>
								<CollapsibleContent>{children}</CollapsibleContent>
							</Collapsible>
						) : (
							<>
								<h3>{title}</h3>
								{children}
							</>
						)}
					</section>,
					rail.target,
				)}
		</>
	);
}

function DecisionRailProfile() {
	const [showStyle, setShowStyle] = useState(false);
	const learning = useQuery(
		osQuery.learningFeedback.model.queryOptions({ input: {} }),
	);
	const profile = useQuery({
		...osQuery.workInteractions.outbound.profile.queryOptions({ input: {} }),
		enabled: showStyle,
	});
	const metric = learning.data?.cardIntuitiveness;
	return (
		<section className="fd-context-sections">
			<h3>From your recent decisions</h3>
			<p>
				{metric?.percent == null
					? "Your card-alone decision rate will appear after your first measured decision."
					: `${metric.percent}% decided from the card alone`}
			</p>
			<p className="text-kumo-subtle">
				Target: 80% · {metric?.decisions ?? 0} measured decisions in recent
				history
			</p>
			<Button
				variant="ghost"
				aria-expanded={showStyle}
				onClick={() => setShowStyle(!showStyle)}
			>
				Style profile and recent approvals
			</Button>
			{showStyle && (
				<div className="grid gap-3">
					{profile.isPending ? (
						<p>Loading your profile…</p>
					) : profile.isError ? (
						<p>Your profile could not be loaded.</p>
					) : (
						<>
							{profile.data?.preferences.map((sentence) => (
								<p key={sentence}>{sentence}</p>
							))}
							{profile.data?.sentStyleHints.map((sentence) => (
								<p key={sentence}>{sentence}</p>
							))}
							{profile.data?.approvals.slice(0, 10).map((approval, index) => (
								<details key={approval.id}>
									<summary>
										{profile.data?.lessons[index] ?? "Approved wording"}
									</summary>
									<p>{approval.after}</p>
								</details>
							))}
							{!profile.data?.approvals.length && (
								<p>Your next approvals will appear here.</p>
							)}
						</>
					)}
				</div>
			)}
			<Link href="/work/attention">History and decisions in Work</Link>
			<p className="text-kumo-subtle">
				I Context · Esc Close · ← Not this · → Approve · E Change · L Later · D
				Decide for me · ? Why this
			</p>
		</section>
	);
}
