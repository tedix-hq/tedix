"use client";

import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";

/* ── Binary Rain Column ─────────────────────────────── */
function BinaryColumn({
	delay,
	left,
	speed,
	seed,
}: {
	delay: number;
	left: string;
	speed: number;
	seed: number;
}) {
	const chars = useMemo(
		() =>
			Array.from({ length: 30 }, (_, i) => ({
				bit: (seed * 7 + i * 13) % 2 === 0 ? "1" : "0",
				opacity: 0.3 + ((seed * 3 + i * 11) % 7) / 10,
			})),
		[seed],
	);
	return (
		<div
			className="absolute top-0 flex flex-col gap-0 font-mono text-[10px] leading-[14px] text-violet-600/[0.06] select-none pointer-events-none dark:text-violet-400/[0.08]"
			style={{
				left,
				animation: `binaryRain ${speed}s linear ${delay}s infinite`,
			}}
			aria-hidden="true"
		>
			{chars.map((c, i) => (
				<span
					key={i}
					className="binary-bit"
					data-bit={c.bit}
					style={{ opacity: c.opacity }}
				/>
			))}
		</div>
	);
}

/* ── Floating Capability Node ───────────────────────── */
function CapNode({
	icon,
	label,
	x,
	y,
	delay,
}: {
	icon: React.ReactNode;
	label: string;
	x: string;
	y: string;
	delay: number;
}) {
	return (
		<div
			className="absolute z-30 flex items-center gap-2 rounded-full border border-violet-300/30 bg-white/60 px-3 py-1.5 backdrop-blur-md shadow-[0_0_12px_rgba(139,92,246,0.1)] dark:border-violet-400/15 dark:bg-violet-900/30 dark:shadow-[0_0_12px_rgba(139,92,246,0.15)]"
			style={{
				left: x,
				top: y,
				animation: `nodeFloat 4s ease-in-out ${delay}s infinite, nodeFadeIn 1s ease-out ${delay * 0.5}s both`,
			}}
		>
			<span className="text-violet-500 dark:text-violet-300/80">{icon}</span>
			<span className="text-[10px] font-medium text-violet-600/70 whitespace-nowrap hidden sm:inline dark:text-violet-200/70">
				{label}
			</span>
		</div>
	);
}

/* ── Animated Neural Line (SVG) ─────────────────────── */
function NeuralLine({
	d,
	delay,
	color,
}: {
	d: string;
	delay: number;
	color: string;
}) {
	return (
		<>
			<path
				d={d}
				fill="none"
				stroke={color}
				strokeWidth="2.5"
				strokeLinecap="round"
				opacity="0.25"
				filter="url(#neuralGlow)"
				style={{
					strokeDasharray: "600",
					strokeDashoffset: "600",
					animation: `neuralDraw 3s ease-out ${delay}s forwards`,
				}}
			/>
			<path
				d={d}
				fill="none"
				stroke={color}
				strokeWidth="1"
				strokeLinecap="round"
				opacity="0.5"
				style={{
					strokeDasharray: "600",
					strokeDashoffset: "600",
					animation: `neuralDraw 3s ease-out ${delay}s forwards`,
				}}
			/>
			<circle r="3" fill={color} opacity="0.8" filter="url(#neuralGlow)">
				<animateMotion
					dur="4s"
					repeatCount="indefinite"
					begin={`${delay + 2}s`}
					path={d}
				/>
			</circle>
		</>
	);
}

/* ── Main Hero Brain Component ──────────────────────────
   Absolutely positioned over the entire hero section.
   The image fills the right half and bleeds into the background.
   ────────────────────────────────────────────────────── */
