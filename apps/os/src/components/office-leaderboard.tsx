import { useQuery } from "@tanstack/react-query";
import type { GetAgentReplyDraftLeaderboardResultSchema } from "@tedix/api-contract/schemas/agent-turn-triage";
import { TEDI_CAREER_STAGES } from "@tedix/api-contract/schemas/earned-delegation";
import type * as z from "zod";
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
import { Progress } from "@/components/kumo/progress";
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
	userProfileQueryOptions,
} from "@/lib/os-query-options";
import { normalizeD1Timestamp } from "@/lib/time";

type ReplyDraftLeaderboard = z.infer<
	typeof GetAgentReplyDraftLeaderboardResultSchema
>;

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

type Level = NonNullable<ReplyDraftLeaderboard["tedis"][number]["level"]>;

/** "Level 2 · Apprentice": the career stage, counted from Shadow as 1. */
export function levelLabel(stage: Level["stage"]): string {
	return `Level ${TEDI_CAREER_STAGES.indexOf(stage) + 1} · ${sentenceCase(stage)}`;
}

/** "12 of 25 replies to Operator"; null at the top of the ladder. */
export function levelProgressText(level: Level): string | null {
	if (!level.nextStage || level.target === null) return null;
	const stood = Math.min(level.stood, level.target);
	return `${stood} of ${level.target} replies to ${sentenceCase(level.nextStage)}`;
}

function LevelProgress({ level }: { level: Level }) {
	const text = levelProgressText(level);
	if (!text || level.target === null) return null;
	return (
		<span className="flex w-48 max-w-full flex-col gap-1">
			<Progress
				value={Math.min(100, Math.round((level.stood / level.target) * 100))}
				aria-label={text}
			/>
			<Text as="span" role="caption" tone="secondary">
				{text}
			</Text>
		</span>
	);
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
 * today, with the career stage its replies earned, its progress to the next
 * one and its streak. You appear last as the coach, counting the corrections
 * that became lessons.
 */
export function OfficeLeaderboard({ now = new Date() }: { now?: Date }) {
	const [period, setPeriod] = useState<Period>("week");
	const weekSince = startOfWeek(now);
	const todaySince = startOfDay(now);
	const board = useQuery(
		replyDraftLeaderboardQueryOptions(weekSince, todaySince),
	);
	const lessons = useQuery({ ...notebookLessonsQueryOptions(), retry: false });
	const profile = useQuery({ ...userProfileQueryOptions(), retry: false });

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
							rows.map((row, index) => (
								<TableRow key={row.tediId}>
									<TableCell className="tabular-nums">{index + 1}</TableCell>
									<TableCell>
										<span className="flex items-center gap-2">
											<TediAvatar name={row.name} avatar={row.avatar} />
											<span className="flex min-w-0 flex-col gap-1">
												<span className="flex flex-wrap items-center gap-2">
													<span>{row.name}</span>
													{row.level ? (
														<Badge variant="secondary">
															{levelLabel(row.level.stage)}
														</Badge>
													) : null}
													{row.level && row.level.streakDays >= 2 ? (
														<Badge variant="outline">
															{row.level.streakDays}-day streak
														</Badge>
													) : null}
												</span>
												{row.level ? <LevelProgress level={row.level} /> : null}
											</span>
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
							))
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
