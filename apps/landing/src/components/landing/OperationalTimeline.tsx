"use client";

import {
	ArrowDown,
	BarChart3,
	CheckCircle2,
	ClipboardCheck,
	Database,
	FileText,
	Globe2,
	Mail,
	MessageCircle,
	RefreshCw,
	Send,
	Sparkles,
	TrendingUp,
	Workflow,
	type LucideIcon,
} from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { TimelineContent } from "../../i18n/content";

const accentClasses: Record<
	string,
	{ bubble: string; label: string; border: string; glow: string }
> = {
	violet: {
		bubble: "from-violet-600 to-violet-400 shadow-violet-500/35",
		label: "text-violet-600 dark:text-violet-300",
		border:
			"group-hover:border-violet-300/80 dark:group-hover:border-violet-400/30",
		glow: "from-violet-500/18 to-transparent",
	},
	blue: {
		bubble: "from-blue-600 to-violet-500 shadow-blue-500/35",
		label: "text-blue-600 dark:text-blue-300",
		border:
			"group-hover:border-blue-300/80 dark:group-hover:border-blue-400/30",
		glow: "from-blue-500/18 to-transparent",
	},
	fuchsia: {
		bubble: "from-fuchsia-600 to-pink-500 shadow-fuchsia-500/35",
		label: "text-fuchsia-600 dark:text-fuchsia-300",
		border:
			"group-hover:border-fuchsia-300/80 dark:group-hover:border-fuchsia-400/30",
		glow: "from-fuchsia-500/18 to-transparent",
	},
	pink: {
		bubble: "from-pink-600 to-rose-500 shadow-pink-500/35",
		label: "text-pink-600 dark:text-pink-300",
		border:
			"group-hover:border-pink-300/80 dark:group-hover:border-pink-400/30",
		glow: "from-pink-500/18 to-transparent",
	},
};

type VisualNode = {
	label: string;
	icon?: LucideIcon;
	logo?: string;
	className: string;
};

const chatChannels: Array<{
	label: string;
	logo?: string;
	icon?: LucideIcon;
	tint?: string;
}> = [
	{ label: "Slack", logo: "/images/tools/slack.svg" },
	{ label: "Teams", logo: "/images/tools/microsoft.svg" },
	{ label: "Discord", logo: "/images/apps/discord.svg" },
	{ label: "Cloud", logo: "/images/apps/microsoft-icon.png" },
	{ label: "Telegram", icon: Send, tint: "text-sky-500" },
	{ label: "Email", logo: "/images/tools/gmail.svg" },
];

const infraNodes: VisualNode[] = [
	{
		label: "GitHub",
		logo: "/images/tools/github.svg",
		className: "left-[7%] top-[18%]",
	},
	{
		label: "Salesforce",
		logo: "/images/tools/salesforce.svg",
		className: "right-[8%] top-[18%]",
	},
	{
		label: "Jira",
		logo: "/images/tools/jira.svg",
		className: "left-[5%] top-[56%]",
	},
	{ label: "Sheets", icon: BarChart3, className: "right-[6%] top-[56%]" },
	{
		label: "Notion",
		logo: "/images/tools/notion.svg",
		className: "left-[17%] bottom-[13%]",
	},
	{ label: "Databases", icon: Database, className: "right-[14%] bottom-[15%]" },
];

function ConnectedNode({
	node,
	delay = 0,
	tone = "violet",
}: {
	node: VisualNode;
	delay?: number;
	tone?: "violet" | "blue";
}) {
	const Icon = node.icon;
	const reduceMotion = useReducedMotion();

	return (
		<motion.div
			className={cn(
				"absolute z-10 flex size-12 items-center justify-center rounded-full border bg-white shadow-[0_14px_30px_rgba(124,58,237,0.18)] dark:bg-white",
				tone === "blue"
					? "border-blue-100 text-blue-600"
					: "border-violet-100 text-violet-600",
				node.className,
			)}
			animate={
				reduceMotion ? undefined : { y: [0, -5, 0], scale: [1, 1.025, 1] }
			}
			transition={{ duration: 4.2, delay, repeat: Infinity, ease: "easeInOut" }}
			aria-label={node.label}
		>
			{node.logo ? (
				<img
					src={node.logo}
					alt=""
					className="max-h-6 max-w-6 object-contain"
					loading="lazy"
				/>
			) : Icon ? (
				<Icon className="size-5" aria-hidden="true" />
			) : null}
		</motion.div>
	);
}

