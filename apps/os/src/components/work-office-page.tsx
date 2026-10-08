import { useQueries, useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Avatar, AvatarFallback } from "@/components/kumo/avatar";
import { Badge } from "@/components/kumo/badge";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@/components/kumo/empty";
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
import { OfficeLeaderboard } from "@/components/office-leaderboard";
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
	workAgentSessionsQueryOptions,
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

/**
 * The one line a person needs: the interaction's "What's needed from you"
 * when it carries one, else its subject without the "repo · host waiting:"
 * prefix every decision-capture subject starts with.
 */
export function officeAsk(request: {
	subject: string;
	metadata?: unknown;
	neededFromYou?: unknown;
}): string {
	const meta =
		typeof request.metadata === "object" && request.metadata !== null
			? (request.metadata as Record<string, unknown>)
			: {};
	const needed = request.neededFromYou ?? meta.neededFromYou;
	if (typeof needed === "string" && needed.trim()) return needed.trim();
	const subject = interactionSubject(request);
	return subject.replace(/^[^:]{0,80}\bwaiting:\s*/i, "") || subject;
}

export const NOTEBOOK_SUBJECTS = [
	"Answers",
	"Git",
	"Deploys",
	"Work",
	"Agents",
] as const;
type NotebookSubject = (typeof NOTEBOOK_SUBJECTS)[number];

const SUBJECT_PATTERNS: Array<[NotebookSubject, RegExp]> = [
	[
		"Git",
		/\b(git|commit|push|pull request|branch|rebase|merge|worktree|stash)\b/i,
	],
	["Deploys", /\b(deploy\w*|ship|release|rollout|wrangler|production|prod)\b/i],
	["Work", /\b(work items?|board|claim|lease|ticket|issue|project|backlog)\b/i],
	["Agents", /\b(agents?|tedis?|sub-?agents?|sessions?|delegat\w*|model)\b/i],
];

/** Which notebook subject a lesson reads as; "Answers" when none matches. */
export function lessonSubject(text: string): NotebookSubject {
	return (
		SUBJECT_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? "Answers"
	);
}

/** "Learned from 3 replies" for a lesson that cites decisions. */
export function learnedFromLine(
	learnedFrom: { replies: number } | null,
): string | null {
	if (!learnedFrom || learnedFrom.replies < 1) return null;
	return `Learned from ${learnedFrom.replies} ${learnedFrom.replies === 1 ? "reply" : "replies"}`;
}

function initials(name: string) {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	return (
		parts
			.slice(0, 2)
			.map((part) => part[0]?.toUpperCase())
			.join("") || "?"
	);
}

export function OfficeSummarySentence({
	knocks,
	answered,
	waiting,
}: {
	knocks: number;
	answered: number;
	waiting: number;
}) {
	if (knocks === 0) return <>Quiet so far: nobody has knocked today.</>;
	if (waiting === 0)
		return (
			<>
				Nothing needs you. {answered} of today's {knocks} knocks were answered
				for you.
			</>
		);
	return (
		<>
			{waiting} {waiting === 1 ? "thing needs" : "things need"} you. {answered}{" "}
			of today's {knocks} knocks were answered for you.
		</>
	);
}

function useTodayKnocks(since: string) {
	const knocks = useQuery(workOfficeKnocksQueryOptions());
	const rows = (knocks.data?.data ?? []).filter(
		(row) =>
			decisionCaptureSummary(row.request.metadata) &&
			isToday(row.request.requestedAt, since),
	);
	return {
		knocks,
		rows,
		more: Boolean(knocks.data?.hasMore && rows.length === 100),
	};
}

function useTodayTotals(since: string) {
	const acceptance = useQuery(replyDraftAcceptanceQueryOptions(since));
	const urgent = useQuery(workUrgentInteractionsQueryOptions());
	const totals = (acceptance.data?.byTurnType ?? []).reduce(
		(sum, row) => ({
			answered: sum.answered + row.autoSent,
			corrected: sum.corrected + row.edited + row.replaced + row.overridden,
		}),
		{ answered: 0, corrected: 0 },
	);
	return { ...totals, waiting: urgent.data?.data.length ?? 0 };
}

