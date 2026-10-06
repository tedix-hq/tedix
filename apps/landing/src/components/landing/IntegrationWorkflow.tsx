"use client";

import {
	BarChart3,
	BookOpen,
	Bot,
	BrainCircuit,
	Braces,
	Building2,
	Cloud,
	Code2,
	Database,
	Eye,
	FileSpreadsheet,
	Landmark,
	Megaphone,
	MessageCircle,
	MonitorCheck,
	Network,
	Shield,
	ShieldCheck,
	TrendingUp,
	UserCheck,
	Users,
	Workflow,
	type LucideIcon,
} from "lucide-react";
import { motion } from "motion/react";
import type { CSSProperties } from "react";
import { Marquee } from "../magicui/Marquee";

type FlowItem = {
	label: string;
	icon: LucideIcon;
};

type SystemPair = {
	source: FlowItem;
	target: FlowItem;
};

const departments: FlowItem[] = [
	{ label: "Business\nDevelopment", icon: Building2 },
	{ label: "Marketing", icon: Megaphone },
	{ label: "Customer\nSuccess", icon: UserCheck },
	{ label: "Engineering", icon: Code2 },
	{ label: "Sales", icon: TrendingUp },
	{ label: "Security", icon: Shield },
];

const systems: SystemPair[] = [
	{
		source: { label: "Analytics", icon: BarChart3 },
		target: { label: "Databases", icon: Database },
	},
	{
		source: { label: "Knowledge", icon: BookOpen },
		target: { label: "Legacy", icon: Landmark },
	},
	{
		source: { label: "SAAS", icon: Cloud },
		target: { label: "Sheets / CSV", icon: FileSpreadsheet },
	},
	{
		source: { label: "Cloud", icon: Cloud },
		target: { label: "Workspace", icon: Users },
	},
	{
		source: { label: "Observability", icon: Eye },
		target: { label: "Chat Interface", icon: MessageCircle },
	},
	{
		source: { label: "API's", icon: Braces },
		target: { label: "AI/ML tools", icon: BrainCircuit },
	},
];

const capabilities: FlowItem[] = [
	{ label: "Analyze\nInfrastructure", icon: Network },
	{ label: "Identify\nCritical Integration", icon: Workflow },
	{ label: "Connect\nSecurely", icon: ShieldCheck },
	{ label: "Orchestrate\nIntelligently", icon: Bot },
	{ label: "Monitor\nContinuously", icon: MonitorCheck },
];

const logos = [
	{ src: "/images/apps/slack.svg", alt: "Slack" },
	{ src: "/images/apps/notion.svg", alt: "Notion" },
	{ src: "/images/apps/discord.svg", alt: "Discord" },
	{ src: "/images/apps/jira.svg", alt: "Jira" },
	{ src: "/images/apps/figma.svg", alt: "Figma" },
	{ src: "/images/apps/intercom.svg", alt: "Intercom" },
	{ src: "/images/apps/calendly.svg", alt: "Calendly" },
	{ src: "/images/apps/stripe.svg", alt: "Stripe" },
	{ src: "/images/apps/shopify.svg", alt: "Shopify" },
	{ src: "/images/apps/klarna.svg", alt: "Klarna" },
];

const leftPaths = [
	"M 190 82 C 296 82 310 178 414 205",
	"M 190 170 C 300 170 318 218 414 232",
	"M 190 258 C 300 258 324 258 414 259",
	"M 190 346 C 300 346 324 300 414 286",
	"M 190 434 C 306 434 318 340 414 313",
	"M 190 522 C 310 522 310 388 414 340",
];

const rightPaths = [
	"M 692 205 C 770 205 738 81 780 81",
	"M 692 232 C 762 232 740 169 780 169",
	"M 692 259 C 750 259 748 257 780 257",
	"M 692 286 C 762 286 740 345 780 345",
	"M 692 313 C 768 313 738 433 780 433",
	"M 692 340 C 780 340 732 521 780 521",
];

const centerNodeYs = [47, 74, 101, 128, 155, 182];

