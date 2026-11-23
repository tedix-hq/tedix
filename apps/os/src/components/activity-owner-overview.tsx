import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DeckCard } from "@tedix/api-contract/schemas/attention";
import { ActivityAreaUpdateSchema } from "@tedix/api-contract/schemas/os-activity-feed";
import { isCriticalDeckCard } from "@tedix/api-contract/utils/deck-curator";
import { plainFeedText } from "@tedix/api-contract/utils/activity-feed";
import { osQuery, workAttentionQueryOptions } from "@/lib/os-query-options";
import { workRefreshOptions } from "@/lib/work-refresh";
import { useCardSchedule } from "@/lib/use-card-schedule";
import { absoluteTime } from "@/lib/time";
import {
	attentionSource,
	attentionStatus,
	attentionTimestamp,
	ATTENTION_SOURCES,
} from "@/lib/attention";
import { DecidedForYou } from "./decided-for-you";
import { WorkInteractionDecisionCard } from "./work-interaction-decision-card";
import { WorkApprovalDecisionCard } from "./work-approval-decision-card";
import { ApprovalDecisionCard } from "./work-decision-stack";
import { WorkReadFailure } from "./work-surface-primitives";
import { Button } from "./kumo/button";
import { Link } from "./kumo/link";

export function ownerQuestion(card: DeckCard) {
	return (
		!card.handled &&
		!card.expired &&
		(isCriticalDeckCard(card) ||
			card.decision?.reversibility === "one_way" ||
			card.decision?.reversibility === "unknown" ||
			card.decision?.tasteOrStrategy === true)
	);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section
			aria-label={title}
			className="grid min-w-0 gap-3 border-b border-kumo-line py-4"
		>
			<h2 className="text-lg font-semibold">{title}</h2>
			{children}
		</section>
	);
}

