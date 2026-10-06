"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
	Brain,
	CheckCircle2,
	CircleDollarSign,
	Clock3,
	Code2,
	FileText,
	Gauge,
	GitBranch,
	KeyRound,
	LockKeyhole,
	type LucideIcon,
	Pause,
	Play,
	ReceiptText,
	RefreshCw,
	ShieldCheck,
	Sparkles,
	Terminal,
	WalletCards,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";

type PaymentPhase =
	| "intent"
	| "calling"
	| "paymentRequired"
	| "budgetCheck"
	| "proofSubmitted"
	| "settled"
	| "memoryLearned"
	| "avoidedRepeatSpend";

type Step = {
	key: PaymentPhase;
	label: string;
	description: string;
	icon: LucideIcon;
	durationMs: number;
	command: string;
};

const steps: Step[] = [
	{
		key: "intent",
		label: "Spend decision",
		description: "CTO weighs confidence, impact, and price before buying.",
		icon: Brain,
		durationMs: 2200,
		command: "decision.intent confidence=62 impact=high",
	},
	{
		key: "calling",
		label: "MCP request",
		description: "Tedix Unified requests the payable research tool.",
		icon: Code2,
		durationMs: 2400,
		command: "mcp.call paymesh__premium_research_brief",
	},
	{
		key: "paymentRequired",
		label: "x402 requirement",
		description: "The tool returns price, network, recipient, and id.",
		icon: CircleDollarSign,
		durationMs: 2400,
		command: "x402.required amount=0.01USDC network=solana-devnet",
	},
	{
		key: "budgetCheck",
		label: "Budget gate",
		description: "Org-scoped policy decides whether CTO may spend.",
		icon: Gauge,
		durationMs: 2600,
		command: "budget.enforce org=tedi tedi=cto window=24h",
	},
	{
		key: "proofSubmitted",
		label: "Proof attached",
		description: "Payment proof is bound to the original requirement.",
		icon: KeyRound,
		durationMs: 2200,
		command: "x402.proof attach requirement=tedix-x402-e2a4...",
	},
	{
		key: "settled",
		label: "Receipt stored",
		description: "Receipt, rationale, and audit event become inspectable.",
		icon: ReceiptText,
		durationMs: 2600,
		command: "ledger.settle receipt=d814425f rationale=dc39001b",
	},
	{
		key: "memoryLearned",
		label: "Memory update",
		description: "tedix-context writes scoped economic judgment.",
		icon: Sparkles,
		durationMs: 2600,
		command: "memory.learn lesson=paid_path_utility scope=org+cto+tool",
	},
	{
		key: "avoidedRepeatSpend",
		label: "Cost saved",
		description: "The next decision uses memory instead of paying again.",
		icon: ShieldCheck,
		durationMs: 5200,
		command: "router.choose free_path saved=0.01USDC",
	},
];

const eventData = {
	tedi: "CTO Tedi",
	task: "Decide whether external pricing evidence is worth buying.",
	tool: "paymesh__premium_research_brief",
	app: "tedix-unified",
	requirementId: "tedix-x402-e2a4fd9aa01cef540f689f45",
	paymentRequestId: "7ee21e41-0cfa-49c9-b8cf-53afe523ca3d",
	receiptId: "d814425f-295d-4c18-8650-c2d037c66f05",
	rationaleId: "dc39001b-09b2-437d-a6c0-6ddae7d66c84",
	auditId: "e407665c-a692-4d60-906b-6458ae1ea80f",
	amount: "0.01 USDC",
	network: "solana-devnet",
	budgetSpent: "0.17",
	budgetMax: "1.00",
	budgetPercent: 17,
	settledCount: 17,
};

const navItems = [
	{ label: "Mission", detail: "active", icon: Brain },
	{ label: "Budget", detail: "17%", icon: WalletCards },
	{ label: "Ledger", detail: "receipt", icon: ReceiptText },
	{ label: "Memory", detail: "learning", icon: Sparkles },
];