export function HeroBrain({
	className,
	variant = "desktop",
}: {
	className?: string;
	variant?: "desktop" | "mobile";
}) {
	const [loaded, setLoaded] = useState(false);
	const isMobile = variant === "mobile";

	const columns = useMemo(
		() =>
			Array.from({ length: 22 }, (_, i) => ({
				delay: (i * 3.7) % 8,
				left: `${(i / 22) * 100}%`,
				speed: 12 + ((i * 2.3) % 10),
			})),
		[],
	);

	return (
		<div
			className={cn(
				"absolute inset-0 overflow-hidden pointer-events-none",
				className,
			)}
		>
			{/* ── Binary Rain (full width, very subtle) ── */}
			<div
				className={cn(
					"absolute inset-0 overflow-hidden",
					isMobile ? "opacity-35" : "opacity-50",
				)}
			>
				{columns.map((col, i) => (
					<BinaryColumn key={i} {...col} seed={i} />
				))}
			</div>

			{/* ── Large ambient glows (set the mood) ── */}
			<div className="absolute -top-40 right-[-10%] h-[700px] w-[700px] rounded-full bg-violet-300/15 blur-[150px] dark:bg-violet-600/20" />
			<div className="absolute top-[20%] right-[10%] h-[400px] w-[400px] rounded-full bg-fuchsia-300/10 blur-[120px] dark:bg-fuchsia-500/15" />
			<div className="absolute bottom-[-10%] right-[5%] h-[350px] w-[350px] rounded-full bg-orange-300/8 blur-[100px] dark:bg-orange-500/12" />
			<div className="absolute top-[40%] left-[30%] h-[300px] w-[300px] rounded-full bg-violet-200/8 blur-[100px] dark:bg-violet-500/8" />

			{/* ── Neural Connection Lines (SVG overlay, full section) ── */}
			<svg
				className="absolute inset-0 h-full w-full z-10"
				viewBox="0 0 1200 700"
				preserveAspectRatio={isMobile ? "xMidYMid slice" : "xMaxYMid slice"}
			>
				<defs>
					<filter id="neuralGlow" x="-50%" y="-50%" width="200%" height="200%">
						<feGaussianBlur in="SourceGraphic" stdDeviation="5" />
					</filter>
					{/* Mask to fade both ends of the lines */}
					<linearGradient id="lineFade" x1="0%" y1="0%" x2="100%" y2="0%">
						<stop offset="0%" stopColor="white" stopOpacity="0" />
						<stop offset="15%" stopColor="white" stopOpacity="1" />
						<stop offset="80%" stopColor="white" stopOpacity="1" />
						<stop offset="100%" stopColor="white" stopOpacity="0" />
					</linearGradient>
					<mask id="lineFadeMask">
						<rect x="0" y="0" width="1200" height="700" fill="url(#lineFade)" />
					</mask>
				</defs>
				{/* Lines flowing from brain (right) outward to left — faded at both ends */}
				<g mask="url(#lineFadeMask)">
					<NeuralLine
						d="M 900 250 C 800 220 650 180 500 170 Q 400 160 280 175"
						delay={0.5}
						color="#c084fc"
					/>
					<NeuralLine
						d="M 880 300 C 780 285 620 260 470 250 Q 360 240 220 260"
						delay={0.8}
						color="#e879f9"
					/>
					<NeuralLine
						d="M 890 360 C 790 355 640 340 480 340 Q 370 340 240 360"
						delay={1.1}
						color="#f472b6"
					/>
					<NeuralLine
						d="M 880 380 C 750 400 580 430 400 470 Q 280 500 100 540"
						delay={1.4}
						color="#fb923c"
					/>
					<NeuralLine
						d="M 910 200 C 830 170 700 130 560 120 Q 450 110 320 130"
						delay={1.7}
						color="#a78bfa"
					/>
				</g>
			</svg>

			{/* ── The Brain Image — large, pulled back so full face is visible ── */}
			<div
				className={cn(
					"absolute top-1/2 z-[15] -translate-y-1/2",
					isMobile
						? "left-1/2 w-[118%] max-w-[560px] -translate-x-1/2"
						: "right-[3%] w-[66%] max-w-[900px] sm:min-w-[400px] lg:right-[1%] lg:w-[70%]",
				)}
			>
				{/* Pulsing glow behind image */}
				<div
					className="absolute inset-[-20%] rounded-full bg-gradient-to-br from-violet-300/20 via-fuchsia-300/10 to-orange-300/10 blur-[80px] dark:from-violet-500/25 dark:via-fuchsia-500/15 dark:to-orange-500/15"
					style={{ animation: "brainPulse 4s ease-in-out infinite" }}
				/>

				{/* Light mode image */}
				<img
					src="/images/hero-brain-light.jpg"
					alt="Human mind merging with artificial intelligence — neural pathways and digital data streams flowing from a human brain profile"
					width={750}
					height={500}
					className={cn(
						"relative h-auto w-full drop-shadow-[0_0_40px_rgba(139,92,246,0.15)] transition-opacity duration-1000 dark:hidden",
						loaded ? "opacity-100" : "opacity-0",
					)}
					style={{
						maskImage: isMobile
							? "linear-gradient(to right, transparent 0%, black 12%, black 90%, transparent 100%), linear-gradient(to bottom, transparent 0%, black 10%, black 88%, transparent 100%)"
							: "linear-gradient(to right, transparent 0%, black 22%, black 88%, transparent 100%), linear-gradient(to bottom, transparent 0%, black 12%, black 82%, transparent 100%)",
						maskComposite: "intersect",
						WebkitMaskImage: isMobile
							? "linear-gradient(to right, transparent 0%, black 12%, black 90%, transparent 100%), linear-gradient(to bottom, transparent 0%, black 10%, black 88%, transparent 100%)"
							: "linear-gradient(to right, transparent 0%, black 22%, black 88%, transparent 100%), linear-gradient(to bottom, transparent 0%, black 12%, black 82%, transparent 100%)",
						WebkitMaskComposite: "source-in",
					}}
					onLoad={() => setLoaded(true)}
				/>
				{/* Dark mode image */}
				<img
					src="/images/hero-brain.jpg"
					alt="Human mind merging with artificial intelligence — neural pathways and digital data streams flowing from a human brain profile"
					width={750}
					height={500}
					className={cn(
						"relative h-auto w-full drop-shadow-[0_0_60px_rgba(139,92,246,0.35)] transition-opacity duration-1000 hidden dark:block",
						loaded ? "opacity-100" : "opacity-0",
					)}
					style={{
						maskImage: isMobile
							? "linear-gradient(to right, transparent 0%, black 12%, black 86%, transparent 100%), linear-gradient(to bottom, transparent 0%, black 10%, black 86%, transparent 100%)"
							: "linear-gradient(to right, transparent 0%, black 20%, black 72%, transparent 100%), linear-gradient(to bottom, transparent 0%, black 12%, black 80%, transparent 100%)",
						maskComposite: "intersect",
						WebkitMaskImage: isMobile
							? "linear-gradient(to right, transparent 0%, black 12%, black 86%, transparent 100%), linear-gradient(to bottom, transparent 0%, black 10%, black 86%, transparent 100%)"
							: "linear-gradient(to right, transparent 0%, black 20%, black 72%, transparent 100%), linear-gradient(to bottom, transparent 0%, black 12%, black 80%, transparent 100%)",
						WebkitMaskComposite: "source-in",
					}}
					onLoad={() => setLoaded(true)}
				/>
			</div>

			{/* ── Capability Nodes — at the origin of the neural lines (center area, not over text) ── */}
			<div className={isMobile ? "hidden sm:block" : undefined}>
				{/* Automation — top line origin */}
				<CapNode
					icon={
						<svg
							xmlns="http://www.w3.org/2000/svg"
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
							<circle cx="12" cy="12" r="3" />
						</svg>
					}
					label="Automation"
					x="58%"
					y="18%"
					delay={0.5}
				/>
				{/* Analytics */}
				<CapNode
					icon={
						<svg
							xmlns="http://www.w3.org/2000/svg"
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<path d="M12 2a10 10 0 1 0 10 10H12V2z" />
							<path d="M20.66 7A10 10 0 0 0 12 2v10h10a10 10 0 0 0-.34-5z" />
						</svg>
					}
					label="Analytics"
					x="48%"
					y="28%"
					delay={0.8}
				/>
				{/* Skills */}
				<CapNode
					icon={
						<svg
							xmlns="http://www.w3.org/2000/svg"
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
						</svg>
					}
					label="Skills"
					x="56%"
					y="50%"
					delay={1.1}
				/>
				{/* Workflows */}
				<CapNode
					icon={
						<svg
							xmlns="http://www.w3.org/2000/svg"
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<polyline points="16 3 21 3 21 8" />
							<line x1="4" x2="21" y1="20" y2="3" />
							<polyline points="21 16 21 21 16 21" />
							<line x1="15" x2="21" y1="15" y2="21" />
							<line x1="4" x2="9" y1="4" y2="4" />
						</svg>
					}
					label="Workflows"
					x="53%"
					y="66%"
					delay={1.4}
				/>
				{/* Knowledge */}
				<CapNode
					icon={
						<svg
							xmlns="http://www.w3.org/2000/svg"
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<circle cx="12" cy="12" r="10" />
							<path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
							<path d="M2 12h20" />
						</svg>
					}
					label="Knowledge"
					x="60%"
					y="80%"
					delay={1.7}
				/>
			</div>

			{/* ── Animated glow orbs — scattered on and around the brain ── */}
			{/* Brain core area — bright, warm */}
			<div
				className="absolute top-[28%] right-[22%] h-3 w-3 rounded-full bg-orange-400 shadow-[0_0_20px_rgba(251,146,60,0.9)] z-20"
				style={{ animation: "orbPulse 3s ease-in-out 0.3s infinite" }}
			/>
			<div
				className="absolute top-[32%] right-[18%] h-2 w-2 rounded-full bg-amber-300 shadow-[0_0_14px_rgba(252,211,77,0.8)] z-20"
				style={{ animation: "orbPulse 2.5s ease-in-out 1.2s infinite" }}
			/>
			<div
				className="absolute top-[25%] right-[26%] h-2.5 w-2.5 rounded-full bg-fuchsia-400 shadow-[0_0_16px_rgba(232,121,249,0.9)] z-20"
				style={{ animation: "orbPulse 3.5s ease-in-out 0.8s infinite" }}
			/>
			{/* Brain top */}
			<div
				className="absolute top-[18%] right-[20%] h-2 w-2 rounded-full bg-violet-400 shadow-[0_0_14px_rgba(167,139,250,0.8)] z-20"
				style={{ animation: "orbPulse 4s ease-in-out 0.5s infinite" }}
			/>
			<div
				className="absolute top-[15%] right-[28%] h-1.5 w-1.5 rounded-full bg-violet-300 shadow-[0_0_10px_rgba(196,181,253,0.7)] z-20"
				style={{ animation: "orbPulse 3s ease-in-out 2s infinite" }}
			/>
			{/* Brain back (left of brain) */}
			<div
				className="absolute top-[35%] right-[30%] h-2 w-2 rounded-full bg-fuchsia-500 shadow-[0_0_14px_rgba(217,70,239,0.8)] z-20"
				style={{ animation: "orbPulse 3.2s ease-in-out 1.5s infinite" }}
			/>
			<div
				className="absolute top-[42%] right-[28%] h-1.5 w-1.5 rounded-full bg-violet-400 shadow-[0_0_10px_rgba(167,139,250,0.7)] z-20"
				style={{ animation: "orbPulse 3.8s ease-in-out 0.2s infinite" }}
			/>
			{/* Face / forehead area */}
			<div
				className="absolute top-[22%] right-[12%] h-1.5 w-1.5 rounded-full bg-violet-300 shadow-[0_0_8px_rgba(196,181,253,0.6)] z-20"
				style={{ animation: "orbPulse 4.5s ease-in-out 1.8s infinite" }}
			/>
			{/* Below brain / neck */}
			<div
				className="absolute top-[55%] right-[20%] h-2 w-2 rounded-full bg-orange-300 shadow-[0_0_12px_rgba(253,186,116,0.7)] z-20"
				style={{ animation: "orbPulse 3.5s ease-in-out 2.5s infinite" }}
			/>
			{/* Scattered particles */}
			<div
				className="absolute top-[12%] right-[35%] h-1 w-1 rounded-full bg-violet-400 shadow-[0_0_8px_rgba(167,139,250,0.6)] z-20"
				style={{ animation: "orbPulse 5s ease-in-out 0.7s infinite" }}
			/>
			<div
				className="absolute top-[60%] right-[15%] h-1.5 w-1.5 rounded-full bg-fuchsia-300 shadow-[0_0_10px_rgba(240,171,252,0.6)] z-20"
				style={{ animation: "orbPulse 4s ease-in-out 3s infinite" }}
			/>
			<div
				className="absolute top-[45%] right-[10%] h-1 w-1 rounded-full bg-orange-400 shadow-[0_0_8px_rgba(251,146,60,0.5)] z-20"
				style={{ animation: "orbPulse 3s ease-in-out 1s infinite" }}
			/>
		</div>
	);
}
