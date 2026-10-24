import { CaretDown, Plus } from "@phosphor-icons/react";
import type { OsPresentationCanvasSlide } from "@tedix/api-contract/schemas/os-workspaces";
import { Button } from "@/components/kumo/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/kumo/dropdown-menu";
import { Text } from "@/components/kumo/text";
import { Toolbar } from "@/components/kumo/toolbar";

type SlideLayout = OsPresentationCanvasSlide["layout"];

/** The layouts a new slide can start from; the main button adds the first. */
export const SLIDE_LAYOUTS: readonly {
	layout: SlideLayout;
	name: string;
	description: string;
}[] = [
	{
		layout: "title-content",
		name: "Content",
		description: "Headline with supporting copy",
	},
	{
		layout: "title",
		name: "Title slide",
		description: "Cover with a large headline",
	},
	{
		layout: "two-column",
		name: "Two columns",
		description: "Side-by-side comparison",
	},
	{
		layout: "four-card",
		name: "Four cards",
		description: "Four short points at a glance",
	},
	{ layout: "blank", name: "Blank", description: "An empty slide to build on" },
];

/** A miniature wireframe of a layout, drawn by `.slide-layout-sketch`. */
function LayoutSketch({ layout }: { layout: SlideLayout }) {
	const columns =
		layout === "two-column" ? 2 : layout === "four-card" ? 4 : layout;
	return (
		<span className="slide-layout-sketch" data-layout={layout} aria-hidden>
			{layout === "blank" ? null : <span className="slide-layout-title" />}
			{typeof columns === "number" ? (
				<span className="slide-layout-columns">
					{Array.from({ length: columns }, (_, column) => (
						<span key={column} />
					))}
				</span>
			) : layout === "title-content" ? (
				<span className="slide-layout-lines">
					<span />
					<span />
					<span />
				</span>
			) : null}
		</span>
	);
}

/**
 * Split button: one press adds the standard content slide after the current
 * one; the caret lists every layout with a sketch and a one-line description.
 * The rail shows it as a full-width button; the toolbar keeps a compact one
 * while the rail is closed.
 */
export function AddSlideButton({
	placement,
	disabled,
	onAdd,
}: {
	placement: "rail" | "toolbar";
	disabled?: boolean;
	onAdd: (layout: SlideLayout) => void;
}) {
	const menu = (
		<DropdownMenuContent
			align={placement === "rail" ? "end" : "start"}
			className="w-[min(18rem,calc(100vw-2rem))]"
		>
			{SLIDE_LAYOUTS.map(({ layout, name, description }) => (
				<DropdownMenuItem
					key={layout}
					data-slide-layout={layout}
					className="gap-3 py-2"
					onClick={() => onAdd(layout)}
				>
					<LayoutSketch layout={layout} />
					<span className="grid min-w-0">
						<Text as="span" role="label" weight="medium">
							{name}
						</Text>
						<Text as="span" role="caption" tone="secondary">
							{description}
						</Text>
					</span>
				</DropdownMenuItem>
			))}
		</DropdownMenuContent>
	);
	if (placement === "toolbar")
		return (
			<div className="slides-add-split flex items-center">
				<Toolbar.Button
					type="button"
					disabled={disabled}
					onClick={() => onAdd("title-content")}
				>
					<Plus size={14} /> Add slide
				</Toolbar.Button>
				<DropdownMenu>
					<DropdownMenuTrigger
						disabled={disabled}
						render={
							<Toolbar.Button type="button" aria-label="New slide template" />
						}
					>
						<CaretDown size={12} />
					</DropdownMenuTrigger>
					{menu}
				</DropdownMenu>
			</div>
		);
	return (
		<div className="slides-add-split slides-rail-add">
			<Button
				type="button"
				variant="secondary"
				size="sm"
				className="slides-rail-add-main"
				disabled={disabled}
				onClick={() => onAdd("title-content")}
			>
				<Plus size={14} /> Add slide
			</Button>
			<DropdownMenu>
				<DropdownMenuTrigger
					disabled={disabled}
					render={
						<Button
							type="button"
							variant="secondary"
							size="sm"
							className="slides-rail-add-caret"
							aria-label="New slide template"
						/>
					}
				>
					<CaretDown size={12} />
				</DropdownMenuTrigger>
				{menu}
			</DropdownMenu>
		</div>
	);
}