function PulseLink({
	d,
	delay = 0,
	tone = "violet",
}: {
	d: string;
	delay?: number;
	tone?: "violet" | "blue" | "pink";
}) {
	const color =
		tone === "blue" ? "#3b82f6" : tone === "pink" ? "#ec4899" : "#8b5cf6";
	const faint =
		tone === "blue"
			? "rgba(59,130,246,0.12)"
			: tone === "pink"
				? "rgba(236,72,153,0.12)"
				: "rgba(139,92,246,0.12)";

	return (
		<>
			<path
				d={d}
				fill="none"
				stroke={faint}
				strokeLinecap="round"
				strokeWidth="8"
			/>
			<path
				d={d}
				fill="none"
				stroke="white"
				strokeLinecap="round"
				strokeOpacity="0.18"
				strokeWidth="4"
			/>
			<motion.path
				d={d}
				fill="none"
				stroke={color}
				strokeDasharray="16 190"
				strokeLinecap="round"
				strokeOpacity="0.42"
				strokeWidth="3"
				animate={{ strokeDashoffset: [0, -206] }}
				transition={{ duration: 4.8, delay, repeat: Infinity, ease: "linear" }}
			/>
		</>
	);
}

function InteractiveRow({
	children,
	tone = "violet",
}: {
	children: ReactNode;
	tone?: "violet" | "pink";
}) {
	return (
		<motion.div
			className={cn(
				"group flex cursor-default items-center gap-2 rounded-xl px-3 py-2 text-[11px] font-medium text-slate-700 transition-colors dark:text-white/70",
				tone === "pink"
					? "bg-pink-50/75 hover:bg-pink-100/80 dark:bg-white/[0.06]"
					: "bg-violet-50/70 hover:bg-violet-100/80 dark:bg-white/[0.06]",
			)}
			whileHover={{ x: 3, scale: 1.01 }}
			transition={{ duration: 0.18, ease: "easeOut" }}
		>
			{children}
		</motion.div>
	);
}

function ChatLogoStrip() {
	return (
		<div className="mt-5 flex flex-wrap items-center justify-center gap-2 rounded-2xl border border-violet-100/80 bg-violet-50/45 px-3 py-3 dark:border-white/10 dark:bg-white/[0.04]">
			{chatChannels.map((channel) => {
				const Icon = channel.icon;

				return (
					<span
						key={channel.label}
						className="flex size-8 items-center justify-center rounded-full bg-white shadow-[0_8px_20px_rgba(76,29,149,0.12)] transition-transform hover:-translate-y-1 dark:bg-white"
					>
						{channel.logo ? (
							<img
								src={channel.logo}
								alt={channel.label}
								className="max-h-4 max-w-4 object-contain"
								loading="lazy"
							/>
						) : Icon ? (
							<Icon className={cn("size-4", channel.tint)} aria-hidden="true" />
						) : null}
					</span>
				);
			})}
			<span className="flex size-8 items-center justify-center rounded-full bg-white text-sm font-bold text-slate-400 shadow-[0_8px_20px_rgba(76,29,149,0.12)] dark:bg-white">
				...
			</span>
		</div>
	);
}

