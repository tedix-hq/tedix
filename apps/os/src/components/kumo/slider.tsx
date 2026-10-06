import { Slider as SliderPrimitive } from "@cloudflare/kumo/primitives/slider";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

type SliderProps = Omit<
	SliderPrimitive.Root.Props<number>,
	"children" | "className"
> & {
	ariaLabel: string;
	className?: string;
};

/** Kumo's Base UI Slider behavior with Tedix's compact console geometry. */
function Slider({ ariaLabel, className, ...props }: SliderProps) {
	return (
		<SliderPrimitive.Root
			data-slot="slider"
			className={cn(
				"relative flex min-h-7 w-full touch-none select-none items-center max-sm:min-h-11 coarse:min-h-11",
				className,
			)}
			{...props}
		>
			<SliderPrimitive.Control className="flex h-5 w-full items-center">
				<SliderPrimitive.Track
					data-slot="slider-track"
					className="relative h-1.5 w-full overflow-hidden rounded-full bg-kumo-fill"
				>
					<SliderPrimitive.Indicator
						data-slot="slider-indicator"
						className="h-full rounded-full bg-kumo-brand"
					/>
				</SliderPrimitive.Track>
				<SliderPrimitive.Thumb
					data-slot="slider-thumb"
					getAriaLabel={() => ariaLabel}
					className="size-4 rounded-full bg-kumo-base shadow-tedix-control ring-2 ring-kumo-brand outline-none transition-shadow duration-tedix-standard motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-kumo-focus focus-visible:ring-offset-2 focus-visible:ring-offset-kumo-base disabled:pointer-events-none disabled:opacity-50"
				/>
			</SliderPrimitive.Control>
		</SliderPrimitive.Root>
	);
}

export { Slider, type SliderProps };
