import { useQueries, useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Badge } from "@/components/kumo/badge";
import { Link } from "@/components/kumo/link";
import { MetricGrid, MetricItem } from "@/components/kumo/metric-grid";
import {
	Collection,
	Page,
	PageDescription,
	PageHeader,
	PageHeading,
	PageSection,
	PageTitle,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import { Skeleton } from "@/components/kumo/skeleton";
import { Text } from "@/components/kumo/text";
import {
	decisionCaptureSummary,
	interactionSubject,
} from "@/components/work-operations-pages";
import { latestDraftOf } from "@/components/work-interaction-draft";
import {
	notebookLessonsQueryOptions,
	replyDraftAcceptanceQueryOptions,
	tediRosterQueryOptions,
	userProfileQueryOptions,
	workInteractionDetailQueryOptions,
	workOfficeKnocksQueryOptions,
	workUrgentInteractionsQueryOptions,
} from "@/lib/os-query-options";
import { absoluteTime, normalizeD1Timestamp, relativeTime } from "@/lib/time";
import { useDocumentTitle } from "@/lib/use-document-title";
import { cn } from "@/lib/utils";

/** Knocks whose answer is looked up (one detail read each). */
const KNOCKS_SHOWN = 12;

/** Local midnight today, as an ISO instant. */
export function startOfToday(now = new Date()): string {
	const day = new Date(now);
	day.setHours(0, 0, 0, 0);
	return day.toISOString();
}

function isToday(iso: string | null | undefined, since: string) {
	if (!iso) return false;
	const at = Date.parse(normalizeD1Timestamp(iso));
	return !Number.isNaN(at) && at >= Date.parse(since);
}

/** "Oct 7" (or "today") for a plain-English line. */
function day(iso: string, since: string) {
	if (isToday(iso, since)) return "today";
	return new Date(normalizeD1Timestamp(iso)).toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
	});
}

type Lane = "answered" | "you";

/** Where a knock went, in plain words. */
export function knockOutcome(input: {
	urgent: boolean;
	open: boolean;
	answeredByYou: boolean;
	draft: { delivery?: string | null; drafter: string } | null;
}): { lane: Lane; text: string } {
	if (input.urgent)
		return {
			lane: "you",
			text: input.open
				? "Important, brought to you"
				: "Important, you answered",
		};
	if (input.draft?.delivery === "auto")
		return { lane: "answered", text: `Answered by ${input.draft.drafter}` };
	if (input.answeredByYou) return { lane: "you", text: "You answered" };
	if (input.draft)
		return {
			lane: "you",
			text: `${input.draft.drafter} wrote a reply for you to check`,
		};
	return {
		lane: "you",
		text: input.open ? "Waiting for you" : "Closed",
	};
}

export function OfficeSummarySentence({
	knocks,
	answered,
	waiting,
	corrected,
}: {
	knocks: number;
	answered: number;
	waiting: number;
	corrected: number;
}) {
	if (knocks === 0) return <>Quiet so far: nobody has knocked today.</>;
	return (
		<>
			{knocks} {knocks === 1 ? "knock" : "knocks"} today. Your chief of staff
			answered {answered} for you, {waiting} {waiting === 1 ? "is" : "are"}{" "}
			waiting for you, and you corrected {corrected}.
		</>
	);
}

