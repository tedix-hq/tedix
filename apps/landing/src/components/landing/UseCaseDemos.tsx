"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/* ═══════════════════════════════════════════════════════
   USE CASE 2 — System Integration Demo
   A live connection diagram showing systems being linked
   ═══════════════════════════════════════════════════════ */

const SYSTEMS = [
	{ name: "SAP ERP", status: "connected", color: "bg-emerald-400" },
	{ name: "Jira", status: "connected", color: "bg-emerald-400" },
	{ name: "GitLab", status: "connected", color: "bg-emerald-400" },
	{ name: "Confluence", status: "syncing", color: "bg-amber-400" },
	{ name: "Slack", status: "pending", color: "bg-white/20" },
];

export function SystemIntegrationDemo({ className }: { className?: string }) {
	const [step, setStep] = useState(0);

	useEffect(() => {
		const timers = SYSTEMS.map((_, i) =>
			setTimeout(() => setStep(i + 1), 600 + i * 700),
		);
		return () => timers.forEach(clearTimeout);
	}, []);

	return (
		<div
			className={cn(
				"overflow-hidden rounded-2xl border border-white/[0.08] bg-[#1a1a1a]",
				className,
			)}
		>
			{/* Header */}
			<div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-3">
				<div className="flex items-center gap-2">
					<div className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]" />
					<span className="text-xs font-semibold text-white/70">
						System Connections
					</span>
				</div>
				<span className="text-[10px] text-white/30">
					{step} of {SYSTEMS.length} connected
				</span>
			</div>

			<div className="p-5 space-y-3">
				{/* Central AI Worker node */}
				<div className="flex items-center justify-center py-3">
					<div className="flex items-center gap-2 rounded-lg border border-violet-500/30 bg-violet-500/10 px-4 py-2">
						<div className="h-2 w-2 rounded-full bg-violet-400 animate-pulse" />
						<span className="text-sm font-semibold text-violet-300">
							AI Worker
						</span>
					</div>
				</div>

				{/* Connection lines */}
				<div className="space-y-2">
					{SYSTEMS.map((sys, i) => (
						<div
							key={sys.name}
							className={cn(
								"flex items-center gap-3 rounded-lg px-4 py-2.5 transition-all duration-500",
								i < step
									? "bg-white/[0.04] translate-x-0 opacity-100"
									: "translate-x-[-10px] opacity-0",
							)}
						>
							<span
								className={cn(
									"h-2 w-2 shrink-0 rounded-full transition-colors duration-300",
									i < step ? sys.color : "bg-white/10",
								)}
							/>
							<span className="text-sm text-white/70 flex-1">{sys.name}</span>
							<div className="flex items-center gap-1.5">
								{/* Connection line animation */}
								<div
									className={cn(
										"h-px w-8 transition-all duration-700",
										i < step
											? "bg-gradient-to-r from-violet-400/50 to-emerald-400/50"
											: "bg-white/5",
									)}
								/>
								<span
									className={cn(
										"text-[10px] font-medium",
										sys.status === "connected" && i < step
											? "text-emerald-400"
											: "",
										sys.status === "syncing" && i < step
											? "text-amber-400"
											: "",
										!(i < step) ? "text-white/20" : "",
									)}
								>
									{i < step ? sys.status : "waiting"}
								</span>
							</div>
						</div>
					))}
				</div>

				{/* Progress bar */}
				<div className="mt-4 space-y-1.5">
					<div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
						<div
							className="h-full rounded-full bg-gradient-to-r from-violet-500 to-emerald-500 transition-all duration-1000 ease-out"
							style={{ width: `${(step / SYSTEMS.length) * 100}%` }}
						/>
					</div>
					<p className="text-center text-[10px] text-white/30">
						Connected in days, not months
					</p>
				</div>
			</div>
		</div>
	);
}

/* ═══════════════════════════════════════════════════════
   USE CASE 3 — GEO & Content Demo
   A content dashboard showing articles being generated
   ═══════════════════════════════════════════════════════ */

const ARTICLES = [
	{
		title: "How AI is Reshaping Customer Service in 2026",
		status: "published",
		score: 94,
	},
	{ title: "The Future of Agentic Commerce", status: "published", score: 91 },
	{
		title: "Why Smart Companies Invest in AI Workers",
		status: "writing",
		score: 0,
	},
];

