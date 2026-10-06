import { Progress as ProgressPrimitive } from "@cloudflare/kumo/primitives/progress";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

function Progress({
	className,
	children,
	value,
	...props
}: ProgressPrimitive.Root.Props) {
	return (
		<ProgressPrimitive.Root
			value={value}
			data-slot="progress"
			className={cn("flex flex-wrap gap-3", className)}
			{...props}
		>
			{children ?? (
				<ProgressTrack>
					<ProgressIndicator />
				</ProgressTrack>
			)}
		</ProgressPrimitive.Root>
	);
}

function ProgressTrack({ className, ...props }: ProgressPrimitive.Track.Props) {
	return (
		<ProgressPrimitive.Track
			data-slot="progress-track"
			className={cn(
				"relative flex h-2 w-full items-center overflow-x-hidden rounded-full bg-kumo-fill",
				className,
			)}
			{...props}
		/>
	);
}

function ProgressIndicator({
	className,
	...props
}: ProgressPrimitive.Indicator.Props) {
	return (
		<ProgressPrimitive.Indicator
			data-slot="progress-indicator"
			className={cn(
				"h-full rounded-full bg-kumo-brand transition-[width] duration-tedix-structural ease-tedix-standard motion-reduce:transition-none",
				className,
			)}
			{...props}
		/>
	);
}

export { Progress, ProgressIndicator, ProgressTrack };
