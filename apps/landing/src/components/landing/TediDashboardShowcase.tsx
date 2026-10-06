"use client";

import { useState, useRef, useMemo, useCallback, useEffect } from "react";

// ─── Data constants ──────────────────────────────────────────────────────────

const SERIES_14 = {
	runs: [142, 138, 156, 171, 165, 188, 204, 196, 214, 232, 221, 248, 262, 281],
	saved: [71, 68, 82, 90, 86, 98, 109, 105, 118, 130, 124, 142, 152, 168],
	errors: [6, 8, 5, 7, 4, 6, 3, 5, 3, 2, 4, 2, 1, 2],
};
const SERIES_7 = {
	runs: [196, 214, 232, 221, 248, 262, 281],
	saved: [105, 118, 130, 124, 142, 152, 168],
	errors: [5, 3, 2, 4, 2, 1, 2],
};
const SERIES_30 = (() => {
	const r: number[] = [],
		s: number[] = [],
		e: number[] = [];
	for (let i = 0; i < 30; i++) {
		const base = 90 + i * 6 + Math.round(Math.sin(i / 2.5) * 18);
		r.push(base);
		s.push(Math.round(base * 0.55 + Math.cos(i / 3) * 9));
		e.push(Math.max(1, 9 - Math.round(i / 4) + (i % 5 === 0 ? 2 : 0)));
	}
	return { runs: r, saved: s, errors: e };
})();
const DAY_LABELS_14 = [
	"May 26",
	"27",
	"28",
	"29",
	"30",
	"31",
	"Jun 1",
	"2",
	"3",
	"4",
	"5",
	"6",
	"7",
	"Today",
];
const DAY_LABELS_7 = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Today"];
const DAY_LABELS_30 = Array.from({ length: 30 }, (_, i) =>
	i === 29 ? "Today" : `${i + 1}`,
);

type SeriesData = { runs: number[]; saved: number[]; errors: number[] };
const SERIES: Record<string, { data: SeriesData; labels: string[] }> = {
	"7d": { data: SERIES_7, labels: DAY_LABELS_7 },
	"14d": { data: SERIES_14, labels: DAY_LABELS_14 },
	"30d": { data: SERIES_30, labels: DAY_LABELS_30 },
};

type Workflow = {
	id: string;
	name: string;
	status: string;
	runs: number;
	success: number;
	avg: string;
	owner: string;
	tag: string;
};
const WORKFLOWS: Workflow[] = [
	{
		id: "wf1",
		name: "Lead → CRM enrichment",
		status: "active",
		runs: 4218,
		success: 99.2,
		avg: "1.4s",
		owner: "Marina K.",
		tag: "Sales",
	},
	{
		id: "wf2",
		name: "Support ticket triage",
		status: "active",
		runs: 3107,
		success: 97.8,
		avg: "0.9s",
		owner: "Daniel R.",
		tag: "Support",
	},
	{
		id: "wf3",
		name: "AI visibility report → Promptwatch",
		status: "active",
		runs: 982,
		success: 98.4,
		avg: "3.2s",
		owner: "Priya S.",
		tag: "Growth",
	},
	{
		id: "wf4",
		name: "Daily sales digest → Slack",
		status: "active",
		runs: 412,
		success: 100,
		avg: "0.6s",
		owner: "Daniel R.",
		tag: "Sales",
	},
	{
		id: "wf5",
		name: "Stripe failed-payment recovery",
		status: "paused",
		runs: 88,
		success: 94.1,
		avg: "2.1s",
		owner: "Marina K.",
		tag: "Finance",
	},
	{
		id: "wf6",
		name: "Contract NDA pre-fill",
		status: "draft",
		runs: 0,
		success: 0,
		avg: "—",
		owner: "Alex T.",
		tag: "Legal",
	},
	{
		id: "wf7",
		name: "Notion → Linear sync",
		status: "active",
		runs: 1664,
		success: 99.7,
		avg: "0.4s",
		owner: "Alex T.",
		tag: "Eng",
	},
	{
		id: "wf8",
		name: "Onboarding email cadence",
		status: "active",
		runs: 720,
		success: 98.9,
		avg: "1.1s",
		owner: "Marina K.",
		tag: "Growth",
	},
];

type Automation = {
	id: string;
	name: string;
	tools: string[];
	runs: string;
	saved: string;
};
const AUTOMATIONS: Automation[] = [
	{
		id: "a1",
		name: "Inbox → classify → respond",
		tools: ["Gmail", "Tedix LLM", "HubSpot"],
		runs: "12.4k",
		saved: "210h",
	},
	{
		id: "a2",
		name: "Calendar prep brief",
		tools: ["GCal", "Notion", "Linear"],
		runs: "3.2k",
		saved: "62h",
	},
	{
		id: "a3",
		name: "PR review summary",
		tools: ["GitHub", "Tedix LLM", "Slack"],
		runs: "1.8k",
		saved: "44h",
	},
	{
		id: "a4",
		name: "AI search visibility alert",
		tools: ["Promptwatch", "Tedix LLM", "Slack"],
		runs: "964",
		saved: "31h",
	},
	{
		id: "a5",
		name: "Voicemail → CRM note",
		tools: ["Twilio", "Whisper", "Salesforce"],
		runs: "612",
		saved: "18h",
	},
	{
		id: "a6",
		name: "Weekly investor update draft",
		tools: ["Stripe", "Notion", "Tedix LLM"],
		runs: "48",
		saved: "11h",
	},
];

type KBDoc = {
	id: string;
	folder: string;
	name: string;
	updated: string;
	body: string;
};
const KB_DOCS: KBDoc[] = [
	{
		id: "d1",
		folder: "Playbooks",
		name: "Customer escalation policy",
		updated: "2d ago",
		body: "Tier-1 responds within 4h. Anything tagged `urgent` or from `enterprise` accounts is auto-paged to the on-call lead. Tedix routes via the Support triage workflow.",
	},
	{
		id: "d2",
		folder: "Playbooks",
		name: "Pricing & discount matrix",
		updated: "5d ago",
		body: "Discount ladder: 10% for annual, 15% for 2yr, 20% for 3yr. Anything beyond requires `CFO approval`. Mid-market floor is $24k ARR.",
	},
	{
		id: "d3",
		folder: "Engineering",
		name: "Incident response runbook",
		updated: "1w ago",
		body: "Open `#inc-` channel, ping `@oncall`, post a status page note within 10 minutes. The PR review summary workflow auto-pulls the last 5 merged PRs.",
	},
	{
		id: "d4",
		folder: "Engineering",
		name: "Data retention defaults",
		updated: "3w ago",
		body: "Run logs: 90 days. PII fields are redacted at ingest unless the workflow has a `pii=allow` policy. Knowledge embeddings refresh nightly at `04:00 UTC`.",
	},
	{
		id: "d5",
		folder: "Sales",
		name: "ICP definition",
		updated: "4d ago",
		body: "Series A→C SaaS with 50–500 employees, US/EU, ops-heavy. Strong fit when they already use Slack + at least one of HubSpot / Salesforce.",
	},
	{
		id: "d6",
		folder: "Sales",
		name: "Objection handling",
		updated: "1d ago",
		body: "Most common: security review length. Counter: SOC2 Type II report + sandboxed deployment option. Loop in Marina for procurement calls.",
	},
];

type Integration = {
	name: string;
	cat: string;
	color: string;
	letter: string;
	logo: string;
	status: string;
};
const INTEGRATIONS: Integration[] = [
	{
		name: "Slack",
		cat: "Messaging",
		color: "#4A154B",
		letter: "#",
		logo: "/images/tools/slack.svg",
		status: "connected",
	},
	{
		name: "Gmail",
		cat: "Email",
		color: "#D14836",
		letter: "M",
		logo: "/images/tools/gmail.svg",
		status: "connected",
	},
	{
		name: "HubSpot",
		cat: "CRM",
		color: "#FF7A59",
		letter: "Hs",
		logo: "/images/tools/hubspot.svg",
		status: "connected",
	},
	{
		name: "Linear",
		cat: "Project",
		color: "#5E6AD2",
		letter: "L",
		logo: "/images/tools/linear.svg",
		status: "connected",
	},
	{
		name: "Notion",
		cat: "Docs",
		color: "#2F2F2F",
		letter: "N",
		logo: "/images/tools/notion.svg",
		status: "connected",
	},
	{
		name: "GitHub",
		cat: "Code",
		color: "#1F2328",
		letter: "Gh",
		logo: "/images/tools/github.svg",
		status: "connected",
	},
	{
		name: "Stripe",
		cat: "Payments",
		color: "#635BFF",
		letter: "$",
		logo: "/images/tools/stripe.svg",
		status: "connected",
	},
	{
		name: "Salesforce",
		cat: "CRM",
		color: "#00A1E0",
		letter: "Sf",
		logo: "/images/tools/salesforce.svg",
		status: "available",
	},
	{
		name: "Zendesk",
		cat: "Support",
		color: "#03363D",
		letter: "Zd",
		logo: "/images/tools/zendesk.svg",
		status: "available",
	},
	{
		name: "Intercom",
		cat: "Support",
		color: "#1F8DED",
		letter: "Ic",
		logo: "/images/tools/intercom.svg",
		status: "available",
	},
	{
		name: "Twilio",
		cat: "Voice/SMS",
		color: "#F22F46",
		letter: "Tw",
		logo: "/images/tools/twilio.svg",
		status: "connected",
	},
];

