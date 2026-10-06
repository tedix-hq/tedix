"use client";
import { Progress as ProgressPrimitive } from "@cloudflare/kumo/primitives/progress";
import { cn } from "@/lib/utils";
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
				"h-full rounded-full bg-kumo-brand transition-[width] motion-reduce:transition-none",
				className,
			)}
			{...props}
		/>
	);
}
function ProgressLabel({ className, ...props }: ProgressPrimitive.Label.Props) {
	return (
		<ProgressPrimitive.Label
			data-slot="progress-label"
			className={cn("font-medium text-kumo-default", className)}
			{...props}
		/>
	);
}
function ProgressValue({ className, ...props }: ProgressPrimitive.Value.Props) {
	return (
		<ProgressPrimitive.Value
			data-slot="progress-value"
			className={cn("ml-auto text-kumo-subtle tabular-nums", className)}
			{...props}
		/>
	);
}
export {
	Progress,
	ProgressIndicator,
	ProgressLabel,
	ProgressTrack,
	ProgressValue,
};
