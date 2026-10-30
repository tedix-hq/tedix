import { Collapsible as KumoCollapsible } from "@cloudflare/kumo/components/collapsible";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

const Collapsible = KumoCollapsible.Root;

function CollapsibleTrigger({
	className,
	...props
}: ComponentProps<typeof KumoCollapsible.Trigger>) {
	return (
		<KumoCollapsible.Trigger
			data-kumo-component="CollapsibleTrigger"
			className={cn(
				"inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 py-1 text-left text-kumo-subtle type-tedix-control transition-colors hover:bg-kumo-tint hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-kumo-focus motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-50 max-sm:min-h-11 coarse:min-h-11",
				className,
			)}
			{...props}
		/>
	);
}

/*
 * Kumo's raw panel snaps. Base UI publishes the collapsed/expanded extremes as
 * `data-starting-style`/`data-ending-style` plus a measured
 * `--collapsible-panel-height`, so the disclosure motion the design contract
 * allows is a height/opacity transition between those two states — the same
 * shape Kumo uses for its own `Collapsible.DefaultPanel`, on Tedix tokens.
 * The clip is what keeps the content hidden while the height runs. It is
 * `overflow: clip` with a ring-wide margin rather than `overflow: hidden`, so a
 * full-width field or button inside an open panel keeps its border and focus
 * ring instead of losing the edge that touches the panel.
 */
function CollapsibleContent({
	className,
	...props
}: ComponentProps<typeof KumoCollapsible.Panel>) {
	return (
		<KumoCollapsible.Panel
			className={cn(
				"h-[var(--collapsible-panel-height)] overflow-clip [overflow-clip-margin:0.25rem] transition-[height,opacity] duration-tedix-standard ease-tedix-standard motion-reduce:transition-none data-ending-style:h-0 data-starting-style:h-0 data-ending-style:opacity-0 data-starting-style:opacity-0",
				className,
			)}
			{...props}
		/>
	);
}

function CollapsibleDefaultTrigger({
	className,
	...props
}: ComponentProps<typeof KumoCollapsible.DefaultTrigger>) {
	return (
		<KumoCollapsible.DefaultTrigger
			className={cn(
				"min-h-8 max-w-full rounded-md px-2 py-1 text-left type-tedix-control hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-kumo-focus max-sm:min-h-11 coarse:min-h-11 [&>span:first-child]:min-w-0 [&>span:first-child]:wrap-anywhere motion-reduce:[&_svg]:transition-none",
				className,
			)}
			{...props}
		/>
	);
}

function CollapsibleDefaultContent({
	className,
	...props
}: ComponentProps<typeof KumoCollapsible.DefaultPanel>) {
	return (
		<KumoCollapsible.DefaultPanel
			className={cn(
				"min-w-0 overflow-clip [overflow-clip-margin:0.25rem] duration-tedix-standard ease-tedix-standard motion-reduce:transition-none [&>div]:min-w-0",
				className,
			)}
			{...props}
		/>
	);
}

export {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
	CollapsibleDefaultTrigger,
	CollapsibleDefaultContent,
};
