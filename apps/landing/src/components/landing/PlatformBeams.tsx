"use client";

import { forwardRef, useRef } from "react";
import { cn } from "@/lib/utils";
import { AnimatedBeam } from "../magicui/AnimatedBeam";

const Circle = forwardRef<
	HTMLDivElement,
	{ className?: string; children?: React.ReactNode }
>(({ className, children }, ref) => {
	return (
		<div
			ref={ref}
			className={cn(
				"z-10 flex size-12 items-center justify-center rounded-full border-2 border-border/60 bg-background p-2.5 shadow-md",
				className,
			)}
		>
			{children}
		</div>
	);
});
Circle.displayName = "Circle";

export function PlatformBeams({ className }: { className?: string }) {
	const containerRef = useRef<HTMLDivElement>(null);
	const tediRef = useRef<HTMLDivElement>(null);
	const chatgptRef = useRef<HTMLDivElement>(null);
	const claudeRef = useRef<HTMLDivElement>(null);
	const geminiRef = useRef<HTMLDivElement>(null);
	const copilotRef = useRef<HTMLDivElement>(null);
	const perplexityRef = useRef<HTMLDivElement>(null);

	return (
		<div
			className={cn(
				"relative flex w-full items-center justify-center overflow-hidden rounded-2xl border border-border/40 bg-muted/30 p-8 md:p-12",
				className,
			)}
			ref={containerRef}
		>
			<div className="flex size-full max-w-lg flex-row items-stretch justify-between gap-10">
				{/* Left: Tedi */}
				<div className="flex flex-col justify-center">
					<Circle
						ref={tediRef}
						className="size-16 border-amber-500/40 shadow-lg shadow-amber-500/10"
					>
						<div className="flex h-full w-full items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-orange-500 text-sm font-bold text-white">
							t
						</div>
					</Circle>
				</div>

				{/* Right: Platforms */}
				<div className="flex flex-col justify-center gap-3">
					<Circle ref={chatgptRef}>
						<img
							src="/images/apps/openai-icon.png"
							alt="ChatGPT"
							className="size-6"
						/>
					</Circle>
					<Circle ref={claudeRef}>
						<img
							src="/images/apps/anthropic-icon.png"
							alt="Claude"
							className="size-6"
						/>
					</Circle>
					<Circle ref={geminiRef}>
						<img
							src="/images/apps/google-icon.png"
							alt="Gemini"
							className="size-6"
						/>
					</Circle>
					<Circle ref={copilotRef}>
						<img
							src="/images/apps/microsoft-icon.png"
							alt="Copilot"
							className="size-6"
						/>
					</Circle>
					<Circle ref={perplexityRef}>
						<img
							src="/images/apps/perplexity-icon.png"
							alt="Perplexity"
							className="size-6"
						/>
					</Circle>
				</div>
			</div>

			{/* Beams */}
			<AnimatedBeam
				containerRef={containerRef}
				fromRef={tediRef}
				toRef={chatgptRef}
				gradientStartColor="#f59e0b"
				gradientStopColor="#ea580c"
				duration={4}
			/>
			<AnimatedBeam
				containerRef={containerRef}
				fromRef={tediRef}
				toRef={claudeRef}
				gradientStartColor="#f59e0b"
				gradientStopColor="#ea580c"
				duration={4}
				delay={0.5}
			/>
			<AnimatedBeam
				containerRef={containerRef}
				fromRef={tediRef}
				toRef={geminiRef}
				gradientStartColor="#f59e0b"
				gradientStopColor="#ea580c"
				duration={4}
				delay={1}
			/>
			<AnimatedBeam
				containerRef={containerRef}
				fromRef={tediRef}
				toRef={copilotRef}
				gradientStartColor="#f59e0b"
				gradientStopColor="#ea580c"
				duration={4}
				delay={1.5}
			/>
			<AnimatedBeam
				containerRef={containerRef}
				fromRef={tediRef}
				toRef={perplexityRef}
				gradientStartColor="#f59e0b"
				gradientStopColor="#ea580c"
				duration={4}
				delay={2}
			/>
		</div>
	);
}
