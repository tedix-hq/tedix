"use client";

import React, {
	type ComponentPropsWithoutRef,
	type CSSProperties,
} from "react";
import { cn } from "@/lib/utils";

export interface ShimmerButtonProps extends ComponentPropsWithoutRef<"button"> {
	shimmerColor?: string;
	shimmerSize?: string;
	borderRadius?: string;
	shimmerDuration?: string;
	background?: string;
	children?: React.ReactNode;
}

export const ShimmerButton = React.forwardRef<
	HTMLButtonElement,
	ShimmerButtonProps
>(
	(
		{
			shimmerColor = "#ffffff",
			shimmerSize = "0.05em",
			shimmerDuration = "3s",
			borderRadius = "100px",
			background = "rgba(0, 0, 0, 1)",
			className,
			children,
			...props
		},
		ref,
	) => {
		return (
			<button
				style={
					{
						"--spread": "90deg",
						"--shimmer-color": shimmerColor,
						"--radius": borderRadius,
						"--speed": shimmerDuration,
						"--cut": shimmerSize,
						"--bg": background,
					} as CSSProperties
				}
				className={cn(
					"group relative z-0 flex cursor-pointer items-center justify-center overflow-hidden whitespace-nowrap border border-white/10 px-6 py-3 text-white [background:var(--bg)] [border-radius:var(--radius)]",
					"transform-gpu transition-transform duration-300 ease-in-out active:translate-y-px",
					className,
				)}
				ref={ref}
				{...props}
			>
				{/* spark container */}
				<div className="-z-30 absolute inset-0 overflow-visible blur-[2px]">
					<div className="animate-shimmer-slide absolute inset-0 aspect-square h-full [mask:none]">
						<div className="animate-spin-around absolute -inset-full w-auto rotate-0 [background:conic-gradient(from_calc(270deg-(var(--spread)*0.5)),transparent_0,var(--shimmer-color)_var(--spread),transparent_var(--spread))]" />
					</div>
				</div>
				{children}

				{/* Highlight */}
				<div
					className={cn(
						"absolute inset-0 size-full",
						"rounded-2xl px-4 py-1.5 text-sm font-medium shadow-[inset_0_-8px_10px_#ffffff1f]",
						"transform-gpu transition-all duration-300 ease-in-out",
						"group-hover:shadow-[inset_0_-6px_10px_#ffffff3f]",
						"group-active:shadow-[inset_0_-10px_10px_#ffffff3f]",
					)}
				/>

				{/* backdrop */}
				<div className="absolute -z-20 inset-[var(--cut)] [background:var(--bg)] [border-radius:var(--radius)]" />
			</button>
		);
	},
);

ShimmerButton.displayName = "ShimmerButton";