function HoverSheen({
	tone = "violet",
}: {
	tone?: "violet" | "pink" | "white";
}) {
	const colors = {
		violet: "from-transparent via-violet-50/70 to-transparent",
		pink: "from-transparent via-pink-50/70 to-transparent",
		white: "from-transparent via-white/85 to-transparent",
	};

	return (
		<span
			className={`pointer-events-none absolute inset-y-[-50%] left-[-85%] z-0 w-2/3 rotate-12 bg-gradient-to-r ${colors[tone]} opacity-0 mix-blend-screen blur-[1px] transition-[transform,opacity] duration-900 ease-out group-hover:translate-x-[330%] group-hover:opacity-100`}
		/>
	);
}

function ConnectorDot({
	className,
	color,
	delay = 0,
	style,
}: {
	className: string;
	color: "violet" | "pink";
	delay?: number;
	style?: CSSProperties;
}) {
	const base =
		color === "violet"
			? {
					background: "#8b5cf6",
					boxShadow:
						"0 0 0 3px rgba(139,92,246,0.16), 0 0 16px rgba(139,92,246,0.68)",
					pulseShadow:
						"0 0 0 7px rgba(139,92,246,0), 0 0 22px rgba(139,92,246,0.74)",
				}
			: {
					background: "#ec4899",
					boxShadow:
						"0 0 0 3px rgba(236,72,153,0.16), 0 0 16px rgba(236,72,153,0.68)",
					pulseShadow:
						"0 0 0 7px rgba(236,72,153,0), 0 0 22px rgba(236,72,153,0.74)",
				};

	return (
		<motion.span
			className={`absolute rounded-full border-2 border-white/90 ${className}`}
			animate={{
				scale: [1, 1.16, 1],
				opacity: [0.84, 1, 0.84],
				boxShadow: [base.boxShadow, base.pulseShadow, base.boxShadow],
			}}
			transition={{
				delay,
				duration: 3.8,
				ease: "easeInOut",
				repeat: Infinity,
			}}
			style={{
				background: base.background,
				...style,
			}}
		/>
	);
}

function NeonPath({
	d,
	color,
	delay,
	phase = "in",
}: {
	d: string;
	color: "violet" | "pink";
	delay: number;
	phase?: "in" | "out";
}) {
	const gradientId = `workflow-${color}-${delay.toString().replace(".", "-")}`;
	const shadow = color === "violet" ? "#7c3aed" : "#ec4899";
	const start = color === "violet" ? "#6d28d9" : "#d946ef";
	const end = color === "violet" ? "#c084fc" : "#fb3fb3";
	const pulse = color === "violet" ? "#a78bfa" : "#ff4fba";
	const flowDelay = delay + (phase === "in" ? 0 : 2.2);
	const pathId = `${gradientId}-path`;

	return (
		<>
			<defs>
				<linearGradient id={gradientId} x1="0" x2="1" y1="0" y2="0">
					<stop stopColor={start} />
					<stop offset="1" stopColor={end} />
				</linearGradient>
			</defs>
			<path
				id={pathId}
				className="dark:opacity-0"
				d={d}
				fill="none"
				stroke={shadow}
				strokeLinecap="round"
				strokeOpacity="0.11"
				strokeWidth="20"
			/>
			<path
				className="dark:opacity-0"
				d={d}
				fill="none"
				stroke="white"
				strokeLinecap="round"
				strokeOpacity="0.18"
				strokeWidth="6"
			/>
			<motion.path
				d={d}
				fill="none"
				stroke={`url(#${gradientId})`}
				strokeLinecap="round"
				strokeWidth="4"
				initial={{ pathLength: 0, opacity: 0.4 }}
				whileInView={{ pathLength: 1, opacity: 0.72 }}
				viewport={{ once: true, amount: 0.35 }}
				transition={{ delay, duration: 1.1, ease: "easeOut" }}
			/>
			<motion.path
				d={d}
				fill="none"
				stroke={pulse}
				strokeDasharray="44 220"
				strokeLinecap="round"
				strokeOpacity="0.68"
				strokeWidth="6"
				animate={{ strokeDashoffset: [0, -520] }}
				transition={{
					delay: flowDelay,
					duration: 4.6,
					ease: "linear",
					repeat: Infinity,
				}}
			/>
			<circle r="4.5" fill={pulse} opacity="0">
				<animateMotion
					begin={`${flowDelay}s`}
					dur="4.6s"
					repeatCount="indefinite"
				>
					<mpath href={`#${pathId}`} />
				</animateMotion>
				<animate
					attributeName="opacity"
					begin={`${flowDelay}s`}
					dur="4.6s"
					repeatCount="indefinite"
					values="0;0.95;0.95;0"
					keyTimes="0;0.12;0.86;1"
				/>
			</circle>
		</>
	);
}

