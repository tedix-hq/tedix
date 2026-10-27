import { type KeyboardEvent, type ReactNode, useEffect, useRef } from "react";
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
	type CanvasDocSelection,
	type CanvasWorkpieceMode,
	canvasDocKey,
} from "@/lib/canvas-search";

/**
 * The workpiece tab strip and its per-document view-mode options. Pure
 * presentation over the shell's opened-document state — selection and URL
 * writes stay in canvas-page.tsx.
 */

/**
 * The open item's views: the item, then for an app Edit (its code, counting
 * the drafts waiting there) and History (its runs). Connections and Review
 * open from the workspace menu; while one is showing it joins the row so the
 * person can see where they are and get back.
 */
export function canvasWorkpieceModeOptions(
	doc: CanvasDocSelection,
	outputKind?: OsOutputKind | null,
	/** Open drafts of a runtime app, counted on the Edit tab. */
	draftCount = 0,
	activeMode: CanvasWorkpieceMode = "workpiece",
): { value: CanvasWorkpieceMode; label: ReactNode }[] {
	return [
		{
			value: "workpiece",
			label:
				doc.type === "gadget" ? "App" : outputWorkshopKindLabel(outputKind),
		},
		...(doc.type === "gadget"
			? [
					{
						value: "edit" as const,
						label:
							draftCount > 0 ? (
								<span className="inline-flex items-center gap-1.5">
									Edit
									<Badge variant="info">{draftCount}</Badge>
								</span>
							) : (
								"Edit"
							),
					},
					{ value: "history" as const, label: "History" },
				]
			: []),
		...(activeMode === "connections"
			? [{ value: "connections" as const, label: "Connections" }]
			: activeMode === "activity"
				? [{ value: "activity" as const, label: "Review" }]
				: []),
	];
}

export const CANVAS_WORKPIECE_PANEL_ID = "canvas-workpiece-panel";

export function canvasWorkpieceTabId(doc: CanvasDocSelection): string {
	return `canvas-workpiece-tab-${encodeURIComponent(canvasDocKey(doc))}`;
}

export function CanvasWorkpieceTabs({
	opened,
	selectedKey,
	gadgets,
	outputs,
	onClose,
	onSelect,
}: {
	opened: readonly CanvasDocSelection[];
	selectedKey: string | null;
	gadgets: readonly { id: string; name: string }[];
	outputs: readonly { id: string; title: string; kind: string }[];
	onClose: (key: string) => void;
	onSelect: (doc: CanvasDocSelection) => void;
}) {
	const stripRef = useRef<HTMLDivElement>(null);
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
		if (event.key !== "Delete") return;
		const tabs = Array.from(
			event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'),
		);
		const current = tabs.indexOf(document.activeElement as HTMLElement);
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
			className="canvas-workpiece-tabs flex-row"
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
							: output?.title;
					const kind =
						doc.type === "gadget" ? "gadget" : (output?.kind ?? null);
					const kindLabel =
						doc.type === "gadget"
							? "App"
							: outputWorkshopKindLabel(
									output?.kind as OsOutputKind | undefined,
								);
					const accessibleName = `${title ?? "Workpiece"} (${kindLabel}, ${doc.id})`;
					const selected = key === selectedKey;
					return (
						<div
							className="canvas-workpiece-tab"
							data-selected={selected || undefined}
							key={key}
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
						</div>
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