export function ContentDemo({ className }: { className?: string }) {
	const [visible, setVisible] = useState(0);

	useEffect(() => {
		const timers = ARTICLES.map((_, i) =>
			setTimeout(() => setVisible(i + 1), 400 + i * 600),
		);
		return () => timers.forEach(clearTimeout);
	}, []);

	return (
		<div
			className={cn(
				"overflow-hidden rounded-2xl border border-white/[0.08] bg-[#1a1a1a]",
				className,
			)}
		>
			{/* Header */}
			<div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-3">
				<div className="flex items-center gap-2">
					<div className="h-2 w-2 rounded-full bg-fuchsia-400 shadow-[0_0_6px_rgba(232,121,249,0.6)]" />
					<span className="text-xs font-semibold text-white/70">
						Content Engine
					</span>
				</div>
				<span className="text-[10px] text-white/30">3 articles this week</span>
			</div>

			<div className="p-5 space-y-3">
				{/* Brand config */}
				<div className="flex items-center gap-2 rounded-lg bg-fuchsia-500/[0.06] border border-fuchsia-500/10 px-3 py-2">
					<span className="text-[10px] font-semibold text-fuchsia-400">
						Brand voice:
					</span>
					<span className="text-[10px] text-white/50">
						Professional, authoritative, data-driven
					</span>
				</div>

				{/* Articles list */}
				<div className="space-y-2">
					{ARTICLES.map((article, i) => (
						<div
							key={article.title}
							className={cn(
								"rounded-lg bg-white/[0.03] border border-white/[0.04] p-3 transition-all duration-500",
								i < visible
									? "translate-y-0 opacity-100"
									: "translate-y-3 opacity-0",
							)}
						>
							<div className="flex items-start justify-between gap-2">
								<p className="text-xs text-white/70 leading-tight flex-1">
									{article.title}
								</p>
								{article.status === "published" ? (
									<span className="shrink-0 rounded bg-emerald-500/20 px-1.5 py-0.5 text-[9px] font-bold text-emerald-400">
										Published
									</span>
								) : (
									<span className="shrink-0 rounded bg-amber-500/20 px-1.5 py-0.5 text-[9px] font-bold text-amber-400 animate-pulse">
										Writing...
									</span>
								)}
							</div>
							{article.score > 0 && (
								<div className="mt-2 flex items-center gap-2">
									<div className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
										<div
											className="h-full rounded-full bg-emerald-500"
											style={{ width: `${article.score}%` }}
										/>
									</div>
									<span className="text-[9px] text-emerald-400">
										{article.score}% SEO
									</span>
								</div>
							)}
						</div>
					))}
				</div>

				{/* Tags */}
				<div className="flex flex-wrap gap-1.5 pt-1">
					{["SEO optimized", "Brand-aligned", "Research-grade"].map((tag) => (
						<span
							key={tag}
							className="rounded-full bg-white/[0.04] px-2 py-0.5 text-[9px] text-white/40"
						>
							{tag}
						</span>
					))}
				</div>
			</div>
		</div>
	);
}

/* ═══════════════════════════════════════════════════════
   USE CASE 4 — Solo Founder Demo
   A growing task list showing tedi taking over more work
   ═══════════════════════════════════════════════════════ */

const TASKS = [
	{ name: "Company knowledge base", status: "done" as const, delay: 0.3 },
	{ name: "GEO optimization", status: "done" as const, delay: 0.6 },
	{ name: "High-quality content", status: "done" as const, delay: 0.9 },
	{ name: "Platform redesign", status: "progress" as const, delay: 1.2 },
	{ name: "Customer onboarding flow", status: "progress" as const, delay: 1.5 },
	{ name: "Analytics dashboard", status: "planned" as const, delay: 1.8 },
];