function DepartmentCard({ item, index }: { item: FlowItem; index: number }) {
	const Icon = item.icon;

	return (
		<motion.div
			className="group absolute left-0 flex h-[68px] w-[190px] items-center gap-4 overflow-hidden rounded-lg border border-violet-300/20 bg-gradient-to-br from-[#2a106a] via-[#1a0748] to-[#0e0328] px-5 text-white shadow-[0_18px_38px_rgba(40,16,98,0.22),0_0_24px_rgba(124,58,237,0.22)] transition-[box-shadow,border-color,filter] duration-300 hover:border-violet-200/55 hover:brightness-110 hover:shadow-[0_22px_46px_rgba(40,16,98,0.36),0_0_50px_rgba(139,92,246,0.62)]"
			style={{ top: 48 + index * 88 }}
			whileHover={{ x: 4, scale: 1.02 }}
			transition={{ duration: 0.2, ease: "easeOut" }}
		>
			<HoverSheen tone="white" />
			<Icon className="relative z-10 h-7 w-7 shrink-0" strokeWidth={2.1} />
			<span className="relative z-10 whitespace-pre-line font-bold text-base leading-tight">
				{item.label}
			</span>
			<ConnectorDot
				color="violet"
				className="-right-1.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2"
				delay={index * 0.16}
			/>
		</motion.div>
	);
}

function SystemPairRow({ pair, index }: { pair: SystemPair; index: number }) {
	const SourceIcon = pair.source.icon;
	const TargetIcon = pair.target.icon;

	return (
		<motion.div
			className="absolute flex h-[58px] items-center"
			style={{ left: 780, top: 57 + index * 88 }}
			whileHover={{ x: -4, scale: 1.01 }}
			transition={{ duration: 0.2, ease: "easeOut" }}
		>
			<div className="group relative flex h-12 w-[140px] items-center gap-3 overflow-hidden rounded-lg border border-violet-300/35 bg-white px-4 text-[#201043] shadow-[0_14px_28px_rgba(236,72,153,0.12)] transition-[box-shadow,border-color,filter] duration-300 hover:border-violet-300/75 hover:brightness-110 hover:shadow-[0_16px_34px_rgba(124,58,237,0.28),0_0_34px_rgba(236,72,153,0.34)] dark:bg-white/[0.07] dark:text-white/85 dark:border-violet-500/25 dark:hover:border-violet-300/55">
				<HoverSheen tone="violet" />
				<ConnectorDot
					color="pink"
					className="-left-1.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2"
					delay={0.18 + index * 0.14}
				/>
				<SourceIcon className="relative z-10 h-5 w-5 shrink-0 text-violet-600" />
				<span className="relative z-10 font-bold text-sm">
					{pair.source.label}
				</span>
			</div>
			<span className="relative h-[3px] w-7 overflow-hidden rounded-full bg-pink-400/70 shadow-[0_0_12px_rgba(236,72,153,0.58)]">
				<motion.span
					className="absolute inset-y-0 left-[-55%] w-1/2 rounded-full bg-white/95 shadow-[0_0_12px_rgba(255,255,255,0.86)]"
					animate={{ x: ["0%", "340%"] }}
					transition={{
						delay: 0.22 + index * 0.18,
						duration: 1.8,
						ease: "easeInOut",
						repeat: Infinity,
						repeatDelay: 0.3,
					}}
				/>
				<ConnectorDot
					color="pink"
					className="-right-1.5 top-1/2 h-3 w-3 -translate-y-1/2"
					delay={0.38 + index * 0.14}
				/>
			</span>
			<div className="group relative flex h-[64px] w-[168px] items-center gap-4 overflow-hidden rounded-lg border border-pink-200/20 bg-gradient-to-br from-[#c30062] via-[#9d004e] to-[#62032f] px-5 text-white shadow-[0_18px_38px_rgba(128,0,64,0.24),0_0_24px_rgba(236,72,153,0.22)] transition-[box-shadow,border-color,filter] duration-300 hover:border-pink-100/55 hover:brightness-110 hover:shadow-[0_22px_46px_rgba(128,0,64,0.38),0_0_54px_rgba(236,72,153,0.66)]">
				<HoverSheen tone="white" />
				<TargetIcon
					className="relative z-10 h-7 w-7 shrink-0"
					strokeWidth={2}
				/>
				<span className="relative z-10 font-bold text-base leading-tight">
					{pair.target.label}
				</span>
			</div>
		</motion.div>
	);
}

