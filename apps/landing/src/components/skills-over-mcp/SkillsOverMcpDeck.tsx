import {
	ArrowLeft,
	ArrowRight,
	BookOpen,
	ChevronRight,
	LockKeyhole,
	MapPin,
	PenLine,
	Sparkles,
	Workflow,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";

type Slide = {
	id: string;
	kicker: string;
	title: string;
	layout?: "cover" | "chapter" | "dark";
	render: () => ReactNode;
};

const conceptRows = [
	["Skill", "SKILL.md", "the recipe, written down"],
	["Workflow", "run_skill_workflow", "the recipe being cooked, step by step"],
	[
		"Muscle memory",
		"tedi_muscle_memory",
		"the shortcut, once it has proven itself",
	],
	[
		"Extension",
		"runtime package",
		"a new appliance in the kitchen, not a recipe",
	],
];

const proofRows = [
	['list_skills({ appSlug: "tedix" })', "what recipes are available"],
	[
		'read_resource({ uri: "skill://tedix/customer-onboarding/SKILL.md" })',
		"the recipe, loaded only when needed",
	],
	[
		'run_skill_workflow({ slug: "customer-onboarding" })',
		"the agent actually runs it",
	],
	[
		"what happened + faster next time",
		"a trail of the steps; proven ones become a shortcut",
	],
];

function clampSlideIndex(index: number, total: number) {
	return Math.min(Math.max(index, 0), total - 1);
}

function useHashSlide(total: number) {
	const [index, setIndex] = useState(0);

	useEffect(() => {
		const readHash = () => {
			const match = window.location.hash.match(/^#\/?(\d+)$/);
			if (match) {
				setIndex(clampSlideIndex(Number(match[1]) - 1, total));
			}
		};

		readHash();
		window.addEventListener("hashchange", readHash);
		return () => window.removeEventListener("hashchange", readHash);
	}, [total]);

	const setSlide = (next: number) => {
		const clamped = clampSlideIndex(next, total);
		setIndex(clamped);
		window.history.replaceState(null, "", `#${clamped + 1}`);
	};

	return [index, setSlide] as const;
}

function Chip({ children }: { children: ReactNode }) {
	return <span className="som-chip">{children}</span>;
}

function Claim({ children }: { children: ReactNode }) {
	return <p className="som-claim">{children}</p>;
}

function DistributionGap() {
	return (
		<div className="som-gap-diagram">
			<div className="som-gap-side">
				<span>github mcp today</span>
				<strong>47 tools, ~32k tokens, no playbook</strong>
				<div className="som-token-cloud">
					<code>list_issues</code>
					<code>get_pull_request</code>
					<code>create_pull_request_review</code>
					<code>get_workflow_run</code>
					<code>list_workflow_run_logs</code>
					<code>+42 more</code>
				</div>
			</div>
			<div className="som-gap-bridge">
				<ChevronRight size={34} />
				<ChevronRight size={34} />
				<ChevronRight size={34} />
			</div>
			<div className="som-gap-side som-gap-side-accent">
				<span>same server, with skills (pr #2382)</span>
				<strong>27 named recipes tell the agent what to do</strong>
				<code>
					skill://github/review-pr/SKILL.md
					<br />
					skill://github/debug-ci/SKILL.md
					<br />
					skill://github/triage-issues/SKILL.md
				</code>
			</div>
		</div>
	);
}

function ResourceReadFlow() {
	return (
		<div className="som-read-flow">
			<div>
				<span>01</span>
				<strong>discover</strong>
				<code>skills/list</code>
			</div>
			<div>
				<span>02</span>
				<strong>read</strong>
				<code>skill://.../SKILL.md</code>
			</div>
			<div>
				<span>03</span>
				<strong>unlock</strong>
				<code>relevant MCP tools</code>
			</div>
			<div>
				<span>04</span>
				<strong>run</strong>
				<code>skill workflow</code>
			</div>
		</div>
	);
}

function SkillDocument() {
	return (
		<pre className="som-document">
			{`customer-onboarding/
├── SKILL.md                  ← the recipe
├── references/
│   ├── kickoff-checklist.md  ← more detail, loaded only when needed
│   └── pricing-tiers.md
├── scripts/
│   └── provision.ts          ← optional script the agent can run
└── assets/
    └── welcome-email.html    ← templates the agent can use

# every file is its own skill:// MCP resource.
# the model reads what it needs, when it needs it.`}
		</pre>
	);
}

function ProofConsole() {
	return (
		<div className="som-console">
			<div className="som-console-chrome">
				<span />
				<span />
				<span />
				<strong>CTO tedi / MCP &mdash; recorded run</strong>
			</div>
			{proofRows.map(([call, proof], index) => (
				<div className="som-console-row" key={call}>
					<span>{String(index + 1).padStart(2, "0")}</span>
					<code>{call}</code>
					<small>{proof}</small>
				</div>
			))}
		</div>
	);
}

function PersonalizationStack() {
	const rows = [
		["public mcp client", "the baseline — the public version"],
		[
			"enterprise tenant",
			"org-customized — their playbook overlays the baseline",
		],
		[
			"authenticated user / role",
			"tightened to what this user is allowed to do",
		],
	];
	return (
		<div className="som-protocol-stack" aria-label="Personalization">
			{rows.map(([label, body], index) => (
				<div key={label} style={{ "--i": index } as React.CSSProperties}>
					<strong>{label}</strong>
					<span>{body}</span>
				</div>
			))}
		</div>
	);
}

function slidesForDeck(): Slide[] {
	return [
		{
			id: "cover",
			kicker: "Berlin · 2026",
			title: "Skills Over MCP",
			layout: "cover",
			render: () => (
				<div className="som-cover">
					<div>
						<Chip>The next layer of agent quality</Chip>
						<h1>Skills Over MCP</h1>
						<p>
							Agents have all the tools. They still need to know which one to
							pick.
						</p>
						<div className="som-speaker">
							<strong>Aaron Koivunen</strong>
							<span>CTO &amp; Co-founder — tedix.dev</span>
						</div>
					</div>
					<img
						className="som-hero-image"
						src="/images/skills-over-mcp/cover.png"
						alt="A chef in whites reaching toward a wall of recipe cards on hooks; one card glows lime green, the rest dim cyan"
					/>
				</div>
			),
		},
		{
			id: "who",
			kicker: "Who I am",
			title: "Aaron Koivunen",
			layout: "cover",
			render: () => (
				<div className="som-cover">
					<div className="som-portrait">
						<div className="som-portrait-head">
							<div className="som-avatar" aria-label="Aaron Koivunen">
								<img src="/images/aaron-profile.jpg" alt="Aaron Koivunen" />
							</div>
							<div className="som-portrait-name">
								<h1>Aaron Koivunen</h1>
								<span>CTO &amp; Co-founder, Tedix</span>
							</div>
						</div>
						<p>Building autonomous digital workers that learn on the job.</p>
						<div className="som-speaker">
							<strong>tedix.dev</strong>
							<span>aaron@tedix.dev · Berlin</span>
						</div>
					</div>
					<div className="som-protocol-stack" aria-label="About">
						<div style={{ "--i": 0 } as React.CSSProperties}>
							<strong>Tedix</strong>
							<span>autonomous digital workers</span>
						</div>
						<div style={{ "--i": 1 } as React.CSSProperties}>
							<strong>What I keep writing about</strong>
							<span>the AI demo → production gap</span>
						</div>
						<div style={{ "--i": 2 } as React.CSSProperties}>
							<strong>Where to find me</strong>
							<span>Berlin · meetups · tedix.dev</span>
						</div>
					</div>
				</div>
			),
		},
		{
			id: "thesis",
			kicker: "Thesis",
			title: "MCP gave agents the keys. Skills tell them which door matters.",
			layout: "chapter",
			render: () => (
				<div className="som-thesis">
					<div>
						<LockKeyhole size={44} />
						<span>tools say what an agent can do</span>
					</div>
					<div>
						<BookOpen size={44} />
						<span>skills say when and how to do it</span>
					</div>
					<div>
						<Workflow size={44} />
						<span>workflows leave a trail of what happened</span>
					</div>
				</div>
			),
		},
		{
			id: "distribution-gap",
			kicker: "Problem",
			title: "The useful thing is rarely the tool. It is the recipe around it.",
			render: () => <DistributionGap />,
		},
		{
			id: "resource-binding",
			kicker: "Protocol Shape · SEP-2640 · same family as the Apps extension",
			title: "Same shape as Apps: skills as MCP Resources.",
			render: () => (
				<div className="som-resource-grid">
					<ResourceReadFlow />
					<SkillDocument />
				</div>
			),
		},
		{
			id: "personalization",
			kicker: "Personalization · the server decides per caller",
			title: "Same name. Different recipe. Per caller.",
			render: () => (
				<div className="som-personalize">
					<PersonalizationStack />
					<Claim>
						Same name. Different recipe for <b>each caller</b>. Who&rsquo;s
						asking decides.
					</Claim>
				</div>
			),
		},
		{
			id: "progressive-discovery",
			kicker: "Sam Morrow · MCP doesn't have a context problem",
			title: "MCP has a solution-awareness problem.",
			render: () => {
				return (
					<div className="som-image-grid">
						<Claim>
							GitHub&rsquo;s MCP server ships <b>47 tools</b>. A skill-led path
							lets the agent look at only the ones the recipe asks for &mdash;
							about <b>84%</b> of those tools stay out of the way until
							they&rsquo;re needed.
						</Claim>
						<img
							className="som-hero-image"
							src="/images/skills-over-mcp/discovery.png"
							alt="On the left, a cook overwhelmed by a swirl of kitchen tools. On the right, the same cook calmly holding a single recipe card next to tidy shelves."
						/>
					</div>
				);
			},
		},
		{
			id: "tedix-vocabulary",
			kicker: "Vocabulary · each skill is a promise",
			title: "Four words. Four jobs. Don't conflate them.",
			render: () => (
				<div className="som-concept-matrix">
					{conceptRows.map(([label, backing, job]) => (
						<div key={label}>
							<strong>{label}</strong>
							<code>{backing}</code>
							<span>{job}</span>
						</div>
					))}
				</div>
			),
		},
		{
			id: "proof",
			kicker: "Proof",
			title: "What it looks like when an autonomous tedi runs on this layer.",
			layout: "dark",
			render: () => <ProofConsole />,
		},
		{
			id: "close",
			kicker: "Close",
			title: "Skills advise. Tools authorize. Workflows leave evidence.",
			layout: "chapter",
			render: () => (
				<div className="som-image-grid">
					<div className="som-close">
						<Claim>
							If your server has more than a handful of tools, ship the recipe
							too.
						</Claim>
						<div>
							<strong>tedix.dev/skills-over-mcp</strong>
							<span>aaron@tedix.dev</span>
						</div>
					</div>
					<img
						className="som-hero-image"
						src="/images/skills-over-mcp/close.png"
						alt="Two chefs handing off a sealed recipe across a kitchen counter with three glowing kitchen-rule emblems beneath: chef's hat, service bell, order ticket"
					/>
				</div>
			),
		},
	];
}

export default function SkillsOverMcpDeck() {
	const slides = useMemo(slidesForDeck, []);
	const [index, setIndex] = useHashSlide(slides.length);
	const current = slides[index];

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.target instanceof HTMLInputElement) {
				return;
			}
			if (
				event.key === "ArrowRight" ||
				event.key === "PageDown" ||
				event.key === " "
			) {
				event.preventDefault();
				setIndex(index + 1);
			}
			if (event.key === "ArrowLeft" || event.key === "PageUp") {
				event.preventDefault();
				setIndex(index - 1);
			}
		};

		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [index, setIndex]);

	return (
		<div className="som-deck">
			<main className="som-stage">
				<section
					className={`som-slide som-slide-${current.id} ${
						current.layout ? `som-layout-${current.layout}` : ""
					}`}
				>
					<div className="som-slide-kicker">
						<span>{current.kicker}</span>
						<span>
							{String(index + 1).padStart(2, "0")} /{" "}
							{String(slides.length).padStart(2, "0")}
						</span>
					</div>
					<div className="som-slide-body">
						{current.layout !== "cover" && <h1>{current.title}</h1>}
						{current.render()}
					</div>
				</section>
			</main>

			<footer className="som-controls" aria-label="Slide navigation">
				<button
					type="button"
					aria-label="Previous slide"
					onClick={() => setIndex(index - 1)}
				>
					<ArrowLeft size={18} />
				</button>
				<div className="som-progress">
					<div
						style={{ width: `${((index + 1) / slides.length) * 100}%` }}
						aria-hidden="true"
					/>
				</div>
				<button
					type="button"
					aria-label="Next slide"
					onClick={() => setIndex(index + 1)}
				>
					<ArrowRight size={18} />
				</button>
			</footer>
		</div>
	);
}
