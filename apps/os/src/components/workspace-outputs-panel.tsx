import "./workspace-outputs-panel.css";
import {
	Books,
	FileText,
	Kanban,
	MonitorPlay,
	PresentationChart,
	ShieldCheck,
	SquaresFour,
	Table as TableIcon,
	Tray,
} from "@phosphor-icons/react";
import type {
	OsGadget,
	OsOutput,
	OsOutputKind,
} from "@tedix/api-contract/schemas/os-workspaces";
import type { ReactElement } from "react";
import { Button } from "@/components/kumo/button";
import { Skeleton } from "@/components/kumo/skeleton";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/kumo/tooltip";
import { outputWorkshopKindLabel } from "@/components/output-workshop";
import type { CanvasDocSelection } from "@/lib/canvas-search";
import { relativeTime } from "@/lib/time";

/**
 * The workspace's Files panel: a narrow column on the right edge of the
 * workbench that lists the workspace's apps and files, opens any of them in
 * the canvas beside the chat, and folds down to an icon rail when the canvas
 * needs the room. The top bar's one panel toggle drives the fold. Phones get
 * the full library pane from the bottom switcher instead.
 *
 * Presentational: the list queries, selection and URL writes stay in
 * canvas-page.tsx, which owns the workbench.
 */

export const WORKSPACE_OUTPUTS_PANEL_KEY = "tedix-os:workspace-outputs-panel";
/** Widths in px; the CSS custom properties in workspace-outputs-panel.css match. */
export const WORKSPACE_OUTPUTS_PANEL_WIDTH = 240;
export const WORKSPACE_OUTPUTS_RAIL_WIDTH = 48;
/**
 * Below this viewport width an expanded panel would leave the stage too
 * narrow, so a person who never chose starts with the rail.
 */
export const WORKSPACE_OUTPUTS_PANEL_ROOMY_MIN = 1200;

export const WORKSPACE_OUTPUTS_EMPTY_COPY =
	"Nothing here yet. Apps and files made in this workspace will show up here.";

export function restoreWorkspaceOutputsPanelExpanded(
	storage: Pick<Storage, "getItem"> | null,
	viewportWidth: number,
): boolean {
	try {
		const stored = storage?.getItem(WORKSPACE_OUTPUTS_PANEL_KEY);
		if (stored === "expanded") return true;
		if (stored === "collapsed") return false;
	} catch {
		// Storage can be unavailable (private mode, blocked site data).
	}
	return viewportWidth >= WORKSPACE_OUTPUTS_PANEL_ROOMY_MIN;
}

export function persistWorkspaceOutputsPanelExpanded(
	storage: Pick<Storage, "setItem"> | null,
	expanded: boolean,
) {
	try {
		storage?.setItem(
			WORKSPACE_OUTPUTS_PANEL_KEY,
			expanded ? "expanded" : "collapsed",
		);
	} catch {
		// Remembering the panel is a convenience; the panel still works.
	}
}

export type WorkspaceOutputsPanelItem = {
	doc: CanvasDocSelection;
	key: string;
	title: string;
	kind: OsOutputKind | "app";
	kindLabel: string;
	updatedAt: string;
};

/**
 * Apps lead, because an app is the workspace's front door and stays put; then
 * every active output, most recently changed first. Archived outputs stay in
 * the Resources library.
 */
export function workspaceOutputsPanelItems(
	outputs: readonly Pick<
		OsOutput,
		"id" | "title" | "kind" | "status" | "updatedAt"
	>[],
	gadgets: readonly Pick<OsGadget, "id" | "name" | "updatedAt">[],
): WorkspaceOutputsPanelItem[] {
	const byNewest = <T extends { updatedAt: string }>(a: T, b: T) =>
		Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
	const apps = [...gadgets]
		.sort(byNewest)
		.map((gadget): WorkspaceOutputsPanelItem => ({
			doc: { type: "gadget", id: gadget.id },
			key: `gadget:${gadget.id}`,
			title: gadget.name,
			kind: "app",
			kindLabel: "App",
			updatedAt: gadget.updatedAt,
		}));
	const files = outputs
		.filter((output) => output.status === "active")
		.sort(byNewest)
		.map((output): WorkspaceOutputsPanelItem => ({
			doc: { type: "output", id: output.id },
			key: `output:${output.id}`,
			title: output.title,
			kind: output.kind,
			kindLabel: outputWorkshopKindLabel(output.kind),
			updatedAt: output.updatedAt,
		}));
	return [...apps, ...files];
}

export function isWorkspaceOutputsItemSelected(
	item: WorkspaceOutputsPanelItem,
	selectedDoc: CanvasDocSelection | null,
): boolean {
	if (!selectedDoc) return false;
	if (item.doc.type === "gadget") {
		return selectedDoc.type === "gadget"
			? selectedDoc.id === item.doc.id
			: selectedDoc.linkedGadgetId === item.doc.id;
	}
	// An app's linked output belongs to the app row, not this one.
	return (
		selectedDoc.type === "output" &&
		selectedDoc.id === item.doc.id &&
		!selectedDoc.linkedGadgetId
	);
}

function OutputKindIcon({
	kind,
	selected,
}: {
	kind: WorkspaceOutputsPanelItem["kind"];
	selected: boolean;
}) {
	const Icon =
		kind === "app"
			? SquaresFour
			: kind === "document"
				? FileText
				: kind === "sheet"
					? TableIcon
					: kind === "presentation"
						? PresentationChart
						: MonitorPlay;
	return (
		<Icon
			aria-hidden
			className="workspace-outputs-icon"
			data-output-kind={kind}
			size={16}
			weight={selected ? "fill" : "regular"}
		/>
	);
}