function LayerIcon() {
	return (
		<motion.div
			className="relative mx-auto mb-3 flex h-[118px] w-[158px] items-center justify-center"
			aria-hidden="true"
			animate={{ y: [0, -4, 0] }}
			transition={{ duration: 3.6, repeat: Infinity, ease: "easeInOut" }}
		>
			<img
				src="/images/tedix-database-violet-scan.svg"
				alt=""
				className="h-full w-full object-contain"
				loading="eager"
			/>
		</motion.div>
	);
}

function CapabilityRail() {
	return (
		<div className="absolute top-[432px] left-[425px] flex gap-5">
			<div className="relative mt-[22px] h-[224px] w-8">
				<div className="absolute left-1/2 top-0 h-full -translate-x-1/2 border-violet-300/55 border-l-2 border-dotted" />
				{[0, 1, 2, 3, 4].map((index) => (
					<span
						key={index}
						className="-translate-x-1/2 -translate-y-1/2 absolute left-1/2 h-1.5 w-1.5 rounded-full bg-violet-600 shadow-[0_0_8px_rgba(124,58,237,0.55)]"
						style={{ top: index * 55 }}
					/>
				))}
			</div>
			<div className="flex flex-col gap-3.5">
				{capabilities.map((item, index) => {
					const Icon = item.icon;

					return (
						<motion.div
							key={item.label}
							className="relative flex items-center gap-4"
							whileHover={{ x: 3 }}
							transition={{ duration: 0.2 }}
						>
							<span className="-left-[26px] absolute top-1/2 h-px w-6 -translate-y-1/2 border-violet-300/55 border-t border-dotted" />
							<span className="flex h-11 w-11 items-center justify-center rounded-full border border-violet-200 bg-white text-violet-600 shadow-[0_10px_24px_rgba(124,58,237,0.18),0_0_18px_rgba(236,72,153,0.16)] dark:border-violet-500/30 dark:bg-violet-900/50 dark:text-violet-300">
								<Icon className="h-5 w-5" />
							</span>
							<span className="whitespace-pre-line font-semibold text-[#111827] text-sm leading-tight dark:text-white/80">
								{item.label}
							</span>
						</motion.div>
					);
				})}
			</div>
		</div>
	);
}

function LogoBelt() {
	return (
		<div className="relative mx-auto mt-8 max-w-5xl opacity-70">
			<Marquee
				pauseOnHover
				className="[--duration:32s] [--gap:2rem] py-0"
				repeat={3}
			>
				{logos.map((logo) => (
					<div
						key={logo.alt}
						className="flex shrink-0 flex-col items-center gap-1"
					>
						<div className="flex h-9 w-9 items-center justify-center">
							<img
								src={logo.src}
								alt={logo.alt}
								className="max-h-6 max-w-7 object-contain opacity-55 grayscale transition-all hover:opacity-100 hover:grayscale-0"
								loading="lazy"
							/>
						</div>
						<span className="text-[10px] font-medium text-muted-foreground/55">
							{logo.alt}
						</span>
					</div>
				))}
			</Marquee>
			<div className="pointer-events-none absolute inset-y-0 left-0 w-28 bg-gradient-to-r from-background to-transparent" />
			<div className="pointer-events-none absolute inset-y-0 right-0 w-28 bg-gradient-to-l from-background to-transparent" />
		</div>
	);
}