const artifactRows = [
	{
		label: "Requirement",
		value: eventData.requirementId,
		icon: CircleDollarSign,
	},
	{ label: "Receipt", value: eventData.receiptId, icon: ReceiptText },
	{ label: "Rationale", value: eventData.rationaleId, icon: Brain },
	{ label: "Audit", value: eventData.auditId, icon: FileText },
];

const policyRows = [
	"Confidence is below the paid-evidence threshold",
	"Decision impact is higher than requested cost",
	"Org budget remains inside the 24h window",
	"Prior receipts show this path can be useful",
];

function shortId(value: string) {
	if (value.length <= 18) return value;
	return `${value.slice(0, 12)}...${value.slice(-7)}`;
}

function getStepState(index: number, activeIndex: number) {
	if (index < activeIndex) return "complete";
	if (index === activeIndex) return "active";
	return "queued";
}

function phaseCopy(phase: PaymentPhase) {
	const copy: Record<PaymentPhase, string> = {
		intent: "Evaluating",
		calling: "Requesting",
		paymentRequired: "Payment required",
		budgetCheck: "Policy check",
		proofSubmitted: "Proof sent",
		settled: "Receipt stored",
		memoryLearned: "Memory updated",
		avoidedRepeatSpend: "Cost saved",
	};

	return copy[phase];
}

function TinyIcon({
	icon: Icon,
	active,
}: {
	icon: LucideIcon;
	active?: boolean;
}) {
	return (
		<div
			className={cn(
				"flex size-7 shrink-0 items-center justify-center rounded-md border",
				active
					? "border-[#7df0b2]/35 bg-[#7df0b2]/12 text-[#a8f5c7]"
					: "border-white/10 bg-white/[0.035] text-[#8ba79d]",
			)}
		>
			<Icon className="size-3.5" />
		</div>
	);
}

function ShellPanel({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<Card
			className={cn(
				"rounded-xl border border-[#263140] bg-[#151a22]/88 py-0 text-[#d8eadf] shadow-none backdrop-blur",
				className,
			)}
			size="sm"
		>
			<CardContent className="p-0">{children}</CardContent>
		</Card>
	);
}

function PhaseControls({
	phase,
	progress,
	isPlaying,
	onToggle,
	onRestart,
}: {
	phase: PaymentPhase;
	progress: number;
	isPlaying: boolean;
	onToggle: () => void;
	onRestart: () => void;
}) {
	return (
		<div className="flex flex-wrap items-center gap-2">
			<Badge className="h-8 rounded-lg border border-[#7df0b2]/30 bg-[#7df0b2]/10 px-3 font-mono text-[#a8f5c7]">
				<span className="mr-2 size-1.5 rounded-full bg-[#7df0b2]" />
				{phaseCopy(phase)}
			</Badge>
			<Badge className="h-8 rounded-lg border border-[#2c3444] bg-[#1c2230] px-3 font-mono text-[#88a194]">
				<Clock3 className="mr-2 size-3.5" />
				{progress}% complete
			</Badge>
			<Button
				className="h-8 rounded-lg border-[#2c3444] bg-[#1c2230] px-3 text-[#d8eadf] hover:bg-[#242d3b]"
				onClick={onToggle}
				size="sm"
				variant="outline"
			>
				{isPlaying ? (
					<Pause className="size-3.5" />
				) : (
					<Play className="size-3.5" />
				)}
				{isPlaying ? "Pause" : "Play"}
			</Button>
			<Button
				className="h-8 rounded-lg bg-[#5bf1ad] px-3 text-[#07120d] hover:bg-[#8ffac8]"
				onClick={onRestart}
				size="sm"
			>
				<RefreshCw className="size-3.5" />
				Restart
			</Button>
		</div>
	);
}