export function SoloFounderDemo({ className }: { className?: string }) {
	const [visible, setVisible] = useState(0);

	useEffect(() => {
		const timers = TASKS.map((_, i) =>
			setTimeout(() => setVisible(i + 1), 500 + i * 500),
		);
		return () => timers.forEach(clearTimeout);
	}, []);

	const doneCount = TASKS.filter((t) => t.status === "done").length;
	const progressCount = TASKS.filter((t) => t.status === "progress").length;

	return (
		<div
			className={cn(
				"overflow-hidden rounded-2xl border border-white/[0.08] bg-[#1a1a1a]",
				className,
			)}
		>
			{/* Header */}
			<div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-3">
				<div className="flex items-center gap-2">
					<div className="h-2 w-2 rounded-full bg-orange-400 shadow-[0_0_6px_rgba(251,146,60,0.6)]" />
					<span className="text-xs font-semibold text-white/70">
						Tedi Progress
					</span>
				</div>
				<div className="flex items-center gap-2 text-[10px]">
					<span className="text-emerald-400">{doneCount} done</span>
					<span className="text-white/20">&bull;</span>
					<span className="text-amber-400">{progressCount} active</span>
				</div>
			</div>

			<div className="p-5 space-y-2">
				{TASKS.map((task, i) => (
					<div
						key={task.name}
						className={cn(
							"flex items-center gap-3 rounded-lg px-3 py-2.5 transition-all duration-500",
							i < visible
								? "translate-x-0 opacity-100"
								: "translate-x-[-10px] opacity-0",
							task.status === "done"
								? "bg-emerald-500/[0.04]"
								: "bg-white/[0.02]",
						)}
					>
						<span
							className={cn(
								"h-2 w-2 shrink-0 rounded-full",
								task.status === "done" ? "bg-emerald-400" : "",
								task.status === "progress" ? "bg-amber-400 animate-pulse" : "",
								task.status === "planned" ? "bg-white/15" : "",
							)}
						/>
						<span
							className={cn(
								"text-sm flex-1",
								task.status === "done" ? "text-white/60" : "",
								task.status === "progress" ? "text-white/70" : "",
								task.status === "planned" ? "text-white/30" : "",
							)}
						>
							{task.name}
						</span>
						<span
							className={cn(
								"text-[10px] font-medium",
								task.status === "done" ? "text-emerald-400" : "",
								task.status === "progress" ? "text-amber-400" : "",
								task.status === "planned" ? "text-white/20" : "",
							)}
						>
							{task.status}
						</span>
					</div>
				))}

				<p className="pt-2 text-center text-[10px] text-white/30">
					One tedi, expanding autonomy
				</p>
			</div>
		</div>
	);
}

/* ═══════════════════════════════════════════════════════
   USE CASE 5 — Rapid Deployment Demo
   A dramatic timeline showing 365 days → 5 days
   ═══════════════════════════════════════════════════════ */

export function RapidDeployDemo({ className }: { className?: string }) {
	const [show, setShow] = useState(false);
	const [countDown, setCountDown] = useState(365);

	useEffect(() => {
		const t = setTimeout(() => setShow(true), 300);
		return () => clearTimeout(t);
	}, []);

	useEffect(() => {
		if (!show) return;
		if (countDown <= 5) return;

		const speed = countDown > 100 ? 15 : countDown > 30 ? 40 : 80;
		const step = countDown > 100 ? 20 : countDown > 30 ? 5 : 1;

		const timer = setTimeout(() => {
			setCountDown((prev) => Math.max(5, prev - step));
		}, speed);

		return () => clearTimeout(timer);
	}, [show, countDown]);

	const milestones = [
		{ label: "Project scoped", day: "Day 1", done: countDown <= 300 },
		{ label: "Platform deployed", day: "Day 3", done: countDown <= 100 },
		{ label: "Content populated", day: "Day 4", done: countDown <= 30 },
		{ label: "Live & public", day: "Day 5", done: countDown <= 5 },
	];

	return (
		<div
			className={cn(
				"overflow-hidden rounded-2xl border border-white/[0.08] bg-[#1a1a1a]",
				className,
			)}
		>
			{/* Header */}
			<div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-3">
				<div className="flex items-center gap-2">
					<div className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]" />
					<span className="text-xs font-semibold text-white/70">
						MiMexTrade Launch
					</span>
				</div>
				<span className="text-[10px] text-white/30">Timeline</span>
			</div>

			<div className="p-6">
				{/* Countdown */}
				<div className="mb-6 text-center">
					<p className="text-xs text-white/30 mb-1">Estimated: 365 days</p>
					<div className="flex items-center justify-center gap-3">
						<span
							className={cn(
								"font-bold font-mono text-4xl tabular-nums transition-colors duration-300",
								countDown <= 5 ? "text-emerald-400" : "text-white/80",
							)}
						>
							{countDown}
						</span>
						<span className="text-sm text-white/30">days</span>
					</div>
					{countDown <= 5 && (
						<p className="mt-1 text-xs font-semibold text-emerald-400 animate-pulse">
							Delivered!
						</p>
					)}
				</div>

				{/* Milestones */}
				<div className="space-y-2">
					{milestones.map((m) => (
						<div
							key={m.label}
							className={cn(
								"flex items-center gap-3 rounded-lg px-3 py-2 transition-all duration-500",
								m.done ? "bg-emerald-500/[0.06]" : "bg-white/[0.02]",
							)}
						>
							<span
								className={cn(
									"h-2 w-2 shrink-0 rounded-full transition-colors",
									m.done ? "bg-emerald-400" : "bg-white/10",
								)}
							/>
							<span
								className={cn(
									"text-xs flex-1",
									m.done ? "text-white/70" : "text-white/30",
								)}
							>
								{m.label}
							</span>
							<span
								className={cn(
									"text-[10px] font-medium",
									m.done ? "text-emerald-400" : "text-white/20",
								)}
							>
								{m.day}
							</span>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
