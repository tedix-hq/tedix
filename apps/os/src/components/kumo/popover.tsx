import {
	Popover as KumoPopover,
	PopoverDescription as KumoPopoverDescription,
	PopoverRoot as KumoPopoverRoot,
	PopoverTitle as KumoPopoverTitle,
	PopoverTrigger as KumoPopoverTrigger,
} from "@cloudflare/kumo/components/popover";
import { Popover as PopoverPrimitive } from "@cloudflare/kumo/primitives/popover";
import type { ComponentProps } from "react";
import type { PopoverContentProps as KumoContentProps } from "@cloudflare/kumo/components/popover";

import { cn } from "@/lib/utils";

type PopoverContentProps = KumoContentProps &
	Pick<
		ComponentProps<typeof PopoverPrimitive.Popup>,
		"initialFocus" | "finalFocus"
	>;

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
		<PopoverPrimitive.Portal container={container}>
			<PopoverPrimitive.Positioner
				anchor={anchor}
				align={align}
				alignOffset={alignOffset}
				side={side}
				sideOffset={sideOffset}
				positionMethod={positionMethod}
				className="isolate z-(--tedix-layer-dropdown)"
			>
				<PopoverPrimitive.Popup
					className={cn(
						"kumo-popover-popup flex origin-(--transform-origin) flex-col rounded-lg bg-kumo-base px-4 py-3 text-kumo-default type-tedix-body shadow-tedix-floating outline outline-kumo-line",
						"transition-[transform,scale,opacity] duration-tedix-standard ease-tedix-standard motion-reduce:transition-none data-ending-style:scale-90 data-starting-style:scale-90 data-ending-style:opacity-0 data-starting-style:opacity-0 data-[instant]:duration-0",
						className,
					)}
					{...props}
				>
					<PopoverPrimitive.Arrow
						className={cn(
							"flex text-kumo-base drop-shadow-sm",
							"data-[side=bottom]:-top-2 data-[side=left]:right-[-13px] data-[side=left]:rotate-90",
							"data-[side=right]:left-[-13px] data-[side=right]:-rotate-90 data-[side=top]:-bottom-2 data-[side=top]:rotate-180",
						)}
					>
						<svg aria-hidden width="20" height="10" viewBox="0 0 20 10">
							<path
								fill="currentColor"
								d="M9.66 2.6 4.8 6.97A4 4 0 0 1 2.13 8H0v2h20V8h-1.47a4 4 0 0 1-2.67-1.03L11 2.6a1 1 0 0 0-1.34 0Z"
							/>
						</svg>
					</PopoverPrimitive.Arrow>
					{children}
				</PopoverPrimitive.Popup>
			</PopoverPrimitive.Positioner>
		</PopoverPrimitive.Portal>
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