type RunLog = { t: string; wf: string; status: string; lat: string };
const RUN_LOG: RunLog[] = [
	{ t: "14:02:11", wf: "Lead → CRM enrichment", status: "ok", lat: "1.2s" },
	{ t: "14:01:54", wf: "Support ticket triage", status: "ok", lat: "0.8s" },
	{ t: "14:01:30", wf: "Notion → Linear sync", status: "ok", lat: "0.4s" },
	{
		t: "14:00:48",
		wf: "AI visibility report → Promptwatch",
		status: "warn",
		lat: "4.1s",
	},
	{ t: "14:00:12", wf: "Onboarding email cadence", status: "ok", lat: "1.0s" },
	{ t: "13:58:55", wf: "Lead → CRM enrichment", status: "ok", lat: "1.3s" },
	{ t: "13:58:02", wf: "Support ticket triage", status: "err", lat: "5.7s" },
	{
		t: "13:57:14",
		wf: "Daily sales digest → Slack",
		status: "ok",
		lat: "0.5s",
	},
];

// ─── Design tokens ────────────────────────────────────────────────────────────

const C = {
	bg: "#0b0a1a",
	panel: "#14132e",
	panelLight: "#1a1838",
	kpiCard: "#221f48",
	border: "rgba(168,132,252,0.10)",
	borderStrong: "rgba(168,132,252,0.18)",
	body: "#e0d6ff",
	secondary: "#b8a8e0",
	muted: "#7d6fa8",
	heading: "#f5ecff",
	violet: "#a855f7",
	violetSoft: "#c084fc",
	violetDeep: "#6d28d9",
	green: "#34d399",
	amber: "#fbbf24",
	rose: "#fb7185",
	cyan: "#22d3ee",
} as const;

const MONO = { fontFamily: "JetBrains Mono, monospace" } as const;
const SHELL_SHADOW =
	"0 1px 0 rgba(255,255,255,0.04) inset, 0 50px 100px -30px rgba(110,50,220,0.35), 0 30px 60px -20px rgba(0,0,0,0.7)";

// ─── Nav ──────────────────────────────────────────────────────────────────────

type NavId =
	| "overview"
	| "workflows"
	| "automations"
	| "knowledge"
	| "integrations"
	| "observability"
	| "settings";

const IcoHome = () => (
	<svg
		width="15"
		height="15"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2"
		strokeLinecap="round"
		strokeLinejoin="round"
	>
		<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
		<polyline points="9 22 9 12 15 12 15 22" />
	</svg>
);
const IcoBoxes = () => (
	<svg
		width="15"
		height="15"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2"
		strokeLinecap="round"
		strokeLinejoin="round"
	>
		<rect x="3" y="3" width="7" height="7" />
		<rect x="14" y="3" width="7" height="7" />
		<rect x="3" y="14" width="7" height="7" />
		<path d="M17.5 17.5 21 21M17.5 21 21 17.5" />
	</svg>
);
const IcoBolt = () => (
	<svg
		width="15"
		height="15"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2"
		strokeLinecap="round"
		strokeLinejoin="round"
	>
		<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
	</svg>
);
const IcoBook = () => (
	<svg
		width="15"
		height="15"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2"
		strokeLinecap="round"
		strokeLinejoin="round"
	>
		<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
		<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
	</svg>
);
const IcoGrid = () => (
	<svg
		width="15"
		height="15"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2"
		strokeLinecap="round"
		strokeLinejoin="round"
	>
		<rect x="3" y="3" width="7" height="7" />
		<rect x="14" y="3" width="7" height="7" />
		<rect x="3" y="14" width="7" height="7" />
		<rect x="14" y="14" width="7" height="7" />
	</svg>
);
const IcoActivity = () => (
	<svg
		width="15"
		height="15"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2"
		strokeLinecap="round"
		strokeLinejoin="round"
	>
		<polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
	</svg>
);
const IcoGear = () => (
	<svg
		width="15"
		height="15"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2"
		strokeLinecap="round"
		strokeLinejoin="round"
	>
		<circle cx="12" cy="12" r="3" />
		<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
	</svg>
);

const NAV_ITEMS: { id: NavId; label: string; icon: React.ReactNode }[] = [
	{ id: "overview", label: "Overview", icon: <IcoHome /> },
	{ id: "workflows", label: "Workflows", icon: <IcoBoxes /> },
	{ id: "automations", label: "Automations", icon: <IcoBolt /> },
	{ id: "knowledge", label: "Knowledge", icon: <IcoBook /> },
	{ id: "integrations", label: "Integrations", icon: <IcoGrid /> },
	{ id: "observability", label: "Observability", icon: <IcoActivity /> },
	{ id: "settings", label: "Settings", icon: <IcoGear /> },
];

// ─── Utility helpers ──────────────────────────────────────────────────────────

function sum(arr: number[]) {
	return arr.reduce((a, b) => a + b, 0);
}