function OfficeHeader({ since }: { since: string }) {
	const { knocks, rows } = useTodayKnocks(since);
	const totals = useTodayTotals(since);
	return (
		<PageHeader>
			<PageHeading>
				<PageTitle>Your office</PageTitle>
				<PageDescription className="text-kumo-default type-tedix-dialog">
					{knocks.isPending ? (
						"Reading today's knocks…"
					) : (
						<OfficeSummarySentence
							knocks={rows.length}
							answered={totals.answered}
							waiting={totals.waiting}
						/>
					)}
				</PageDescription>
			</PageHeading>
		</PageHeader>
	);
}

function TodayTiles({ since }: { since: string }) {
	const { knocks, rows, more } = useTodayKnocks(since);
	const totals = useTodayTotals(since);
	if (knocks.isPending)
		return <Skeleton className="h-24 w-full" aria-label="Loading today" />;
	return (
		<MetricGrid columns={4} appearance="bounded" aria-label="Today">
			<MetricItem
				className="py-4"
				label="Knocks today"
				emphasis="metric"
				value={`${rows.length}${more ? "+" : ""}`}
			/>
			<MetricItem
				className="py-4"
				label="Answered for you"
				emphasis="metric"
				value={totals.answered}
			/>
			<MetricItem
				className="py-4"
				label="Waiting for you"
				emphasis="metric"
				value={<Link href="/work/interactions">{totals.waiting}</Link>}
			/>
			<MetricItem
				className="py-4"
				label="You corrected"
				emphasis="metric"
				value={totals.corrected}
			/>
		</MetricGrid>
	);
}

function Time({ at }: { at: string }) {
	return (
		<time dateTime={at} title={absoluteTime(at)}>
			{relativeTime(at)}
		</time>
	);
}