function ListeningAura() {
	const reduceMotion = useReducedMotion();
	const listeningBubbles = [
		{
			className:
				"left-[13%] top-[36%] size-2 bg-blue-700/18 dark:bg-blue-300/22",
			delay: 0,
			x: [0, -5, -1, 0],
			y: [0, -7, 1, 0],
		},
		{
			className:
				"right-[14%] top-[33%] size-2.5 bg-indigo-700/18 dark:bg-indigo-300/22",
			delay: 0.45,
			x: [0, 5, 1, 0],
			y: [0, -6, 2, 0],
		},
		{
			className:
				"bottom-[18%] left-[25%] size-1.5 bg-violet-700/20 dark:bg-violet-300/24",
			delay: 0.9,
			x: [0, -3, 2, 0],
			y: [0, 5, -1, 0],
		},
		{
			className:
				"bottom-[21%] right-[23%] size-2 bg-purple-700/18 dark:bg-purple-300/22",
			delay: 1.25,
			x: [0, 4, -1, 0],
			y: [0, 4, -2, 0],
		},
	];

	return (
		<>
			{[0, 0.85].map((delay) => (
				<motion.span
					key={delay}
					className="pointer-events-none absolute -inset-2 rounded-full border border-violet-500/42 shadow-[0_0_28px_rgba(124,58,237,0.36)] dark:border-sky-200/70 dark:shadow-[0_0_24px_rgba(56,189,248,0.26)]"
					animate={
						reduceMotion
							? undefined
							: { opacity: [0.62, 0.12, 0.62], scale: [0.86, 1.26, 0.86] }
					}
					transition={{
						duration: 2.65,
						delay,
						repeat: Infinity,
						ease: "easeInOut",
					}}
				/>
			))}
			{listeningBubbles.map((bubble) => (
				<motion.span
					key={bubble.className}
					className={cn(
						"pointer-events-none absolute z-10 rounded-full shadow-[0_0_10px_rgba(79,70,229,0.16)] dark:shadow-[0_0_10px_rgba(165,180,252,0.18)]",
						bubble.className,
					)}
					animate={
						reduceMotion
							? undefined
							: {
									opacity: [0.2, 0.5, 0.2],
									scale: [0.65, 1.2, 0.7],
									x: bubble.x,
									y: bubble.y,
								}
					}
					transition={{
						duration: 2.2,
						delay: bubble.delay,
						repeat: Infinity,
						ease: "easeInOut",
					}}
				/>
			))}
		</>
	);
}

function BrandCore() {
	const reduceMotion = useReducedMotion();

	return (
		<motion.div
			className="absolute left-1/2 top-[43%] z-20 flex size-24 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/80 bg-white shadow-[0_22px_50px_rgba(124,58,237,0.2),0_0_34px_rgba(236,72,153,0.18)]"
			animate={reduceMotion ? undefined : { scale: [1, 1.035, 1] }}
			transition={{ duration: 3.8, repeat: Infinity, ease: "easeInOut" }}
		>
			<ListeningAura />
			<div className="absolute inset-1 rounded-full bg-[radial-gradient(circle_at_35%_25%,rgba(255,255,255,0.95),rgba(217,70,239,0.14)_44%,rgba(124,58,237,0.18))]" />
			<motion.img
				src="/images/tedi-core-icon.png"
				alt=""
				className="relative z-20 size-[5.65rem] rounded-full object-contain drop-shadow-[0_14px_22px_rgba(124,58,237,0.25)]"
				loading="lazy"
				animate={
					reduceMotion
						? undefined
						: {
								scale: [1, 1.045, 1],
								filter: ["brightness(1)", "brightness(1.08)", "brightness(1)"],
							}
				}
				transition={{ duration: 3.4, repeat: Infinity, ease: "easeInOut" }}
			/>
		</motion.div>
	);
}

function DayOneVisual() {
	const reduceMotion = useReducedMotion();
	const sourceNodes: VisualNode[] = [
		{
			label: "Documentation",
			icon: FileText,
			className: "left-[8%] top-[18%]",
		},
		{ label: "Databases", icon: Database, className: "left-[9%] bottom-[24%]" },
		{ label: "Website", icon: Globe2, className: "right-[8%] top-[18%]" },
		{ label: "Tools", icon: Workflow, className: "right-[9%] bottom-[24%]" },
	];

	return (
		<div className="relative mb-7 h-44 overflow-hidden rounded-2xl bg-gradient-to-b from-violet-50 to-white dark:from-violet-950/35 dark:to-white/[0.03]">
			<svg
				className="absolute inset-0 size-full"
				viewBox="0 0 520 224"
				preserveAspectRatio="none"
				aria-hidden="true"
			>
				<PulseLink d="M260 92 C205 55 145 54 80 69" tone="violet" delay={0.1} />
				<PulseLink
					d="M260 92 C198 108 143 132 82 146"
					tone="violet"
					delay={0.35}
				/>
				<PulseLink d="M260 92 C315 55 375 54 440 69" tone="pink" delay={0.55} />
				<PulseLink
					d="M260 92 C322 108 377 132 438 146"
					tone="pink"
					delay={0.8}
				/>
			</svg>
			<motion.div
				className="absolute left-1/2 top-[42%] z-20 flex size-24 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-violet-100 bg-white shadow-[0_22px_46px_rgba(124,58,237,0.22),0_0_34px_rgba(217,70,239,0.2)]"
				animate={reduceMotion ? undefined : { scale: [1, 1.035, 1] }}
				transition={{ duration: 3.6, repeat: Infinity, ease: "easeInOut" }}
			>
				<ListeningAura />
				<div className="absolute inset-1 rounded-full bg-[radial-gradient(circle_at_35%_25%,rgba(255,255,255,0.98),rgba(168,85,247,0.1)_48%,rgba(217,70,239,0.14))]" />
				<motion.img
					src="/images/tedi-astronaut-waving.png"
					alt=""
					className="relative z-20 size-16 object-contain drop-shadow-[0_12px_18px_rgba(124,58,237,0.22)]"
					loading="lazy"
					animate={
						reduceMotion
							? undefined
							: {
									scale: [1, 1.055, 1],
									filter: [
										"brightness(1)",
										"brightness(1.07)",
										"brightness(1)",
									],
								}
					}
					transition={{ duration: 3.5, repeat: Infinity, ease: "easeInOut" }}
				/>
			</motion.div>
			{sourceNodes.map((node, index) => (
				<ConnectedNode key={node.label} node={node} delay={index * 0.24} />
			))}
		</div>
	);
}

