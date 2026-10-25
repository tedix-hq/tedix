import { createRoot } from "react-dom/client";
import {
	type CardRunLinkProps,
	DelegationSummaryRow,
	DelegationWorkCard,
	delegationFromRun,
} from "../src/components/chat-cards";
import { delegationLiveState } from "../src/lib/delegation-activity";
import "../src/styles.css";

// The delegation card in its three shapes against the app's real CSS: working
// with a known total and an open activity list, stalled with Stop and retry,
// and finished, folded to one summary line.
const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
document.documentElement.style.colorScheme = dark ? "dark" : "light";

const now = Date.now();
const ago = (seconds: number) => new Date(now - seconds * 1_000).toISOString();
const TEDI = "00000000-0000-4000-8000-0000000000d1";

function Link({ className, children, title }: CardRunLinkProps) {
	return (
		<a href="#details" className={className} title={title}>
			{children}
		</a>
	);
}

const tool = (id: string, name: string, start: number, end?: number) => [
	{
		id: `${id}:s`,
		kind: "tool.started",
		toolCallId: id,
		payload: { name },
		createdAt: ago(start),
	},
	...(end != null
		? [
				{
					id: `${id}:e`,
					kind: "tool.completed",
					toolCallId: id,
					payload: { name },
					createdAt: ago(end),
				},
			]
		: []),
];
const events = [
	{ id: "start", kind: "run.started", createdAt: ago(420) },
	...tool("t1", "community__search_posts", 400, 391),
	...tool("t2", "community__read_thread", 380, 352),
	...tool("t3", "notes__write_summary", 30),
];

const base = {
	organizationId: "org",
	conversationId: "home:os:fixture",
	delegatedTediId: TEDI,
	createdAt: ago(420),
	startedAt: ago(420),
};
const working = {
	...base,
	id: "run-working",
	childRunId: "child-working",
	status: "running" as const,
	updatedAt: ago(12),
	progress: {
		current: 48,
		total: 100,
		label: "Working",
		detail: "Writing the summary for this week's community threads",
	},
};
const stalled = {
	...working,
	id: "run-stalled",
	childRunId: "child-stalled",
	updatedAt: ago(7 * 60 + 20),
};
const finished = {
	...base,
	id: "run-done",
	childRunId: "child-done",
	status: "completed" as const,
	createdAt: ago(600),
	startedAt: ago(600),
	completedAt: ago(117),
	usage: {
		pricing: null,
		inputTokens: 1200,
		outputTokens: 300,
		reasoningTokens: null,
		totalTokens: 1500,
		costUsd: 0.0042,
	},
};

function Card({ run, slot }: { run: typeof working; slot: string }) {
	const work = delegationFromRun(run)!;
	return (
		<section data-fixture={slot} aria-label={slot}>
			<ul className="m-0 grid list-none gap-4 p-0">
				<DelegationWorkCard
					work={work}
					tediName="Community Operator"
					LinkComponent={Link}
					live={delegationLiveState({
						run,
						// The stalled branch has recorded nothing since its last update.
						events: slot === "stalled" ? [] : events,
						now,
					})}
					onStop={() => {}}
					onRetry={() => {}}
				/>
			</ul>
		</section>
	);
}

createRoot(document.getElementById("root")!).render(
	<main className="mx-auto grid max-w-3xl gap-8 bg-kumo-base px-4 py-6 text-kumo-default">
		<Card run={working} slot="working" />
		<Card run={stalled} slot="stalled" />
		<section data-fixture="finished" aria-label="finished">
			<ul className="m-0 grid list-none gap-4 p-0">
				<DelegationSummaryRow
					work={delegationFromRun(finished)!}
					tediName="Community Operator"
					LinkComponent={Link}
				/>
			</ul>
		</section>
	</main>,
);