function LeftRail({
	activeIndex,
	phase,
}: {
	activeIndex: number;
	phase: PaymentPhase;
}) {
	return (
		<aside className="hidden min-h-[calc(100vh-2rem)] border-[#242b38] border-r bg-[#222a33]/72 px-3 py-4 text-[#9fc8aa] lg:block">
			<div className="mb-5 flex items-center gap-2 px-2">
				<div className="flex size-8 items-center justify-center rounded-lg bg-[#8cf8c5]/10 text-[#a6f5c6]">
					<CircleDollarSign className="size-4" />
				</div>
				<div>
					<div className="font-semibold text-[#d7f4df] text-sm">TedixPay</div>
					<div className="font-mono text-[#7f9d8d] text-[10px]">
						economic runtime
					</div>
				</div>
			</div>

			<div className="space-y-1">
				{navItems.map((item, index) => {
					const Icon = item.icon;
					const active = index <= Math.min(activeIndex, navItems.length - 1);
					return (
						<div
							className={cn(
								"flex items-center justify-between rounded-lg px-2 py-2 font-mono text-[12px]",
								active ? "bg-[#9cf6c7]/10 text-[#bdf8d1]" : "text-[#87a193]",
							)}
							key={item.label}
						>
							<span className="flex items-center gap-2">
								<Icon className="size-3.5" />
								{item.label}
							</span>
							<span className="text-[10px] opacity-70">{item.detail}</span>
						</div>
					);
				})}
			</div>

			<div className="mt-7 px-2">
				<div className="mb-2 font-mono text-[#748678] text-[10px] uppercase">
					Spend window
				</div>
				<div className="rounded-xl border border-[#3c4654] bg-[#151a22]/60 p-3">
					<div className="flex items-end justify-between gap-2">
						<div className="font-mono text-[#dffbe8] text-lg">
							{eventData.budgetSpent}
						</div>
						<div className="pb-0.5 font-mono text-[#789386] text-[11px]">
							/ {eventData.budgetMax} USDC
						</div>
					</div>
					<Progress
						className="mt-3 [&_[data-slot=progress-indicator]]:bg-[#6af0b3] [&_[data-slot=progress-track]]:h-1.5 [&_[data-slot=progress-track]]:bg-[#2a313d]"
						value={eventData.budgetPercent}
					/>
					<div className="mt-3 flex items-center gap-2 font-mono text-[#88a194] text-[10px]">
						<span className="size-1.5 rounded-full bg-[#6af0b3]" />
						{phaseCopy(phase)}
					</div>
				</div>
			</div>
		</aside>
	);
}

function RunHeader({
	activeStep,
	phase,
	progress,
	isPlaying,
	onToggle,
	onRestart,
}: {
	activeStep: Step;
	phase: PaymentPhase;
	progress: number;
	isPlaying: boolean;
	onToggle: () => void;
	onRestart: () => void;
}) {
	return (
		<header className="border-[#242b38] border-b bg-[#0d091d]/92 px-4 py-4 md:px-6">
			<div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
				<div className="min-w-0">
					<div className="mb-3 flex flex-wrap items-center gap-2 font-mono text-[12px]">
						<span className="rounded-md bg-[#5ef0aa]/10 px-2 py-1 text-[#a8f5c7]">
							TEDIXPAY
						</span>
						<span className="text-[#6e7f76]">/</span>
						<span className="text-[#92a89c]">x402</span>
						<span className="text-[#6e7f76]">/</span>
						<span className="truncate text-[#d8eadf]">{activeStep.key}</span>
					</div>
					<h1 className="max-w-3xl font-semibold text-2xl text-[#edf8ef] tracking-[-0.01em] md:text-[2rem]">
						An agent decides whether money should move
					</h1>
					<p className="mt-2 text-[#ffe17a] text-sm font-medium">
						Interactive simulation — sample data. No real payments are made.
					</p>
					<p className="mt-2 max-w-2xl text-[#93a29a] text-sm leading-6">
						This example shows a payable MCP call becoming a budget decision,
						receipt, rationale, and memory signal. A later decision reuses the
						sample evidence instead of repeating the purchase.
					</p>
				</div>

				<PhaseControls
					isPlaying={isPlaying}
					onRestart={onRestart}
					onToggle={onToggle}
					phase={phase}
					progress={progress}
				/>
			</div>
		</header>
	);
}

