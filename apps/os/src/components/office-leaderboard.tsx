import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/kumo/avatar";
import { Badge } from "@/components/kumo/badge";
import {
	PageSection,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import { SegmentedControl } from "@/components/kumo/segmented-control";
import { Skeleton } from "@/components/kumo/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/kumo/table";
import { Text } from "@/components/kumo/text";
import {
	notebookLessonsQueryOptions,
	replyDraftLeaderboardQueryOptions,
	tediOperationsSummariesQueryOptions,
	userProfileQueryOptions,
} from "@/lib/os-query-options";
import { normalizeD1Timestamp } from "@/lib/time";

type Period = "week" | "today";
const PERIODS: readonly { value: Period; label: string }[] = [
	{ value: "week", label: "This week" },
	{ value: "today", label: "Today" },
];

/** Local midnight today, as an ISO instant. */
function startOfDay(now: Date): string {
	const day = new Date(now);
	day.setHours(0, 0, 0, 0);
	return day.toISOString();
}

/** Local midnight on the Monday of this week, as an ISO instant. */
export function startOfWeek(now = new Date()): string {
	const day = new Date(now);
	day.setHours(0, 0, 0, 0);
	day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
	return day.toISOString();
}

/** "45 s", "3 min", "1.5 h"; an em dash with nothing to average. */
export function formatReplyTime(seconds: number | null): string {
	if (seconds === null) return "—";
	if (seconds < 60) return `${seconds} s`;
	if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
	return `${Math.round(seconds / 360) / 10} h`;
}

function initials(name: string): string {
	return (
		name
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((part) => part[0]?.toUpperCase())
			.join("") || "?"
	);
}

function sentenceCase(value: string): string {
	const text = value.replaceAll("_", " ");
	return text.charAt(0).toUpperCase() + text.slice(1);
}

function TediAvatar({ name, avatar }: { name: string; avatar: string | null }) {
	const isUrl = Boolean(avatar && /^https?:\/\//.test(avatar));
	return (
		<Avatar size="sm">
			{isUrl && avatar ? <AvatarImage src={avatar} alt="" /> : null}
			<AvatarFallback>
				{avatar && !isUrl ? avatar : initials(name)}
			</AvatarFallback>
		</Avatar>
	);
}

/**
 * Who answers your knocks best: each drafting tedi ranked by replies that
 * stood (auto-sent and not overridden, or accepted as written), this week or
 * today, with its Earned Delegation career stage when it has one. You appear
 * last as the coach, counting the corrections that became lessons.
 */
export function OfficeLeaderboard({ now = new Date() }: { now?: Date }) {
	const [period, setPeriod] = useState<Period>("week");
	const weekSince = startOfWeek(now);
	const todaySince = startOfDay(now);
	const board = useQuery(
		replyDraftLeaderboardQueryOptions(weekSince, todaySince),
	);
	const tediIds = (board.data?.tedis ?? []).map((row) => row.tediId);
	const summaries = useQuery({
		...tediOperationsSummariesQueryOptions(tediIds),
		enabled: tediIds.length > 0,
		retry: false,
	});
	const lessons = useQuery({ ...notebookLessonsQueryOptions(), retry: false });
	const profile = useQuery({ ...userProfileQueryOptions(), retry: false });

	const stageOf = new Map(
		(summaries.data?.data ?? []).map((row) => [
			row.tediId,
			row.delegationProfile.activeRole?.careerStage ?? null,
		]),
	);
	const since = period === "week" ? weekSince : todaySince;
	const taught = (lessons.data?.lessons ?? []).filter(
		(lesson) =>
			lesson.learnedFrom?.fromCaller &&
			lesson.addedAt &&
			Date.parse(normalizeD1Timestamp(lesson.addedAt)) >= Date.parse(since),
	).length;
	const rows = [...(board.data?.tedis ?? [])]
		.map((row) => ({ ...row, score: row[period] }))
		.filter((row) => row.score.answered > 0)
		.sort(
			(a, b) =>
				b.score.stood - a.score.stood ||
				a.score.corrected - b.score.corrected ||
				b.score.answered - a.score.answered,
		);
	const coach = profile.data?.name?.trim() || "You";

	return (
		<PageSection aria-labelledby="office-leaderboard-title">
			<SectionHeader>
				<SectionHeading>
					<SectionTitle id="office-leaderboard-title">Leaderboard</SectionTitle>
					<SectionDescription>
						Ranked by replies that stood: sent for you and not overridden, or
						accepted as written. Volume alone does not count.
					</SectionDescription>
				</SectionHeading>
				<SegmentedControl
					ariaLabel="Leaderboard period"
					value={period}
					onValueChange={setPeriod}
					options={PERIODS}
					compact
				/>
			</SectionHeader>
			{board.isPending ? (
				<Skeleton className="h-32 w-full" aria-label="Loading leaderboard" />
			) : board.isError ? (
				<Text as="p" role="body" tone="secondary">
					The leaderboard could not be read right now.
				</Text>
			) : (
				<Table scrollLabel="Leaderboard">
					<TableHeader>
						<TableRow>
							<TableHead className="w-10">#</TableHead>
							<TableHead>Tedi</TableHead>
							<TableHead className="text-right">Stood</TableHead>
							<TableHead className="text-right">Knocks answered</TableHead>
							<TableHead className="text-right">Auto-sent</TableHead>
							<TableHead className="text-right">Corrected</TableHead>
							<TableHead className="text-right">Avg reply</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.length === 0 ? (
							<TableRow>
								<TableCell colSpan={7}>
									<Text as="span" role="body" tone="secondary">
										No drafted replies{" "}
										{period === "week" ? "this week" : "today"} yet.
									</Text>
								</TableCell>
							</TableRow>
						) : (
							rows.map((row, index) => {
								const stage = stageOf.get(row.tediId);
								return (
									<TableRow key={row.tediId}>
										<TableCell className="tabular-nums">{index + 1}</TableCell>
										<TableCell>
											<span className="flex items-center gap-2">
												<TediAvatar name={row.name} avatar={row.avatar} />
												<span>{row.name}</span>
												{stage ? (
													<Badge variant="secondary">
														{sentenceCase(stage)}
													</Badge>
												) : null}
											</span>
										</TableCell>
										<TableCell className="text-right font-semibold tabular-nums">
											{row.score.stood}
										</TableCell>
										<TableCell className="text-right tabular-nums">
											{row.score.answered}
										</TableCell>
										<TableCell className="text-right tabular-nums">
											{row.score.autoSent}
										</TableCell>
										<TableCell className="text-right tabular-nums">
											{row.score.corrected}
										</TableCell>
										<TableCell className="text-right tabular-nums">
											{formatReplyTime(row.score.avgReplySeconds)}
										</TableCell>
									</TableRow>
								);
							})
						)}
						<TableRow className="bg-kumo-tint">
							<TableCell>
								<Badge variant="teal-subtle">Coach</Badge>
							</TableCell>
							<TableCell>
								<span className="flex items-center gap-2">
									<TediAvatar name={coach} avatar={null} />
									<span>{coach}</span>
								</span>
							</TableCell>
							<TableCell colSpan={5} className="text-right">
								<span className="font-semibold tabular-nums">{taught}</span>{" "}
								{taught === 1 ? "lesson" : "lessons"} taught: corrections that
								became notebook lines
							</TableCell>
						</TableRow>
					</TableBody>
				</Table>
			)}
		</PageSection>
	);
}