function Knocks({ since }: { since: string }) {
	const { knocks, rows: today } = useTodayKnocks(since);
	const tedis = useQuery({ ...tediRosterQueryOptions(100), retry: false });
	const urgent = useQuery(workUrgentInteractionsQueryOptions());
	const rows = today.slice(0, KNOCKS_SHOWN);
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
	if (knocks.isPending) return null;
	const items = rows.map((row, index) => {
		const summary = decisionCaptureSummary(row.request.metadata);
		const draft = latestDraftOf(details[index]?.data);
		const drafter = draft
			? (names.get(draft.drafterId) ?? "Your chief of staff")
			: null;
		const open = row.effectiveState === "open";
		const outcome = knockOutcome({
			urgent: summary?.urgency === "now",
			open,
			answeredByYou: row.responseCount > 0 && draft?.delivery !== "auto",
			draft: draft && drafter ? { delivery: draft.delivery, drafter } : null,
		});
		return {
			row,
			open,
			urgent: summary?.urgency === "now",
			outcome,
			drafter,
			arriving: !firstPaint && !seen.current?.has(row.request.id),
		};
	});
	// Every open important knock reaches "For you", not only the recent ones.
	const recentForYou = items.filter(
		(item) => item.outcome.lane === "you" && item.open,
	);
	const shown = new Set(recentForYou.map((item) => item.row.request.id));
	const forYou = [
		...(urgent.data?.data ?? [])
			.filter((row) => !shown.has(row.request.id))
			.map((row) => ({
				row,
				open: true,
				urgent: true,
				outcome: { lane: "you" as Lane, text: "Important, brought to you" },
				drafter: null,
				arriving: false,
			})),
		...recentForYou,
	].sort((a, b) =>
		b.row.request.requestedAt.localeCompare(a.row.request.requestedAt),
	);
	const answered = items.filter((item) => item.outcome.lane === "answered");
	const byTedi = new Map<string, typeof answered>();
	for (const item of answered) {
		const key = item.drafter ?? "Your chief of staff";
		byTedi.set(key, [...(byTedi.get(key) ?? []), item]);
	}
	return (
		<>
			<PageSection aria-labelledby="office-for-you-title">
				<SectionHeader>
					<SectionHeading>
						<SectionTitle id="office-for-you-title">For you</SectionTitle>
					</SectionHeading>
				</SectionHeader>
				{forYou.length ? (
					<Collection aria-label="For you">
						{forYou.map(({ row, urgent, outcome, arriving }) => (
							<li
								key={row.request.id}
								className={cn(
									"grid gap-1 px-4 py-3",
									arriving && "office-knock-arrive",
								)}
							>
								<div className="flex min-w-0 items-start gap-2">
									<Link
										variant="record"
										href={`/work/interactions/${row.request.id}`}
										className="line-clamp-2 min-w-0 flex-1"
									>
										{officeAsk(row.request)}
									</Link>
									{urgent ? (
										<Badge variant="warning" className="shrink-0">
											Important
										</Badge>
									) : null}
								</div>
								<Text as="p" role="label" tone="secondary">
									{outcome.text} · <Time at={row.request.requestedAt} />
								</Text>
							</li>
						))}
					</Collection>
				) : (
					<Empty appearance="quiet">
						<EmptyHeader>
							<EmptyTitle>Nothing needs you</EmptyTitle>
							<EmptyDescription>
								Important knocks and replies waiting for your OK land here.
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
				)}
			</PageSection>
			<PageSection aria-labelledby="office-answered-title">
				<SectionHeader>
					<SectionHeading>
						<SectionTitle id="office-answered-title">
							Answered for you
						</SectionTitle>
						<SectionDescription>
							Routine knocks your tedis replied to the way you would.
						</SectionDescription>
					</SectionHeading>
				</SectionHeader>
				{byTedi.size ? (
					<div className="grid gap-3">
						{[...byTedi].map(([tedi, list]) => (
							<Card key={tedi} size="sm">
								<CardHeader className="flex items-center gap-3">
									<Avatar size="sm">
										<AvatarFallback>{initials(tedi)}</AvatarFallback>
									</Avatar>
									<CardTitle className="min-w-0 flex-1 truncate">
										{tedi}
									</CardTitle>
									<Badge variant="secondary">{list.length}</Badge>
								</CardHeader>
								<CardContent>
									<ul className="m-0 grid list-none gap-2 p-0">
										{list.map(({ row, arriving }) => (
											<li
												key={row.request.id}
												className={cn(
													"flex min-w-0 items-baseline gap-3",
													arriving && "office-knock-arrive",
												)}
											>
												<Link
													variant="record"
													href={`/work/interactions/${row.request.id}`}
													className="min-w-0 flex-1 truncate"
												>
													{officeAsk(row.request)}
												</Link>
												<Text
													as="span"
													role="label"
													tone="secondary"
													className="shrink-0"
												>
													<Time at={row.request.requestedAt} />
												</Text>
											</li>
										))}
									</ul>
								</CardContent>
							</Card>
						))}
					</div>
				) : (
					<Text as="p" role="body" tone="secondary">
						None yet today.
					</Text>
				)}
			</PageSection>
		</>
	);
}

/** Active means something happened in the last 15 minutes. */
export const ACTIVE_WINDOW_MS = 15 * 60_000;

function isActive(iso: string | null | undefined, now: number) {
	if (!iso) return false;
	const at = Date.parse(normalizeD1Timestamp(iso));
	return !Number.isNaN(at) && now - at <= ACTIVE_WINDOW_MS;
}

/** Knocks per hour over the last 24 hours, oldest first. */
export function knocksPerHour(requestedAt: string[], now: number): number[] {
	const hours = Array.from({ length: 24 }, () => 0);
	for (const iso of requestedAt) {
		const age = now - Date.parse(normalizeD1Timestamp(iso));
		if (Number.isNaN(age) || age < 0 || age >= 24 * 3_600_000) continue;
		hours[23 - Math.floor(age / 3_600_000)]! += 1;
	}
	return hours;
}

const HARNESS_LABELS = { "claude-code": "Claude Code", codex: "Codex" };

type SeenSession = { harness: string; key: string; at: string };