/** Uses canonical projections; a session ending is never evidence of a deployment. */
export function ActivityOwnerOverview({
	projectIds,
}: {
	projectIds?: string[];
}) {
	const [shown, setShown] = useState(3);
	const [answering, setAnswering] = useState<string>();
	const { now } = useCardSchedule();
	const portfolio = useQuery({
		...osQuery.projects.getPortfolio.queryOptions({ input: {} }),
		...workRefreshOptions,
	});
	const attention = useQuery({
		...workAttentionQueryOptions(),
		...workRefreshOptions,
	});
	// The decisions read is slow enough to push reads beside it past the
	// request timeout, so it starts once the areas read has settled; it does
	// not wait for running work, whose retries would hold back owner questions.
	const deck = useQuery({
		...osQuery.attention.listDeckCards.queryOptions({
			input: { limit: 100, presentation: "stored" },
		}),
		...workRefreshOptions,
		enabled: !portfolio.isPending,
	});
	const questions = (deck.data?.cards ?? []).filter(ownerQuestion);
	const projects = (portfolio.data?.data ?? []).filter(
		({ project }) =>
			project.status !== "archived" &&
			(!projectIds || projectIds.includes(project.id)),
	);
	const cards = attention.data?.cards ?? [];
	const areas = projects.map((row) => ({
		...row,
		cards: cards.filter((card) => card.projectId === row.project.id),
		report: ActivityAreaUpdateSchema.safeParse(
			row.project.metadata?.activityOverview,
		).data,
	}));
	const releases = areas.flatMap((area) =>
		(area.report?.releases ?? []).map((release) => ({
			...release,
			area: area.project.name,
		})),
	);
	const today = new Date(
		now.getFullYear(),
		now.getMonth(),
		now.getDate(),
	).getTime();
	const running = cards.filter(
		(card) =>
			card.column === "moving" &&
			(!projectIds || (card.projectId && projectIds.includes(card.projectId))),
	);
	const groups = [...new Set(running.map((card) => card.projectId))];
	return (
		<div className="min-w-0 break-words" aria-label="Owner overview">
			<Section title="Needs you">
				<p className="text-kumo-subtle">
					Hard to undo, money, outside people, publication, or a choice of
					direction.
				</p>
				{deck.isError && (
					<WorkReadFailure
						title="Owner questions unavailable"
						error={deck.error}
						onRetry={() => deck.refetch()}
					/>
				)}
				{deck.isPending ? (
					<p>Checking questions…</p>
				) : (
					!deck.isError &&
					!questions.length && (
						<p>No owner questions in the loaded decisions.</p>
					)
				)}
				{!deck.isError &&
					questions.slice(0, shown).map((card) => (
						<div
							key={card.id}
							className="grid min-w-0 gap-2 border-t border-kumo-line pt-3"
						>
							<p className="font-semibold">
								{card.presentation?.title ?? card.label}
							</p>
							<p>
								{card.presentation?.recommendation ??
									card.decision?.recommendation ??
									"No recommendation recorded."}
							</p>
							<Button
								variant="outline"
								size="sm"
								className="justify-self-start"
								aria-expanded={answering === card.id}
								onClick={() =>
									setAnswering(answering === card.id ? undefined : card.id)
								}
							>
								{answering === card.id ? "Close answer" : "Answer"}
							</Button>
							{answering !== card.id ? null : !deck.data?.complete ? (
								<Link href="/work?view=deck">{card.label}</Link>
							) : card.interaction ? (
								<WorkInteractionDecisionCard
									requestId={card.interaction.request.id}
									preview={card.interaction}
									onNext={() => void deck.refetch()}
								/>
							) : card.workApproval ? (
								<WorkApprovalDecisionCard
									row={card.workApproval}
									onNext={() => void deck.refetch()}
								/>
							) : card.runtimeApproval ? (
								<ApprovalDecisionCard
									id={card.runtimeApproval.id}
									onNext={() => void deck.refetch()}
								/>
							) : (
								<Link href="/work?view=deck">{card.label}</Link>
							)}
						</div>
					))}
				{questions.length > shown && (
					<Button variant="ghost" onClick={() => setShown(shown + 3)}>
						More owner questions
					</Button>
				)}
				{deck.data && !deck.data.complete && (
					<p role="status">
						Some decision sources could not be read. The list is incomplete.
					</p>
				)}
				<Link href="/work?view=deck">All requests and decisions</Link>
			</Section>
			<DecidedForYou />
			<Section title="By area">
				{portfolio.isError && (
					<WorkReadFailure
						title="Areas unavailable"
						error={portfolio.error}
						onRetry={() => portfolio.refetch()}
					/>
				)}
				{attention.isError && (
					<WorkReadFailure
						title="Area activity unavailable"
						error={attention.error}
						onRetry={() => attention.refetch()}
					/>
				)}
				{portfolio.isPending && <p>Checking areas…</p>}
				<ul className="grid gap-3">
					{areas.map((area) => {
						const latest = area.cards
							.filter(
								(card) =>
									card.column === "done" &&
									attentionTimestamp(
										card.finishedAt ?? card.heartbeatAt ?? "",
									) >= today,
							)
							.sort(
								(a, b) =>
									attentionTimestamp(b.finishedAt ?? b.heartbeatAt ?? "") -
									attentionTimestamp(a.finishedAt ?? a.heartbeatAt ?? ""),
							)[0];
						const reportToday =
							area.report && Date.parse(area.report.observedAt) >= today;
						return (
							<li key={area.project.id} className="min-w-0">
								<Link
									variant="record"
									href={`/work/projects/${area.project.id}`}
								>
									{area.project.name}
								</Link>
								{" · "}
								{area.health?.replaceAll("_", " ") ?? area.project.status}
								{" · Today: "}
								{reportToday
									? area.report!.changed
									: latest
										? plainFeedText(latest.note || latest.title)
										: attention.isPending || attention.isError
											? "unknown"
											: "no result reported"}
								{" · Next: "}
								{reportToday ? (
									area.report!.next
								) : area.next ? (
									<Link href={`/work/items/${area.next.id}`}>
										{plainFeedText(area.next.title)}
									</Link>
								) : (
									"not recorded"
								)}
							</li>
						);
					})}
				</ul>
			</Section>
			<Section title="Running by area">
				{attention.isPending && <p>Checking running work…</p>}
				{attention.isError ? (
					<p>Current running work is unknown.</p>
				) : (
					!attention.isPending &&
					!running.length && <p>No running work reported.</p>
				)}
				{groups.map((id) => (
					<div key={id ?? "unfiled"} className="grid min-w-0 gap-2">
						<h3 className="font-semibold">
							{portfolio.data?.data.find((row) => row.project.id === id)
								?.project.name ??
								attention.data?.projects.find((project) => project.id === id)
									?.name ??
								"No area assigned"}
						</h3>
						<ul className="grid gap-2">
							{running
								.filter((card) => card.projectId === id)
								.map((card) => (
									<li key={card.id}>
										<Link href={card.href}>{plainFeedText(card.title)}</Link>
										{" · "}
										{ATTENTION_SOURCES[attentionSource(card)].label}
										{" · "}
										{attentionStatus(card, now.getTime())}
									</li>
								))}
						</ul>
					</div>
				))}
			</Section>
			<Section title="Live and held">
				<p className="text-kumo-subtle">
					Dated reports from each area’s lead. A finished task alone does not
					prove it is live.
				</p>
				{portfolio.isError ? (
					<p>Release reports are unavailable.</p>
				) : portfolio.isPending ? (
					<p>Checking release reports…</p>
				) : (
					!releases.length && (
						<p>
							No live or held release report recorded. Deployment state is
							unknown.
						</p>
					)
				)}
				<ul className="grid gap-2">
					{releases.map((release, index) => (
						<li key={`${release.area}:${index}`}>
							<strong>{release.state === "live" ? "Live" : "Held"}</strong>
							{" · "}
							{release.area}
							{" · "}
							<Link href={release.href}>{release.label}</Link>
							{" · "}
							{release.detail}
							{" · "}
							<time dateTime={release.at}>{absoluteTime(release.at)}</time>
						</li>
					))}
				</ul>
			</Section>
		</div>
	);
}
