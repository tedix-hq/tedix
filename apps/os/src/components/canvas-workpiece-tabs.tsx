import {
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@/components/kumo/context-menu";
import {
	FileText,
	MonitorPlay,
	PresentationChart,
	SquaresFour,
	Table as TableIcon,
	X,
} from "@phosphor-icons/react";
import type { OsOutputKind } from "@tedix/api-contract/schemas/os-workspaces";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/kumo/tabs";
import { outputWorkshopKindLabel } from "@/components/output-workshop";
import {
	type CanvasWorkpieceSelection,
	type CanvasWorkpieceMode,
	canvasDocKey,
} from "@/lib/canvas-search";

/**
 * The workpiece tab strip and its per-document view-mode options. Pure
 * presentation over the shell's opened-document state — selection and URL
 * writes stay in canvas-page.tsx.
 */

/**
 * The open item's views: the item, then for an app Code (counting the drafts
 * waiting there), History (its runs), and Connections. The editor of a Doc,
 * Sheet or Slides file is named after its file and has no History: editing a
 * file is not a run. For other items, Connections and Review join the row
 * when opened from the menu.
 */
export function canvasWorkpieceModeOptions(
	doc: CanvasWorkpieceSelection,
	outputKind?: OsOutputKind | null,
	/** Open drafts of a runtime app, counted on the Code tab. */
	draftCount = 0,
	activeMode: CanvasWorkpieceMode = "workpiece",
	/** The kind of file this app edits, when it is a file's editor. */
	fileEditorKind?: OsOutputKind | null,
): { value: CanvasWorkpieceMode; label: ReactNode }[] {
	return [
		{
			value: "workpiece",
			label:
				doc.type === "gadget"
					? fileEditorKind === "document"
						? "Doc"
						: fileEditorKind
							? outputWorkshopKindLabel(fileEditorKind)
							: "App"
					: doc.type === "repository"
						? "Repository"
						: outputWorkshopKindLabel(outputKind),
		},
		...(doc.type === "gadget"
			? [
					{
						value: "edit" as const,
						label:
							draftCount > 0 ? (
								<span className="inline-flex items-center gap-1.5">
									Code
									<Badge variant="info">{draftCount}</Badge>
								</span>
							) : (
								"Code"
							),
					},
					...(fileEditorKind
						? []
						: [{ value: "history" as const, label: "History" }]),
				]
			: []),
		...(doc.type === "gadget" || activeMode === "connections"
			? [{ value: "connections" as const, label: "Connections" }]
			: []),
		...(activeMode === "activity"
			? [{ value: "activity" as const, label: "Review" }]
			: []),
	];
}

export const CANVAS_WORKPIECE_PANEL_ID = "canvas-workpiece-panel";

export function canvasWorkpieceTabId(doc: CanvasWorkpieceSelection): string {
	return `canvas-workpiece-tab-${encodeURIComponent(canvasDocKey(doc))}`;
}

export function CanvasWorkpieceTabs({
	opened,
	selectedKey,
	gadgets,
	outputs,
	onClose,
	onCloseOthers,
	onMove,
	onSelect,
}: {
	opened: readonly CanvasWorkpieceSelection[];
	selectedKey: string | null;
	gadgets: readonly { id: string; name: string }[];
	outputs: readonly { id: string; title: string; kind: string }[];
	onClose: (key: string) => void;
	/** Close every tab except this one. */
	onCloseOthers?: (key: string) => void;
	/** Put the tab `key` where the tab `beforeKey` is. */
	onMove?: (key: string, beforeKey: string) => void;
	onSelect: (doc: CanvasWorkpieceSelection) => void;
}) {
	const stripRef = useRef<HTMLDivElement>(null);
	const dragging = useRef<string | null>(null);
	const [dropKey, setDropKey] = useState<string | null>(null);
	useEffect(() => {
		const strip = stripRef.current;
		if (!strip) return;
		const reveal = () => {
			const list = strip.querySelector<HTMLElement>('[role="tablist"]');
			const active = strip.querySelector<HTMLElement>("[data-selected]");
			if (!list || !active) return;
			const box = active.getBoundingClientRect();
			const view = list.getBoundingClientRect();
			if (box.right > view.right) list.scrollLeft += box.right - view.right + 8;
			else if (box.left < view.left)
				list.scrollLeft -= view.left - box.left + 8;
		};
		reveal();
		const observer = new ResizeObserver(reveal);
		observer.observe(strip);
		return () => observer.disconnect();
	}, [selectedKey, opened, gadgets, outputs]);
	/**
	 * The Tab primitive owns the roaming stop and the arrow, Home and End keys;
	 * Delete stays local: it closes the focused tab and hands the stop to the
	 * neighbour the shell selects next.
	 */
	const onListKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		const tabs = Array.from(
			event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'),
		);
		const current = tabs.indexOf(document.activeElement as HTMLElement);
		// Alt+Shift+Left or Right moves the focused tab one place: the keyboard
		// way to reorder.
		if (
			onMove &&
			event.altKey &&
			event.shiftKey &&
			(event.key === "ArrowLeft" || event.key === "ArrowRight")
		) {
			const moving = opened[current];
			const neighbour = opened[current + (event.key === "ArrowLeft" ? -1 : 1)];
			if (!moving || !neighbour) return;
			event.preventDefault();
			event.stopPropagation();
			onMove(canvasDocKey(moving), canvasDocKey(neighbour));
			return;
		}
		if (event.key !== "Delete") return;
		const closing = current >= 0 ? opened[current] : undefined;
		if (!closing) return;
		event.preventDefault();
		(tabs[current + 1] ?? tabs[current - 1])?.focus();
		onClose(canvasDocKey(closing));
	};
	if (opened.length === 0) return null;
	return (
		<Tabs
			ref={stripRef}
			value={selectedKey}
			onValueChange={(key) => {
				const doc = opened.find((candidate) => canvasDocKey(candidate) === key);
				if (doc && key !== selectedKey) onSelect(doc);
			}}
			data-focus-ring="inset"
			className="canvas-workpiece-tabs data-[orientation=horizontal]:flex-row"
		>
			<TabsList
				aria-label="Open workpieces"
				variant="filter"
				activateOnFocus
				onKeyDown={onListKeyDown}
				className="min-h-full"
			>
				{opened.map((doc) => {
					const key = canvasDocKey(doc);
					const output = outputs.find((candidate) => candidate.id === doc.id);
					const title =
						doc.type === "gadget"
							? gadgets.find((candidate) => candidate.id === doc.id)?.name
							: doc.type === "repository"
								? `Repository · ${doc.id.slice(0, 8)}`
								: output?.title;
					const kind =
						doc.type === "gadget" ? "gadget" : (output?.kind ?? null);
					const kindLabel =
						doc.type === "gadget"
							? "App"
							: doc.type === "repository"
								? "Repository"
								: outputWorkshopKindLabel(
										output?.kind as OsOutputKind | undefined,
									);
					const accessibleName = `${title ?? "Workpiece"} (${kindLabel}, ${doc.id}${doc.type === "repository" ? `, session ${doc.attemptId}` : ""})`;
					const selected = key === selectedKey;
					return (
						<ContextMenu key={key}>
							<ContextMenuTrigger
								className="canvas-workpiece-tab"
								data-selected={selected || undefined}
								data-drop-target={dropKey === key || undefined}
								draggable={onMove ? true : undefined}
								onDragStart={(event) => {
									dragging.current = key;
									event.dataTransfer.effectAllowed = "move";
									event.dataTransfer.setData("text/plain", key);
								}}
								onDragOver={(event) => {
									if (!dragging.current || dragging.current === key) return;
									event.preventDefault();
									event.dataTransfer.dropEffect = "move";
									setDropKey(key);
								}}
								onDragLeave={() =>
									setDropKey((current) => (current === key ? null : current))
								}
								onDrop={(event) => {
									event.preventDefault();
									const from = dragging.current;
									dragging.current = null;
									setDropKey(null);
									if (from && from !== key) onMove?.(from, key);
								}}
								onDragEnd={() => {
									dragging.current = null;
									setDropKey(null);
								}}
							>
								<TabsTrigger
									aria-label={accessibleName}
									aria-controls={CANVAS_WORKPIECE_PANEL_ID}
									id={canvasWorkpieceTabId(doc)}
									title={title ?? "Workpiece"}
									className="min-w-0 flex-1 justify-start gap-1.5 px-2"
									onClick={() => {
										// Re-tapping the open tab returns to it from the
										// library or Work pane; the primitive only reports
										// value changes, so the shell hears this case here.
										if (selected) onSelect(doc);
									}}
									value={key}
								>
									<TabKindIcon kind={kind} />
									<span className="truncate">{title ?? "Workpiece"}</span>
								</TabsTrigger>
								<Button
									aria-label={`Close ${accessibleName}`}
									className="shrink-0"
									onClick={() => onClose(key)}
									size="icon-sm"
									tabIndex={-1}
									variant="ghost"
								>
									<X size={12} />
								</Button>
							</ContextMenuTrigger>
							<ContextMenuContent>
								<ContextMenuItem onClick={() => onClose(key)}>
									Close
								</ContextMenuItem>
								{onCloseOthers && (
									<ContextMenuItem
										disabled={opened.length < 2}
										onClick={() => onCloseOthers(key)}
									>
										Close other tabs
									</ContextMenuItem>
								)}
								{onMove && opened.length > 1 && (
									<>
										<ContextMenuSeparator />
										<ContextMenuItem
											disabled={opened[0] === doc}
											onClick={() => onMove(key, canvasDocKey(opened[0]!))}
										>
											Move to the start
										</ContextMenuItem>
										<ContextMenuItem
											disabled={opened[opened.length - 1] === doc}
											onClick={() =>
												onMove(key, canvasDocKey(opened[opened.length - 1]!))
											}
										>
											Move to the end
										</ContextMenuItem>
									</>
								)}
							</ContextMenuContent>
						</ContextMenu>
					);
				})}
			</TabsList>
		</Tabs>
	);
}

function TabKindIcon({ kind }: { kind: string | null }) {
	const Icon =
		kind === "gadget"
			? SquaresFour
			: kind === "document"
				? FileText
				: kind === "sheet"
					? TableIcon
					: kind === "presentation"
						? PresentationChart
						: kind === "video"
							? MonitorPlay
							: null;
	return Icon ? (
		<Icon aria-hidden className="shrink-0" data-tab-kind={kind} size={13} />
	) : null;
}