function TodayCard({ since }: { since: string }) {
	const knocks = useQuery(workOfficeKnocksQueryOptions());
	const urgent = useQuery(workUrgentInteractionsQueryOptions());
	const acceptance = useQuery(replyDraftAcceptanceQueryOptions(since));
	const rows = (knocks.data?.data ?? []).filter(
		(row) =>
			decisionCaptureSummary(row.request.metadata) &&
			isToday(row.request.requestedAt, since),
	);
	const more = Boolean(knocks.data?.hasMore && rows.length === 100);
	const totals = (acceptance.data?.byTurnType ?? []).reduce(
		(sum, row) => ({
			answered: sum.answered + row.autoSent,
			corrected: sum.corrected + row.edited + row.replaced + row.overridden,
		}),
		{ answered: 0, corrected: 0 },
	);
	const waiting = urgent.data?.data.length ?? 0;
	if (knocks.isPending)
		return <Skeleton className="h-32 w-full" aria-label="Loading today" />;
	return (
		<PageSection aria-labelledby="office-today-title">
			<SectionHeader>
				<SectionHeading>
					<SectionTitle id="office-today-title">Today</SectionTitle>
					<SectionDescription>
						<OfficeSummarySentence
							knocks={rows.length}
							answered={totals.answered}
							waiting={waiting}
							corrected={totals.corrected}
						/>
					</SectionDescription>
				</SectionHeading>
			</SectionHeader>
			<MetricGrid columns={4} appearance="bounded" aria-label="Today">
				<MetricItem
					label="Knocks today"
					emphasis="metric"
					value={`${rows.length}${more ? "+" : ""}`}
					description="Sessions that finished a turn"
				/>
				<MetricItem
					label="Answered for you"
					emphasis="metric"
					value={totals.answered}
					description="Routine replies sent the way you would"
				/>
				<MetricItem
					label="Waiting for you"
					emphasis="metric"
					value={<Link href="/work/interactions">{waiting}</Link>}
					description="Only the important ones"
				/>
				<MetricItem
					label="You corrected"
					emphasis="metric"
					value={totals.corrected}
					description="Each one teaches the notebook"
				/>
			</MetricGrid>
		</PageSection>
	);
}

function KnockList({ since }: { since: string }) {
	const knocks = useQuery(workOfficeKnocksQueryOptions());
	const tedis = useQuery({ ...tediRosterQueryOptions(100), retry: false });
	const rows = (knocks.data?.data ?? [])
		.filter(
			(row) =>
				decisionCaptureSummary(row.request.metadata) &&
				isToday(row.request.requestedAt, since),
		)
		.slice(0, KNOCKS_SHOWN);
	const details = useQueries({
		queries: rows.map((row) => ({
			...workInteractionDetailQueryOptions(row.request.id),
			staleTime: 30_000,
		})),
	});
	// Knocks present on first paint are not "new"; later arrivals slide in.
	const seen = useRef<Set<string> | null>(null);
	const firstPaint = seen.current === null;
	useEffect(() => {
		if (!knocks.data) return;
		seen.current ??= new Set();
		for (const row of rows) seen.current.add(row.request.id);
	});
	const names = new Map(
		(tedis.data?.data ?? []).map((tedi) => [
			tedi.id,
			tedi.displayName || tedi.name,
		]),
	);
	if (rows.length === 0) return null;
	const items = rows.map((row, index) => {
		const summary = decisionCaptureSummary(row.request.metadata);
		const draft = latestDraftOf(details[index]?.data);
		const outcome = knockOutcome({
			urgent: summary?.urgency === "now",
			open: row.effectiveState === "open",
			answeredByYou: row.responseCount > 0 && draft?.delivery !== "auto",
			draft: draft
				? {
						delivery: draft.delivery,
						drafter: names.get(draft.drafterId) ?? "your chief of staff",
					}
				: null,
		});
		return { row, summary, outcome };
	});
	const lanes: Array<[Lane, string, string]> = [
		[
			"answered",
			"Answered for you",
			"Routine knocks your chief of staff and department heads took care of.",
		],
		["you", "For you", "Important knocks, and replies waiting for your OK."],
	];
	return (
		<PageSection aria-labelledby="office-knocks-title">
			<SectionHeader>
				<SectionHeading>
					<SectionTitle id="office-knocks-title">Latest knocks</SectionTitle>
				</SectionHeading>
			</SectionHeader>
			<div className="grid gap-4 md:grid-cols-2">
				{lanes.map(([lane, title, description]) => {
					const laneItems = items.filter((item) => item.outcome.lane === lane);
					return (
						<div key={lane} className="grid min-w-0 content-start gap-2">
							<div>
								<Text as="h3" role="label" tone="strong">
									{title} ({laneItems.length})
								</Text>
								<Text as="p" role="label" tone="secondary">
									{description}
								</Text>
							</div>
							{laneItems.length ? (
								<Collection aria-label={title}>
									{laneItems.map(({ row, summary, outcome }) => (
										<li
											key={row.request.id}
											className={cn(
												"grid gap-0.5 px-3 py-2",
												!firstPaint &&
													!seen.current?.has(row.request.id) &&
													"office-knock-arrive",
											)}
										>
											<Link
												variant="record"
												href={`/work/interactions/${row.request.id}`}
												title={summary?.sessionId}
												className="truncate"
											>
												{interactionSubject(row.request)}
											</Link>
											<Text as="p" role="label" tone="secondary">
												{outcome.text} ·{" "}
												<time
													dateTime={row.request.requestedAt}
													title={absoluteTime(row.request.requestedAt)}
												>
													{relativeTime(row.request.requestedAt)}
												</time>
											</Text>
										</li>
									))}
								</Collection>
							) : (
								<Text as="p" role="body" tone="secondary">
									None yet today.
								</Text>
							)}
						</div>
					);
				})}
			</div>
		</PageSection>
	);
}