function CommandStack({ activeIndex }: { activeIndex: number }) {
	return (
		<ShellPanel className="overflow-hidden">
			<div className="flex items-center justify-between border-[#263140] border-b px-4 py-3">
				<div className="flex items-center gap-2 font-mono text-[#a8f5c7] text-sm">
					<Terminal className="size-4" />
					payment run
				</div>
				<div className="font-mono text-[#70867d] text-xs">
					8 files changed + agent memory
				</div>
			</div>
			<div className="divide-y divide-[#263140]">
				{steps.map((step, index) => {
					const state = getStepState(index, activeIndex);
					const Icon = step.icon;
					return (
						<div
							className={cn(
								"grid grid-cols-[2rem_1fr_auto] gap-3 px-4 py-3 transition-colors duration-500",
								state === "active" && "bg-[#ffe17a]/7",
								state === "complete" && "bg-[#69f0ae]/6",
							)}
							key={step.key}
						>
							<TinyIcon
								active={state !== "queued"}
								icon={state === "complete" ? CheckCircle2 : Icon}
							/>
							<div className="min-w-0">
								<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
									<div className="font-semibold text-[#e7f5ea] text-sm">
										{step.label}
									</div>
									<code className="truncate font-mono text-[#8ea097] text-[11px]">
										{step.command}
									</code>
								</div>
								<div className="mt-1 text-[#7f9188] text-xs leading-5">
									{step.description}
								</div>
							</div>
							<div
								className={cn(
									"pt-1 font-mono text-[10px] uppercase",
									state === "active"
										? "text-[#ffe17a]"
										: state === "complete"
											? "text-[#8ffac8]"
											: "text-[#58675f]",
								)}
							>
								{state}
							</div>
						</div>
					);
				})}
			</div>
		</ShellPanel>
	);
}

function ConversationPanel({ phase }: { phase: PaymentPhase }) {
	const repeatAvoided = phase === "avoidedRepeatSpend";

	return (
		<div className="space-y-4">
			<div className="ml-auto max-w-[640px] rounded-2xl border border-[#334054] bg-[#222a36] px-4 py-3 text-[#cfe3d6] shadow-black/10 shadow-lg">
				<div className="mb-2 font-mono text-[#8fa49a] text-[11px]">
					task from CTO
				</div>
				{eventData.task}
			</div>

			<div className="max-w-[760px] rounded-2xl border border-[#263140] bg-[#151a22] px-4 py-4">
				<div className="mb-3 flex items-center gap-2">
					<TinyIcon active icon={Brain} />
					<div>
						<div className="font-semibold text-[#edf8ef]">{eventData.tedi}</div>
						<div className="font-mono text-[#7f9188] text-[11px]">
							economic reasoning
						</div>
					</div>
				</div>
				<p className="text-[#aebeb5] text-sm leading-6">
					{repeatAvoided
						? "In this simulation, the sample receipt represents earlier paid evidence. I will reuse that evidence rather than repeat the purchase."
						: "Confidence is low enough to justify paid evidence, but only if the organization policy allows the spend and the receipt remains auditable."}
				</p>
			</div>

			<div className="grid gap-3 sm:grid-cols-3">
				<div className="rounded-xl border border-[#263140] bg-[#151a22] p-4">
					<div className="font-mono text-[#7f9188] text-[11px] uppercase">
						confidence
					</div>
					<div className="mt-2 font-mono text-2xl text-[#9ff5c6]">
						{repeatAvoided ? "81%" : "62%"}
					</div>
					<div className="mt-1 text-[#819188] text-xs">
						{repeatAvoided ? "prior evidence retrieved" : "below threshold"}
					</div>
				</div>
				<div className="rounded-xl border border-[#263140] bg-[#151a22] p-4">
					<div className="font-mono text-[#7f9188] text-[11px] uppercase">
						request price
					</div>
					<div className="mt-2 font-mono text-2xl text-[#ffe17a]">
						{eventData.amount}
					</div>
					<div className="mt-1 text-[#819188] text-xs">{eventData.network}</div>
				</div>
				<div className="rounded-xl border border-[#263140] bg-[#151a22] p-4">
					<div className="font-mono text-[#7f9188] text-[11px] uppercase">
						next action
					</div>
					<div className="mt-2 font-mono text-2xl text-[#edf8ef]">
						{repeatAvoided ? "save" : "verify"}
					</div>
					<div className="mt-1 text-[#819188] text-xs">
						{repeatAvoided ? "0.01 USDC preserved" : phaseCopy(phase)}
					</div>
				</div>
			</div>

			<ShellPanel className="overflow-hidden">
				<div className="border-[#263140] border-b px-4 py-3 font-mono text-[#92a89c] text-xs">
					tool invocation
				</div>
				<pre className="overflow-hidden px-4 py-4 font-mono text-[#bcd5c5] text-xs leading-6">
					{`paymesh.premium_research_brief({
  requester: "cto",
  budgetWindow: "24h",
  policy: "org-scoped",
  maxAmount: "0.01 USDC"
})`}
				</pre>
			</ShellPanel>
		</div>
	);
}

