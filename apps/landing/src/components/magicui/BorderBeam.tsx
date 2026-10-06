"use client";

import { motion, type MotionStyle, type Transition } from "motion/react";
import { cn } from "@/lib/utils";

interface BorderBeamProps {
	size?: number;
	duration?: number;
	delay?: number;
	colorFrom?: string;
	colorTo?: string;
	transition?: Transition;
	className?: string;
	style?: React.CSSProperties;
	reverse?: boolean;
	initialOffset?: number;
	borderWidth?: number;
}

export function BorderBeam({
	className,
	size = 50,
	delay = 0,
	duration = 6,
	colorFrom = "#ffaa40",
	colorTo = "#9c40ff",
	transition,
	style,
	reverse = false,
	initialOffset = 0,
	borderWidth = 1,
}: BorderBeamProps) {
	return (
		<div
			className="pointer-events-none absolute inset-0 rounded-[inherit]"
			style={{
				border: `${borderWidth}px solid transparent`,
				mask: "linear-gradient(transparent, transparent), linear-gradient(#000, #000)",
				maskComposite: "intersect",
				WebkitMaskComposite: "source-in",
				maskClip: "padding-box, border-box",
				WebkitMaskClip: "padding-box, border-box",
			}}
		>
			<motion.div
				className={cn("absolute aspect-square", "bg-gradient-to-l", className)}
				style={
					{
						width: size,
						offsetPath: `rect(0 auto auto 0 round ${size}px)`,
						backgroundImage: `linear-gradient(to left, ${colorFrom}, ${colorTo}, transparent)`,
						...style,
					} as MotionStyle
				}
				initial={{ offsetDistance: `${initialOffset}%` }}
				animate={{
					offsetDistance: reverse
						? [`${100 - initialOffset}%`, `${-initialOffset}%`]
						: [`${initialOffset}%`, `${100 + initialOffset}%`],
				}}
				transition={{
					repeat: Number.POSITIVE_INFINITY,
					ease: "linear",
					duration,
					delay: -delay,
					...transition,
				}}
			/>
		</div>
	);
}
