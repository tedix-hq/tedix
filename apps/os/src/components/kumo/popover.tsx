import {
	Popover as KumoPopover,
	PopoverDescription as KumoPopoverDescription,
	PopoverRoot as KumoPopoverRoot,
	PopoverTitle as KumoPopoverTitle,
	PopoverTrigger as KumoPopoverTrigger,
} from "@cloudflare/kumo/components/popover";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

type PopoverContentProps = Pick<
	ComponentProps<typeof KumoPopover.Positioner>,
	"anchor" | "align" | "alignOffset" | "side" | "sideOffset" | "positionMethod"
> &
	Pick<ComponentProps<typeof KumoPopover.Portal>, "container"> &
	Pick<
		ComponentProps<typeof KumoPopover.Popup>,
		"children" | "initialFocus" | "finalFocus"
	> & { className?: string };

/**
 * Kumo's non-modal overlay. Use this for transient anchored panels instead of
 * a modal Sheet or Dialog, which traps focus and locks document scroll.
 */
const Popover = KumoPopover;
const PopoverRoot = KumoPopoverRoot;
const PopoverTrigger = KumoPopoverTrigger;
const PopoverTitle = KumoPopoverTitle;
const PopoverDescription = KumoPopoverDescription;

/*
 * Kumo's popup already scale-fades on `data-starting-style`/`data-ending-style`,
 * but on its own `duration-150` with the default easing and no reduced-motion
 * path. Re-key it onto the shared overlay-entry contract so a popover, a select
 * popup, and a tooltip all enter the same way. `cn` (tailwind-merge) replaces
 * Kumo's duration rather than stacking a second one.
 */
function PopoverContent({
	className,
	children,
	side = "bottom",
	align = "center",
	sideOffset = 8,
	alignOffset = 0,
	positionMethod = "absolute",
	anchor,
	container,
	...props
}: PopoverContentProps) {
	return (
		<KumoPopover.Portal container={container}>
			<KumoPopover.Positioner
				anchor={anchor}
				align={align}
				alignOffset={alignOffset}
				side={side}
				sideOffset={sideOffset}
				positionMethod={positionMethod}
				className="isolate z-(--tedix-layer-dropdown)"
			>
				<KumoPopover.Popup
					className={cn(
						"max-h-[var(--available-height)] max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain type-tedix-body shadow-tedix-floating",
						"duration-tedix-standard ease-tedix-standard motion-reduce:transition-none data-[instant]:duration-0",
						className,
					)}
					{...props}
				>
					<KumoPopover.Arrow className="text-kumo-base drop-shadow-sm" />
					{children}
				</KumoPopover.Popup>
			</KumoPopover.Positioner>
		</KumoPopover.Portal>
	);
}

export {
	Popover,
	PopoverContent,
	type PopoverContentProps,
	PopoverDescription,
	PopoverRoot,
	PopoverTitle,
	PopoverTrigger,
};