/** A row that names itself in a tooltip only when the rail hides its label. */
function RailTooltip({
	label,
	railed,
	children,
}: {
	label: string;
	railed: boolean;
	children: ReactElement;
}) {
	if (!railed) return children;
	return (
		<Tooltip>
			<TooltipTrigger render={children} />
			<TooltipContent side="left" sideOffset={8}>
				{label}
			</TooltipContent>
		</Tooltip>
	);
}

type WorkspaceOutputsListProps = {
	items: readonly WorkspaceOutputsPanelItem[];
	loading: boolean;
	error: boolean;
	selectedDoc: CanvasDocSelection | null;
	onSelect: (doc: CanvasDocSelection) => void;
	onOpenActivity: () => void;
	/** Opens the whole library (search, sources, schedules) in the canvas. */
	onBrowseLibrary: () => void;
	/** Opens the workspace's work items in the canvas. */
	onOpenWork: () => void;
	/** Which of the two canvas views above is showing, if either. */
	canvasView?: "library" | "work" | null;
	/** The icon-only rail: labels hide and each row names itself in a tooltip. */
	railed?: boolean;
	now?: Date;
};

/** A footer row: an icon and a label, named in a tooltip when railed. */
function FooterRow({
	label,
	icon,
	railed,
	current,
	onClick,
	...rest
}: {
	label: string;
	icon: ReactElement;
	railed: boolean;
	current?: boolean;
	onClick: () => void;
	[key: `data-${string}`]: string;
}) {
	return (
		<RailTooltip label={label} railed={railed}>
			<Button
				aria-current={current || undefined}
				aria-label={railed ? label : undefined}
				className="workspace-outputs-row"
				data-selected={current || undefined}
				multiline
				onClick={onClick}
				size="sm"
				variant="ghost"
				{...rest}
			>
				{icon}
				<span className="workspace-outputs-label">
					<span className="workspace-outputs-title">{label}</span>
				</span>
			</Button>
		</RailTooltip>
	);
}

/** The list itself. */
export function WorkspaceOutputsList({
	items,
	loading,
	error,
	selectedDoc,
	onSelect,
	onOpenActivity,
	onBrowseLibrary,
	onOpenWork,
	canvasView = null,
	railed = false,
	now,
}: WorkspaceOutputsListProps) {
	return (
		<div className="workspace-outputs-body">
			{loading ? (
				<div className="workspace-outputs-skeleton" aria-hidden>
					<Skeleton className="h-7" />
					<Skeleton className="h-7" />
					<Skeleton className="h-7" />
				</div>
			) : error ? (
				<p className="workspace-outputs-note" role="status">
					Files are unavailable right now.
				</p>
			) : items.length === 0 ? (
				<div
					className="workspace-outputs-empty"
					data-workspace-outputs-empty=""
				>
					<Tray aria-hidden size={18} />
					<p>{WORKSPACE_OUTPUTS_EMPTY_COPY}</p>
				</div>
			) : (
				<ul className="workspace-outputs-list" aria-label="Files">
					{items.map((item) => {
						const selected = isWorkspaceOutputsItemSelected(item, selectedDoc);
						const updated = relativeTime(item.updatedAt, now);
						return (
							<li key={item.key}>
								<RailTooltip
									label={`${item.title} · ${item.kindLabel}`}
									railed={railed}
								>
									<Button
										aria-current={selected || undefined}
										aria-label={railed ? item.title : undefined}
										className="workspace-outputs-row"
										data-selected={selected || undefined}
										multiline
										onClick={() => onSelect(item.doc)}
										size="sm"
										variant="ghost"
									>
										<OutputKindIcon kind={item.kind} selected={selected} />
										<span className="workspace-outputs-label">
											<span className="workspace-outputs-title">
												{item.title}
											</span>
											<span className="workspace-outputs-meta">
												{item.kindLabel}
												{updated ? ` · ${updated}` : ""}
											</span>
										</span>
									</Button>
								</RailTooltip>
							</li>
						);
					})}
				</ul>
			)}
			<div className="workspace-outputs-footer">
				<FooterRow
					label="Everything here"
					icon={
						<Books aria-hidden className="workspace-outputs-icon" size={16} />
					}
					railed={railed}
					current={canvasView === "library"}
					onClick={onBrowseLibrary}
					data-workspace-outputs-library=""
				/>
				<FooterRow
					label="Work"
					icon={
						<Kanban aria-hidden className="workspace-outputs-icon" size={16} />
					}
					railed={railed}
					current={canvasView === "work"}
					onClick={onOpenWork}
					data-workspace-outputs-work=""
				/>
				<FooterRow
					label="Approvals"
					icon={
						<ShieldCheck
							aria-hidden
							className="workspace-outputs-icon"
							size={16}
						/>
					}
					railed={railed}
					onClick={onOpenActivity}
					data-workspace-outputs-activity=""
				/>
			</div>
		</div>
	);
}

export const WORKSPACE_OUTPUTS_PANEL_ID = "workspace-outputs-panel";

export function WorkspaceOutputsPanel({
	expanded,
	...list
}: Omit<WorkspaceOutputsListProps, "railed"> & {
	expanded: boolean;
}) {
	const count = list.loading || list.error ? null : list.items.length;
	return (
		<aside
			aria-label="Workspace files"
			className="workspace-outputs-panel"
			data-expanded={expanded}
			id={WORKSPACE_OUTPUTS_PANEL_ID}
		>
			<header className="workspace-outputs-header">
				<h2 className="workspace-outputs-heading">
					Files
					{count ? (
						<span className="workspace-outputs-count">{count}</span>
					) : null}
				</h2>
			</header>
			<WorkspaceOutputsList {...list} railed={!expanded} />
		</aside>
	);
}
