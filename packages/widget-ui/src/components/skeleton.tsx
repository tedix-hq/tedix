import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../lib/utils";

/**
 * Speed class mappings for animation duration
 */
const SPEED_CLASSES: Record<string, string> = {
	slow: "duration-[2s]",
	normal: "duration-[1.6s]",
	fast: "duration-[1s]",
};

const skeletonVariants = cva("", {
	variants: {
		variant: {
			default: "rounded-md",
			circular: "rounded-full",
			rectangular: "rounded-none",
		},
		tone: {
			subtle: "bg-muted/50",
			moderate: "bg-muted",
			pronounced: "bg-muted-foreground/30",
		},
	},
	defaultVariants: {
		variant: "default",
		tone: "moderate",
	},
});

interface SkeletonProps
	extends React.ComponentProps<"div">, VariantProps<typeof skeletonVariants> {
	/** Enable wave animation. Default: true */
	animate?: boolean;
	/** Animation speed for pulse or wave animations */
	speed?: "slow" | "normal" | "fast";
	/**
	 * Shimmer/wave animation direction for RTL language support.
	 * - "ltr": Wave animates left-to-right (default, for LTR languages)
	 * - "rtl": Wave animates right-to-left (for RTL languages like Arabic, Hebrew)
	 * @note Only applies when animate=true
	 * @default "ltr"
	 */
	direction?: "ltr" | "rtl";
}

function Skeleton({
	className,
	variant,
	animate = true,
	speed = "normal",
	direction = "ltr",
	tone,
	style,
	...props
}: SkeletonProps) {
	const speedClass = SPEED_CLASSES[speed] ?? SPEED_CLASSES.normal;

	// Animation duration in seconds
	const durationMap = {
		slow: 2,
		normal: 1.6,
		fast: 1,
	};
	const duration = durationMap[speed];

	return (
		<div
			data-slot="skeleton"
			className={cn(
				skeletonVariants({ variant, tone }),
				animate && "skeleton--animated relative overflow-hidden",
				!animate && "animate-pulse",
				!animate && speedClass,
				className,
			)}
			style={
				{
					"--skeleton-duration": `${duration}s`,
					"--skeleton-direction": direction === "ltr" ? "1" : "-1",
					...style,
				} as React.CSSProperties
			}
			{...props}
		/>
	);
}

export { Skeleton, skeletonVariants, type SkeletonProps };
