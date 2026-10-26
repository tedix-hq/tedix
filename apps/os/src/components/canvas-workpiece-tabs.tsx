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
			const active = strip.querySelector<HTMLElement>("[data-selected]");
			if (!active) return;
			const box = active.getBoundingClientRect();
			const view = strip.getBoundingClientRect();
			if (box.right > view.right)
				strip.scrollLeft += box.right - view.right + 8;
			else if (box.left < view.left)
				strip.scrollLeft -= view.left - box.left + 8;
		};
		reveal();
		const observer = new ResizeObserver(reveal);
		observer.observe(strip);
		return () => observer.disconnect();
	}, [selectedKey, opened, gadgets, outputs]);
	/**
	 * One Tab stop for the strip: the selected tab holds it and the arrows,
	 * Home and End roam it, selecting as they go -- the tablist pattern's
	 * automatic activation. Delete closes the focused tab and hands the stop
	 * to the neighbour the shell selects next.
	 */
	const onTabsKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const strip = stripRef.current;
		if (!strip) return;
		const tabs = Array.from(
			strip.querySelectorAll<HTMLElement>('[role="tab"]'),
		);
		const current = tabs.indexOf(document.activeElement as HTMLElement);
		if (current < 0) return;
		if (event.key === "Delete") {
			const closing = opened[current];
			if (!closing) return;
			event.preventDefault();
			(tabs[current + 1] ?? tabs[current - 1])?.focus();
			onClose(canvasDocKey(closing));
			return;
		}
		const next =
			event.key === "ArrowRight"
				? (current + 1) % tabs.length
				: event.key === "ArrowLeft"
					? (current - 1 + tabs.length) % tabs.length
					: event.key === "Home"
						? 0
						: event.key === "End"
							? tabs.length - 1
							: -1;
		const doc = next >= 0 ? opened[next] : undefined;
		if (!doc) return;
		event.preventDefault();
		tabs[next]?.focus();
		if (canvasDocKey(doc) !== selectedKey) onSelect(doc);
	};
	if (opened.length === 0) return null;
	// With nothing selected the first tab keeps the strip reachable by Tab.
	const focusableKey =
		selectedKey ?? (opened[0] ? canvasDocKey(opened[0]) : null);
	return (
		<div
			ref={stripRef}
			data-focus-ring="inset"
			className="canvas-workpiece-tabs"
			role="tablist"
			aria-label="Open workpieces"
			onKeyDown={onTabsKeyDown}
		>
			{opened.map((doc) => {
				const key = canvasDocKey(doc);
				const tabId = canvasWorkpieceTabId(doc);
				const output = outputs.find((candidate) => candidate.id === doc.id);
				const title =
					doc.type === "gadget"
						? gadgets.find((candidate) => candidate.id === doc.id)?.name
						: output?.title;
				const kind = doc.type === "gadget" ? "gadget" : (output?.kind ?? null);
				const kindLabel =
					doc.type === "gadget"
						? "App"
						: outputWorkshopKindLabel(output?.kind as OsOutputKind | undefined);
				const accessibleName = `${title ?? "Workpiece"} (${kindLabel}, ${doc.id})`;
				const selected = key === selectedKey;
				return (
					<div
						className="canvas-workpiece-tab"
						data-selected={selected || undefined}
						key={key}
					>
						<Button
							aria-label={accessibleName}
							aria-controls={CANVAS_WORKPIECE_PANEL_ID}
							aria-selected={selected}
							id={tabId}
							tabIndex={key === focusableKey ? 0 : -1}
							title={title ?? "Workpiece"}
							className="min-w-0 flex-1 justify-start px-2 type-tedix-control"
							onClick={() => onSelect(doc)}
							role="tab"
							size="sm"
							variant="ghost"
						>
							<TabKindIcon kind={kind} />
							<span className="truncate">{title ?? "Workpiece"}</span>
						</Button>
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
		</div>
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
