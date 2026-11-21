import { ListSkeleton } from "@/components/list-skeleton";
import { FileUnreadDot } from "@/components/unread-badge";
import { NewResourceMenu } from "./create-document-dialog";
import { OS_COPY } from "@/shared/os-copy";
import "./workspace-outputs-panel.css";
import {
	Books,
	FileText,
	Kanban,
	Robot,
	MonitorPlay,
	PresentationChart,
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
import { LoadError } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Empty } from "@/components/kumo/empty";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/kumo/tooltip";
import { outputWorkshopKindLabel } from "@/components/output-workshop";
import { WorkspaceItemMenu } from "@/components/workspace-item-menu";
import type { CanvasDocSelection } from "@/lib/canvas-search";
import { relativeTime } from "@/lib/time";

/**
 * The workspace's Files rail: a narrow column on the right edge of the
 * workbench that lists the workspace's apps and files and opens any of them,
 * or the Overview, Work and Agents, in the side panel beside the chat. It
 * folds down to an icon rail when the panel needs the room; the top bar's
 * Files toggle drives the fold. A phone shows it full width as its Files tab.
 *
 * Presentational: the list queries, selection and URL writes stay in
 * canvas-page.tsx, which owns the workbench.
 */

export const WORKSPACE_OUTPUTS_PANEL_KEY = "tedix-os:workspace-outputs-panel";
/**
 * Below this viewport width an expanded panel would leave the stage too
 * narrow, so a person who never chose starts with the rail.
 */
export const WORKSPACE_OUTPUTS_PANEL_ROOMY_MIN = 1200;

export const WORKSPACE_OUTPUTS_EMPTY_COPY =
	"Apps and files made in this workspace will show up here.";

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
	outputId?: string;
};

/**
 * A bound file and its editor appear once. Other apps lead the active files;
 * archived outputs stay in the Resources library.
 */
export function workspaceOutputsPanelItems(
	outputs: readonly Pick<
		OsOutput,
		"id" | "title" | "kind" | "status" | "updatedAt"
	>[],
	gadgets: readonly Pick<OsGadget, "id" | "name" | "updatedAt">[],
	editors: ReadonlyMap<string, string> = new Map(),
): WorkspaceOutputsPanelItem[] {
	const byNewest = <T extends { updatedAt: string }>(a: T, b: T) =>
		Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
	const boundGadgets = new Set(
		outputs
			.filter((output) => output.status === "active")
			.map((output) => editors.get(output.id))
			.filter(Boolean),
	);
	const apps = [...gadgets]
		.filter((gadget) => !boundGadgets.has(gadget.id))
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
			doc: editors.has(output.id)
				? { type: "gadget", id: editors.get(output.id)! }
				: { type: "output", id: output.id },
			key: `output:${output.id}`,
			outputId: output.id,
			title: output.title,
			kind: output.kind,
			kindLabel:
				editors.has(output.id) && output.kind === "document"
					? "Doc"
					: outputWorkshopKindLabel(output.kind),
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
		if (selectedDoc.type === "output" && item.outputId === selectedDoc.id)
			return true;
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
	/** Loads the list again after it failed. */
	onRetry?: () => void;
	retrying?: boolean;
	selectedDoc: CanvasDocSelection | null;
	onSelect: (doc: CanvasDocSelection) => void;
	onOpenAppDraft?: (gadgetId: string) => void;
	/** Opens the whole library (search, sources, schedules) in the canvas. */
	onBrowseLibrary: () => void;
	/** Opens the workspace's work items in the canvas. */
	onOpenWork: () => void;
	/** Opens the workspace's agents and their runs in the canvas. */
	onOpenAgents: () => void;
	/** Which of the canvas views above is showing, if any. */
	canvasView?: "library" | "work" | "agents" | null;
	/** The icon-only rail: labels hide and each row names itself in a tooltip. */
	railed?: boolean;
	now?: Date;
	/** With a workspace, each row offers Open, Rename and Archive. */
	workspaceId?: string;
	/** A row was archived; close whatever is showing it. */
	onArchived?: (item: WorkspaceOutputsPanelItem) => void;
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
	onRetry,
	retrying,
	selectedDoc,
	onSelect,
	onOpenAppDraft,
	onBrowseLibrary,
	onOpenWork,
	onOpenAgents,
	canvasView = null,
	railed = false,
	now,
	workspaceId,
	onArchived,
}: WorkspaceOutputsListProps) {
	return (
		<div className="workspace-outputs-body">
			{loading ? (
				<div className="workspace-outputs-skeleton" aria-hidden>
					<ListSkeleton rows={3} rowClassName="h-7" />
				</div>
			) : error ? (
				<LoadError
					className="workspace-outputs-empty"
					title="Files are unavailable"
					onRetry={onRetry}
					retrying={retrying}
				/>
			) : items.length === 0 ? (
				<Empty
					appearance="quiet"
					className="workspace-outputs-empty"
					data-workspace-outputs-empty=""
					description={WORKSPACE_OUTPUTS_EMPTY_COPY}
					icon={<Tray aria-hidden size={20} />}
					title="Nothing here yet"
				/>
			) : (
				<ul className="workspace-outputs-list" aria-label="Files">
					{items.map((item) => {
						const selected = isWorkspaceOutputsItemSelected(item, selectedDoc);
						const updated = relativeTime(item.updatedAt, now);
						const row = (
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
									<FileUnreadDot outputId={item.outputId} />
								</Button>
							</RailTooltip>
						);
						const gadgetId =
							item.doc.type === "gadget" && !item.outputId
								? item.doc.id
								: undefined;
						return (
							<li key={item.key}>
								{workspaceId && !railed && (item.outputId || gadgetId) ? (
									<WorkspaceItemMenu
										workspaceId={workspaceId}
										item={{
											title: item.title,
											kindLabel: item.kindLabel,
											outputId: item.outputId,
											gadgetId,
										}}
										onOpen={() => onSelect(item.doc)}
										onDraftCreated={onOpenAppDraft}
										onArchived={() => onArchived?.(item)}
									>
										{row}
									</WorkspaceItemMenu>
								) : (
									row
								)}
							</li>
						);
					})}
				</ul>
			)}
			<div className="workspace-outputs-footer">
				<FooterRow
					label={OS_COPY.workspace.overview}
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
					label="Agents"
					icon={
						<Robot aria-hidden className="workspace-outputs-icon" size={16} />
					}
					railed={railed}
					current={canvasView === "agents"}
					onClick={onOpenAgents}
					data-workspace-outputs-agents=""
				/>
			</div>
		</div>
	);
}

export const WORKSPACE_OUTPUTS_PANEL_ID = "workspace-outputs-panel";

export function WorkspaceOutputsPanel({
	expanded,
	workspaceId,
	...list
}: Omit<WorkspaceOutputsListProps, "railed"> & {
	expanded: boolean;
	workspaceId?: string;
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
					{count ? <Badge variant="secondary">{count}</Badge> : null}
				</h2>
				{/* The workspace's one New menu; templates are in it too. */}
				{expanded && workspaceId && (
					<div className="ml-auto flex items-center gap-1">
						<NewResourceMenu
							workspaceId={workspaceId}
							onCreated={(output) =>
								list.onSelect({ type: "output", id: output.id })
							}
							onAppCreated={(gadget) =>
								list.onSelect({ type: "gadget", id: gadget.id })
							}
						/>
					</div>
				)}
			</header>
			<WorkspaceOutputsList
				{...list}
				railed={!expanded}
				workspaceId={workspaceId}
			/>
		</aside>
	);
}