function WeekOneVisual() {
	const reduceMotion = useReducedMotion();

	return (
		<div className="relative mb-7 h-56 overflow-hidden rounded-2xl bg-gradient-to-b from-blue-50 to-white dark:from-blue-950/30 dark:to-white/[0.03]">
			<svg
				className="absolute inset-0 size-full"
				viewBox="0 0 520 224"
				preserveAspectRatio="none"
				aria-hidden="true"
			>
				<PulseLink d="M260 94 C196 58 151 45 91 60" tone="blue" delay={0.1} />
				<PulseLink d="M260 94 C324 58 369 45 429 60" tone="blue" delay={0.3} />
				<PulseLink
					d="M260 94 C190 104 141 125 79 146"
					tone="violet"
					delay={0.55}
				/>
				<PulseLink
					d="M260 94 C330 104 379 125 441 146"
					tone="violet"
					delay={0.75}
				/>
				<PulseLink d="M260 94 C198 134 172 154 116 166" tone="pink" delay={1} />
				<PulseLink
					d="M260 94 C324 134 346 154 402 166"
					tone="pink"
					delay={1.2}
				/>
			</svg>
			<BrandCore />
			{infraNodes.map((node, index) => (
				<ConnectedNode
					key={node.label}
					node={node}
					delay={index * 0.18}
					tone="blue"
				/>
			))}
		</div>
	);
}

function MonthOneVisual({ content }: { content: TimelineContent }) {
	return (
		<div className="mb-7 rounded-2xl border border-fuchsia-100 bg-white p-4 shadow-[0_14px_40px_rgba(168,85,247,0.1)] dark:border-white/10 dark:bg-white/[0.05]">
			<div className="mb-3 flex items-center justify-between">
				<span className="text-xs font-bold text-slate-900 dark:text-white/85">
					{content.automationTitle}
				</span>
				<span className="rounded-full bg-emerald-50 px-2 py-1 text-[10px] font-bold text-emerald-600 dark:bg-emerald-400/10 dark:text-emerald-300">
					{content.activeLabel}
				</span>
			</div>
			<div className="space-y-2">
				{content.automationRows.map((row) => (
					<InteractiveRow key={row}>
						<ClipboardCheck
							className="size-3.5 text-violet-600 dark:text-violet-300"
							aria-hidden="true"
						/>
						<span>{row}</span>
						<span className="ml-auto flex items-center gap-1 text-[10px] font-bold text-emerald-500 transition-transform group-hover:translate-x-0.5">
							{content.activeLabel}
							<span className="size-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.75)]" />
						</span>
					</InteractiveRow>
				))}
			</div>
		</div>
	);
}

function ContinuousVisual({ content }: { content: TimelineContent }) {
	const intelligenceIcons = [Workflow, BarChart3, Sparkles, TrendingUp];
	const intelligence = content.intelligenceRows.map((label, index) => ({
		label,
		icon: intelligenceIcons[index] ?? Workflow,
	}));

	return (
		<div className="mb-7 rounded-2xl border border-pink-100 bg-white p-4 shadow-[0_14px_40px_rgba(236,72,153,0.1)] dark:border-white/10 dark:bg-white/[0.05]">
			<div className="mb-3 flex items-center justify-between">
				<span className="text-xs font-bold text-slate-900 dark:text-white/85">
					{content.intelligenceTitle}
				</span>
				<RefreshCw className="size-3.5 text-pink-500" aria-hidden="true" />
			</div>
			<div className="space-y-2">
				{intelligence.map((item) => {
					const Icon = item.icon;

					return (
						<InteractiveRow key={item.label} tone="pink">
							<span className="flex size-6 items-center justify-center rounded-lg bg-white text-pink-600 shadow-sm dark:bg-white/10 dark:text-pink-300">
								<Icon className="size-3.5" aria-hidden="true" />
							</span>
							<span>{item.label}</span>
							<CheckCircle2
								className="ml-auto size-3.5 text-emerald-500 transition-transform group-hover:scale-110"
								aria-hidden="true"
							/>
						</InteractiveRow>
					);
				})}
			</div>
		</div>
	);
}