/** "learned from: your reply on Oct 7" for a lesson that cites decisions. */
export function learnedFromLine(
	learnedFrom: {
		replies: number;
		lastReplyAt: string | null;
		fromCaller: boolean;
	} | null,
	since: string,
): string | null {
	if (!learnedFrom) return null;
	const whose = learnedFrom.fromCaller ? "your" : "a teammate's";
	const date = learnedFrom.lastReplyAt
		? day(learnedFrom.lastReplyAt, since)
		: null;
	const when = date ? (date === "today" ? " today" : ` on ${date}`) : "";
	if (learnedFrom.replies <= 1) return `Learned from ${whose} reply${when}`;
	const many = learnedFrom.fromCaller ? "your" : "your team's";
	return `Learned from ${learnedFrom.replies} of ${many} replies, the latest${when}`;
}

function Notebook({ since }: { since: string }) {
	const lessons = useQuery(notebookLessonsQueryOptions());
	const profile = useQuery({ ...userProfileQueryOptions(), retry: false });
	const firstName = profile.data?.name?.trim().split(/\s+/)[0];
	const title = firstName ? `How ${firstName} works` : "How you work";
	return (
		<PageSection aria-labelledby="office-notebook-title">
			<SectionHeader>
				<SectionHeading>
					<SectionTitle id="office-notebook-title">
						The notebook: {title}
					</SectionTitle>
					<SectionDescription>
						What the office has learned. When you correct someone, a line is
						added here, and every session reads it before it starts.
					</SectionDescription>
				</SectionHeading>
			</SectionHeader>
			{lessons.isPending ? (
				<Skeleton className="h-24 w-full" />
			) : lessons.isError ? (
				<Text as="p" role="body" tone="secondary">
					The notebook could not be read right now.
				</Text>
			) : lessons.data.lessons.length === 0 ? (
				<Text as="p" role="body" tone="secondary">
					The notebook is empty. Lines appear after you correct a session.
				</Text>
			) : (
				<Collection aria-label={title}>
					{lessons.data.lessons.map((lesson) => {
						const source = learnedFromLine(lesson.learnedFrom, since);
						const fresh = isToday(lesson.addedAt, since);
						return (
							<li
								key={lesson.id}
								title={lesson.id}
								className={cn(
									"grid gap-1 px-3 py-2.5",
									fresh && "bg-kumo-success-tint",
								)}
							>
								<Text as="p" role="body" className="line-clamp-4">
									{fresh ? (
										<Badge variant="success" className="mr-2">
											Added today
										</Badge>
									) : null}
									{lesson.text}
								</Text>
								{source ? (
									<Text as="p" role="label" tone="secondary">
										{source}
									</Text>
								) : null}
							</li>
						);
					})}
				</Collection>
			)}
		</PageSection>
	);
}

export function WorkOfficePage() {
	useDocumentTitle("Office · Work");
	const since = startOfToday();
	return (
		<Page width="xl">
			<PageHeader>
				<PageHeading>
					<PageTitle>Your office</PageTitle>
					<PageDescription>
						Your coding sessions are employees. When one finishes a turn, it
						knocks. Your chief of staff answers the routine knocks the way you
						would, department heads answer the ones in their area, and only the
						important ones reach you.
					</PageDescription>
				</PageHeading>
			</PageHeader>
			<TodayCard since={since} />
			<KnockList since={since} />
			<Notebook since={since} />
		</Page>
	);
}
