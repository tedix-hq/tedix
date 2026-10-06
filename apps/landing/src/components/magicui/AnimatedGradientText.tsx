"use client";

import type { ReactNode } from "react";

interface AnimatedGradientTextProps {
	children: ReactNode;
	className?: string;
	speed?: string;
	colorFrom?: string;
	colorTo?: string;
}

export function AnimatedGradientText({
	children,
	className = "",
	speed = "3s",
	colorFrom = "#f59e0b",
	colorTo = "#ea580c",
}: AnimatedGradientTextProps) {
	return (
		<span
			className={`animate-gradient bg-[length:200%_auto] bg-clip-text text-transparent ${className}`}
			style={{
				backgroundImage: `linear-gradient(to right, ${colorFrom}, ${colorTo}, ${colorFrom})`,
				animationDuration: speed,
			}}
		>
			{children}
		</span>
	);
}