function StepVisual({
	content,
	index,
}: {
	content: TimelineContent;
	index: number;
}) {
	if (index === 0) return <DayOneVisual />;
	if (index === 1) return <WeekOneVisual />;
	if (index === 2) return <MonthOneVisual content={content} />;
	return <ContinuousVisual content={content} />;
}

export function OperationalTimeline({ content }: { content: TimelineContent }) {
	const reduceMotion = useReducedMotion();
	const steps = content.steps;

	return (
		<div className="relative mx-auto max-w-7xl px-4 py-14 sm:px-6 md:py-18 lg:px-8">
			<div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_0%,rgba(139,92,246,0.12),transparent_34%),radial-gradient(circle_at_80%_10%,rgba(236,72,153,0.12),transparent_32%)]" />
			<div className="relative text-center">
				<p className="mb-4 text-xs font-bold uppercase tracking-[0.2em] text-violet-600 dark:text-violet-300">
					{content.eyebrow}
				</p>
				<h2 className="mx-auto max-w-3xl font-display text-4xl font-bold leading-tight tracking-tight text-slate-950 md:text-5xl dark:text-white">
					{content.titleLine1}
					<br className="hidden sm:block" />{" "}
					<span className="bg-gradient-to-r from-violet-600 via-fuchsia-500 to-pink-500 bg-clip-text text-transparent">
						{content.titleLine2}
					</span>
				</h2>
			</div>

			<div className="relative mt-14">
				<div className="relative mx-auto grid max-w-6xl gap-7 lg:grid-cols-2 lg:gap-x-14 lg:gap-y-12">
					<svg
						className="pointer-events-none absolute inset-0 z-0 hidden size-full lg:block"
						viewBox="0 0 1152 1010"
						preserveAspectRatio="none"
						aria-hidden="true"
					>
						<defs>
							<linearGradient
								id="workflow-flow-gradient"
								x1="0"
								x2="1"
								y1="0"
								y2="1"
							>
								<stop stopColor="#8b5cf6" />
								<stop offset="0.5" stopColor="#e879f9" />
								<stop offset="1" stopColor="#f472b6" />
							</linearGradient>
							<filter
								id="workflow-flow-glow"
								x="-20%"
								y="-20%"
								width="140%"
								height="140%"
							>
								<feGaussianBlur stdDeviation="7" result="blur" />
								<feMerge>
									<feMergeNode in="blur" />
									<feMergeNode in="SourceGraphic" />
								</feMerge>
							</filter>
							<marker
								id="workflow-flow-arrow"
								markerHeight="10"
								markerWidth="10"
								orient="auto"
								refX="7"
								refY="3"
								viewBox="0 0 8 6"
							>
								<path d="M0 0 L8 3 L0 6 Z" fill="#f472b6" />
							</marker>
						</defs>
						<path
							d="M548 235 C606 232 664 238 698 278 C744 334 718 420 648 476 C584 526 458 498 342 548 C252 587 248 684 336 735 C430 788 586 738 704 765"
							fill="none"
							filter="url(#workflow-flow-glow)"
							stroke="url(#workflow-flow-gradient)"
							strokeLinecap="round"
							strokeOpacity="0.24"
							strokeWidth="24"
						/>
						<path
							d="M548 235 C606 232 664 238 698 278 C744 334 718 420 648 476 C584 526 458 498 342 548 C252 587 248 684 336 735 C430 788 586 738 704 765"
							fill="none"
							stroke="rgba(232,121,249,0.18)"
							strokeLinecap="round"
							strokeWidth="16"
						/>
						<motion.path
							d="M548 235 C606 232 664 238 698 278 C744 334 718 420 648 476 C584 526 458 498 342 548 C252 587 248 684 336 735 C430 788 586 738 704 765"
							fill="none"
							stroke="url(#workflow-flow-gradient)"
							strokeDasharray="90 840"
							strokeLinecap="round"
							strokeOpacity="0.92"
							strokeWidth="6"
							markerEnd="url(#workflow-flow-arrow)"
							animate={
								reduceMotion ? undefined : { strokeDashoffset: [0, -930] }
							}
							transition={{ duration: 5.8, repeat: Infinity, ease: "linear" }}
						/>
					</svg>
					{steps.map((step, index) => {
						const accent = accentClasses[step.accent];

						return (
							<div key={step.number} className="contents">
								<motion.article
									className={cn(
										"group relative z-10 flex min-h-[470px] flex-col rounded-3xl border border-violet-100/80 bg-white/90 p-6 pt-10 shadow-[0_20px_60px_rgba(76,29,149,0.08)] backdrop-blur transition-all duration-500 hover:-translate-y-1 hover:shadow-[0_26px_80px_rgba(124,58,237,0.14)] dark:border-white/10 dark:bg-[#21142f]/92 dark:shadow-[0_20px_70px_rgba(0,0,0,0.34)]",
										accent.border,
									)}
								>
									<div
										className={cn(
											"pointer-events-none absolute inset-x-0 top-0 h-28 rounded-t-3xl bg-gradient-to-b opacity-0 transition-opacity duration-500 group-hover:opacity-100",
											accent.glow,
										)}
									/>
									<div className="absolute left-1/2 top-0 z-10 -translate-x-1/2 -translate-y-1/2">
										<div
											className={cn(
												"flex size-11 items-center justify-center rounded-full bg-gradient-to-br text-base font-bold text-white shadow-lg ring-4 ring-white dark:ring-[#14091f]",
												accent.bubble,
											)}
										>
											{step.number}
										</div>
									</div>

									<div className="relative">
										<p
											className={cn(
												"mb-4 text-[11px] font-bold uppercase tracking-[0.18em]",
												accent.label,
											)}
										>
											{step.kicker}
										</p>
										<StepVisual content={content} index={index} />
										<h3 className="mb-3 font-display text-2xl font-bold leading-tight text-slate-950 dark:text-white">
											{step.title}
										</h3>
										<div className="space-y-3 text-sm leading-relaxed text-slate-600 dark:text-white/58">
											{step.copy.map((paragraph) => (
												<p key={paragraph}>{paragraph}</p>
											))}
										</div>
										{index === 0 && <ChatLogoStrip />}
									</div>
								</motion.article>
								{index < steps.length - 1 && (
									<div className="-my-2 flex justify-center lg:hidden">
										<div className="flex size-9 items-center justify-center rounded-full border border-violet-100 bg-white text-violet-600 shadow-[0_10px_25px_rgba(124,58,237,0.14)] dark:border-white/10 dark:bg-white/8 dark:text-violet-200">
											<ArrowDown className="size-4" aria-hidden="true" />
										</div>
									</div>
								)}
							</div>
						);
					})}
				</div>
			</div>

			<div className="relative mt-8 flex flex-wrap justify-center gap-2 text-xs font-semibold text-slate-500 dark:text-white/45">
				<span className="inline-flex items-center gap-1.5 rounded-full border border-violet-100 bg-white/70 px-3 py-1.5 dark:border-white/10 dark:bg-white/5">
					<MessageCircle
						className="size-3.5 text-violet-500"
						aria-hidden="true"
					/>
					{content.badges[0]}
				</span>
				<span className="inline-flex items-center gap-1.5 rounded-full border border-violet-100 bg-white/70 px-3 py-1.5 dark:border-white/10 dark:bg-white/5">
					<Database className="size-3.5 text-fuchsia-500" aria-hidden="true" />
					{content.badges[1]}
				</span>
				<span className="inline-flex items-center gap-1.5 rounded-full border border-violet-100 bg-white/70 px-3 py-1.5 dark:border-white/10 dark:bg-white/5">
					<Send className="size-3.5 text-pink-500" aria-hidden="true" />
					{content.badges[2]}
				</span>
				<span className="inline-flex items-center gap-1.5 rounded-full border border-violet-100 bg-white/70 px-3 py-1.5 dark:border-white/10 dark:bg-white/5">
					<Mail className="size-3.5 text-blue-500" aria-hidden="true" />
					{content.badges[3]}
				</span>
			</div>
		</div>
	);
}