function Sparkline({
	data,
	color,
	w = 60,
	h = 22,
}: {
	data: number[];
	color: string;
	w?: number;
	h?: number;
}) {
	if (!data.length) return null;
	const mn = Math.min(...data),
		mx = Math.max(...data),
		range = mx - mn || 1;
	const pts = data
		.map(
			(v, i) =>
				`${(i / (data.length - 1)) * w},${h - ((v - mn) / range) * (h - 4) - 2}`,
		)
		.join(" ");
	return (
		<svg width={w} height={h} style={{ overflow: "visible" }}>
			<polyline
				points={pts}
				fill="none"
				stroke={color}
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
	return (
		<div
			onClick={onToggle}
			style={{
				width: 32,
				height: 18,
				borderRadius: 9,
				cursor: "pointer",
				position: "relative",
				background: on ? "#a855f7" : "#3d3a5c",
				transition: "background 0.2s",
				flexShrink: 0,
			}}
		>
			<div
				style={{
					position: "absolute",
					top: 3,
					left: on ? 15 : 3,
					width: 12,
					height: 12,
					borderRadius: "50%",
					background: "#fff",
					transition: "left 0.2s",
				}}
			/>
		</div>
	);
}

function renderBody(text: string) {
	return text.split(/`([^`]+)`/).map((p, i) =>
		i % 2 === 1 ? (
			<code
				key={i}
				style={{
					background: "rgba(168,85,247,0.15)",
					color: C.violetSoft,
					padding: "1px 5px",
					borderRadius: 4,
					...MONO,
					fontSize: 11,
				}}
			>
				{p}
			</code>
		) : (
			<span key={i}>{p}</span>
		),
	);
}

function useInViewOnce<T extends HTMLElement>() {
	const ref = useRef<T | null>(null);
	const [seen, setSeen] = useState(false);

	useEffect(() => {
		if (seen) return;
		const node = ref.current;
		if (!node) return;

		const markIfVisible = () => {
			const rect = node.getBoundingClientRect();
			const height =
				window.innerHeight || document.documentElement.clientHeight;
			if (rect.top < height * 0.92 && rect.bottom > height * 0.08) {
				setSeen(true);
				return true;
			}
			return false;
		};

		if (markIfVisible()) return;

		if (typeof IntersectionObserver === "undefined") {
			setSeen(true);
			return;
		}

		const observer = new IntersectionObserver(
			([entry]) => {
				if (entry?.isIntersecting) {
					setSeen(true);
					observer.disconnect();
				}
			},
			{ threshold: 0.08, rootMargin: "0px 0px -6% 0px" },
		);

		observer.observe(node);

		const handleViewportChange = () => markIfVisible();
		window.addEventListener("scroll", handleViewportChange, { passive: true });
		window.addEventListener("resize", handleViewportChange);
		const fallback = window.setTimeout(() => setSeen(true), 450);

		return () => {
			observer.disconnect();
			window.removeEventListener("scroll", handleViewportChange);
			window.removeEventListener("resize", handleViewportChange);
			window.clearTimeout(fallback);
		};
	}, [seen]);

	return [ref, seen] as const;
}

function AnimatedNumber({
	active,
	duration = 1200,
	format,
	value,
}: {
	active: boolean;
	duration?: number;
	format: (value: number) => string;
	value: number;
}) {
	const [display, setDisplay] = useState(0);
	const currentRef = useRef(0);

	useEffect(() => {
		if (!active) return;

		const reduceMotion =
			typeof window !== "undefined" &&
			window.matchMedia("(prefers-reduced-motion: reduce)").matches;

		if (reduceMotion) {
			currentRef.current = value;
			setDisplay(value);
			return;
		}

		const startValue = currentRef.current;
		const delta = value - startValue;
		const startedAt = performance.now();
		let frame = 0;

		const tick = (now: number) => {
			const progress = Math.min(1, (now - startedAt) / duration);
			const eased = 1 - Math.pow(1 - progress, 3);
			const next = startValue + delta * eased;
			currentRef.current = next;
			setDisplay(next);

			if (progress < 1) {
				frame = requestAnimationFrame(tick);
			} else {
				currentRef.current = value;
				setDisplay(value);
			}
		};

		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [active, duration, value]);

	return <>{format(display)}</>;
}

function SegmentBtn({
	label,
	active,
	onClick,
}: {
	label: string;
	active: boolean;
	onClick: () => void;
}) {
	return (
		<button
			onClick={onClick}
			style={{
				padding: "2px 9px",
				borderRadius: 5,
				border: "none",
				cursor: "pointer",
				...MONO,
				fontSize: 10,
				background: active ? "rgba(168,85,247,0.2)" : "transparent",
				color: active ? C.violetSoft : C.muted,
			}}
		>
			{label}
		</button>
	);
}

// ─── VIEW: Overview ───────────────────────────────────────────────────────────

function ViewOverview() {
	const [overviewRef, metricsInView] = useInViewOnce<HTMLDivElement>();
	const [period, setPeriod] = useState<"7d" | "14d" | "30d">("14d");
	const [visible, setVisible] = useState({
		runs: true,
		saved: true,
		errors: true,
	});
	const [activeKpi, setActiveKpi] = useState("runs");
	const [insightOpen, setInsightOpen] = useState(false);
	const [insightDismissed, setInsightDismissed] = useState(false);
	const [hoverIdx, setHoverIdx] = useState<number | null>(null);
	const svgRef = useRef<SVGSVGElement>(null);

	const { data, labels } = SERIES[period];
	const totalRuns = sum(data.runs);
	const totalSaved = sum(data.saved);
	const activeWfs = WORKFLOWS.filter((w) => w.status === "active").length;
	const errRate = (sum(data.errors) / totalRuns) * 100;

	const W = 548,
		H = 172,
		PAD = { l: 34, r: 10, t: 14, b: 26 };
	const cW = W - PAD.l - PAD.r,
		cH = H - PAD.t - PAD.b;
	const n = data.runs.length;

	const scaleY = (arr: number[]) => {
		const mx = Math.max(...arr) * 1.15;
		return (v: number) => cH - (v / mx) * cH;
	};
	const syR = scaleY(data.runs),
		syS = scaleY(data.saved);
	const xOf = (i: number) => PAD.l + (i / (n - 1 || 1)) * cW;

	const pathOf = (vals: number[], sy: (v: number) => number) =>
		vals
			.map(
				(v, i) =>
					`${i === 0 ? "M" : "L"}${xOf(i).toFixed(1)},${(PAD.t + sy(v)).toFixed(1)}`,
			)
			.join(" ");

	const areaOf = (vals: number[], sy: (v: number) => number) => {
		const d = pathOf(vals, sy);
		const l = vals.length - 1;
		return (
			d +
			` L${xOf(l).toFixed(1)},${(PAD.t + cH).toFixed(1)} L${xOf(0).toFixed(1)},${(PAD.t + cH).toFixed(1)} Z`
		);
	};

	const handleMouseMove = useCallback(
		(e: React.MouseEvent<SVGSVGElement>) => {
			const rect = e.currentTarget.getBoundingClientRect();
			const mx = ((e.clientX - rect.left) / rect.width) * W - PAD.l;
			const step = cW / (n - 1 || 1);
			setHoverIdx(Math.max(0, Math.min(n - 1, Math.round(mx / step))));
		},
		[n, cW, W],
	);

	const maxRuns = Math.max(...data.runs) * 1.15;
	const gridTicks = 4;

	const kpis = [
		{
			key: "runs",
			label: "WORKFLOW RUNS",
			value: totalRuns,
			format: (v: number) => Math.round(v).toLocaleString(),
			delta: "+12%",
			pos: true,
			spark: data.runs,
			color: C.violet,
		},
		{
			key: "saved",
			label: "HOURS SAVED",
			value: totalSaved,
			format: (v: number) => Math.round(v).toLocaleString(),
			delta: "+9%",
			pos: true,
			spark: data.saved,
			color: C.green,
		},
		{
			key: "active",
			label: "ACTIVE WORKFLOWS",
			value: activeWfs,
			format: (v: number) => String(Math.round(v)),
			delta: "+2",
			pos: true,
			spark: WORKFLOWS.map((_, i) => i + 1),
			color: C.cyan,
		},
		{
			key: "err",
			label: "ERROR RATE",
			value: errRate,
			format: (v: number) => `${v.toFixed(2)}%`,
			delta: "-0.4%",
			pos: false,
			spark: data.errors,
			color: C.rose,
		},
	];

	const topWfs = [...WORKFLOWS]
		.filter((w) => w.status === "active")
		.sort((a, b) => b.success - a.success)
		.slice(0, 5);

	return (
		<div
			ref={overviewRef}
			style={{
				padding: "14px 14px 0",
				display: "flex",
				flexDirection: "column",
				gap: 10,
				height: "100%",
			}}
		>
			{/* KPI row */}
			<div
				style={{
					display: "grid",
					gridTemplateColumns: "repeat(4,1fr)",
					gap: 7,
				}}
			>
				{kpis.map((k) => (
					<div
						key={k.key}
						onClick={() => setActiveKpi(k.key)}
						style={{
							background: C.kpiCard,
							borderRadius: 13,
							padding: "9px 11px",
							cursor: "pointer",
							border: `1px solid ${activeKpi === k.key ? C.violet : C.border}`,
							position: "relative",
							overflow: "hidden",
						}}
					>
						<div
							style={{
								...MONO,
								fontSize: 9,
								color: C.muted,
								letterSpacing: "0.06em",
								marginBottom: 3,
							}}
						>
							{k.label}
						</div>
						<div
							style={{
								fontSize: 21,
								fontWeight: 700,
								color: C.heading,
								lineHeight: 1,
								...MONO,
								fontVariantNumeric: "tabular-nums",
							}}
						>
							<AnimatedNumber
								active={metricsInView}
								value={k.value}
								format={k.format}
							/>
						</div>
						<div
							style={{
								display: "flex",
								alignItems: "flex-end",
								justifyContent: "space-between",
								marginTop: 4,
							}}
						>
							<span
								style={{
									fontSize: 10,
									color:
										k.key === "err"
											? k.pos
												? C.rose
												: C.green
											: k.pos
												? C.green
												: C.rose,
									...MONO,
								}}
							>
								{k.delta}
							</span>
							<Sparkline data={k.spark} color={k.color} w={54} h={18} />
						</div>
					</div>
				))}
			</div>

			{/* Chart + sidebar */}
			<div
				style={{
					display: "grid",
					gridTemplateColumns: "1fr 210px",
					gap: 8,
					flex: 1,
					minHeight: 0,
				}}
			>
				{/* Chart */}
				<div
					style={{
						background: C.panel,
						borderRadius: 13,
						border: `1px solid ${C.border}`,
						padding: "10px 12px",
						display: "flex",
						flexDirection: "column",
						gap: 6,
					}}
				>
					<div
						style={{
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
							flexWrap: "wrap",
							gap: 4,
						}}
					>
						<span style={{ fontSize: 12, fontWeight: 600, color: C.heading }}>
							Activity
						</span>
						<div
							style={{
								display: "flex",
								gap: 4,
								alignItems: "center",
								flexWrap: "wrap",
							}}
						>
							{/* Legend toggles */}
							{(
								[
									{ k: "runs", label: "Runs", c: C.violet },
									{ k: "saved", label: "Saved", c: C.green },
									{ k: "errors", label: "Errors", c: C.rose },
								] as const
							).map((l) => (
								<button
									key={l.k}
									onClick={() =>
										setVisible((v) => ({
											...v,
											[l.k]: !v[l.k as keyof typeof v],
										}))
									}
									style={{
										display: "flex",
										alignItems: "center",
										gap: 4,
										padding: "2px 7px",
										borderRadius: 6,
										border: `1px solid ${C.border}`,
										cursor: "pointer",
										...MONO,
										fontSize: 10,
										background: visible[l.k as keyof typeof visible]
											? "rgba(168,132,252,0.08)"
											: "transparent",
										color: visible[l.k as keyof typeof visible] ? l.c : C.muted,
									}}
								>
									<span
										style={{
											width: 7,
											height: 7,
											borderRadius: "50%",
											background: visible[l.k as keyof typeof visible]
												? l.c
												: C.muted,
											display: "inline-block",
										}}
									/>
									{l.label}
								</button>
							))}
							{/* Period switcher */}
							<div
								style={{
									display: "flex",
									gap: 2,
									marginLeft: 6,
									background: C.panelLight,
									borderRadius: 7,
									padding: 2,
								}}
							>
								{(["7d", "14d", "30d"] as const).map((p) => (
									<SegmentBtn
										key={p}
										label={p}
										active={period === p}
										onClick={() => setPeriod(p)}
									/>
								))}
							</div>
						</div>
					</div>

					{/* SVG chart */}
					<div style={{ position: "relative", flex: 1, minHeight: 0 }}>
						<svg
							ref={svgRef}
							width="100%"
							height="100%"
							viewBox={`0 0 ${W} ${H}`}
							onMouseMove={handleMouseMove}
							onMouseLeave={() => setHoverIdx(null)}
						>
							<defs>
								<linearGradient id="ovGradRuns" x1="0" y1="0" x2="0" y2="1">
									<stop offset="0%" stopColor="#a855f7" stopOpacity="0.28" />
									<stop offset="100%" stopColor="#a855f7" stopOpacity="0" />
								</linearGradient>
								<linearGradient id="ovGradSaved" x1="0" y1="0" x2="0" y2="1">
									<stop offset="0%" stopColor="#34d399" stopOpacity="0.18" />
									<stop offset="100%" stopColor="#34d399" stopOpacity="0" />
								</linearGradient>
							</defs>
							{/* Grid */}
							{Array.from({ length: gridTicks + 1 }, (_, i) => {
								const y = PAD.t + (i / gridTicks) * cH;
								const val = Math.round(maxRuns * (1 - i / gridTicks));
								return (
									<g key={i}>
										<line
											x1={PAD.l}
											y1={y}
											x2={W - PAD.r}
											y2={y}
											stroke="rgba(168,132,252,0.08)"
											strokeDasharray="4 4"
										/>
										{val > 0 && (
											<text
												x={PAD.l - 4}
												y={y + 3}
												textAnchor="end"
												fill={C.muted}
												style={{ ...MONO, fontSize: 8 }}
											>
												{val}
											</text>
										)}
									</g>
								);
							})}
							{/* X labels */}
							{labels.map((lb, i) => {
								const step = Math.max(1, Math.ceil(labels.length / 7));
								if (i % step !== 0 && i !== labels.length - 1) return null;
								return (
									<text
										key={i}
										x={xOf(i)}
										y={H - 6}
										textAnchor="middle"
										fill={C.muted}
										style={{ ...MONO, fontSize: 8 }}
									>
										{lb}
									</text>
								);
							})}
							{/* Areas */}
							{visible.runs && (
								<path d={areaOf(data.runs, syR)} fill="url(#ovGradRuns)" />
							)}
							{visible.saved && (
								<path d={areaOf(data.saved, syS)} fill="url(#ovGradSaved)" />
							)}
							{/* Lines */}
							{visible.runs && (
								<path
									d={pathOf(data.runs, syR)}
									fill="none"
									stroke={C.violet}
									strokeWidth="1.8"
									strokeLinecap="round"
									strokeLinejoin="round"
								/>
							)}
							{visible.saved && (
								<path
									d={pathOf(data.saved, syS)}
									fill="none"
									stroke={C.green}
									strokeWidth="1.4"
									strokeLinecap="round"
									strokeLinejoin="round"
								/>
							)}
							{/* Hover */}
							{hoverIdx !== null && (
								<g>
									<line
										x1={xOf(hoverIdx)}
										y1={PAD.t}
										x2={xOf(hoverIdx)}
										y2={PAD.t + cH}
										stroke="rgba(168,85,247,0.35)"
										strokeDasharray="4 3"
										strokeWidth="1"
									/>
									{visible.runs && (
										<circle
											cx={xOf(hoverIdx)}
											cy={PAD.t + syR(data.runs[hoverIdx])}
											r="4"
											fill={C.violet}
											stroke={C.bg}
											strokeWidth="2"
										/>
									)}
									{visible.saved && (
										<circle
											cx={xOf(hoverIdx)}
											cy={PAD.t + syS(data.saved[hoverIdx])}
											r="3.5"
											fill={C.green}
											stroke={C.bg}
											strokeWidth="2"
										/>
									)}
								</g>
							)}
						</svg>
						{/* Tooltip */}
						{hoverIdx !== null && (
							<div
								style={{
									position: "absolute",
									top: 6,
									left: `${Math.min(80, (hoverIdx / (n - 1 || 1)) * 100)}%`,
									transform: "translateX(-50%)",
									background: C.panelLight,
									border: `1px solid ${C.borderStrong}`,
									borderRadius: 8,
									padding: "5px 10px",
									pointerEvents: "none",
									zIndex: 10,
								}}
							>
								<div
									style={{
										...MONO,
										fontSize: 9,
										color: C.muted,
										marginBottom: 2,
									}}
								>
									{labels[hoverIdx]}
								</div>
								{visible.runs && (
									<div style={{ ...MONO, fontSize: 11, color: C.violet }}>
										Runs: {data.runs[hoverIdx]}
									</div>
								)}
								{visible.saved && (
									<div style={{ ...MONO, fontSize: 11, color: C.green }}>
										Saved: {data.saved[hoverIdx]}h
									</div>
								)}
								{visible.errors && (
									<div style={{ ...MONO, fontSize: 11, color: C.rose }}>
										Errors: {data.errors[hoverIdx]}
									</div>
								)}
							</div>
						)}
					</div>
				</div>

				{/* Suggestions */}
				<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
					{!insightDismissed ? (
						<div
							style={{
								background: "rgba(251,191,36,0.06)",
								border: "1px solid rgba(251,191,36,0.2)",
								borderRadius: 13,
								padding: "10px 12px",
							}}
						>
							<div
								style={{
									display: "flex",
									alignItems: "center",
									gap: 5,
									marginBottom: 5,
								}}
							>
								<span
									style={{
										width: 7,
										height: 7,
										borderRadius: "50%",
										background: C.amber,
										display: "inline-block",
										boxShadow: `0 0 0 3px rgba(251,191,36,0.2)`,
									}}
								/>
								<span style={{ fontSize: 11, fontWeight: 600, color: C.amber }}>
									Insight
								</span>
							</div>
							<div
								style={{
									fontSize: 10,
									color: C.body,
									marginBottom: 7,
									lineHeight: 1.5,
								}}
							>
								Invoice OCR latency spiked 2.9× on Jun 7. Consider adding a
								retry cap.
							</div>
							<button
								onClick={() => setInsightOpen((o) => !o)}
								style={{
									fontSize: 10,
									color: C.amber,
									background: "rgba(251,191,36,0.1)",
									border: "1px solid rgba(251,191,36,0.2)",
									borderRadius: 6,
									padding: "3px 8px",
									cursor: "pointer",
									marginRight: 6,
									...MONO,
								}}
							>
								Review plan
							</button>
							<button
								onClick={() => setInsightDismissed(true)}
								style={{
									fontSize: 10,
									color: C.muted,
									background: "transparent",
									border: "none",
									cursor: "pointer",
									...MONO,
								}}
							>
								Dismiss
							</button>
							{insightOpen && (
								<div
									style={{
										marginTop: 8,
										borderTop: "1px solid rgba(251,191,36,0.15)",
										paddingTop: 8,
									}}
								>
									{[
										"1. Open workflow: Invoice OCR",
										"2. Set max retry=2, timeout=4s",
										"3. Add latency alert > 3s",
									].map((s, i) => (
										<div
											key={i}
											style={{
												fontSize: 10,
												...MONO,
												color: C.secondary,
												marginBottom: 3,
											}}
										>
											{s}
										</div>
									))}
								</div>
							)}
						</div>
					) : (
						<div
							style={{
								background: C.panel,
								border: `1px solid ${C.border}`,
								borderRadius: 13,
								padding: "10px 12px",
							}}
						>
							<div
								style={{ fontSize: 11, color: C.muted, textAlign: "center" }}
							>
								No new insights
							</div>
						</div>
					)}

					<div
						style={{
							background: C.panel,
							border: `1px solid ${C.border}`,
							borderRadius: 13,
							padding: "10px 12px",
							flex: 1,
							overflowY: "auto",
						}}
					>
						<div
							style={{
								fontSize: 11,
								fontWeight: 600,
								color: C.heading,
								marginBottom: 8,
							}}
						>
							Top by reliability
						</div>
						{topWfs.map((w) => (
							<div key={w.id} style={{ marginBottom: 8 }}>
								<div
									style={{
										display: "flex",
										justifyContent: "space-between",
										marginBottom: 3,
									}}
								>
									<span
										style={{
											fontSize: 10,
											color: C.body,
											whiteSpace: "nowrap",
											overflow: "hidden",
											textOverflow: "ellipsis",
											maxWidth: "64%",
										}}
									>
										{w.name}
									</span>
									<span style={{ ...MONO, fontSize: 10, color: C.green }}>
										{w.success}%
									</span>
								</div>
								<div
									style={{
										height: 3,
										background: "rgba(168,132,252,0.1)",
										borderRadius: 2,
										overflow: "hidden",
									}}
								>
									<div
										style={{
											height: "100%",
											width: `${w.success}%`,
											background: `linear-gradient(90deg,${C.green},${C.cyan})`,
											borderRadius: 2,
										}}
									/>
								</div>
							</div>
						))}
					</div>
				</div>
			</div>
		</div>
	);
}

// ─── VIEW: Workflows ──────────────────────────────────────────────────────────

function ViewWorkflows() {
	const [sort, setSort] = useState<{
		key: keyof Workflow;
		dir: "asc" | "desc";
	}>({ key: "runs", dir: "desc" });
	const [filter, setFilter] = useState<"all" | "active" | "paused" | "draft">(
		"all",
	);

	const rows = useMemo(() => {
		const base =
			filter === "all"
				? WORKFLOWS
				: WORKFLOWS.filter((w) => w.status === filter);
		return [...base].sort((a, b) => {
			const av = a[sort.key],
				bv = b[sort.key];
			const cmp =
				typeof av === "number" && typeof bv === "number"
					? av - bv
					: String(av).localeCompare(String(bv));
			return sort.dir === "asc" ? cmp : -cmp;
		});
	}, [sort, filter]);

	const toggleSort = (key: keyof Workflow) => {
		setSort((s) => ({
			key,
			dir: s.key === key && s.dir === "desc" ? "asc" : "desc",
		}));
	};

	const sdot = (s: string) =>
		({ active: C.green, paused: C.amber, draft: C.muted })[s] ?? C.muted;
	const cols: Array<{ key: keyof Workflow; label: string }> = [
		{ key: "name", label: "Workflow" },
		{ key: "status", label: "Status" },
		{ key: "runs", label: "Runs (30d)" },
		{ key: "success", label: "Success %" },
		{ key: "avg", label: "Avg latency" },
		{ key: "owner", label: "Owner" },
		{ key: "tag", label: "Tag" },
	];

	return (
		<div
			style={{
				padding: "14px 14px",
				height: "100%",
				display: "flex",
				flexDirection: "column",
				gap: 10,
			}}
		>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
				}}
			>
				<span style={{ fontSize: 13, fontWeight: 600, color: C.heading }}>
					Workflows
				</span>
				<div style={{ display: "flex", gap: 6, alignItems: "center" }}>
					<div
						style={{
							display: "flex",
							background: C.panelLight,
							borderRadius: 7,
							padding: 2,
							gap: 2,
						}}
					>
						{(["all", "active", "paused", "draft"] as const).map((f) => (
							<SegmentBtn
								key={f}
								label={f}
								active={filter === f}
								onClick={() => setFilter(f)}
							/>
						))}
					</div>
					<button
						style={{
							padding: "4px 10px",
							borderRadius: 7,
							border: `1px solid ${C.violet}`,
							background: "rgba(168,85,247,0.12)",
							color: C.violetSoft,
							fontSize: 11,
							cursor: "pointer",
						}}
					>
						+ New workflow
					</button>
				</div>
			</div>
			<div style={{ flex: 1, overflowY: "auto" }}>
				<table style={{ width: "100%", borderCollapse: "collapse" }}>
					<thead>
						<tr>
							{cols.map(({ key, label }) => (
								<th
									key={key}
									onClick={() => toggleSort(key)}
									style={{
										padding: "5px 7px",
										textAlign: "left",
										cursor: "pointer",
										...MONO,
										fontSize: 9,
										color: sort.key === key ? C.violetSoft : C.muted,
										letterSpacing: "0.05em",
										borderBottom: `1px solid ${C.border}`,
										whiteSpace: "nowrap",
									}}
								>
									{label}
									{sort.key === key ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{rows.map((w, ri) => (
							<tr
								key={w.id}
								style={{
									background:
										ri % 2 === 0 ? "transparent" : "rgba(168,132,252,0.02)",
								}}
							>
								<td
									style={{
										padding: "6px 7px",
										fontSize: 11,
										color: C.body,
										borderBottom: `1px solid ${C.border}`,
									}}
								>
									{w.name}
								</td>
								<td
									style={{
										padding: "6px 7px",
										borderBottom: `1px solid ${C.border}`,
									}}
								>
									<span
										style={{ display: "flex", alignItems: "center", gap: 5 }}
									>
										<span
											style={{
												width: 6,
												height: 6,
												borderRadius: "50%",
												background: sdot(w.status),
												display: "inline-block",
											}}
										/>
										<span style={{ ...MONO, fontSize: 10, color: C.secondary }}>
											{w.status}
										</span>
									</span>
								</td>
								<td
									style={{
										padding: "6px 7px",
										...MONO,
										fontSize: 11,
										color: C.body,
										borderBottom: `1px solid ${C.border}`,
									}}
								>
									{w.runs.toLocaleString()}
								</td>
								<td
									style={{
										padding: "6px 7px",
										...MONO,
										fontSize: 11,
										borderBottom: `1px solid ${C.border}`,
										color:
											w.success >= 99
												? C.green
												: w.success >= 95
													? C.amber
													: C.rose,
									}}
								>
									{w.success ? `${w.success}%` : "—"}
								</td>
								<td
									style={{
										padding: "6px 7px",
										...MONO,
										fontSize: 11,
										color: C.secondary,
										borderBottom: `1px solid ${C.border}`,
									}}
								>
									{w.avg}
								</td>
								<td
									style={{
										padding: "6px 7px",
										fontSize: 11,
										color: C.secondary,
										borderBottom: `1px solid ${C.border}`,
									}}
								>
									{w.owner}
								</td>
								<td
									style={{
										padding: "6px 7px",
										borderBottom: `1px solid ${C.border}`,
									}}
								>
									{w.tag && (
										<span
											style={{
												background: "rgba(168,85,247,0.15)",
												color: C.violetSoft,
												borderRadius: 5,
												padding: "1px 7px",
												...MONO,
												fontSize: 9,
											}}
										>
											{w.tag}
										</span>
									)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}

// ─── VIEW: Automations ────────────────────────────────────────────────────────

function ViewAutomations() {
	return (
		<div style={{ padding: "14px", height: "100%", overflowY: "auto" }}>
			<div
				style={{
					fontSize: 13,
					fontWeight: 600,
					color: C.heading,
					marginBottom: 12,
				}}
			>
				Automations
			</div>
			<div
				style={{
					display: "grid",
					gridTemplateColumns: "repeat(2,1fr)",
					gap: 10,
				}}
			>
				{AUTOMATIONS.map((a) => (
					<div
						key={a.id}
						style={{
							background: C.panel,
							border: `1px solid ${C.border}`,
							borderRadius: 13,
							padding: "12px 14px",
						}}
					>
						<div
							style={{
								display: "flex",
								alignItems: "center",
								gap: 6,
								marginBottom: 8,
							}}
						>
							<span style={{ color: C.violet }}>
								<IcoBolt />
							</span>
							<span style={{ fontSize: 12, fontWeight: 600, color: C.heading }}>
								{a.name}
							</span>
						</div>
						<div
							style={{
								display: "flex",
								flexWrap: "wrap",
								gap: 4,
								marginBottom: 10,
							}}
						>
							{a.tools.map((t, i) => (
								<span
									key={t}
									style={{ display: "flex", alignItems: "center", gap: 3 }}
								>
									<span
										style={{
											background: "rgba(168,132,252,0.12)",
											color: C.secondary,
											borderRadius: 5,
											padding: "2px 7px",
											...MONO,
											fontSize: 10,
										}}
									>
										{t}
									</span>
									{i < a.tools.length - 1 && (
										<span style={{ color: C.muted, fontSize: 10, ...MONO }}>
											→
										</span>
									)}
								</span>
							))}
						</div>
						<div
							style={{
								display: "flex",
								gap: 16,
								borderTop: `1px solid ${C.border}`,
								paddingTop: 8,
							}}
						>
							<span style={{ ...MONO, fontSize: 10, color: C.muted }}>
								Runs: <span style={{ color: C.body }}>{a.runs}</span>
							</span>
							<span style={{ ...MONO, fontSize: 10, color: C.muted }}>
								Saved: <span style={{ color: C.green }}>{a.saved}</span>
							</span>
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

// ─── VIEW: Knowledge ──────────────────────────────────────────────────────────

function ViewKnowledge() {
	const [selected, setSelected] = useState("d1");
	const folders = [...new Set(KB_DOCS.map((d) => d.folder))];
	const doc = KB_DOCS.find((d) => d.id === selected)!;

	return (
		<div
			style={{
				padding: "14px",
				height: "100%",
				display: "flex",
				gap: 12,
				overflow: "hidden",
			}}
		>
			{/* Tree */}
			<div style={{ width: 158, flexShrink: 0, overflowY: "auto" }}>
				{folders.map((f) => (
					<div key={f} style={{ marginBottom: 10 }}>
						<div
							style={{
								...MONO,
								fontSize: 9,
								color: C.muted,
								letterSpacing: "0.08em",
								marginBottom: 4,
								textTransform: "uppercase",
							}}
						>
							{f}
						</div>
						{KB_DOCS.filter((d) => d.folder === f).map((d) => (
							<div
								key={d.id}
								onClick={() => setSelected(d.id)}
								style={{
									display: "flex",
									alignItems: "center",
									gap: 5,
									padding: "5px 6px",
									borderRadius: 7,
									cursor: "pointer",
									background:
										selected === d.id ? "rgba(168,85,247,0.15)" : "transparent",
									border:
										selected === d.id
											? `1px solid rgba(168,85,247,0.25)`
											: "1px solid transparent",
									marginBottom: 2,
								}}
							>
								<span
									style={{
										color: selected === d.id ? C.violet : C.muted,
										flexShrink: 0,
									}}
								>
									<IcoBook />
								</span>
								<span
									style={{
										fontSize: 10,
										color: selected === d.id ? C.body : C.secondary,
										lineHeight: 1.35,
									}}
								>
									{d.name}
								</span>
							</div>
						))}
					</div>
				))}
			</div>
			{/* Reader */}
			<div
				style={{
					flex: 1,
					background: C.panel,
					border: `1px solid ${C.border}`,
					borderRadius: 13,
					padding: "14px 16px",
					overflowY: "auto",
				}}
			>
				<h4
					style={{
						fontSize: 13,
						fontWeight: 700,
						color: C.heading,
						marginBottom: 4,
						marginTop: 0,
					}}
				>
					{doc.name}
				</h4>
				<div style={{ ...MONO, fontSize: 9, color: C.muted, marginBottom: 12 }}>
					{doc.folder} · Updated {doc.updated}
				</div>
				<p style={{ fontSize: 12, color: C.body, lineHeight: 1.75, margin: 0 }}>
					{renderBody(doc.body)}
				</p>
			</div>
		</div>
	);
}

// ─── VIEW: Integrations ───────────────────────────────────────────────────────

function ViewIntegrations() {
	const [tab, setTab] = useState<"all" | "connected" | "available">("all");
	const shown =
		tab === "all" ? INTEGRATIONS : INTEGRATIONS.filter((i) => i.status === tab);

	return (
		<div
			style={{
				padding: "14px",
				height: "100%",
				display: "flex",
				flexDirection: "column",
				gap: 10,
			}}
		>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
				}}
			>
				<span style={{ fontSize: 13, fontWeight: 600, color: C.heading }}>
					Integrations
				</span>
				<div
					style={{
						display: "flex",
						background: C.panelLight,
						borderRadius: 7,
						padding: 2,
						gap: 2,
					}}
				>
					{(["all", "connected", "available"] as const).map((t) => (
						<SegmentBtn
							key={t}
							label={t}
							active={tab === t}
							onClick={() => setTab(t)}
						/>
					))}
				</div>
			</div>
			<div
				style={{
					display: "grid",
					gridTemplateColumns: "repeat(4,1fr)",
					gap: 8,
					overflowY: "auto",
				}}
			>
				{shown.map((i) => (
					<div
						key={i.name}
						style={{
							background: C.panel,
							border: `1px solid ${C.border}`,
							borderRadius: 13,
							padding: "12px",
							display: "flex",
							flexDirection: "column",
							gap: 8,
							transition:
								"transform 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease",
						}}
					>
						<div
							style={{
								width: 36,
								height: 36,
								borderRadius: 9,
								background: "rgba(255,255,255,0.92)",
								display: "flex",
								alignItems: "center",
								justifyContent: "center",
								flexShrink: 0,
								border: "1px solid rgba(255,255,255,0.1)",
								boxShadow: `0 8px 18px -12px ${i.color}`,
							}}
						>
							<img
								src={i.logo}
								alt={`${i.name} logo`}
								width={22}
								height={22}
								style={{
									width: 22,
									height: 22,
									objectFit: "contain",
									display: "block",
								}}
								onError={(e) => {
									const t = e.target as HTMLImageElement;
									t.style.display = "none";
									const fallback = t.nextElementSibling as HTMLElement | null;
									if (fallback) fallback.style.display = "block";
								}}
							/>
							<span
								style={{
									display: "none",
									fontSize: 12,
									fontWeight: 700,
									color: i.color,
								}}
							>
								{i.letter}
							</span>
						</div>
						<div>
							<div style={{ fontSize: 12, fontWeight: 600, color: C.heading }}>
								{i.name}
							</div>
							<div style={{ ...MONO, fontSize: 9, color: C.muted }}>
								{i.cat}
							</div>
						</div>
						<span
							style={{
								alignSelf: "flex-start",
								background:
									i.status === "connected"
										? "rgba(52,211,153,0.12)"
										: "rgba(168,132,252,0.1)",
								color: i.status === "connected" ? C.green : C.muted,
								borderRadius: 5,
								padding: "2px 7px",
								...MONO,
								fontSize: 9,
							}}
						>
							{i.status}
						</span>
					</div>
				))}
			</div>
		</div>
	);
}

// ─── VIEW: Observability ──────────────────────────────────────────────────────

function ViewObservability() {
	const p50 = [
		0.8, 0.9, 0.85, 1.1, 0.9, 0.95, 1.0, 1.2, 0.88, 0.92, 0.95, 1.05, 0.9, 0.85,
	];
	const p95 = [
		3.2, 3.8, 3.5, 4.1, 3.7, 4.0, 3.9, 5.7, 4.1, 3.8, 3.6, 4.2, 3.9, 3.7,
	];
	const sr = [
		99.2, 98.8, 99.1, 97.8, 99.0, 98.5, 99.3, 94.1, 99.2, 99.4, 99.1, 98.9,
		99.5, 99.2,
	];
	const metrics = [
		{
			label: "P50 Latency",
			value: "0.9s",
			delta: "-4%",
			deltaPos: true,
			color: C.cyan,
			spark: p50,
		},
		{
			label: "P95 Latency",
			value: "3.9s",
			delta: "+8%",
			deltaPos: false,
			color: C.amber,
			spark: p95,
		},
		{
			label: "Success Rate",
			value: "98.9%",
			delta: "-0.1%",
			deltaPos: false,
			color: C.green,
			spark: sr,
		},
	];
	const sc = (s: string) =>
		({ ok: C.green, warn: C.amber, err: C.rose })[s] ?? C.muted;

	return (
		<div
			style={{
				padding: "14px",
				height: "100%",
				display: "flex",
				flexDirection: "column",
				gap: 10,
			}}
		>
			<div style={{ fontSize: 13, fontWeight: 600, color: C.heading }}>
				Observability
			</div>
			<div
				style={{
					display: "grid",
					gridTemplateColumns: "repeat(3,1fr)",
					gap: 8,
				}}
			>
				{metrics.map((m) => (
					<div
						key={m.label}
						style={{
							background: C.panel,
							border: `1px solid ${C.border}`,
							borderRadius: 13,
							padding: "12px 14px",
							display: "flex",
							justifyContent: "space-between",
							alignItems: "center",
						}}
					>
						<div>
							<div
								style={{
									...MONO,
									fontSize: 9,
									color: C.muted,
									marginBottom: 4,
								}}
							>
								{m.label}
							</div>
							<div
								style={{
									fontSize: 20,
									fontWeight: 700,
									color: C.heading,
									...MONO,
								}}
							>
								{m.value}
							</div>
							<div
								style={{
									...MONO,
									fontSize: 10,
									color: m.deltaPos ? C.green : C.rose,
									marginTop: 2,
								}}
							>
								{m.delta}
							</div>
						</div>
						<Sparkline data={m.spark} color={m.color} w={96} h={36} />
					</div>
				))}
			</div>
			<div
				style={{
					flex: 1,
					background: C.panel,
					border: `1px solid ${C.border}`,
					borderRadius: 13,
					padding: "12px 14px",
					overflowY: "auto",
				}}
			>
				<div
					style={{
						...MONO,
						fontSize: 9,
						color: C.muted,
						marginBottom: 8,
						letterSpacing: "0.06em",
						textTransform: "uppercase",
					}}
				>
					Live run log
				</div>
				{RUN_LOG.map((r, i) => (
					<div
						key={i}
						style={{
							display: "flex",
							alignItems: "center",
							gap: 10,
							padding: "5px 0",
							borderBottom: `1px solid ${C.border}`,
						}}
					>
						<span
							style={{
								...MONO,
								fontSize: 10,
								color: C.muted,
								width: 62,
								flexShrink: 0,
							}}
						>
							{r.t}
						</span>
						<span
							style={{
								fontSize: 11,
								color: C.body,
								flex: 1,
								minWidth: 0,
								overflow: "hidden",
								textOverflow: "ellipsis",
								whiteSpace: "nowrap",
							}}
						>
							{r.wf}
						</span>
						<span
							style={{
								width: 8,
								height: 8,
								borderRadius: "50%",
								background: sc(r.status),
								display: "inline-block",
								flexShrink: 0,
							}}
						/>
						<span
							style={{
								...MONO,
								fontSize: 10,
								color: sc(r.status),
								width: 34,
								textAlign: "right",
								flexShrink: 0,
							}}
						>
							{r.lat}
						</span>
					</div>
				))}
			</div>
		</div>
	);
}

// ─── VIEW: Settings ───────────────────────────────────────────────────────────

function ViewSettings() {
	const [s, setS] = useState({
		notifyEmail: true,
		notifySlack: true,
		notifyDigest: false,
		pii: false,
		retain90: true,
		audit: true,
	});
	const tog = (k: keyof typeof s) => setS((p) => ({ ...p, [k]: !p[k] }));

	type SettingKey = keyof typeof s;
	const notifRows: Array<[SettingKey, string, string]> = [
		["notifyEmail", "Email alerts", "Receive critical alerts via email"],
		["notifySlack", "Slack alerts", "Post run failures to #alerts channel"],
		["notifyDigest", "Daily digest", "Morning summary of workflow activity"],
	];
	const privRows: Array<[SettingKey, string, string]> = [
		["pii", "PII passthrough", "Allow PII fields in workflow data"],
		["retain90", "90-day log retention", "Keep run logs for 90 days"],
		["audit", "Audit trail", "Log all config changes with attribution"],
	];

	function Panel({
		title,
		rows,
	}: {
		title: string;
		rows: Array<[SettingKey, string, string]>;
	}) {
		return (
			<div
				style={{
					background: C.panel,
					border: `1px solid ${C.border}`,
					borderRadius: 13,
					padding: "14px 16px",
					flex: 1,
				}}
			>
				<div
					style={{
						fontSize: 12,
						fontWeight: 600,
						color: C.heading,
						marginBottom: 12,
					}}
				>
					{title}
				</div>
				{rows.map(([k, label, sub]) => (
					<div
						key={k}
						style={{
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
							padding: "8px 0",
							borderBottom: `1px solid ${C.border}`,
						}}
					>
						<div>
							<div style={{ fontSize: 11, color: C.body, marginBottom: 2 }}>
								{label}
							</div>
							<div style={{ fontSize: 10, color: C.muted }}>{sub}</div>
						</div>
						<Toggle on={s[k]} onToggle={() => tog(k)} />
					</div>
				))}
			</div>
		);
	}

	return (
		<div
			style={{
				padding: "14px",
				height: "100%",
				display: "flex",
				flexDirection: "column",
				gap: 10,
			}}
		>
			<div style={{ fontSize: 13, fontWeight: 600, color: C.heading }}>
				Settings
			</div>
			<div style={{ display: "flex", gap: 10, flex: 1 }}>
				<Panel title="Notifications" rows={notifRows} />
				<Panel title="Privacy & Retention" rows={privRows} />
			</div>
		</div>
	);
}

// ─── Dashboard shell ──────────────────────────────────────────────────────────

function Dashboard() {
	const [active, setActive] = useState<NavId>("overview");
	const [hovered, setHovered] = useState<NavId | null>(null);

	const viewSubtitle: Record<NavId, string> = {
		overview: "Your workspace at a glance",
		workflows: "Manage and monitor all workflows",
		automations: "Pre-built automation recipes",
		knowledge: "Team knowledge base",
		integrations: "Connected tools and services",
		observability: "Real-time performance metrics",
		settings: "Workspace configuration",
	};

	const views: Record<NavId, React.ReactNode> = {
		overview: <ViewOverview />,
		workflows: <ViewWorkflows />,
		automations: <ViewAutomations />,
		knowledge: <ViewKnowledge />,
		integrations: <ViewIntegrations />,
		observability: <ViewObservability />,
		settings: <ViewSettings />,
	};

	return (
		<div
			style={{
				display: "flex",
				height: "100%",
				background: C.bg,
				overflow: "hidden",
			}}
		>
			{/* Sidebar */}
			<div
				style={{
					width: 220,
					flexShrink: 0,
					background: C.panel,
					borderRight: `1px solid ${C.border}`,
					display: "flex",
					flexDirection: "column",
					height: "100%",
				}}
			>
				{/* Brand */}
				<div
					style={{
						display: "flex",
						alignItems: "center",
						gap: 9,
						padding: "13px 13px 10px",
					}}
				>
					<img
						src="/images/tedi-astronaut-waving.png"
						width={38}
						height={38}
						alt="Tedi"
						style={{ borderRadius: 9, flexShrink: 0, objectFit: "cover" }}
						onError={(e) => {
							const t = e.target as HTMLImageElement;
							t.style.display = "none";
							const p = t.parentElement;
							if (p) {
								const fb = document.createElement("div");
								Object.assign(fb.style, {
									width: "38px",
									height: "38px",
									borderRadius: "9px",
									background: "linear-gradient(135deg,#a855f7,#6d28d9)",
									display: "flex",
									alignItems: "center",
									justifyContent: "center",
									fontSize: "18px",
									color: "#fff",
									flexShrink: "0",
								});
								fb.textContent = "T";
								p.insertBefore(fb, t);
							}
						}}
					/>
					<div>
						<div
							style={{
								fontFamily: "Inter, sans-serif",
								fontWeight: 600,
								fontSize: 16,
								color: C.heading,
							}}
						>
							tedix
						</div>
						<div style={{ ...MONO, fontSize: 10, color: C.muted }}>
							os.tedix.dev
						</div>
					</div>
				</div>
				{/* Nav items */}
				<div
					style={{
						flex: 1,
						padding: "4px 8px",
						display: "flex",
						flexDirection: "column",
						gap: 2,
						overflowY: "auto",
					}}
				>
					{NAV_ITEMS.map((n) => {
						const isActive = active === n.id;
						const isHovered = hovered === n.id;
						const isLit = isActive || isHovered;
						return (
							<div
								key={n.id}
								aria-pressed={isActive}
								role="button"
								tabIndex={0}
								onClick={() => setActive(n.id)}
								onKeyDown={(event) => {
									if (event.key === "Enter" || event.key === " ") {
										event.preventDefault();
										setActive(n.id);
									}
								}}
								onMouseEnter={() => setHovered(n.id)}
								onMouseLeave={() => setHovered(null)}
								style={{
									display: "flex",
									alignItems: "center",
									gap: 8,
									padding: "7px 10px",
									borderRadius: 9,
									fontSize: 12,
									cursor: "pointer",
									transition:
										"transform 0.18s ease, background 0.18s ease, border-color 0.18s ease, color 0.18s ease, box-shadow 0.18s ease",
									background: isActive
										? "linear-gradient(135deg,rgba(168,85,247,0.22),rgba(109,40,217,0.14))"
										: isHovered
											? "linear-gradient(135deg,rgba(168,132,252,0.12),rgba(168,85,247,0.07))"
											: "transparent",
									color: isLit ? C.violetSoft : C.secondary,
									borderLeft: isLit
										? `2px solid ${isActive ? C.violet : C.violetSoft}`
										: "2px solid transparent",
									boxShadow:
										isHovered && !isActive
											? "0 8px 18px -14px rgba(192,132,252,0.9), inset 0 0 0 1px rgba(192,132,252,0.12)"
											: "none",
									transform:
										isHovered && !isActive
											? "translateX(3px)"
											: "translateX(0)",
								}}
							>
								<span
									style={{
										display: "flex",
										alignItems: "center",
										color: isLit ? C.violetSoft : C.secondary,
										transition: "color 0.18s ease",
									}}
								>
									{n.icon}
								</span>
								<span style={{ flex: 1 }}>{n.label}</span>
								{n.id === "workflows" && (
									<span
										style={{
											background: C.green,
											color: "#0b1a10",
											borderRadius: 10,
											padding: "1px 6px",
											...MONO,
											fontSize: 9,
											fontWeight: 700,
										}}
									>
										8
									</span>
								)}
								<span
									aria-hidden="true"
									style={{
										color: C.violetSoft,
										fontSize: 15,
										lineHeight: 1,
										opacity: isHovered && !isActive ? 0.9 : 0,
										transform:
											isHovered && !isActive
												? "translateX(0)"
												: "translateX(-4px)",
										transition: "opacity 0.18s ease, transform 0.18s ease",
										width: 8,
									}}
								>
									›
								</span>
							</div>
						);
					})}
				</div>
				{/* Footer */}
				<div
					style={{
						padding: "10px 13px",
						borderTop: `1px solid ${C.border}`,
						display: "flex",
						alignItems: "center",
						gap: 8,
					}}
				>
					<div
						style={{
							width: 28,
							height: 28,
							borderRadius: "50%",
							background: `linear-gradient(135deg,${C.violet},${C.violetDeep})`,
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							fontSize: 10,
							fontWeight: 700,
							color: "#fff",
							flexShrink: 0,
						}}
					>
						MK
					</div>
					<div>
						<div style={{ fontSize: 11, color: C.body, fontWeight: 500 }}>
							Marina K.
						</div>
						<div style={{ ...MONO, fontSize: 9, color: C.muted }}>
							team · pro
						</div>
					</div>
				</div>
			</div>

			{/* Main */}
			<div
				style={{
					flex: 1,
					display: "flex",
					flexDirection: "column",
					overflow: "hidden",
				}}
			>
				{/* Topbar */}
				<div
					style={{
						height: 44,
						borderBottom: `1px solid ${C.border}`,
						display: "flex",
						alignItems: "center",
						padding: "0 16px",
						gap: 10,
						flexShrink: 0,
					}}
				>
					<div style={{ flex: 1 }}>
						<div style={{ fontSize: 13, fontWeight: 600, color: C.heading }}>
							{NAV_ITEMS.find((n) => n.id === active)?.label}
						</div>
						<div style={{ ...MONO, fontSize: 9, color: C.muted }}>
							{viewSubtitle[active]}
						</div>
					</div>
					{/* Search */}
					<div
						style={{
							display: "flex",
							alignItems: "center",
							gap: 6,
							background: C.panelLight,
							borderRadius: 8,
							padding: "5px 10px",
							border: `1px solid ${C.border}`,
							width: 156,
						}}
					>
						<svg
							width="11"
							height="11"
							viewBox="0 0 24 24"
							fill="none"
							stroke={C.muted}
							strokeWidth="2"
						>
							<circle cx="11" cy="11" r="8" />
							<line x1="21" y1="21" x2="16.65" y2="16.65" />
						</svg>
						<span style={{ ...MONO, fontSize: 10, color: C.muted }}>
							Search...
						</span>
					</div>
					{/* Bell */}
					<div style={{ position: "relative", cursor: "pointer" }}>
						<svg
							width="16"
							height="16"
							viewBox="0 0 24 24"
							fill="none"
							stroke={C.secondary}
							strokeWidth="2"
						>
							<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
							<path d="M13.73 21a2 2 0 0 1-3.46 0" />
						</svg>
						<span
							style={{
								position: "absolute",
								top: -3,
								right: -3,
								width: 8,
								height: 8,
								borderRadius: "50%",
								background: C.violet,
								border: `1px solid ${C.bg}`,
							}}
						/>
					</div>
					{/* Plus */}
					<div
						style={{
							width: 24,
							height: 24,
							borderRadius: 7,
							background: "rgba(168,85,247,0.15)",
							border: `1px solid ${C.borderStrong}`,
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							cursor: "pointer",
							color: C.violet,
							fontSize: 16,
							lineHeight: 1,
							flexShrink: 0,
						}}
					>
						+
					</div>
				</div>
				{/* View area */}
				<div style={{ flex: 1, overflow: "hidden" }}>
					<div style={{ height: "100%", overflowY: "auto" }}>
						{views[active]}
					</div>
				</div>
			</div>
		</div>
	);
}

// ─── Copy section ─────────────────────────────────────────────────────────────

const BULLETS = [
	"Persistent memory across tools and teams",
	"End-to-end workflow automation",
	"Explainable actions and audit trails",
	"Scoped access and approvals",
	"Connected tools and workflows",
];

// ─── Main export ──────────────────────────────────────────────────────────────

export function TediDashboardShowcase() {
	return (
		<div className="mt-20 w-full">
			<p className="mb-3 text-center text-sm text-slate-400">
				Interactive mockup — sample data
			</p>
			{/* Dashboard mockup */}
			<div
				style={{
					borderRadius: 18,
					overflow: "hidden",
					boxShadow: SHELL_SHADOW,
					border: `1px solid ${C.borderStrong}`,
				}}
			>
				{/* Browser chrome */}
				<div
					className="bg-[#08071a]"
					style={{
						height: 40,
						display: "flex",
						alignItems: "center",
						padding: "0 14px",
						gap: 10,
						borderBottom: `1px solid ${C.border}`,
						flexShrink: 0,
					}}
				>
					<div style={{ display: "flex", gap: 6 }}>
						<span
							style={{
								width: 11,
								height: 11,
								borderRadius: "50%",
								background: "#ff5f57",
								display: "inline-block",
							}}
						/>
						<span
							style={{
								width: 11,
								height: 11,
								borderRadius: "50%",
								background: "#ffbd2e",
								display: "inline-block",
							}}
						/>
						<span
							style={{
								width: 11,
								height: 11,
								borderRadius: "50%",
								background: "#28ca42",
								display: "inline-block",
							}}
						/>
					</div>
					<div style={{ flex: 1, display: "flex", justifyContent: "center" }}>
						<div
							style={{
								display: "flex",
								alignItems: "center",
								gap: 6,
								background: "rgba(255,255,255,0.05)",
								border: `1px solid ${C.border}`,
								borderRadius: 7,
								padding: "4px 14px",
								minWidth: 220,
							}}
						>
							<svg
								width="10"
								height="10"
								viewBox="0 0 24 24"
								fill="none"
								stroke={C.green}
								strokeWidth="2.5"
							>
								<rect x="3" y="11" width="18" height="11" rx="2" />
								<path d="M7 11V7a5 5 0 0 1 10 0v4" />
							</svg>
							<span style={{ ...MONO, fontSize: 10, color: C.muted }}>
								os.tedix.dev
							</span>
						</div>
					</div>
					<div style={{ width: 60 }} />
				</div>
				{/* Shell — fixed height */}
				<div className="h-[540px]" style={{ overflow: "hidden" }}>
					<Dashboard />
				</div>
			</div>

			{/* Copy section */}
			<div className="mx-auto mt-20 max-w-3xl text-center">
				<h2 className="mb-2 font-bold font-display text-4xl leading-tight tracking-tight text-foreground md:text-5xl">
					Autonomous operations.
				</h2>
				<h2
					className="mb-10 font-bold font-display text-4xl leading-tight tracking-tight md:text-5xl"
					style={{
						background: "linear-gradient(135deg,#a855f7,#6d28d9)",
						WebkitBackgroundClip: "text",
						WebkitTextFillColor: "transparent",
					}}
				>
					Real results.
				</h2>

				<ul className="mb-10 space-y-3 inline-block text-left">
					{BULLETS.map((b, i) => (
						<li
							key={i}
							className="flex items-center gap-3 text-violet-950 dark:text-violet-100"
							style={{ fontSize: 15, fontWeight: 500 }}
						>
							<span
								style={{
									width: 22,
									height: 22,
									borderRadius: "50%",
									flexShrink: 0,
									display: "flex",
									alignItems: "center",
									justifyContent: "center",
									background: "linear-gradient(135deg,#a855f7,#6d28d9)",
								}}
							>
								<svg
									width="11"
									height="11"
									viewBox="0 0 24 24"
									fill="none"
									stroke="#fff"
									strokeWidth="3"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<polyline points="20 6 9 17 4 12" />
								</svg>
							</span>
							{b}
						</li>
					))}
				</ul>

				<div className="flex justify-center">
					<a
						href="#cta"
						style={{
							display: "inline-flex",
							alignItems: "center",
							gap: 8,
							background: "linear-gradient(135deg,#a855f7,#6d28d9)",
							color: "#fff",
							borderRadius: 12,
							padding: "13px 32px",
							fontSize: 15,
							fontWeight: 600,
							textDecoration: "none",
							boxShadow: "0 4px 24px rgba(168,85,247,0.35)",
							transition: "opacity 0.2s, transform 0.2s",
						}}
						onMouseEnter={(e) => {
							Object.assign((e.currentTarget as HTMLAnchorElement).style, {
								opacity: "0.88",
								transform: "translateY(-1px)",
							});
						}}
						onMouseLeave={(e) => {
							Object.assign((e.currentTarget as HTMLAnchorElement).style, {
								opacity: "1",
								transform: "translateY(0)",
							});
						}}
					>
						Request your Tedi
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2.5"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<line x1="5" y1="12" x2="19" y2="12" />
							<polyline points="12 5 19 12 12 19" />
						</svg>
					</a>
				</div>
			</div>

			<style>{`
        @keyframes pulse {
          0%,100%{box-shadow:0 0 0 3px rgba(251,191,36,0.2);}
          50%{box-shadow:0 0 0 6px rgba(251,191,36,0.08);}
        }
      `}</style>
		</div>
	);
}