function PolicyPanel({ activeIndex }: { activeIndex: number }) {
	return (
		<ShellPanel>
			<div className="border-[#263140] border-b px-4 py-3">
				<div className="flex items-center gap-2 font-mono text-[#a8f5c7] text-sm">
					<WalletCards className="size-4" />
					budget gate
				</div>
			</div>
			<div className="p-4">
				<div className="grid grid-cols-2 gap-3">
					<div className="rounded-lg border border-[#303a48] bg-[#1b222c] p-3">
						<div className="font-mono text-[#73887e] text-[10px] uppercase">
							spent
						</div>
						<div className="mt-1 font-mono text-[#9ff5c6] text-xl">
							{eventData.budgetSpent}
						</div>
					</div>
					<div className="rounded-lg border border-[#303a48] bg-[#1b222c] p-3">
						<div className="font-mono text-[#73887e] text-[10px] uppercase">
							limit
						</div>
						<div className="mt-1 font-mono text-[#edf8ef] text-xl">
							{eventData.budgetMax}
						</div>
					</div>
				</div>

				<div className="mt-4">
					<div className="mb-2 flex justify-between font-mono text-[#809286] text-[11px]">
						<span>org window</span>
						<span>{eventData.budgetPercent}%</span>
					</div>
					<Progress
						className="[&_[data-slot=progress-indicator]]:bg-[#5bf1ad] [&_[data-slot=progress-track]]:h-1.5 [&_[data-slot=progress-track]]:bg-[#2a313d]"
						value={eventData.budgetPercent}
					/>
				</div>

				<div className="mt-4 space-y-2">
					{policyRows.map((row, index) => (
						<div
							className="flex items-start gap-2 border-[#263140] border-t pt-2 text-[#9eaea5] text-xs leading-5"
							key={row}
						>
							<CheckCircle2
								className={cn(
									"mt-0.5 size-3.5 shrink-0",
									activeIndex >= index + 2
										? "text-[#7df0b2]"
										: "text-[#55645d]",
								)}
							/>
							{row}
						</div>
					))}
				</div>
			</div>
		</ShellPanel>
	);
}

