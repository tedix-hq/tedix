import { type ReactNode, useEffect, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { ActivityFeedConfig } from "@tedix/api-contract/schemas/os-activity-feed";
import { plainFeedText } from "@tedix/api-contract/utils/activity-feed";
import { dispatcherHealthQueryOptions, osQuery } from "@/lib/os-query-options";
import { workRefreshOptions } from "@/lib/work-refresh";
import { absoluteTime, relativeTime } from "@/lib/time";
import { useWorkPrincipalNames } from "./work-operations-shared";
import { workPrincipalTooltip } from "@/lib/work-display";
import { WorkReadFailure } from "./work-surface-primitives";
import { Card, CardContent, CardHeader, CardTitle } from "./kumo/card";
import {
	Collapsible,
	CollapsibleDefaultContent,
	CollapsibleDefaultTrigger,
} from "./kumo/collapsible";
import { Button } from "./kumo/button";
import { Link } from "./kumo/link";
import { Text } from "./kumo/text";
import { ActivityHarnessScorecard } from "./activity-harness-scorecard";

/** Uses the same canonical attempt and dispatcher projections as Work. */
export function ActivityRunningNow({
	config,
	projectId,
	followedProjects,
	children,
}: {
	config: ActivityFeedConfig;
	projectId?: string;
	followedProjects?: string[];
	children?: ReactNode;
}) {
	const scopes = projectId
		? [projectId]
		: config.scope === "organization"
			? (followedProjects ?? [undefined])
			: [...new Set(config.projects.map((project) => project.id))];
	const queries = useQueries({
		queries: scopes.map((id) => ({
			...osQuery.workItems.listAttemptProjection.queryOptions({
				input: {
					projectId: id,
					includeLaneState: false,
					runtimeStates: ["queued", "running", "waiting", "retrying"],
					limit: 100,
				},
			}),
			...workRefreshOptions,
			refetchInterval: 30_000,
		})),
	});
	const [scorecard, setScorecard] = useState(false);
	const health = useQuery({
		...dispatcherHealthQueryOptions(),
		enabled: scorecard,
		...workRefreshOptions,
		refetchInterval: 30_000,
	});
	const [now, setNow] = useState(() => new Date());
	useEffect(() => {
		const timer = setInterval(() => setNow(new Date()), 15_000);
		return () => clearInterval(timer);
	}, []);
	const rows = [
		...new Map(
			queries
				.flatMap((query) => query.data?.data ?? [])
				.map((row) => [row.attempt.id, row]),
		).values(),
	];
	const names = useWorkPrincipalNames(rows[0]?.attempt.orgId);
	const [expanded, setExpanded] = useState(false);
	const byWork = new Map<string, typeof rows>();
	for (const row of rows.sort(
		(a, b) =>
			a.attempt.startedAt.localeCompare(b.attempt.startedAt) ||
			a.workItem.id.localeCompare(b.workItem.id),
	)) {
		const group = byWork.get(row.workItem.id);
		if (group) group.push(row);
		else byWork.set(row.workItem.id, [row]);
	}
	const work = [...byWork.values()];
	const failed = queries.some((query) => query.isError);
	const pending = queries.some((query) => query.isPending);
	const reports = health.data?.data ?? [];
	const fresh = reports.filter(
		(lane) =>
			!lane.stale &&
			now.getTime() - Date.parse(lane.duty?.observedAt ?? lane.observedAt) <=
				lane.staleAfterSeconds * 1000,
	);
	// The supervisor reports its own lane; it is not a runner.
	const supervisor = (lane: (typeof reports)[number]) =>
		lane.lane === "supervisor" ||
		lane.lane === "supervisor-lead" ||
		lane.duty?.kind === "task";
	const runners = fresh.filter((lane) => !supervisor(lane));
	const up = runners.filter(
		(lane) => lane.running && (!lane.duty || lane.duty.state === "running"),
	);
	const lastReport = reports
		.map((lane) => lane.observedAt)
		.sort()
		.at(-1);
	const healthFailed = health.isError || health.failureCount > 0;
	return (
		<>
			<Card aria-label="Running now" className="my-4 min-w-0">
				<CardHeader>
					<CardTitle>Running now</CardTitle>
				</CardHeader>
				<CardContent className="grid min-w-0 gap-3">
					{failed && (
						<WorkReadFailure
							title="Could not load running work"
							error={
								queries.find((query) => query.error || query.failureReason)
									?.error ??
								queries.find((query) => query.failureReason)?.failureReason
							}
							onRetry={() =>
								Promise.all(queries.map((query) => query.refetch()))
							}
							retrying={queries.some((query) => query.isFetching)}
						/>
					)}
					{rows.length > 0 ? (
						<ul aria-label="Active work" className="grid min-w-0 gap-2">
							{(expanded ? work : work.slice(0, 5)).map((group) => {
								const { attempt, workItem } = group[group.length - 1]!;
								const people = [
									...new Set(
										group.map(({ attempt }) =>
											workPrincipalTooltip(
												attempt.executorType,
												attempt.executorId,
												names,
											),
										),
									),
								];
								const status =
									attempt.expiresAt &&
									Date.parse(attempt.expiresAt) <= now.getTime()
										? "No recent update"
										: (
												{
													queued: "Waiting to start",
													waiting: "Waiting",
													retrying: "Trying again",
												} as Record<string, string>
											)[attempt.runtimeState];
								return (
									<li
										key={workItem.id}
										className="flex min-w-0 flex-wrap items-baseline gap-x-2"
									>
										<Text weight="semibold">{people.join(", ")}</Text>
										<Link variant="record" href={`/work/items/${workItem.id}`}>
											{plainFeedText(workItem.title) || workItem.title}
										</Link>
										{status && <Text tone="secondary">{status}</Text>}
									</li>
								);
							})}
						</ul>
					) : (
						<Text tone="secondary">
							{failed
								? "Current activity is unknown."
								: pending
									? "Checking running work…"
									: "No work is running here."}
						</Text>
					)}
					{work.length > 5 && (
						<Button
							className="justify-self-start"
							size="sm"
							variant="ghost"
							onClick={() => setExpanded(!expanded)}
						>
							{expanded ? "Show fewer" : `Show all ${work.length}`}
						</Button>
					)}
					{failed && rows.length > 0 && (
						<Text tone="secondary">
							Showing the last update. Current activity may have changed.
						</Text>
					)}
					{queries.some((query) => query.data?.hasMore) && (
						<Link href="/work?view=feed&filter=queue">More running work</Link>
					)}
					{/* Runner statistics are for whoever operates the runners; they load on request. */}
					<Collapsible open={scorecard} onOpenChange={setScorecard}>
						<CollapsibleDefaultTrigger>
							Runner scorecard · Last 24 h
						</CollapsibleDefaultTrigger>
						<CollapsibleDefaultContent>
							<Text role="caption" aria-label="Runner health">
								{healthFailed || !runners.length
									? "Runners up: unknown"
									: `Runners up: ${up.length} / ${runners.length}`}
								{reports.length > fresh.length
									? ` · ${reports.length - fresh.length} stale ${reports.length - fresh.length === 1 ? "report" : "reports"}`
									: ""}
								{!healthFailed && fresh.some(supervisor)
									? " · Supervisor reporting"
									: " · Supervisor: unknown"}
								{lastReport && (
									<>
										{" "}
										· Last report{" "}
										<time
											dateTime={lastReport}
											title={absoluteTime(lastReport)}
										>
											{relativeTime(lastReport, now)}
										</time>
									</>
								)}
							</Text>
							{healthFailed && (
								<WorkReadFailure
									title="Runner health unavailable"
									error={health.error ?? health.failureReason}
									onRetry={() => health.refetch()}
									retrying={health.isFetching}
								/>
							)}

							{scorecard && (
								<ActivityHarnessScorecard scopes={scopes} now={now.getTime()} />
							)}
						</CollapsibleDefaultContent>
					</Collapsible>
				</CardContent>
			</Card>
			{(!pending || queries.some((query) => query.isPaused)) && children}
		</>
	);
}