/**
 * Sessions seen through their captured turns. The status board stays empty
 * when the hooks report under an agent identity, but every finished turn
 * still lands as a decision-capture interaction carrying host and session.
 */
export function sessionsFromKnocks(
	rows: Array<{ request: { requestedAt: string; metadata?: unknown } }>,
): SeenSession[] {
	return rows.flatMap((row) => {
		const meta = row.request.metadata as
			| { host?: unknown; sessionId?: unknown }
			| null
			| undefined;
		return typeof meta?.host === "string" && typeof meta.sessionId === "string"
			? [
					{
						harness: meta.host,
						key: meta.sessionId,
						at: row.request.requestedAt,
					},
				]
			: [];
	});
}

/** Distinct sessions: active within 15 minutes, idle within 24 hours. */
export function sessionActivity(seen: SeenSession[], now: number) {
	const latest = new Map<string, number>();
	for (const entry of seen) {
		const at = Date.parse(normalizeD1Timestamp(entry.at));
		if (Number.isNaN(at)) continue;
		latest.set(entry.key, Math.max(latest.get(entry.key) ?? 0, at));
	}
	let active = 0;
	let idle = 0;
	for (const at of latest.values()) {
		if (now - at <= ACTIVE_WINDOW_MS) active += 1;
		else if (now - at <= 24 * 3_600_000) idle += 1;
	}
	return { active, idle };
}

function Activity() {
	const sessions = useQuery(workAgentSessionsQueryOptions());
	const tedis = useQuery({ ...tediRosterQueryOptions(100), retry: false });
	const knocks = useQuery(workOfficeKnocksQueryOptions());
	const now = Date.now();
	const seen = [
		...(sessions.data?.sessions ?? [])
			.filter((session) => session.effectiveState !== "ended")
			.map((session) => ({
				harness: session.harness,
				key: session.sessionKey,
				at:
					session.effectiveState === "working"
						? new Date(now).toISOString()
						: session.lastEventAt,
			})),
		...sessionsFromKnocks(knocks.data?.data ?? []),
	];
	const harnesses = (["claude-code", "codex"] as const).map((harness) => ({
		harness,
		...sessionActivity(
			seen.filter((entry) => entry.harness === harness),
			now,
		),
	}));
	const hours = knocksPerHour(
		(knocks.data?.data ?? []).map((row) => row.request.requestedAt),
		now,
	);
	const peak = Math.max(1, ...hours);
	const roster = tedis.data?.data ?? [];
	return (
		<Card size="sm" aria-labelledby="office-activity-title">
			<CardHeader className="flex items-center gap-2">
				<CardTitle id="office-activity-title" className="flex-1">
					Activity
				</CardTitle>
				<svg
					viewBox="0 0 96 16"
					className="h-4 w-24 text-kumo-brand"
					role="img"
					aria-label={`Knocks per hour, last 24 hours: ${hours.reduce((a, b) => a + b, 0)} in all`}
				>
					{hours.map((count, index) => {
						const height = count ? Math.max(2, (count / peak) * 16) : 1;
						return (
							<rect
								key={index}
								x={index * 4}
								y={16 - height}
								width={2.5}
								height={height}
								rx={1}
								fill="currentColor"
								opacity={count ? 1 : 0.25}
							>
								<title>
									{count} {count === 1 ? "knock" : "knocks"},{" "}
									{23 - index === 0 ? "this hour" : `${23 - index}h ago`}
								</title>
							</rect>
						);
					})}
				</svg>
			</CardHeader>
			<CardContent className="grid gap-3">
				<div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
					<Text as="span" role="label" tone="secondary" className="w-14">
						Sessions
					</Text>
					{harnesses.map(({ harness, active, idle }) => (
						<Text key={harness} as="span" role="body">
							{HARNESS_LABELS[harness]}{" "}
							<Text as="span" role="body" tone="strong" weight="semibold">
								{active}
							</Text>{" "}
							active
							<Text as="span" role="body" tone="secondary">
								{" "}
								/ {idle} idle
							</Text>
						</Text>
					))}
				</div>
				<div className="flex flex-wrap items-center gap-x-6 gap-y-2">
					<Text as="span" role="label" tone="secondary" className="w-14">
						Tedis
					</Text>
					{roster.length ? (
						<div className="flex flex-wrap gap-1.5">
							{roster.map((tedi) => {
								const name = tedi.displayName || tedi.name;
								const active = isActive(tedi.lastActivityAt, now);
								return (
									<Avatar
										key={tedi.id}
										size="sm"
										title={`${name}: ${
											tedi.lastActivityAt
												? `active ${relativeTime(tedi.lastActivityAt)}`
												: "no activity yet"
										}`}
										className={cn(
											active ? "ring-2 ring-kumo-brand" : "opacity-40",
										)}
									>
										<AvatarFallback>{initials(name)}</AvatarFallback>
									</Avatar>
								);
							})}
						</div>
					) : (
						<Text as="span" role="body" tone="secondary">
							No tedis yet.
						</Text>
					)}
				</div>
			</CardContent>
		</Card>
	);
}

