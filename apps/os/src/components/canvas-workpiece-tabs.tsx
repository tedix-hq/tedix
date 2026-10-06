import { useEffect, useRef } from "react";
import {
	FileText,
	MonitorPlay,
	PresentationChart,
	SquaresFour,
	Table as TableIcon,
	X,
} from "@phosphor-icons/react";
import type { OsOutputKind } from "@tedix/api-contract/schemas/os-workspaces";
import { Button } from "@/components/kumo/button";
import { outputWorkshopKindLabel } from "@/components/output-workshop";
import { type CanvasDocSelection, canvasDocKey } from "@/lib/canvas-search";

/**
 * The workpiece tab strip and its per-document view-mode options. Pure
 * presentation over the shell's opened-document state — selection and URL
 * writes stay in canvas-page.tsx.
 */

export function canvasWorkpieceModeOptions(
	doc: CanvasDocSelection,
	outputKind?: OsOutputKind | null,
) {
	return [
		{
			value: "workpiece" as const,
			label:
				doc.type === "gadget" ? "App" : outputWorkshopKindLabel(outputKind),
		},
		...(doc.type === "gadget"
			? [
					{ value: "source" as const, label: "Code" },
					{ value: "runs" as const, label: "Runs" },
				]
			: []),
		{ value: "connections" as const, label: "Connections" },
		{ value: "activity" as const, label: "Review" },
	] as const;
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
	if (opened.length === 0) return null;
	return (
		<div
			ref={stripRef}
			className="canvas-workpiece-tabs"
			role="tablist"
			aria-label="Open workpieces"
		>
			{opened.map((doc) => {
				const key = canvasDocKey(doc);
				const title =
					doc.type === "gadget"
						? gadgets.find((candidate) => candidate.id === doc.id)?.name
						: outputs.find((candidate) => candidate.id === doc.id)?.title;
				const selected = key === selectedKey;
				return (
					<div
						className="canvas-workpiece-tab"
						data-selected={selected || undefined}
						key={key}
					>
						<Button
							aria-selected={selected}
							title={title ?? "Workpiece"}
							className="min-w-0 flex-1 justify-start px-2 type-tedix-control"
							onClick={() => onSelect(doc)}
							role="tab"
							size="sm"
							variant="ghost"
						>
							{/*
							 * The kind icon is what distinguishes tabs when several
							 * artifacts share a title -- three "Q3 Review" tabs are
							 * unreadable as text alone. Same icon set as the Outputs
							 * library cards.
							 */}
							<TabKindIcon
								kind={
									doc.type === "gadget"
										? "gadget"
										: (outputs.find((candidate) => candidate.id === doc.id)
												?.kind ?? null)
								}
							/>
							<span className="truncate">{title ?? "Workpiece"}</span>
						</Button>
						<Button
							aria-label={`Close ${title ?? "workpiece"}`}
							className="shrink-0"
							onClick={() => onClose(key)}
							size="icon-sm"
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