function InspectorPanel({
	activeIndex,
	phase,
}: {
	activeIndex: number;
	phase: PaymentPhase;
}) {
	const repeatAvoided = phase === "avoidedRepeatSpend";

	return (
		<aside className="space-y-4">
			<ShellPanel>
				<div className="flex items-center justify-between gap-3 border-[#263140] border-b px-4 py-3">
					<div className="font-mono text-[#a8f5c7] text-sm">
						economic memory
					</div>
					<Badge className="h-7 rounded-md border border-[#303a48] bg-[#10151c] px-2 font-mono text-[#d8eadf] text-[11px]">
						{repeatAvoided ? "Saved 0.01 USDC" : "Under review"}
					</Badge>
				</div>
				<div className="p-4">
					<div className="font-semibold text-[#edf8ef]">
						{repeatAvoided
							? "Free path selected"
							: "Receipt becomes policy memory"}
					</div>
					<p className="mt-2 text-[#9eaea5] text-sm leading-6">
						{repeatAvoided
							? "The tedi used prior settlement evidence instead of buying the same proof again."
							: "Payment truth stays in the ledger. Context observes the outcome and writes a scoped lesson."}
					</p>
					<div className="mt-4 rounded-lg border border-[#303a48] bg-[#10151c] p-3 font-mono text-[#90a69a] text-[11px] leading-5">
						<div>
							lesson:{" "}
							{repeatAvoided ? "fallback_preferred" : "paid_path_utility"}
						</div>
						<div>scope: org + cto + tool</div>
						<div>saved: {repeatAvoided ? "0.01 USDC" : "pending"}</div>
					</div>
				</div>
			</ShellPanel>

			<ShellPanel className="overflow-hidden">
				<div className="flex items-center justify-between border-[#263140] border-b px-4 py-3">
					<div className="flex items-center gap-2 font-mono text-[#a8f5c7] text-sm">
						<GitBranch className="size-4" />
						run details
					</div>
					<LockKeyhole className="size-4 text-[#7f9188]" />
				</div>

				<div className="divide-y divide-[#263140]">
					{artifactRows.map((artifact, index) => {
						const Icon = artifact.icon;
						const unlocked = activeIndex >= index + 2;
						return (
							<div className="px-4 py-3" key={artifact.label}>
								<div className="mb-1 flex items-center gap-2 font-mono text-[#7f9188] text-[11px] uppercase">
									<Icon className="size-3.5" />
									{artifact.label}
								</div>
								<div
									className={cn(
										"truncate font-mono text-[11px]",
										unlocked ? "text-[#d8eadf]" : "text-[#65756d]",
									)}
								>
									{unlocked ? artifact.value : shortId(artifact.value)}
								</div>
							</div>
						);
					})}
				</div>
			</ShellPanel>
		</aside>
	);
}

export default function TedixPayConsole() {
	const [activeIndex, setActiveIndex] = useState(0);
	const [isPlaying, setIsPlaying] = useState(true);
	const activeStep = steps[activeIndex] ?? steps[0];
	const phase = activeStep.key;
	const totalMs = useMemo(
		() => steps.reduce((sum, step) => sum + step.durationMs, 0),
		[],
	);
	const elapsedMs = useMemo(
		() =>
			steps
				.slice(0, activeIndex)
				.reduce((sum, step) => sum + step.durationMs, 0),
		[activeIndex],
	);
	const progress = Math.round((elapsedMs / totalMs) * 100);

	useEffect(() => {
		if (!isPlaying) return;
		const timeout = window.setTimeout(() => {
			setActiveIndex((current) => (current + 1) % steps.length);
		}, activeStep.durationMs);

		return () => window.clearTimeout(timeout);
	}, [activeIndex, activeStep.durationMs, isPlaying]);

	return (
		<section className="min-h-screen w-screen max-w-full overflow-x-hidden bg-[#090616] text-[#d8eadf]">
			<div className="min-h-screen bg-[linear-gradient(90deg,rgba(125,240,178,0.035)_1px,transparent_1px),linear-gradient(rgba(125,240,178,0.026)_1px,transparent_1px)] bg-[size:28px_28px]">
				<div className="mx-auto min-h-screen max-w-[1480px] border-[#242b38] border-x bg-[#0b0718]/96 shadow-2xl shadow-black/40">
					<div className="grid min-h-screen lg:grid-cols-[220px_minmax(0,1fr)]">
						<LeftRail activeIndex={activeIndex} phase={phase} />

						<div className="min-w-0">
							<RunHeader
								activeStep={activeStep}
								isPlaying={isPlaying}
								onRestart={() => {
									setActiveIndex(0);
									setIsPlaying(true);
								}}
								onToggle={() => setIsPlaying((value) => !value)}
								phase={phase}
								progress={progress}
							/>

							<main className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_minmax(340px,0.78fr)_320px]">
								<div className="min-w-0 space-y-4">
									<CommandStack activeIndex={activeIndex} />
								</div>
								<ConversationPanel phase={phase} />
								<div className="min-w-0 space-y-4">
									<PolicyPanel activeIndex={activeIndex} />
									<InspectorPanel activeIndex={activeIndex} phase={phase} />
								</div>
							</main>
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}