function Notebook({ since }: { since: string }) {
	const lessons = useQuery(notebookLessonsQueryOptions());
	const profile = useQuery({ ...userProfileQueryOptions(), retry: false });
	const firstName = profile.data?.name?.trim().split(/\s+/)[0];
	const title = firstName ? `How ${firstName} works` : "How you work";
	const groups = NOTEBOOK_SUBJECTS.map(
		(subject) =>
			[
				subject,
				(lessons.data?.lessons ?? []).filter(
					(lesson) => lessonSubject(lesson.text) === subject,
				),
			] as const,
	).filter(([, list]) => list.length > 0);
	return (
		<PageSection aria-labelledby="office-notebook-title">
			<SectionHeader>
				<SectionHeading>
					<SectionTitle id="office-notebook-title">{title}</SectionTitle>
					<SectionDescription>
						Every session reads this notebook before it starts. Your corrections
						add to it.
					</SectionDescription>
				</SectionHeading>
			</SectionHeader>
			{lessons.isPending ? (
				<Skeleton className="h-24 w-full" />
			) : lessons.isError ? (
				<Text as="p" role="body" tone="secondary">
					The notebook could not be read right now.
				</Text>
			) : groups.length === 0 ? (
				<Empty appearance="quiet">
					<EmptyHeader>
						<EmptyTitle>The notebook is empty</EmptyTitle>
						<EmptyDescription>
							Lines appear after you correct a session.
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<div className="grid gap-3">
					{groups.map(([subject, list]) => (
						<Card key={subject} size="sm">
							<CardHeader className="flex items-center gap-2">
								<CardTitle className="flex-1">{subject}</CardTitle>
								<Text as="span" role="label" tone="secondary">
									{list.length}
								</Text>
							</CardHeader>
							<CardContent>
								<ul className="m-0 grid list-none divide-y divide-kumo-hairline p-0">
									{list.map((lesson) => {
										const source = learnedFromLine(lesson.learnedFrom);
										const fresh = isToday(lesson.addedAt, since);
										return (
											<li
												key={lesson.id}
												title={lesson.id}
												className="grid gap-1 py-2.5 first:pt-0 last:pb-0"
											>
												<Text as="p" role="body" className="line-clamp-4">
													{lesson.text}
												</Text>
												{source || fresh ? (
													<div className="flex flex-wrap items-center gap-2">
														{source ? (
															<Text as="span" role="label" tone="secondary">
																{source}
															</Text>
														) : null}
														{fresh ? (
															<Badge variant="success">New today</Badge>
														) : null}
													</div>
												) : null}
											</li>
										);
									})}
								</ul>
							</CardContent>
						</Card>
					))}
				</div>
			)}
		</PageSection>
	);
}

export function WorkOfficePage() {
	useDocumentTitle("Office · Work");
	const since = startOfToday();
	return (
		<Page width="md" className="gap-10">
			<div className="grid gap-5">
				<OfficeHeader since={since} />
				<TodayTiles since={since} />
				<Activity />
			</div>
			<Knocks since={since} />
			<OfficeLeaderboard />
			<Notebook since={since} />
		</Page>
	);
}