function DesktopWorkflow() {
	return (
		<div className="relative mx-auto hidden h-[700px] max-w-[1120px] lg:block">
			<svg
				className="pointer-events-none absolute inset-x-0 top-0 h-[620px] w-full"
				viewBox="0 0 1120 620"
				aria-hidden="true"
			>
				{leftPaths.map((d, index) => (
					<NeonPath
						key={d}
						d={d}
						color="violet"
						delay={0.12 + index * 0.05}
						phase="in"
					/>
				))}
				{rightPaths.map((d, index) => (
					<NeonPath
						key={d}
						d={d}
						color="pink"
						delay={0.22 + index * 0.05}
						phase="out"
					/>
				))}
			</svg>

			{departments.map((item, index) => (
				<DepartmentCard key={item.label} item={item} index={index} />
			))}

			<motion.div className="absolute top-[24px] left-1/2 flex -translate-x-1/2 items-center gap-3">
				<img
					src="/images/tedi-astronaut-waving.png"
					alt=""
					className="h-[64px] w-[64px] object-contain drop-shadow-[0_14px_20px_rgba(60,30,130,0.22)]"
					loading="lazy"
				/>
				<span className="font-display text-[44px] leading-none tracking-tight text-[#161616] dark:text-white">
					tedix
				</span>
			</motion.div>

			<motion.div
				className="group absolute top-[158px] left-[412px] flex h-[228px] w-[280px] flex-col items-center justify-center overflow-hidden rounded-[28px] border border-violet-300/70 bg-white/96 px-8 py-7 text-center shadow-[0_22px_60px_rgba(124,58,237,0.22),0_0_34px_rgba(236,72,153,0.36)] transition-[box-shadow,border-color,filter] duration-300 hover:border-violet-300 hover:brightness-110 hover:shadow-[0_26px_72px_rgba(124,58,237,0.34),0_0_58px_rgba(236,72,153,0.5)] dark:bg-[#130825]/90 dark:border-violet-500/30 dark:shadow-[0_22px_60px_rgba(124,58,237,0.35),0_0_34px_rgba(236,72,153,0.25)] dark:hover:border-violet-300/55 dark:hover:shadow-[0_26px_72px_rgba(124,58,237,0.52),0_0_62px_rgba(236,72,153,0.46)]"
				whileHover={{ scale: 1.015 }}
				transition={{ duration: 0.2, ease: "easeOut" }}
			>
				<HoverSheen tone="violet" />
				{centerNodeYs.map((top) => (
					<ConnectorDot
						key={`left-${top}`}
						color="violet"
						className="-left-1.5 z-0 h-3 w-3"
						delay={top / 120}
						style={{ top: top - 6 }}
					/>
				))}
				{centerNodeYs.map((top) => (
					<ConnectorDot
						key={`right-${top}`}
						color="pink"
						className="-right-1.5 z-0 h-3 w-3"
						delay={0.24 + top / 120}
						style={{ top: top - 6 }}
					/>
				))}
				<div className="relative z-10">
					<LayerIcon />
				</div>
				<h3 className="relative z-10 font-medium uppercase tracking-[0.2em] text-violet-600 text-lg leading-tight">
					AI INTEGRATION
					<br />
					LAYER
				</h3>
			</motion.div>

			<CapabilityRail />

			{systems.map((pair, index) => (
				<SystemPairRow key={pair.target.label} pair={pair} index={index} />
			))}
		</div>
	);
}

