"use client";

import { Tooltip as TooltipPrimitive } from "@cloudflare/kumo/primitives/tooltip";

import { cn } from "@/lib/utils";

function TooltipProvider({
	delay = 0,
	...props
}: TooltipPrimitive.Provider.Props) {
	return <TooltipPrimitive.Provider delay={delay} {...props} />;
}

function Tooltip(props: TooltipPrimitive.Root.Props) {
	return <TooltipPrimitive.Root {...props} />;
}

function TooltipTrigger(props: TooltipPrimitive.Trigger.Props) {
	return <TooltipPrimitive.Trigger {...props} />;
}

function TooltipContent({
	className,
	side = "top",
	sideOffset = 10,
	align = "center",
	alignOffset = 0,
	children,
	...props
}: TooltipPrimitive.Popup.Props &
	Pick<
		TooltipPrimitive.Positioner.Props,
		"align" | "alignOffset" | "side" | "sideOffset"
	>) {
	return (
		<TooltipPrimitive.Portal>
			<TooltipPrimitive.Positioner
				align={align}
				alignOffset={alignOffset}
				side={side}
				sideOffset={sideOffset}
				// The layer sits on the positioner because Base UI's `transform` here
				// is a stacking context; the popup below carried a second `z-50` that
				// could only ever order the arrow against its own siblings.
				className="isolate z-(--tedix-layer-tooltip) max-w-[var(--available-width)]"
			>
				<TooltipPrimitive.Popup
					data-kumo-component="Tooltip"
					className={cn(
						"flex max-w-xs origin-[var(--transform-origin)] flex-col rounded-md bg-kumo-base px-2.5 py-1.5 text-kumo-default type-tedix-control shadow-tedix-floating outline outline-kumo-fill",
						"transition-[transform,scale,opacity] duration-tedix-standard ease-tedix-standard motion-reduce:transition-none data-ending-style:scale-90 data-starting-style:scale-90 data-ending-style:opacity-0 data-starting-style:opacity-0 data-[instant]:duration-0",
						className,
					)}
					{...props}
				>
					<TooltipPrimitive.Arrow
						className={cn(
							"flex text-kumo-base drop-shadow-sm",
							"data-[side=bottom]:top-[-8px] data-[side=left]:right-[-13px] data-[side=left]:rotate-90",
							"data-[side=top]:bottom-[-8px] data-[side=right]:left-[-13px] data-[side=right]:-rotate-90 data-[side=top]:rotate-180",
						)}
					>
						<svg aria-hidden width="20" height="10" viewBox="0 0 20 10">
							<path
								fill="currentColor"
								d="M9.66 2.6 4.8 6.97A4 4 0 0 1 2.13 8H0v2h20V8h-1.47a4 4 0 0 1-2.67-1.03L11 2.6a1 1 0 0 0-1.34 0Z"
							/>
						</svg>
					</TooltipPrimitive.Arrow>
					{children}
				</TooltipPrimitive.Popup>
			</TooltipPrimitive.Positioner>
		</TooltipPrimitive.Portal>
	);
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