function CompactWorkflow() {
	return (
		<div className="lg:hidden">
			<div className="mx-auto mb-8 flex max-w-sm items-center justify-center gap-3">
				<img
					src="/images/tedi-astronaut-waving.png"
					alt=""
					className="h-20 w-20 object-contain"
					loading="lazy"
				/>
				<span className="font-display text-5xl tracking-tight text-[#161616] dark:text-white">
					tedix
				</span>
			</div>

			<div className="group relative mx-auto max-w-md overflow-hidden rounded-[28px] border border-violet-300/60 bg-white p-8 text-center shadow-[0_22px_60px_rgba(124,58,237,0.18),0_0_32px_rgba(236,72,153,0.24)] transition-[box-shadow,border-color,filter] duration-300 hover:border-violet-300 hover:brightness-110 hover:shadow-[0_26px_72px_rgba(124,58,237,0.34),0_0_58px_rgba(236,72,153,0.5)] dark:bg-[#130825]/90 dark:border-violet-500/30 dark:hover:border-violet-300/55 dark:hover:shadow-[0_26px_72px_rgba(124,58,237,0.52),0_0_62px_rgba(236,72,153,0.46)]">
				<HoverSheen tone="violet" />
				<div className="relative z-10">
					<LayerIcon />
				</div>
				<h3 className="relative z-10 font-medium uppercase tracking-[0.2em] text-violet-600 text-lg leading-tight">
					AI INTEGRATION
					<br />
					LAYER
				</h3>
			</div>

			<div className="mt-8 grid gap-4 md:grid-cols-2">
				<div className="rounded-2xl border border-violet-200/50 bg-gradient-to-br from-[#281062] to-[#150638] p-5 text-white shadow-[0_18px_38px_rgba(40,16,98,0.18)]">
					<p className="mb-4 text-xs font-bold uppercase tracking-[0.18em] text-violet-200">
						Company teams
					</p>
					<div className="grid gap-3 sm:grid-cols-2 md:grid-cols-1">
						{departments.map((item) => {
							const Icon = item.icon;

							return (
								<div
									key={item.label}
									className="group relative flex items-center gap-3 overflow-hidden rounded-lg bg-white/8 px-3 py-2 transition-[box-shadow,filter] duration-300 hover:brightness-110 hover:shadow-[0_0_34px_rgba(139,92,246,0.58)]"
								>
									<HoverSheen tone="white" />
									<Icon className="relative z-10 h-5 w-5 shrink-0" />
									<span className="relative z-10 whitespace-pre-line font-semibold text-sm leading-tight">
										{item.label}
									</span>
								</div>
							);
						})}
					</div>
				</div>

				<div className="rounded-2xl border border-pink-200/70 bg-white p-5 shadow-[0_18px_38px_rgba(236,72,153,0.12)] dark:bg-white/[0.06] dark:border-pink-500/20">
					<p className="mb-4 text-xs font-bold uppercase tracking-[0.18em] text-pink-600">
						Connected systems
					</p>
					<div className="grid gap-3 sm:grid-cols-2 md:grid-cols-1">
						{systems.map((pair) => {
							const Icon = pair.target.icon;

							return (
								<div
									key={pair.target.label}
									className="group relative flex items-center gap-3 overflow-hidden rounded-lg bg-gradient-to-br from-[#c30062] via-[#9d004e] to-[#62032f] px-3 py-2 text-white transition-[box-shadow,filter] duration-300 hover:brightness-110 hover:shadow-[0_0_38px_rgba(236,72,153,0.62)]"
								>
									<HoverSheen tone="white" />
									<Icon className="relative z-10 h-5 w-5 shrink-0" />
									<span className="relative z-10 font-semibold text-sm leading-tight">
										{pair.target.label}
									</span>
								</div>
							);
						})}
					</div>
				</div>
			</div>
		</div>
	);
}

export function IntegrationWorkflow() {
	return (
		<div className="relative">
			<div className="pointer-events-none absolute inset-x-0 top-10 mx-auto h-48 max-w-3xl rounded-full bg-fuchsia-300/20 blur-3xl dark:bg-fuchsia-500/8" />
			<DesktopWorkflow />
			<CompactWorkflow />
			<LogoBelt />
		</div>
	);
}
